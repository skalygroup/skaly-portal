'use client';

/**
 * Save a streamed response to disk without pulling it through the JS heap.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * ADR-028 made the audit-log export a Postgres cursor → CSV → socket pipeline
 * with nothing holding the full set, precisely so a 50k-row export cannot be
 * bounded by memory. `await res.blob()` on the client would put that ceiling
 * straight back, one tab at a time.
 *
 * ── The two paths ────────────────────────────────────────────────────────────
 * The File System Access API is the only browser API that streams a download to
 * disk under JS control: `response.body.pipeTo(fileStream)` moves bytes without
 * ever materialising them. That is the real implementation of the rule, and it
 * is what Chrome and Edge get — which is the whole audience, since the portal
 * refuses to render below 768px and is desktop-Chrome targeted.
 *
 * Everywhere else falls back to collecting chunks into a Blob. That IS buffering
 * and the comment says so rather than pretending otherwise; it is the least-bad
 * option a browser without `showSaveFilePicker` leaves.
 *
 * ponytail: fallback holds the export in memory (~50MB at NFR §2.2's 50k rows).
 * If a non-Chromium browser ever becomes a real target, the upgrade is a
 * service-worker download stream, not a bigger Blob.
 */

interface SaveFilePickerWindow {
  showSaveFilePicker?: (opts: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>;
}

/** Thrown by the picker when the user closes it. Not an error worth reporting. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export async function streamToDisk(res: Response, filename: string): Promise<'saved' | 'cancelled'> {
  if (!res.body) throw new Error('Response has no body to save.');

  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    let writable: WritableStream<Uint8Array>;
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
      });
      writable = await handle.createWritable();
    } catch (err) {
      if (isAbort(err)) return 'cancelled';
      throw err;
    }
    // The whole point: bytes go response → disk, never through an array we hold.
    await res.body.pipeTo(writable);
    return 'saved';
  }

  // Fallback. Chunks accumulate; see the ceiling noted above.
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can race the download in some browsers; one tick is
  // enough for the click to have been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return 'saved';
}
