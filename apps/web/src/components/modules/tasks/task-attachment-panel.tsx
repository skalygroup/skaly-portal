'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { SlidePanel } from './slide-panel';

import type { TaskDetail } from './types';

import { api } from '@/lib/api';
import { handleMutationError } from '@/lib/mutation-errors';
import { uploadTaskAttachment, validateAttachment } from '@/lib/upload-attachment';

interface UploadState {
  name: string;
  pct: number;
  error?: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attachment panel (ADR-007, Step 7 §5): drag-drop or browse, presign→PUT→confirm
 * per file with a progress bar, plus the existing list with download and delete.
 */
export function TaskAttachmentPanel({
  open,
  onClose,
  taskId,
  period,
  meId,
  canManage,
}: {
  open: boolean;
  onClose: () => void;
  taskId: string | null;
  period: string;
  meId: string | undefined;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const { data: task } = useQuery({
    queryKey: ['task', taskId],
    queryFn: async () => (await api<{ data: TaskDetail }>(`/v1/tasks/${taskId}`)).data,
    enabled: open && !!taskId,
  });
  const attachments = task?.attachments ?? [];
  const existingBytes = attachments.reduce((sum, a) => sum + a.fileSize, 0);

  async function handleFiles(files: FileList | File[]) {
    if (!taskId) return;
    for (const file of Array.from(files)) {
      const invalid = validateAttachment(file, existingBytes);
      if (invalid) {
        toast.error(`${file.name}: ${invalid}`);
        continue;
      }
      const idx = uploads.length;
      setUploads((u) => [...u, { name: file.name, pct: 0 }]);
      try {
        await uploadTaskAttachment(taskId, file, (pct) =>
          setUploads((u) => u.map((x, i) => (i === idx ? { ...x, pct } : x))),
        );
        setUploads((u) => u.filter((_, i) => i !== idx));
        void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
        void queryClient.invalidateQueries({ queryKey: ['tasks', period] });
      } catch (err) {
        setUploads((u) => u.map((x, i) => (i === idx ? { ...x, error: 'Failed' } : x)));
        handleMutationError(err, 'File exceeded the limit — not saved.');
      }
    }
  }

  const deleteMutation = useMutation({
    mutationFn: async (aid: string) =>
      api<{ data: { deleted: true } }>(`/v1/tasks/${taskId}/attachments/${aid}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['task', taskId] });
      void queryClient.invalidateQueries({ queryKey: ['tasks', period] });
    },
    onError: (err) => handleMutationError(err),
  });

  async function download(aid: string) {
    try {
      const { data } = await api<{ data: { downloadUrl: string } }>(`/v1/tasks/${taskId}/attachments/${aid}/download`);
      window.open(data.downloadUrl, '_blank', 'noopener');
    } catch (err) {
      handleMutationError(err);
    }
  }

  return (
    <SlidePanel open={open} onClose={onClose} title="Attachments">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        className="flex cursor-pointer flex-col items-center gap-2 rounded-lg px-4 py-8 text-center"
        style={{ border: `2px dashed ${dragOver ? 'var(--accent-gold)' : 'var(--border-default)'}`, background: dragOver ? 'var(--accent-gold-dim)' : 'transparent' }}
      >
        <Upload size={22} style={{ color: 'var(--text-muted)' }} />
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Drop files or click to browse</p>
        <p className="text-xs" style={{ color: 'var(--text-disabled)' }}>PDF, Word, images, video — up to 50MB each, 200MB total</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {uploads.length > 0 ? (
        <div className="mt-4 space-y-2">
          {uploads.map((u, i) => (
            <div key={i}>
              <div className="flex justify-between text-xs" style={{ color: u.error ? 'var(--status-red)' : 'var(--text-secondary)' }}>
                <span className="truncate">{u.name}</span>
                <span>{u.error ?? `${u.pct}%`}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-base)' }}>
                <div className="h-full rounded-full" style={{ width: `${u.pct}%`, background: u.error ? 'var(--status-red)' : 'var(--accent-gold)' }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 space-y-2">
        {attachments.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-disabled)' }}>No attachments yet.</p>
        ) : (
          attachments.map((a) => {
            const canDelete = canManage || a.uploadedBy === meId;
            return (
              <div key={a.id} className="flex items-center justify-between rounded px-3 py-2" style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}>
                <div className="min-w-0">
                  <p className="truncate text-sm" style={{ color: 'var(--text-primary)' }}>{a.fileName}</p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{formatBytes(a.fileSize)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => void download(a.id)} aria-label="Download" className="rounded p-1.5" style={{ color: 'var(--text-secondary)' }}>
                    <Download size={15} />
                  </button>
                  {canDelete ? (
                    <button type="button" onClick={() => deleteMutation.mutate(a.id)} aria-label="Delete" className="rounded p-1.5" style={{ color: 'var(--status-red)' }}>
                      <Trash2 size={15} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </SlidePanel>
  );
}
