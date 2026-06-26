import React, { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { PackageCheck, Check, X as XIcon, AlertTriangle, Truck, Trophy } from 'lucide-react';

type ReqItem = {
  id: string;
  product_service_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  current_stock: number;
  threshold: number;
  suggested_qty: number;
  avg_daily_consumption: number | null;
  days_of_cover: number | null;
  unit_price: number | null;
};

type QuoteItem = { id: string; product_service_id: string; product_name: string; unit_price: number; available_qty: number | null; line_total: number };
type Quote = {
  id: string; requisition_id: string; supplier_contact_id: string; supplier_name: string;
  status: 'sent' | 'answered' | 'accepted' | 'rejected';
  delivery_days: number | null; total_amount: number | null; notes: string | null;
  sent_at: string; answered_at: string | null; accepted_at: string | null;
  items: QuoteItem[];
};

type Supplier = { id: string; name: string; identifier: string; supplier_categories: string | null };
type Settings = { enabled: boolean; targetDays: number };

const brl = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

export function ProcurementView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [requisition, setRequisition] = useState<any>(null);
  const [items, setItems] = useState<ReqItem[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSettings = () => apiFetch('/api/procurement/settings').then(r => r.json()).then(setSettings).catch(() => {});
  const loadSuppliers = () => apiFetch('/api/procurement/suppliers').then(r => r.json()).then(d => setSuppliers(Array.isArray(d) ? d : [])).catch(() => {});
  const loadRequisition = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/procurement/requisition');
      const data = await r.json();
      setRequisition(data.requisition || null);
      setItems(Array.isArray(data.items) ? data.items : []);
      // Se já está aprovada (ou virou pedido), carrega as cotações associadas.
      if (data.requisition?.id) {
        const q = await apiFetch(`/api/procurement/requisition/${data.requisition.id}/quotes`).then(x => x.json()).catch(() => []);
        setQuotes(Array.isArray(q) ? q : []);
      } else setQuotes([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { loadSettings(); loadSuppliers(); loadRequisition(); const t = setInterval(loadRequisition, 30_000); return () => clearInterval(t); }, []);

  const saveSettings = async (patch: Partial<Settings>) => {
    const next = { enabled: settings?.enabled || false, targetDays: settings?.targetDays || 14, ...patch };
    setSettings(next);
    await apiFetch('/api/procurement/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
    loadRequisition();
  };

  const approve = async () => {
    if (!requisition?.id) return;
    const r = await apiFetch(`/api/procurement/requisition/${requisition.id}/approve`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (d?.quotesSent != null) alert(`Aprovado! Cotação enviada para ${d.quotesSent} fornecedor(es).`);
    loadRequisition();
  };
  const dismiss = async () => {
    if (!requisition?.id) return;
    await apiFetch(`/api/procurement/requisition/${requisition.id}/dismiss`, { method: 'POST' });
    loadRequisition();
  };
  const acceptQuote = async (quoteId: string) => {
    await apiFetch(`/api/procurement/quote/${quoteId}/accept`, { method: 'POST' });
    loadRequisition();
  };

  const totalEstimado = items.reduce((acc, it) => acc + ((it.unit_price || 0) * (it.suggested_qty || 0)), 0);
  const draft = requisition?.status === 'draft';
  const bestQuote = quotes.filter(q => q.status === 'answered' && q.total_amount != null).sort((a, b) => (a.total_amount || 0) - (b.total_amount || 0))[0];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <PackageCheck className="h-6 w-6 text-indigo-400" /> Compras / Reposição
        </h2>
      </div>
      <p className="text-sm text-zinc-400 mb-6">
        A IA observa o estoque, propõe a lista de reposição e — após sua aprovação —
        <b> cota com os fornecedores cadastrados</b>. Você escolhe o vencedor com um clique.
      </p>

      {/* Configuração */}
      {settings && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">⚙️ Reposição inteligente</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Cobre os próximos{' '}
                <input type="number" min="1" value={settings.targetDays}
                  onChange={e => setSettings({ ...settings, targetDays: parseInt(e.target.value, 10) || 14 })}
                  onBlur={e => saveSettings({ targetDays: parseInt(e.target.value, 10) || 14 })}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1 text-center text-zinc-200" /> dias com base no consumo médio (saídas dos últimos 30 dias).
              </p>
            </div>
            <button onClick={() => saveSettings({ enabled: !settings.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Fornecedores cadastrados (atalho informativo). */}
      {suppliers.length === 0 && (
        <div className="mb-6 rounded-xl border border-amber-700/30 bg-amber-500/5 p-3 text-xs">
          <p className="text-amber-300 font-medium">Cadastre fornecedores para receber cotações automáticas.</p>
          <p className="text-zinc-400 mt-1">Vá em <i>Contatos</i>, marque os contatos que são fornecedores como <b>“Fornecedor”</b> e (opcional) adicione as <b>categorias</b> que ele atende.</p>
        </div>
      )}
      {suppliers.length > 0 && (
        <div className="mb-6">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Fornecedores cadastrados ({suppliers.length})</p>
          <div className="flex flex-wrap gap-2">
            {suppliers.map(s => (
              <span key={s.id} className="text-xs bg-zinc-900 border border-zinc-800 rounded-full px-3 py-1 text-zinc-300">
                <Truck className="inline w-3 h-3 mr-1 text-indigo-400" />{s.name}
                {s.supplier_categories ? <span className="text-zinc-500"> · {s.supplier_categories}</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Requisição em andamento (rascunho ou aprovada com cotações). */}
      {loading ? (
        <p className="text-sm text-zinc-500">Carregando...</p>
      ) : items.length === 0 && quotes.length === 0 ? (
        <div className="rounded-xl border border-emerald-700/30 bg-emerald-500/5 p-6 text-center">
          <p className="text-emerald-300 font-medium">✅ Tudo em ordem por aqui</p>
          <p className="text-xs text-zinc-500 mt-1">Nenhum produto abaixo do mínimo crítico no momento.</p>
          <p className="text-xs text-zinc-500 mt-3">Defina o mínimo crítico em <i>Catálogo</i> para a IA monitorar o item.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between p-4 border-b border-zinc-800">
            <div>
              <p className="text-sm font-medium text-zinc-100 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                {items.length > 0
                  ? `${items.length} item(ns) abaixo do mínimo crítico`
                  : `Requisição aprovada — aguardando cotações`}
              </p>
              {items.length > 0 && (
                <p className="text-xs text-zinc-500 mt-1">Estimativa total: <b className="text-zinc-200">{brl(totalEstimado)}</b> (preço de venda — não custo).</p>
              )}
            </div>
            {draft && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-8 bg-zinc-900 border-zinc-700 hover:bg-zinc-800" onClick={dismiss}>
                  <XIcon className="w-3 h-3 mr-2" /> Descartar
                </Button>
                <Button size="sm" className="h-8 bg-emerald-600 hover:bg-emerald-700" onClick={approve}>
                  <Check className="w-3 h-3 mr-2" /> Aprovar e cotar
                </Button>
              </div>
            )}
          </div>

          {items.length > 0 && (
            <div className="divide-y divide-zinc-800">
              {items.map(it => (
                <div key={it.id} className="p-4 grid grid-cols-12 gap-3 items-center">
                  <div className="col-span-5">
                    <p className="text-sm text-zinc-100">
                      {it.product_name}{it.variant_name ? <span className="text-zinc-400"> ({it.variant_name})</span> : null}
                    </p>
                    <p className="text-xs text-zinc-500">
                      consumo médio: {it.avg_daily_consumption ? `${it.avg_daily_consumption}/dia` : 'sem histórico'}
                    </p>
                  </div>
                  <div className="col-span-2 text-xs"><p className="text-zinc-400">Em estoque</p><p className="font-mono text-rose-300 font-semibold">{it.current_stock}</p></div>
                  <div className="col-span-2 text-xs"><p className="text-zinc-400">Mínimo</p><p className="font-mono text-zinc-300">{it.threshold}</p></div>
                  <div className="col-span-1 text-xs"><p className="text-zinc-400">Cobertura</p><p className="font-mono text-amber-300">{it.days_of_cover != null ? `${it.days_of_cover} d` : '—'}</p></div>
                  <div className="col-span-2 text-right"><p className="text-xs text-zinc-400">Sugerido</p><p className="text-lg font-bold text-emerald-300">{it.suggested_qty}</p></div>
                </div>
              ))}
            </div>
          )}

          {/* Comparativo de cotações (Fase 2). */}
          {quotes.length > 0 && (
            <div className="border-t border-zinc-800">
              <div className="p-4">
                <p className="text-sm font-medium text-zinc-100 mb-2">Cotações dos fornecedores</p>
                <p className="text-xs text-zinc-500 mb-3">A IA está parseando as respostas dos fornecedores no WhatsApp em tempo real. O melhor preço entre os que responderam fica destacado.</p>
              </div>
              <div className="divide-y divide-zinc-800">
                {quotes.map(q => {
                  const isBest = bestQuote && q.id === bestQuote.id;
                  const isAccepted = q.status === 'accepted';
                  const isRejected = q.status === 'rejected';
                  const waiting = q.status === 'sent';
                  return (
                    <div key={q.id} className={`p-4 ${isAccepted ? 'bg-emerald-500/5' : isBest ? 'bg-indigo-500/5' : ''} ${isRejected ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-zinc-100 flex items-center gap-2">
                            <Truck className="w-4 h-4 text-indigo-400" /> {q.supplier_name}
                            {isAccepted && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Vencedor</span>}
                            {!isAccepted && isBest && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 flex items-center gap-1"><Trophy className="w-2.5 h-2.5" /> Melhor preço</span>}
                            {waiting && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-zinc-700 text-zinc-300">Aguardando resposta</span>}
                            {isRejected && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-zinc-800 text-zinc-500">Não escolhido</span>}
                          </p>
                          <p className="text-xs text-zinc-500 mt-0.5">
                            {q.total_amount != null ? <>Total: <b className="text-zinc-200">{brl(q.total_amount)}</b></> : 'sem total ainda'}
                            {q.delivery_days != null && <> · entrega em <b className="text-zinc-200">{q.delivery_days} dia(s)</b></>}
                          </p>
                        </div>
                        {!isAccepted && !isRejected && q.status === 'answered' && (
                          <Button size="sm" className="h-8 bg-emerald-600 hover:bg-emerald-700" onClick={() => acceptQuote(q.id)}>
                            <Check className="w-3 h-3 mr-2" /> Confirmar com {q.supplier_name.split(' ')[0]}
                          </Button>
                        )}
                      </div>
                      {q.items.length > 0 && (
                        <div className="mt-3 grid grid-cols-12 text-xs text-zinc-400">
                          {q.items.map(it => (
                            <React.Fragment key={it.id}>
                              <div className="col-span-6 py-1 text-zinc-300">{it.product_name}</div>
                              <div className="col-span-2 py-1 text-right">{brl(it.unit_price)}</div>
                              <div className="col-span-2 py-1 text-right">{it.available_qty != null ? `${it.available_qty} disp.` : '—'}</div>
                              <div className="col-span-2 py-1 text-right text-zinc-200">{brl(it.line_total)}</div>
                            </React.Fragment>
                          ))}
                        </div>
                      )}
                      {q.notes && <p className="text-xs text-zinc-500 mt-2">📝 {q.notes}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="p-3 text-[11px] text-zinc-500 border-t border-zinc-800">
            Sugestão = maior valor entre <i>repor até o mínimo</i> e <i>cobrir os próximos {settings?.targetDays ?? 14} dias</i> de consumo médio.
            Ao aprovar, a IA dispara a cotação automaticamente nos fornecedores via WhatsApp e parseia as respostas.
          </div>
        </div>
      )}
    </div>
  );
}
