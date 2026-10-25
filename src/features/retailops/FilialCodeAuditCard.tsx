import { useState } from 'react';
import { apiFetch } from '@/src/lib/api';

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
    } catch { setData({ error: true }); } finally { setBusy(false); }
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
              {o.collisions && (
                <div className={o.collisions.total ? 'text-amber-300' : 'text-emerald-300'}>
                  {o.collisions.total ? `${o.collisions.total} linha(s) já existem sob o destino (colisão) — não seriam sobrescritas` : 'sem colisão com o destino'}
                  {o.overlapsTarget ? ' · período se sobrepõe ao do destino' : o.gapDaysToTarget != null ? ` · termina ${o.gapDaysToTarget} dia(s) antes do destino começar` : ''}
                </div>
              )}
            </div>
          ))}
          {data.notes.map((n: string) => <p key={n} className="text-zinc-500">{n}</p>)}
        </div>
      )}
    </div>
  );
}
