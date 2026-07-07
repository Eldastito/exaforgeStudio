import type { ReactNode } from 'react';
import { useState, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, RadialBarChart, RadialBar, PolarAngleAxis,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Users, Briefcase, Bot, Download, Target,
  Activity, Sparkles, Zap, MessageSquare, CalendarCheck, UserCheck, Loader2, Radar,
} from 'lucide-react';
import { motion } from 'motion/react';
import { format } from 'date-fns';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';
import { CheckCircle2, Circle, ArrowRight, Rocket, X, PartyPopper, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { BigIdeaBar } from '@/src/components/BigIdeaBar';
import { RecognitionInbox } from '@/src/components/RecognitionInbox';

const C = {
  indigo: '#6366f1', violet: '#8b5cf6', emerald: '#10b981',
  amber: '#f59e0b', rose: '#f43f5e', sky: '#38bdf8',
};
const DONUT = [C.emerald, C.rose, C.indigo, C.amber, C.sky, C.violet];

const PERIODS: { id: 'today' | 'week' | 'month' | 'all'; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: 'week', label: '7 dias' },
  { id: 'month', label: '30 dias' },
  { id: 'all', label: 'Tudo' },
];

type Metrics = {
  totalTickets: number;
  newLeadsCount: number;
  salesCount: number;
  handoffCount: number;
  appointmentCount: number;
  chartData: { name: string; tickets: number }[];
  channelData: { channel_id: string; count: number }[];
  aiResponseCount: number;
  averageFirstResponseTime: number;
  resolutionRateAI: number;
  deltas?: { tickets: number; sales: number; ai: number; appointments: number };
  series?: { tickets: number[]; ai: number[]; sales: number[]; appointments: number[] };
  averageOrderValue?: number;
  paidRevenue?: number;
  funnelByStage?: { stage: string; count: number }[];
  lossReasons?: { reason: string; count: number }[];
  lossCount?: number;
  stageVelocity?: { stage: string; avgHours: number; n: number }[];
  avgTimeToSaleHours?: number;
  csat?: { responses: number; avgScore: number; detractors: number; satisfactionPct: number };
  hospitality?: {
    firstResponseSeconds: number; qualifiedRate: number;
    quotesSent: number; quotesAccepted: number; quotesAcceptRate: number;
    abandonedNudged: number; abandonedRecovered: number; abandonedRecoveryRate: number;
    bookingsCreated: number; eventsCreated: number; eventsWon: number;
  };
};

type TooltipLike = { active?: boolean; payload?: any[]; label?: string | number };

function ChartTooltip({ active, payload, label, suffix = '' }: TooltipLike & { suffix?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-700/60 bg-slate-900/95 px-3.5 py-2.5 shadow-2xl backdrop-blur-md">
      {label !== undefined && (
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-slate-400">{label}</p>
      )}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color || p.fill || C.indigo }} />
          <span className="text-sm font-semibold text-white">
            {typeof p.value === 'number' ? p.value.toLocaleString('pt-BR') : p.value}{suffix}
          </span>
        </div>
      ))}
    </div>
  );
}

function fmtDate(name: string): string {
  try { return format(new Date(name), 'dd/MM'); } catch { return name; }
}

// Formata uma duração em segundos de forma legível (ex.: 45s, 2m 5s, 1h 3m).
function fmtDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

type Profit = {
  revenue: number; cost: number; profit: number; margin: number; orders: number;
  hasCostData: boolean; byProduct: { name: string; qty: number; revenue: number; cost: number; profit: number; margin: number }[];
};

type ChecklistItem = { key: string; label: string; done: boolean; view: string };
type Checklist = { items: ChecklistItem[]; completed: number; total: number; pct: number };

const COLLAPSED_KEY = 'zappflow_setup_collapsed';
const DONE_ACK_KEY = 'zappflow_setup_done_ack';

function SetupChecklist() {
  const setViewMode = useStore(s => s.setViewMode);
  const [data, setData] = useState<Checklist | null>(null);
  // Recolhido: vira uma pílula discreta, mas continua reabrível.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  // Celebração "tudo pronto" já reconhecida pelo usuário.
  const [doneAck, setDoneAck] = useState(() => {
    try { return localStorage.getItem(DONE_ACK_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    apiFetch('/api/analytics/setup-checklist')
      .then(r => r.json())
      .then(d => { if (d && Array.isArray(d.items)) setData(d); })
      .catch(() => {});
  }, []);

  if (!data) return null;
  const allDone = data.completed >= data.total;

  const collapse = () => {
    try { localStorage.setItem(COLLAPSED_KEY, '1'); } catch { /* noop */ }
    setCollapsed(true);
  };
  const expand = () => {
    try { localStorage.removeItem(COLLAPSED_KEY); } catch { /* noop */ }
    setCollapsed(false);
  };
  const ackDone = () => {
    try { localStorage.setItem(DONE_ACK_KEY, '1'); } catch { /* noop */ }
    setDoneAck(true);
  };

  // ===== Tudo concluído =====
  if (allDone) {
    // Já comemorou e reconheceu: some de vez (dashboard limpo).
    if (doneAck) return null;
    // Recolhido: pílula de celebração reabrível.
    if (collapsed) {
      return (
        <button
          onClick={expand}
          className="group inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/15"
        >
          <PartyPopper className="h-4 w-4" /> Configuração concluída
        </button>
      );
    }
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
        className="relative overflow-hidden rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-600/15 via-emerald-500/5 to-slate-900/40 p-6 md:p-8 text-center"
      >
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-emerald-500/20 blur-3xl" />
        <button onClick={collapse} className="absolute right-4 top-4 text-slate-500 hover:text-slate-300" title="Recolher"><X className="h-4 w-4" /></button>
        <div className="relative mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/15">
          <PartyPopper className="h-7 w-7 text-emerald-300" />
        </div>
        <h3 className="relative text-xl md:text-2xl font-bold text-white">Tudo pronto! 🎉</h3>
        <p className="relative mx-auto mt-2 max-w-md text-sm text-slate-300">
          Você concluiu todos os passos de configuração. Sua IA está pronta para atender e vender. Bom trabalho!
        </p>
        <div className="relative mt-5 flex items-center justify-center gap-3">
          <button
            onClick={() => setViewMode('kanban' as any)}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            Ir para o atendimento <ArrowRight className="h-4 w-4" />
          </button>
          <button onClick={ackDone} className="rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700">
            Concluir
          </button>
        </div>
      </motion.div>
    );
  }

  // ===== Em progresso, recolhido: pílula reabrível =====
  if (collapsed) {
    return (
      <button
        onClick={expand}
        className="group inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 transition-colors hover:bg-indigo-500/15"
      >
        <Rocket className="h-4 w-4" />
        Primeiros passos
        <span className="rounded-full bg-indigo-500/20 px-1.5 py-0.5 text-xs font-semibold text-indigo-200">{data.completed}/{data.total}</span>
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </button>
    );
  }

  // ===== Em progresso, expandido: checklist completo =====
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
      className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-600/10 to-slate-900/40 p-4 md:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600/20 border border-indigo-500/30">
            <Rocket className="h-5 w-5 text-indigo-300" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">Configure sua conta</h3>
            <p className="text-sm text-slate-400">Conclua os passos abaixo para começar a vender com a IA.</p>
          </div>
        </div>
        <button onClick={collapse} className="text-slate-500 hover:text-slate-300" title="Recolher"><X className="h-4 w-4" /></button>
      </div>

      {/* Progresso */}
      <div className="mt-4 flex items-center gap-3">
        <div className="h-2 flex-1 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${data.pct}%` }} />
        </div>
        <span className="text-xs font-semibold text-indigo-300">{data.completed}/{data.total}</span>
      </div>

      {/* Itens */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {data.items.map(it => (
          <button
            key={it.key}
            onClick={() => !it.done && setViewMode(it.view as any)}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
              it.done
                ? 'border-emerald-500/20 bg-emerald-500/5 text-slate-400 cursor-default'
                : 'border-slate-800 bg-slate-900/40 text-slate-200 hover:border-indigo-500/40'
            }`}
          >
            {it.done
              ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              : <Circle className="h-4 w-4 shrink-0 text-slate-600" />}
            <span className={`flex-1 ${it.done ? 'line-through' : ''}`}>{it.label}</span>
            {!it.done && <ArrowRight className="h-3.5 w-3.5 text-slate-500" />}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

export function DashboardPanel() {
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'all'>('month');
  const [m, setM] = useState<Metrics | null>(null);
  const [profit, setProfit] = useState<Profit | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  // Radar Score (ADR-025): melhor esforço — módulo desabilitado (403) ou sem
  // sessão pontuada ({score:null}) simplesmente não mostram o card; o painel
  // nunca quebra por causa do Radar.
  const [radarScore, setRadarScore] = useState<{ score: number; status: string; completedAt?: string } | null>(null);
  const [planAlerts, setPlanAlerts] = useState<{ key: string; label: string; pct: number; level: string }[]>([]);
  const [detractors, setDetractors] = useState<any[]>([]);
  const [showDetractors, setShowDetractors] = useState(false);

  useEffect(() => {
    apiFetch('/api/plans/alerts').then(r => r.json()).then(d => { if (Array.isArray(d?.alerts)) setPlanAlerts(d.alerts); }).catch(() => {});
    apiFetch('/api/analytics/detractors?days=90').then(r => r.json()).then(d => setDetractors(d.detractors || [])).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/api/analytics/profit?period=${period}`)
      .then(r => r.json()).then(d => { if (!cancelled) setProfit(d); }).catch(() => {});
    apiFetch(`/api/analytics/metrics?period=${period}`)
      .then(r => r.json())
      .then(data => { if (!cancelled) setM(data); })
      .catch(err => console.error('Falha ao carregar métricas:', err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/radar/latest-score')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d && d.score != null) setRadarScore(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const exportPdf = async () => {
    setExporting(true);
    try {
      const res = await apiFetch('/api/analytics/reports/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'full', period }),
      });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `relatorio-${period}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      toast.error('Não foi possível gerar o PDF.');
    } finally {
      setExporting(false);
    }
  };

  const totalTickets = m?.totalTickets ?? 0;
  const sales = m?.salesCount ?? 0;
  const conversion = totalTickets ? Math.round((sales / totalTickets) * 100) : 0;
  const automation = m?.resolutionRateAI ?? 0;
  const frt = m?.averageFirstResponseTime ?? 0;

  const D = m?.deltas;
  const S = m?.series;

  const area = (m?.chartData ?? []).map(d => ({ name: fmtDate(d.name), tickets: d.tickets }));
  const donut = (m?.channelData ?? []).map((d, i) => ({
    name: d.channel_id ? `Canal ${i + 1}` : 'Direto',
    value: d.count,
    color: DONUT[i % DONUT.length],
  }));
  const totalContacts = donut.reduce((s, d) => s + d.value, 0);
  const spark = (a?: number[]) => (a ?? []).map((v, i) => ({ i, v }));

  return (
    <div className="custom-scroll relative flex-1 overflow-y-auto bg-gradient-to-b from-slate-950 via-slate-950 to-[#0b1020]">
      <div className="pointer-events-none absolute right-0 top-16 h-72 w-72 rounded-full bg-indigo-600/10 blur-[120px]" />
      <div className="relative mx-auto w-full max-w-7xl space-y-6 md:space-y-8 p-4 md:p-8">

        {/* HEADER */}
        <motion.div
          initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
          className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
        >
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-medium text-indigo-300">
                <Sparkles className="h-3 w-3" /> Relatório Premium
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Ao vivo
              </span>
            </div>
            <h2 className="bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-2xl md:text-3xl font-bold tracking-tight text-transparent">
              Performance de Atendimento
            </h2>
            <p className="mt-1 text-sm text-slate-400">Métricas de SLA, conversão e produtividade da IA em tempo real.</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex flex-1 sm:flex-none rounded-xl border border-slate-800 bg-slate-900/60 p-1 backdrop-blur">
              {PERIODS.map(p => (
                <button
                  key={p.id} onClick={() => setPeriod(p.id)}
                  className={`flex-1 sm:flex-none rounded-lg px-2.5 sm:px-3 py-1.5 text-xs font-medium transition-all ${
                    period === p.id ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >{p.label}</button>
              ))}
            </div>
            <button
              onClick={exportPdf} disabled={exporting}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 sm:px-4 py-2 text-xs font-medium text-slate-200 backdrop-blur transition-colors hover:border-indigo-500/40 hover:text-white disabled:opacity-50"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              <span className="hidden sm:inline">Exportar PDF</span>
              <span className="sm:hidden">PDF</span>
            </button>
          </div>
        </motion.div>

        <SetupChecklist />

        {planAlerts.length > 0 && (
          <div className="space-y-2">
            {planAlerts.map(a => (
              <div key={a.key} className={`flex items-center gap-3 rounded-xl border p-3 text-sm ${a.level === 'exceeded' ? 'bg-red-500/10 border-red-500/30 text-red-300' : a.level === 'critical' ? 'bg-amber-500/10 border-amber-500/30 text-amber-300' : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300'}`}>
                <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                <span><strong>{a.label}:</strong> {a.level === 'exceeded' ? `Limite do plano atingido (${a.pct}%).` : `${a.pct}% do limite usado.`}</span>
              </div>
            ))}
          </div>
        )}

        {loading && !m ? (
          <div className="space-y-6">
            {/* KPI cards skeleton */}
            <div className="grid grid-cols-1 gap-4 md:gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-10 w-10 rounded-xl" />
                    <Skeleton className="h-5 w-12 rounded-full" />
                  </div>
                  <Skeleton className="mt-4 h-7 w-24" />
                  <Skeleton className="mt-2 h-3 w-28" />
                  <Skeleton className="mt-4 h-10 w-full" />
                </div>
              ))}
            </div>
            {/* Charts skeleton */}
            <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 lg:col-span-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-4 h-64 w-full" />
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mx-auto mt-6 h-44 w-44 rounded-full" />
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* KPI CARDS */}
            <div className="grid grid-cols-1 gap-4 md:gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard index={0} title="Total de Tickets" value={totalTickets.toLocaleString('pt-BR')} delta={D?.tickets ?? 0}
                caption={`${m?.newLeadsCount ?? 0} novos leads`} icon={<Briefcase className="h-5 w-5" />} accent={C.indigo}
                series={spark(S?.tickets)} />
              <KpiCard index={1} title="Taxa de Conversão" value={`${conversion}%`} delta={D?.sales ?? 0}
                caption={`${sales} vendas`} icon={<Target className="h-5 w-5" />} accent={C.emerald}
                series={spark(S?.sales)} />
              <KpiCard index={2} title="Respostas da IA" value={(m?.aiResponseCount ?? 0).toLocaleString('pt-BR')} delta={D?.ai ?? 0}
                caption="Mensagens automáticas" icon={<Bot className="h-5 w-5" />} accent={C.violet}
                series={spark(S?.ai)} />
              <KpiCard index={3} title="Agendamentos" value={(m?.appointmentCount ?? 0).toLocaleString('pt-BR')} delta={D?.appointments ?? 0}
                caption={`${m?.handoffCount ?? 0} handoffs p/ humano`} icon={<CalendarCheck className="h-5 w-5" />} accent={C.amber}
                series={spark(S?.appointments)} />
            </div>

            {/* BIG IDEA BAR (Knaflic, ADR-048) — IA lê os KPIs e devolve
                "e daí?" + ação recomendada. Não substitui os gráficos; ancora
                a interpretação antes deles. Cache por hash no backend. */}
            {m && (
              <BigIdeaBar
                panelKey={`dashboard:${period}`}
                data={{
                  period,
                  totalTickets, sales, conversion,
                  automation, frt,
                  newLeads: m.newLeadsCount, appointments: m.appointmentCount, handoffs: m.handoffCount,
                  deltas: D,
                  csat: m.csat,
                  hospitality: m.hospitality,
                  paidRevenue: m.paidRevenue, aov: m.averageOrderValue,
                  avgTimeToSaleHours: m.avgTimeToSaleHours,
                }}
              />
            )}

            {/* NOTAS DE RECONHECIMENTO (Hunter, ADR-049) — o Diretor IA
                puxa da memória do dono momentos que merecem reconhecimento
                (CSAT 5, cliente recuperado, etc.). Só aparece quando há
                sugestões abertas. */}
            <RecognitionInbox />

            {/* RADAR SCORE (ADR-025) — só aparece quando o módulo Radar está
                ativo E existe uma sessão com score calculado. */}
            {radarScore && (
              <motion.div
                initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.28 }}
                className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur"
              >
                <div className="absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, #2dd4bf, transparent)' }} />
                <div className="flex items-center gap-4">
                  <div className="rounded-xl border p-2.5" style={{ borderColor: '#2dd4bf33', backgroundColor: '#2dd4bf1a', color: '#2dd4bf' }}>
                    <Radar className="h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-medium text-slate-400">Radar de Execução IA — maturidade da operação</p>
                    <p className="text-sm text-slate-500 mt-0.5">
                      {radarScore.status === 'awaiting_review' ? 'Diagnóstico aguardando revisão' : 'Último diagnóstico concluído'}
                      {radarScore.completedAt ? ` em ${format(new Date(radarScore.completedAt), 'dd/MM/yyyy')}` : ''} — detalhes no módulo Radar.
                    </p>
                  </div>
                  <p className="text-3xl font-bold tracking-tight text-white tabular-nums">{radarScore.score}<span className="text-base font-medium text-slate-500">/100</span></p>
                </div>
              </motion.div>
            )}

            {/* LUCRO / MARGEM */}
            {profit && (
              <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
                <Panel index={3} className="lg:col-span-1" title="Lucro do período" subtitle={profit.hasCostData ? `${profit.orders} pedido(s) faturado(s)` : 'cadastre o custo no estoque'} icon={<TrendingUp className="h-4 w-4" />}>
                  <div className="space-y-3 pt-1">
                    <div className="flex items-end justify-between">
                      <span className="text-2xl md:text-3xl font-bold bg-gradient-to-r from-emerald-300 to-emerald-500 bg-clip-text text-transparent break-all">
                        R$ {Number(profit.profit).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </span>
                      <span className="mb-1 inline-flex items-center rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                        {profit.margin}% margem
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-center">
                      <div className="rounded-lg border border-slate-800 bg-slate-950/40 py-2">
                        <p className="text-sm font-bold text-slate-200">R$ {Number(profit.revenue).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                        <p className="text-[10px] text-slate-500">Receita</p>
                      </div>
                      <div className="rounded-lg border border-slate-800 bg-slate-950/40 py-2">
                        <p className="text-sm font-bold text-rose-300">R$ {Number(profit.cost).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                        <p className="text-[10px] text-slate-500">Custo</p>
                      </div>
                    </div>
                    {!profit.hasCostData && (
                      <p className="text-[11px] text-amber-400/80">Registre o custo das mercadorias (Catálogo → 📦 → Entrada) para ver o lucro real.</p>
                    )}
                  </div>
                </Panel>

                <Panel index={4} className="lg:col-span-2" title="Lucro por produto" subtitle="Top itens por lucro no período" icon={<Target className="h-4 w-4" />}>
                  {profit.byProduct.length === 0 ? (
                    <p className="py-8 text-center text-sm text-slate-500">Sem vendas faturadas no período.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {profit.byProduct.map((p, i) => (
                        <div key={i} className="flex items-center justify-between text-sm border border-slate-800 rounded-lg px-3 py-2">
                          <span className="text-slate-300 truncate pr-2">{p.name} <span className="text-slate-600">×{p.qty}</span></span>
                          <span className="flex items-center gap-3 shrink-0">
                            <span className="font-mono text-emerald-400">R$ {Number(p.profit).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                            <span className="text-[11px] text-slate-500 w-12 text-right">{p.margin}%</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              </div>
            )}

            {/* VOLUME + FUNIL */}
            <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
              <Panel index={4} className="lg:col-span-2" title="Volume de Atendimentos" subtitle="Tickets por dia (últimos 7 dias)" icon={<MessageSquare className="h-4 w-4" />}>
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={area} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                      <defs>
                        <linearGradient id="gVol" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={C.indigo} stopOpacity={0.45} />
                          <stop offset="95%" stopColor={C.indigo} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis dataKey="name" stroke="#475569" fontSize={12} tickLine={false} axisLine={false} />
                      <YAxis stroke="#475569" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#334155', strokeWidth: 1 }} />
                      <Area type="monotone" dataKey="tickets" name="Tickets" stroke={C.indigo} strokeWidth={2.5} fill="url(#gVol)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Panel>

              <Panel index={5} title="Resumo do Funil" subtitle="Indicadores principais" icon={<Activity className="h-4 w-4" />}>
                <div className="space-y-3 pt-1">
                  <FunnelRow label="Novos Leads" value={m?.newLeadsCount ?? 0} max={totalTickets} color={C.sky} />
                  <FunnelRow label="Vendas" value={sales} max={totalTickets} color={C.emerald} />
                  <FunnelRow label="Agendamentos" value={m?.appointmentCount ?? 0} max={totalTickets} color={C.amber} />
                  <FunnelRow label="Handoffs (Humano)" value={m?.handoffCount ?? 0} max={totalTickets} color={C.rose} />
                </div>
                <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <p className="text-xs text-slate-400">Conversão fim a fim</p>
                  <div className="mt-1 flex items-end gap-2">
                    <span className="text-2xl font-bold text-white">{conversion}%</span>
                    {(D?.sales ?? 0) >= 0 ? (
                      <span className="mb-1 inline-flex items-center text-xs font-medium text-emerald-400">
                        <TrendingUp className="h-3.5 w-3.5" /> {(D?.sales ?? 0) > 0 ? `+${D?.sales}% vs período anterior` : 'estável'}
                      </span>
                    ) : (
                      <span className="mb-1 inline-flex items-center text-xs font-medium text-rose-400">
                        <TrendingDown className="h-3.5 w-3.5" /> {D?.sales}% vs período anterior
                      </span>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-slate-400">Ticket médio</p>
                      <span className="text-lg font-bold text-white">
                        {`R$ ${Number(m?.averageOrderValue ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
                      </span>
                    </div>
                    <div>
                      <p className="text-xs text-slate-400">Tempo até a venda</p>
                      <span className="text-lg font-bold text-white">
                        {(m?.avgTimeToSaleHours ?? 0) > 0
                          ? ((m?.avgTimeToSaleHours ?? 0) >= 24
                              ? `${Math.round((m?.avgTimeToSaleHours ?? 0) / 24 * 10) / 10} d`
                              : `${m?.avgTimeToSaleHours} h`)
                          : '—'}
                      </span>
                    </div>
                  </div>
                </div>
                {/* Por que perdemos vendas — agregação dos motivos de fechamento sem sucesso. */}
                {(m?.lossReasons?.length ?? 0) > 0 && (
                  <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <p className="text-xs text-slate-400">Por que perdemos ({m?.lossCount ?? 0})</p>
                    <div className="mt-2 space-y-1.5">
                      {(m?.lossReasons ?? []).slice(0, 5).map((r) => (
                        <div key={r.reason} className="flex items-center justify-between text-xs">
                          <span className="text-slate-400">{r.reason}</span>
                          <span className="font-mono text-rose-300">{r.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Satisfação (CSAT) — média, % satisfeitos e detratores com timeline. */}
                {(m?.csat?.responses ?? 0) > 0 && (
                  <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <p className="text-xs text-slate-400">Satisfação ({m?.csat?.responses ?? 0} respostas)</p>
                    <div className="mt-1 flex items-end gap-2">
                      <span className="text-2xl font-bold text-white">{m?.csat?.avgScore ?? 0}<span className="text-sm text-slate-500">/5</span></span>
                      <span className="mb-1 text-xs font-medium text-emerald-400">{m?.csat?.satisfactionPct ?? 0}% satisfeitos</span>
                      {(m?.csat?.detractors ?? 0) > 0 && (
                        <button onClick={() => setShowDetractors(!showDetractors)}
                          className="mb-1 text-xs font-medium text-rose-400 hover:text-rose-300 underline underline-offset-2">
                          {m?.csat?.detractors} detrator(es)
                        </button>
                      )}
                    </div>
                    {showDetractors && detractors.length > 0 && (
                      <div className="mt-3 space-y-2 max-h-48 overflow-y-auto">
                        {detractors.map((d: any) => (
                          <div key={d.id} className="rounded-lg bg-slate-900/60 border border-slate-800 p-2 text-xs">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-300 font-medium">{d.contact_name || d.contact_identifier}</span>
                              <span className="text-rose-400 font-mono">nota {d.score}</span>
                            </div>
                            {d.comment && d.follow_up_status === 'captured' && (
                              <p className="mt-1 text-slate-400 italic">"{d.comment}"</p>
                            )}
                            <p className="mt-0.5 text-slate-600">{new Date(d.answered_at).toLocaleDateString('pt-BR')}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            </div>

            {/* FUNIL POR ETAPA (drop-off) */}
            {(m?.funnelByStage?.length ?? 0) > 0 && (
              <Panel index={8} title="Funil por Etapa" subtitle="Quantos tickets alcançaram cada estágio (e o tempo médio)" icon={<Activity className="h-4 w-4" />}>
                <div className="space-y-2.5 pt-1">
                  {(() => {
                    const STAGE_LABELS: Record<string, string> = {
                      novo_lead: 'Novo Lead', ia_atendendo: 'IA Atendendo', qualificado: 'Qualificado',
                      proposta: 'Proposta', aguardando_pagamento: 'Aguard. Pagto', agendado: 'Agendado',
                      em_execucao: 'Em Execução', entregue_concluido: 'Concluído', pos_venda: 'Pós-venda', perdido: 'Perdido',
                    };
                    const fs = m?.funnelByStage ?? [];
                    const top = Math.max(1, ...fs.map(s => s.count));
                    const velMap = new Map<string, number>((m?.stageVelocity ?? []).map(v => [v.stage, v.avgHours] as [string, number]));
                    return fs.filter(s => s.stage !== 'perdido').map((s, i) => {
                      const prev = i > 0 ? fs[i - 1].count : s.count;
                      const drop = prev > 0 && i > 0 ? Math.round((1 - s.count / prev) * 100) : 0;
                      const h = velMap.get(s.stage);
                      return (
                        <div key={s.stage}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-300">{STAGE_LABELS[s.stage] || s.stage}</span>
                            <span className="flex items-center gap-2">
                              {h ? <span className="text-slate-500">{h >= 24 ? `${Math.round(h / 24 * 10) / 10}d` : `${h}h`} médio</span> : null}
                              {drop > 0 ? <span className="text-rose-400">-{drop}%</span> : null}
                              <span className="font-mono text-slate-200">{s.count}</span>
                            </span>
                          </div>
                          <div className="mt-1 h-2 w-full rounded-full bg-slate-800">
                            <div className="h-2 rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${Math.max(4, (s.count / top) * 100)}%` }} />
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </Panel>
            )}

            {/* PILOTO HOTELEIRO — as 5 métricas que vendem o caso. Mostra só se há
                sinal de hotelaria (alguma reserva criada ou orçamento enviado). */}
            {m?.hospitality && ((m.hospitality.bookingsCreated || 0) + (m.hospitality.quotesSent || 0) + (m.hospitality.eventsCreated || 0)) > 0 && (
              <Panel index={9} title="Piloto Hoteleiro" subtitle="As 5 métricas que vendem o caso de 60 dias" icon={<Activity className="h-4 w-4" />}>
                <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                  <HospKPI label="1ª resposta" value={m.hospitality.firstResponseSeconds < 60 ? `${m.hospitality.firstResponseSeconds}s` : `${Math.round(m.hospitality.firstResponseSeconds/60)}min`} sub="tempo médio" cls="text-indigo-300" />
                  <HospKPI label="Qualificados" value={`${m.hospitality.qualifiedRate}%`} sub="dos leads" cls="text-amber-300" />
                  <HospKPI label="Orçamentos" value={`${m.hospitality.quotesAccepted}/${m.hospitality.quotesSent}`} sub={`${m.hospitality.quotesAcceptRate}% aceite`} cls="text-emerald-300" />
                  <HospKPI label="Recuperadas" value={`${m.hospitality.abandonedRecovered}/${m.hospitality.abandonedNudged}`} sub={`${m.hospitality.abandonedRecoveryRate}% voltou`} cls="text-violet-300" />
                  <HospKPI label="Conversões" value={`${m.hospitality.bookingsCreated + m.hospitality.eventsWon}`} sub={`${m.hospitality.bookingsCreated} reservas · ${m.hospitality.eventsWon} eventos`} cls="text-rose-300" />
                </div>
              </Panel>
            )}

            {/* ORIGEM + IA + SLA */}
            <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
              <Panel index={6} title="Origem dos Contatos" subtitle={`${totalContacts} atendimentos`} icon={<Users className="h-4 w-4" />}>
                <div className="relative h-[180px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={donut.length ? donut : [{ name: 'Sem dados', value: 1, color: '#334155' }]}
                        cx="50%" cy="50%" innerRadius={52} outerRadius={72} paddingAngle={4} dataKey="value" stroke="none">
                        {(donut.length ? donut : [{ color: '#334155' }]).map((s: any, i) => <Cell key={i} fill={s.color} />)}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-bold text-white">{totalContacts}</span>
                    <span className="text-[10px] uppercase tracking-wider text-slate-500">total</span>
                  </div>
                </div>
                <div className="mt-2 space-y-1.5">
                  {donut.length === 0 && <p className="text-center text-xs text-slate-500">Sem dados de canal ainda.</p>}
                  {donut.map(s => (
                    <div key={s.name} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2 text-slate-400">
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} /> {s.name}
                      </span>
                      <span className="font-mono text-slate-300">{s.value}</span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel index={7} title="Eficiência da IA" subtitle="Resolução autônoma" icon={<Zap className="h-4 w-4" />}>
                <div className="relative h-[180px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadialBarChart innerRadius="72%" outerRadius="100%" data={[{ name: 'IA', value: automation, fill: C.violet }]} startAngle={90} endAngle={-270}>
                      <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                      <RadialBar background={{ fill: '#1e293b' }} dataKey="value" cornerRadius={20} />
                    </RadialBarChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-3xl font-bold text-white">{automation}%</span>
                    <span className="text-[10px] uppercase tracking-wider text-slate-500">resolvido por IA</span>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/40 py-2">
                    <p className="text-lg font-bold text-violet-400">{m?.aiResponseCount ?? 0}</p>
                    <p className="text-[10px] text-slate-500">Respostas IA</p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/40 py-2">
                    <p className="text-lg font-bold text-slate-200">{m?.handoffCount ?? 0}</p>
                    <p className="text-[10px] text-slate-500">Para humano</p>
                  </div>
                </div>
              </Panel>

              <Panel index={8} title="Tempo de Resposta" subtitle="Primeira resposta (média)" icon={<UserCheck className="h-4 w-4" />}>
                <div className="flex h-[180px] flex-col items-center justify-center">
                  <span className="bg-gradient-to-r from-emerald-300 to-emerald-500 bg-clip-text text-5xl font-bold text-transparent">
                    {fmtDuration(frt)}
                  </span>
                  <span className="mt-2 text-xs text-slate-500">tempo médio até a 1ª resposta</span>
                  {frt === 0 ? (
                    <span className="mt-3 inline-flex items-center gap-1 rounded-md bg-slate-500/10 px-2 py-0.5 text-xs font-semibold text-slate-400">
                      sem dados no período
                    </span>
                  ) : frt <= 60 ? (
                    <span className="mt-3 inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                      <TrendingDown className="h-3 w-3" /> dentro do SLA
                    </span>
                  ) : (
                    <span className="mt-3 inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-400">
                      <TrendingUp className="h-3 w-3" /> acima de 1 min
                    </span>
                  )}
                </div>
              </Panel>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FunnelRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="font-medium text-slate-300">{label}</span>
        <span className="font-mono text-xs text-slate-400">{value}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-800/70">
        <motion.div
          initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.7, ease: 'easeOut' }}
          className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${color}, ${color}aa)` }}
        />
      </div>
    </div>
  );
}

function KpiCard({ index, title, value, delta, caption, icon, accent, series }: {
  index: number; title: string; value: string; delta: number; caption: string;
  icon: ReactNode; accent: string; series: { i: number; v: number }[];
}) {
  const positive = delta >= 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: index * 0.06 }}
      className="group relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur transition-colors hover:border-slate-700"
    >
      <div className="absolute inset-x-0 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
      <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-10 blur-2xl transition-opacity group-hover:opacity-20" style={{ backgroundColor: accent }} />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400">{title}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-white">{value}</p>
        </div>
        <div className="rounded-xl border p-2.5" style={{ borderColor: `${accent}33`, backgroundColor: `${accent}1a`, color: accent }}>
          {icon}
        </div>
      </div>
      <div className="relative mt-3 flex items-center justify-between">
        <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold ${
          positive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
        }`}>
          {positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
          {positive ? '+' : ''}{delta}%
        </span>
        <span className="text-[11px] text-slate-500">{caption}</span>
      </div>
      <div className="relative mt-3 h-9 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`spark-${index}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.4} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="v" stroke={accent} strokeWidth={2} fill={`url(#spark-${index})`} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
}

function Panel({ index, title, subtitle, icon, className = '', children }: {
  index: number; title: string; subtitle?: string; icon: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: index * 0.05 }}
      className={`rounded-2xl border border-slate-800 bg-slate-900/50 p-4 md:p-6 backdrop-blur ${className}`}
    >
      <div className="mb-5 flex items-center gap-3">
        <div className="rounded-lg border border-slate-700/60 bg-slate-800/60 p-2 text-slate-300">{icon}</div>
        <div>
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {children}
    </motion.div>
  );
}

function HospKPI({ label, value, sub, cls }: { label: string; value: any; sub?: string; cls: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`text-xl font-bold ${cls}`}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}
