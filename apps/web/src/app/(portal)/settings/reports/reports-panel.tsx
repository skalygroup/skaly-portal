'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { PanelHeader, PanelTable, RowAction, Td, Th } from '@/components/settings/panel-chrome';
import { api, ApiError } from '@/lib/api';
import { currentIstPeriod } from '@/lib/hooks/use-month-context';
import { useNotifySocket } from '@/lib/socket';
import { cn } from '@/lib/utils';

type ReportStatus = 'pending' | 'ready' | 'failed';

interface ReportRow {
  id: string;
  type: string;
  period: string;
  clientId: string | null;
  clientName: string | null;
  status: ReportStatus;
  errorMessage: string | null;
  requestedAt: string;
  completedAt: string | null;
  requestedBy: string | null;
}

interface ClientRow {
  id: string;
  name: string;
  isInternal: boolean;
  active: boolean;
}

const QUERY_KEY = ['settings', 'reports'] as const;

const TYPE_LABELS: Record<string, string> = {
  client_monthly: 'Client — monthly',
  org_monthly: 'Organisation — monthly',
};

export function ReportsPanel() {
  const qc = useQueryClient();
  const [type, setType] = useState<'client_monthly' | 'org_monthly'>('client_monthly');
  const [period, setPeriod] = useState(currentIstPeriod());
  const [clientId, setClientId] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  /**
   * The other end of audit M-08. `report_ready`'s linkBuilder points here as
   * `/settings/reports?reportId={id}` precisely so the notification does not
   * carry a presigned URL that dies overnight — which only pays off if landing
   * here actually shows you the report you clicked for.
   */
  const highlightId = useSearchParams().get('reportId');

  const { data: reports = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api<{ data: ReportRow[] }>('/v1/reports')).data,
    staleTime: 15_000,
  });

  const { data: clients = [] } = useQuery({
    queryKey: ['clients', 'lookup'],
    queryFn: async () => (await api<{ data: ClientRow[] }>('/v1/clients')).data,
    staleTime: 5 * 60_000,
  });

  /**
   * ⭐ SOCKET, NOT POLL.
   *
   * ⚠️ `report_ready` IS A NOTIFICATION TYPE, NOT A SOCKET EVENT. ADR-020's
   * `notifications_type_check` enum is where that name lives; the notify
   * namespace emits exactly two events, `notify:new` and `notify:read`
   * (NotificationService), and `notify:new` carries the whole row — including
   * its `type`. Subscribing to `'report_ready'` registered a handler for an
   * event nothing on the server has ever sent, so a finished report sat on
   * "Generating" until the user reloaded. The panel's unit test passed anyway
   * because it invoked the handler it had just registered: it proved the
   * handler was right and never that the event was real.
   *
   * Filtering here rather than adding a second server-side emit: the fact is
   * already on the wire, and one consumer does not justify sending it twice.
   *
   * The type covers BOTH outcomes — the worker notifies on a failed render too,
   * with `status: 'failed'` — so this is the terminal signal for every report
   * and there is no state it can leave stuck spinning.
   *
   * ADR-022's matrix calls this an INVALIDATE rather than a patch. The payload
   * deliberately carries NO download URL (audit M-08: the presigned link lives
   * 24h and anything holding it outlives it), so a patched row would still have
   * to fetch before it could offer a button. Refetching the list is one request
   * that produces a completely correct row instead of a nearly-correct one.
   *
   * If the event is missed — tab offline, socket down — the list is `staleTime`
   * 15s and refetches on the next mount or window focus. The push makes it
   * instant; it is not what makes it correct.
   */
  const onNotification = useCallback(
    (n: { type?: string }) => {
      // Every notification of every type arrives here. Without the guard, one
      // task assignment would refetch this list for everyone looking at it.
      if (n?.type !== 'report_ready') return;
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    [qc],
  );

  useNotifySocket('notify:new', onNotification);

  const generate = useMutation({
    mutationFn: () =>
      api<{ data: { reportId: string; status: 'pending' } }>('/v1/reports/generate', {
        method: 'POST',
        body: JSON.stringify({
          type,
          period,
          // Required for client_monthly, REJECTED for org_monthly — so it is
          // omitted rather than sent as null.
          ...(type === 'client_monthly' && clientId ? { clientId } : {}),
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success('Generating. We’ll let you know when it’s ready.');
    },
    onError: (err) => {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      if (code === 'VALIDATION_ERROR' && type === 'client_monthly' && !clientId) {
        setFieldError('Choose a client for a client report.');
        return;
      }
      toast.error('Could not start that report. Try again.');
    },
  });

  /**
   * The link is fetched at CLICK time, never stored on the row.
   *
   * `GET /v1/reports/:id` presigns from `file_key` on every read, so a report
   * generated yesterday downloads today without a re-render. Caching the URL in
   * this component would give the user a button that works until it silently
   * doesn't — the same defect as baking it into the notification (M-08).
   */
  async function download(row: ReportRow) {
    setDownloading(row.id);
    try {
      const { data } = await api<{ data: ReportRow & { downloadUrl: string | null } }>(
        `/v1/reports/${row.id}`,
      );
      if (!data.downloadUrl) throw new ApiError(404, 'NO_LINK');
      window.open(data.downloadUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'UNKNOWN';
      toast.error(
        code === 'RESOURCE_EXPIRED'
          ? 'This report is older than 30 days and its file was removed. Generate it again.'
          : 'Could not fetch the download link. Try again.',
      );
      // A 410 is not a failure to fix by retrying the download — the object is
      // gone. Refetch so the row can offer [Regenerate] instead.
      if (code === 'RESOURCE_EXPIRED') void qc.invalidateQueries({ queryKey: QUERY_KEY });
    } finally {
      setDownloading(null);
    }
  }

  /** Retry and Regenerate are the same request as the original — a report is a
   *  pure function of (type, period, client), so re-asking is the whole fix. */
  const regenerate = useMutation({
    mutationFn: (row: ReportRow) =>
      api('/v1/reports/generate', {
        method: 'POST',
        body: JSON.stringify({
          type: row.type,
          period: row.period,
          ...(row.clientId ? { clientId: row.clientId } : {}),
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success('Generating again. We’ll let you know when it’s ready.');
    },
    onError: () => toast.error('Could not start that report. Try again.'),
  });

  return (
    <div>
      <PanelHeader
        title="Reports"
        description="Monthly PDFs for a client or the whole organisation."
      />

      {/* ── Generate ────────────────────────────────────────────────────── */}
      <div className="mb-8 rounded-xl border border-border-subtle bg-bg-surface p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="report-type" className="text-[11.5px] font-semibold text-text-muted">
              Report
            </label>
            <select
              id="report-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as typeof type);
                setFieldError(null);
              }}
              style={{ colorScheme: 'dark' }}
              className={INPUT}
            >
              <option value="client_monthly">{TYPE_LABELS.client_monthly}</option>
              <option value="org_monthly">{TYPE_LABELS.org_monthly}</option>
            </select>
          </div>

          {type === 'client_monthly' && (
            <div className="flex flex-col gap-1">
              <label htmlFor="report-client" className="text-[11.5px] font-semibold text-text-muted">
                Client
              </label>
              <select
                id="report-client"
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setFieldError(null);
                }}
                aria-invalid={fieldError !== null}
                aria-describedby={fieldError ? 'report-client-error' : undefined}
                style={{ colorScheme: 'dark' }}
                className={cn(INPUT, 'aria-[invalid=true]:border-status-red')}
              >
                <option value="">Choose a client…</option>
                {clients
                  .filter((c) => c.active && !c.isInternal)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor="report-period" className="text-[11.5px] font-semibold text-text-muted">
              Period
            </label>
            <input
              id="report-period"
              type="month"
              value={period}
              onChange={(e) => e.target.value && setPeriod(e.target.value)}
              className={INPUT}
            />
          </div>

          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className="h-10 rounded-md bg-accent-gold px-4 text-[13px] font-semibold text-bg-base transition-[filter] hover:brightness-[1.06] disabled:opacity-60"
          >
            {generate.isPending ? 'Starting…' : 'Generate'}
          </button>
        </div>

        {fieldError && (
          <p id="report-client-error" role="alert" className="mt-2 text-[12.5px] text-status-red">
            {fieldError}
          </p>
        )}

        {/* ADR-027's contract, said out loud. A user who believes the tab has to
            stay open will keep it open — and then treat a normal navigation as
            having broken their report. */}
        <p className="mt-3 text-[12.5px] text-text-muted">
          Rendering happens in the background. We’ll notify you when it’s ready —{' '}
          <strong className="font-semibold text-text-secondary">you can leave this page.</strong>
        </p>
      </div>

      <PanelTable
        loading={isLoading}
        empty={reports.length === 0}
        head={
          <>
            <Th>Report</Th>
            <Th>Period</Th>
            <Th>Requested</Th>
            <Th>Status</Th>
            <Th className="text-right">Actions</Th>
          </>
        }
      >
        {reports.map((row) => (
          <tr
            key={row.id}
            data-testid={`report-${row.id}`}
            className={cn(
              'border-b border-border-subtle last:border-0',
              row.id === highlightId && 'bg-[var(--accent-gold-dim)]',
            )}
          >
            <Td className="font-medium text-text-primary">
              {TYPE_LABELS[row.type] ?? row.type}
              {row.clientName && <span className="text-text-muted"> · {row.clientName}</span>}
            </Td>
            <Td>{row.period}</Td>
            <Td>{row.requestedAt.slice(0, 10)}</Td>
            <Td>
              <StatusChip row={row} />
            </Td>
            <Td className="text-right">
              {row.status === 'ready' && (
                <RowAction onClick={() => void download(row)}>
                  {downloading === row.id ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" /> Linking…
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <Download size={12} /> Download
                    </span>
                  )}
                </RowAction>
              )}
              {row.status === 'failed' && (
                <RowAction onClick={() => regenerate.mutate(row)}>
                  <span className="inline-flex items-center gap-1.5">
                    <RefreshCw size={12} /> Retry
                  </span>
                </RowAction>
              )}
            </Td>
          </tr>
        ))}
      </PanelTable>
    </div>
  );
}

/**
 * The failure message is shown INLINE next to the chip, not behind a hover or a
 * toast that has long since gone. "Failed" without a reason is a dead end; the
 * worker already wrote `error_message` for exactly this.
 */
function StatusChip({ row }: { row: ReportRow }) {
  if (row.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-bg-elevated px-2.5 py-0.5 text-[11px] font-medium text-text-secondary">
        <Loader2 size={11} className="animate-spin" /> Generating
      </span>
    );
  }
  if (row.status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-status-green/10 px-2.5 py-0.5 text-[11px] font-medium text-status-green">
        <CheckCircle2 size={11} /> Ready
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-status-red/10 px-2.5 py-0.5 text-[11px] font-medium text-status-red">
        <AlertCircle size={11} /> Failed
      </span>
      {row.errorMessage && (
        <span className="max-w-xs text-[11.5px] leading-snug text-text-muted">{row.errorMessage}</span>
      )}
    </span>
  );
}

const INPUT =
  'h-10 rounded-md border border-border-default bg-bg-elevated px-3 text-[13px] text-text-primary outline-none focus:border-accent-gold focus:shadow-[0_0_0_3px_var(--accent-gold-dim)]';
