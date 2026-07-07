import React, { useEffect, useState } from 'react';
import { BarChart3, RefreshCw, ShoppingCart, DollarSign, Receipt, CheckCircle2, Calendar, Users } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

type Pair = { d30: number; all: number };
type Summary = {
  orders: Pair; revenue: Pair; ticket: Pair;
  paidOrders: Pair; appointments: Pair; contacts: Pair;
};

const brl = (v: number) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
const int = (v: number) => String(Math.round(Number(v || 0)));

export function ReportsPanel() {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    apiFetch('/api/analytics/sales-summary')
      .then(r => r.json())
      .then((d) => setData(d && d.orders ? d : null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const cards = data ? [
    { icon: <ShoppingCart className="w-5 h-5" />, label: 'Pedidos (não cancelados)', fmt: int, pair: data.orders, accent: 'text-emerald-400' },
    { icon: <DollarSign className="w-5 h-5" />, label: 'Faturamento', fmt: brl, pair: data.revenue, accent: 'text-emerald-400' },
    { icon: <Receipt className="w-5 h-5" />, label: 'Ticket médio', fmt: brl, pair: data.ticket, accent: 'text-indigo-400' },
    { icon: <CheckCircle2 className="w-5 h-5" />, label: 'Pedidos pagos', fmt: int, pair: data.paidOrders, accent: 'text-emerald-400' },
    { icon: <Calendar className="w-5 h-5" />, label: 'Agendamentos', fmt: int, pair: data.appointments, accent: 'text-sky-400' },
    { icon: <Users className="w-5 h-5" />, label: 'Contatos', fmt: int, pair: data.contacts, accent: 'text-amber-400' },
  ] : [];

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="flex justify-between items-center mb-6">
        <div>
          <p className="zf-kicker mb-1">30 Dias × Total</p>
          <h2 className="zf-page-title flex items-center gap-2">
            <BarChart3 className="w-6 h-6" style={{ color: 'var(--color-flow)' }} />
            Relatórios de vendas
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Resumo dos últimos 30 dias comparado com o total geral.</p>
        </div>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20 text-zinc-500">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Carregando…
        </div>
      ) : !data ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-400">
          Não foi possível carregar os relatórios agora. Tente atualizar.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {cards.map((c, i) => (
            <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="flex items-center gap-2 text-zinc-400 text-sm">
                <span className={c.accent}>{c.icon}</span>
                {c.label}
              </div>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500">Últimos 30 dias</p>
                  <p className={`text-2xl font-bold ${c.accent}`}>{c.fmt(c.pair.d30)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] uppercase tracking-wider text-zinc-500">Total geral</p>
                  <p className="text-lg font-semibold text-zinc-300">{c.fmt(c.pair.all)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="mt-6 text-xs text-zinc-500">
        Dica: na aba <span className="text-zinc-300">Integrações</span> você pode exportar este resumo (e os dados completos) para o Google Sheets.
      </p>
    </div>
  );
}
