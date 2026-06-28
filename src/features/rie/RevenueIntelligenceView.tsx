import { useEffect, useState, useCallback, useRef } from 'react';
import { Gauge, RefreshCw, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { apiFetch } from '@/src/lib/api';
import type { RicPeriod, RicSnapshot } from './types';
import { MoneyKpiCard } from './components/MoneyKpiCard';
import { IqrGauge } from './components/IqrGauge';
import { DriverCard } from './components/DriverCard';
import { DirectorPanel } from './components/DirectorPanel';
import { TopActionsList } from './components/TopActionsList';
import { LossSourcesBars } from './components/LossSourcesBars';
import { SimulatorWidget } from './components/SimulatorWidget';
import { ConfigDrawer } from './components/ConfigDrawer';
import { ExportAuditButton } from './components/ExportAuditButton';
import { brl, pct, TICKET_SOURCE_LABEL } from './lib/format';

/**
 * Revenue Intelligence Center — Home (PR 2/5 do front).
 *
 * Faixa de dinheiro + IQR + drivers já com binding real ao snapshot
 * (GET /api/analytics/revenue-intelligence). Top 5 ações, fontes da perda,
 * tendência e simulador seguem em skeleton (PRs 3–5).
 * Ver docs/PRD-UXUI-REVENUE-INTELLIGENCE-CENTER.md.
 */

const PERIODS: { id: RicPeriod; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: 'week', label: '7 dias' },
  { id: 'month', label: '30 dias' },
  { id: 'all', label: 'Tudo' },
];

function Card({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-ric-card border border-ric-border bg-ric-surface p-5 ${className}`}>
      {children}
    </div>
  );
}

// Itens do breakdown que melhor explicam cada driver (composição transparente).
function driverItems(snapshot: RicSnapshot, key: 'atendimento' | 'comercial' | 'operacional') {
  const b = snapshot.drivers[key].breakdown;
  if (key === 'atendimento') {
    return [
      { label: '1ª resposta', value: `${b.firstResponseSec ?? 0}s` },
      { label: 'abandono', value: pct(b.abandonRatePct ?? 0) },
      { label: 'leads parados', value: String(b.stalledLeads ?? 0) },
    ];
  }
  if (key === 'comercial') {
    return [
      { label: 'conversão', value: pct(b.conversionPct ?? 0) },
      { label: 'orçam. parados', value: String(b.staleQuotes ?? 0) },
      { label: 'negócios frios', value: String(b.coldDeals ?? 0) },
    ];
  }
  return [
    { label: 'repasse humano', value: pct(b.handoffRatePct ?? 0) },
    { label: 'ciclo até venda', value: `${b.avgTimeToSaleHours ?? 0}h` },
  ];
}

export function RevenueIntelligenceView() {
  const [period, setPeriod] = useState<RicPeriod>('month');
  const [snapshot, setSnapshot] = useState<RicSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const topActionsRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (p: RicPeriod) => {
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch(`/api/analytics/revenue-intelligence?period=${p}`);
      if (!res.ok) throw new Error(String(res.status));
      setSnapshot(await res.json());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(period); }, [period, load]);

  const m = snapshot?.money;
  const ticketSrc = m ? (TICKET_SOURCE_LABEL[m.ticket.source] || m.ticket.source) : '';
  const lossInfo = m ? `${m.formula} · ticket ${brl(m.ticket.value, 2)} (${ticketSrc})` : '';

  return (
    <div className="flex-1 overflow-y-auto bg-ric-bg custom-scroll">
      <div className="mx-auto w-full max-w-[1400px] p-6">
        {/* ===== Header ===== */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-ric-card bg-ric-primary/15 ring-1 ring-ric-primary/30">
              <Gauge className="h-5 w-5 text-ric-primary-2" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight text-slate-100">Revenue Intelligence</h2>
              <p className="text-sm text-slate-400">Onde está o dinheiro que sua empresa está deixando na mesa.</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded-ric-card border border-ric-border bg-ric-surface p-1">
              {PERIODS.map(p => (
                <button
                  key={p.id}
                  onClick={() => setPeriod(p.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    period === p.id ? 'bg-ric-primary text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setConfigOpen(true)}
              title="Calibrar a fórmula"
              className="flex items-center gap-2 rounded-ric-card border border-ric-border bg-ric-surface px-3 py-2 text-xs font-semibold text-slate-300 transition-colors hover:bg-ric-surface-2"
            >
              <SlidersHorizontal className="h-4 w-4" /> Calibrar
            </button>
            <ExportAuditButton period={period} />
          </div>
        </div>

        {/* ===== Erro ===== */}
        {error && (
          <div className="mt-6 flex items-center justify-between rounded-ric-card border border-rose-500/30 bg-rose-500/5 p-4">
            <div className="flex items-center gap-3 text-sm text-rose-300">
              <AlertTriangle className="h-5 w-5" /> Não consegui carregar os dados do Revenue Intelligence.
            </div>
            <button onClick={() => load(period)} className="flex items-center gap-2 rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/10">
              <RefreshCw className="h-3.5 w-3.5" /> Tentar de novo
            </button>
          </div>
        )}

        {/* ===== Faixa de dinheiro (4 KPI) ===== */}
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {loading || !m ? (
            ['Receita em risco', 'Receita recuperável', 'Receita recuperada', 'Ticket-base'].map((label, i) => (
              <Card key={label}>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
                <Skeleton className="mt-3 h-9 w-32 bg-slate-700/40" />
                <Skeleton className="mt-2 h-3 w-24 bg-slate-700/30" />
                <div className="mt-4 h-1 w-full rounded-full" style={{ background: ['#ff8a4c', '#ffb648', '#36e39a', '#6366f1'][i], opacity: 0.3 }} />
              </Card>
            ))
          ) : (
            <>
              <MoneyKpiCard
                label="Receita em risco"
                value={m.estimatedLoss}
                tone="risk"
                chip="potencial em risco"
                info={lossInfo}
                sublabel={m.ticket.source === 'fallback' ? 'Defina o ticket médio para estimar' : undefined}
              />
              <MoneyKpiCard label="Receita recuperável" value={m.recoverable} tone="recoverable" sublabel="alta chance de recuperação (IRR)" />
              <MoneyKpiCard label="Receita recuperada" value={m.recovered} tone="recovered" sublabel={`pelos fluxos do ZappFlow (janela ${snapshot.attributionWindowDays}d)`} />
              <MoneyKpiCard label="Ticket-base" value={m.ticket.value} tone="info" decimals={2} sublabel={ticketSrc} />
            </>
          )}
        </div>

        {/* ===== IQR + drivers (8) | Diretor IA (4) ===== */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">IQR · Índice de Qualidade da Receita</p>
            {loading || !snapshot ? (
              <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-4">
                <div className="flex flex-col items-center justify-center sm:col-span-1">
                  <Skeleton className="h-24 w-24 rounded-full bg-slate-700/40" />
                  <Skeleton className="mt-3 h-3 w-16 bg-slate-700/30" />
                </div>
                {['Atendimento', 'Comercial', 'Operacional'].map(d => (
                  <div key={d} className="rounded-xl border border-ric-border bg-ric-bg/40 p-3">
                    <p className="text-xs font-medium text-slate-400">{d}</p>
                    <Skeleton className="mt-2 h-7 w-12 bg-slate-700/40" />
                    <Skeleton className="mt-2 h-2 w-full bg-slate-700/30" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-4">
                <div className="flex items-center justify-center sm:col-span-1">
                  <IqrGauge score={snapshot.iqr.score} narrative={snapshot.iqr.narrative} />
                </div>
                <DriverCard label="Atendimento" score={snapshot.drivers.atendimento.score} weight={snapshot.iqr.weights.atendimento} items={driverItems(snapshot, 'atendimento')} weakest={snapshot.iqr.weakestDriver === 'atendimento'} />
                <DriverCard label="Comercial" score={snapshot.drivers.comercial.score} weight={snapshot.iqr.weights.comercial} items={driverItems(snapshot, 'comercial')} weakest={snapshot.iqr.weakestDriver === 'comercial'} />
                <DriverCard label="Operacional" score={snapshot.drivers.operacional.score} weight={snapshot.iqr.weights.operacional} items={driverItems(snapshot, 'operacional')} weakest={snapshot.iqr.weakestDriver === 'operacional'} />
              </div>
            )}
          </Card>

          {/* Diretor IA — painel fixo, glow ciano */}
          <DirectorPanel
            onRecover={() => topActionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        </div>

        {/* ===== Top 5 ações (8) | Fontes da perda (4) ===== */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div ref={topActionsRef} className="lg:col-span-8">
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Top 5 ações prioritárias</p>
              {loading || !snapshot ? (
                <div className="mt-4 space-y-3">
                  {[0, 1, 2, 3, 4].map(i => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-7 w-7 rounded-full bg-slate-700/40" />
                      <Skeleton className="h-4 flex-1 bg-slate-700/30" />
                      <Skeleton className="h-4 w-20 bg-slate-700/30" />
                    </div>
                  ))}
                </div>
              ) : (
                <TopActionsList snapshot={snapshot} />
              )}
            </Card>
          </div>

          <Card className="lg:col-span-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Fontes da perda</p>
            {loading || !snapshot ? (
              <div className="mt-4 space-y-4">
                {[0, 1, 2, 3].map(i => (
                  <div key={i}>
                    <Skeleton className="h-3 w-32 bg-slate-700/30" />
                    <Skeleton className="mt-2 h-2 w-full bg-slate-700/20" />
                  </div>
                ))}
              </div>
            ) : (
              <LossSourcesBars snapshot={snapshot} />
            )}
          </Card>
        </div>

        {/* ===== Tendência (8) | Simulador (4) — PR 4/5 ===== */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Tendência — desde a conexão</p>
            <Skeleton className="mt-4 h-40 w-full bg-slate-700/25" />
          </Card>

          <Card className="lg:col-span-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Simulador rápido</p>
            <SimulatorWidget />
          </Card>
        </div>
      </div>

      <ConfigDrawer open={configOpen} onClose={() => setConfigOpen(false)} onSaved={() => load(period)} />
    </div>
  );
}
