import { useCallback, useEffect, useState } from 'react';
import { Wallet, Loader2, Plus, ArrowDownCircle, ArrowUpCircle, TrendingUp, TrendingDown, Check } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

// Motor de Caixa (ADR-125 Fatia 1) — livro-caixa. Venda ≠ lucro ≠ caixa:
// só dinheiro que entrou de fato conta como caixa; fiado/recebível fica em "a receber".

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
const todayStr = () => new Date().toISOString().slice(0, 10);

export function CashView() {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch('/api/cash').then((r) => r.json()).then((d: any) => setData(d)).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (url: string, body: any) => {
    setBusy(true);
    try {
      const r = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { load(); return d; }
      toast.error(d.error || 'Não consegui concluir.'); return null;
    } catch { toast.error('Falha na operação.'); return null; }
    finally { setBusy(false); }
  };

  const lancar = (direction: 'in' | 'out') => {
    const v = window.prompt(direction === 'in' ? 'Entrada de caixa (R$):' : 'Saída de caixa (R$):');
    if (v == null) return;
    const amount = Number(v.replace(',', '.'));
    if (!(amount > 0)) return;
    const note = window.prompt('Descrição (opcional):') || undefined;
    post('/api/cash/events', { direction, amount, note }).then((d) => d && toast.success('Lançado no caixa.'));
  };
  const novaConta = (tipo: 'payable' | 'receivable') => {
    const desc = window.prompt(tipo === 'payable' ? 'Conta a PAGAR — descrição:' : 'Conta a RECEBER — descrição:');
    if (!desc) return;
    const v = window.prompt('Valor (R$):'); if (v == null) return;
    const amount = Number(v.replace(',', '.')); if (!(amount > 0)) return;
    const due = window.prompt('Vencimento (AAAA-MM-DD):', todayStr()) || todayStr();
    const url = tipo === 'payable' ? '/api/cash/payables' : '/api/cash/receivables';
    post(url, { description: desc, amount, dueDate: due }).then((d) => d && toast.success('Cadastrada.'));
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando…</div>;
  const s = data?.summary;

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-2.5"><Wallet className="w-6 h-6 text-emerald-300" /></div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Caixa</h2>
            <p className="text-sm text-zinc-400">Só o dinheiro que <strong>entrou de fato</strong> é caixa. Fiado e contas a receber ficam em "a receber" — não é caixa até cair na mão.</p>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="text-[11px] uppercase tracking-wide text-emerald-400/80">Caixa atual</div>
            <div className="text-2xl font-semibold text-emerald-200 mt-1">{brl(s?.caixaAtual)}</div>
          </div>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="text-[11px] uppercase tracking-wide text-amber-400/80">A receber</div>
            <div className="text-2xl font-semibold text-amber-200 mt-1">{brl(s?.aReceber)}</div>
            <div className="text-[11px] text-amber-300/70 mt-0.5">fiado {brl(s?.aReceberDetalhe?.fiado)} · outros {brl(s?.aReceberDetalhe?.manual)}</div>
          </div>
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
            <div className="text-[11px] uppercase tracking-wide text-red-400/80">A pagar</div>
            <div className="text-2xl font-semibold text-red-200 mt-1">{brl(s?.aPagar)}</div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1 text-emerald-300"><TrendingUp className="w-4 h-4" /> Entrou hoje: {brl(s?.realizadoHoje?.inflow)}</span>
          <span className="inline-flex items-center gap-1 text-red-300"><TrendingDown className="w-4 h-4" /> Saiu hoje: {brl(s?.realizadoHoje?.outflow)}</span>
          <span className="text-zinc-500">· 7 dias: líquido {brl(s?.realizado7d?.net)}</span>
        </div>

        {/* Ações rápidas */}
        <div className="mt-4 flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => lancar('in')} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-3 py-2 disabled:opacity-50"><ArrowDownCircle className="w-4 h-4" /> Entrada</button>
          <button disabled={busy} onClick={() => lancar('out')} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm px-3 py-2 disabled:opacity-50"><ArrowUpCircle className="w-4 h-4" /> Saída</button>
          <button disabled={busy} onClick={() => novaConta('payable')} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 text-sm px-3 py-2"><Plus className="w-4 h-4" /> Conta a pagar</button>
          <button disabled={busy} onClick={() => novaConta('receivable')} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 text-sm px-3 py-2"><Plus className="w-4 h-4" /> Conta a receber</button>
        </div>

        {/* Listas */}
        <div className="mt-5 grid md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <h3 className="text-sm font-medium text-red-200 mb-2">Contas a pagar</h3>
            {(!data?.payables || data.payables.length === 0) ? <div className="text-[13px] text-zinc-500">Nada em aberto.</div> : (
              <div className="space-y-1.5">
                {data.payables.map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                    <div className="min-w-0"><div className="truncate text-[13px] text-zinc-100">{p.description}</div><div className="text-[11px] text-zinc-500">vence {p.due_date}</div></div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[13px] text-red-300">{brl(p.amount)}</span>
                      <button disabled={busy} onClick={() => post(`/api/cash/payables/${p.id}/pay`, {}).then((d) => d && toast.success('Baixado no caixa.'))} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1"><Check className="w-3 h-3" /> Paguei</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <h3 className="text-sm font-medium text-amber-200 mb-2">Contas a receber</h3>
            {(!data?.receivables || data.receivables.length === 0) ? <div className="text-[13px] text-zinc-500">Nada em aberto. <span className="text-zinc-600">(o fiado do Balcão entra no total acima)</span></div> : (
              <div className="space-y-1.5">
                {data.receivables.map((r: any) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                    <div className="min-w-0"><div className="truncate text-[13px] text-zinc-100">{r.description}</div><div className="text-[11px] text-zinc-500">vence {r.due_date}</div></div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[13px] text-amber-300">{brl(r.amount)}</span>
                      <button disabled={busy} onClick={() => post(`/api/cash/receivables/${r.id}/receive`, {}).then((d) => d && toast.success('Entrou no caixa.'))} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1"><Check className="w-3 h-3" /> Recebi</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Últimos lançamentos */}
        {data?.recentEvents?.length > 0 && (
          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <h3 className="text-sm font-medium text-zinc-200 mb-2">Últimos lançamentos</h3>
            <div className="space-y-1">
              {data.recentEvents.map((e: any) => (
                <div key={e.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="min-w-0 truncate text-zinc-400">{e.event_date} · {e.note || e.source_type}</span>
                  <span className={e.direction === 'in' ? 'text-emerald-300' : 'text-red-300'}>{e.direction === 'in' ? '+' : '−'}{brl(e.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
