import React, { useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { toast } from '@/src/lib/toast';
import { BrainCircuit, Send, Sparkles, RefreshCw, ListChecks, MessageSquare, TrendingUp, ShieldCheck, CheckCircle2, XCircle, Target, Activity, AlertTriangle, Clock, Zap, Handshake, Repeat2, UserX, MessageCircle } from 'lucide-react';
import { useStore } from '@/src/store/useStore';

type Msg = { role: 'user' | 'ai'; text: string };
type Tab = 'conversar' | 'plano' | 'funciona' | 'operacoes' | 'recuperacao';

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
  const [tab, setTab] = useState<Tab>('conversar');
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
          <TabButton active={tab === 'conversar'} onClick={() => setTab('conversar')} icon={<MessageSquare className="h-4 w-4" />} label="Conversar" />
          <TabButton active={tab === 'plano'} onClick={() => setTab('plano')} icon={<ListChecks className="h-4 w-4" />} label="Plano de Ação" />
          <TabButton active={tab === 'funciona'} onClick={() => setTab('funciona')} icon={<TrendingUp className="h-4 w-4" />} label="O que funciona" />
          {showOperacoes && <TabButton active={tab === 'operacoes'} onClick={() => setTab('operacoes')} icon={<Activity className="h-4 w-4" />} label="Operações" />}
          {showOperacoes && <TabButton active={tab === 'recuperacao'} onClick={() => setTab('recuperacao')} icon={<Handshake className="h-4 w-4" />} label="Recuperação" />}
        </div>
      </div>
      {tab === 'conversar' ? <ConversarTab /> : tab === 'plano' ? <PlanoDeAcaoTab /> : tab === 'operacoes' ? <OperacoesTab /> : tab === 'recuperacao' ? <RecuperacaoTab /> : <FuncionaTab />}
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
  const [loading, setLoading] = useState(true);
  const [gateError, setGateError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setGateError(null);
    Promise.all([
      apiFetch('/api/runtime/operations/overview'),
      apiFetch('/api/runtime/operations/exceptions?limit=50'),
      apiFetch('/api/runtime/operations/indicators'),
    ]).then(async ([oR, eR, iR]) => {
      // Runtime não habilitado (flag off) → 403 uniforme
      if (oR.status === 403) {
        const j = await oR.json().catch(() => ({}));
        setGateError(j?.error || 'Execution Runtime não está habilitado para esta organização.');
        return;
      }
      const [o, e, i] = await Promise.all([
        oR.json().catch(() => null),
        eR.json().catch(() => ({ exceptions: [] })),
        iR.json().catch(() => ({})),
      ]);
      setOverview(o || null);
      setExceptions(Array.isArray(e?.exceptions) ? e.exceptions : []);
      setIndicators(i && typeof i === 'object' ? i : {});
    }).catch(() => setGateError('Falha ao carregar o painel de Operações.'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

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
