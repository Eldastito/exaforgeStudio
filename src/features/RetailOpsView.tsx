import { useEffect, useMemo, useState } from 'react';
import { Store, Loader2, Check, X, RefreshCw, Calculator, CalendarDays, Plus, Scale, AlertTriangle, Users, Upload, Trash2, Sparkles, Globe, Download, Lightbulb, Boxes, TrendingUp, CreditCard, Pencil, ArrowLeftRight, Truck, PackageCheck } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

// ============================================================================
// Rede de Lojas — Operação (RetailOps, ADR-083/084). Telas do FECHAMENTO diário
// e da COMISSÃO da equipe, consumindo a API já testada (/api/retailops/*).
// Só aparece quando o módulo `retail` está habilitado na org.
// ============================================================================

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const CLOSING_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pendente', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  received: { label: 'Informado', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  extracted: { label: 'Lido (IA)', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  needs_review: { label: 'Conferir', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'Aprovado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  rejected: { label: 'Rejeitado', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};
const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Prévia', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  approved: { label: 'Aprovada', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  rejected: { label: 'Rejeitada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};

function Badge({ map, s }: { map: Record<string, { label: string; cls: string }>; s: string }) {
  const it = map[s] || { label: s, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${it.cls}`}>{it.label}</span>;
}

// ---- Insights da loja: o que a IA observou e sugere ------------------------
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
function InsightsTab() {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [acted, setActed] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<any[]>([]);

  const loadActions = async () => {
    const d = await apiFetch('/api/retailops/insights/actions').then(r => r.json()).catch(() => ({}));
    setActions(Array.isArray(d?.actions) ? d.actions : []);
  };
  const act = async (p: any) => {
    if (!p?.signalId) return;
    const res = await apiFetch('/api/retailops/insights/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signalId: p.signalId }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.ok) {
      const st = d.action?.status;
      setActed(prev => ({ ...prev, [p.signalId]: st }));
      if (d.transfer && d.transfer.id) toast.success('Transferência despachada — acompanhe na aba Transferências.');
      else if (d.transfer && d.transfer.error) toast.error(`Ação criada, mas a transferência falhou: ${d.transfer.error}`);
      else toast.success(st === 'approved' ? 'Ação criada e aprovada.' : 'Ação criada — aguardando aprovação.');
      loadActions();
    } else toast.error(d.error || 'Falha ao criar a ação.');
  };
  const actionOp = async (a: any, op: 'approve' | 'cancel' | 'complete') => {
    let body: any = undefined;
    if (op === 'complete') {
      const v = window.prompt('Resultado obtido (R$, opcional):', '');
      if (v === null) return;
      body = { resultAmount: v.trim() === '' ? null : Number(v) };
    }
    const res = await apiFetch(`/api/actions/${a.id}/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (res.ok) { toast.success(op === 'approve' ? 'Ação aprovada.' : op === 'cancel' ? 'Ação cancelada.' : 'Ação concluída (medida).'); loadActions(); }
    else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha na operação.'); }
  };

  const load = async () => {
    setLoading(true);
    try { setData(await apiFetch('/api/retailops/insights').then(r => r.json()).catch(() => null)); await loadActions(); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await apiFetch('/api/retailops/signals/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (res.ok) { const d = await res.json().catch(() => ({})); toast.success(`Operações analisadas: ${d.published || 0} sinal(is).`); load(); }
      else toast.error('Falha ao analisar.');
    } finally { setAnalyzing(false); }
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
  const priorities: any[] = data?.priorities || [];
  const patterns: any[] = data?.patterns || [];
  const sev = data?.bySeverity || {};
  const fmtImpact = (im: any) => im ? (im.unit === 'BRL' ? brl(im.amount) : `${im.amount} ${im.unit === 'units' ? 'un' : (im.unit || '')}`.trim()) : null;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Lightbulb className="w-4 h-4 text-amber-400" /> O que a IA observou na sua loja</div>
        <div className="flex items-center gap-1.5">
          {(['critical', 'risk', 'attention', 'info'] as const).filter(k => (sev[k] || 0) > 0).map(k => (
            <span key={k} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${SEV[k].cls}`}>{sev[k]} {SEV[k].label}</span>
          ))}
        </div>
        <button onClick={analyze} disabled={analyzing} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{analyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Analisar agora</button>
      </div>

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">O que atacar primeiro</h3>
      {priorities.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">Nenhuma prioridade agora. Clique em <strong>“Analisar agora”</strong> — a IA varre a operação e traz o que importa.</div>
      ) : (
        <div className="space-y-2">
          {priorities.map((p, i) => (
            <div key={p.signalId || i} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] font-mono text-zinc-500">#{i + 1}</span>
                <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[11px] text-zinc-400">{p.domain}</span>
                {p.impact && <span className="text-[11px] text-emerald-300">impacto {fmtImpact(p.impact)}</span>}
                <span className="text-[11px] text-zinc-500">· {p.dueHint}</span>
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

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-6 mb-2">Padrões aprendidos ({patterns.length})</h3>
      {patterns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-600">A IA ainda não validou padrões recorrentes. Eles aparecem quando algo se repete ao longo das semanas (rode o aprendizado na aba Padrões).</div>
      ) : (
        <div className="space-y-1.5">
          {patterns.map((p) => (
            <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-zinc-500"><span className="font-mono">{p.pattern_type}</span><span>· confiança {Math.round(Number(p.confidence) * 100)}% · visto {p.occurrences}x</span></div>
              {p.description && <p className="text-sm text-zinc-200">{p.description}</p>}
            </div>
          ))}
        </div>
      )}

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-6 mb-2">Ações em andamento ({actions.filter(a => a.status !== 'done' && a.status !== 'cancelled').length})</h3>
      {actions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-600">Nenhuma ação ainda. Clique em <strong>“Agir”</strong> numa prioridade acima para criar uma.</div>
      ) : (
        <div className="space-y-1.5">
          {actions.map((a) => {
            const st = ACTION_STATUS[a.status] || { label: a.status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
            return (
              <div key={a.id} className="flex items-center gap-2 flex-wrap rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                <span className="text-sm text-zinc-200">{a.title}</span>
                {a.expected_impact != null && <span className="text-[11px] text-zinc-500">· esperado {a.impact_unit === 'BRL' ? brl(a.expected_impact) : `${a.expected_impact} ${a.impact_unit === 'units' ? 'un' : (a.impact_unit || '')}`.trim()}</span>}
                {a.status === 'done' && a.result_amount != null && <span className="text-[11px] text-emerald-300">· realizado {a.impact_unit === 'BRL' ? brl(a.result_amount) : a.result_amount}</span>}
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
  );
}

// Tabela compacta do relatório de comissão (por vendedor/produto/loja).
function ReportBlock({ title, rows, cols, empty }: { title: string; rows: any[]; cols: Array<[string, string, boolean?]>; empty: string }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">{title}</h4>
      {(!rows || rows.length === 0) ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-3 text-center text-[12px] text-zinc-600">{empty}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              {cols.map(([k, label, money]) => <th key={k} className={`px-3 py-1.5 font-medium ${money ? 'text-right' : 'text-left'}`}>{label}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-zinc-800/60">
                  {cols.map(([k, , money]) => <td key={k} className={`px-3 py-1.5 ${money ? 'text-right text-zinc-200' : 'text-zinc-300'} ${k === 'commission' ? 'text-emerald-300' : ''}`}>{money ? brl(r[k]) : r[k]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Padrões (IA) — memória de padrões do varejo (ADR-142) ------------------
function PatternsTab() {
  const [patterns, setPatterns] = useState<any[]>([]);
  const [typeStats, setTypeStats] = useState<any[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);

  const effOf = (type: string) => typeStats.find((s) => s.pattern_type === type);

  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/api/retailops/patterns').then(r => r.json()).catch(() => ({}));
      setEnabled(!!d?.enabled);
      setPatterns(Array.isArray(d?.patterns) ? d.patterns : []);
      setTypeStats(Array.isArray(d?.typeStats) ? d.typeStats : []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const recordOutcome = async (p: any, outcome: 'worked' | 'no_effect' | 'backfired') => {
    const res = await apiFetch(`/api/retailops/patterns/${p.id}/outcome`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success('Desfecho registrado — o sistema aprendeu com o resultado.');
      if (Array.isArray(d.patterns)) setPatterns(d.patterns);
      if (Array.isArray(d.typeStats)) setTypeStats(d.typeStats);
    } else toast.error(d.error || 'Falha ao registrar o desfecho.');
  };

  const toggle = async () => {
    const res = await apiFetch('/api/retailops/patterns/flag', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setEnabled(!!d.enabled); toast.success(d.enabled ? 'Aprendizado de padrões ligado.' : 'Aprendizado de padrões desligado.'); }
    else toast.error(d.error || 'Falha ao alterar.');
  };
  const learn = async () => {
    setLearning(true);
    try {
      const res = await apiFetch('/api/retailops/patterns/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`Aprendizado rodado: ${d.detected || 0} padrão(ões), ${d.validated || 0} validado(s).`); setPatterns(Array.isArray(d.patterns) ? d.patterns : []); }
      else toast.error(d.error || 'Falha ao rodar o aprendizado.');
    } finally { setLearning(false); }
  };
  const analyzeOps = async () => {
    const res = await apiFetch('/api/retailops/signals/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast.success(`Operações analisadas: ${d.published || 0} sinal(is) para o Diretor/Pareto${d.resolved ? `, ${d.resolved} resolvido(s)` : ''}.`);
    else toast.error(d.error || 'Falha ao analisar as operações.');
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <p className="text-sm text-zinc-400">Padrões recorrentes que a IA aprende da operação (divergência de caixa, estoque negativo…). A confiança é calculada por regra de recorrência; a IA só descreve.</p>
        <button onClick={toggle} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>
          <span className={`inline-block w-2 h-2 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-zinc-600'}`} /> Aprendizado {enabled ? 'ligado' : 'desligado'}
        </button>
        <button onClick={learn} disabled={learning || !enabled} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {learning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Rodar aprendizado agora
        </button>
        <button onClick={analyzeOps} title="Analisa as operações (loja virtual, reservas, vendas) e publica sinais para o Pareto e o Diretor IA." className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/20">
          <Calculator className="w-4 h-4" /> Analisar operações
        </button>
      </div>

      {patterns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center">
          <p className="text-sm text-zinc-500">Nenhum padrão aprendido ainda.</p>
          <p className="mt-1 text-[12px] text-zinc-600">{enabled ? 'Rode o aprendizado quando houver histórico (fechamentos, divergências, estoque). Padrões validados aparecem para o Diretor IA e no Pareto.' : 'Ligue o aprendizado para a IA começar a observar os padrões da loja.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {patterns.map((p) => {
            const eff = effOf(p.pattern_type);
            return (
            <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-zinc-500">{p.pattern_type}</span>
                <Badge map={PATTERN_STATUS} s={p.status} />
                <span className="text-[11px] text-zinc-500">confiança {Math.round(Number(p.confidence) * 100)}% · visto {p.occurrences}x{p.last_seen_date ? ` · ${p.last_seen_date}` : ''}</span>
                {eff && eff.acted > 0 && <span className="text-[11px] text-indigo-300">eficácia das ações {Math.round(Number(eff.effectiveness) * 100)}% ({eff.acted}x)</span>}
              </div>
              {p.description && <p className="mt-1.5 text-sm text-zinc-200">{p.description}</p>}
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[11px] text-zinc-500">Agiu sobre isso? Como foi:</span>
                <button onClick={() => recordOutcome(p, 'worked')} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Funcionou</button>
                <button onClick={() => recordOutcome(p, 'no_effect')} className="rounded border border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800">Sem efeito</button>
                <button onClick={() => recordOutcome(p, 'backfired')} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">Piorou</button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type RetailTab = 'insights' | 'fechamento' | 'comissao' | 'maisvendidos' | 'cartao' | 'clientes' | 'divergencia' | 'estoque' | 'reposicao' | 'transferencias' | 'equipe' | 'padroes' | 'lojavirtual';
const TABS: { key: RetailTab; label: string; icon: any }[] = [
  { key: 'insights', label: 'Insights', icon: Lightbulb },
  { key: 'fechamento', label: 'Fechamento diário', icon: CalendarDays },
  { key: 'comissao', label: 'Comissão', icon: Calculator },
  { key: 'maisvendidos', label: 'Mais vendidos', icon: TrendingUp },
  { key: 'cartao', label: 'Recebíveis (cartão)', icon: CreditCard },
  { key: 'clientes', label: 'Clientes (PDV)', icon: Users },
  { key: 'divergencia', label: 'Divergência', icon: Scale },
  { key: 'estoque', label: 'Estoque negativo', icon: AlertTriangle },
  { key: 'reposicao', label: 'Reposição (grade)', icon: Boxes },
  { key: 'transferencias', label: 'Transferências', icon: ArrowLeftRight },
  { key: 'equipe', label: 'Equipe & cobrança', icon: Users },
  { key: 'padroes', label: 'Padrões (IA)', icon: Sparkles },
  { key: 'lojavirtual', label: 'Loja virtual → PDV', icon: Globe },
];

const PATTERN_STATUS: Record<string, { label: string; cls: string }> = {
  validated: { label: 'Validado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  candidate: { label: 'Candidato', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  dormant: { label: 'Adormecido', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  refuted: { label: 'Refutado', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};

export function RetailOpsView() {
  const [tab, setTab] = useState<RetailTab>('insights');
  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-4">
        <p className="zf-kicker mb-1">Rede de Lojas</p>
        <h2 className="zf-page-title flex items-center gap-2"><Store className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Operação da Rede</h2>
        <p className="text-zinc-400 text-sm mt-1">Fechamento diário, comissão, conferência com o sistema, estoque e cobrança da equipe.</p>
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${tab === key ? 'bg-indigo-600 text-white' : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}><Icon className="w-4 h-4" /> {label}</button>
        ))}
      </div>
      {tab === 'insights' && <InsightsTab />}
      {tab === 'fechamento' && <ClosingsTab />}
      {tab === 'comissao' && <CommissionTab />}
      {tab === 'maisvendidos' && <TopProductsTab />}
      {tab === 'cartao' && <CardReceivablesTab />}
      {tab === 'clientes' && <PdvCustomersTab />}
      {tab === 'divergencia' && <ReconciliationTab />}
      {tab === 'estoque' && <NegativeStockTab />}
      {tab === 'reposicao' && <ReplenishmentTab />}
      {tab === 'transferencias' && <TransfersTab />}
      {tab === 'equipe' && <ResponsiblesTab />}
      {tab === 'padroes' && <PatternsTab />}
      {tab === 'lojavirtual' && <OnlineReserveTab />}
    </div>
  );
}

// ---- Loja virtual → PDV: baixas pendentes (ADR-143 Fase 0) -------------------
function OnlineReserveTab() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [onlineStoreId, setOnlineStoreId] = useState<string>('');
  const [defaultSeller, setDefaultSeller] = useState<string>('');
  const [users, setUsers] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [reserves, setReserves] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [fStore, setFStore] = useState('');
  const [fProduct, setFProduct] = useState('');
  const [fQty, setFQty] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [d, st, pr] = await Promise.all([
        apiFetch('/api/retailops/online-reserve').then(r => r.json()).catch(() => ({})),
        apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({})),
        apiFetch('/api/products').then(r => r.json()).catch(() => ([])),
      ]);
      setEnabled(!!d?.enabled);
      setOnlineStoreId(d?.onlineStoreId || '');
      setDefaultSeller(d?.defaultSellerUserId || '');
      setUsers(Array.isArray(d?.users) ? d.users : []);
      setReserves(Array.isArray(d?.reserves) ? d.reserves : []);
      setPending(Array.isArray(d?.pending) ? d.pending : []);
      const sts = Array.isArray(st?.stores) ? st.stores : (Array.isArray(st) ? st : []);
      setStores(sts);
      setProducts(Array.isArray(pr) ? pr.filter((p: any) => p.type === 'product') : []);
      setFStore(prev => prev || d?.onlineStoreId || (sts[0]?.id ?? ''));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const saveReserve = async () => {
    if (!fStore || !fProduct || fQty === '') { toast.error('Escolha loja, produto e quantidade.'); return; }
    const res = await apiFetch('/api/retailops/online-reserve/item', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: fStore, productId: fProduct, qty: Number(fQty) }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast.success('Reserva salva.'); setFProduct(''); setFQty(''); load(); }
    else toast.error(d.error || 'Falha ao salvar a reserva.');
  };
  const removeReserve = async (r: any) => {
    const res = await apiFetch('/api/retailops/online-reserve/item', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: r.store_id, productId: r.product_service_id, variantId: r.variant_id || null }) });
    if (res.ok) { toast.success('Reserva removida.'); load(); }
    else toast.error('Falha ao remover.');
  };

  const saveFlag = async (patch: { enabled?: boolean; onlineStoreId?: string }) => {
    const body = { enabled: patch.enabled ?? enabled, onlineStoreId: patch.onlineStoreId ?? onlineStoreId };
    const res = await apiFetch('/api/retailops/online-reserve/flag', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setEnabled(!!d.enabled); setOnlineStoreId(d.onlineStoreId || ''); toast.success('Configuração salva.'); }
    else toast.error(d.error || 'Falha ao alterar.');
  };
  const toggle = () => saveFlag({ enabled: !enabled });
  const saveDefaultSeller = async (userId: string) => {
    setDefaultSeller(userId);
    const res = await apiFetch('/api/retailops/online-reserve/default-seller', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: userId || null }) });
    if (res.ok) toast.success('Vendedor padrão salvo.'); else toast.error('Falha ao salvar.');
  };
  const confirm = async (row: any) => {
    const res = await apiFetch('/api/retailops/online-reserve/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast.success('Baixa confirmada — lançada no PDV.'); setPending(Array.isArray(d.pending) ? d.pending : pending.filter(p => p.id !== row.id)); load(); }
    else toast.error(d.error || 'Falha ao confirmar.');
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <p className="text-sm text-zinc-400 max-w-2xl">A loja virtual vende de uma reserva por loja (sem vender o que não tem). Cada venda online gera uma <b>baixa a lançar no PDV</b> — confirme aqui depois de lançar, para o estoque não descontar duas vezes.</p>
        <button onClick={toggle} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>
          <span className={`inline-block w-2 h-2 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-zinc-600'}`} /> {enabled ? 'ligada' : 'desligada'}
        </button>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
        <label className="text-xs text-zinc-400">Filial da loja virtual (de qual loja o estoque online sai):</label>
        <select value={onlineStoreId} onChange={e => saveFlag({ onlineStoreId: e.target.value })} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          <option value="">— não aplicar reserva no checkout —</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>)}
        </select>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
        <label className="text-xs text-zinc-400" title="Quando o cliente compra pelo link mas a conversa não tem atendente dono, a comissão vai para este vendedor. Em branco = venda 100% IA fica sem comissão.">Vendedor padrão da loja online (vendas 100% IA):</label>
        <select value={defaultSeller} onChange={e => saveDefaultSeller(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          <option value="">— sem comissão (a IA vendeu) —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
        </select>
      </div>

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Baixas pendentes no PDV ({pending.length})</h3>
      {pending.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">Nenhuma baixa pendente. Vendas online aparecem aqui para você lançar no PDV.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Loja</th>
              <th className="px-3 py-2 text-left font-medium">Produto</th>
              <th className="px-3 py-2 text-right font-medium">Qtd</th>
              <th className="px-3 py-2 text-left font-medium">Pedido</th>
              <th className="px-3 py-2 text-right font-medium">Ação</th>
            </tr></thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id} className="border-t border-zinc-800/60">
                  <td className="px-3 py-2 text-zinc-300">{p.store_name || p.store_id}</td>
                  <td className="px-3 py-2 text-zinc-200">{p.product_name || p.product_service_id}</td>
                  <td className="px-3 py-2 text-right text-zinc-200">{p.qty}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-zinc-500">{String(p.order_id).slice(0, 8)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => confirm(p)} className="inline-flex items-center gap-1 rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10"><Check className="w-3 h-3" /> Lancei no PDV</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-6 mb-2">Reserva e-commerce por loja ({reserves.length})</h3>
      <p className="text-[12px] text-zinc-500 mb-2">Defina quanto de cada produto a loja virtual pode vender por loja. É deste número (menos as vendas ainda não lançadas no PDV) que sai o estoque online.</p>

      <div className="mb-3 flex items-end gap-2 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <label className="text-[11px] text-zinc-400 flex flex-col gap-1">Loja
          <select value={fStore} onChange={e => setFStore(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 min-w-[140px]">
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400 flex flex-col gap-1">Produto
          <select value={fProduct} onChange={e => setFProduct(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 min-w-[200px]">
            <option value="">— escolher —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400 flex flex-col gap-1">Reservar
          <input type="number" min={0} value={fQty} onChange={e => setFQty(e.target.value)} placeholder="0" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 w-24" />
        </label>
        <button onClick={saveReserve} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><Plus className="w-4 h-4" /> Salvar reserva</button>
      </div>

      {reserves.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-[12px] text-zinc-600">Nenhuma reserva definida ainda. Use o formulário acima para liberar produtos na loja virtual.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Loja</th>
              <th className="px-3 py-2 text-left font-medium">Produto</th>
              <th className="px-3 py-2 text-right font-medium">Reservado</th>
              <th className="px-3 py-2 text-right font-medium">Disponível online</th>
              <th className="px-3 py-2 text-right font-medium"></th>
            </tr></thead>
            <tbody>
              {reserves.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800/60">
                  <td className="px-3 py-2 text-zinc-300">{r.store_name || String(r.store_id).slice(0, 8)}</td>
                  <td className="px-3 py-2 text-zinc-200">{r.product_name || String(r.product_service_id).slice(0, 8)}</td>
                  <td className="px-3 py-2 text-right text-zinc-200">{r.qty_reserved}</td>
                  <td className={`px-3 py-2 text-right ${Number(r.available) <= 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{r.available}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => removeReserve(r)} title="Remover reserva" className="inline-flex items-center rounded border border-red-500/30 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"><Trash2 className="w-3 h-3" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Fechamento diário ------------------------------------------------------
function ClosingsTab() {
  const [date, setDate] = useState(todayStr());
  const [stores, setStores] = useState<any[]>([]);
  const [closings, setClosings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [informing, setInforming] = useState<any | null>(null);
  const [storeModal, setStoreModal] = useState<null | { store: any | null }>(null);
  const [bridge, setBridge] = useState<boolean | null>(null);

  const toggleBridge = async () => {
    const next = !bridge;
    const res = await apiFetch('/api/retailops/revenue-bridge', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setBridge(!!d.enabled); toast.success(d.enabled ? 'Faturamento das lojas agora conta no Diretor/Caixa.' : 'Ponte de faturamento desligada.'); }
    else toast.error(d.error || 'Falha ao alterar a ponte de faturamento.');
  };

  const toggleActive = async (s: any) => {
    const res = await apiFetch(`/api/retailops/stores/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !s.active }) });
    if (res.ok) { toast.success(s.active ? 'Loja desativada.' : 'Loja reativada.'); load(); }
    else toast.error('Falha ao atualizar a loja.');
  };

  const load = async () => {
    setLoading(true);
    try {
      const [st, cl, br] = await Promise.all([
        apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({})),
        apiFetch(`/api/retailops/closings?date=${date}`).then(r => r.json()).catch(() => ({})),
        apiFetch('/api/retailops/revenue-bridge').then(r => r.json()).catch(() => ({})),
      ]);
      setStores(Array.isArray(st?.stores) ? st.stores : (Array.isArray(st) ? st : []));
      setClosings(Array.isArray(cl?.closings) ? cl.closings : (Array.isArray(cl) ? cl : []));
      setBridge(!!br?.enabled);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const byStore = useMemo(() => { const m: Record<string, any> = {}; for (const c of closings) m[c.store_id] = c; return m; }, [closings]);

  const openInform = async (store: any) => {
    // Garante o fechamento do dia (getOrCreate) e abre o formulário.
    const res = await apiFetch('/api/retailops/closings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: store.id, closingDate: date }) });
    const c = await res.json().catch(() => ({}));
    if (res.ok) setInforming({ ...c, store_name: store.name });
    else toast.error(c.error || 'Não foi possível abrir o fechamento.');
  };
  const setStatus = async (c: any, action: 'approve' | 'reject') => {
    const res = await apiFetch(`/api/retailops/closings/${c.id}/${action}`, { method: 'POST' });
    if (res.ok) { toast.success(action === 'approve' ? 'Fechamento aprovado.' : 'Fechamento rejeitado.'); load(); }
    else toast.error('Falha ao atualizar o fechamento.');
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <label className="text-xs text-zinc-400">Data
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        </label>
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        <button
          onClick={async () => {
            const res = await apiFetch('/api/retailops/quotas/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, apply: true }) });
            const d = await res.json().catch(() => ({}));
            if (res.ok) { toast.success(d.suggestions?.length ? `Cotas sugeridas pelo PDV aplicadas a ${d.suggestions.length} loja(s).` : 'Sem histórico do PDV suficiente para sugerir cotas ainda.'); load(); }
            else toast.error(d.error || 'Falha ao sugerir cotas.');
          }}
          title="Calcula a cota de cada loja pela média do MESMO dia da semana nas últimas 8 semanas (vendas reais do PDV via Alterdata) e aplica na data selecionada."
          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20"
        >
          Sugerir cotas (PDV)
        </button>
        {bridge !== null && (
          <button
            onClick={toggleBridge}
            title={bridge
              ? 'Ligado: os fechamentos aprovados/conciliados contam como faturamento no Diretor IA / Caixa / DRE. Clique para desligar.'
              : 'Desligado: o faturamento das lojas fica só na Operação da Rede. Clique para o Diretor IA / Caixa enxergarem a receita.'}
            className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${bridge ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}
          >
            <span className={`inline-block w-2 h-2 rounded-full ${bridge ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            Faturamento no Diretor {bridge ? 'ligado' : 'desligado'}
          </button>
        )}
        <button onClick={() => setStoreModal({ store: null })} className={`inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 ${bridge === null ? 'ml-auto' : ''}`}><Plus className="w-4 h-4" /> Nova loja</button>
      </div>

      {stores.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center">
          <p className="text-sm text-zinc-500">Nenhuma loja cadastrada na rede ainda.</p>
          <p className="mt-1 text-[12px] text-zinc-600">Cadastre as lojas (filiais) para registrar o fechamento diário, apurar comissão e conferir divergências.</p>
          <button onClick={() => setStoreModal({ store: null })} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><Plus className="w-4 h-4" /> Cadastrar primeira loja</button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Loja</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Cota</th>
                <th className="px-3 py-2 text-right font-medium">Informado</th>
                <th className="px-3 py-2 text-right font-medium">Desvio</th>
                <th className="px-3 py-2 text-right font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => {
                const c = byStore[s.id];
                const variance = Number(c?.variance_amount || 0);
                return (
                  <tr key={s.id} className={`border-t border-zinc-800/70 ${!s.active ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2 text-zinc-200">
                      <div className="flex items-center gap-2">
                        <span>{s.name}{s.code ? <span className="text-zinc-500"> · {s.code}</span> : null}</span>
                        {!s.active && <span className="text-[10px] rounded-full border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-zinc-400">inativa</span>}
                        <button onClick={() => setStoreModal({ store: s })} title="Editar loja" className="text-[11px] text-zinc-500 hover:text-zinc-300">editar</button>
                        <button onClick={() => toggleActive(s)} title={s.active ? 'Desativar loja' : 'Reativar loja'} className="text-[11px] text-zinc-500 hover:text-zinc-300">{s.active ? 'desativar' : 'reativar'}</button>
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Excluir a loja "${s.name}"?\n\nSe existir OUTRA loja com o mesmo código (${s.code || 'sem código'}), todo o histórico (estoque, fechamentos, cotas) será UNIFICADO nela antes de excluir — nada se perde. Sem outra loja de mesmo código, só é possível excluir loja sem histórico.`)) return;
                            const res = await apiFetch(`/api/retailops/stores/${s.id}`, { method: 'DELETE' });
                            const d = await res.json().catch(() => ({}));
                            if (res.ok) { toast.success(d.mergedIntoName ? `Loja excluída — histórico unificado em "${d.mergedIntoName}".` : 'Loja excluída.'); load(); }
                            else toast.error(d.error || 'Falha ao excluir a loja.');
                          }}
                          title="Excluir loja duplicada (unifica o histórico na outra loja de mesmo código)"
                          className="text-[11px] text-rose-400/80 hover:text-rose-300"
                        >excluir</button>
                      </div>
                    </td>
                    <td className="px-3 py-2">{c ? <Badge map={CLOSING_STATUS} s={c.status} /> : <span className="text-xs text-zinc-500">—</span>}</td>
                    <td className="px-3 py-2 text-right text-zinc-400">{c ? brl(c.quota_amount) : '—'}</td>
                    <td className="px-3 py-2 text-right text-zinc-200">{c?.informed_total != null ? brl(c.informed_total) : '—'}</td>
                    <td className={`px-3 py-2 text-right ${variance < 0 ? 'text-red-300' : variance > 0 ? 'text-emerald-300' : 'text-zinc-500'}`}>{c?.informed_total != null ? brl(variance) : '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => openInform(s)} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800">{c && c.informed_total != null ? 'Editar' : 'Informar'}</button>
                        {c && ['received', 'extracted', 'needs_review'].includes(c.status) && (
                          <>
                            <button onClick={() => setStatus(c, 'approve')} title="Aprovar" className="rounded bg-emerald-600/90 px-1.5 py-0.5 text-white hover:bg-emerald-500"><Check className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setStatus(c, 'reject')} title="Rejeitar" className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300 hover:bg-red-500/10"><X className="w-3.5 h-3.5" /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {informing && <InformModal closing={informing} onClose={() => setInforming(null)} onSaved={() => { setInforming(null); load(); }} />}
      {storeModal && <StoreFormModal store={storeModal.store} onClose={() => setStoreModal(null)} onSaved={() => { setStoreModal(null); load(); }} />}
    </div>
  );
}

// ---- Cadastro/edição de loja (reutilizável nas abas) ------------------------
function StoreFormModal({ store, onClose, onSaved }: { store: any | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!store;
  const [name, setName] = useState(store?.name || '');
  const [code, setCode] = useState(store?.code || '');
  const [wa, setWa] = useState(store?.whatsapp_identifier || '');
  const [address, setAddress] = useState(store?.address || '');
  const [city, setCity] = useState(store?.city || '');
  const [lat, setLat] = useState(store?.latitude != null ? String(store.latitude) : '');
  const [lng, setLng] = useState(store?.longitude != null ? String(store.longitude) : '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) { toast.error('Dê um nome à loja.'); return; }
    setSaving(true);
    try {
      const body = JSON.stringify({
        name: name.trim(), code: code.trim() || null, whatsappIdentifier: wa.replace(/\D/g, '') || null,
        address: address.trim() || null, city: city.trim() || null,
        latitude: lat.trim() === '' ? null : Number(lat.replace(',', '.')),
        longitude: lng.trim() === '' ? null : Number(lng.replace(',', '.')),
      });
      const res = editing
        ? await apiFetch(`/api/retailops/stores/${store.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })
        : await apiFetch('/api/retailops/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (res.ok) { toast.success(editing ? 'Loja atualizada.' : 'Loja cadastrada.'); onSaved(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || 'Falha ao salvar a loja.'); }
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">{editing ? 'Editar loja' : 'Nova loja (filial)'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <div className="mt-4 space-y-3">
          <label className="block text-xs text-zinc-400">Nome da loja
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Loja Centro" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="block text-xs text-zinc-400">Código (opcional)
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="Ex.: 1005 (código da filial no ERP)" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            <span className="mt-1 block text-[11px] text-zinc-500">Com a integração Alterdata/ERP ligada, use aqui o <strong>mesmo código da filial do ERP</strong> (ex.: 1005, 1006) — é por ele que o estoque e o preço são casados na sincronização.</span>
          </label>
          <label className="block text-xs text-zinc-400">WhatsApp da loja (opcional)
            <input value={wa} onChange={e => setWa(e.target.value)} placeholder="Ex.: 5511987654321" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            <span className="mt-1 block text-[11px] text-zinc-500">Recebe a cobrança de pendências (fechamento, malote) e permite dar baixa respondendo.</span>
          </label>
          <label className="block text-xs text-zinc-400">Endereço (opcional)
            <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Rua, nº, bairro" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-zinc-400 col-span-1">Cidade
              <input value={city} onChange={e => setCity(e.target.value)} placeholder="Cidade" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="block text-xs text-zinc-400">Latitude
              <input value={lat} onChange={e => setLat(e.target.value)} placeholder="-22.90" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="block text-xs text-zinc-400">Longitude
              <input value={lng} onChange={e => setLng(e.target.value)} placeholder="-43.17" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
          </div>
          <span className="block text-[11px] text-zinc-500 -mt-1">As coordenadas (lat/long) permitem sugerir a transferência entre as lojas <strong>mais próximas</strong>. Pegue no Google Maps: clique com o botão direito no ponto → o primeiro item copia “lat, long”.</span>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar loja</button>
        </div>
      </div>
    </div>
  );
}

// Botão reutilizável "Nova loja" (para as abas que dependem de lojas cadastradas).
function NewStoreButton({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"><Plus className="w-3.5 h-3.5" /> Nova loja</button>
      {open && <StoreFormModal store={null} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onCreated(); }} />}
    </>
  );
}

const PAYMENT_METHODS = ['dinheiro', 'pix', 'credito', 'debito', 'voucher', 'troca', 'outros'];
function InformModal({ closing, onClose, onSaved }: { closing: any; onClose: () => void; onSaved: () => void }) {
  const initial: Record<string, string> = {};
  for (const it of closing.items || []) initial[it.payment_method] = String(it.informed_amount || '');
  const [methods, setMethods] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);
  const total = useMemo(() => PAYMENT_METHODS.reduce((a, m) => a + (Number(methods[m]) || 0), 0), [methods]);

  const save = async () => {
    setSaving(true);
    try {
      const items = PAYMENT_METHODS.filter(m => Number(methods[m]) > 0).map(m => ({ paymentMethod: m, informedAmount: Number(methods[m]) }));
      const res = await apiFetch(`/api/retailops/closings/${closing.id}/inform`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ informedTotal: total, items }) });
      if (res.ok) { toast.success('Fechamento informado.'); onSaved(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || 'Falha ao salvar.'); }
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Fechamento — {closing.store_name}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">Informe o total por forma de pagamento. Cota do dia: {brl(closing.quota_amount)}.</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {PAYMENT_METHODS.map(m => (
            <label key={m} className="text-xs text-zinc-400 capitalize">{m}
              <input inputMode="decimal" value={methods[m] || ''} onChange={e => setMethods(p => ({ ...p, [m]: e.target.value.replace(',', '.') }))}
                placeholder="0,00" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-950/60 px-3 py-2">
          <span className="text-sm text-zinc-400">Total informado</span>
          <span className="text-sm font-semibold text-zinc-100">{brl(total)}</span>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving || total <= 0} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar fechamento
          </button>
        </div>
      </div>
    </div>
  );
}


// ---- Lançamento de vendas por vendedor (manual / foto+IA — Cenário B) -------
// A loja anota as vendas de cada vendedor no papel; o gestor digita aqui OU
// envia a foto da folha p/ a IA ler e pré-preencher, conferindo antes de salvar.
type SellerRow = { sellerName: string; valor: string; pecas: string };
function SellerSalesModal({ defaultDate, onClose, onSaved }: { defaultDate: string; onClose: () => void; onSaved: () => void }) {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [date, setDate] = useState(defaultDate || todayStr());
  const [rows, setRows] = useState<SellerRow[]>([{ sellerName: '', valor: '', pecas: '' }]);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanSource, setScanSource] = useState<'manual' | 'photo'>('manual');
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => { apiFetch('/api/retailops/stores').then(r => r.json()).then(d => setStores(Array.isArray(d?.stores) ? d.stores : [])).catch(() => {}); }, []);

  const total = useMemo(() => rows.reduce((a, r) => a + (Number(r.valor) || 0), 0), [rows]);
  const totalPecas = useMemo(() => rows.reduce((a, r) => a + (Number(r.pecas) || 0), 0), [rows]);
  const setRow = (i: number, patch: Partial<SellerRow>) => setRows(p => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addRow = () => setRows(p => [...p, { sellerName: '', valor: '', pecas: '' }]);
  const removeRow = (i: number) => setRows(p => p.length > 1 ? p.filter((_, idx) => idx !== i) : p);

  const onScan = async (file: File) => {
    setScanning(true); setScanNote(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await apiFetch('/api/retailops/seller-sales/scan', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao ler a folha.'); return; }
      const entries = Array.isArray(d.entries) ? d.entries : [];
      if (!entries.length) { toast.error('A IA não encontrou vendedores legíveis. Tente uma foto mais nítida ou digite manualmente.'); return; }
      setRows(entries.map((e: any) => ({ sellerName: String(e.sellerName || ''), valor: e.valor ? String(e.valor) : '', pecas: e.pecas ? String(e.pecas) : '' })));
      setScanSource('photo'); setImageUrl(d.imageUrl || null);
      setScanNote(d.needsReview
        ? `Leitura com baixa confiança (${d.confidence}%). CONFIRA cada linha antes de salvar.`
        : `IA leu ${entries.length} vendedor(es) (confiança ${d.confidence}%). Confira e salve.`);
    } catch { toast.error('Falha ao enviar a imagem.'); }
    finally { setScanning(false); }
  };

  const save = async () => {
    const entries = rows
      .map(r => ({ sellerName: r.sellerName.trim(), valor: Number(r.valor) || 0, pecas: Number(r.pecas) || 0 }))
      .filter(e => e.sellerName && (e.valor > 0 || e.pecas > 0));
    if (!entries.length) { toast.error('Informe ao menos um vendedor com nome e valor (ou peças).'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/retailops/seller-sales', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: storeId || null, saleDate: date, entries, source: scanSource, imageUrl }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`${d.created?.length || entries.length} lançamento(s) salvo(s).`); onSaved(); }
      else toast.error(d.error || 'Falha ao salvar.');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Vendas por vendedor</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">Digite as vendas de cada vendedor ou envie a foto da folha para a IA ler. Confira antes de salvar.</p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-xs text-zinc-400">Data da folha
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="text-xs text-zinc-400">Loja (opcional)
            <select value={storeId} onChange={e => setStoreId(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
              <option value="">— todas / não informar —</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-3">
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/20 cursor-pointer">
            {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Enviar foto da folha (IA)
            <input type="file" accept="image/*" className="hidden" disabled={scanning} onChange={e => { const f = e.target.files?.[0]; if (f) onScan(f); e.currentTarget.value = ''; }} />
          </label>
          {scanNote && <p className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-300/90"><Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {scanNote}</p>}
        </div>

        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-1 text-[11px] uppercase tracking-wider text-zinc-500">
            <span>Vendedor</span><span className="w-24 text-right">Valor (R$)</span><span className="w-16 text-right">Peças</span><span className="w-6"></span>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
              <input value={r.sellerName} onChange={e => setRow(i, { sellerName: e.target.value })} placeholder="Nome do vendedor" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
              <input inputMode="decimal" value={r.valor} onChange={e => setRow(i, { valor: e.target.value.replace(',', '.') })} placeholder="0,00" className="w-24 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-right text-zinc-100" />
              <input inputMode="numeric" value={r.pecas} onChange={e => setRow(i, { pecas: e.target.value.replace(/[^0-9]/g, '') })} placeholder="0" className="w-16 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-right text-zinc-100" />
              <button onClick={() => removeRow(i)} title="Remover linha" className="text-zinc-600 hover:text-red-300"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button onClick={addRow} className="inline-flex items-center gap-1.5 text-xs text-indigo-300 hover:text-indigo-200"><Plus className="w-3.5 h-3.5" /> Adicionar vendedor</button>
        </div>

        <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-950/60 px-3 py-2 text-sm">
          <span className="text-zinc-400">Total</span>
          <span className="font-semibold text-zinc-100">{brl(total)} · {totalPecas} peça(s)</span>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving || (total <= 0 && totalPecas <= 0)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar
          </button>
        </div>
      </div>
    </div>
  );
}


// ---- Edição de um lançamento de venda por vendedor já feito ------------------
function EditSellerSaleModal({ sale, onClose, onSaved }: { sale: any; onClose: () => void; onSaved: () => void }) {
  const [stores, setStores] = useState<any[]>([]);
  const [sellerName, setSellerName] = useState(String(sale.seller_name || ''));
  const [date, setDate] = useState(String(sale.sale_date || todayStr()).slice(0, 10));
  const [storeId, setStoreId] = useState(String(sale.store_id || ''));
  const [valor, setValor] = useState(sale.valor != null ? String(sale.valor) : '');
  const [pecas, setPecas] = useState(sale.pecas != null ? String(sale.pecas) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { apiFetch('/api/retailops/stores').then(r => r.json()).then(d => setStores(Array.isArray(d?.stores) ? d.stores : [])).catch(() => {}); }, []);

  const save = async () => {
    const name = sellerName.trim();
    const v = Number(valor) || 0, p = Number(pecas) || 0;
    if (!name) { toast.error('Informe o nome do vendedor.'); return; }
    if (v <= 0 && p <= 0) { toast.error('Informe um valor ou a quantidade de peças.'); return; }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/retailops/seller-sales/${sale.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerName: name, saleDate: date, storeId: storeId || null, valor: v, pecas: p }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Lançamento atualizado.'); onSaved(); }
      else toast.error(d.error || 'Falha ao salvar.');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Editar lançamento</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">Origem: {sale.source === 'photo' ? 'foto (IA)' : 'manual'}. As alterações somam na comissão por vendedor.</p>
        <div className="mt-3 space-y-3">
          <label className="block text-xs text-zinc-400">Vendedor
            <input value={sellerName} onChange={e => setSellerName(e.target.value)} placeholder="Nome do vendedor" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-400">Data da folha
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400">Loja (opcional)
              <select value={storeId} onChange={e => setStoreId(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
                <option value="">— não informar —</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-400">Valor (R$)
              <input inputMode="decimal" value={valor} onChange={e => setValor(e.target.value.replace(',', '.'))} placeholder="0,00" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400">Peças
              <input inputMode="numeric" value={pecas} onChange={e => setPecas(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar</button>
        </div>
      </div>
    </div>
  );
}


// ---- Reposição / grade furada (estoque por loja do ERP) ---------------------
// Loja que TRABALHA o produto mas está zerada num tamanho que outra loja tem
// sobrando → sugestão de transferência entre filiais.
function ReplenishmentTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeFilter, setStoreFilter] = useState('');
  const [xfer, setXfer] = useState<any | null>(null);
  const load = () => {
    setLoading(true);
    apiFetch('/api/retailops/replenishment')
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d?.suggestions) ? d.suggestions : []))
      .catch(() => toast.error('Falha ao carregar as sugestões de reposição.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  const stores = useMemo(() => Array.from(new Set(rows.map(r => r.needy_store))).sort(), [rows]);
  const shown = storeFilter ? rows.filter(r => r.needy_store === storeFilter) : rows;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
          <option value="">Todas as lojas</option>
          {stores.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        <span className="text-xs text-zinc-500">{shown.length} sugestão(ões) — loja com o produto na grade, porém zerada num tamanho que outra filial tem sobrando (≥2).</span>
      </div>
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhuma grade furada encontrada — os tamanhos disponíveis estão bem distribuídos entre as lojas. 🎉</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Produto</th>
                <th className="px-3 py-2 text-left font-medium">Variação</th>
                <th className="px-3 py-2 text-left font-medium">Falta em</th>
                <th className="px-3 py-2 text-left font-medium">Sobra em</th>
                <th className="px-3 py-2 text-right font-medium">Qtd disponível</th>
                <th className="px-3 py-2 text-right font-medium">Distância</th>
                <th className="px-3 py-2 text-right font-medium">Ação</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{r.product_name}</td>
                  <td className="px-3 py-2 text-zinc-300">{[r.size, r.color].filter(Boolean).join(' / ') || r.variant_name}</td>
                  <td className="px-3 py-2 text-rose-300">{r.needy_store}</td>
                  <td className="px-3 py-2 text-emerald-300">{r.donor_store}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{r.donor_qty}</td>
                  <td className="px-3 py-2 text-right text-zinc-400">{r.distance_km != null ? `${r.distance_km} km` : '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setXfer(r)} disabled={!r.donor_store_id || !r.needy_store_id}
                      className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-600/20 text-indigo-200 px-2.5 py-1 text-xs hover:bg-indigo-600/30 disabled:opacity-40">
                      <ArrowLeftRight className="w-3.5 h-3.5" /> Transferir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {xfer && <TransferModal row={xfer} onClose={() => setXfer(null)} onDone={() => { setXfer(null); load(); }} />}
    </div>
  );
}

// Modal de despacho: confirma a quantidade a transferir da loja que tem sobra
// para a que está com a grade furada. Cria a transferência já EM TRÂNSITO (baixa
// na origem); a entrada no destino acontece na aba Transferências, na recepção.
function TransferModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const max = Math.max(1, Number(row.donor_qty) || 1);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const variant = [row.size, row.color].filter(Boolean).join(' / ') || row.variant_name;
  const submit = async () => {
    const q = Math.min(max, Math.max(1, Math.trunc(Number(qty) || 0)));
    setBusy(true);
    try {
      const res = await apiFetch('/api/retailops/transfers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originStoreId: row.donor_store_id, destStoreId: row.needy_store_id, items: [{ productId: row.product_service_id, variantId: row.variant_id, quantity: q }] }),
      });
      const d = await res.json();
      if (res.ok) { toast.success('Transferência despachada — baixa lançada na origem.'); onDone(); }
      else toast.error(d?.error || 'Não foi possível criar a transferência.');
    } catch { toast.error('Falha ao criar a transferência.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-4" onClick={e => e.stopPropagation()}>
        <div className="text-sm text-zinc-100 font-medium">{row.product_name}</div>
        <div className="text-xs text-zinc-400 mt-0.5">{variant}</div>
        <div className="mt-3 text-sm text-zinc-300 flex items-center gap-2">
          <span className="text-emerald-300">{row.donor_store}</span>
          <ArrowLeftRight className="w-4 h-4 text-zinc-500" />
          <span className="text-rose-300">{row.needy_store}</span>
          {row.distance_km != null && <span className="text-[11px] text-zinc-500">· {row.distance_km} km</span>}
        </div>
        {row.best_time && <div className="mt-2 text-[11px] text-amber-300/90">🕐 Melhor horário para separar: {row.best_time}</div>}
        <label className="text-xs text-zinc-500 mt-3 block">Quantidade a transferir (máx. {max})</label>
        <input autoFocus type="number" min={1} max={max} value={qty}
          onChange={e => setQty(Math.min(max, Math.max(1, Math.trunc(Number(e.target.value) || 1))))}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-lg text-zinc-100 mt-1" />
        <div className="grid grid-cols-2 gap-2 mt-4">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 text-zinc-300 text-sm py-2 hover:bg-zinc-900">Cancelar</button>
          <button onClick={submit} disabled={busy} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm py-2 disabled:opacity-40">Despachar</button>
        </div>
      </div>
    </div>
  );
}

// Aba Transferências: lista as transferências (em trânsito no topo) e permite
// RECEBER (dá entrada no destino) ou CANCELAR (estorna a origem) as em trânsito.
function TransfersTab() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const load = () => {
    setLoading(true);
    apiFetch('/api/retailops/transfers').then(r => r.json())
      .then(d => setList(Array.isArray(d?.transfers) ? d.transfers : []))
      .catch(() => toast.error('Falha ao carregar as transferências.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  const act = async (id: string, action: 'receive' | 'cancel') => {
    if (action === 'cancel' && !window.confirm('Cancelar a transferência e estornar a baixa na origem?')) return;
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/retailops/transfers/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json();
      if (res.ok) { toast.success(action === 'receive' ? 'Recebido — entrada lançada no destino.' : 'Transferência cancelada.'); load(); }
      else toast.error(d?.error || 'Não foi possível concluir a ação.');
    } catch { toast.error('Falha na ação.'); }
    finally { setBusyId(null); }
  };
  const badge = (s: string) => s === 'in_transit'
    ? <span className="inline-flex items-center gap-1 text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5 text-[11px]"><Truck className="w-3 h-3" /> Em trânsito</span>
    : s === 'received'
    ? <span className="inline-flex items-center gap-1 text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2 py-0.5 text-[11px]"><PackageCheck className="w-3 h-3" /> Recebida</span>
    : <span className="inline-flex items-center gap-1 text-zinc-400 bg-zinc-500/10 border border-zinc-500/30 rounded-full px-2 py-0.5 text-[11px]"><X className="w-3 h-3" /> Cancelada</span>;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        <span className="text-xs text-zinc-500">Peças em trânsito entre lojas: baixa lançada na origem; a entrada no destino sai na recepção.</span>
      </div>
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhuma transferência ainda. Crie uma na aba <span className="text-zinc-300">Reposição (grade)</span>.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Origem → Destino</th>
                <th className="px-3 py-2 text-right font-medium">Itens</th>
                <th className="px-3 py-2 text-right font-medium">Peças</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Ação</th>
              </tr>
            </thead>
            <tbody>
              {list.map(t => (
                <tr key={t.id} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200"><span className="text-emerald-300">{t.origin_store}</span> <span className="text-zinc-500">→</span> <span className="text-rose-300">{t.dest_store}</span></td>
                  <td className="px-3 py-2 text-right text-zinc-300">{t.item_count}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{t.total_sent}</td>
                  <td className="px-3 py-2">{badge(t.status)}</td>
                  <td className="px-3 py-2 text-right">
                    {t.status === 'in_transit' ? (
                      <div className="inline-flex gap-1.5">
                        <button onClick={() => act(t.id, 'receive')} disabled={busyId === t.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-600/20 text-emerald-200 px-2.5 py-1 text-xs hover:bg-emerald-600/30 disabled:opacity-40"><PackageCheck className="w-3.5 h-3.5" /> Receber</button>
                        <button onClick={() => act(t.id, 'cancel')} disabled={busyId === t.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 text-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40"><X className="w-3.5 h-3.5" /> Cancelar</button>
                      </div>
                    ) : <span className="text-zinc-600 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}




// ---- Clientes do PDV (Fase 3, opt-in) ---------------------------------------
function PdvCustomersTab() {
  const [q, setQ] = useState('');
  const [bMonth, setBMonth] = useState('');
  const [data, setData] = useState<{ total: number; customers: any[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    apiFetch(`/api/retailops/pdv-customers?q=${encodeURIComponent(q)}&birthdayMonth=${bMonth}&limit=100`)
      .then(r => r.json())
      .then(d => setData(d && !d.error ? d : null))
      .catch(() => toast.error('Falha ao carregar clientes.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [q, bMonth]);
  const MESES = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  return (
    <div>
      <p className="text-[12px] text-zinc-500 mb-3">Base de clientes do PDV (nome, CPF, celular, e-mail, aniversário) — separada dos contatos do WhatsApp, para campanhas e relacionamento. Requer o opt-in "Importar clientes do PDV" em Integrações → Alterdata.</p>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nome, CPF ou celular…" className="w-full max-w-sm bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100" />
        <select value={bMonth} onChange={e => setBMonth(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-sm text-zinc-100" title="Aniversariantes do mês">
          {MESES.map((m, i) => <option key={i} value={i === 0 ? '' : String(i).padStart(2, '0')}>{i === 0 ? 'Aniversário: todos os meses' : `Aniversário: ${m}`}</option>)}
        </select>
        {data && <span className="text-xs text-zinc-500">{data.total} cliente(s)</span>}
      </div>
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : !data || data.customers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum cliente do PDV {q || bMonth ? 'para este filtro' : 'importado ainda'}. Ligue "Importar clientes do PDV" em Integrações → Alterdata e sincronize.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Nome</th>
              <th className="px-3 py-2 text-left font-medium">Celular</th>
              <th className="px-3 py-2 text-left font-medium">E-mail</th>
              <th className="px-3 py-2 text-left font-medium">Aniversário</th>
              <th className="px-3 py-2 text-left font-medium">Última compra</th>
            </tr></thead>
            <tbody>
              {data.customers.map((c: any) => (
                <tr key={c.codigo_n} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{c.nome || '—'}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.celular || '—'}</td>
                  <td className="px-3 py-2 text-zinc-400">{c.email || '—'}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.nascimento ? c.nascimento.slice(5).split('-').reverse().join('/') : '—'}</td>
                  <td className="px-3 py-2 text-zinc-400">{c.ultima_compra ? c.ultima_compra.split('-').reverse().join('/') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Recebíveis de cartão (parcelasCartao do PDV) ---------------------------
function CardReceivablesTab() {
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(todayStr().slice(0, 8) + '28');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    apiFetch(`/api/retailops/pdv-card-receivables?start=${start}&end=${end}`)
      .then(r => r.json())
      .then(d => setData(d && !d.error ? d : null))
      .catch(() => toast.error('Falha ao carregar os recebíveis.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const t = data?.totals;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">Vencimento de</span>
        <input type="date" value={start} onChange={e => setStart(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <span className="text-xs text-zinc-500">até</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><RefreshCw className="w-4 h-4" /> Gerar</button>
      </div>
      {t && (
        <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"><p className="text-[11px] uppercase tracking-wider text-zinc-500">Parcelas</p><p className="text-lg font-semibold text-zinc-100">{t.parcelas}</p></div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"><p className="text-[11px] uppercase tracking-wider text-zinc-500">Bruto</p><p className="text-lg font-semibold text-zinc-100">{brl(t.bruto)}</p></div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"><p className="text-[11px] uppercase tracking-wider text-zinc-500">Taxa retida</p><p className="text-lg font-semibold text-rose-300">{brl(t.taxa)}</p></div>
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3"><p className="text-[11px] uppercase tracking-wider text-emerald-400/80">Líquido a receber</p><p className="text-lg font-semibold text-emerald-300">{brl(t.liquido)}</p></div>
        </div>
      )}
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : !data || data.byDay.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum recebível de cartão no período. As parcelas entram pela sincronização das vendas do PDV.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Vencimento</th>
              <th className="px-3 py-2 text-right font-medium">Parcelas</th>
              <th className="px-3 py-2 text-right font-medium">Bruto</th>
              <th className="px-3 py-2 text-right font-medium">Líquido</th>
            </tr></thead>
            <tbody>
              {data.byDay.map((r: any) => (
                <tr key={r.vencimento} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{r.vencimento?.split('-').reverse().join('/')}</td>
                  <td className="px-3 py-2 text-right text-zinc-300">{r.parcelas}</td>
                  <td className="px-3 py-2 text-right text-zinc-300">{brl(r.bruto)}</td>
                  <td className="px-3 py-2 text-right text-emerald-300">{brl(r.liquido)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Mais vendidos por produto (itens das vendas do PDV) --------------------
function TopProductsTab() {
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(todayStr());
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    apiFetch(`/api/retailops/pdv-top-products?start=${start}&end=${end}`)
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d?.products) ? d.products : []))
      .catch(() => toast.error('Falha ao carregar os mais vendidos.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  const maxPecas = rows.reduce((m, r) => Math.max(m, Number(r.pecas || 0)), 0) || 1;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">De</span>
        <input type="date" value={start} onChange={e => setStart(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <span className="text-xs text-zinc-500">até</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><RefreshCw className="w-4 h-4" /> Gerar</button>
        <span className="text-xs text-zinc-500">Ranking pelos itens vendidos no PDV (peças e faturamento).</span>
      </div>
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum item de venda do PDV no período ainda. As vendas entram pela sincronização (Integrações → Alterdata) — o histórico completa aos poucos.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Produto</th>
              <th className="px-3 py-2 text-right font-medium">Peças</th>
              <th className="px-3 py-2 text-right font-medium">Faturamento</th>
              <th className="px-3 py-2 text-left font-medium w-40">Volume</th>
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.produto} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-500">{i + 1}</td>
                  <td className="px-3 py-2 text-zinc-200">{r.nome || <span className="font-mono text-zinc-400">{r.produto}</span>}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{r.pecas}</td>
                  <td className="px-3 py-2 text-right text-emerald-300">{brl(r.valor)}</td>
                  <td className="px-3 py-2"><div className="h-2 rounded-full bg-indigo-500/70" style={{ width: `${Math.max(4, Math.round(Number(r.pecas) / maxPecas * 100))}%` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Comissão ---------------------------------------------------------------
function CommissionTab() {
  const [runs, setRuns] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [ruleForm, setRuleForm] = useState<null | { name: string; scope: string; calculationType: string; percent: string; amount: string; bonus: string; quota: string }>(null);
  const [savingRule, setSavingRule] = useState(false);
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(todayStr());
  const [report, setReport] = useState<any | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const [pdvSellers, setPdvSellers] = useState<any[]>([]);
  const [pdvPct, setPdvPct] = useState<number | null>(null);
  const [sellerSales, setSellerSales] = useState<any[]>([]);
  const [sellerSalesModal, setSellerSalesModal] = useState(false);
  const [editSale, setEditSale] = useState<any | null>(null);
  // Dá NOME à matrícula do ERP (mapeamento retail_sellers) — com regra "por
  // vendedor" ativa, a apuração oficial passa a usar esse nome.
  const nomearVendedor = async (v: any) => {
    const name = window.prompt(`Nome do vendedor da matrícula ${v.vendedor}:`, v.seller_name || '');
    if (name == null) return;
    const res = await apiFetch(`/api/retailops/sellers/${encodeURIComponent(v.vendedor)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    if (res.ok) { toast.success('Vendedor atualizado.'); loadReport(); } else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao salvar o vendedor.'); }
  };
  const loadReport = async () => {
    setLoadingReport(true);
    try {
      const d = await apiFetch(`/api/retailops/commission/report?start=${start}&end=${end}`).then(r => r.json()).catch(() => null);
      if (d && !d.error) setReport(d); else toast.error(d?.error || 'Falha ao gerar o relatório.');
      // Vendas por VENDEDOR direto do PDV (Fase 4 — VendaMalote sincronizado).
      const pv = await apiFetch(`/api/retailops/pdv-sellers?start=${start}&end=${end}`).then(r => r.json()).catch(() => null);
      setPdvSellers(Array.isArray(pv?.sellers) ? pv.sellers : []);
      setPdvPct(pv?.commissionPercent ?? null);
      await loadSellerSales();
    } finally { setLoadingReport(false); }
  };
  const loadSellerSales = async () => {
    const d = await apiFetch(`/api/retailops/seller-sales?start=${start}&end=${end}`).then(r => r.json()).catch(() => null);
    setSellerSales(Array.isArray(d?.entries) ? d.entries : []);
  };
  const deleteSellerSale = async (row: any) => {
    if (!window.confirm(`Remover o lançamento de ${row.seller_name} (${brl(row.valor)})?`)) return;
    const res = await apiFetch(`/api/retailops/seller-sales/${row.id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Lançamento removido.'); loadReport(); } else toast.error('Falha ao remover.');
  };
  const downloadReportCsv = () => {
    if (!report) return;
    const erp = report.hasErpSellerSales;
    const head = ['Dimensão', 'Nome', 'Vendas', 'Vendas (qtd)', 'Comissão'];
    if (erp) head.push('Comissão ERP');
    const rows: string[] = [head.join(';')];
    for (const s of report.bySeller || []) rows.push(['Vendedor', s.sellerName, s.sales, s.orders, s.commission, ...(erp ? [s.erpCommission ?? ''] : [])].join(';'));
    for (const p of report.byProduct || []) rows.push(['Produto', p.productName, p.sales, p.orders, p.commission, ...(erp ? [''] : [])].join(';'));
    for (const st of report.byStore || []) rows.push(['Loja', st.storeName, st.sales, '', st.commission, ...(erp ? [''] : [])].join(';'));
    rows.push(['Total', '', '', '', report.totals?.totalCommission ?? 0, ...(erp ? [report.totals?.sellerErpCommission ?? ''] : [])].join(';'));
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `comissao_${start}_a_${end}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [r, ru] = await Promise.all([
        apiFetch('/api/retailops/commission/runs').then(x => x.json()).catch(() => ({})),
        apiFetch('/api/retailops/commission/rules').then(x => x.json()).catch(() => ({})),
      ]);
      setRuns(Array.isArray(r?.runs) ? r.runs : (Array.isArray(r) ? r : []));
      setRules(Array.isArray(ru?.rules) ? ru.rules : (Array.isArray(ru) ? ru : []));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const createRun = async () => {
    setCreating(true);
    try {
      const res = await apiFetch('/api/retailops/commission/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ periodStart: start, periodEnd: end }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Apuração criada (prévia).'); setDetail(d); load(); }
      else toast.error(d.error || 'Falha ao apurar.');
    } finally { setCreating(false); }
  };
  const open = async (run: any) => {
    const d = await apiFetch(`/api/retailops/commission/runs/${run.id}`).then(r => r.json()).catch(() => null);
    if (d) setDetail(d);
  };
  const setStatus = async (run: any, action: 'approve' | 'reject') => {
    const res = await apiFetch(`/api/retailops/commission/runs/${run.id}/${action}`, { method: 'POST' });
    if (res.ok) { toast.success(action === 'approve' ? 'Comissão aprovada.' : 'Apuração rejeitada.'); setDetail(null); load(); }
    else toast.error('Falha ao atualizar.');
  };

  const saveRule = async () => {
    if (!ruleForm) return;
    const name = ruleForm.name.trim();
    if (!name) { toast.error('Dê um nome à regra.'); return; }
    let config: any = {};
    if (ruleForm.calculationType === 'percent_sales') config = { percent: Number(ruleForm.percent) || 0 };
    else if (ruleForm.calculationType === 'fixed') config = { amount: Number(ruleForm.amount) || 0 };
    else if (ruleForm.calculationType === 'quota_bonus') config = { bonus: Number(ruleForm.bonus) || 0, quota: Number(ruleForm.quota) || 0 };
    setSavingRule(true);
    try {
      const res = await apiFetch('/api/retailops/commission/rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scope: ruleForm.scope, period: 'monthly', calculationType: ruleForm.calculationType, config }),
      });
      if (res.ok) { toast.success('Regra de comissão criada.'); setRuleForm(null); load(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao criar regra.'); }
    } finally { setSavingRule(false); }
  };
  const toggleRule = async (r: any) => {
    const res = await apiFetch(`/api/retailops/commission/rules/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !r.active }) });
    if (res.ok) load(); else toast.error('Falha ao atualizar regra.');
  };
  const ruleSummary = (r: any) => {
    let c: any = {}; try { c = JSON.parse(r.config_json || '{}'); } catch { /* noop */ }
    if (r.calculation_type === 'percent_sales') return `${Number(c.percent || 0)}% das vendas`;
    if (r.calculation_type === 'fixed') return `${brl(c.amount)} fixo`;
    if (r.calculation_type === 'quota_bonus') return `${brl(c.bonus)} ao bater a meta`;
    if (r.calculation_type === 'tiered') return `faixas progressivas`;
    return r.calculation_type;
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Calculator className="w-4 h-4 text-indigo-400" /> Regras de comissão</div>
          <div className="flex items-center gap-2">
            <NewStoreButton onCreated={load} />
            <button onClick={() => setRuleForm({ name: '', scope: 'store', calculationType: 'percent_sales', percent: '5', amount: '', bonus: '', quota: '' })} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20">
              <Plus className="w-3.5 h-3.5" /> Nova regra
            </button>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">É aqui que você define <strong>quanto vai pagar de comissão</strong> — o percentual sobre as vendas, um valor fixo, ou um bônus ao bater a meta. Sem regra ativa, a apuração vem zerada.</p>
        {rules.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-500">Nenhuma regra ainda. Clique em <strong>“Nova regra”</strong> para definir o percentual.</div>
        ) : (
          <div className="mt-3 space-y-1.5">
            {rules.map(r => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-zinc-100">{r.name} <span className="text-zinc-500">· {r.scope === 'global' ? 'rede toda' : r.scope === 'seller' ? 'por vendedor' : r.scope === 'product' ? 'por produto' : 'por loja'}</span></div>
                  <div className="text-[11px] text-indigo-300">{ruleSummary(r)}</div>
                </div>
                <button onClick={() => toggleRule(r)} className={`ml-3 shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${r.active ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'}`}>{r.active ? 'Ativa' : 'Inativa'}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Relatório de comissão do período (por vendedor / produto / loja) */}
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Calculator className="w-4 h-4 text-emerald-400" /> Relatório de comissão</div>
          <label className="text-[11px] text-zinc-400 ml-2">De <input type="date" value={start} onChange={e => setStart(e.target.value)} className="ml-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" /></label>
          <label className="text-[11px] text-zinc-400">até <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="ml-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" /></label>
          <button onClick={loadReport} disabled={loadingReport} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{loadingReport ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Gerar</button>
          <button onClick={() => setSellerSalesModal(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1.5 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"><Plus className="w-3.5 h-3.5" /> Lançar vendas por vendedor</button>
          {report && <button onClick={downloadReportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><Download className="w-3.5 h-3.5" /> CSV</button>}
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">Não tem o vendedor por venda no ERP? Anote as vendas de cada vendedor no papel e clique em <strong>“Lançar vendas por vendedor”</strong> — digite ou envie a foto da folha para a IA ler. Esses valores somam na comissão por vendedor.</p>

        {report && (
          <div className="mt-3 space-y-4">
            <div className="text-sm text-zinc-300">Comissão total do período: <span className="font-semibold text-emerald-300">{brl(report.totals?.totalCommission)}</span>
              <span className="text-zinc-500"> · vendedores {brl(report.totals?.sellerCommission)} · produtos {brl(report.totals?.productCommission)} · lojas {brl(report.totals?.storeCommission)}</span>
            </div>

            <ReportBlock title="Por vendedor" empty={!report.hasRules?.seller ? 'Sem regra por vendedor ativa.' : 'Nenhuma venda com vendedor no período. Lance a folha da loja em “Lançar vendas por vendedor”.'} rows={report.bySeller} cols={[['sellerName', 'Vendedor'], ['sales', 'Vendas', true], ['pecas', 'Peças'], ['orders', 'Nº vendas'], ['commission', 'Comissão', true], ...(report.hasErpSellerSales ? [['erpCommission', 'Comissão ERP', true]] : [])] as [string, string, boolean?][]} />
            {report.hasErpSellerSales && <p className="text-[11px] text-zinc-500 -mt-2">“Comissão” é a nossa apuração (pelas regras); “Comissão ERP” é a que o próprio ERP calculou — compare para conferir divergências.</p>}
            <ReportBlock title="Por produto" empty={!report.hasRules?.product ? 'Sem regra por produto ativa.' : 'Nenhuma venda por produto no período.'} rows={report.byProduct} cols={[['productName', 'Produto'], ['sales', 'Vendas', true], ['orders', 'Nº vendas'], ['commission', 'Comissão', true]]} />
            <ReportBlock title="Por loja (fechamentos)" empty={!report.hasRules?.store ? 'Sem regra por loja ativa.' : 'Sem fechamentos no período.'} rows={report.byStore} cols={[['storeName', 'Loja'], ['sales', 'Vendas', true], ['commission', 'Comissão', true]]} />

            {/* Lançamentos por vendedor do período (manual/foto — Cenário B).
                Já entram somados na tabela "Por vendedor" acima; esta lista
                permite conferir e remover cada folha lançada. */}
            {sellerSales.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Folhas de vendas lançadas (manual/foto)</p>
                <div className="overflow-x-auto rounded-xl border border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                      <th className="px-3 py-2 text-left font-medium">Data</th>
                      <th className="px-3 py-2 text-left font-medium">Vendedor</th>
                      <th className="px-3 py-2 text-left font-medium">Loja</th>
                      <th className="px-3 py-2 text-right font-medium">Valor</th>
                      <th className="px-3 py-2 text-right font-medium">Peças</th>
                      <th className="px-3 py-2 text-center font-medium">Origem</th>
                      <th className="px-3 py-2 text-right font-medium"></th>
                    </tr></thead>
                    <tbody>
                      {sellerSales.map((v: any) => (
                        <tr key={v.id} className="border-t border-zinc-800/70">
                          <td className="px-3 py-2 text-zinc-300">{v.sale_date}</td>
                          <td className="px-3 py-2 text-zinc-100">{v.seller_name}</td>
                          <td className="px-3 py-2 text-zinc-300">{v.store_name || '—'}</td>
                          <td className="px-3 py-2 text-right text-zinc-100">{brl(v.valor)}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{Number(v.pecas || 0)}</td>
                          <td className="px-3 py-2 text-center"><span className={`rounded-full border px-2 py-0.5 text-[11px] ${v.source === 'photo' ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'}`}>{v.source === 'photo' ? 'foto' : 'manual'}</span></td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button onClick={() => setEditSale(v)} title="Editar" className="text-zinc-500 hover:text-indigo-300"><Pencil className="w-4 h-4" /></button>
                              <button onClick={() => deleteSellerSale(v)} title="Remover" className="text-zinc-500 hover:text-red-300"><Trash2 className="w-4 h-4" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Vendas por VENDEDOR direto do PDV (Fase 4 — VendaMalote). A
                matrícula é a do ERP; para pagar comissão por pessoa, associe a
                matrícula ao vendedor e crie uma regra por vendedor. A seção
                aparece SEMPRE que há relatório — vazia, explica o porquê (sem
                isso o usuário acha que "não gerou"). */}
            {pdvSellers.length === 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Vendas por operador de caixa — PDV (matrícula)</p>
                <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-[13px] text-zinc-500">
                  Nenhuma venda do PDV importada para este período ainda. As vendas entram pela sincronização: vá em <span className="text-zinc-300">Integrações → Alterdata → Sincronizar agora</span> (a primeira carga traz o histórico; a mensagem mostra "N venda(s) PDV") e clique em <span className="text-zinc-300">Gerar</span> de novo.
                </div>
              </div>
            )}
            {pdvSellers.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Vendas por operador de caixa — PDV (matrícula)</p>
                <p className="text-[12px] text-amber-300/80 mb-2">A matrícula do caixa é do OPERADOR (pode cobrir a rede toda) — não é o vendedor individual. A comissão por vendedor virá do relatório de comissão do próprio ERP (em construção). Use esta tabela como volume por caixa.</p>
                <div className="overflow-x-auto rounded-xl border border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                      <th className="px-3 py-2 text-left font-medium">Matrícula (operador)</th>
                      <th className="px-3 py-2 text-left font-medium">Loja</th>
                      <th className="px-3 py-2 text-right font-medium">Vendas</th>
                      <th className="px-3 py-2 text-right font-medium">Nº vendas</th>
                      <th className="px-3 py-2 text-right font-medium">Peças</th>
                    </tr></thead>
                    <tbody>
                      {pdvSellers.map((v: any, i: number) => (
                        <tr key={i} className="border-t border-zinc-800/70">
                          <td className="px-3 py-2 font-mono text-zinc-200">{v.vendedor}</td>
                          <td className="px-3 py-2 text-zinc-300">{v.store_name}</td>
                          <td className="px-3 py-2 text-right text-zinc-100">{brl(v.sales)}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{v.orders}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{Number(v.pecas || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {sellerSalesModal && <SellerSalesModal defaultDate={end} onClose={() => setSellerSalesModal(false)} onSaved={() => { setSellerSalesModal(false); loadReport(); }} />}
      {editSale && <EditSellerSaleModal sale={editSale} onClose={() => setEditSale(null)} onSaved={() => { setEditSale(null); loadReport(); }} />}

      {ruleForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setRuleForm(null)}>
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-zinc-100">Nova regra de comissão</h3>
              <button onClick={() => setRuleForm(null)} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block text-xs text-zinc-400">Nome
                <input value={ruleForm.name} onChange={e => setRuleForm({ ...ruleForm, name: e.target.value })} placeholder="Ex.: Comissão dos vendedores" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
              </label>
              <label className="block text-xs text-zinc-400">Aplica-se a
                <select value={ruleForm.scope} onChange={e => setRuleForm({ ...ruleForm, scope: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
                  <option value="store">Cada loja (fechamentos)</option>
                  <option value="global">A rede toda (fechamentos)</option>
                  <option value="seller">Cada vendedor (vendas do ZappFlow)</option>
                  <option value="product">Cada produto (vendas do ZappFlow)</option>
                </select>
                {(ruleForm.scope === 'seller' || ruleForm.scope === 'product') && <span className="mt-1 block text-[11px] text-zinc-500">Apura sobre as vendas feitas pelo ZappFlow (WhatsApp/loja virtual). Vendas do balcão físico entram por loja.</span>}
              </label>
              <label className="block text-xs text-zinc-400">Como calcular
                <select value={ruleForm.calculationType} onChange={e => setRuleForm({ ...ruleForm, calculationType: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
                  <option value="percent_sales">Percentual sobre as vendas</option>
                  <option value="quota_bonus">Bônus ao bater a meta</option>
                  <option value="fixed">Valor fixo</option>
                </select>
              </label>
              {ruleForm.calculationType === 'percent_sales' && (
                <label className="block text-xs text-zinc-400">Percentual (%)
                  <input type="number" step="0.1" min="0" value={ruleForm.percent} onChange={e => setRuleForm({ ...ruleForm, percent: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                  <span className="mt-1 block text-[11px] text-zinc-500">Ex.: 5 → paga 5% de tudo que a loja vendeu no período.</span>
                </label>
              )}
              {ruleForm.calculationType === 'quota_bonus' && (
                <>
                  <label className="block text-xs text-zinc-400">Bônus (R$)
                    <input type="number" step="0.01" min="0" value={ruleForm.bonus} onChange={e => setRuleForm({ ...ruleForm, bonus: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                    <span className="mt-1 block text-[11px] text-zinc-500">Pago só quando as vendas do período atingem a meta (cota).</span>
                  </label>
                  {(ruleForm.scope === 'seller' || ruleForm.scope === 'product') && (
                    <label className="block text-xs text-zinc-400">Meta (R$) do vendedor/produto
                      <input type="number" step="0.01" min="0" value={ruleForm.quota} onChange={e => setRuleForm({ ...ruleForm, quota: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                      <span className="mt-1 block text-[11px] text-zinc-500">Por loja a meta vem das cotas diárias; por vendedor/produto, defina aqui.</span>
                    </label>
                  )}
                </>
              )}
              {ruleForm.calculationType === 'fixed' && (
                <label className="block text-xs text-zinc-400">Valor fixo (R$)
                  <input type="number" step="0.01" min="0" value={ruleForm.amount} onChange={e => setRuleForm({ ...ruleForm, amount: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                </label>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setRuleForm(null)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
              <button onClick={saveRule} disabled={savingRule} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{savingRule ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar regra</button>
            </div>
          </div>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <label className="text-xs text-zinc-400">Início<input type="date" value={start} onChange={e => setStart(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" /></label>
        <label className="text-xs text-zinc-400">Fim<input type="date" value={end} onChange={e => setEnd(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" /></label>
        <button onClick={createRun} disabled={creating} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Nova apuração
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhuma apuração ainda. Escolha o período e clique em “Nova apuração”.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Período</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Vendas</th>
              <th className="px-3 py-2 text-right font-medium">Comissão</th>
              <th className="px-3 py-2 text-right font-medium">Ações</th>
            </tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{r.period_start} → {r.period_end}</td>
                  <td className="px-3 py-2"><Badge map={RUN_STATUS} s={r.status} /></td>
                  <td className="px-3 py-2 text-right text-zinc-400">{brl(r.total_sales)}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{brl(r.total_commission)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => open(r)} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800">Ver</button>
                      {r.status === 'draft' && (
                        <>
                          <button onClick={() => setStatus(r, 'approve')} title="Aprovar" className="rounded bg-emerald-600/90 px-1.5 py-0.5 text-white hover:bg-emerald-500"><Check className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setStatus(r, 'reject')} title="Rejeitar" className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300 hover:bg-red-500/10"><X className="w-3.5 h-3.5" /></button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDetail(null)}>
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-zinc-100">Apuração {detail.period_start} → {detail.period_end}</h3>
              <button onClick={() => setDetail(null)} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
            </div>
            <div className="mt-1 flex items-center gap-2"><Badge map={RUN_STATUS} s={detail.status} /><span className="text-xs text-zinc-500">Total: {brl(detail.total_commission)}</span></div>
            <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/60 text-zinc-400"><tr><th className="px-3 py-2 text-left font-medium">Loja / Escopo</th><th className="px-3 py-2 text-right font-medium">Base</th><th className="px-3 py-2 text-right font-medium">Comissão</th></tr></thead>
                <tbody>
                  {(detail.items || []).map((it: any) => (
                    <tr key={it.id} className="border-t border-zinc-800/70">
                      <td className="px-3 py-2 text-zinc-200">{it.seller_name}</td>
                      <td className="px-3 py-2 text-right text-zinc-400">{brl(it.base_amount)}</td>
                      <td className="px-3 py-2 text-right text-zinc-100">{brl(it.commission_amount)}</td>
                    </tr>
                  ))}
                  {(!detail.items || detail.items.length === 0) && <tr><td colSpan={3} className="px-3 py-4 text-center text-xs text-zinc-500">Sem itens (cadastre regras de comissão).</td></tr>}
                </tbody>
              </table>
            </div>
            {detail.status === 'draft' && (
              <div className="mt-4 flex justify-end gap-2">
                <button onClick={() => setStatus(detail, 'reject')} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10">Rejeitar</button>
                <button onClick={() => setStatus(detail, 'approve')} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500">Aprovar comissão</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Conferência de divergência (fechamento × sistema) ----------------------
const DIV_STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: 'Confere', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  divergent: { label: 'Divergente', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  pending_informed: { label: 'Sem fechamento', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
};
function ReconciliationTab() {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyDiv, setOnlyDiv] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch(`/api/retailops/reconciliation?month=${month}${onlyDiv ? '&onlyDivergent=1' : ''}`).then(r => r.json()).catch(() => null);
      setData(d);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [month, onlyDiv]);

  const onImport = async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch('/api/retailops/reconciliation/import', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`Conferidos ${d.matched ?? 0} fechamento(s)${d.divergences ? ` — ${d.divergences} divergente(s)` : ''}.`); load(); }
      else toast.error(d.error || 'Falha ao importar o CSV.');
    } finally { setImporting(false); }
  };

  const s = data?.summary;
  return (
    <div>
      <div className="mb-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3 text-[12px] text-sky-200/90">
        Compara o <strong>fechamento informado</strong> com o total do <strong>sistema/PDV</strong> (export do Alterdata). Enquanto a integração viva não é ligada, importe aqui o CSV de <em>“Fechamento de Caixa — Diário”</em>.
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-xs text-zinc-400">Mês
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400"><input type="checkbox" checked={onlyDiv} onChange={e => setOnlyDiv(e.target.checked)} /> Só divergentes</label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Importar CSV do sistema
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.currentTarget.value = ''; }} />
        </label>
        <div className="ml-auto"><NewStoreButton onCreated={load} /></div>
      </div>

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Conferidos" value={String(s.reconciledCount)} />
          <Stat label="Divergentes" value={String(s.divergentCount)} tone={s.divergentCount > 0 ? 'red' : 'ok'} />
          <Stat label="Divergência total" value={brl(s.totalDivergenceBRL)} tone={s.totalDivergenceBRL > 0 ? 'red' : 'ok'} />
          <Stat label="Total do sistema" value={brl(s.systemTotalBRL)} />
        </div>
      )}

      {loading ? <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
        : !data?.rows?.length ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum fechamento conferido neste mês. Importe o CSV do sistema para comparar.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Data</th>
                <th className="px-3 py-2 text-left font-medium">Loja</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Informado</th>
                <th className="px-3 py-2 text-right font-medium">Sistema</th>
                <th className="px-3 py-2 text-right font-medium">Diferença</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r: any, i: number) => (
                  <tr key={`${r.storeId}-${r.date}-${i}`} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-300">{r.date}</td>
                    <td className="px-3 py-2 text-zinc-200">{r.storeName}</td>
                    <td className="px-3 py-2"><Badge map={DIV_STATUS} s={r.status} /></td>
                    <td className="px-3 py-2 text-right text-zinc-300">{r.informed != null ? brl(r.informed) : '—'}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{brl(r.system)}</td>
                    <td className={`px-3 py-2 text-right ${Number(r.divergence) ? 'text-red-300' : 'text-zinc-500'}`}>{r.divergence != null ? brl(r.divergence) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ---- Estoque negativo -------------------------------------------------------
function NegativeStockTab() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/api/retailops/stock/negative').then(r => r.json()).catch(() => ({}));
      setItems(Array.isArray(d?.items) ? d.items : []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12px] text-zinc-400">Itens com saldo <strong className="text-red-300">negativo</strong> por loja — normalmente venda lançada sem entrada correspondente. Corrija a entrada no estoque.</p>
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
      </div>
      {loading ? <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
        : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-emerald-800/40 bg-emerald-500/5 p-8 text-center text-sm text-emerald-300/80"><Check className="mx-auto mb-2 h-5 w-5" /> Nenhum item com estoque negativo. 🎉</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Loja</th>
                <th className="px-3 py-2 text-left font-medium">Produto</th>
                <th className="px-3 py-2 text-right font-medium">Saldo</th>
              </tr></thead>
              <tbody>
                {items.map((it: any) => (
                  <tr key={it.id} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-200">{it.store_name}</td>
                    <td className="px-3 py-2 text-zinc-300">{it.product_name || it.product_service_id}</td>
                    <td className="px-3 py-2 text-right font-semibold text-red-300">{Number(it.quantity_available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ---- Equipe & cobrança (responsáveis por loja) ------------------------------
const RESP_TYPES = ['fechamento', 'malote', 'escala'];
function ResponsiblesTab() {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState<string>('');
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [wa, setWa] = useState('');
  const [types, setTypes] = useState<string[]>([]);

  useEffect(() => {
    apiFetch('/api/retailops/stores').then(r => r.json()).then(d => {
      const st = Array.isArray(d?.stores) ? d.stores : [];
      setStores(st);
      if (st[0]) setStoreId(st[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const loadList = async (id: string) => {
    if (!id) { setList([]); return; }
    const d = await apiFetch(`/api/retailops/stores/${id}/responsibles`).then(r => r.json()).catch(() => ({}));
    setList(Array.isArray(d?.responsibles) ? d.responsibles : []);
  };
  useEffect(() => { loadList(storeId); /* eslint-disable-next-line */ }, [storeId]);

  const add = async () => {
    if (!wa.trim()) { toast.error('Informe o WhatsApp do responsável.'); return; }
    setAdding(true);
    try {
      const res = await apiFetch(`/api/retailops/stores/${storeId}/responsibles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, whatsappIdentifier: wa, taskTypes: types.length ? types : undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Responsável adicionado.'); setName(''); setWa(''); setTypes([]); loadList(storeId); }
      else toast.error(d.error || 'Falha ao adicionar.');
    } finally { setAdding(false); }
  };
  const remove = async (rid: string) => {
    const res = await apiFetch(`/api/retailops/responsibles/${rid}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Responsável removido.'); loadList(storeId); }
    else toast.error('Falha ao remover.');
  };
  const toggleType = (t: string) => setTypes(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
  if (stores.length === 0) return <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Cadastre as lojas da rede para definir os responsáveis pela cobrança.</div>;

  return (
    <div>
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-400">
        Quem recebe a <strong>cobrança pelo WhatsApp</strong> de cada pendência (fechamento/malote/escala) e pode dar baixa respondendo. Sem responsável, a cobrança vai para o número da própria loja.
      </div>
      <label className="text-xs text-zinc-400">Loja
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>

      <div className="mt-4 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-[1fr_1fr_auto]">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome (opcional)" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <input value={wa} onChange={e => setWa(e.target.value)} placeholder="WhatsApp (ex.: 5531988887777)" inputMode="tel" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <button onClick={add} disabled={adding} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Adicionar</button>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <span className="text-[11px] text-zinc-500">Cobra:</span>
          {RESP_TYPES.map(t => (
            <button key={t} onClick={() => toggleType(t)} className={`rounded-full border px-2.5 py-0.5 text-[11px] capitalize ${types.includes(t) ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>{t}</button>
          ))}
          <span className="text-[11px] text-zinc-600">{types.length === 0 ? '(vazio = todos)' : ''}</span>
        </div>
      </div>

      <div className="mt-4">
        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">Nenhum responsável nesta loja ainda — a cobrança vai para o número da loja.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Nome</th>
                <th className="px-3 py-2 text-left font-medium">WhatsApp</th>
                <th className="px-3 py-2 text-left font-medium">Cobra</th>
                <th className="px-3 py-2 text-right font-medium">Ações</th>
              </tr></thead>
              <tbody>
                {list.map((r: any) => (
                  <tr key={r.id} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-200">{r.name || <span className="text-zinc-500">—</span>}</td>
                    <td className="px-3 py-2 text-zinc-300">{r.whatsapp_identifier}</td>
                    <td className="px-3 py-2 text-zinc-400 capitalize">{r.task_types === 'all' ? 'todos' : r.task_types}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => remove(r.id)} title="Remover" className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300 hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'ok' }) {
  const color = tone === 'red' ? 'text-red-300' : tone === 'ok' ? 'text-emerald-300' : 'text-zinc-100';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}
