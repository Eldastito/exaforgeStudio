/**
 * OrgGroupView — ADR-199 (UI): tela do ZapFlow Grupo. Três abas sobre as APIs já
 * testadas (/api/groups*): Operações (lista + provisionar nova operação), Consolidado
 * (dashboard fan-out por marca) e Fatura (prévia consolidada ou separada por pagador).
 *
 * Feature gated no servidor (404 sem FEATURE_ORG_GROUPS) → mostra estado honesto. Dinheiro
 * é role-gated na rota (owner/admin); 402/403 vira aviso, nunca inventa número.
 */
import React, { useEffect, useState } from 'react';
import { Building2, Plus, RefreshCw, Receipt, LayoutGrid } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

const brl = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

type Tab = 'ops' | 'consolidated' | 'billing';

export function OrgGroupView() {
  const [groupId, setGroupId] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null); // null=carregando
  const [tab, setTab] = useState<Tab>('ops');

  useEffect(() => {
    apiFetch('/api/groups')
      .then((r) => (r.status === 404 ? { off: true } : r.json()))
      .then((d: any) => {
        if (d?.off) { setAvailable(false); return; }
        setAvailable(true);
        setGroupId(d?.groups?.[0]?.id ?? null);
      })
      .catch(() => setAvailable(false));
  }, []);

  if (available === false) {
    return <Wrap><Empty title="Grupo indisponível" msg="O recurso de grupo não está habilitado nesta conta." /></Wrap>;
  }
  if (available === null) return <Wrap><p className="text-zinc-500 text-sm">Carregando…</p></Wrap>;

  return (
    <Wrap>
      <div className="flex items-center gap-2 mb-5">
        <Building2 className="w-6 h-6 text-indigo-400" />
        <h2 className="text-xl font-semibold text-zinc-100">Grupo</h2>
      </div>
      <div className="flex gap-1 border-b border-zinc-800 mb-5">
        <TabBtn active={tab === 'ops'} onClick={() => setTab('ops')} icon={<LayoutGrid className="w-4 h-4" />}>Operações</TabBtn>
        <TabBtn active={tab === 'consolidated'} onClick={() => setTab('consolidated')} icon={<RefreshCw className="w-4 h-4" />}>Consolidado</TabBtn>
        <TabBtn active={tab === 'billing'} onClick={() => setTab('billing')} icon={<Receipt className="w-4 h-4" />}>Fatura</TabBtn>
      </div>
      {tab === 'ops' && <OpsTab groupId={groupId} onGroupCreated={setGroupId} />}
      {tab === 'consolidated' && <ConsolidatedTab groupId={groupId} />}
      {tab === 'billing' && <BillingTab groupId={groupId} />}
    </Wrap>
  );
}

// ---------- Operações: lista + provisionar ----------
function OpsTab({ groupId, onGroupCreated }: { groupId: string | null; onGroupCreated: (id: string) => void }) {
  const [ops, setOps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    if (!groupId) { setOps([]); setLoading(false); return; }
    try {
      const r = await apiFetch(`/api/groups/${groupId}/billing-preview`);
      if (r.ok) { const d = await r.json(); setOps(d.operations || []); }
      else setOps([]);
    } catch { setOps([]); }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [groupId]);

  async function provision(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await apiFetch('/api/groups/provision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessName: name.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setMsg(d.created ? 'Operação criada com paridade de plano.' : 'Operação já existia (nada duplicado).');
        setName('');
        if (d.groupId && !groupId) onGroupCreated(d.groupId);
        setTimeout(load, 300);
      } else setMsg(d.error || 'Falha ao provisionar.');
    } catch { setMsg('Falha de rede.'); }
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <form onSubmit={provision} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <p className="text-sm font-medium text-zinc-200 mb-2">Adicionar operação ao grupo</p>
        <p className="text-xs text-zinc-500 mb-3">Cria uma nova operação (CNPJ) com o MESMO plano da sua operação atual (paridade). O canal e o ERP por CNPJ são conectados depois.</p>
        <div className="flex gap-2">
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Nome da operação (ex.: Toulon Grande Rio)"
            className="flex-1 rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
          />
          <button disabled={busy || !name.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-3 py-2 text-sm font-medium text-white">
            <Plus className="w-4 h-4" /> Adicionar
          </button>
        </div>
        {msg && <p className="text-xs mt-2 text-zinc-400">{msg}</p>}
      </form>

      <div>
        <p className="text-sm font-medium text-zinc-300 mb-2">Operações do grupo</p>
        {loading ? <p className="text-sm text-zinc-500">Carregando…</p>
          : ops.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma operação ainda. Adicione a primeira acima.</p>
          : (
            <div className="rounded-xl border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
              {ops.map((o) => (
                <div key={o.organizationId} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-100 truncate">{o.businessName || o.organizationId}</p>
                    <p className="text-xs text-zinc-500">{o.planName || (o.unpriced ? 'sem plano' : o.planId || '—')}</p>
                  </div>
                  <span className="text-sm text-zinc-300">{brl(o.netPrice)}</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

// ---------- Consolidado ----------
function ConsolidatedTab({ groupId }: { groupId: string | null }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!groupId) return;
    setLoading(true);
    try {
      const r = await apiFetch(`/api/groups/${groupId}/consolidated?month=${month}`);
      setData(r.ok ? await r.json() : null);
    } catch { setData(null); }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [groupId, month]);

  if (!groupId) return <Empty title="Sem grupo" msg="Adicione operações na aba Operações." />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-sm text-zinc-400">Mês</label>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          className="rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100" />
      </div>
      {loading ? <p className="text-sm text-zinc-500">Carregando…</p> : data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Stat label="Vendas (total)" value={brl(data.totals?.totalSales)} />
            <Stat label="Fechamentos" value={String(data.totals?.closingsCount ?? 0)} />
            <Stat label="Comissão (est.)" value={brl(data.totals?.commissionEstimate)} />
          </div>
          <div className="rounded-xl border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
            {(data.operations || []).map((o: any) => (
              <div key={o.organizationId} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="text-sm text-zinc-100 truncate">{o.businessName || o.organizationId}</span>
                  {o.partial && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">parcial</span>}
                </div>
                <span className="text-sm text-zinc-300">{o.partial ? '—' : brl(o.totalSales)}</span>
              </div>
            ))}
          </div>
          {data.partial?.length > 0 && <p className="text-xs text-amber-500/80">{data.partial.length} operação(ões) indisponível(is) — mostradas como parciais.</p>}
        </>
      )}
    </div>
  );
}

// ---------- Fatura (prévia) ----------
function BillingTab({ groupId }: { groupId: string | null }) {
  const [split, setSplit] = useState(false);
  const [addon, setAddon] = useState('0');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!groupId) return;
    setLoading(true);
    const q = `groupAddon=${encodeURIComponent(addon || '0')}${split ? '&split=payer' : ''}`;
    try {
      const r = await apiFetch(`/api/groups/${groupId}/billing-preview?${q}`);
      setData(r.ok ? await r.json() : null);
    } catch { setData(null); }
    setLoading(false);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [groupId, split, addon]);

  if (!groupId) return <Empty title="Sem grupo" msg="Adicione operações na aba Operações." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="inline-flex rounded-lg border border-zinc-800 overflow-hidden text-sm">
          <button onClick={() => setSplit(false)} className={`px-3 py-1.5 ${!split ? 'bg-indigo-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'}`}>Consolidada</button>
          <button onClick={() => setSplit(true)} className={`px-3 py-1.5 ${split ? 'bg-indigo-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'}`}>Separada por pagador</button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-zinc-400">Add-on de grupo (R$)</label>
          <input type="number" min="0" value={addon} onChange={(e) => setAddon(e.target.value)}
            className="w-24 rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100" />
        </div>
      </div>
      <p className="text-xs text-zinc-500">Prévia — não é cobrança. A emissão real depende do gateway de pagamento.</p>

      {loading ? <p className="text-sm text-zinc-500">Carregando…</p> : data && (
        !split ? (
          <>
            <div className="rounded-xl border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
              {(data.operations || []).map((o: any) => (
                <Row key={o.organizationId} name={o.businessName || o.organizationId} sub={o.unpriced ? 'sem plano' : o.planName} value={brl(o.netPrice)} />
              ))}
            </div>
            <TotalsBar discount={data.volumeDiscountPct} count={data.operationCount} addon={data.groupAddon} total={data.total} />
          </>
        ) : (
          <>
            {(data.payers || []).map((p: any) => (
              <div key={p.payerRef} className="rounded-xl border border-zinc-800 overflow-hidden mb-3">
                <div className="px-4 py-2 bg-zinc-900/60 text-sm text-zinc-200 flex justify-between">
                  <span className="truncate">Pagador: {p.operations?.[0]?.businessName ? (p.payerRef.startsWith('org_') ? p.operations[0].businessName : p.payerRef) : p.payerRef}</span>
                  <span className="font-medium">{brl(p.total)}</span>
                </div>
                <div className="divide-y divide-zinc-800">
                  {p.operations.map((o: any) => (
                    <Row key={o.organizationId} name={o.businessName || o.organizationId} sub={o.unpriced ? 'sem plano' : o.planName} value={brl(o.netPrice)} />
                  ))}
                  {p.addon > 0 && <Row name="Add-on de grupo" sub="uma vez" value={brl(p.addon)} />}
                </div>
              </div>
            ))}
            <TotalsBar discount={data.volumeDiscountPct} count={data.operationCount} addon={data.groupAddon} total={data.grandTotal} note="Soma das faturas separadas = consolidado." />
          </>
        )
      )}
    </div>
  );
}

// ---------- primitivos ----------
function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="p-4 md:p-6 max-w-4xl mx-auto w-full">{children}</div>;
}
function TabBtn({ active, onClick, icon, children }: any) {
  return (
    <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px ${active ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}>
      {icon}{children}
    </button>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-zinc-100 mt-0.5">{value}</p>
    </div>
  );
}
const Row: React.FC<{ name: string; sub?: string; value: string }> = ({ name, sub, value }) => (
  <div className="flex items-center justify-between px-4 py-3">
    <div className="min-w-0">
      <p className="text-sm text-zinc-100 truncate">{name}</p>
      {sub && <p className="text-xs text-zinc-500">{sub}</p>}
    </div>
    <span className="text-sm text-zinc-300">{value}</span>
  </div>
);
function TotalsBar({ discount, count, addon, total, note }: any) {
  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-4 flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs text-zinc-400">
        {count} operação(ões) · desconto de volume {discount}%{addon > 0 ? ` · add-on ${brl(addon)}` : ''}
        {note && <span className="block text-zinc-500 mt-0.5">{note}</span>}
      </div>
      <div className="text-right">
        <p className="text-[11px] uppercase tracking-wide text-zinc-500">Total/mês</p>
        <p className="text-xl font-bold text-white">{brl(total)}</p>
      </div>
    </div>
  );
}
function Empty({ title, msg }: { title: string; msg: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
      <p className="text-zinc-200 font-medium">{title}</p>
      <p className="text-sm text-zinc-500 mt-1">{msg}</p>
    </div>
  );
}
