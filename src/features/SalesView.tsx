import React, { useState, useEffect } from 'react';
import { ShoppingCart, RefreshCw, AlertTriangle, Bot, CheckCircle2, CreditCard, Download } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { PaymentSettingsModal } from '@/src/features/PaymentSettingsModal';
import { EmptyState } from '@/src/components/EmptyState';

type OrderItem = { id: string; name_snapshot: string; quantity: number; unit_price: number; line_total: number };
type Order = {
  id: string; status: string; total_amount: number; currency?: string;
  created_by?: string; created_at: string; contact_name?: string; contact_number?: string;
  payment_status?: string;
  items: OrderItem[];
};

const STATUS: Record<string, { label: string; color: string }> = {
  aguardando_pagamento: { label: 'Aguardando pagamento', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  pago: { label: 'Pago', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  em_preparo: { label: 'Em preparo', color: 'bg-sky-500/10 text-sky-400 border-sky-500/30' },
  entregue: { label: 'Entregue', color: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30' },
  concluido: { label: 'Concluído', color: 'bg-emerald-600/10 text-emerald-300 border-emerald-600/30' },
  cancelado: { label: 'Cancelado', color: 'bg-zinc-600/10 text-zinc-400 border-zinc-600/30' },
  reembolso: { label: 'Reembolso', color: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
  devolucao: { label: 'Devolução', color: 'bg-rose-600/10 text-rose-300 border-rose-600/30' },
};

// Próximas transições possíveis por status (rótulo do botão -> novo status)
const TRANSITIONS: Record<string, { label: string; to: string; danger?: boolean }[]> = {
  aguardando_pagamento: [{ label: 'Confirmar pagamento', to: 'pago' }, { label: 'Cancelar', to: 'cancelado', danger: true }],
  pago: [{ label: 'Em preparo', to: 'em_preparo' }, { label: 'Marcar entregue', to: 'entregue' }, { label: 'Reembolsar', to: 'reembolso', danger: true }],
  em_preparo: [{ label: 'Marcar entregue', to: 'entregue' }, { label: 'Reembolsar', to: 'reembolso', danger: true }],
  entregue: [{ label: 'Concluir', to: 'concluido' }, { label: 'Devolução', to: 'devolucao', danger: true }],
  concluido: [{ label: 'Devolução', to: 'devolucao', danger: true }],
};

const FILTERS = ['todos', 'aguardando_pagamento', 'pago', 'em_preparo', 'entregue', 'concluido', 'reembolso', 'devolucao', 'cancelado'];

const PERIODS: { id: string; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: 'week', label: '7 dias' },
  { id: 'month', label: '30 dias' },
  { id: 'all', label: 'Tudo' },
];

export function SalesView() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [summary, setSummary] = useState<{ byStatus: any[]; revenue: number }>({ byStatus: [], revenue: 0 });
  const [filter, setFilter] = useState('todos');
  const [period, setPeriod] = useState('month');
  const [loading, setLoading] = useState(true);
  const [autoClose, setAutoClose] = useState(false);
  const [lowStock, setLowStock] = useState<any[]>([]);
  const [showPayments, setShowPayments] = useState(false);
  const [neg, setNeg] = useState<{ enabled: boolean; max: number; rules: string }>({ enabled: false, max: 0, rules: '' });

  // Monta a query string com status (se houver) e período (se != 'all').
  const buildQuery = () => {
    const p: string[] = [];
    if (filter !== 'todos') p.push(`status=${filter}`);
    if (period !== 'all') p.push(`period=${period}`);
    return p.length ? `?${p.join('&')}` : '';
  };

  const load = () => {
    setLoading(true);
    const q = buildQuery();
    const sumQ = period !== 'all' ? `?period=${period}` : '';
    Promise.all([
      apiFetch(`/api/orders${q}`).then(r => r.json()).catch(() => []),
      apiFetch(`/api/orders/summary${sumQ}`).then(r => r.json()).catch(() => ({ byStatus: [], revenue: 0 })),
      apiFetch('/api/orders/settings').then(r => r.json()).catch(() => ({ ai_auto_close_sales: false })),
      apiFetch('/api/products').then(r => r.json()).catch(() => []),
    ]).then(([ord, sum, set, prods]) => {
      setOrders(Array.isArray(ord) ? ord : []);
      setSummary(sum || { byStatus: [], revenue: 0 });
      setAutoClose(!!set?.ai_auto_close_sales);
      setNeg({ enabled: !!set?.negotiator_enabled, max: set?.negotiator_max_discount || 0, rules: set?.negotiator_rules || '' });
      setLowStock((Array.isArray(prods) ? prods : []).filter((p: any) => p.stock_control_enabled && (p.sellable ?? 0) <= (p.low_stock_threshold || 0)));
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter, period]);

  const exportCsv = async () => {
    try {
      const res = await apiFetch(`/api/orders/export.csv${buildQuery()}`);
      if (!res.ok) { alert('Não foi possível exportar.'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `vendas-${period}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert('Não foi possível exportar.'); }
  };

  const changeStatus = async (id: string, to: string) => {
    try {
      const res = await apiFetch(`/api/orders/${id}/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: to }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Erro ao atualizar'); return; }
      load();
    } catch (e) { alert('Erro ao atualizar'); }
  };

  const toggleAutonomy = async () => {
    const next = !autoClose;
    setAutoClose(next);
    try {
      await apiFetch('/api/orders/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_auto_close_sales: next }),
      });
    } catch (e) { setAutoClose(!next); }
  };

  const saveNeg = async (patch: Partial<{ enabled: boolean; max: number; rules: string }>) => {
    const nx = { ...neg, ...patch };
    setNeg(nx);
    await apiFetch('/api/orders/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ negotiator_enabled: nx.enabled, negotiator_max_discount: nx.max, negotiator_rules: nx.rules }),
    }).catch(() => {});
  };

  const confirmPayment = async (id: string) => {
    try {
      const res = await apiFetch(`/api/payments/orders/${id}/confirm`, { method: 'POST' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error || 'Erro'); return; }
      load();
    } catch (e) { alert('Erro ao confirmar pagamento'); }
  };

  const countFor = (s: string) => summary.byStatus.find((b: any) => b.status === s)?.count || 0;
  const brl = (v: number) => `R$ ${Number(v || 0).toFixed(2)}`;

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="flex flex-wrap justify-between items-start gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <ShoppingCart className="w-6 h-6 text-indigo-400" /> Vendas
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Pedidos, estoque e status de entrega — vendas pelo WhatsApp via IA</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
        <div className="flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
          {PERIODS.map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${period === p.id ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
              {p.label}
            </button>
          ))}
        </div>
        <button onClick={exportCsv} className="inline-flex items-center gap-2 text-sm text-zinc-300 border border-zinc-800 rounded-lg px-3 py-2 hover:border-indigo-500/40">
          <Download className="w-4 h-4 text-indigo-400" /> CSV
        </button>
        <button onClick={() => setShowPayments(true)} className="inline-flex items-center gap-2 text-sm text-zinc-300 border border-zinc-800 rounded-lg px-3 py-2 hover:border-emerald-500/40">
          <CreditCard className="w-4 h-4 text-emerald-400" /> Pagamentos
        </button>
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-zinc-300 border border-zinc-800 rounded-lg px-3 py-2 hover:border-indigo-500/40">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
        </div>
      </div>

      {showPayments && <PaymentSettingsModal onClose={() => setShowPayments(false)} />}

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <SummaryCard label="Receita confirmada" value={brl(summary.revenue)} accent="text-emerald-400" />
        <SummaryCard label="Aguardando pagamento" value={String(countFor('aguardando_pagamento'))} accent="text-amber-400" />
        <SummaryCard label="Entregues" value={String(countFor('entregue') + countFor('concluido'))} accent="text-indigo-400" />
        <SummaryCard label="Reembolsos/Devoluções" value={String(countFor('reembolso') + countFor('devolucao'))} accent="text-rose-400" />
      </div>

      {/* Autonomia da IA + alerta de estoque */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex items-center justify-between">
          <div className="flex items-start gap-3">
            <Bot className="w-5 h-5 text-indigo-400 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-zinc-100">Autonomia da IA nas vendas</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {autoClose
                  ? 'IA fecha a venda e baixa o estoque automaticamente.'
                  : 'IA reserva o estoque; você confirma o pagamento para baixar.'}
              </p>
            </div>
          </div>
          <button onClick={toggleAutonomy}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoClose ? 'bg-indigo-600' : 'bg-zinc-700'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoClose ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <p className="text-sm font-medium text-zinc-100 flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-rose-400" /> Estoque baixo
          </p>
          {lowStock.length === 0 ? (
            <p className="text-xs text-zinc-500">Tudo certo com o estoque. ✅</p>
          ) : (
            <div className="space-y-1 max-h-24 overflow-auto">
              {lowStock.map((p: any) => (
                <div key={p.id} className="flex justify-between text-xs">
                  <span className="text-zinc-300 truncate pr-2">{p.name}</span>
                  <span className="text-rose-400 font-mono">{p.sellable ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Negociador */}
      <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-100">🤝 Negociador da IA</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              A IA negocia preço <strong>só quando o cliente aciona</strong> (pede desconto, acha caro, vai desistir) e <strong>nunca abaixo do preço mínimo</strong> de cada produto (definido no Catálogo).
            </p>
          </div>
          <button onClick={() => saveNeg({ enabled: !neg.enabled })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${neg.enabled ? 'bg-indigo-600' : 'bg-zinc-700'}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${neg.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        {neg.enabled && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              Desconto máximo:
              <input type="number" min="0" max="90" value={neg.max}
                onChange={e => setNeg({ ...neg, max: parseInt(e.target.value, 10) || 0 })}
                onBlur={e => saveNeg({ max: parseInt(e.target.value, 10) || 0 })}
                className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-zinc-200 text-center" /> %
              <span className="text-xs text-zinc-600">(0 = só até o preço mínimo do produto)</span>
            </div>
            <textarea
              className="w-full h-16 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none"
              placeholder="Regras extras para a IA negociar (opcional). Ex.: priorize pagamento à vista; ofereça brinde antes de baixar o preço."
              value={neg.rules}
              onChange={e => setNeg({ ...neg, rules: e.target.value })}
              onBlur={e => saveNeg({ rules: e.target.value })}
            />
          </div>
        )}
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${filter === f ? 'bg-indigo-600 text-white border-indigo-600' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
            {f === 'todos' ? 'Todos' : STATUS[f]?.label || f}
          </button>
        ))}
      </div>

      {/* Lista de pedidos */}
      {loading ? (
        <p className="text-zinc-500 text-sm py-8 text-center">Carregando...</p>
      ) : orders.length === 0 ? (
        filter !== 'todos' ? (
          <div className="py-12 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/30">
            Nenhum pedido com status "{STATUS[filter]?.label || filter}" neste período.
          </div>
        ) : (
          <EmptyState
            icon={<ShoppingCart className="w-6 h-6" />}
            title="Nenhuma venda ainda"
            description="Quando a IA fechar um pedido pelo WhatsApp (ou você criar um manualmente), ele aparece aqui com status, pagamento e estoque. Garanta que o catálogo e a IA estão configurados."
          />
        )
      ) : (
        <div className="space-y-3">
          {orders.map(o => {
            const st = STATUS[o.status] || { label: o.status, color: 'bg-zinc-700/10 text-zinc-400 border-zinc-700/30' };
            const transitions = TRANSITIONS[o.status] || [];
            return (
              <div key={o.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-zinc-100">{o.contact_name || o.contact_number || 'Cliente'}</span>
                      {o.created_by === 'ai' && <span className="inline-flex items-center gap-1 text-[10px] text-indigo-300 bg-indigo-500/10 rounded px-1.5 py-0.5"><Bot className="w-3 h-3" /> IA</span>}
                      <span className={`text-[11px] px-2 py-0.5 rounded border ${st.color}`}>{st.label}</span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-0.5">#{o.id.slice(0, 8)} • {new Date(o.created_at).toLocaleString('pt-BR')}</p>
                    <div className="mt-2 text-sm text-zinc-300 space-y-0.5">
                      {o.items.map(it => (
                        <div key={it.id} className="text-zinc-400">
                          {it.quantity}× {it.name_snapshot} <span className="text-zinc-600">— {brl(it.line_total)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-zinc-100">{brl(o.total_amount)}</p>
                    {o.payment_status === 'paid' && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 mt-1"><CheckCircle2 className="w-3 h-3" /> pago</span>
                    )}
                    <div className="flex flex-wrap gap-2 justify-end mt-2">
                      {o.status === 'aguardando_pagamento' && o.payment_status !== 'paid' && (
                        <button onClick={() => confirmPayment(o.id)}
                          className="text-xs px-2.5 py-1.5 rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10">
                          Confirmar pagamento
                        </button>
                      )}
                      {transitions.length === 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs text-zinc-500"><CheckCircle2 className="w-3.5 h-3.5" /> finalizado</span>
                      ) : transitions.map(t => (
                        <button key={t.to} onClick={() => changeStatus(o.id, t.to)}
                          className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${t.danger ? 'border-rose-500/30 text-rose-400 hover:bg-rose-500/10' : 'border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10'}`}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-bold mt-1 ${accent}`}>{value}</p>
    </div>
  );
}
