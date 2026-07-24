import { useEffect, useMemo, useState } from 'react';
import { Store, Loader2, Check, X, RefreshCw, Calculator, CalendarDays, Plus, Scale, AlertTriangle, Users, Upload, Trash2, Sparkles, Globe } from 'lucide-react';
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

type RetailTab = 'fechamento' | 'comissao' | 'divergencia' | 'estoque' | 'equipe' | 'padroes' | 'lojavirtual';
const TABS: { key: RetailTab; label: string; icon: any }[] = [
  { key: 'fechamento', label: 'Fechamento diário', icon: CalendarDays },
  { key: 'comissao', label: 'Comissão', icon: Calculator },
  { key: 'divergencia', label: 'Divergência', icon: Scale },
  { key: 'estoque', label: 'Estoque negativo', icon: AlertTriangle },
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
  const [tab, setTab] = useState<RetailTab>('fechamento');
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
      {tab === 'fechamento' && <ClosingsTab />}
      {tab === 'comissao' && <CommissionTab />}
      {tab === 'divergencia' && <ReconciliationTab />}
      {tab === 'estoque' && <NegativeStockTab />}
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
  const [stores, setStores] = useState<any[]>([]);
  const [reserves, setReserves] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [d, st] = await Promise.all([
        apiFetch('/api/retailops/online-reserve').then(r => r.json()).catch(() => ({})),
        apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({})),
      ]);
      setEnabled(!!d?.enabled);
      setOnlineStoreId(d?.onlineStoreId || '');
      setReserves(Array.isArray(d?.reserves) ? d.reserves : []);
      setPending(Array.isArray(d?.pending) ? d.pending : []);
      setStores(Array.isArray(st?.stores) ? st.stores : (Array.isArray(st) ? st : []));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const saveFlag = async (patch: { enabled?: boolean; onlineStoreId?: string }) => {
    const body = { enabled: patch.enabled ?? enabled, onlineStoreId: patch.onlineStoreId ?? onlineStoreId };
    const res = await apiFetch('/api/retailops/online-reserve/flag', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setEnabled(!!d.enabled); setOnlineStoreId(d.onlineStoreId || ''); toast.success('Configuração salva.'); }
    else toast.error(d.error || 'Falha ao alterar.');
  };
  const toggle = () => saveFlag({ enabled: !enabled });
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

      <div className="mb-4 flex items-center gap-2 text-sm">
        <label className="text-xs text-zinc-400">Filial da loja virtual (de qual loja o estoque online sai):</label>
        <select value={onlineStoreId} onChange={e => saveFlag({ onlineStoreId: e.target.value })} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          <option value="">— não aplicar reserva no checkout —</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>)}
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
      {reserves.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-[12px] text-zinc-600">Nenhuma reserva definida. Defina quanto de cada produto a loja virtual pode vender por loja (via API <span className="font-mono">/online-reserve/item</span> — editor visual na próxima fatia).</div>
      ) : (
        <div className="space-y-1">
          {reserves.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-sm rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-1.5">
              <span className="text-zinc-500 font-mono text-[11px]">{String(r.store_id).slice(0, 8)}</span>
              <span className="text-zinc-300">{String(r.product_service_id).slice(0, 8)}</span>
              <span className="ml-auto text-zinc-400">reserva {r.qty_reserved}</span>
            </div>
          ))}
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
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) { toast.error('Dê um nome à loja.'); return; }
    setSaving(true);
    try {
      const body = JSON.stringify({ name: name.trim(), code: code.trim() || null, whatsappIdentifier: wa.replace(/\D/g, '') || null });
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
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="Ex.: 01, CENTRO" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="block text-xs text-zinc-400">WhatsApp da loja (opcional)
            <input value={wa} onChange={e => setWa(e.target.value)} placeholder="Ex.: 5511987654321" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            <span className="mt-1 block text-[11px] text-zinc-500">Recebe a cobrança de pendências (fechamento, malote) e permite dar baixa respondendo.</span>
          </label>
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

// ---- Comissão ---------------------------------------------------------------
function CommissionTab() {
  const [runs, setRuns] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [ruleForm, setRuleForm] = useState<null | { name: string; scope: string; calculationType: string; percent: string; amount: string; bonus: string }>(null);
  const [savingRule, setSavingRule] = useState(false);
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(todayStr());

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
    else if (ruleForm.calculationType === 'quota_bonus') config = { bonus: Number(ruleForm.bonus) || 0 };
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
            <button onClick={() => setRuleForm({ name: '', scope: 'store', calculationType: 'percent_sales', percent: '5', amount: '', bonus: '' })} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20">
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
                  <div className="truncate text-sm text-zinc-100">{r.name} <span className="text-zinc-500">· {r.scope === 'global' ? 'rede toda' : 'por loja'}</span></div>
                  <div className="text-[11px] text-indigo-300">{ruleSummary(r)}</div>
                </div>
                <button onClick={() => toggleRule(r)} className={`ml-3 shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${r.active ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'}`}>{r.active ? 'Ativa' : 'Inativa'}</button>
              </div>
            ))}
          </div>
        )}
      </div>

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
                  <option value="store">Cada loja</option>
                  <option value="global">A rede toda</option>
                </select>
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
                <label className="block text-xs text-zinc-400">Bônus (R$)
                  <input type="number" step="0.01" min="0" value={ruleForm.bonus} onChange={e => setRuleForm({ ...ruleForm, bonus: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                  <span className="mt-1 block text-[11px] text-zinc-500">Pago só quando as vendas do período atingem a meta (cota).</span>
                </label>
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
