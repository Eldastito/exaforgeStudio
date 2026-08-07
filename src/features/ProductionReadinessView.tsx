import React, { useEffect, useMemo, useState } from 'react';
import {
  ShieldCheck, RefreshCcw, Loader2, CheckCircle2, XCircle,
  AlertTriangle, Ban, CircleCheck, KeyRound, Rocket,
} from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

/**
 * ProductionReadinessView (ADR-154 F10.2) — tela master admin que responde,
 * de forma única e honesta, "este deploy está pronto pra vender?".
 *
 * Consome GET /api/admin/production-readiness (ProductionReadinessService da
 * F10.1). É PURA LEITURA: só renderiza o relatório que o backend produz — não
 * inventa estado nem esconde o que falta. O `email` volta como não-configurado
 * (transporte SMTP é TODO) e a tela mostra isso sem maquiar. Nenhum segredo
 * trafega no payload — só o estado (configurado/faltando) + a dica de env.
 *
 * O verdito (banner) espelha o rollup do backend:
 *   - blocked  → há bloqueador sem config; o produto não sobe.
 *   - degraded → sem bloqueador, mas falta recomendado (arrisca produção).
 *   - ready    → bloqueadores + recomendados ok; pronto pra vender.
 */

type CheckLevel = 'blocker' | 'recommended' | 'optional';

interface ReadinessCheck {
  key: string;
  label: string;
  level: CheckLevel;
  ok: boolean;
  detail: string;
  hint?: string;
}

interface ReadinessReport {
  status: 'ready' | 'degraded' | 'blocked';
  generatedAt: string;
  summary: {
    blockersFailing: number;
    recommendedFailing: number;
    optionalConfigured: number;
    optionalTotal: number;
  };
  checks: ReadinessCheck[];
}

// Metadados de apresentação por rollup — verdito em linguagem de operador.
const STATUS_META: Record<ReadinessReport['status'], {
  label: string; verdict: string; icon: React.ReactNode; ring: string; text: string; chip: string;
}> = {
  ready: {
    label: 'Pronto pra vender',
    verdict: 'Todos os bloqueadores e recomendados estão configurados. Pode subir.',
    icon: <Rocket className="w-6 h-6" />,
    ring: 'border-emerald-800/50 bg-emerald-950/30',
    text: 'text-emerald-300',
    chip: 'bg-emerald-500/15 text-emerald-300 border-emerald-800/50',
  },
  degraded: {
    label: 'Roda, mas com ressalvas',
    verdict: 'Nenhum bloqueador, mas há recomendados faltando — sobe por sua conta e risco.',
    icon: <AlertTriangle className="w-6 h-6" />,
    ring: 'border-amber-800/50 bg-amber-950/30',
    text: 'text-amber-300',
    chip: 'bg-amber-500/15 text-amber-300 border-amber-800/50',
  },
  blocked: {
    label: 'Bloqueado — não sobe pra produção',
    verdict: 'Há bloqueador(es) sem configuração. Sem isso o produto não funciona pra ninguém.',
    icon: <Ban className="w-6 h-6" />,
    ring: 'border-red-900/50 bg-red-950/30',
    text: 'text-red-300',
    chip: 'bg-red-500/15 text-red-300 border-red-800/50',
  },
};

// Metadados por nível — título + o que significa faltar.
const LEVEL_META: Record<CheckLevel, { title: string; blurb: string }> = {
  blocker: {
    title: 'Bloqueadores',
    blurb: 'Sem isto o produto não roda pra ninguém.',
  },
  recommended: {
    title: 'Recomendados',
    blurb: 'Funciona sem, mas degrada ou arrisca produção.',
  },
  optional: {
    title: 'Canais opcionais',
    blurb: 'Recursos opt-in; a ausência só desliga aquele canal.',
  },
};

const LEVEL_ORDER: CheckLevel[] = ['blocker', 'recommended', 'optional'];

export function ProductionReadinessView() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    apiFetch('/api/admin/production-readiness')
      .then(r => r.json())
      .then(d => {
        if (d && Array.isArray(d.checks) && d.status) setReport(d);
        else { setReport(null); setError(d?.error || 'resposta inesperada'); }
      })
      .catch(e => { setReport(null); setError(String(e?.message || e)); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const grouped = useMemo(() => {
    const g: Record<CheckLevel, ReadinessCheck[]> = { blocker: [], recommended: [], optional: [] };
    for (const c of report?.checks || []) (g[c.level] || g.optional).push(c);
    return g;
  }, [report]);

  const statusMeta = report ? STATUS_META[report.status] : null;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-emerald-400" />
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Prontidão de Produção</h1>
            <p className="text-xs text-zinc-500">
              Estado real de cada dependência pra colocar o FalaTu na prateleira (ADR-154 F10). Master Admin.
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
          Erro ao carregar prontidão: {error}
        </div>
      )}

      {loading && !report && (
        <div className="h-32 rounded-xl border border-zinc-800 bg-zinc-900/40 animate-pulse" />
      )}

      {report && statusMeta && (
        <>
          {/* Verdito principal */}
          <div className={`rounded-2xl border p-5 flex items-start gap-4 ${statusMeta.ring}`}>
            <div className={statusMeta.text}>{statusMeta.icon}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className={`text-lg font-bold ${statusMeta.text}`}>{statusMeta.label}</h2>
                <span className={`px-2 py-0.5 rounded-md border text-[10px] uppercase font-mono ${statusMeta.chip}`}>
                  {report.status}
                </span>
              </div>
              <p className="text-sm text-zinc-300 mt-1">{statusMeta.verdict}</p>
              <p className="text-[11px] text-zinc-500 mt-2 font-mono">
                Gerado em {new Date(report.generatedAt).toLocaleString('pt-BR')} · lê o ambiente a cada consulta
              </p>
            </div>
          </div>

          {/* Resumo */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <SummaryTile
              icon={<Ban className="w-4 h-4" />}
              label="Bloqueadores faltando"
              value={report.summary.blockersFailing}
              tone={report.summary.blockersFailing > 0 ? 'bad' : 'good'}
            />
            <SummaryTile
              icon={<AlertTriangle className="w-4 h-4" />}
              label="Recomendados faltando"
              value={report.summary.recommendedFailing}
              tone={report.summary.recommendedFailing > 0 ? 'warn' : 'good'}
            />
            <SummaryTile
              icon={<CircleCheck className="w-4 h-4" />}
              label="Canais opcionais"
              value={`${report.summary.optionalConfigured}/${report.summary.optionalTotal}`}
              tone="neutral"
            />
          </div>

          {/* Checagens por nível */}
          {LEVEL_ORDER.map(level => {
            const checks = grouped[level];
            if (!checks || checks.length === 0) return null;
            return (
              <section key={level} className="space-y-3">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">
                    {LEVEL_META[level].title}
                  </h3>
                  <span className="text-[11px] text-zinc-500">{LEVEL_META[level].blurb}</span>
                </div>
                <div className="space-y-2">
                  {checks.map(c => <CheckRow key={c.key} check={c} />)}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function SummaryTile({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: React.ReactNode;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const toneCls: Record<string, string> = {
    good: 'text-emerald-300',
    warn: 'text-amber-300',
    bad: 'text-red-300',
    neutral: 'text-zinc-100',
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase text-zinc-500">{icon} {label}</div>
      <div className={`text-2xl font-bold mt-2 tabular-nums ${toneCls[tone]}`}>{value}</div>
    </div>
  );
}

const CheckRow: React.FC<{ check: ReadinessCheck }> = ({ check }) => {
  // Um recomendado/bloqueador faltando é problema; um opcional off é só informativo.
  const failIsProblem = check.level !== 'optional';
  const border = check.ok
    ? 'border-zinc-800'
    : failIsProblem
      ? (check.level === 'blocker' ? 'border-red-900/40' : 'border-amber-900/40')
      : 'border-zinc-800';
  return (
    <div className={`rounded-lg border bg-zinc-900/40 p-4 flex items-start gap-3 ${border}`}>
      <div className="mt-0.5">
        {check.ok
          ? <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          : failIsProblem
            ? <XCircle className={`w-5 h-5 ${check.level === 'blocker' ? 'text-red-400' : 'text-amber-400'}`} />
            : <XCircle className="w-5 h-5 text-zinc-600" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-zinc-100">{check.label}</span>
          <StatusPill ok={check.ok} level={check.level} />
        </div>
        <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{check.detail}</p>
        {check.hint && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500">
            <KeyRound className="w-3 h-3 shrink-0" />
            <code className="font-mono text-zinc-400 break-all">{check.hint}</code>
          </div>
        )}
      </div>
    </div>
  );
};

function StatusPill({ ok, level }: { ok: boolean; level: CheckLevel }) {
  if (ok) {
    return <span className="px-2 py-0.5 rounded-md border text-[10px] uppercase font-mono bg-emerald-500/15 text-emerald-300 border-emerald-800/50">configurado</span>;
  }
  if (level === 'optional') {
    return <span className="px-2 py-0.5 rounded-md border text-[10px] uppercase font-mono bg-zinc-800/50 text-zinc-400 border-zinc-700/50">desligado</span>;
  }
  const cls = level === 'blocker'
    ? 'bg-red-500/15 text-red-300 border-red-800/50'
    : 'bg-amber-500/15 text-amber-300 border-amber-800/50';
  return <span className={`px-2 py-0.5 rounded-md border text-[10px] uppercase font-mono ${cls}`}>faltando</span>;
}
