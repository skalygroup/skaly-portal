/**
 * The report PDF (ADR-027 §3). Pure presentation — it is handed a ReportData and
 * returns an element, so it can be rendered in a test without a worker, a DB or R2.
 *
 * Brand faces are VENDORED (src/assets/fonts). `Font.register` accepts a URL and
 * that is the trap the ADR names: a network fetch inside a render is an unbounded
 * stall in the middle of a timed operation.
 */
import { fileURLToPath } from 'node:url';

import { Document, Font, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import type { ClientMonthlyData, OrgMonthlyData, ReportData } from './report-data.js';

const font = (file: string): string =>
  fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url));

// Registered once at module load, not per render. Static weights only — the
// variable-font files render at one arbitrary weight and silently ignore
// fontWeight (see the fonts README).
Font.register({
  family: 'DM Sans',
  fonts: [
    { src: font('DMSans-Regular.ttf'), fontWeight: 400 },
    { src: font('DMSans-Medium.ttf'), fontWeight: 500 },
    { src: font('DMSans-SemiBold.ttf'), fontWeight: 600 },
  ],
});
Font.register({ family: 'Big Shoulders', fonts: [{ src: font('BigShoulders-Bold.ttf'), fontWeight: 700 }] });
Font.register({ family: 'DM Mono', fonts: [{ src: font('DMMono-Regular.ttf'), fontWeight: 400 }] });

// UIUX §5's type roles: display face for headings, DM Sans for UI text, DM Mono
// for every piece of DATA. That last rule is why counts and dates below are mono.
const C = {
  ink: '#101010',
  muted: '#6B6B6B',
  rule: '#E4E4E4',
  gold: '#C8A44D',
} as const;

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 44, fontFamily: 'DM Sans', fontSize: 10, color: C.ink },
  brandRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', borderBottomWidth: 2, borderBottomColor: C.gold, paddingBottom: 8 },
  brand: { fontFamily: 'Big Shoulders', fontSize: 22, fontWeight: 700, letterSpacing: 0.5 },
  brandMeta: { fontFamily: 'DM Mono', fontSize: 8, color: C.muted },
  title: { fontFamily: 'Big Shoulders', fontSize: 30, fontWeight: 700, marginTop: 22 },
  subtitle: { fontFamily: 'DM Mono', fontSize: 11, color: C.muted, marginTop: 2 },
  section: { fontFamily: 'Big Shoulders', fontSize: 15, fontWeight: 700, marginTop: 22, marginBottom: 8 },
  statRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  stat: { flex: 1, borderWidth: 1, borderColor: C.rule, borderRadius: 4, padding: 10 },
  statNum: { fontFamily: 'Big Shoulders', fontSize: 24, fontWeight: 700 },
  statLabel: { fontSize: 8, color: C.muted, marginTop: 2 },
  tr: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.rule, paddingVertical: 5 },
  th: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.ink, paddingBottom: 4 },
  thText: { fontSize: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: C.muted },
  cell: { fontSize: 9 },
  data: { fontFamily: 'DM Mono', fontSize: 9 },
  empty: { fontSize: 9, color: C.muted, fontStyle: 'normal', marginTop: 4 },
  footer: { position: 'absolute', bottom: 26, left: 44, right: 44, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: C.rule, paddingTop: 6 },
  footerText: { fontFamily: 'DM Mono', fontSize: 7, color: C.muted },
});

const IST = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 'YYYY-MM-DD' → '14 Aug 2026'. Takes the string as-is; DATE columns are
 *  identity-parsed (lib/db.ts) so there is no timezone to shift. */
function shortDate(d: string | null): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(day)} ${months[Number(m) - 1]} ${y}`;
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statNum}>{String(value)}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function Row({ cells, widths, header }: { cells: string[]; widths: number[]; header?: boolean }) {
  return (
    <View style={header ? s.th : s.tr}>
      {cells.map((c, i) => (
        <Text key={i} style={[{ width: `${widths[i]}%` }, header ? s.thText : i === 0 ? s.cell : s.data]}>
          {c}
        </Text>
      ))}
    </View>
  );
}

function OrgBody({ d }: { d: OrgMonthlyData }) {
  return (
    <>
      <Text style={s.section}>At a glance</Text>
      <View style={s.statRow}>
        <Stat value={d.attendancePct === null ? '—' : `${d.attendancePct}%`} label="Attendance" />
        <Stat value={d.activeStaffCount} label="Active staff" />
        <Stat value={d.activeClientCount} label="Active clients" />
        <Stat value={d.posts} label="Posts published" />
      </View>

      <Text style={s.section}>Tasks</Text>
      <View style={s.statRow}>
        <Stat value={d.tasks.total} label="Total" />
        <Stat value={d.tasks.done} label="Done" />
        <Stat value={d.tasks.pending} label="Pending" />
        <Stat value={d.tasks.overdue} label="Overdue" />
      </View>

      <Text style={s.section}>Shoots</Text>
      <View style={s.statRow}>
        <Stat value={d.shoots.total} label="Slots" />
        <Stat value={d.shoots.completed} label="Completed" />
        <Stat value={d.shoots.confirmed} label="Confirmed" />
        <Stat value={d.shoots.unset} label="Unset" />
      </View>

      <Text style={s.section}>Per staff member</Text>
      {d.perStaff.length === 0 ? (
        <Text style={s.empty}>No tasks were assigned this month.</Text>
      ) : (
        <View>
          <Row header cells={['Name', 'Role', 'Assigned', 'Done', 'Overdue']} widths={[34, 22, 15, 14, 15]} />
          {d.perStaff.map((p) => (
            <Row
              key={p.name}
              cells={[p.name, p.role, String(p.assigned), String(p.done), String(p.overdue)]}
              widths={[34, 22, 15, 14, 15]}
            />
          ))}
        </View>
      )}
    </>
  );
}

function ClientBody({ d }: { d: ClientMonthlyData }) {
  const p = d.pipeline;
  return (
    <>
      <Text style={s.section}>Shoot slots</Text>
      {d.slots.length === 0 ? (
        <Text style={s.empty}>No shoot slots exist for this client in this period.</Text>
      ) : (
        <View>
          <Row header cells={['Slot', 'Status', 'Date', 'Freelancer', 'Pieces']} widths={[10, 22, 22, 30, 16]} />
          {d.slots.map((slot) => (
            <Row
              key={slot.index}
              cells={[
                `#${slot.index}`,
                slot.status,
                shortDate(slot.date),
                slot.freelancer ?? '—',
                String(slot.pieces),
              ]}
              widths={[10, 22, 22, 30, 16]}
            />
          ))}
        </View>
      )}

      <Text style={s.section}>Content pipeline</Text>
      {p === null ? (
        <Text style={s.empty}>No pipeline row for this period.</Text>
      ) : (
        <View>
          <Row header cells={['Stage', 'When']} widths={[45, 55]} />
          <Row cells={['Visit type', p.visitType ?? '—']} widths={[45, 55]} />
          <Row cells={['Last shoot', shortDate(p.lastShootDate)]} widths={[45, 55]} />
          <Row cells={['Raw received', p.rawReceivedAt ? shortDate(p.rawReceivedAt) : '—']} widths={[45, 55]} />
          <Row cells={['Finals ready', p.finalsReadyAt ? shortDate(p.finalsReadyAt) : '—']} widths={[45, 55]} />
          <Row cells={['Posted', p.postedAt ? shortDate(p.postedAt) : '—']} widths={[45, 55]} />
          <Row cells={['Coming shoot', shortDate(p.comingShootDate)]} widths={[45, 55]} />
        </View>
      )}

      <Text style={s.section}>Calendar</Text>
      {d.calendar.length === 0 ? (
        <Text style={s.empty}>No calendar cells for this period.</Text>
      ) : (
        <View>
          <Row header cells={['Status', 'Days']} widths={[70, 30]} />
          {d.calendar.map((c) => (
            <Row key={c.status} cells={[c.status, String(c.count)]} widths={[70, 30]} />
          ))}
        </View>
      )}
    </>
  );
}

export function ReportDocument({ data, generatedAt }: { data: ReportData; generatedAt: Date }) {
  const title = data.kind === 'org_monthly' ? 'Monthly Report' : data.clientName;
  const stamp = IST.format(generatedAt);

  return (
    <Document
      title={`Skaly — ${title} — ${data.periodLabel}`}
      author="Skaly Business Portal"
      creator="Skaly Business Portal"
    >
      <Page size="A4" style={s.page}>
        <View style={s.brandRow} fixed>
          <Text style={s.brand}>SKALY</Text>
          <Text style={s.brandMeta}>{data.period}</Text>
        </View>

        <Text style={s.title}>{title}</Text>
        <Text style={s.subtitle}>
          {data.periodLabel}
          {data.kind === 'client_monthly'
            ? ` · ${data.shootSlotsPerMonth} shoots/month · ${data.piecesPerVisit} pieces/visit`
            : ''}
        </Text>

        {data.kind === 'org_monthly' ? <OrgBody d={data} /> : <ClientBody d={data} />}

        <View style={s.footer} fixed>
          <Text style={s.footerText}>Generated {stamp} IST</Text>
          {/* The `render` prop is evaluated per page — a plain string here would
              print "1 of 1" on every page of a long report. */}
          <Text
            style={s.footerText}
            render={({ pageNumber, totalPages }) => `${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
