import React, { useEffect, useState } from 'react';
import { X, Plus, ArrowDownToLine, ArrowUpFromLine, RotateCcw } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

type Product = { id: string; name: string; quantity_available?: number; sellable?: number | null };

const MOV_LABEL: Record<string, string> = {
  entrada: 'Entrada', saida: 'Saída', ajuste: 'Ajuste', transferencia: 'Transferência',
};

export function StockModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const [variants, setVariants] = useState<any[]>([]);
  const [movements, setMovements] = useState<any[]>([]);
  const [tab, setTab] = useState<'mov' | 'var'>('mov');

  // form de movimentação
  const [mov, setMov] = useState({ type: 'entrada', quantity: '', unit_cost: '', origin: 'loja física', note: '', variant_id: '' });
  // form de variação
  const [vform, setVform] = useState({ size: '', color: '', variant_type: '', price: '', initial_stock: '' });

  const load = () => {
    apiFetch(`/api/products/${product.id}/variants`).then(r => r.json()).then(d => setVariants(Array.isArray(d) ? d : [])).catch(() => {});
    apiFetch(`/api/products/${product.id}/movements`).then(r => r.json()).then(d => setMovements(Array.isArray(d) ? d : [])).catch(() => {});
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [product.id]);

  const addMovement = async () => {
    if (!mov.quantity) return;
    const res = await apiFetch(`/api/products/${product.id}/movements`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...mov, variant_id: mov.variant_id || undefined }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setMov({ ...mov, quantity: '', unit_cost: '', note: '' }); load(); }
    else toast.error(d.error || 'Erro ao registrar movimentação');
  };

  const addVariant = async () => {
    const label = [vform.size, vform.color, vform.variant_type].filter(Boolean).join(' / ');
    if (!label) { toast.info('Informe tamanho, cor ou tipo.'); return; }
    const res = await apiFetch(`/api/products/${product.id}/variants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...vform, price: vform.price ? parseFloat(vform.price) : undefined, initial_stock: vform.initial_stock ? parseInt(vform.initial_stock, 10) : 0 }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setVform({ size: '', color: '', variant_type: '', price: '', initial_stock: '' }); load(); }
    else toast.error(d.error || 'Erro ao criar variação');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[640px] max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-semibold text-zinc-100">Estoque — {product.name}</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-zinc-500 mb-4">Disponível atual: <strong className="text-zinc-300">{product.sellable ?? product.quantity_available ?? 0}</strong></p>

        <div className="flex gap-2 mb-4">
          <button onClick={() => setTab('mov')} className={`text-xs px-3 py-1.5 rounded-lg border ${tab === 'mov' ? 'bg-indigo-600 text-white border-indigo-600' : 'border-zinc-800 text-zinc-400'}`}>Movimentações</button>
          <button onClick={() => setTab('var')} className={`text-xs px-3 py-1.5 rounded-lg border ${tab === 'var' ? 'bg-indigo-600 text-white border-indigo-600' : 'border-zinc-800 text-zinc-400'}`}>Variações (tamanho/cor/tipo)</button>
        </div>

        {tab === 'mov' && (
          <div className="space-y-4">
            {/* Form de movimentação */}
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
              <p className="text-sm font-medium text-zinc-200">Registrar movimentação</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={mov.type} onChange={e => setMov({ ...mov, type: e.target.value })}>
                  <option value="entrada">Entrada (recebi mercadoria)</option>
                  <option value="saida">Saída (perda/uso)</option>
                  <option value="transferencia">Transferência (loja física → e-commerce)</option>
                  <option value="ajuste">Ajuste de inventário (define o total)</option>
                </select>
                {variants.length > 0 && (
                  <select className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={mov.variant_id} onChange={e => setMov({ ...mov, variant_id: e.target.value })}>
                    <option value="">Produto (sem variação)</option>
                    {variants.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                )}
                <input type="number" min="0" placeholder="Quantidade" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={mov.quantity} onChange={e => setMov({ ...mov, quantity: e.target.value })} />
                <input type="number" step="0.01" placeholder="Custo unitário (R$)" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={mov.unit_cost} onChange={e => setMov({ ...mov, unit_cost: e.target.value })} />
                <input placeholder="Origem (ex.: loja física)" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={mov.origin} onChange={e => setMov({ ...mov, origin: e.target.value })} />
                <input placeholder="Observação (opcional)" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={mov.note} onChange={e => setMov({ ...mov, note: e.target.value })} />
              </div>
              <Button onClick={addMovement} className="bg-indigo-600 hover:bg-indigo-700 text-white w-full"><Plus className="w-4 h-4 mr-1" /> Registrar</Button>
            </div>

            {/* Histórico */}
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2">Histórico</p>
              {movements.length === 0 ? (
                <p className="text-sm text-zinc-500">Nenhuma movimentação ainda.</p>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-auto">
                  {movements.map(m => {
                    const inbound = m.type === 'entrada' || m.type === 'transferencia';
                    return (
                      <div key={m.id} className="flex items-center justify-between text-sm border border-zinc-800 rounded-lg px-3 py-2">
                        <div className="flex items-center gap-2">
                          {m.type === 'ajuste' ? <RotateCcw className="w-3.5 h-3.5 text-amber-400" /> : inbound ? <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-400" /> : <ArrowUpFromLine className="w-3.5 h-3.5 text-rose-400" />}
                          <span className="text-zinc-300">{MOV_LABEL[m.type]} {m.variant_name ? `· ${m.variant_name}` : ''}</span>
                          {m.origin && <span className="text-xs text-zinc-600">({m.origin})</span>}
                        </div>
                        <div className="text-right">
                          <span className={`font-mono ${inbound ? 'text-emerald-400' : m.type === 'ajuste' ? 'text-amber-400' : 'text-rose-400'}`}>
                            {inbound ? '+' : m.type === 'ajuste' ? '=' : '−'}{m.quantity}
                          </span>
                          {m.unit_cost > 0 && <span className="text-[11px] text-zinc-500 ml-2">R$ {Number(m.unit_cost).toFixed(2)}/un</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'var' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
              <p className="text-sm font-medium text-zinc-200">Nova variação</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input placeholder="Tamanho (P/M/G)" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={vform.size} onChange={e => setVform({ ...vform, size: e.target.value })} />
                <input placeholder="Cor" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={vform.color} onChange={e => setVform({ ...vform, color: e.target.value })} />
                <input placeholder="Tipo" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={vform.variant_type} onChange={e => setVform({ ...vform, variant_type: e.target.value })} />
                <input type="number" step="0.01" placeholder="Preço (opcional)" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={vform.price} onChange={e => setVform({ ...vform, price: e.target.value })} />
                <input type="number" min="0" placeholder="Estoque inicial" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={vform.initial_stock} onChange={e => setVform({ ...vform, initial_stock: e.target.value })} />
              </div>
              <Button onClick={addVariant} className="bg-indigo-600 hover:bg-indigo-700 text-white w-full"><Plus className="w-4 h-4 mr-1" /> Adicionar variação</Button>
            </div>
            {variants.length === 0 ? (
              <p className="text-sm text-zinc-500">Nenhuma variação. Sem variações, o estoque é controlado no produto inteiro.</p>
            ) : (
              <div className="space-y-1.5">
                {variants.map(v => (
                  <div key={v.id} className="flex items-center justify-between text-sm border border-zinc-800 rounded-lg px-3 py-2">
                    <span className="text-zinc-200">{v.name}</span>
                    <span className="font-mono text-emerald-400">{v.sellable ?? 0} em estoque</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
