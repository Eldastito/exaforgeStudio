import React, { useState, useEffect } from 'react';
import { toast } from '@/src/lib/toast';
import { Package, Plus, X, Pencil, Upload, AlertTriangle, Boxes, Trash2, Sparkles, Camera, Loader2, Receipt } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { StockModal } from '@/src/features/StockModal';
import { EmptyState } from '@/src/components/EmptyState';

type Product = {
  id: string; type: string; name: string; description?: string; price?: number;
  currency?: string; active?: number; stock_control_enabled?: number;
  quantity_available?: number; quantity_reserved?: number; sellable?: number | null;
  low_stock_threshold?: number;
};

const emptyForm = { type: 'product', name: '', description: '', price: '0', stock_control_enabled: true, initial_stock: '0', min_price: '' };
const emptyScanForm = { name: '', category: '', description: '', price: '', stock_control_enabled: true, initial_stock: '1' };

export function CatalogView() {
  const [products, setProducts] = useState<Product[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [form, setForm] = useState<any>(emptyForm);
  const [stockProduct, setStockProduct] = useState<Product | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [suggestedTitle, setSuggestedTitle] = useState('');

  // Cadastro Inteligente (Smart Inventory, ADR-019/ADR-020) — foto do produto
  // -> IA extrai os campos e grava um rascunho -> usuário revisa e confirma
  // -> só então o produto é criado de verdade.
  const [showScan, setShowScan] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ draftId: string; imageUrl: string; extracted: any; confidenceScore: number } | null>(null);
  const [scanForm, setScanForm] = useState<any>(emptyScanForm);
  const [scanSaving, setScanSaving] = useState(false);
  const [scanReviewed, setScanReviewed] = useState(false);

  // Cadastro por Nota Fiscal (Smart Inventory Fase 1, ADR-021) — foto da nota
  // -> IA extrai TODOS os itens comprados (com custo) e grava um rascunho ->
  // usuário revisa linha a linha (produto novo, repor estoque de um produto
  // existente, ou ignorar) -> só então produtos/estoque são criados de fato.
  const [showInvoiceScan, setShowInvoiceScan] = useState(false);
  const [invoiceScanning, setInvoiceScanning] = useState(false);
  const [invoiceDraft, setInvoiceDraft] = useState<{ draftId: string; imageUrl: string; supplierName: string | null; confidenceScore: number } | null>(null);
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);
  const [invoiceSaving, setInvoiceSaving] = useState(false);

  const loadProducts = () => {
    apiFetch('/api/products')
      .then(r => r.json())
      .then(data => setProducts(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  useEffect(() => { loadProducts(); }, []);

  const openNew = () => { setEditing(null); setForm(emptyForm); setSuggestedTitle(''); setShowModal(true); };
  const openEdit = (p: Product) => {
    setEditing(p); setSuggestedTitle('');
    setForm({
      type: p.type || 'product', name: p.name, description: p.description || '',
      price: String(p.price ?? 0), stock_control_enabled: !!p.stock_control_enabled,
      initial_stock: String(p.quantity_available ?? 0),
      min_price: (p as any).min_price != null ? String((p as any).min_price) : '',
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
            min_price: form.min_price === '' ? null : parseFloat(form.min_price),
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

  const generateAI = async () => {
    if (!form.name.trim()) { toast.error('Preencha o nome do produto primeiro.'); return; }
    setAiLoading(true); setSuggestedTitle('');
    try {
      const res = await apiFetch('/api/products/ai/describe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, type: form.type, price: parseFloat(form.price) || 0, description: form.description }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao gerar com a IA.'); return; }
      if (d.description) setForm((f: any) => ({ ...f, description: d.description }));
      if (d.title && d.title.toLowerCase() !== form.name.trim().toLowerCase()) setSuggestedTitle(d.title);
      toast.success('Descrição gerada pela IA. Revise antes de salvar. ✨');
    } catch (e) { toast.error('Erro ao gerar com a IA'); }
    finally { setAiLoading(false); }
  };

  const handleDelete = async (p: Product) => {
    if (!window.confirm(`Excluir "${p.name}" do catálogo? Esta ação não pode ser desfeita. O histórico de pedidos é preservado.`)) return;
    try {
      const res = await apiFetch(`/api/products/${p.id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao excluir'); return; }
      toast.success('Item excluído.');
      loadProducts();
    } catch (e) { toast.error('Erro ao excluir'); }
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
        toast.success(`Importação concluída: ${data.created} criados, ${data.updated} atualizados.`);
        setShowImport(false); setCsv(''); loadProducts();
      } else {
        toast.error(data.error || 'Erro na importação');
      }
    } catch (e) { toast.error('Erro na importação'); }
    finally { setImporting(false); }
  };

  const openScan = () => { setScanResult(null); setScanForm(emptyScanForm); setScanReviewed(false); setShowScan(true); };

  const handleScanUpload = async (file: File) => {
    setScanning(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await apiFetch('/api/products/smart-scan', { method: 'POST', body });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Não foi possível analisar a foto.'); return; }
      setScanResult(d);
      setScanReviewed(false);
      setScanForm({
        name: d.extracted.name || '',
        category: d.extracted.category || '',
        description: d.extracted.description || '',
        price: '',
        stock_control_enabled: true,
        initial_stock: '1',
      });
    } catch (e) {
      toast.error('Erro ao enviar a foto.');
    } finally {
      setScanning(false);
    }
  };

  const scanConfidenceTier = (score: number): 'high' | 'medium' | 'low' =>
    score >= 95 ? 'high' : score >= 80 ? 'medium' : 'low';

  const handleScanConfirm = async () => {
    if (!scanResult) return;
    if (!scanForm.name.trim()) { toast.error('Informe o nome do produto.'); return; }
    if (!scanForm.price || Number(scanForm.price) <= 0) { toast.error('Informe o preço de venda antes de publicar.'); return; }
    if (scanConfidenceTier(scanResult.confidenceScore) === 'low' && !scanReviewed) {
      toast.error('Confirme que revisou os campos (confiança baixa da IA nesta foto).');
      return;
    }
    setScanSaving(true);
    try {
      const res = await apiFetch(`/api/products/smart-scan/${scanResult.draftId}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: scanForm.name, category: scanForm.category || undefined,
          description: scanForm.description, price: parseFloat(scanForm.price),
          stock_control_enabled: scanForm.stock_control_enabled,
          initial_stock: parseInt(scanForm.initial_stock || '0', 10),
        }),
      });
      const created = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(created.error || 'Não foi possível criar o produto.'); return; }

      toast.success('Produto cadastrado a partir da foto — já disponível na loja e para a IA vender. 📸');
      setShowScan(false); setScanResult(null); setScanForm(emptyScanForm); setScanReviewed(false);
      loadProducts();
    } catch (e) {
      toast.error('Erro ao publicar o produto.');
    } finally {
      setScanSaving(false);
    }
  };

  const openInvoiceScan = () => { setInvoiceDraft(null); setInvoiceItems([]); setShowInvoiceScan(true); };

  const handleInvoiceUpload = async (file: File) => {
    setInvoiceScanning(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await apiFetch('/api/products/invoice-scan', { method: 'POST', body });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Não foi possível analisar a nota fiscal.'); return; }
      setInvoiceDraft({ draftId: d.draftId, imageUrl: d.imageUrl, supplierName: d.supplierName || null, confidenceScore: d.confidenceScore });
      setInvoiceItems((d.items || []).map((it: any) => {
        const match = products.find(p => p.name.trim().toLowerCase() === String(it.name || '').trim().toLowerCase());
        return {
          name: it.name || '', quantity: String(it.quantity || 1), unit: it.unit || '',
          unitCost: it.unitCost ? String(it.unitCost) : '0', confidence: it.confidence || 0,
          selection: match ? match.id : 'create', salePrice: '',
        };
      }));
    } catch (e) {
      toast.error('Erro ao enviar a foto da nota fiscal.');
    } finally {
      setInvoiceScanning(false);
    }
  };

  const updateInvoiceItem = (index: number, patch: any) => {
    setInvoiceItems((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleInvoiceConfirm = async () => {
    if (!invoiceDraft) return;
    const payloadItems: any[] = [];
    for (const row of invoiceItems) {
      if (row.selection === 'skip') { payloadItems.push({ action: 'skip' }); continue; }
      const quantity = parseInt(row.quantity, 10) || 0;
      if (quantity <= 0) { toast.error(`Informe uma quantidade válida para "${row.name}".`); return; }
      if (row.selection === 'create') {
        if (!row.salePrice || Number(row.salePrice) <= 0) { toast.error(`Informe o preço de venda de "${row.name}" antes de publicar.`); return; }
        payloadItems.push({ action: 'create', name: row.name, quantity, unitCost: Number(row.unitCost) || 0, salePrice: Number(row.salePrice) });
      } else {
        payloadItems.push({ action: 'restock', matchedProductId: row.selection, quantity, unitCost: Number(row.unitCost) || 0 });
      }
    }
    if (!payloadItems.some((i) => i.action !== 'skip')) { toast.error('Selecione ao menos um item para confirmar.'); return; }

    setInvoiceSaving(true);
    try {
      const res = await apiFetch(`/api/products/invoice-scan/${invoiceDraft.draftId}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: payloadItems }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(result.error || 'Não foi possível confirmar a nota fiscal.'); return; }

      toast.success(`Nota fiscal processada: ${result.created.length} produto(s) novo(s), ${result.restocked.length} reposto(s). 🧾`);
      setShowInvoiceScan(false); setInvoiceDraft(null); setInvoiceItems([]);
      loadProducts();
    } catch (e) {
      toast.error('Erro ao confirmar a nota fiscal.');
    } finally {
      setInvoiceSaving(false);
    }
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
          <Button variant="outline" className="border-emerald-700/50 text-emerald-300 hover:border-emerald-500" onClick={openScan}>
            <Camera className="w-4 h-4 mr-2" /> Cadastro Inteligente
          </Button>
          <Button variant="outline" className="border-emerald-700/50 text-emerald-300 hover:border-emerald-500" onClick={openInvoiceScan}>
            <Receipt className="w-4 h-4 mr-2" /> Nota Fiscal
          </Button>
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
          <EmptyState
            icon={<Package className="w-6 h-6" />}
            title="Seu catálogo está vazio"
            description="Cadastre produtos ou serviços com preço e estoque. A IA usa o catálogo para responder dúvidas, montar cotações e fechar vendas pelo WhatsApp."
            actionLabel="Cadastrar primeiro item"
            onAction={openNew}
          />
        ) : (
          products.map(p => (
            <div key={p.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition-colors group">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">{p.type}</span>
                <button onClick={() => setStockProduct(p)} className="text-zinc-400 hover:text-emerald-400" title="Estoque, variações e movimentações">
                  <Boxes className="w-4 h-4" />
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
              {/* Ações do card — sempre visíveis e rotuladas */}
              <div className="mt-4 grid grid-cols-2 gap-2 border-t border-zinc-800 pt-3">
                <button onClick={() => openEdit(p)}
                  className="inline-flex items-center justify-center gap-1.5 text-sm rounded-lg border border-zinc-700 text-zinc-200 hover:border-indigo-500/50 hover:text-indigo-300 py-1.5 transition-colors">
                  <Pencil className="w-4 h-4" /> Editar
                </button>
                <button onClick={() => handleDelete(p)}
                  className="inline-flex items-center justify-center gap-1.5 text-sm rounded-lg border border-zinc-700 text-zinc-200 hover:border-rose-500/50 hover:text-rose-300 py-1.5 transition-colors">
                  <Trash2 className="w-4 h-4" /> Excluir
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal Criar/Editar */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[420px] max-h-[90vh] overflow-y-auto">
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-zinc-400 mb-1 block">Preço (R$)</label>
                  <input required type="number" step="0.01" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                    value={form.price} onChange={(e) => setForm({...form, price: e.target.value})} />
                </div>
                <div>
                  <label className="text-sm text-zinc-400 mb-1 block">Preço mínimo <span className="text-zinc-600">(negociação)</span></label>
                  <input type="number" step="0.01" placeholder="opcional" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                    value={form.min_price} onChange={(e) => setForm({...form, min_price: e.target.value})} />
                </div>
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
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm text-zinc-400">Descrição</label>
                  <button type="button" onClick={generateAI} disabled={aiLoading}
                    className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-50">
                    <Sparkles className="w-3.5 h-3.5" /> {aiLoading ? 'Gerando...' : 'Gerar com IA'}
                  </button>
                </div>
                <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 h-20 resize-none"
                  value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} />
                {suggestedTitle && (
                  <button type="button" onClick={() => { setForm((f: any) => ({ ...f, name: suggestedTitle })); setSuggestedTitle(''); }}
                    className="mt-1.5 text-[11px] text-indigo-300 hover:text-indigo-200 text-left">
                    💡 Título sugerido: <span className="underline">{suggestedTitle}</span> — clique para usar
                  </button>
                )}
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
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[520px] max-h-[90vh] overflow-y-auto">
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

      {/* Modal Cadastro Inteligente (Smart Inventory) */}
      {showScan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[460px] max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <Camera className="w-5 h-5 text-emerald-400" /> Cadastro Inteligente
              </h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => { setShowScan(false); setScanResult(null); setScanReviewed(false); }}><X className="w-5 h-5" /></button>
            </div>

            {!scanResult && (
              <div>
                <p className="text-sm text-zinc-400 mb-4">Tire ou envie uma foto do produto — a IA identifica nome, marca, categoria e peso automaticamente. Você revisa e define o preço antes de publicar.</p>
                <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-zinc-700 rounded-xl py-10 cursor-pointer hover:border-emerald-500/50 transition-colors">
                  {scanning ? (
                    <>
                      <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
                      <span className="text-sm text-zinc-400">Analisando com IA...</span>
                    </>
                  ) : (
                    <>
                      <Camera className="w-8 h-8 text-zinc-500" />
                      <span className="text-sm text-zinc-400">Toque para tirar/escolher uma foto</span>
                    </>
                  )}
                  <input
                    type="file" accept="image/png,image/jpeg,image/webp" capture="environment" className="hidden"
                    disabled={scanning}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleScanUpload(f); e.target.value = ''; }}
                  />
                </label>
              </div>
            )}

            {scanResult && (
              <div className="space-y-4">
                {(() => {
                  const tier = scanConfidenceTier(scanResult.confidenceScore);
                  const banner = tier === 'high'
                    ? { cls: 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300', text: `IA confiante na leitura (${scanResult.confidenceScore}%). Confira e publique.` }
                    : tier === 'medium'
                    ? { cls: 'border-amber-700/50 bg-amber-950/30 text-amber-300', text: `Confiança média (${scanResult.confidenceScore}%) — confira estes campos com atenção.` }
                    : { cls: 'border-red-700/50 bg-red-950/30 text-red-300', text: `Confiança baixa (${scanResult.confidenceScore}%) — a foto ficou pouco nítida ou incompleta. Revise com atenção antes de publicar.` };
                  return (
                    <div className={`text-xs rounded-lg border px-3 py-2 ${banner.cls}`}>{banner.text}</div>
                  );
                })()}
                <div className="flex gap-3">
                  <img src={scanResult.imageUrl} alt="Produto" className="w-20 h-20 object-cover rounded-lg border border-zinc-800" />
                  <div className="flex-1">
                    <p className="text-xs text-zinc-500">Revise os campos abaixo antes de publicar — nada é publicado sem sua confirmação.</p>
                    {scanResult.extracted.weightLabel && (
                      <p className="text-xs text-emerald-400 mt-1">Peso/volume identificado: {scanResult.extracted.weightLabel}</p>
                    )}
                    {scanResult.extracted.brand && (
                      <p className="text-xs text-zinc-400">Marca identificada: {scanResult.extracted.brand}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-sm text-zinc-400 mb-1 block">Nome</label>
                  <input required className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                    value={scanForm.name} onChange={(e) => setScanForm({ ...scanForm, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Categoria</label>
                    <input className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                      value={scanForm.category} onChange={(e) => setScanForm({ ...scanForm, category: e.target.value })} />
                  </div>
                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Preço de venda (R$) *</label>
                    <input required type="number" step="0.01" placeholder="a IA não sugere preço" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                      value={scanForm.price} onChange={(e) => setScanForm({ ...scanForm, price: e.target.value })} />
                  </div>
                </div>
                <div>
                  <label className="text-sm text-zinc-400 mb-1 block">Descrição</label>
                  <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 h-16 resize-none"
                    value={scanForm.description} onChange={(e) => setScanForm({ ...scanForm, description: e.target.value })} />
                </div>
                <div className="flex items-center gap-2">
                  <input id="scanstockctl" type="checkbox" checked={scanForm.stock_control_enabled}
                    onChange={(e) => setScanForm({ ...scanForm, stock_control_enabled: e.target.checked })} />
                  <label htmlFor="scanstockctl" className="text-sm text-zinc-300">Controlar estoque</label>
                </div>
                {scanForm.stock_control_enabled && (
                  <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Quantidade em estoque</label>
                    <input type="number" min="0" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                      value={scanForm.initial_stock} onChange={(e) => setScanForm({ ...scanForm, initial_stock: e.target.value })} />
                  </div>
                )}

                {scanConfidenceTier(scanResult.confidenceScore) === 'low' && (
                  <div className="flex items-start gap-2 border border-red-700/40 bg-red-950/20 rounded-lg p-2">
                    <input id="scanreviewed" type="checkbox" className="mt-0.5" checked={scanReviewed}
                      onChange={(e) => setScanReviewed(e.target.checked)} />
                    <label htmlFor="scanreviewed" className="text-sm text-red-300">Revisei e confirmo os dados acima manualmente.</label>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={() => { setScanResult(null); setScanForm(emptyScanForm); setScanReviewed(false); }}>Tirar outra foto</Button>
                  <Button onClick={handleScanConfirm} disabled={scanSaving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    {scanSaving ? 'Publicando...' : 'Aprovar e Publicar'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Cadastro por Nota Fiscal (Smart Inventory Fase 1) */}
      {showInvoiceScan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[820px] max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <Receipt className="w-5 h-5 text-emerald-400" /> Cadastro por Nota Fiscal
              </h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => { setShowInvoiceScan(false); setInvoiceDraft(null); setInvoiceItems([]); }}><X className="w-5 h-5" /></button>
            </div>

            {!invoiceDraft && (
              <div>
                <p className="text-sm text-zinc-400 mb-4">Fotografe a nota fiscal de uma compra — a IA lê todos os itens comprados (com quantidade e custo) de uma vez. Você revisa cada item, escolhe se é produto novo ou reposição de estoque, e define o preço de venda antes de publicar.</p>
                <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-zinc-700 rounded-xl py-10 cursor-pointer hover:border-emerald-500/50 transition-colors">
                  {invoiceScanning ? (
                    <>
                      <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
                      <span className="text-sm text-zinc-400">Lendo a nota fiscal com IA...</span>
                    </>
                  ) : (
                    <>
                      <Receipt className="w-8 h-8 text-zinc-500" />
                      <span className="text-sm text-zinc-400">Toque para tirar/escolher a foto da nota</span>
                    </>
                  )}
                  <input
                    type="file" accept="image/png,image/jpeg,image/webp" capture="environment" className="hidden"
                    disabled={invoiceScanning}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleInvoiceUpload(f); e.target.value = ''; }}
                  />
                </label>
              </div>
            )}

            {invoiceDraft && (
              <div className="space-y-4">
                <div className="flex gap-3 items-start">
                  <img src={invoiceDraft.imageUrl} alt="Nota fiscal" className="w-20 h-20 object-cover rounded-lg border border-zinc-800" />
                  <div className="flex-1 text-xs text-zinc-500">
                    <p>Revise cada item — nada é criado ou reposto no estoque sem sua confirmação.</p>
                    {invoiceDraft.supplierName && <p className="text-zinc-400 mt-1">Fornecedor identificado: {invoiceDraft.supplierName}</p>}
                    <p className="mt-1">{invoiceItems.length} item(ns) identificado(s). Confiança geral da leitura: {invoiceDraft.confidenceScore}%.</p>
                  </div>
                </div>

                <div className="overflow-x-auto -mx-6 px-6">
                  <table className="w-full text-sm min-w-[720px]">
                    <thead>
                      <tr className="text-left text-zinc-500 text-xs border-b border-zinc-800">
                        <th className="pb-2 pr-2">Item</th>
                        <th className="pb-2 pr-2 w-20">Qtd</th>
                        <th className="pb-2 pr-2 w-28">Custo unit. (R$)</th>
                        <th className="pb-2 pr-2 w-52">Produto</th>
                        <th className="pb-2 pr-2 w-28">Preço venda (R$)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoiceItems.map((row, i) => (
                        <tr key={i} className={`border-b border-zinc-800/60 align-top ${row.selection === 'skip' ? 'opacity-40' : ''}`}>
                          <td className="py-2 pr-2">
                            <input className="w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100"
                              value={row.name} onChange={(e) => updateInvoiceItem(i, { name: e.target.value })} />
                            {row.confidence < 80 && <span className="text-[11px] text-amber-400">confiança baixa nesta linha — confira</span>}
                          </td>
                          <td className="py-2 pr-2">
                            <input type="number" min="0" className="w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100"
                              value={row.quantity} onChange={(e) => updateInvoiceItem(i, { quantity: e.target.value })} />
                          </td>
                          <td className="py-2 pr-2">
                            <input type="number" step="0.01" min="0" className="w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100"
                              value={row.unitCost} onChange={(e) => updateInvoiceItem(i, { unitCost: e.target.value })} />
                          </td>
                          <td className="py-2 pr-2">
                            <select className="w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100"
                              value={row.selection} onChange={(e) => updateInvoiceItem(i, { selection: e.target.value })}>
                              <option value="create">+ Novo produto</option>
                              <option value="skip">Ignorar este item</option>
                              {products.map((p) => (<option key={p.id} value={p.id}>Repor: {p.name}</option>))}
                            </select>
                          </td>
                          <td className="py-2 pr-2">
                            {row.selection === 'create' ? (
                              <input type="number" step="0.01" min="0" placeholder="obrigatório" className="w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100"
                                value={row.salePrice} onChange={(e) => updateInvoiceItem(i, { salePrice: e.target.value })} />
                            ) : (
                              <span className="text-zinc-600 text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="ghost" onClick={() => { setInvoiceDraft(null); setInvoiceItems([]); }}>Tirar outra foto</Button>
                  <Button onClick={handleInvoiceConfirm} disabled={invoiceSaving} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    {invoiceSaving ? 'Publicando...' : 'Aprovar e Publicar'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {stockProduct && (
        <StockModal product={stockProduct} onClose={() => { setStockProduct(null); loadProducts(); }} />
      )}
    </div>
  );
}
