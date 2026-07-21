import { useEffect, useMemo, useState } from 'react';
import { Store, Loader2, Check, X, RefreshCw, Calculator, CalendarDays, Plus, Scale, AlertTriangle, Users, Upload, Trash2 } from 'lucide-react';
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

type RetailTab = 'fechamento' | 'comissao' | 'divergencia' | 'estoque' | 'equipe';
const TABS: { key: RetailTab; label: string; icon: any }[] = [
  { key: 'fechamento', label: 'Fechamento diário', icon: CalendarDays },
  { key: 'comissao', label: 'Comissão', icon: Calculator },
  { key: 'divergencia', label: 'Divergência', icon: Scale },
  { key: 'estoque', label: 'Estoque negativo', icon: AlertTriangle },
  { key: 'equipe', label: 'Equipe & cobrança', icon: Users },
];

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

  const load = async () => {
    setLoading(true);
    try {
      const [st, cl] = await Promise.all([
        apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({})),
        apiFetch(`/api/retailops/closings?date=${date}`).then(r => r.json()).catch(() => ({})),
      ]);
      setStores(Array.isArray(st?.stores) ? st.stores : (Array.isArray(st) ? st : []));
      setClosings(Array.isArray(cl?.closings) ? cl.closings : (Array.isArray(cl) ? cl : []));
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
      </div>

      {stores.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          Nenhuma loja cadastrada na rede ainda. Cadastre as lojas (filiais) para registrar o fechamento diário.
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
                  <tr key={s.id} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-200">{s.name}</td>
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
    </div>
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

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      {rules.length === 0 && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-200/90">
          Nenhuma <strong>regra de comissão</strong> ativa ainda — a apuração vem zerada. Cadastre as regras da rede antes de apurar (por loja, meta batida, etc.).
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
