import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import {
  Radar, RefreshCcw, Loader2, Activity, AlertTriangle, Zap,
  Clock, Gauge, CircleCheck, CircleAlert, CircleX,
} from 'lucide-react';

/**
 * RadarHealthView (ADR-161 F12.1/F12.2 — UI) — a materialização visual da SAÚDE
 * do Radar pro admin. É PURA LEITURA: renderiza o que `RadarHealthService`
 * (GET /api/signals/health) e `DetectorBudgetService` (GET /api/signals/detector
 * -budget) derivam por query — não inventa estado, não esconde detector que
 * parou. Espelha o status honesto do backend (ok/watch/degraded).
 *
 * Ambos os endpoints são requireRole(owner/admin); o servidor reforça o gate.
 */

type Status = 'ok' | 'watch' | 'degraded';

interface DetectorHealth {
  detector: string;
  emittedWindow: number;
  lastDetectedAt: string | null;
  ageHours: number | null;
  stale: boolean;
  stormRisk: boolean;
  calibration: 'ok' | 'watch' | 'poor' | 'unknown';
  falsePositiveRate: number;
  dismissalRate: number;
  status: Status;
}

interface HealthReport {
  generatedAt: string;
  windowHours: number;
  staleHours: number;
  calibrationDays: number | null;
  overall: Status;
  totals: { total: number; open: number; byStatus: Record<string, number>; bySeverity: Record<string, number>; byDomain: Record<string, number> };
  detectorSummary: { total: number; ok: number; watch: number; degraded: number; stale: number; storm: number };
  detectors: DetectorHealth[];
}

interface BudgetRow { detector: string; used: number; remaining: number; allowed: boolean }
interface BudgetReport { cap: number; detectors: BudgetRow[] }

const STATUS_META: Record<Status, { label: string; verdict: string; icon: React.ReactNode; ring: string; text: string; chip: string }> = {
  ok: {
    label: 'Radar saudável', verdict: 'Todos os detectores operando dentro do esperado.',
    icon: <CircleCheck className="w-6 h-6" />, ring: 'border-emerald-800/50 bg-emerald-950/30', text: 'text-emerald-300', chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-800/50',
  },
  watch: {
    label: 'Atenção', verdict: 'Sem falha grave, mas há detector parado ou em observação — vale um olhar.',
    icon: <CircleAlert className="w-6 h-6" />, ring: 'border-amber-800/50 bg-amber-950/30', text: 'text-amber-300', chip: 'bg-amber-500/15 text-amber-300 border-amber-800/50',
  },
  degraded: {
    label: 'Degradado', verdict: 'Há detector em storm ou mal calibrado — o Radar está gritando ruído ou gastando à toa.',
    icon: <CircleX className="w-6 h-6" />, ring: 'border-red-900/50 bg-red-950/30', text: 'text-red-300', chip: 'bg-red-500/15 text-red-300 border-red-800/50',
  },
};

const SEV_META: Record<string, string> = {
  critical: 'text-red-300', risk: 'text-amber-300', attention: 'text-sky-300', info: 'text-zinc-400',
};

const fmtAge = (h: number | null) => {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)}min`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
};

export function RadarHealthView() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [budget, setBudget] = useState<BudgetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch('/api/signals/health').then((r) => r.json()),
      apiFetch('/api/signals/detector-budget').then((r) => r.json()).catch(() => null),
    ])
      .then(([h, b]) => {
        if (h && h.overall && Array.isArray(h.detectors)) setReport(h);
        else { setReport(null); setError(h?.error || 'resposta inesperada'); }
        if (b && Array.isArray(b.detectors)) setBudget(b);
      })
      .catch((e) => { setReport(null); setError(String(e?.message || e)); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const meta = report ? STATUS_META[report.overall] : null;
  const budgetByDetector = useMemo(() => {
    const m = new Map<string, BudgetRow>();
    for (const r of budget?.detectors || []) m.set(r.detector, r);
    return m;
  }, [budget]);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Radar className="w-6 h-6 text-indigo-400" />
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Saúde do Radar</h1>
            <p className="text-xs text-zinc-500">
              Volume, frescor, storm, calibração e budget de IA por detector (ADR-161 F12). Derivado por query — só leitura.
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/50 text-sm text-zinc-300 hover:text-zinc-100 disabled:opacity-50"
          title="Recarregar"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
          Recarregar
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-300">
          Erro ao carregar a saúde do Radar: {error}
        </div>
      )}

      {loading && !report && <div className="h-32 rounded-xl border border-zinc-800 bg-zinc-900/40 animate-pulse" />}

      {report && meta && (
        <>
          {/* Verdito geral */}
          <div className={`rounded-2xl border p-5 flex items-start gap-4 ${meta.ring}`}>
            <div className={meta.text}>{meta.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className={`text-lg font-bold ${meta.text}`}>{meta.label}</h2>
                <span className={`px-2 py-0.5 rounded-md border text-[10px] uppercase font-mono ${meta.chip}`}>{report.overall}</span>
              </div>
              <p className="text-sm text-zinc-300 mt-1">{meta.verdict}</p>
              <p className="text-[11px] text-zinc-500 mt-2 font-mono">
                {report.detectorSummary.total} detector(es) · {report.detectorSummary.stale} parado(s) · {report.detectorSummary.storm} em storm · janela {report.windowHours}h · gerado {new Date(report.generatedAt).toLocaleString('pt-BR')}
              </p>
            </div>
          </div>

          {/* Resumo de volume */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryTile icon={<Activity className="w-4 h-4" />} label="Sinais (total)" value={report.totals.total} tone="neutral" />
            <SummaryTile icon={<Zap className="w-4 h-4" />} label="Abertos" value={report.totals.open} tone="neutral" />
            <SummaryTile icon={<Clock className="w-4 h-4" />} label="Parados" value={report.detectorSummary.stale} tone={report.detectorSummary.stale > 0 ? 'warn' : 'good'} />
            <SummaryTile icon={<AlertTriangle className="w-4 h-4" />} label="Em storm" value={report.detectorSummary.storm} tone={report.detectorSummary.storm > 0 ? 'bad' : 'good'} />
          </div>

          {/* Volume por severidade */}
          {Object.keys(report.totals.bySeverity || {}).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {(['critical', 'risk', 'attention', 'info'] as const).map((s) => (
                report.totals.bySeverity[s] ? (
                  <span key={s} className={`rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-1.5 text-sm ${SEV_META[s]}`}>
                    <span className="tabular-nums font-semibold">{report.totals.bySeverity[s]}</span> <span className="text-[11px] uppercase text-zinc-500">{s}</span>
                  </span>
                ) : null
              ))}
            </div>
          )}

          {/* Detectores */}
          <section className="space-y-3">
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Detectores</h3>
              <span className="text-[11px] text-zinc-500">ordenados por gravidade · budget de investigação diária de IA</span>
            </div>
            {report.detectors.length === 0 ? (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
                Nenhum detector emitiu sinais ainda.
              </div>
            ) : (
              <div className="space-y-2">
                {report.detectors.map((d) => <DetectorRow key={d.detector} d={d} budget={budgetByDetector.get(d.detector)} cap={budget?.cap} />)}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SummaryTile({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const toneCls: Record<string, string> = { good: 'text-emerald-300', warn: 'text-amber-300', bad: 'text-red-300', neutral: 'text-zinc-100' };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase text-zinc-500">{icon} {label}</div>
      <div className={`text-2xl font-bold mt-2 tabular-nums ${toneCls[tone]}`}>{value}</div>
    </div>
  );
}

const STATUS_PILL: Record<Status, string> = {
  ok: 'bg-emerald-500/15 text-emerald-300 border-emerald-800/50',
  watch: 'bg-amber-500/15 text-amber-300 border-amber-800/50',
  degraded: 'bg-red-500/15 text-red-300 border-red-800/50',
};

const DetectorRow: React.FC<{ d: DetectorHealth; budget?: BudgetRow; cap?: number }> = ({ d, budget, cap }) => {
  const border = d.status === 'degraded' ? 'border-red-900/40' : d.status === 'watch' ? 'border-amber-900/40' : 'border-zinc-800';
  const pct = cap && cap > 0 && budget ? Math.min(100, Math.round((budget.used / cap) * 100)) : 0;
  return (
    <div className={`rounded-lg border bg-zinc-900/40 p-4 ${border}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-zinc-100 font-mono break-all">{d.detector}</span>
        <span className={`px-2 py-0.5 rounded-md border text-[10px] uppercase font-mono ${STATUS_PILL[d.status]}`}>{d.status}</span>
        {d.stale && <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300"><Clock className="w-3 h-3" /> parado</span>}
        {d.stormRisk && <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300"><AlertTriangle className="w-3 h-3" /> storm</span>}
        {d.calibration === 'poor' && <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300"><Gauge className="w-3 h-3" /> mal calibrado</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-zinc-500">
        <span>janela: <span className="text-zinc-300 tabular-nums">{d.emittedWindow}</span> sinal(is)</span>
        <span>último: <span className="text-zinc-300">{fmtAge(d.ageHours)}</span></span>
        <span>falso-positivo: <span className="text-zinc-300 tabular-nums">{Math.round(d.falsePositiveRate * 100)}%</span></span>
        <span>descarte: <span className="text-zinc-300 tabular-nums">{Math.round(d.dismissalRate * 100)}%</span></span>
      </div>
      {budget && cap ? (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>Budget de investigação IA (hoje)</span>
            <span className="tabular-nums">{budget.used}/{cap}{!budget.allowed && <span className="text-red-300"> · esgotado</span>}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className={`h-full ${pct >= 100 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default RadarHealthView;
