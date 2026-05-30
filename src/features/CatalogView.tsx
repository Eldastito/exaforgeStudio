import React, { useState, useEffect } from 'react';
import { Package, Plus, X } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

export function CatalogView() {
  const [products, setProducts] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ type: 'product', name: '', description: '', price: '0', stock_control_enabled: false });

  const loadProducts = () => {
    apiFetch('/api/products')
      .then(r => r.json())
      .then(data => setProducts(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, price: parseFloat(form.price) })
      });
      setShowModal(false);
      setForm({ type: 'product', name: '', description: '', price: '0', stock_control_enabled: false });
      loadProducts();
    } catch(e) { }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 relative">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <Package className="w-6 h-6 text-indigo-400" />
            Catálogo
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Gerencie produtos e serviços</p>
        </div>
        <Button className="bg-indigo-600 hover:bg-indigo-700" onClick={() => setShowModal(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Novo Item
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {products.length === 0 ? (
          <div className="col-span-full py-12 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/30">
            Nenhum produto ou serviço cadastrado ainda.
          </div>
        ) : (
          products.map(p => (
            <div key={p.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition-colors">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">{p.type}</span>
                {p.active ? (
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                ) : (
                  <span className="w-2 h-2 rounded-full bg-zinc-600"></span>
                )}
              </div>
              <h3 className="font-semibold text-zinc-100 mt-2">{p.name}</h3>
              <p className="text-zinc-500 text-sm mt-1 line-clamp-2">{p.description || 'Sem descrição'}</p>
              <div className="mt-4 font-mono text-zinc-300">
                {p.currency} {p.price?.toFixed(2)}
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[400px]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100">Novo Item</h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => setShowModal(false)}><X className="w-5 h-5"/></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Tipo</label>
                <select className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.type} onChange={(e) => setForm({...form, type: e.target.value})}>
                   <option value="product">Produto</option>
                   <option value="service">Serviço</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Nome</label>
                <input required className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Preço (R$)</label>
                <input required type="number" step="0.01" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.price} onChange={(e) => setForm({...form, price: e.target.value})} />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Descrição</label>
                <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 h-20 resize-none" 
                  value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
                <Button type="submit" variant="default" className="bg-indigo-600 hover:bg-indigo-700 text-white">Salvar</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
