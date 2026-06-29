import { useEffect, useState, useCallback, useRef } from 'react';
import { Gauge, RefreshCw, AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';
import type { RicPeriod, RicSnapshot, RicRecoveryAction } from './types';
import { MoneyKpiCard } from './components/MoneyKpiCard';
import { IqrGauge } from './components/IqrGauge';
import { DriverCard } from './components/DriverCard';
import { DirectorPanel } from './components/DirectorPanel';
import { TopActionsList } from './components/TopActionsList';
import { LossSourcesBars } from './components/LossSourcesBars';
import { SimulatorWidget } from './components/SimulatorWidget';
import { ConfigDrawer } from './components/ConfigDrawer';
import { ExportAuditButton } from './components/ExportAuditButton';
import { DriverDrilldown } from './components/DriverDrilldown';
import { TrendChart } from './components/TrendChart';
import { TrialBanner } from './components/TrialBanner';
import { brl, pct, TICKET_SOURCE_LABEL } from './lib/format';

type DriverKey = 'atendimento' | 'comercial' | 'operacional';

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

const ACTION_STATUS: Record<string, { label: string; cls: string }> = {
  created: { label: 'Rascunho criado', cls: 'border-slate-500/40 bg-slate-500/10 text-slate-300' },
  sent: { label: 'Disparada', cls: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
  converted: { label: 'Recuperou', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
  dismissed: { label: 'Descartada', cls: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-400' },
};

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
  const [drillDriver, setDrillDriver] = useState<DriverKey | null>(null);
  const [actions, setActions] = useState<RicRecoveryAction[]>([]);
  const [actingKey, setActingKey] = useState<string | null>(null);
  const canDelegate = useStore(s => s.isModuleEnabled('execucao'));
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

  const loadActions = useCallback(() => {
    apiFetch('/api/analytics/revenue-intelligence/actions')
      .then(r => r.json())
      .then(d => setActions(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  // Cria a ação de recuperação (campanha rascunho) para uma fonte de perda.
  const act = useCallback(async (sourceKey: string) => {
    setActingKey(sourceKey);
    try {
      const r = await apiFetch('/api/analytics/revenue-intelligence/actions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceKey }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Falha ao criar a ação.');
      toast.success(`Campanha de recuperação criada (rascunho) com ${d.contacts} contato(s). Revise e envie em Campanhas.`);
      loadActions();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível criar a ação.');
    } finally {
      setActingKey(null);
    }
  }, [loadActions]);

  // Delega uma fonte de perda como TAREFA interna para a equipe (Execution Intel).
  const delegate = useCallback(async (_sourceKey: string, label: string) => {
    try {
      const r = await apiFetch('/api/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: label, source: 'ric', priority: 'alta' }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha ao delegar.');
      toast.success('Tarefa criada em Tarefas — defina o responsável lá. 📋');
    } catch (e: any) { toast.error(e.message || 'Não foi possível delegar.'); }
  }, []);

  useEffect(() => { load(period); }, [period, load]);
  useEffect(() => { loadActions(); }, [loadActions]);

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

          <div className="flex flex-wrap items-center gap-3">
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

        {/* ===== Auditoria-trial de 14 dias (GTM) ===== */}
        <TrialBanner period={period} />

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
              <MoneyKpiCard label="Receita recuperada" value={m.recovered} tone="recovered" pulseOnIncrease sublabel={m.rri != null ? `RRI ${pct(m.rri)} · janela ${snapshot.attributionWindowDays}d` : `pelos fluxos do ZappFlow (janela ${snapshot.attributionWindowDays}d)`} />
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
                <DriverCard label="Atendimento" score={snapshot.drivers.atendimento.score} weight={snapshot.iqr.weights.atendimento} items={driverItems(snapshot, 'atendimento')} weakest={snapshot.iqr.weakestDriver === 'atendimento'} onClick={() => setDrillDriver('atendimento')} />
                <DriverCard label="Comercial" score={snapshot.drivers.comercial.score} weight={snapshot.iqr.weights.comercial} items={driverItems(snapshot, 'comercial')} weakest={snapshot.iqr.weakestDriver === 'comercial'} onClick={() => setDrillDriver('comercial')} />
                <DriverCard label="Operacional" score={snapshot.drivers.operacional.score} weight={snapshot.iqr.weights.operacional} items={driverItems(snapshot, 'operacional')} weakest={snapshot.iqr.weakestDriver === 'operacional'} onClick={() => setDrillDriver('operacional')} />
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
                <TopActionsList snapshot={snapshot} onAct={act} actingKey={actingKey} onDelegate={canDelegate ? delegate : undefined} />
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

        {/* ===== Ações de recuperação (loop fechado) ===== */}
        {actions.length > 0 && (
          <div className="mt-5">
            <Card>
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Ações de recuperação</p>
                <span className="text-xs text-slate-500">
                  Recuperado por ações: <span className="font-bold text-ric-success">{brl(actions.reduce((s, a) => s + (a.recovered_amount || 0), 0))}</span>
                </span>
              </div>
              <div className="mt-3 space-y-2">
                {actions.map(a => {
                  const badge = ACTION_STATUS[a.status] || ACTION_STATUS.created;
                  return (
                    <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-ric-border bg-ric-bg/40 px-3 py-2.5">
                      <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                      <span className="flex-1 text-sm text-slate-200">{a.label}</span>
                      <span className="text-xs text-slate-500">{a.contacts_count} contato(s)</span>
                      {a.recovered_amount > 0 && (
                        <span className="text-sm font-bold tabular-nums text-ric-success">{brl(a.recovered_amount)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] text-slate-500">As campanhas são criadas como rascunho — revise e dispare em Campanhas. A receita recuperada é atribuída aos pedidos pagos dos contatos após o disparo.</p>
            </Card>
          </div>
        )}

        {/* ===== Tendência (8) | Simulador (4) — PR 4/5 ===== */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Em risco × recuperada · por janela</p>
            <TrendChart />
          </Card>

          <Card className="lg:col-span-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Simulador rápido</p>
            <SimulatorWidget />
          </Card>
        </div>
      </div>

      <ConfigDrawer open={configOpen} onClose={() => setConfigOpen(false)} onSaved={() => load(period)} />
      {snapshot && <DriverDrilldown snapshot={snapshot} driver={drillDriver} onClose={() => setDrillDriver(null)} />}
    </div>
  );
}
