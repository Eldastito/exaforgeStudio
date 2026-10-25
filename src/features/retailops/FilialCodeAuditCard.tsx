import { useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

// Prévia SOMENTE LEITURA: vendas guardadas sob códigos de filial que não são mais de nenhuma loja ativa
// (loja que mudou de código). Não altera nada; reetiquetar é uma etapa posterior decidida pelo dono.
export function FilialCodeAuditCard() {
  const [into, setInto] = useState('');
  const [data, setData] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/retailops/stores/filial-codes/audit${into.trim() ? `?into=${encodeURIComponent(into.trim())}` : ''}`);
      setData(r.ok ? await r.json() : { error: true });
      if (r.ok) loadHistory();
    } catch { setData({ error: true }); } finally { setBusy(false); }
  };
  // Troca de código no histórico: prévia (leitura) → digitar a confirmação → aplicar → desfazer.
  const [plan, setPlan] = useState<any | null>(null);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const loadHistory = async () => {
    try { const r = await apiFetch('/api/retailops/stores/filial-remap/history'); if (r.ok) setHistory((await r.json()).remaps || []); } catch { /* sem histórico */ }
  };
  const openPlan = async (from: string) => {
    setWorking(true); setTyped('');
    try {
      const r = await apiFetch(`/api/retailops/stores/filial-remap/plan?from=${encodeURIComponent(from)}&into=${encodeURIComponent(into.trim())}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Não foi possível montar a prévia.'); setPlan(null); } else { setPlan(d); loadHistory(); }
    } finally { setWorking(false); }
  };
  const applyPlan = async () => {
    if (!plan) return;
    setWorking(true);
    try {
      const expectedMove = Object.fromEntries(Object.entries(plan.tables).map(([k, v]: any) => [k, v.move]));
      const r = await apiFetch('/api/retailops/stores/filial-remap/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: plan.from, into: plan.into, confirm: typed.trim(), expectedMove }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Não foi possível aplicar.'); return; }
      toast.success(`Troca feita: ${d.moved.pdvSales} vendas movidas de ${plan.from} para ${plan.into}.`);
      setPlan(null); setTyped(''); await run(); await loadHistory();
    } finally { setWorking(false); }
  };
  const undo = async (id: string) => {
    if (!window.confirm('Desfazer esta troca? As linhas movidas voltam para o código antigo.')) return;
    setWorking(true);
    try {
      const r = await apiFetch(`/api/retailops/stores/filial-remap/undo/${encodeURIComponent(id)}`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d.error || 'Não foi possível desfazer.'); return; }
      const left = Object.values(d.notReturned || {}).reduce((a: number, b: any) => a + Number(b || 0), 0);
      toast.success(left ? `Desfeito, mas ${left} linha(s) não voltaram (já havia registro igual no código antigo).` : 'Troca desfeita.');
      await run(); await loadHistory();
    } finally { setWorking(false); }
  };
  const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return (
    <div className="mb-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-300">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-200">Vendas de códigos antigos de loja</span>
        <span className="text-zinc-500">(só leitura — nada é alterado)</span>
        <input value={into} onChange={e => setInto(e.target.value)} placeholder="Código atual da loja (ex.: 1084)" className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-700 text-zinc-100 w-56" />
        <button onClick={run} disabled={busy} className="px-2 py-1 rounded-md bg-zinc-700 hover:bg-zinc-600 text-white disabled:opacity-50">{busy ? 'Conferindo…' : 'Conferir'}</button>
      </div>
      {data?.error && <p className="mt-2 text-rose-300">Não foi possível conferir agora.</p>}
      {data && !data.error && (
        <div className="mt-2 space-y-1.5">
          <p>{data.summary.orphanCodes} código(s) sem loja ativa · {data.summary.pdvSales} vendas do PDV · {brl(data.summary.pdvTotal)}{data.target ? ` · destino: ${data.target.name} (${data.target.code})` : ''}</p>
          {data.orphans.map((o: any) => (
            <div key={o.filial} className="rounded-md bg-zinc-950/60 border border-zinc-800 px-2 py-1">
              <span className="text-zinc-100">{o.filial}</span>
              {o.storeRecord ? <span> · loja cadastrada: {o.storeRecord.name}{o.storeRecord.active ? '' : ' (inativa)'}</span> : <span className="text-amber-300"> · sem loja cadastrada</span>}
              <div className="text-zinc-400">
                PDV: {o.pdvSales.rows} vendas {o.pdvSales.firstDate ? `de ${o.pdvSales.firstDate} a ${o.pdvSales.lastDate}` : ''} · {brl(o.pdvSales.total)} · {o.pdvSales.sellers} código(s) de vendedor
                {' · '}itens {o.saleItems.rows} · parcelas de cartão {o.cardInstallments.rows} · vendas por vendedor do ERP {o.erpSellerSales.rows}
              </div>
              {data.target && !o.storeRecord?.active && (
                <button onClick={() => openPlan(o.filial)} disabled={working} className="mt-1 mr-2 px-2 py-0.5 rounded bg-sky-700/80 hover:bg-sky-600 text-white disabled:opacity-50">Ver troca {o.filial} → {data.target.code}</button>
              )}
              {o.collisions && (
                <div className={o.collisions.total ? 'text-amber-300' : 'text-emerald-300'}>
                  {o.collisions.total ? `${o.collisions.total} linha(s) já existem sob o destino (colisão) — não seriam sobrescritas` : 'sem colisão com o destino'}
                  {o.overlapsTarget ? ' · período se sobrepõe ao do destino' : o.gapDaysToTarget != null ? ` · termina ${o.gapDaysToTarget} dia(s) antes do destino começar` : ''}
                </div>
              )}
            </div>
          ))}
          {plan && (
            <div className="rounded-md border border-sky-500/40 bg-sky-500/5 p-2">
              <p className="text-zinc-100">Troca {plan.from} → {plan.into} ({plan.targetName}) — prévia, nada foi alterado ainda</p>
              <ul className="mt-1 text-zinc-300">
                <li>Vendas do PDV: {plan.tables.pdvSales.move} movem · {plan.tables.pdvSales.stay} ficam{plan.salesCollisions.identical + plan.salesCollisions.different > 0 ? ` (${plan.salesCollisions.identical} idêntica(s) e ${plan.salesCollisions.different} com valor/vendedor DIFERENTE sob o ${plan.into})` : ''}</li>
                <li>Itens: {plan.tables.saleItems.move} movem · {plan.tables.saleItems.stay} ficam</li>
                <li>Parcelas de cartão: {plan.tables.cardInstallments.move} movem · {plan.tables.cardInstallments.stay} ficam</li>
                <li>Vendas por vendedor do ERP: {plan.tables.erpSellerSales.move} movem · {plan.tables.erpSellerSales.stay} ficam</li>
                {plan.moving.firstDate && <li>O que move: de {plan.moving.firstDate} a {plan.moving.lastDate} · {brl(plan.moving.pdvTotal)}</li>}
              </ul>
              <p className="mt-1 text-zinc-500">O que já existe sob o {plan.into} nunca é sobrescrito nem apagado: fica no lugar. Dá para desfazer depois.</p>
              {plan.willMoveRows > 0 ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span>Para confirmar, digite <strong className="text-zinc-100">{plan.confirmWith}</strong>:</span>
                  <input value={typed} onChange={e => setTyped(e.target.value)} className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-700 text-zinc-100 w-32" />
                  <button onClick={applyPlan} disabled={working || typed.trim() !== plan.confirmWith} className="px-2 py-1 rounded-md bg-amber-600/80 hover:bg-amber-600 text-white disabled:opacity-40">Aplicar troca</button>
                  <button onClick={() => { setPlan(null); setTyped(''); }} className="px-2 py-1 rounded-md border border-zinc-700 text-zinc-300">Cancelar</button>
                </div>
              ) : <p className="mt-1 text-zinc-400">Não há linha para mover.</p>}
            </div>
          )}
          {history.length > 0 && (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
              <p className="text-zinc-200">Trocas já feitas</p>
              {history.map((h: any) => (
                <p key={h.id} className="text-zinc-400">
                  {String(h.createdAt).slice(0, 16)} · {h.from} → {h.into} · {h.counts?.moved?.pdvSales ?? 0} vendas movidas
                  {h.undoneAt ? <span className="text-zinc-500"> · desfeita</span> : <button onClick={() => undo(h.id)} disabled={working} className="ml-2 text-amber-300 hover:underline disabled:opacity-50">desfazer</button>}
                </p>
              ))}
            </div>
          )}
          {data.notes.map((n: string) => <p key={n} className="text-zinc-500">{n}</p>)}
        </div>
      )}
    </div>
  );
}
