import type { ReactNode } from 'react';
import { useState } from 'react';
import { useStore } from '@/src/store/useStore';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell,
  RadialBarChart, RadialBar, PolarAngleAxis,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Users, Clock, Briefcase, Bot, Download,
  ArrowUpRight, Target, Activity, Sparkles, Zap, MessageSquare,
} from 'lucide-react';
import { motion } from 'motion/react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// Paleta premium do relatório
const C = {
  indigo: '#6366f1',
  violet: '#8b5cf6',
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
  sky: '#38bdf8',
};

const STAGE_COLORS: Record<string, string> = {
  novo_lead: C.sky,
  em_atendimento: C.indigo,
  proposta: C.amber,
  fechado: C.emerald,
};

const RANGES = ['Últimos 7 dias', 'Este Mês', 'Trimestre'] as const;

// --- Tooltip customizado e reutilizável ---
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

export function DashboardPanel() {
  const { tickets, contacts, messages, stages } = useStore();
  const [range, setRange] = useState<(typeof RANGES)[number]>('Últimos 7 dias');

  // --- Métricas reais derivadas da store ---
  const ticketsArr = Object.values(tickets);
  const totalTickets = ticketsArr.length;
  const inProgress = ticketsArr.filter(t => t.stage === 'em_atendimento').length;
  const closed = ticketsArr.filter(t => t.stage === 'fechado').length;
  const urgent = ticketsArr.filter(t => t.priority === 'alta').length;
  const totalContacts = Object.keys(contacts).length;
  const conversion = totalTickets ? Math.round((closed / totalTickets) * 100) : 0;

  const allMessages = Object.values(messages).flat();
  const botMessages = allMessages.filter(m => m.sender === 'bot').length;
  const automation = allMessages.length ? Math.round((botMessages / allMessages.length) * 100) : 0;

  // Funil de pipeline (contagem por estágio)
  const funnel = stages.map(s => ({
    id: s.id,
    title: s.title,
    count: ticketsArr.filter(t => t.stage === s.id).length,
    color: STAGE_COLORS[s.id] ?? C.indigo,
  }));
  const funnelMax = Math.max(1, ...funnel.map(f => f.count));

  // Atividade recente (tickets ordenados por última mensagem)
  const recent = [...ticketsArr]
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime())
    .slice(0, 5);

  // --- Séries para gráficos (demonstração de tendência) ---
  const volumeData = [
    { name: 'Seg', atend: 12, resolvidos: 8 },
    { name: 'Ter', atend: 19, resolvidos: 14 },
    { name: 'Qua', atend: 15, resolvidos: 12 },
    { name: 'Qui', atend: 22, resolvidos: 18 },
    { name: 'Sex', atend: 28, resolvidos: 23 },
    { name: 'Sáb', atend: 10, resolvidos: 9 },
    { name: 'Dom', atend: 5, resolvidos: 5 },
  ];
  const responseData = [
    { name: 'Seg', tempo: 4.2 }, { name: 'Ter', tempo: 3.8 }, { name: 'Qua', tempo: 3.5 },
    { name: 'Qui', tempo: 4.0 }, { name: 'Sex', tempo: 4.5 }, { name: 'Sáb', tempo: 2.1 }, { name: 'Dom', tempo: 1.5 },
  ];
  const sourceData = [
    { name: 'WhatsApp', value: 65, color: C.emerald },
    { name: 'Instagram', value: 27, color: C.rose },
    { name: 'WhatsApp Web', value: 8, color: C.indigo },
  ];
  const spark = (a: number[]) => a.map((v, i) => ({ i, v }));

  return (
    <div className="custom-scroll relative flex-1 overflow-y-auto bg-gradient-to-b from-slate-950 via-slate-950 to-[#0b1020]">
      {/* glow decorativo */}
      <div className="pointer-events-none absolute right-0 top-16 h-72 w-72 rounded-full bg-indigo-600/10 blur-[120px]" />
      <div className="relative mx-auto w-full max-w-7xl space-y-8 p-8">

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
            <h2 className="bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
              Performance de Atendimento
            </h2>
            <p className="mt-1 text-sm text-slate-400">Métricas de SLA, conversão e produtividade da IA em tempo real.</p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-xl border border-slate-800 bg-slate-900/60 p-1 backdrop-blur">
              {RANGES.map(r => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                    range === r ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <button className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-2 text-xs font-medium text-slate-200 backdrop-blur transition-colors hover:border-indigo-500/40 hover:text-white">
              <Download className="h-4 w-4" /> Exportar
            </button>
          </div>
        </motion.div>

        {/* KPI CARDS */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            index={0}
            title="Total de Tickets"
            value={totalTickets.toLocaleString('pt-BR')}
            delta={12.5}
            caption={`${urgent} marcados como urgentes`}
            icon={<Briefcase className="h-5 w-5" />}
            accent={C.indigo}
            series={spark([8, 12, 10, 15, 13, 18, totalTickets + 14])}
          />
          <KpiCard
            index={1}
            title="Em Atendimento"
            value={inProgress.toLocaleString('pt-BR')}
            delta={-4.1}
            caption="Carga atual da equipe"
            icon={<Clock className="h-5 w-5" />}
            accent={C.amber}
            series={spark([5, 7, 6, 9, 8, 6, inProgress + 5])}
          />
          <KpiCard
            index={2}
            title="Taxa de Conversão"
            value={`${conversion}%`}
            delta={8.3}
            caption={`${closed} negócios fechados`}
            icon={<Target className="h-5 w-5" />}
            accent={C.emerald}
            series={spark([18, 22, 25, 24, 30, 28, conversion + 10])}
          />
          <KpiCard
            index={3}
            title="Automação IA (RAG)"
            value={`${automation}%`}
            delta={15.7}
            caption={`${botMessages} respostas automáticas`}
            icon={<Bot className="h-5 w-5" />}
            accent={C.violet}
            series={spark([20, 28, 33, 35, 40, 38, automation + 12])}
          />
        </div>

        {/* LINHA PRINCIPAL: Volume + Funil */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Panel index={4} className="lg:col-span-2" title="Volume de Atendimentos" subtitle="Recebidos vs. resolvidos" icon={<MessageSquare className="h-4 w-4" />}>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={volumeData} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gAtend" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.indigo} stopOpacity={0.45} />
                      <stop offset="95%" stopColor={C.indigo} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gResolv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.emerald} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={C.emerald} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="name" stroke="#475569" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="#475569" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#334155', strokeWidth: 1 }} />
                  <Area type="monotone" dataKey="atend" name="Recebidos" stroke={C.indigo} strokeWidth={2.5} fill="url(#gAtend)" />
                  <Area type="monotone" dataKey="resolvidos" name="Resolvidos" stroke={C.emerald} strokeWidth={2.5} fill="url(#gResolv)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex items-center gap-5 pl-1">
              <Legend color={C.indigo} label="Recebidos" />
              <Legend color={C.emerald} label="Resolvidos" />
            </div>
          </Panel>

          <Panel index={5} title="Funil de Vendas" subtitle="Distribuição do pipeline" icon={<Activity className="h-4 w-4" />}>
            <div className="space-y-4 pt-1">
              {funnel.map((f, i) => (
                <div key={f.id}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span className="font-medium text-slate-300">{f.title}</span>
                    <span className="font-mono text-xs text-slate-400">{f.count}</span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-slate-800/70">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${(f.count / funnelMax) * 100}%` }}
                      transition={{ duration: 0.7, delay: 0.3 + i * 0.08, ease: 'easeOut' }}
                      className="h-full rounded-full"
                      style={{ background: `linear-gradient(90deg, ${f.color}, ${f.color}aa)` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <p className="text-xs text-slate-400">Conversão fim a fim</p>
              <div className="mt-1 flex items-end gap-2">
                <span className="text-2xl font-bold text-white">{conversion}%</span>
                <span className="mb-1 inline-flex items-center text-xs font-medium text-emerald-400">
                  <ArrowUpRight className="h-3.5 w-3.5" /> saudável
                </span>
              </div>
            </div>
          </Panel>
        </div>

        {/* SEGUNDA LINHA: Tempo + Origem + Gauge IA */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Panel index={6} title="Tempo de Resposta" subtitle="Média em horas" icon={<TrendingUp className="h-4 w-4" />}>
            <div className="h-[180px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={responseData} margin={{ top: 10, right: 10, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="name" stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip content={<ChartTooltip suffix="h" />} cursor={{ stroke: '#334155' }} />
                  <Line type="monotone" dataKey="tempo" stroke={C.amber} strokeWidth={3}
                    dot={{ fill: C.amber, r: 3, strokeWidth: 0 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          <Panel index={7} title="Origem dos Contatos" subtitle={`${totalContacts} contatos`} icon={<Users className="h-4 w-4" />}>
            <div className="relative h-[180px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={sourceData} cx="50%" cy="50%" innerRadius={52} outerRadius={72} paddingAngle={4} dataKey="value" stroke="none">
                    {sourceData.map((s, i) => <Cell key={i} fill={s.color} />)}
                  </Pie>
                  <Tooltip content={<ChartTooltip suffix="%" />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-bold text-white">{totalContacts}</span>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">contatos</span>
              </div>
            </div>
            <div className="mt-2 space-y-1.5">
              {sourceData.map(s => (
                <div key={s.name} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 text-slate-400">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} /> {s.name}
                  </span>
                  <span className="font-mono text-slate-300">{s.value}%</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel index={8} title="Eficiência da IA" subtitle="Resolução autônoma" icon={<Zap className="h-4 w-4" />}>
            <div className="relative h-[180px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <RadialBarChart innerRadius="72%" outerRadius="100%" data={[{ name: 'IA', value: automation, fill: C.violet }]} startAngle={90} endAngle={-270}>
                  <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                  <RadialBar background={{ fill: '#1e293b' }} dataKey="value" cornerRadius={20} />
                </RadialBarChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-bold text-white">{automation}%</span>
                <span className="text-[10px] uppercase tracking-wider text-slate-500">automatizado</span>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 py-2">
                <p className="text-lg font-bold text-violet-400">{botMessages}</p>
                <p className="text-[10px] text-slate-500">Respostas IA</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 py-2">
                <p className="text-lg font-bold text-slate-200">{allMessages.length - botMessages}</p>
                <p className="text-[10px] text-slate-500">Respostas humanas</p>
              </div>
            </div>
          </Panel>
        </div>

        {/* ATIVIDADE RECENTE */}
        <Panel index={9} title="Atividade Recente" subtitle="Últimos leads movimentados" icon={<Activity className="h-4 w-4" />}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="pb-3 pl-1 font-medium">Contato</th>
                  <th className="pb-3 font-medium">Estágio</th>
                  <th className="pb-3 font-medium">Prioridade</th>
                  <th className="pb-3 pr-1 text-right font-medium">Última atividade</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 ? (
                  <tr><td colSpan={4} className="py-8 text-center text-slate-500">Nenhuma atividade ainda.</td></tr>
                ) : recent.map(t => {
                  const contact = contacts[t.contactId];
                  const stage = funnel.find(f => f.id === t.stage);
                  return (
                    <tr key={t.id} className="border-b border-slate-800/50 transition-colors hover:bg-slate-800/20">
                      <td className="py-3 pl-1">
                        <div className="flex items-center gap-3">
                          {contact?.avatar ? (
                            <img src={contact.avatar} alt="" className="h-8 w-8 rounded-full border border-slate-700" />
                          ) : (
                            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-slate-300">
                              {(contact?.name ?? '?').slice(0, 1).toUpperCase()}
                            </div>
                          )}
                          <div>
                            <p className="font-medium text-slate-200">{contact?.name ?? 'Desconhecido'}</p>
                            <p className="text-xs text-slate-500">{contact?.number ?? t.contactId}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                          style={{ color: stage?.color, backgroundColor: `${stage?.color}1a` }}>
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: stage?.color }} />
                          {stage?.title ?? t.stage}
                        </span>
                      </td>
                      <td className="py-3">
                        <PriorityBadge priority={t.priority} />
                      </td>
                      <td className="py-3 pr-1 text-right text-xs text-slate-400">
                        {formatDistanceToNow(new Date(t.lastMessageAt), { addSuffix: true, locale: ptBR })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>

      </div>
    </div>
  );
}

// --- Subcomponentes ---

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
      className={`rounded-2xl border border-slate-800 bg-slate-900/50 p-6 backdrop-blur ${className}`}
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

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2 text-xs text-slate-400">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} /> {label}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: 'baixa' | 'media' | 'alta' }) {
  const map = {
    alta: { c: C.rose, t: 'Alta' },
    media: { c: C.amber, t: 'Média' },
    baixa: { c: C.emerald, t: 'Baixa' },
  } as const;
  const p = map[priority];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: p.c }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: p.c }} /> {p.t}
    </span>
  );
}
