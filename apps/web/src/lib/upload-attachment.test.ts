// @vitest-environment node
// Logic test (no DOM): the ADR-007 upload orders presign → PUT(xhr) → confirm,
// and the client-side validation gates type/size/total. Matches the repo's
// node-env test style (jsdom is intentionally avoided — see use-polling.test.ts).
import { ATTACHMENT_MAX_BYTES, TASK_ATTACHMENT_TOTAL_BYTES } from '@skaly/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { uploadTaskAttachment, validateAttachment } from './upload-attachment';

// Record every step so we can assert the exact order.
const calls: string[] = [];

vi.mock('@/lib/api', () => ({
  api: vi.fn(async (path: string) => {
    if (path.includes('/attachments/presign')) {
      calls.push('presign');
      return { data: { presignedUrl: 'https://r2.fake/put', fileKey: 'attachments/t1/abc_f.pdf' } };
    }
    if (path.includes('/attachments/confirm')) {
      calls.push('confirm');
      return { data: { id: 'att1', fileName: 'f.pdf', fileSize: 1234, mimeType: 'application/pdf', uploadedBy: 'u1', uploadedAt: null } };
    }
    throw new Error(`unexpected path ${path}`);
  }),
  ApiError: class ApiError extends Error {},
}));

// Minimal fake XHR that records the PUT and drives progress + load.
class FakeXHR {
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send() {
    calls.push('put');
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.onload?.();
    });
  }
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
});
afterEach(() => vi.unstubAllGlobals());

function fakeFile(name = 'f.pdf', type = 'application/pdf', size = 1234): File {
  return { name, type, size } as File;
}

describe('uploadTaskAttachment', () => {
  it('calls presign → PUT(xhr) → confirm in order and returns the confirmed attachment', async () => {
    const progress: number[] = [];
    const att = await uploadTaskAttachment('t1', fakeFile(), (p) => progress.push(p));

    expect(calls).toEqual(['presign', 'put', 'confirm']);
    expect(att.id).toBe('att1');
    expect(progress).toContain(50); // 5/10 → 50%
  });

  it('sets the PUT Content-Type to the file mime (must match the signed type)', async () => {
    const sent: FakeXHR[] = [];
    class RecordingXHR extends FakeXHR {
      override send() {
        sent.push(this);
        super.send();
      }
    }
    vi.stubGlobal('XMLHttpRequest', RecordingXHR as unknown as typeof XMLHttpRequest);
    await uploadTaskAttachment('t1', fakeFile('clip.mp4', 'video/mp4', 10));
    expect(sent[0]!.headers['Content-Type']).toBe('video/mp4');
    expect(sent[0]!.method).toBe('PUT');
  });
});

describe('validateAttachment', () => {
  it('rejects a disallowed MIME type', () => {
    expect(validateAttachment(fakeFile('x.exe', 'application/x-msdownload', 10), 0)).toMatch(/not allowed/);
  });
  it('rejects a file over the 50MB per-file limit', () => {
    expect(validateAttachment(fakeFile('big.mp4', 'video/mp4', ATTACHMENT_MAX_BYTES + 1), 0)).toMatch(/50MB/);
  });
  it('rejects when the task total would exceed 200MB', () => {
    expect(validateAttachment(fakeFile('f.pdf', 'application/pdf', 10 * 1024 * 1024), TASK_ATTACHMENT_TOTAL_BYTES)).toMatch(/200MB/);
  });
  it('accepts a valid file within limits', () => {
    expect(validateAttachment(fakeFile('f.pdf', 'application/pdf', 1024), 0)).toBeNull();
  });
});
