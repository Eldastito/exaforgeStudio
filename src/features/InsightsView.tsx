import { useEffect, useMemo, useState } from 'react';
import { Loader2, Check, RefreshCw, Lightbulb } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

// ============================================================================
// Insights globais (ADR-136, kernel de inteligência empresarial).
// Generaliza a tela de Insights do varejo para TODA a plataforma: o Pareto dos
// sinais abertos de qualquer domínio (finanças, produção, compras, estoque,
// vendas, varejo…) num só lugar, com "Agir" (propõe a ação recomendada) e o
// painel de "Ações em andamento" que fecha o ciclo propor→aprovar→concluir→medir.
// Núcleo — visível para toda org, consome /api/insights e /api/actions.
// ============================================================================

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;

const SEV: Record<string, { label: string; cls: string }> = {
  critical: { label: 'crítico', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  risk: { label: 'risco', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  attention: { label: 'atenção', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  info: { label: 'info', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
};
const ACTION_STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_approval: { label: 'aguarda aprovação', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'aprovada', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  done: { label: 'concluída', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  cancelled: { label: 'cancelada', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  rejected: { label: 'rejeitada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};
// Rótulos pt-BR dos domínios (o back-end é a fonte da verdade; aqui só apresenta).
const DOMAIN_LABEL: Record<string, string> = {
  finance: 'Finanças', production: 'Produção', procurement: 'Compras', inventory: 'Estoque',
  sales: 'Vendas', retail_ops: 'Varejo', tasks: 'Tarefas', people: 'Pessoas',
  security: 'Segurança', compliance: 'Compliance',
};
const domLabel = (d: string) => DOMAIN_LABEL[d] || d;
const fmtImpact = (im: any) => im ? (im.unit === 'BRL' ? brl(im.amount) : `${im.amount} ${im.unit === 'units' ? 'un' : (im.unit || '')}`.trim()) : null;
const fmtVal = (v: any, unit: any) => unit === 'BRL' ? brl(v) : `${v} ${unit === 'units' ? 'un' : (unit || '')}`.trim();

export function InsightsView() {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [acted, setActed] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<any[]>([]);
  const [domainFilter, setDomainFilter] = useState<string>('all');

  const loadActions = async () => {
    const d = await apiFetch('/api/insights/actions').then(r => r.json()).catch(() => ({}));
    setActions(Array.isArray(d?.actions) ? d.actions : []);
  };
  const load = async () => {
    setLoading(true);
    try { setData(await apiFetch('/api/insights').then(r => r.json()).catch(() => null)); await loadActions(); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await apiFetch('/api/insights/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (res.ok) { const d = await res.json().catch(() => ({})); toast.success(`Negócio analisado: ${d.published || 0} sinal(is) aberto(s).`); load(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao analisar.'); }
    } finally { setAnalyzing(false); }
  };
  const act = async (p: any) => {
    if (!p?.signalId) return;
    const res = await apiFetch('/api/insights/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signalId: p.signalId }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.ok) {
      const st = d.action?.status;
      setActed(prev => ({ ...prev, [p.signalId]: st }));
      toast.success(st === 'approved' ? 'Ação criada e aprovada.' : 'Ação criada — aguardando aprovação.');
      loadActions();
    } else toast.error(d.error || 'Falha ao criar a ação.');
  };
  const actionOp = async (a: any, op: 'approve' | 'cancel' | 'complete') => {
    let body: any = undefined;
    if (op === 'complete') {
      const v = window.prompt('Resultado obtido (valor, opcional):', '');
      if (v === null) return;
      body = { resultAmount: v.trim() === '' ? null : Number(v) };
    }
    const res = await apiFetch(`/api/actions/${a.id}/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (res.ok) { toast.success(op === 'approve' ? 'Ação aprovada.' : op === 'cancel' ? 'Ação cancelada.' : 'Ação concluída (medida).'); loadActions(); }
    else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha na operação.'); }
  };

  const priorities: any[] = data?.priorities || [];
  const sev = data?.bySeverity || {};
  const byDomain: Record<string, number> = data?.byDomain || {};
  const ledger = data?.ledgerTotals || null;
  const domains = useMemo(() => Object.keys(byDomain).sort((a, b) => (byDomain[b] || 0) - (byDomain[a] || 0)), [byDomain]);
  const shown = domainFilter === 'all' ? priorities : priorities.filter((p) => p.domain === domainFilter);
  const openActions = actions.filter(a => a.status !== 'done' && a.status !== 'cancelled');

  if (loading) return <div className="flex-1 flex items-center gap-2 p-8 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Lightbulb className="w-4 h-4 text-amber-400" /> O que a IA observou no seu negócio</div>
          <div className="flex items-center gap-1.5">
            {(['critical', 'risk', 'attention', 'info'] as const).filter(k => (sev[k] || 0) > 0).map(k => (
              <span key={k} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${SEV[k].cls}`}>{sev[k]} {SEV[k].label}</span>
            ))}
          </div>
          <button onClick={analyze} disabled={analyzing} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{analyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Analisar agora</button>
        </div>

        {/* Impact Ledger — esperado × realizado (o que o negócio ganhou agindo). */}
        {ledger && ledger.count > 0 && (
          <div className="mb-5 grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3"><p className="text-[11px] text-zinc-500">Esperado</p><p className="text-lg font-semibold text-zinc-200">{brl(ledger.expected)}</p></div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3"><p className="text-[11px] text-zinc-500">Realizado</p><p className="text-lg font-semibold text-emerald-300">{brl(ledger.realized)}</p></div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3"><p className="text-[11px] text-zinc-500">Gap</p><p className={`text-lg font-semibold ${Number(ledger.gap) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{brl(ledger.gap)}</p></div>
          </div>
        )}

        {/* Filtro por domínio (só aparece quando há mais de um domínio com sinal). */}
        {domains.length > 1 && (
          <div className="mb-3 flex items-center gap-1.5 flex-wrap">
            <button onClick={() => setDomainFilter('all')} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${domainFilter === 'all' ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:bg-zinc-800'}`}>Todos ({priorities.length})</button>
            {domains.map((d) => (
              <button key={d} onClick={() => setDomainFilter(d)} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${domainFilter === d ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400 hover:bg-zinc-800'}`}>{domLabel(d)} ({byDomain[d]})</button>
            ))}
          </div>
        )}

        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">O que atacar primeiro</h3>
        {shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">Nenhuma prioridade agora. Clique em <strong>“Analisar agora”</strong> — a IA varre o negócio inteiro e traz o que importa.</div>
        ) : (
          <div className="space-y-2">
            {shown.map((p, i) => (
              <div key={p.signalId || i} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-zinc-500">#{i + 1}</span>
                  <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[11px] text-zinc-400">{domLabel(p.domain)}</span>
                  {p.impact && <span className="text-[11px] text-emerald-300">impacto {fmtImpact(p.impact)}</span>}
                  {p.dueHint && <span className="text-[11px] text-zinc-500">· {p.dueHint}</span>}
                </div>
                <p className="mt-1 text-sm text-zinc-200">{p.interpretation || p.fact}</p>
                <div className="mt-1.5 flex items-center gap-2 text-[12px] flex-wrap">
                  <span className="text-zinc-500">Sugestão:</span>
                  <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-indigo-200">{p.recommendedAction}</span>
                  {p.signalId && (acted[p.signalId]
                    ? <span className="inline-flex items-center gap-1 text-emerald-300"><Check className="w-3.5 h-3.5" /> {acted[p.signalId] === 'approved' ? 'ação criada' : 'ação criada (aguarda aprovação)'}</span>
                    : <button onClick={() => act(p)} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-500">Agir</button>)}
                </div>
              </div>
            ))}
          </div>
        )}

        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-6 mb-2">Ações em andamento ({openActions.length})</h3>
        {actions.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-600">Nenhuma ação ainda. Clique em <strong>“Agir”</strong> numa prioridade acima para criar uma.</div>
        ) : (
          <div className="space-y-1.5">
            {actions.map((a) => {
              const st = ACTION_STATUS[a.status] || { label: a.status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
              return (
                <div key={a.id} className="flex items-center gap-2 flex-wrap rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                  <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[11px] text-zinc-500">{domLabel(a.domain)}</span>
                  <span className="text-sm text-zinc-200">{a.title}</span>
                  {a.expected_impact != null && <span className="text-[11px] text-zinc-500">· esperado {fmtVal(a.expected_impact, a.impact_unit)}</span>}
                  {a.status === 'done' && a.result_amount != null && <span className="text-[11px] text-emerald-300">· realizado {fmtVal(a.result_amount, a.impact_unit)}</span>}
                  <div className="ml-auto flex items-center gap-1.5">
                    {a.status === 'awaiting_approval' && <button onClick={() => actionOp(a, 'approve')} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Aprovar</button>}
                    {a.status === 'approved' && <button onClick={() => actionOp(a, 'complete')} className="rounded border border-indigo-500/30 px-2 py-0.5 text-[11px] text-indigo-300 hover:bg-indigo-500/10">Concluir</button>}
                    {(a.status === 'awaiting_approval' || a.status === 'approved') && <button onClick={() => actionOp(a, 'cancel')} className="rounded border border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800">Cancelar</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default InsightsView;
