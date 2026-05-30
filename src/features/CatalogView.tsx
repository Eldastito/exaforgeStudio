import React, { useState, useEffect } from 'react';
import { Package, Plus, X, Pencil, Upload, AlertTriangle } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';

type Product = {
  id: string; type: string; name: string; description?: string; price?: number;
  currency?: string; active?: number; stock_control_enabled?: number;
  quantity_available?: number; quantity_reserved?: number; sellable?: number | null;
  low_stock_threshold?: number;
};

const emptyForm = { type: 'product', name: '', description: '', price: '0', stock_control_enabled: true, initial_stock: '0' };

export function CatalogView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState<any>(emptyForm);

  const loadProducts = () => {
    apiFetch('/api/products')
      .then(r => r.json())
      .then(data => setProducts(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  useEffect(() => { loadProducts(); }, []);

  const openNew = () => { setEditing(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (p: Product) => {
    setEditing(p);
    setForm({
      type: p.type || 'product', name: p.name, description: p.description || '',
      price: String(p.price ?? 0), stock_control_enabled: !!p.stock_control_enabled,
      initial_stock: String(p.quantity_available ?? 0),
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editing) {
        await apiFetch(`/api/products/${editing.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name, description: form.description, price: parseFloat(form.price),
            type: form.type, stock_control_enabled: form.stock_control_enabled,
            quantity: form.stock_control_enabled ? parseInt(form.initial_stock || '0', 10) : undefined,
          }),
        });
      } else {
        await apiFetch('/api/products', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...form, price: parseFloat(form.price),
            initial_stock: parseInt(form.initial_stock || '0', 10),
          }),
        });
      }
      setShowModal(false); setEditing(null); setForm(emptyForm);
      loadProducts();
    } catch (e) { /* noop */ }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const res = await apiFetch('/api/products/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(`Importação concluída: ${data.created} criados, ${data.updated} atualizados.`);
        setShowImport(false); setCsv(''); loadProducts();
      } else {
        alert(data.error || 'Erro na importação');
      }
    } catch (e) { alert('Erro na importação'); }
    finally { setImporting(false); }
  };

  const isLow = (p: Product) =>
    !!p.stock_control_enabled && (p.sellable ?? 0) <= (p.low_stock_threshold || 0);

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 relative">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <Package className="w-6 h-6 text-indigo-400" />
            Catálogo &amp; Estoque
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Produtos, serviços e controle de estoque usado pela IA vendedora</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-zinc-700 text-zinc-200" onClick={() => setShowImport(true)}>
            <Upload className="w-4 h-4 mr-2" /> Importar CSV
          </Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700" onClick={openNew}>
            <Plus className="w-4 h-4 mr-2" /> Novo Item
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {products.length === 0 ? (
          <div className="col-span-full py-12 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/30">
            Nenhum produto ou serviço cadastrado ainda.
          </div>
        ) : (
          products.map(p => (
            <div key={p.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition-colors group">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">{p.type}</span>
                <button onClick={() => openEdit(p)} className="text-zinc-500 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" title="Editar">
                  <Pencil className="w-4 h-4" />
                </button>
              </div>
              <h3 className="font-semibold text-zinc-100 mt-2">{p.name}</h3>
              <p className="text-zinc-500 text-sm mt-1 line-clamp-2">{p.description || 'Sem descrição'}</p>
              <div className="mt-4 flex items-center justify-between">
                <span className="font-mono text-zinc-300">{p.currency || 'BRL'} {Number(p.price ?? 0).toFixed(2)}</span>
                {p.stock_control_enabled ? (
                  <span className={`inline-flex items-center gap-1 text-xs font-medium rounded px-2 py-0.5 ${isLow(p) ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                    {isLow(p) && <AlertTriangle className="w-3 h-3" />}
                    {p.sellable ?? 0} em estoque
                  </span>
                ) : (
                  <span className="text-xs text-zinc-600">sem controle</span>
                )}
              </div>
              {p.stock_control_enabled && (p.quantity_reserved ?? 0) > 0 && (
                <p className="mt-1 text-[11px] text-amber-400/80">{p.quantity_reserved} reservado(s) em pedidos</p>
              )}
            </div>
          ))
        )}
      </div>

      {/* Modal Criar/Editar */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[420px]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100">{editing ? 'Editar Item' : 'Novo Item'}</h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => { setShowModal(false); setEditing(null); }}><X className="w-5 h-5"/></button>
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
              <div className="flex items-center gap-2">
                <input id="stockctl" type="checkbox" checked={form.stock_control_enabled}
                  onChange={(e) => setForm({...form, stock_control_enabled: e.target.checked})} />
                <label htmlFor="stockctl" className="text-sm text-zinc-300">Controlar estoque</label>
              </div>
              {form.stock_control_enabled && (
                <div>
                  <label className="text-sm text-zinc-400 mb-1 block">Quantidade em estoque</label>
                  <input type="number" min="0" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                    value={form.initial_stock} onChange={(e) => setForm({...form, initial_stock: e.target.value})} />
                </div>
              )}
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Descrição</label>
                <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 h-20 resize-none"
                  value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => { setShowModal(false); setEditing(null); }}>Cancelar</Button>
                <Button type="submit" variant="default" className="bg-indigo-600 hover:bg-indigo-700 text-white">Salvar</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Importar CSV */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[520px]">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-zinc-100">Importar produtos (CSV)</h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => setShowImport(false)}><X className="w-5 h-5"/></button>
            </div>
            <p className="text-xs text-zinc-500 mb-3">
              Cole o conteúdo do CSV. Cabeçalho aceito: <code className="text-indigo-300">nome,preco,quantidade,descricao,tipo</code>.
              Produtos com o mesmo nome são atualizados.
            </p>
            <textarea
              className="w-full h-48 bg-zinc-950 border border-zinc-800 rounded p-3 text-sm text-zinc-100 font-mono resize-none"
              placeholder={"nome,preco,quantidade,descricao\nCamiseta Preta,49.90,30,Algodao 100%\nCaneca,25,100,Ceramica"}
              value={csv} onChange={(e) => setCsv(e.target.value)}
            />
            <div className="flex justify-end gap-2 pt-3">
              <Button type="button" variant="ghost" onClick={() => setShowImport(false)}>Cancelar</Button>
              <Button onClick={handleImport} disabled={importing || !csv.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                {importing ? 'Importando...' : 'Importar'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
