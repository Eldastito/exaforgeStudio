import React, { useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { toast } from '@/src/lib/toast';
import { BrainCircuit, Send, Sparkles, RefreshCw, ListChecks, MessageSquare, TrendingUp, ShieldCheck, CheckCircle2, XCircle, Target, Activity, AlertTriangle, Clock, Zap, Handshake, Repeat2, UserX, MessageCircle, Globe } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useStore } from '@/src/store/useStore';

type Msg = { role: 'user' | 'ai'; text: string };
type Tab = 'empresa' | 'conversar' | 'decidir' | 'plano' | 'funciona' | 'operacoes' | 'recuperacao';

const DOMAIN_LABEL: Record<string, string> = {
  finance: 'Finanças', production: 'Produção', procurement: 'Compras', inventory: 'Estoque',
  sales: 'Vendas', retail_ops: 'Varejo', tasks: 'Tarefas', people: 'Pessoas', agenda: 'Agenda',
};
const domLabel = (d: string) => DOMAIN_LABEL[d] || d;

const SUGESTOES = [
  'Por que minhas vendas mudaram este mês?',
  'Onde estou perdendo dinheiro?',
  'Quais clientes têm risco de cancelar?',
  'O que devo priorizar hoje?',
  'Qual produto devo promover?',
];

export function ExecutiveView() {
  const [tab, setTab] = useState<Tab>('empresa');
  // ADR-152 F3.2 — aba Operações só pra quem tem permissão do módulo `runtime`
  // (RBAC granular ADR-095) OU o operador da plataforma. Cosmético; segurança
  // real é o runtimeGate + enforceModulePermission no backend (retorna 403).
  const canAccessModule = useStore(s => s.canAccessModule);
  const isMasterAdmin = useStore(s => s.isMasterAdmin);
  const showOperacoes = isMasterAdmin || canAccessModule('runtime');

  return (
    <div className="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
      <div className="p-6 border-b border-zinc-800">
        <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <BrainCircuit className="h-6 w-6 text-indigo-400" /> Diretor Executivo IA
        </h2>
        <p className="text-sm text-zinc-400 mt-1">Pergunte qualquer coisa sobre o seu negócio, ou acompanhe o plano de ação — tudo com dados reais do sistema, nada inventado.</p>
        <div className="flex gap-2 mt-4">
          <TabButton active={tab === 'empresa'} onClick={() => setTab('empresa')} icon={<Activity className="h-4 w-4" />} label="Minha empresa" />
          <TabButton active={tab === 'conversar'} onClick={() => setTab('conversar')} icon={<MessageSquare className="h-4 w-4" />} label="Conversar" />
          <TabButton active={tab === 'decidir'} onClick={() => setTab('decidir')} icon={<Target className="h-4 w-4" />} label="Analisar decisão" />
          <TabButton active={tab === 'plano'} onClick={() => setTab('plano')} icon={<ListChecks className="h-4 w-4" />} label="Plano de Ação" />
          <TabButton active={tab === 'funciona'} onClick={() => setTab('funciona')} icon={<TrendingUp className="h-4 w-4" />} label="O que funciona" />
          {showOperacoes && <TabButton active={tab === 'operacoes'} onClick={() => setTab('operacoes')} icon={<Activity className="h-4 w-4" />} label="Operações" />}
          {showOperacoes && <TabButton active={tab === 'recuperacao'} onClick={() => setTab('recuperacao')} icon={<Handshake className="h-4 w-4" />} label="Recuperação" />}
        </div>
      </div>
      {tab === 'empresa' ? <MinhaEmpresaTab /> : tab === 'conversar' ? <ConversarTab /> : tab === 'decidir' ? <DecidirTab /> : tab === 'plano' ? <PlanoDeAcaoTab /> : tab === 'operacoes' ? <OperacoesTab /> : tab === 'recuperacao' ? <RecuperacaoTab /> : <FuncionaTab />}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${active ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
      {icon} {label}
    </button>
  );
}

// ===== Aba: Minha empresa (CEO Operating Layer, ADR-190) =====
// "Como está minha empresa?" — 3 pilares + saúde + indicadores + pior pilar +
// restrição (hipótese) + visão. Consome os endpoints /snapshot e /constraint (já
// testados no backend). A IA não entra aqui — é leitura determinística do snapshot.
const PILLAR_PT_UI: Record<string, string> = { commercial: 'Comercial', operations: 'Operações', finance: 'Financeiro' };
const HEALTH_UI: Record<string, { label: string; cls: string; dot: string }> = {
  critical: { label: 'Crítico', cls: 'text-red-300 border-red-700 bg-red-950/40', dot: 'bg-red-500' },
  attention: { label: 'Atenção', cls: 'text-amber-300 border-amber-700 bg-amber-950/40', dot: 'bg-amber-500' },
  ok: { label: 'OK', cls: 'text-emerald-300 border-emerald-700 bg-emerald-950/40', dot: 'bg-emerald-500' },
  unknown: { label: 'Sem dados', cls: 'text-zinc-400 border-zinc-700 bg-zinc-900', dot: 'bg-zinc-600' },
};
const fmtIndicator = (v: number | null, unit: string) => {
  if (v === null || v === undefined) return '—';
  if (unit === 'BRL') return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === 'percent') return `${v}%`;
  return String(v);
};

function FinRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-400">{label}</span>
      <span className={`tabular-nums ${muted ? 'text-zinc-500' : 'text-zinc-100'}`}>{value}</span>
    </div>
  );
}

function MinhaEmpresaTab() {
  const [snap, setSnap] = useState<any | null>(null);
  const [con, setCon] = useState<any | null>(null);
  const [fin, setFin] = useState<any | null>(null);
  const [kp, setKp] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/executive/snapshot').then(r => r.json()).catch(() => null),
      apiFetch('/api/executive/constraint').then(r => r.json()).catch(() => null),
      apiFetch('/api/executive/finance').then(r => r.json()).catch(() => null),
      apiFetch('/api/executive/key-person').then(r => r.json()).catch(() => null),
    ]).then(([s, c, f, k]) => { setSnap(s); setCon(c); setFin(f); setKp(k); }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500"><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Lendo sua empresa…</div>;
  if (!snap?.pillars) return <div className="flex-1 flex items-center justify-center text-zinc-500">Não consegui ler o panorama agora.</div>;

  const pillars = ['commercial', 'operations', 'finance'].map(k => snap.pillars[k]).filter(Boolean);
  const worst = con?.worstPillar;
  const constraint = con?.constraint;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      {/* Visão declarada */}
      {snap.vision?.defined && snap.vision?.statement && (
        <div className="rounded-xl border border-indigo-800 bg-indigo-950/30 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-indigo-300 flex items-center gap-1"><Target className="h-3.5 w-3.5" /> Visão</div>
          <div className="text-sm text-zinc-100 mt-1">{snap.vision.statement}</div>
        </div>
      )}

      {/* Onde focar: pior pilar + restrição nº1 (hipótese) */}
      {(worst || constraint) ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-zinc-400 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> Onde focar</div>
          {worst && <div className="text-sm text-zinc-200 mt-1">Pilar em pior forma: <span className="font-semibold">{PILLAR_PT_UI[worst.pillar] || worst.pillar}</span> <span className="text-zinc-500">({worst.criticalCount} crítico(s), {worst.riskCount} risco(s))</span></div>}
          {constraint && (
            <div className="text-sm text-zinc-300 mt-1.5">
              <span className="inline-block text-[11px] px-1.5 py-0.5 rounded bg-amber-950/50 border border-amber-800 text-amber-300 mr-1.5">hipótese</span>
              Prioridade nº1: <span className="text-zinc-100">{constraint.fact}</span> → {constraint.recommendedAction}
              {constraint.threatensGoal && <span className="text-zinc-500"> (ameaça a meta “{constraint.threatensGoal.label}”, gap {constraint.threatensGoal.gapPct}%)</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/20 px-4 py-3 text-sm text-emerald-200 flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Tudo sob controle nos 3 pilares — nenhuma exceção estratégica agora.</div>
      )}

      {/* Os 3 pilares */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {pillars.map((p: any) => {
          const h = HEALTH_UI[p.health] || HEALTH_UI.unknown;
          const inds = (p.indicators || []).filter((i: any) => i.availability === 'available' && i.value !== null).slice(0, 4);
          return (
            <div key={p.pillar} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">{PILLAR_PT_UI[p.pillar] || p.pillar}</div>
                <span className={`text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${h.cls}`}><span className={`h-1.5 w-1.5 rounded-full ${h.dot}`} /> {h.label}</span>
              </div>
              <div className="mt-3 space-y-1.5">
                {inds.length ? inds.map((i: any) => (
                  <div key={i.metricKey} className="flex items-center justify-between text-sm">
                    <span className="text-zinc-400">{i.label}</span>
                    <span className="text-zinc-100 tabular-nums">{fmtIndicator(i.value, i.unit)}</span>
                  </div>
                )) : <div className="text-xs text-zinc-500">Sem indicadores com fonte ainda.</div>}
              </div>
              {(p.exceptions?.length > 0) && <div className="mt-3 text-xs text-amber-400/90">{p.exceptions.length} exceção(ões) aberta(s)</div>}
              {(p.goals?.length > 0) && <div className="mt-1 text-xs text-zinc-500">{p.goals.length} meta(s) neste pilar</div>}
            </div>
          );
        })}
      </div>

      {/* Financeiro executivo (F7) + Dependência de pessoas (§38) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {fin?.available && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5"><TrendingUp className="h-4 w-4 text-emerald-400" /> Financeiro</div>
            <div className="mt-3 space-y-1.5 text-sm">
              <FinRow label="Caixa" value={fmtIndicator(fin.liquidity?.cash ?? null, 'BRL')} />
              {fin.liquidity?.survivalDays != null && <FinRow label="Sobrevivência de caixa" value={`${fin.liquidity.survivalDays} dias`} />}
              <FinRow label="A receber" value={fmtIndicator(fin.receivables?.total ?? null, 'BRL')} />
              <FinRow label="Vencido" value={fmtIndicator(fin.receivables?.overdue ?? null, 'BRL')} muted={!fin.receivables?.overdue} />
              <FinRow label="Inadimplência" value={fin.receivables?.defaultRateAvailability === 'available' ? `${fin.receivables?.defaultRatePct}%` : '—'} />
              {fin.profitability?.available && <FinRow label="Margem" value={fin.profitability?.marginPct != null ? `${fin.profitability.marginPct}%` : '—'} />}
              {fin.profitability?.available && <FinRow label="Resultado (core)" value={fmtIndicator(fin.profitability?.operatingResultCore ?? null, 'BRL')} />}
            </div>
            {Array.isArray(fin.caveats) && fin.caveats.length > 0 && (
              <div className="mt-3 text-[11px] text-zinc-500 leading-snug">{fin.caveats[0]}</div>
            )}
          </div>
        )}
        {kp?.dimensions?.some((d: any) => d.risk === 'high' || d.risk === 'medium') && (
          <div className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4">
            <div className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5"><UserX className="h-4 w-4 text-amber-400" /> Dependência de pessoas</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">Risco de concentração — hipótese, não certeza.</div>
            <div className="mt-3 space-y-2">
              {kp.dimensions.filter((d: any) => d.risk === 'high' || d.risk === 'medium').map((d: any) => (
                <div key={d.dimension} className="flex items-center justify-between text-sm">
                  <span className="text-zinc-300">{d.label}</span>
                  <span className={`tabular-nums font-medium ${d.risk === 'high' ? 'text-red-300' : 'text-amber-300'}`}>{d.topShare}% num só ({d.participants} pessoas)</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load} className="border-zinc-700 text-zinc-300"><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Atualizar</Button>
      </div>
    </div>
  );
}

// ===== Aba: Conversar (briefing + chat) =====
function ConversarTab() {
  const [briefing, setBriefing] = useState<string>('');
  const [loadingBriefing, setLoadingBriefing] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadBriefing = () => {
    setLoadingBriefing(true);
    apiFetch('/api/executive/briefing').then(r => r.json()).then(d => setBriefing(d.text || '')).catch(() => {}).finally(() => setLoadingBriefing(false));
  };
  useEffect(() => { loadBriefing(); }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, thinking]);

  const ask = async (q: string) => {
    const question = (q ?? input).trim();
    if (!question || thinking) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text: question }]);
    setThinking(true);
    try {
      const res = await apiFetch('/api/executive/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      const d = await res.json();
      setMessages(m => [...m, { role: 'ai', text: d.text || 'Sem resposta.' }]);
    } catch {
      setMessages(m => [...m, { role: 'ai', text: 'Não consegui responder agora. Tente de novo.' }]);
    } finally { setThinking(false); }
  };

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-indigo-300 flex items-center gap-2"><Sparkles className="h-4 w-4" /> Briefing de hoje</p>
            <button onClick={loadBriefing} className="text-zinc-500 hover:text-zinc-300" title="Atualizar"><RefreshCw className={`h-4 w-4 ${loadingBriefing ? 'animate-spin' : ''}`} /></button>
          </div>
          {loadingBriefing ? (
            <p className="text-sm text-zinc-500">Analisando seu negócio…</p>
          ) : (
            <p className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">{briefing || 'Sem dados suficientes ainda. Conforme o sistema for usado, o briefing fica mais rico.'}</p>
          )}
        </div>

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-zinc-800 text-zinc-100 rounded-tl-sm border border-zinc-700'}`}>
              {m.text}
            </div>
          </div>
        ))}
        {thinking && <div className="flex justify-start"><div className="bg-zinc-800 border border-zinc-700 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm text-zinc-400 flex items-center gap-2"><RefreshCw className="h-3 w-3 animate-spin" /> Analisando os dados…</div></div>}

        {messages.length === 0 && !thinking && (
          <div className="flex flex-wrap gap-2 pt-2">
            {SUGESTOES.map(s => (
              <button key={s} onClick={() => ask(s)} className="text-xs px-3 py-1.5 rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">{s}</button>
            ))}
          </div>
        )}
      </div>

      <div className="p-4 border-t border-zinc-800">
        <div className="flex gap-2">
          <textarea
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-100 resize-none h-12 focus:border-indigo-500 outline-none"
            placeholder="Pergunte ao seu Diretor IA…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          />
          <Button onClick={() => ask(input)} disabled={thinking || !input.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white h-12 px-4">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

// ===== Aba: Plano de Ação (prioridades C3 + aprovações C2a + esperado×realizado C2b) =====
const brl = (n: number) => `R$ ${(Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtImpact = (impact: any) => impact == null ? '—' : impact.unit === 'BRL' ? brl(impact.amount) : `${impact.amount} ${impact.unit || ''}`.trim();
const policyLabel = (a: any) => {
  if (!a) return null;
  const p = a.policy;
  return p === 'none' ? 'Sem aprovação' : p === 'single' ? '1 aprovação' : p === 'two_step' ? '2 aprovações' : p === 'role' ? `Perfil ${a.requiredRole || 'gestor'}` : String(p);
};

// ===== Aba: O que funciona (eficácia aprendida por tipo de ação) =====
function FuncionaTab() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch('/api/executive/effectiveness').then(r => r.json()).then(d => setItems(Array.isArray(d.items) ? d.items : [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const effCls = (e: number) => e >= 0.66 ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : e >= 0.34 ? 'text-amber-300 bg-amber-500/10 border-amber-500/30' : 'text-rose-300 bg-rose-500/10 border-rose-500/30';

  if (loading) return <div className="flex-1 flex items-center gap-2 p-6 text-sm text-zinc-500"><RefreshCw className="h-4 w-4 animate-spin" /> Carregando…</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-2 text-sm text-zinc-300">
          <TrendingUp className="h-4 w-4 text-indigo-400" />
          O que <strong>costuma funcionar</strong> no seu negócio — aprendido dos desfechos que você registrou.
        </div>
        {items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">
            Ainda não há histórico de eficácia. Conforme você <strong>age sobre os padrões</strong> (na tela de Insights) e marca o desfecho
            (<em>Funcionou / Sem efeito / Piorou</em>), a plataforma aprende quais ações resolvem — e mostra aqui, ranqueado.
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={`${it.domain}-${it.patternType}-${i}`} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[11px] text-zinc-400">{domLabel(it.domain)}</span>
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${effCls(it.effectiveness)}`}>eficácia {Math.round(it.effectiveness * 100)}%</span>
                  <span className="text-[11px] text-zinc-500">em {it.acted} ação{it.acted > 1 ? 'ões' : ''}</span>
                </div>
                <p className="mt-1 text-sm text-zinc-200">{it.recommendedAction}</p>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-zinc-500">
                  <span className="text-emerald-400">✓ funcionou {it.worked}</span>
                  <span>• sem efeito {it.noEffect}</span>
                  <span className="text-rose-400">✗ piorou {it.backfired}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PlanoDeAcaoTab() {
  const [priorities, setPriorities] = useState<any[]>([]);
  const [awaiting, setAwaiting] = useState<any[]>([]);
  const [approved, setApproved] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const load = () => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/business/priorities').then(r => r.json()).catch(() => ({ global: [] })),
      apiFetch('/api/actions?status=awaiting_approval').then(r => r.json()).catch(() => ({ actions: [] })),
      apiFetch('/api/actions?status=approved').then(r => r.json()).catch(() => ({ actions: [] })),
      apiFetch('/api/actions/ledger').then(r => r.json()).catch(() => null),
    ]).then(([p, aw, ap, l]) => {
      setPriorities(p?.global || []);
      setAwaiting(aw?.actions || []);
      setApproved(ap?.actions || []);
      setLedger(l);
    }).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const post = async (id: string, path: string, body: any, okMsg: string) => {
    setBusy(id);
    try {
      const r = await apiFetch(`/api/actions/${id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); toast.error(e.error || 'Não foi possível concluir a operação.'); return; }
      toast.success(okMsg);
      load();
    } catch { toast.error('Falha de conexão.'); }
    finally { setBusy(''); }
  };

  const approve = (id: string) => post(id, 'approve', { reason: reasons[id] || undefined }, 'Ação aprovada.');
  const reject = (id: string) => {
    if (!(reasons[id] || '').trim()) { toast.info('Informe o motivo da rejeição.'); return; }
    post(id, 'reject', { reason: reasons[id] }, 'Ação rejeitada.');
  };
  const complete = (id: string) => {
    const v = amounts[id] != null && amounts[id] !== '' ? Number(amounts[id]) : undefined;
    post(id, 'complete', { resultAmount: v }, 'Ação concluída e resultado registrado.');
  };
  const prepare = async (id: string) => {
    setBusy(id);
    try {
      const r = await apiFetch(`/api/actions/${id}/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Não foi possível preparar.'); return; }
      toast.success(d.result?.summary || 'Comando preparado (rascunho). Nada foi enviado.');
      load();
    } catch { toast.error('Falha de conexão.'); }
    finally { setBusy(''); }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500"><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Carregando o plano de ação…</div>;

  const t = ledger?.totals;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">Números determinísticos, do próprio sistema. A IA prioriza; você decide.</p>
        <button onClick={load} className="text-zinc-500 hover:text-zinc-300 flex items-center gap-1 text-xs" title="Atualizar"><RefreshCw className="h-4 w-4" /> Atualizar</button>
      </div>

      {/* Impact Ledger: esperado × realizado (fato ≠ estimativa) */}
      {t && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="text-sm font-semibold text-zinc-200 flex items-center gap-2 mb-3"><TrendingUp className="h-4 w-4 text-emerald-400" /> Impacto medido (esperado × realizado)</p>
          <div className="grid grid-cols-3 gap-3">
            <Metric label="Esperado" value={brl(t.expected)} />
            <Metric label="Realizado" value={brl(t.realized)} accent="emerald" />
            <Metric label="Diferença" value={brl(t.gap)} accent={t.gap >= 0 ? 'emerald' : 'amber'} />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg border border-zinc-800 p-2.5">
              <p className="text-zinc-500 flex items-center gap-1"><ShieldCheck className="h-3 w-3 text-emerald-400" /> Comprovado (fato)</p>
              <p className="text-zinc-300 mt-0.5">{brl(t.fact?.realized || 0)} <span className="text-zinc-600">de {brl(t.fact?.expected || 0)} esperado</span></p>
            </div>
            <div className="rounded-lg border border-zinc-800 p-2.5">
              <p className="text-zinc-500">Estimado</p>
              <p className="text-zinc-300 mt-0.5">{brl(t.estimate?.realized || 0)} <span className="text-zinc-600">de {brl(t.estimate?.expected || 0)} esperado</span></p>
            </div>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2">Comprovado e estimado nunca são somados num único número.</p>
        </div>
      )}

      {/* Prioridades (Pareto — C3) */}
      <section>
        <p className="text-sm font-semibold text-zinc-200 flex items-center gap-2 mb-3"><Target className="h-4 w-4 text-indigo-400" /> Prioridades de hoje</p>
        {priorities.length === 0 ? (
          <EmptyHint text="Nenhuma prioridade no momento. Quando o sistema detectar sinais (caixa, recebíveis, estoque…), eles aparecem aqui ordenados por impacto." />
        ) : (
          <div className="space-y-2">
            {priorities.map((p) => (
              <div key={p.signalId} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-indigo-300 bg-indigo-500/10 rounded px-1.5 py-0.5">#{p.rank}</span>
                      <span className="text-sm font-medium text-zinc-100">{p.recommendedAction}</span>
                      <span className="text-[11px] text-zinc-500 uppercase tracking-wide">{p.domain}</span>
                      {p.override && <span className="text-[11px] text-rose-300 bg-rose-500/10 rounded px-1.5 py-0.5">crítico</span>}
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">{p.interpretation}</p>
                    <p className="text-[11px] text-zinc-600 mt-1">{p.reason}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-zinc-100">{fmtImpact(p.impact)}</p>
                    <p className="text-[11px] text-zinc-500">{p.basis === 'fact' ? 'fato' : 'estimativa'} · {Math.round((p.confidence || 0) * 100)}%</p>
                    {p.approvalNeeded && <p className="text-[11px] text-amber-400/80 mt-0.5">{policyLabel(p.approvalNeeded)}</p>}
                  </div>
                </div>
                <p className="text-[11px] text-zinc-600 mt-2 flex items-center gap-1"><span className="text-zinc-500">Como medir:</span> {p.howMeasured}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Aguardando aprovação (C2a) */}
      <section>
        <p className="text-sm font-semibold text-zinc-200 flex items-center gap-2 mb-3"><ShieldCheck className="h-4 w-4 text-amber-400" /> Aguardando sua aprovação {awaiting.length > 0 && <span className="text-xs text-zinc-500">({awaiting.length})</span>}</p>
        {awaiting.length === 0 ? (
          <EmptyHint text="Nada aguardando aprovação." />
        ) : (
          <div className="space-y-2">
            {awaiting.map((a) => (
              <div key={a.id} className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100">{a.title}</p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">{a.domain} · {a.action_type} · {policyLabel({ policy: a.approval_policy, requiredRole: a.approval_role })}</p>
                    {a.expected_impact != null && <p className="text-[11px] text-zinc-500 mt-0.5">Impacto esperado: {brl(a.expected_impact)}</p>}
                  </div>
                </div>
                <input
                  value={reasons[a.id] || ''}
                  onChange={e => setReasons(s => ({ ...s, [a.id]: e.target.value }))}
                  placeholder="Motivo (obrigatório para rejeitar)"
                  className="mt-2 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 outline-none"
                />
                <div className="flex gap-2 mt-2">
                  <Button onClick={() => approve(a.id)} disabled={busy === a.id} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs"><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Aprovar</Button>
                  <Button onClick={() => reject(a.id)} disabled={busy === a.id} className="bg-zinc-800 hover:bg-rose-900/60 text-zinc-200 h-8 px-3 text-xs border border-zinc-700"><XCircle className="h-3.5 w-3.5 mr-1" /> Rejeitar</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Aprovadas — prontas para concluir (C2b) */}
      {approved.length > 0 && (
        <section>
          <p className="text-sm font-semibold text-zinc-200 flex items-center gap-2 mb-3"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> Aprovadas — registre o resultado</p>
          <div className="space-y-2">
            {approved.map((a) => (
              <div key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <p className="text-sm font-medium text-zinc-100">{a.title}</p>
                <p className="text-[11px] text-zinc-500 mt-0.5">{a.domain} · esperado {a.expected_impact != null ? brl(a.expected_impact) : '—'}{a.executed_at ? ' · preparada' : ''}</p>
                <div className="flex gap-2 mt-2 items-center flex-wrap">
                  {a.command_type && (
                    <Button onClick={() => prepare(a.id)} disabled={busy === a.id} className="bg-zinc-800 hover:bg-zinc-700 text-zinc-200 h-8 px-3 text-xs border border-zinc-700"><Sparkles className="h-3.5 w-3.5 mr-1" /> Preparar</Button>
                  )}
                  <input
                    type="number"
                    value={amounts[a.id] || ''}
                    onChange={e => setAmounts(s => ({ ...s, [a.id]: e.target.value }))}
                    placeholder="Resultado (R$)"
                    className="w-40 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 outline-none"
                  />
                  <Button onClick={() => complete(a.id)} disabled={busy === a.id} className="bg-indigo-600 hover:bg-indigo-700 text-white h-8 px-3 text-xs">Concluir</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: 'emerald' | 'amber' }) {
  const color = accent === 'emerald' ? 'text-emerald-400' : accent === 'amber' ? 'text-amber-400' : 'text-zinc-100';
  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className={`text-lg font-semibold mt-0.5 ${color}`}>{value}</p>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-xs text-zinc-500 rounded-lg border border-dashed border-zinc-800 p-4">{text}</p>;
}

// ===== Aba: Operações (ADR-152 F3.2 — Exception Center + Impact do dia) =====
// Consome /api/runtime/operations/{overview,exceptions,indicators,ledger}.
// Gateado por `runtimeGate` no backend (flag `execution_runtime_enabled` da
// org) — se desligado, mostra o card de habilitação em vez do painel.

const EXCEPTION_LABEL: Record<string, string> = {
  credential_missing: 'Credencial ausente',
  sla_at_risk: 'SLA vencido',
  integration_failed: 'Integração falhou',
  conflict: 'Conflito / dado inválido',
  decision_needed: 'Decisão humana',
  approval_needed: 'Aprovação pendente',
  data_missing: 'Dado faltante',
  risk_high: 'Risco elevado',
  irreversible_action: 'Ação irreversível',
  sensitive_customer: 'Cliente sensível',
};
const exceptionColor = (cat: string): string => {
  switch (cat) {
    case 'credential_missing': return 'text-rose-300 bg-rose-500/10 border-rose-500/30';
    case 'sla_at_risk': return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
    case 'integration_failed': return 'text-orange-300 bg-orange-500/10 border-orange-500/30';
    case 'conflict': return 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30';
    default: return 'text-indigo-300 bg-indigo-500/10 border-indigo-500/30';
  }
};

const minutesLabel = (m: number): string => {
  const n = Math.trunc(m);
  if (n <= 0) return '—';
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const rem = n % 60;
  return rem ? `${h}h ${rem}min` : `${h}h`;
};

function OperacoesTab() {
  const [overview, setOverview] = useState<any | null>(null);
  const [exceptions, setExceptions] = useState<any[]>([]);
  const [indicators, setIndicators] = useState<Record<string, number> | null>(null);
  const [churn, setChurn] = useState<any[]>([]); // ADR-155 F4.2 — sinais churn_risk_high
  const [kpis, setKpis] = useState<any[]>([]); // ADR-155 — KPIs A/B (F2.3/F3.2) + indicação (F6)
  const [loading, setLoading] = useState(true);
  const [gateError, setGateError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setGateError(null);
    Promise.all([
      apiFetch('/api/runtime/operations/overview'),
      apiFetch('/api/runtime/operations/exceptions?limit=50'),
      apiFetch('/api/runtime/operations/indicators'),
      apiFetch('/api/runtime/operations/churn'),
      apiFetch('/api/runtime/operations/kpis'),
    ]).then(async ([oR, eR, iR, cR, kR]) => {
      // Runtime não habilitado (flag off) → 403 uniforme
      if (oR.status === 403) {
        const j = await oR.json().catch(() => ({}));
        setGateError(j?.error || 'Execution Runtime não está habilitado para esta organização.');
        return;
      }
      const [o, e, i, c, k] = await Promise.all([
        oR.json().catch(() => null),
        eR.json().catch(() => ({ exceptions: [] })),
        iR.json().catch(() => ({})),
        cR.json().catch(() => ({ signals: [] })),
        kR.json().catch(() => ({ signals: [] })),
      ]);
      setOverview(o || null);
      setExceptions(Array.isArray(e?.exceptions) ? e.exceptions : []);
      setIndicators(i && typeof i === 'object' ? i : {});
      setChurn(Array.isArray(c?.signals) ? c.signals : []);
      setKpis(Array.isArray(k?.signals) ? k.signals : []);
    }).catch(() => setGateError('Falha ao carregar o painel de Operações.'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // F4.2 — RN-014: o detector sugere; o humano decide (acknowledge = "vou cuidar",
  // dismiss = "não é risco"). Nunca age sozinho (não cancela, não dá desconto).
  const actOnChurn = async (id: string, action: 'acknowledge' | 'dismiss') => {
    try { await apiFetch(`/api/runtime/operations/churn/${id}/${action}`, { method: 'POST' }); } catch { /* best-effort */ }
    load();
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500"><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Carregando Operações…</div>;

  if (gateError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
          <div className="flex items-center gap-2 text-amber-300 font-semibold"><ShieldCheck className="h-5 w-5" /> Execution Runtime desligado</div>
          <p className="text-sm text-zinc-300 mt-2">{gateError}</p>
          <p className="text-xs text-zinc-500 mt-3">Habilitação é feita pelo operador da plataforma (flag <code className="text-zinc-400">execution_runtime_enabled</code>). Depois de ligar, é preciso configurar políticas por processo em <em>agent_policies</em> (autonomia = <code>execute</code> + modo <code>approved_execution</code>) para o Runtime rodar ações automaticamente.</p>
        </div>
      </div>
    );
  }

  const running = overview?.running || { processes: 0, awaitingApproval: 0, awaitingConfirmation: 0 };
  const today = overview?.completedToday || { processes: 0, actions: 0, outcomes: { count: 0, realized: 0, timeSavedMinutes: 0, revenueRecovered: 0, costAvoided: 0, lossPrevented: 0 } };
  const cats = today.outcomes || {};

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <Activity className="h-4 w-4 text-indigo-400" />
          Painel de <strong>Operações</strong> — processos em execução, resultado do dia, exceções e indicadores. Atualiza ao recarregar.
          <button onClick={load} className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"><RefreshCw className="h-3.5 w-3.5" /> Atualizar</button>
        </div>

        {/* Bloco 1 — Em execução */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><Zap className="h-3.5 w-3.5" /> Em execução</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Processos ativos" value={String(running.processes || 0)} />
            <Metric label="Aguardando aprovação" value={String(running.awaitingApproval || 0)} accent={running.awaitingApproval > 0 ? 'amber' : undefined} />
            <Metric label="Aguardando confirmação externa" value={String(running.awaitingConfirmation || 0)} />
            <Metric label="Exceções vivas" value={String(overview?.exceptionsCount || 0)} accent={overview?.exceptionsCount > 0 ? 'amber' : undefined} />
          </div>
        </div>

        {/* Bloco 2 — Concluído hoje */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Concluído hoje</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Processos concluídos" value={String(today.processes || 0)} accent={today.processes > 0 ? 'emerald' : undefined} />
            <Metric label="Ações concluídas" value={String(today.actions || 0)} accent={today.actions > 0 ? 'emerald' : undefined} />
            <Metric label="Outcomes registrados" value={String(cats.count || 0)} />
            <Metric label="Realizado (soma bruta)" value={brl(cats.realized || 0)} />
          </div>
          {/* Categorias explícitas (ADR-152 F3.1) — NUNCA somamos entre elas
              porque as unidades e interpretações são diferentes. Aqui a UI
              mostra cada uma como card próprio. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            <Metric label="Tempo devolvido ao gestor" value={minutesLabel(Number(cats.timeSavedMinutes || 0))} />
            <Metric label="Receita recuperada" value={brl(cats.revenueRecovered || 0)} accent={Number(cats.revenueRecovered || 0) > 0 ? 'emerald' : undefined} />
            <Metric label="Custo evitado" value={brl(cats.costAvoided || 0)} accent={Number(cats.costAvoided || 0) > 0 ? 'emerald' : undefined} />
            <Metric label="Perda evitada" value={brl(cats.lossPrevented || 0)} accent={Number(cats.lossPrevented || 0) > 0 ? 'emerald' : undefined} />
          </div>
          <p className="text-[11px] text-zinc-500 mt-2">Categorias separadas de propósito — cada uma na sua unidade. Nunca somamos "tempo" com "R$" pra não inflar o número.</p>
        </div>

        {/* Bloco 3 — Exceções categorizadas */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Exceções ({exceptions.length})</h3>
          {exceptions.length === 0 ? (
            <EmptyHint text="Nada exigindo intervenção agora. ✨" />
          ) : (
            <div className="space-y-2">
              {exceptions.map((e) => (
                <div key={`${e.source}:${e.id}`} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${exceptionColor(e.category)}`}>{EXCEPTION_LABEL[e.category] || e.category}</span>
                    <span className="text-[11px] text-zinc-500">{sourceLabel(e.source)}</span>
                    {e.since && <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {relativeTime(e.since)}</span>}
                  </div>
                  <p className="mt-1 text-sm text-zinc-200">{e.subject}</p>
                  <p className="mt-1 text-xs text-zinc-400 italic">{e.recommendedAction}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bloco 3b — Clientes em risco de churn (ADR-155 F4.2). Advisory: o
            detector sugere, o humano decide. Só aparece se há sinal aberto. */}
        {churn.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><UserX className="h-3.5 w-3.5" /> Clientes em risco de churn ({churn.length})</h3>
            <div className="space-y-2">
              {churn.map((s) => {
                const ev = s.evidence || {};
                const score = Number(ev.score || 0);
                const factors: string[] = Array.isArray(ev.factors) ? ev.factors : [];
                const alto = s.severity === 'risk';
                return (
                  <div key={s.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${alto ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}>{score}/100 · {alto ? 'alto' : 'atenção'}</span>
                      <span className="text-sm font-medium text-zinc-200">{ev.contactName || 'Cliente'}</span>
                      {Number(s.impact_amount) > 0 && <span className="text-[11px] text-zinc-500">R$ {brl(Number(s.impact_amount)).replace('R$', '').trim()} em aberto</span>}
                    </div>
                    {factors.length > 0 && (
                      <ul className="mt-1.5 text-xs text-zinc-400 list-disc pl-4 space-y-0.5">
                        {factors.map((f, i) => <li key={i}>{f}</li>)}
                      </ul>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <button onClick={() => actOnChurn(s.id, 'acknowledge')} className="inline-flex items-center gap-1 rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-600/20"><CheckCircle2 className="h-3.5 w-3.5" /> Vou cuidar</button>
                      <button onClick={() => actOnChurn(s.id, 'dismiss')} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/40 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800"><XCircle className="h-3.5 w-3.5" /> Não é risco</button>
                    </div>
                    {ev.nota && <p className="text-[10px] text-zinc-600 mt-1.5 italic">{ev.nota}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Bloco 3c — KPIs de copy calibrada (A/B F2.3/F3.2) + indicação (F6).
            Placar vivo, só leitura: mostra o que a copy calibrada está rendendo
            vs o control. Só aparece se há KPI publicado. */}
        {kpis.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5" /> Copy calibrada & indicação</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {kpis.map((s) => <React.Fragment key={s.id}><KpiCard signal={s} /></React.Fragment>)}
            </div>
            <p className="text-[11px] text-zinc-500 mt-2">Números derivados por consulta (medição, não estimativa). "Calibrada" é a copy afinada pelo grimoire; "Control" é a legada — o A/B só elege vencedor com amostra mínima.</p>
            <div className="mt-4"><KpiTrendChart /></div>
          </div>
        )}

        {/* Bloco 4 — Indicadores por status */}
        {indicators && Object.keys(indicators).length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><Target className="h-3.5 w-3.5" /> Indicadores</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label="Processos totais" value={String(indicators.processesTotal || 0)} />
              <Metric label="Processos falhos" value={String(indicators.processesFailed || 0)} accent={indicators.processesFailed > 0 ? 'amber' : undefined} />
              <Metric label="Processos escalados" value={String(indicators.processesEscalated || 0)} accent={indicators.processesEscalated > 0 ? 'amber' : undefined} />
              <Metric label="Ações aguardando aprovação" value={String(indicators.actionsAwaitingApproval || 0)} />
              <Metric label="Confirmações pendentes" value={String(indicators.confirmationsPending || 0)} />
              <Metric label="Confirmações vencidas" value={String(indicators.confirmationsTimedOut || 0)} accent={indicators.confirmationsTimedOut > 0 ? 'amber' : undefined} />
              <Metric label="Jobs pendentes" value={String(indicators.jobsPending || 0)} />
              <Metric label="Jobs falhados (dead-letter)" value={String(indicators.jobsFailed || 0)} accent={indicators.jobsFailed > 0 ? 'amber' : undefined} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ADR-155 — card de KPI (A/B de copy ou programa de indicação). Só leitura.
function KpiCard({ signal }: { signal: any }) {
  const ev = signal?.evidence || {};
  const type = signal?.signal_type;

  if (type === 'referral_program_result') {
    const conv = Number(ev.conversionRatePct || 0);
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex items-center gap-2 mb-2.5">
          <Repeat2 className="h-4 w-4 text-indigo-400" />
          <span className="text-sm font-semibold text-zinc-200">Programa de indicação</span>
          <span className="ml-auto text-[11px] text-zinc-400">{conv}% de conversão</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <MiniStat label="Códigos" value={String(ev.codesIssued ?? 0)} />
          <MiniStat label="Indicados" value={String(ev.referred ?? 0)} />
          <MiniStat label="Converteram" value={String(ev.qualified ?? 0)} accent={Number(ev.qualified) > 0} />
        </div>
      </div>
    );
  }

  // A/B da copy (cobrança ou recuperação) — mesmo shape de evidence.
  const isCollection = type === 'collection_ab_result';
  const variants: any[] = Array.isArray(ev.variants) ? ev.variants : [];
  const control = variants.find((v) => v.variant === 'control');
  const cal = variants.find((v) => v.variant === 'calibrated');
  const winner = ev.winner as string | null;
  const winnerLabel = winner === 'calibrated' ? 'Calibrada vencendo' : winner === 'control' ? 'Control vencendo' : winner === 'tie' ? 'Empate' : 'Amostra insuficiente';
  const winnerColor = winner === 'calibrated' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : winner === 'control' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
    : 'border-zinc-700 bg-zinc-800/40 text-zinc-400';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-2 mb-2.5">
        {isCollection ? <Zap className="h-4 w-4 text-indigo-400" /> : <Handshake className="h-4 w-4 text-indigo-400" />}
        <span className="text-sm font-semibold text-zinc-200">A/B da copy — {isCollection ? 'Cobrança' : 'Recuperação'}</span>
        <span className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${winnerColor}`}>{winnerLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <VariantCell label="Control" v={control} />
        <VariantCell label="Calibrada" v={cal} highlight={winner === 'calibrated'} />
      </div>
    </div>
  );
}

// ADR-155 — gráfico temporal por dia: A/B control × calibrada (cobrança/
// recuperação) e conversão da indicação (uma linha). Consome
// /api/runtime/operations/kpi-trend. Snapshot diário, sem backfill: precisa de
// ≥2 pontos pra desenhar uma linha.
type TrendKind = 'collection' | 'sales_recovery' | 'referral';
function KpiTrendChart() {
  const [kind, setKind] = useState<TrendKind>('collection');
  const [data, setData] = useState<{ points: any[] } | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    apiFetch(`/api/runtime/operations/kpi-trend?kind=${kind}&days=30`)
      .then((r) => r.json())
      .then((d) => { if (alive) setData({ points: Array.isArray(d?.points) ? d.points : [] }); })
      .catch(() => { if (alive) setData({ points: [] }); });
    return () => { alive = false; };
  }, [kind]);

  const points = data?.points || [];
  const isReferral = kind === 'referral';
  const chartRows = points.map((p) => isReferral
    ? { name: String(p.date).slice(5), conversao: p.conversionRate }
    : { name: String(p.date).slice(5), control: p.controlRate, calibrada: p.calibratedRate });
  const tabBtn = (k: TrendKind, label: string) => (
    <button onClick={() => setKind(k)} className={`px-2.5 py-1 ${kind === k ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}>{label}</button>
  );
  const subtitle = isReferral ? 'Conversão da indicação' : 'Evolução do A/B (taxa de recuperação)';
  const footnote = isReferral
    ? 'Conversão (%) por dia — indicados que viraram compra paga. Snapshot diário, sem backfill.'
    : 'Taxa de recuperação (%) por dia — control (legada) × calibrada (grimoire). Snapshot diário, sem backfill.';

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-indigo-400" /> {subtitle}</span>
        <div className="ml-auto inline-flex rounded-lg border border-zinc-800 overflow-hidden text-[11px]">
          {tabBtn('collection', 'Cobrança')}
          {tabBtn('sales_recovery', 'Recuperação')}
          {tabBtn('referral', 'Indicação')}
        </div>
      </div>
      {data === null ? (
        <div className="h-48 rounded-lg bg-zinc-900/40 border border-zinc-800 animate-pulse" />
      ) : points.length < 2 ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center">
          <p className="text-sm text-zinc-500">Ainda sem histórico suficiente pra desenhar a evolução.</p>
          <p className="text-[11px] text-zinc-600 mt-1">O gráfico acumula a partir do 1º snapshot diário — volte em alguns dias.</p>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartRows} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} unit="%" width={42} />
            <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #27272a', borderRadius: 8, fontSize: 12 }} formatter={(v: any) => `${v}%`} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {isReferral ? (
              <Line type="monotone" dataKey="conversao" name="Conversão" stroke="#818cf8" strokeWidth={2} dot={false} />
            ) : (
              <>
                <Line type="monotone" dataKey="control" name="Control" stroke="#a1a1aa" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="calibrada" name="Calibrada" stroke="#34d399" strokeWidth={2} dot={false} />
              </>
            )}
          </LineChart>
        </ResponsiveContainer>
      )}
      <p className="text-[11px] text-zinc-500 mt-1.5">{footnote}</p>
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 text-center">
      <div className={`text-lg font-semibold ${accent ? 'text-emerald-300' : 'text-zinc-100'}`}>{value}</div>
      <div className="text-[10px] text-zinc-500">{label}</div>
    </div>
  );
}

function VariantCell({ label, v, highlight }: { label: string; v: any; highlight?: boolean }) {
  const rate = v ? Number(v.recoveryRatePct || 0) : null;
  return (
    <div className={`rounded-lg border p-2.5 ${highlight ? 'border-emerald-600/40 bg-emerald-600/5' : 'border-zinc-800 bg-zinc-900/60'}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] text-zinc-400">{label}</span>
        <span className={`text-xl font-semibold ${highlight ? 'text-emerald-300' : 'text-zinc-100'}`}>{rate === null ? '—' : `${rate}%`}</span>
      </div>
      <div className="text-[10px] text-zinc-500">{v ? `${v.recovered}/${v.sent} · ${brl(Number(v.revenueCents || 0) / 100)}` : 'sem dados'}</div>
    </div>
  );
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'process_escalated': return 'Processo escalado';
    case 'process_failed': return 'Processo falhou';
    case 'action_overdue': return 'Ação com deadline vencido';
    case 'job_dead_letter': return 'Job na dead-letter';
    case 'confirmation_timeout': return 'Confirmação vencida';
    default: return s;
  }
}

function relativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return d.toLocaleString('pt-BR');
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'agora mesmo';
    if (min < 60) return `há ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `há ${h}h`;
    const days = Math.floor(h / 24);
    return `há ${days} dia${days > 1 ? 's' : ''}`;
  } catch { return iso; }
}

// ===== Aba: Recuperação Comercial (ADR-152 F4c.5) =====
// Consome /api/runtime/sales-recovery/{metrics,proposals,touches,attributions}.
// Gateado por `runtimeGate` (execution_runtime_enabled) — igual à Operações.
// G-4c-1 preservada na UI: nenhuma msg é enviada sem o dono clicar "Aprovar"
// (aprovação humana obrigatória; modo autonomous continua bloqueado em
// decisão #4 LGPD).

const REPLY_INTENT_LABEL: Record<string, string> = {
  interested: 'Interessado',
  meeting_request: 'Pediu reunião',
  not_now: 'Adiou',
  objection: 'Objeção',
  remove_me: 'Opt-out (LGPD)',
  already_bought: 'Comprou em outro',
  unknown: 'Não interpretado',
};
const REPLY_INTENT_COLOR = (i: string): string => {
  switch (i) {
    case 'interested': case 'meeting_request': return 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30';
    case 'remove_me': return 'text-rose-300 bg-rose-500/10 border-rose-500/30';
    case 'objection': return 'text-amber-300 bg-amber-500/10 border-amber-500/30';
    case 'already_bought': return 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/30';
    default: return 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30';
  }
};

const STAGE_LABEL: Record<string, string> = {
  novo_lead: 'Novo lead', qualificado: 'Qualificado', proposta: 'Proposta',
  orcamento: 'Orçamento', negociacao: 'Negociação', ganho: 'Ganho', perdido: 'Perdido', desqualificado: 'Desqualificado',
};

function RecuperacaoTab() {
  const [metrics, setMetrics] = useState<any | null>(null);
  const [proposals, setProposals] = useState<any[]>([]);
  const [touches, setTouches] = useState<any[]>([]);
  const [attributions, setAttributions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [gateError, setGateError] = useState<string | null>(null);
  const [editingProposal, setEditingProposal] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const load = () => {
    setLoading(true); setGateError(null);
    Promise.all([
      apiFetch('/api/runtime/sales-recovery/metrics'),
      apiFetch('/api/runtime/sales-recovery/proposals?limit=50'),
      apiFetch('/api/runtime/sales-recovery/touches?limit=20'),
      apiFetch('/api/runtime/sales-recovery/attributions?limit=20&window=30'),
    ]).then(async ([mR, pR, tR, aR]) => {
      if (mR.status === 403) {
        const j = await mR.json().catch(() => ({}));
        setGateError(j?.error || 'Execution Runtime não está habilitado para esta organização.');
        return;
      }
      const [m, p, t, a] = await Promise.all([
        mR.json().catch(() => null),
        pR.json().catch(() => ({ items: [] })),
        tR.json().catch(() => ({ items: [] })),
        aR.json().catch(() => ({ items: [] })),
      ]);
      setMetrics(m || null);
      setProposals(Array.isArray(p?.items) ? p.items : []);
      setTouches(Array.isArray(t?.items) ? t.items : []);
      setAttributions(Array.isArray(a?.items) ? a.items : []);
    }).catch(() => setGateError('Falha ao carregar o painel de Recuperação Comercial.'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const markBusy = (id: string, on: boolean) => setBusyIds((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const approve = async (id: string, messageOverride?: string) => {
    markBusy(id, true);
    try {
      const r = await apiFetch(`/api/runtime/sales-recovery/proposals/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageOverride ? { messageOverride } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(j?.error || 'Erro ao aprovar.'); return; }
      if (j.sent) toast.success('Mensagem enviada!');
      else toast.info(j.error || 'Aprovado mas envio falhou. Verifique o sinal.');
      setEditingProposal(null);
      load();
    } catch (e: any) { toast.error(e?.message || 'Erro ao aprovar.'); }
    finally { markBusy(id, false); }
  };

  const dismiss = async (id: string) => {
    markBusy(id, true);
    try {
      const r = await apiFetch(`/api/runtime/sales-recovery/proposals/${id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(j?.error || 'Erro ao dispensar.'); return; }
      toast.success('Proposta dispensada.');
      load();
    } catch (e: any) { toast.error(e?.message || 'Erro ao dispensar.'); }
    finally { markBusy(id, false); }
  };

  const detectNow = async () => {
    try {
      const r = await apiFetch('/api/runtime/sales-recovery/detect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(j?.error || 'Erro na detecção.'); return; }
      toast.success(`Detecção: ${j.detected || 0} deals; ${j.proposed || 0} propostas novas.`);
      load();
    } catch (e: any) { toast.error(e?.message || 'Erro na detecção.'); }
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500"><RefreshCw className="h-5 w-5 animate-spin mr-2" /> Carregando Recuperação…</div>;

  if (gateError) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-amber-500/40 bg-amber-500/5 p-5">
          <div className="flex items-center gap-2 text-amber-300 font-semibold"><ShieldCheck className="h-5 w-5" /> Execution Runtime desligado</div>
          <p className="text-sm text-zinc-300 mt-2">{gateError}</p>
          <p className="text-xs text-zinc-500 mt-3">A Recuperação Comercial exige o Runtime ativo (<code className="text-zinc-400">execution_runtime_enabled</code>) e o opt-in do módulo (<code className="text-zinc-400">sales_recovery_enabled</code>). Fale com o operador da plataforma.</p>
        </div>
      </div>
    );
  }

  const cfg = metrics?.config || {};
  const revenue = metrics?.revenue || {};
  const propsCount = metrics?.proposals || {};
  const touchesCount = metrics?.touches || {};
  const replyBreakdown = metrics?.replyBreakdown7d || {};
  const optOuts = Number(metrics?.optOuts || 0);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <Handshake className="h-4 w-4 text-indigo-400" />
          Painel de <strong>Recuperação Comercial</strong> — Runtime detecta deals parados no funil, propõe mensagem, você aprova/dispensa. Cada envio passa pelo seu clique — modo autônomo bloqueado por LGPD.
          <button onClick={detectNow} className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-300 hover:text-zinc-100 border border-zinc-700 rounded px-2 py-1"><Zap className="h-3.5 w-3.5" /> Detectar agora</button>
          <button onClick={load} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"><RefreshCw className="h-3.5 w-3.5" /> Atualizar</button>
        </div>

        {/* Config flags */}
        <div className="flex flex-wrap gap-2 text-[11px]">
          <ConfigChip label="Recuperação" on={!!cfg.salesRecoveryEnabled} />
          <ConfigChip label="Follow-up automático" on={!!cfg.followupEnabled} />
          <ConfigChip label="Atribuição de revenue" on={!!cfg.attributionEnabled} />
          {cfg.stalledDays != null && <span className="text-zinc-500 self-center">Parado ≥ {cfg.stalledDays}d</span>}
          {cfg.attributionWindowDays != null && <span className="text-zinc-500 self-center">Janela atribuição: {cfg.attributionWindowDays}d</span>}
        </div>

        {/* Bloco 1 — KPIs */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5" /> Impacto do piloto</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Propostas em aberto" value={String(propsCount.open || 0)} accent={propsCount.open > 0 ? 'amber' : undefined} />
            <Metric label="Envios (7d)" value={String(touchesCount.last7d || 0)} />
            <Metric label="Receita recuperada (30d)" value={brl(revenue.last30d || 0)} accent={Number(revenue.last30d || 0) > 0 ? 'emerald' : undefined} />
            <Metric label="Opt-outs formalizados" value={String(optOuts)} accent={optOuts > 0 ? 'amber' : undefined} />
          </div>
          {revenue.total > revenue.last30d && (
            <p className="text-[11px] text-zinc-500 mt-2">Total acumulado: {brl(revenue.total || 0)} · {revenue.attributions30d || 0} atribuições nos últimos 30 dias.</p>
          )}
        </div>

        {/* Bloco 2 — Reply breakdown (7d) */}
        {Object.keys(replyBreakdown).length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><MessageCircle className="h-3.5 w-3.5" /> Respostas dos clientes (7d)</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(replyBreakdown).map(([intent, n]) => (
                <span key={intent} className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${REPLY_INTENT_COLOR(intent)}`}>
                  {REPLY_INTENT_LABEL[intent] || intent}: <strong className="ml-1">{Number(n)}</strong>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Bloco 3 — Propostas em aberto */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><ListChecks className="h-3.5 w-3.5" /> Propostas em aberto ({proposals.length})</h3>
          {proposals.length === 0 ? (
            <EmptyHint text="Sem propostas em aberto. Clique em 'Detectar agora' pra escanear deals parados." />
          ) : (
            <div className="space-y-3">
              {proposals.map((p) => {
                const ev = p.evidence || {};
                const attempt = ev.attemptNumber || 1;
                const busy = busyIds.has(p.id);
                const isEditing = editingProposal === p.id;
                return (
                  <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-zinc-100">{ev.contactName || ev.phone || 'Sem nome'}</span>
                      <span className="text-[11px] text-zinc-500">{STAGE_LABEL[ev.stage] || ev.stage} · parado há {ev.daysStalled || 0}d</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded border border-indigo-500/30 text-indigo-300 bg-indigo-500/10">Tentativa {attempt}/3</span>
                      {ev.messageSource === 'llm' && <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1"><Sparkles className="h-3 w-3" /> LLM</span>}
                      {ev.messageSource === 'template' && <span className="text-[11px] text-zinc-500">template</span>}
                      <span className="ml-auto text-[11px] text-zinc-500 inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {relativeTime(p.detectedAt)}</span>
                    </div>
                    {isEditing ? (
                      <textarea
                        className="w-full min-h-[80px] rounded border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100"
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        placeholder="Edite a mensagem antes de enviar…"
                      />
                    ) : (
                      <p className="text-sm text-zinc-200 whitespace-pre-wrap italic">"{ev.proposedText || '(sem texto)'}"</p>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      {isEditing ? (
                        <>
                          <Button size="sm" onClick={() => approve(p.id, editText)} disabled={busy || !editText.trim()}><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Aprovar editado</Button>
                          <Button size="sm" variant="outline" onClick={() => setEditingProposal(null)} disabled={busy}>Cancelar</Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" onClick={() => approve(p.id)} disabled={busy}><CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Aprovar e enviar</Button>
                          <Button size="sm" variant="outline" onClick={() => { setEditingProposal(p.id); setEditText(ev.proposedText || ''); }} disabled={busy}>Editar</Button>
                          <Button size="sm" variant="ghost" onClick={() => dismiss(p.id)} disabled={busy}><XCircle className="h-3.5 w-3.5 mr-1" /> Dispensar</Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Bloco 4 — Envios recentes */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><Send className="h-3.5 w-3.5" /> Envios recentes ({touches.length})</h3>
          {touches.length === 0 ? (
            <EmptyHint text="Nenhum envio ainda. Aprove uma proposta acima pra começar." />
          ) : (
            <div className="space-y-2">
              {touches.map((t) => (
                <div key={t.id} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 flex items-center gap-3">
                  <span className="text-sm text-zinc-200 min-w-[120px] truncate">{t.contactName || t.phone || t.contactId}</span>
                  <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1"><Clock className="h-3 w-3" /> {relativeTime(t.sentAt)}</span>
                  {t.replyIntent ? (
                    <span className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${REPLY_INTENT_COLOR(t.replyIntent)}`}>{REPLY_INTENT_LABEL[t.replyIntent] || t.replyIntent}</span>
                  ) : (
                    <span className="ml-auto text-[11px] text-zinc-500">aguardando resposta</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bloco 5 — Revenue atribuído (F4c.4) */}
        {attributions.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2 flex items-center gap-1.5"><Repeat2 className="h-3.5 w-3.5" /> Deals ganhos (atribuídos ao piloto)</h3>
            <div className="space-y-2">
              {attributions.map((a) => (
                <div key={a.id} className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center gap-3">
                  <span className="text-sm text-zinc-200 min-w-[120px] truncate">{a.contactName || `ticket ${String(a.ticketId).slice(0, 8)}`}</span>
                  <span className="text-[11px] text-zinc-500">{a.source === 'orders' ? 'venda concretizada' : a.source === 'quotes' ? 'proposta aceita' : 'ticket médio (estimativa)'} · {a.basis}</span>
                  <span className="ml-auto text-sm font-semibold text-emerald-300">{brl(a.revenueRecovered)}</span>
                  <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1 min-w-[80px] justify-end"><Clock className="h-3 w-3" /> {relativeTime(a.attributedAt)}</span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500 mt-2">Atribuição automática quando o ticket vira <em>ganho</em> em até {cfg.attributionWindowDays || 30}d após o envio aprovado.</p>
          </div>
        )}

        {optOuts > 0 && (
          <p className="text-[11px] text-zinc-500 inline-flex items-center gap-1"><UserX className="h-3 w-3" /> {optOuts} contato(s) com opt-out formalizado — Runtime não propõe pra eles (LGPD Art.8 §5).</p>
        )}
      </div>
    </div>
  );
}

function ConfigChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 ${on ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : 'text-zinc-500 border-zinc-700'}`}>
      {on ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />} {label}
    </span>
  );
}

// ===== Aba: Analisar decisão (DI-UI-3) — Pre-Mortem/Red Team/Advocate =====
// O empresário descreve uma decisão e recebe a análise protegida: nível de
// impacto L0–L4 (DI-1), cenários, riscos previstos (Pre-Mortem), desafios de
// premissa (Red Team), a defesa (Advocate) e uma recomendação advisória. Consome
// POST /api/decision-intelligence/analyze. O gate real de execução segue no RBAC.
const DECISION_TYPES: Array<{ key: string; label: string }> = [
  { key: 'purchase', label: 'Compra / estoque' }, { key: 'campaign', label: 'Campanha / marketing' },
  { key: 'hire', label: 'Contratação' }, { key: 'investment', label: 'Investimento' },
  { key: 'expansion', label: 'Expansão / nova unidade' }, { key: 'generic', label: 'Outra' },
];
const brlv = (n: any) => `R$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LEVEL_CLS: Record<number, string> = {
  0: 'text-zinc-300 border-zinc-600 bg-zinc-700/20', 1: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
  2: 'text-amber-300 border-amber-500/40 bg-amber-500/10', 3: 'text-orange-300 border-orange-500/40 bg-orange-500/10',
  4: 'text-red-300 border-red-500/40 bg-red-500/10',
};
const STANCE_UI: Record<string, { label: string; cls: string }> = {
  proceed: { label: 'Prosseguir', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  proceed_with_caution: { label: 'Prosseguir com cautela', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  hold_for_human: { label: 'Segurar — decisão do dono', cls: 'text-red-300 border-red-500/40 bg-red-500/10' },
};

function DecidirTab() {
  const [form, setForm] = useState<any>({ title: '', decisionType: 'purchase', impactAmount: '', expectedValue: '', externalTopic: '', premises: '' });
  const [loading, setLoading] = useState(false);
  const [out, setOut] = useState<any | null>(null);
  const setF = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const analisar = async () => {
    if (!form.title.trim()) { toast.error('Descreva a decisão.'); return; }
    setLoading(true); setOut(null);
    try {
      const premises = String(form.premises).split('\n').map((s: string) => s.trim()).filter(Boolean).map((label: string) => ({ label, basis: 'estimate' }));
      const body: any = {
        title: form.title.trim(), decisionType: form.decisionType,
        impactAmount: form.impactAmount ? Number(String(form.impactAmount).replace(',', '.')) : null, impactUnit: 'BRL',
        expectedValue: form.expectedValue ? Number(String(form.expectedValue).replace(',', '.')) : null,
        externalTopic: form.externalTopic.trim() || undefined, premises, mode: 'auto',
      };
      const r = await apiFetch('/api/decision-intelligence/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Falha na análise.');
      setOut(d);
    } catch (e: any) { toast.error(String(e?.message || e)); } finally { setLoading(false); }
  };

  const inputCls = 'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none';
  const levelN = out?.level ? Number(String(out.level).replace('L', '')) : null;
  const stance = out?.recommendation?.stance ? STANCE_UI[out.recommendation.stance] : null;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="mb-3 text-sm text-zinc-300">Descreva uma decisão e eu analiso os riscos, os cenários e recomendo — antes de você gastar. Ex.: <span className="text-zinc-400">"comprar R$ 180 mil da nova coleção"</span>.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11px] uppercase text-zinc-500">A decisão *</label>
              <input className={inputCls} placeholder="ex.: comprar a coleção de inverno" value={form.title} onChange={(e) => setF('title', e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase text-zinc-500">Tipo</label>
              <select className={inputCls} value={form.decisionType} onChange={(e) => setF('decisionType', e.target.value)}>
                {DECISION_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase text-zinc-500">Valor (R$)</label>
              <input className={inputCls} inputMode="decimal" placeholder="ex.: 180000" value={form.impactAmount} onChange={(e) => setF('impactAmount', e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase text-zinc-500">Retorno esperado (R$, opcional)</label>
              <input className={inputCls} inputMode="decimal" placeholder="ex.: 155000" value={form.expectedValue} onChange={(e) => setF('expectedValue', e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase text-zinc-500">Tópico de mercado (opcional)</label>
              <input className={inputCls} placeholder="ex.: inverno" value={form.externalTopic} onChange={(e) => setF('externalTopic', e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11px] uppercase text-zinc-500">Premissas (uma por linha, opcional)</label>
              <textarea className={`${inputCls} min-h-[70px]`} placeholder={'ex.: crescimento de 20% no inverno\nfornecedor entrega no prazo'} value={form.premises} onChange={(e) => setF('premises', e.target.value)} />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={analisar} disabled={loading}>{loading ? <><RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Analisando…</> : <><Sparkles className="mr-2 h-4 w-4" /> Analisar decisão</>}</Button>
          </div>
        </div>

        {out && (
          <div className="space-y-3">
            {/* Nível + recomendação */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                {levelN != null && <span className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${LEVEL_CLS[levelN]}`}>{out.level} · {out.levelLabel}</span>}
                {stance && <span className={`rounded-full border px-2.5 py-0.5 text-[12px] font-medium ${stance.cls}`}>{stance.label}</span>}
              </div>
              {out.recommendation?.headline && <p className="mt-2 text-sm text-zinc-100">{out.recommendation.headline}</p>}
              {out.recommendation?.why?.length > 0 && (
                <ul className="mt-2 space-y-1 text-[13px] text-zinc-400">
                  {out.recommendation.why.map((w: string, i: number) => <li key={i} className="flex gap-2"><span className="text-zinc-600">•</span> {w}</li>)}
                </ul>
              )}
              {out.skipped && <p className="mt-1 text-[12px] text-zinc-500">{out.reason}</p>}
              <p className="mt-2 text-[11px] text-zinc-600">Recomendação advisória — a autorização final segue as permissões (RBAC).</p>
            </div>

            {/* Tendência de mercado (DI-5.6) — inteligência de nicho anonimizada +
                o delta da última pesquisa (novo/cresceu/retraiu/saiu). Só aparece
                quando o nicho tem pesquisa fresca e a org optou (external_intelligence_enabled). */}
            {out.external?.available && <MercadoTrendCard external={out.external} />}

            {/* Cenários */}
            {out.scenarios?.ok && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="mb-2 text-sm font-medium text-zinc-200">Cenários</div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  {['conservative', 'base', 'aggressive'].map((k) => (
                    <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
                      <div className="text-[11px] uppercase text-zinc-500">{out.scenarios[k].label}</div>
                      <div className="mt-0.5 font-semibold text-zinc-100 tabular-nums">{brlv(out.scenarios[k].value)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Pre-Mortem */}
            {out.premortem?.risks?.length > 0 && (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-200"><AlertTriangle className="h-4 w-4" /> Pre-Mortem — o que pode dar errado</div>
                <div className="space-y-2">
                  {out.premortem.risks.map((rk: any, i: number) => (
                    <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                      <div className="flex items-center gap-2 text-[13px]">
                        <span className="text-zinc-100">{rk.description}</span>
                        {rk.probability && <span className="ml-auto rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] uppercase text-zinc-300">{rk.probability}</span>}
                      </div>
                      {rk.mitigation && <div className="mt-1 text-[12px] text-zinc-400">Mitigação: {rk.mitigation}</div>}
                      {(rk.leadingIndicator || rk.threshold) && <div className="mt-0.5 text-[11px] text-zinc-500">Monitorar: {rk.leadingIndicator}{rk.threshold ? ` (${rk.threshold})` : ''}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Red Team */}
            {out.redTeam?.challenges?.length > 0 && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-200"><ShieldCheck className="h-4 w-4 text-red-300" /> Red Team — premissas a validar</div>
                <ul className="space-y-1 text-[13px] text-zinc-400">
                  {out.redTeam.challenges.map((c: any, i: number) => <li key={i} className="flex gap-2"><span className="text-zinc-600">•</span> <span><span className="text-zinc-300">{c.premise}:</span> {c.issue}</span></li>)}
                </ul>
              </div>
            )}

            {/* Advocate */}
            {out.advocate && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-200"><TrendingUp className="h-4 w-4" /> A favor</div>
                <p className="text-[13px] text-zinc-200">{out.advocate.thesis}</p>
                {out.advocate.support?.length > 0 && (
                  <ul className="mt-2 space-y-1 text-[13px] text-zinc-400">
                    {out.advocate.support.map((s: string, i: number) => <li key={i} className="flex gap-2"><span className="text-zinc-600">•</span> {s}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Card: Tendência de mercado (DI-5.6 / ADR-157) =====
// Surfaça pro lojista a inteligência de nicho COMPARTILHADA (anonimizada, sem
// dado de outra loja) + o delta da última pesquisa. O broker é read-only: este
// card nunca dispara pesquisa, só lê o que a automação já publicou. `trend` vem
// null na 1ª versão do nicho (não há "anterior" pra comparar).
function MercadoTrendCard({ external }: { external: any }) {
  const ctx = external?.contextualization?.context || {};
  const summary: string = typeof ctx.summary === 'string' ? ctx.summary : '';
  const conf = Number(ctx.confidence);
  const trend = external?.trend || null;
  const changes: Array<{ kind: string; label: string; items: string[] }> = trend && !trend.isFirst ? [
    { kind: 'new', label: '✨ novo', items: Array.isArray(trend.new) ? trend.new : [] },
    { kind: 'grew', label: '↑ cresceu', items: Array.isArray(trend.grew) ? trend.grew : [] },
    { kind: 'shrank', label: '↓ retraiu', items: Array.isArray(trend.shrank) ? trend.shrank : [] },
    { kind: 'gone', label: 'saiu', items: Array.isArray(trend.gone) ? trend.gone : [] },
  ].filter((c) => c.items.length > 0) : [];
  const confDelta = trend ? Number(trend.confidenceDelta) : 0;
  const nothingChanged = trend && !trend.isFirst && changes.length === 0 && Math.abs(confDelta) < 0.01;

  return (
    <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-sky-200">
        <Globe className="h-4 w-4" /> Tendência de mercado — {external.vertical}
        {Number.isFinite(conf) && conf > 0 && <span className="ml-auto text-[11px] font-normal text-zinc-400">confiança {Math.round(conf * 100)}%</span>}
      </div>
      {summary && <p className="text-[13px] text-zinc-200">{summary}</p>}

      {trend?.isFirst && <p className="mt-2 text-[12px] text-zinc-500">Primeira leitura deste nicho — sem versão anterior pra comparar. As próximas mostram o que mudou.</p>}
      {nothingChanged && <p className="mt-2 text-[12px] text-zinc-500">Sem mudança material desde a última pesquisa deste nicho.</p>}

      {changes.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">O que mudou desde a última vez</p>
          {changes.map((c) => (
            <div key={c.kind} className="flex flex-wrap items-center gap-1.5">
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${TREND_CLS[c.kind]}`}>{c.label}</span>
              {c.items.map((it, i) => (
                <span key={i} className={`rounded-full border px-2 py-0.5 text-[11px] ${c.kind === 'gone' ? 'border-zinc-700 text-zinc-500 line-through' : 'border-zinc-700 text-zinc-300'}`}>{it}</span>
              ))}
            </div>
          ))}
        </div>
      )}

      {trend && !trend.isFirst && Math.abs(confDelta) >= 0.01 && (
        <p className={`mt-2 text-[12px] ${confDelta > 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
          Confiança {confDelta > 0 ? 'subiu' : 'caiu'} {Math.abs(Math.round(confDelta * 100))} p.p. vs a última pesquisa.
        </p>
      )}

      <p className="mt-2 text-[11px] text-zinc-600">Inteligência de nicho compartilhada e anonimizada — nunca inclui dados de outra loja. Só leitura (não dispara pesquisa).</p>
    </div>
  );
}

const TREND_CLS: Record<string, string> = {
  new: 'bg-sky-500/15 text-sky-300',
  grew: 'bg-emerald-500/15 text-emerald-300',
  shrank: 'bg-amber-500/15 text-amber-300',
  gone: 'bg-zinc-700/40 text-zinc-400',
};
