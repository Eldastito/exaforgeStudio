import React, { useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { toast } from '@/src/lib/toast';
import { BrainCircuit, Send, Sparkles, RefreshCw, ListChecks, MessageSquare, TrendingUp, ShieldCheck, CheckCircle2, XCircle, Target } from 'lucide-react';

type Msg = { role: 'user' | 'ai'; text: string };
type Tab = 'conversar' | 'plano';

const SUGESTOES = [
  'Por que minhas vendas mudaram este mês?',
  'Onde estou perdendo dinheiro?',
  'Quais clientes têm risco de cancelar?',
  'O que devo priorizar hoje?',
  'Qual produto devo promover?',
];

export function ExecutiveView() {
  const [tab, setTab] = useState<Tab>('conversar');

  return (
    <div className="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
      <div className="p-6 border-b border-zinc-800">
        <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <BrainCircuit className="h-6 w-6 text-indigo-400" /> Diretor Executivo IA
        </h2>
        <p className="text-sm text-zinc-400 mt-1">Pergunte qualquer coisa sobre o seu negócio, ou acompanhe o plano de ação — tudo com dados reais do sistema, nada inventado.</p>
        <div className="flex gap-2 mt-4">
          <TabButton active={tab === 'conversar'} onClick={() => setTab('conversar')} icon={<MessageSquare className="h-4 w-4" />} label="Conversar" />
          <TabButton active={tab === 'plano'} onClick={() => setTab('plano')} icon={<ListChecks className="h-4 w-4" />} label="Plano de Ação" />
        </div>
      </div>
      {tab === 'conversar' ? <ConversarTab /> : <PlanoDeAcaoTab />}
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
