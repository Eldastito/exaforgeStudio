import React, { useEffect, useState } from 'react';
import { Store, Save, Copy, Plus, X, Star, Eye, EyeOff, Image as ImageIcon, Loader2, Layers, Trash2, Pencil, Tag, BarChart3, GripVertical } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Button } from '@/src/components/ui/button';
import { EmptyState } from '@/src/components/EmptyState';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

type StorefrontSettings = {
  organization_id?: string;
  slug: string;
  title: string;
  subtitle: string;
  logo_url: string;
  banner_url: string;
  accent_color: string;
  default_mode: 'day' | 'night';
  whatsapp_number: string;
  published: boolean;
  default_markup_percent?: number | null;
  ai_catalog_photos_enabled?: boolean;
};

type SaleMode = 'unit' | 'slice' | 'size' | 'weight' | 'volume';

type ProductImage = { id: string; url: string; position: number };

type StorefrontProduct = {
  id: string;
  name: string;
  price: number;
  currency: string;
  description?: string;
  sale_mode: SaleMode;
  sale_options: any;
  storefront_visible: 0 | 1;
  featured: boolean;
  images: ProductImage[];
};

const emptySettings: StorefrontSettings = {
  slug: '',
  title: '',
  subtitle: '',
  logo_url: '',
  banner_url: '',
  accent_color: '#6366f1',
  default_mode: 'day',
  whatsapp_number: '',
  published: false,
  ai_catalog_photos_enabled: false,
};

function getOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return '';
  }
}

export function StorefrontSettingsView() {
  const [settings, setSettings] = useState<StorefrontSettings>(emptySettings);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  const [products, setProducts] = useState<StorefrontProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [curating, setCurating] = useState(false);
  const [curationTips, setCurationTips] = useState<{ name: string; reason: string }[] | null>(null);
  const [collections, setCollections] = useState<{ id: string; title: string; rule: string; productIds?: string[] }[]>([]);
  const [buildingCollections, setBuildingCollections] = useState(false);
  const [manualEditing, setManualEditing] = useState<{ id: string; title: string; productIds: string[] } | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [editingProduct, setEditingProduct] = useState<StorefrontProduct | null>(null);

  const RULE_LABEL: Record<string, string> = {
    featured: 'Produtos em destaque', best_sellers: 'Mais vendidos', newest: 'Novidades (recém-adicionados)', manual: 'Selecionada manualmente',
  };

  const loadCollections = async () => {
    try {
      const data = await apiFetch('/api/storefront/collections').then((r) => r.json());
      setCollections(Array.isArray(data) ? data : []);
    } catch (e) { console.error(e); }
  };

  const buildCollections = async () => {
    setBuildingCollections(true);
    try {
      const res = await apiFetch('/api/storefront/ai/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao montar coleções.'); return; }
      await loadCollections();
      const n = Array.isArray(d.collections) ? d.collections.length : 0;
      toast.success(n ? `Vitrine organizada em ${n} coleção(ões). ✨` : 'Sem produtos suficientes para montar coleções.');
    } catch (e) { toast.error('Erro ao montar coleções com a IA'); }
    finally { setBuildingCollections(false); }
  };

  const deleteCollection = async (id: string) => {
    setCollections((list) => list.filter((c) => c.id !== id));
    try { await apiFetch(`/api/storefront/collections/${id}`, { method: 'DELETE' }); }
    catch (e) { toast.error('Erro ao remover coleção'); loadCollections(); }
  };

  // Reordena as coleções (drag-and-drop). A ordem definida aqui é a ordem de
  // exibição na vitrine pública.
  const onDragEndCollections = (result: DropResult) => {
    if (!result.destination || result.destination.index === result.source.index) return;
    const next = [...collections];
    const [moved] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, moved);
    setCollections(next); // otimista
    apiFetch('/api/storefront/collections/reorder', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: next.map((c) => c.id) }),
    }).then((r) => { if (!r.ok) { toast.error('Erro ao salvar a ordem.'); loadCollections(); } })
      .catch(() => { toast.error('Erro ao salvar a ordem.'); loadCollections(); });
  };

  const loadProducts = async () => {
    try {
      const data = await apiFetch('/api/storefront/products').then((r) => r.json());
      setProducts(Array.isArray(data) ? data.map(normalizeProduct) : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingProducts(false);
    }
  };

  // Curadoria de destaques pela IA: sugere e aplica os produtos em destaque com
  // base em vendas e margem. O dono pode ajustar depois com o toggle de cada item.
  const curateFeatured = async () => {
    if (!window.confirm('A IA vai escolher os produtos em destaque da vitrine (por vendas e margem) e aplicar agora. Você pode ajustar manualmente depois. Continuar?')) return;
    setCurating(true); setCurationTips(null);
    try {
      const res = await apiFetch('/api/storefront/ai/featured', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply: true, max: 4 }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha na curadoria.'); return; }
      const tips = Array.isArray(d.suggestions) ? d.suggestions.map((s: any) => ({ name: s.name, reason: s.reason })) : [];
      setCurationTips(tips);
      await loadProducts();
      toast.success(tips.length ? `Destaques atualizados: ${tips.length} produto(s). ✨` : 'Nenhum produto para destacar ainda.');
    } catch (e) { toast.error('Erro na curadoria com a IA'); }
    finally { setCurating(false); }
  };

  // Reordena os produtos da vitrine (drag-and-drop). A ordem é a de exibição na LP.
  const onDragEndProducts = (result: DropResult) => {
    if (!result.destination || result.destination.index === result.source.index) return;
    const next = [...products];
    const [moved] = next.splice(result.source.index, 1);
    next.splice(result.destination.index, 0, moved);
    setProducts(next); // otimista
    apiFetch('/api/storefront/products/reorder', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: next.map((p) => p.id) }),
    }).then((r) => { if (!r.ok) { toast.error('Erro ao salvar a ordem.'); loadProducts(); } })
      .catch(() => { toast.error('Erro ao salvar a ordem.'); loadProducts(); });
  };

  // Exclui o produto do catálogo (e, portanto, da vitrine). Reaproveita o
  // endpoint do catálogo, que limpa estoque/imagens e preserva o histórico.
  const deleteProduct = async (p: StorefrontProduct) => {
    if (!window.confirm(`Excluir "${p.name}" do catálogo e da loja? Esta ação não pode ser desfeita. O histórico de pedidos é preservado.`)) return;
    setProducts((list) => list.filter((x) => x.id !== p.id));
    try {
      const res = await apiFetch(`/api/products/${p.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || 'Erro ao excluir.');
        await loadProducts();
        return;
      }
      toast.success('Produto excluído da loja.');
    } catch (e) {
      toast.error('Erro ao excluir.');
      await loadProducts();
    }
  };

  useEffect(() => {
    let active = true;
    apiFetch('/api/storefront/settings')
      .then((r) => r.json())
      .then((data) => {
        if (!active || !data) return;
        setSettings({
          ...emptySettings,
          ...data,
          published: !!data.published,
          ai_catalog_photos_enabled: !!data.ai_catalog_photos_enabled,
          default_mode: (data.default_mode === 'night' ? 'night' : 'day'),
        });
      })
      .catch((e) => console.error(e))
      .finally(() => active && setLoadingSettings(false));

    loadProducts();
    loadCollections();

    return () => {
      active = false;
    };
  }, []);

  const publicUrl = `${getOrigin()}/loja/${settings.slug || ''}`;

  const setField = <K extends keyof StorefrontSettings>(key: K, value: StorefrontSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await apiFetch('/api/storefront/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: settings.title,
          subtitle: settings.subtitle,
          slug: settings.slug,
          logo_url: settings.logo_url,
          banner_url: settings.banner_url,
          accent_color: settings.accent_color,
          default_mode: settings.default_mode,
          whatsapp_number: settings.whatsapp_number,
          published: settings.published,
          default_markup_percent: settings.default_markup_percent ?? null,
          ai_catalog_photos_enabled: settings.ai_catalog_photos_enabled,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSettings({
          ...emptySettings,
          ...data,
          published: !!data.published,
          ai_catalog_photos_enabled: !!data.ai_catalog_photos_enabled,
          default_mode: (data.default_mode === 'night' ? 'night' : 'day'),
        });
        toast.success('Configurações da loja salvas.');
      } else if (res.status === 409) {
        toast.error(data?.error || 'Este endereço (slug) já está em uso. Escolha outro.');
      } else {
        toast.error(data?.error || 'Erro ao salvar configurações.');
      }
    } catch (e) {
      toast.error('Erro ao salvar configurações.');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleCopyLink = async () => {
    if (!settings.slug) {
      toast.error('Defina um endereço (slug) e salve antes de copiar o link.');
      return;
    }
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success('Link da loja copiado.');
    } catch {
      toast.error('Não foi possível copiar o link.');
    }
  };

  const patchProduct = (id: string, updates: Partial<StorefrontProduct>) =>
    setProducts((list) => list.map((p) => (p.id === id ? { ...p, ...updates } : p)));

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="max-w-5xl mx-auto space-y-8">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <Store className="w-6 h-6 text-indigo-400" />
            Loja Virtual
          </h2>
          <p className="text-zinc-400 text-sm mt-1">
            Configure a vitrine pública da sua loja e escolha quais produtos aparecem para seus clientes.
          </p>
        </div>

        {/* Configuração da loja */}
        <section className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
          <h3 className="text-lg font-semibold text-zinc-100 mb-4">Configuração da loja</h3>

          {loadingSettings ? (
            <div className="flex items-center gap-2 text-zinc-400 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando...
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Título da loja">
                  <input
                    className={inputClass}
                    value={settings.title}
                    onChange={(e) => setField('title', e.target.value)}
                    placeholder="Minha Loja"
                  />
                </Field>
                <Field label="Subtítulo">
                  <input
                    className={inputClass}
                    value={settings.subtitle}
                    onChange={(e) => setField('subtitle', e.target.value)}
                    placeholder="Os melhores produtos"
                  />
                </Field>
              </div>

              <Field label="Endereço (slug)">
                <input
                  className={inputClass}
                  value={settings.slug}
                  onChange={(e) => setField('slug', e.target.value)}
                  placeholder="minha-loja"
                />
                <p className="text-xs text-zinc-500 mt-1.5">
                  URL pública: <span className="text-indigo-300 break-all">{publicUrl}</span>
                </p>
              </Field>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Cor de destaque">
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      className="h-9 w-12 rounded bg-zinc-950 border border-zinc-800 cursor-pointer"
                      value={settings.accent_color || '#6366f1'}
                      onChange={(e) => setField('accent_color', e.target.value)}
                    />
                    <input
                      className={inputClass}
                      value={settings.accent_color}
                      onChange={(e) => setField('accent_color', e.target.value)}
                      placeholder="#6366f1"
                    />
                  </div>
                </Field>

                <Field label="Tema padrão">
                  <div className="flex gap-2">
                    {(['day', 'night'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setField('default_mode', mode)}
                        className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                          settings.default_mode === mode
                            ? 'bg-indigo-600/10 text-indigo-400 border-indigo-500/30'
                            : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {mode === 'day' ? 'Claro (dia)' : 'Escuro (noite)'}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>

              <Field label="WhatsApp">
                <input
                  className={inputClass}
                  value={settings.whatsapp_number}
                  onChange={(e) => setField('whatsapp_number', e.target.value)}
                  placeholder="+55 11 99999-9999"
                />
              </Field>

              <Field label="Margem padrão do preço sugerido (%)">
                <input
                  className={inputClass}
                  type="number" min={1} max={500} step={1}
                  value={settings.default_markup_percent ?? ''}
                  onChange={(e) => setField('default_markup_percent', e.target.value === '' ? null : Number(e.target.value))}
                  placeholder="40 (padrão)"
                />
                <p className="text-[11px] text-zinc-500 mt-1">Usada só para SUGERIR o preço de venda a partir do custo da nota fiscal — você sempre revisa antes de publicar.</p>
              </Field>

              <div className="grid grid-cols-1 gap-4">
                <ImageUploadInput
                  label="Logo da loja"
                  hint="Quadrado, 512×512 px (1:1). PNG com fundo transparente. Aparece no topo da vitrine. Máx. 5 MB."
                  value={settings.logo_url}
                  onChange={(url) => setField('logo_url', url)}
                  previewClass="h-16 w-16 rounded-xl object-cover"
                />
                <ImageUploadInput
                  label="Banner da loja"
                  hint="Retangular, 1600×500 px (≈3:1). JPG ou PNG. Faixa de destaque no topo da vitrine. Máx. 5 MB."
                  value={settings.banner_url}
                  onChange={(url) => setField('banner_url', url)}
                  previewClass="h-16 w-28 rounded-lg object-cover"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">Publicar loja</p>
                  <p className="text-xs text-zinc-500">Quando ativo, a loja fica acessível publicamente.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.published}
                  onClick={() => setField('published', !settings.published)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    settings.published ? 'bg-indigo-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      settings.published ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">Fotos profissionais por IA (Estúdio)</p>
                  <p className="text-xs text-zinc-500">Quando um produto é cadastrado por foto no WhatsApp, a IA do Estúdio troca o fundo pela identidade visual da loja antes de publicar. Cada foto nova custa uma chamada de IA extra.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!settings.ai_catalog_photos_enabled}
                  onClick={() => setField('ai_catalog_photos_enabled', !settings.ai_catalog_photos_enabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    settings.ai_catalog_photos_enabled ? 'bg-indigo-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      settings.ai_catalog_photos_enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  {savingSettings ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Salvar
                </Button>
                <Button
                  variant="outline"
                  onClick={handleCopyLink}
                  className="border-zinc-700 text-zinc-200"
                >
                  <Copy className="w-4 h-4 mr-2" /> Copiar link da loja
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* Produtos na vitrine */}
        <section className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h3 className="text-lg font-semibold text-zinc-100">Produtos na vitrine</h3>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10" onClick={curateFeatured} disabled={curating}>
                <Star className="w-4 h-4 mr-2" /> {curating ? 'Curando...' : 'Sugerir destaques (IA)'}
              </Button>
              <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={() => setShowNew(true)}>
                <Plus className="w-4 h-4 mr-2" /> Novo produto
              </Button>
            </div>
          </div>

          {curationTips && curationTips.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-sm text-amber-300 font-medium mb-1 flex items-center gap-1.5"><Star className="w-4 h-4" /> Destaques escolhidos pela IA</p>
              <ul className="text-xs text-zinc-300 space-y-0.5">
                {curationTips.map((t, i) => (
                  <li key={i}>• <span className="text-zinc-100">{t.name}</span> — <span className="text-zinc-400">{t.reason}</span></li>
                ))}
              </ul>
              <p className="text-[11px] text-zinc-500 mt-2">Ajuste manualmente no botão de estrela de cada produto, se quiser.</p>
            </div>
          )}

          {loadingProducts ? (
            <div className="flex items-center gap-2 text-zinc-400 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando produtos...
            </div>
          ) : products.length === 0 ? (
            <div className="grid grid-cols-1">
              <EmptyState
                icon={<Store className="w-6 h-6" />}
                title="Nenhum produto ainda"
                description="Crie um produto aqui (ou no Catálogo) para exibi-lo na sua loja virtual."
              />
            </div>
          ) : (
            <>
              <p className="text-[11px] text-zinc-500 mb-2">Arraste pela alça (⋮⋮) para definir a ordem em que os produtos aparecem na vitrine.</p>
              <DragDropContext onDragEnd={onDragEndProducts}>
                <Droppable droppableId="products">
                  {(dropProvided) => (
                    <div ref={dropProvided.innerRef} {...dropProvided.droppableProps} className="space-y-4">
                      {products.map((p: StorefrontProduct, index: number) => (
                        // @ts-expect-error React 18+ types issue with hello-pangea/dnd
                        <Draggable key={p.id} draggableId={p.id} index={index}>
                          {(dragProvided) => (
                            <div ref={dragProvided.innerRef} {...dragProvided.draggableProps}>
                              <ProductRow
                                product={p}
                                onPatch={(u) => patchProduct(p.id, u)}
                                onDelete={() => deleteProduct(p)}
                                onEdit={() => setEditingProduct(p)}
                                dragHandleProps={dragProvided.dragHandleProps}
                              />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {dropProvided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            </>
          )}
        </section>

        {/* Coleções da vitrine (curadoria pela IA) */}
        <section className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <div>
              <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Layers className="w-5 h-5 text-indigo-400" /> Coleções</h3>
              <p className="text-xs text-zinc-500 mt-0.5">Seções da vitrine (ex.: Destaques, Mais vendidos, Novidades). A IA monta automaticamente, ou você cria uma coleção escolhendo os produtos a dedo.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="border-zinc-700 text-zinc-200" onClick={() => { setManualEditing(null); setShowManual(true); }}>
                <Plus className="w-4 h-4 mr-2" /> Coleção manual
              </Button>
              <Button variant="outline" className="border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10" onClick={buildCollections} disabled={buildingCollections}>
                <Layers className="w-4 h-4 mr-2" /> {buildingCollections ? 'Montando...' : 'Montar coleções (IA)'}
              </Button>
            </div>
          </div>

          {collections.length === 0 ? (
            <p className="text-sm text-zinc-500 py-4">Nenhuma coleção ainda. Use <span className="text-indigo-300">Montar coleções (IA)</span> ou crie uma <span className="text-zinc-300">Coleção manual</span>.</p>
          ) : (
            <>
              <p className="text-[11px] text-zinc-500 mt-3 mb-1.5">Arraste para definir a ordem em que as seções aparecem na vitrine (de cima para baixo).</p>
              <DragDropContext onDragEnd={onDragEndCollections}>
                <Droppable droppableId="collections">
                  {(dropProvided) => (
                    <div ref={dropProvided.innerRef} {...dropProvided.droppableProps} className="space-y-2">
                      {collections.map((c, index) => (
                        // @ts-expect-error React 18+ types issue with hello-pangea/dnd
                        <Draggable key={c.id} draggableId={c.id} index={index}>
                          {(dragProvided, snapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              className={`flex items-center justify-between rounded-lg border bg-zinc-950/40 px-3 py-2.5 ${snapshot.isDragging ? 'border-indigo-500/50 shadow-lg' : 'border-zinc-800'}`}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span {...dragProvided.dragHandleProps} className="cursor-grab text-zinc-500 hover:text-zinc-300 active:cursor-grabbing" title="Arrastar para reordenar">
                                  <GripVertical className="w-4 h-4" />
                                </span>
                                <span className="text-xs text-zinc-600 w-4 text-right">{index + 1}.</span>
                                <div className="min-w-0">
                                  <p className="text-sm text-zinc-100 font-medium truncate">{c.title}</p>
                                  <p className="text-[11px] text-zinc-500 truncate">
                                    {RULE_LABEL[c.rule] || c.rule}{c.rule === 'manual' ? ` — ${(c.productIds || []).length} produto(s)` : ''}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                {c.rule === 'manual' && (
                                  <button onClick={() => { setManualEditing({ id: c.id, title: c.title, productIds: c.productIds || [] }); setShowManual(true); }}
                                    title="Editar coleção" className="text-zinc-400 hover:text-indigo-400"><Pencil className="w-4 h-4" /></button>
                                )}
                                <button onClick={() => deleteCollection(c.id)} title="Remover coleção"
                                  className="text-zinc-400 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {dropProvided.placeholder}
                    </div>
                  )}
                </Droppable>
              </DragDropContext>
            </>
          )}
        </section>

        {/* Relatório da vitrine */}
        <AnalyticsSection />

        {/* Cupons de desconto */}
        <CouponsSection />
      </div>

      {showManual && (
        <ManualCollectionModal
          products={products}
          editing={manualEditing}
          onClose={() => { setShowManual(false); setManualEditing(null); }}
          onSaved={() => { setShowManual(false); setManualEditing(null); loadCollections(); }}
        />
      )}

      {showNew && (
        <NewProductModal
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); loadProducts(); }}
        />
      )}

      {editingProduct && (
        <EditProductModal
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={() => { setEditingProduct(null); loadProducts(); }}
        />
      )}
    </div>
  );
}

// Modal de edição rápida de um produto (nome, preço, descrição) direto da
// vitrine. Salva no catálogo via PATCH /api/products/:id.
function EditProductModal({ product, onClose, onSaved }: {
  product: StorefrontProduct;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(product.name);
  const [price, setPrice] = useState(String(product.price ?? 0));
  const [description, setDescription] = useState(product.description || '');
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const generateAI = async () => {
    if (!name.trim()) { toast.error('Preencha o nome primeiro.'); return; }
    setAiLoading(true);
    try {
      const res = await apiFetch('/api/products/ai/describe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: 'product', price: Number(price) || 0, description }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao gerar com a IA.'); return; }
      if (d.description) setDescription(d.description);
      toast.success('Descrição gerada pela IA. Revise antes de salvar. ✨');
    } catch (e) { toast.error('Erro ao gerar com a IA'); }
    finally { setAiLoading(false); }
  };

  const save = async () => {
    if (!name.trim()) { toast.error('Informe o nome do produto.'); return; }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/products/${product.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), price: Number(price) || 0 }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao salvar.'); return; }
      toast.success('Produto atualizado.');
      onSaved();
    } catch (e) { toast.error('Erro ao salvar produto.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">Editar produto</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <Field label="Nome">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Preço (R$)">
            <input className={inputClass} type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm text-zinc-400">Descrição</label>
              <button type="button" onClick={generateAI} disabled={aiLoading}
                className="inline-flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-50">
                <Star className="w-3.5 h-3.5" /> {aiLoading ? 'Gerando...' : 'Gerar com IA'}
              </button>
            </div>
            <textarea className={`${inputClass} h-20 resize-none`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descrição do produto" />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Modal de coleção MANUAL: nome + seleção de produtos a dedo.
function ManualCollectionModal({ products, editing, onClose, onSaved }: {
  products: StorefrontProduct[];
  editing: { id: string; title: string; productIds: string[] } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(editing?.title || '');
  const [selected, setSelected] = useState<string[]>(editing?.productIds || []);
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const save = async () => {
    if (!title.trim()) { toast.error('Dê um nome à coleção.'); return; }
    if (selected.length === 0) { toast.error('Selecione ao menos um produto.'); return; }
    setSaving(true);
    try {
      const url = editing ? `/api/storefront/collections/${editing.id}` : '/api/storefront/collections';
      const res = await apiFetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), productIds: selected }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Erro ao salvar coleção.'); return; }
      toast.success(editing ? 'Coleção atualizada.' : 'Coleção criada.');
      onSaved();
    } catch (e) { toast.error('Erro ao salvar coleção.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">{editing ? 'Editar coleção' : 'Nova coleção manual'}</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <Field label="Nome da coleção">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Promoções da semana" autoFocus />
        </Field>
        <p className="text-xs text-zinc-400 mt-4 mb-2">Produtos da coleção ({selected.length} selecionado(s)):</p>
        <div className="flex-1 overflow-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
          {products.length === 0 ? (
            <p className="text-sm text-zinc-500 p-3">Nenhum produto cadastrado ainda.</p>
          ) : products.map((p) => (
            <label key={p.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-zinc-800/50 cursor-pointer">
              <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggle(p.id)} className="accent-indigo-500" />
              <span className="text-sm text-zinc-200 flex-1">{p.name}</span>
              <span className="text-xs font-mono text-zinc-500">{p.currency} {p.price.toFixed(2)}</span>
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (editing ? 'Salvar' : 'Criar coleção')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Modal enxuto para criar um produto direto da tela da loja. Depois de criado,
// o dono ajusta imagens e modo de venda na própria linha do produto.
function NewProductModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [description, setDescription] = useState('');
  const [saleMode, setSaleMode] = useState<'unit' | 'slice' | 'size' | 'weight' | 'volume'>('unit');
  const [saving, setSaving] = useState(false);

  const priceHint =
    saleMode === 'weight' ? 'Preço por quilo (kg)'
    : saleMode === 'volume' ? 'Preço por litro (L)'
    : saleMode === 'slice' ? 'Preço por fatia'
    : 'Preço por unidade';

  const create = async () => {
    if (!name.trim()) { toast.error('Informe o nome do produto.'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'product', name: name.trim(), description: description.trim(),
          price: Number(price) || 0, stock_control_enabled: false,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.id) { toast.error(data?.error || 'Erro ao criar produto.'); return; }
      // Define o modo de venda escolhido (se não for o padrão).
      if (saleMode !== 'unit') {
        await apiFetch(`/api/storefront/products/${data.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sale_mode: saleMode }),
        }).catch(() => {});
      }
      toast.success('Produto criado! Agora adicione fotos e ajuste as opções.');
      onCreated();
    } catch {
      toast.error('Erro ao criar produto.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">Novo produto</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <Field label="Nome">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Camiseta Premium" autoFocus />
          </Field>
          <Field label="Descrição (opcional)">
            <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Breve descrição" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Modo de venda">
              <select className={inputClass} value={saleMode} onChange={(e) => setSaleMode(e.target.value as any)}>
                <option value="unit">Unidade</option>
                <option value="slice">Fatia</option>
                <option value="size">Tamanho (P/M/G)</option>
                <option value="weight">Peso (kg)</option>
                <option value="volume">Volume (L)</option>
              </select>
            </Field>
            <Field label={priceHint}>
              <input className={inputClass} type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" />
            </Field>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={create} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Criar produto'}
          </Button>
        </div>
      </div>
    </div>
  );
}

type Analytics = {
  days: number; visits: number; orders: number; revenue: number; paidRevenue: number;
  conversion: number; topProducts: { id: string; name: string; clicks: number }[];
};

// Relatório da vitrine: visitas, conversão, pedidos e produtos mais clicados.
function AnalyticsSection() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiFetch(`/api/storefront/analytics?days=${days}`).then((r) => r.json())
      .then((d) => { if (active) setData(d); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days]);

  const brl = (v: number) => `R$ ${Number(v || 0).toFixed(2)}`;

  return (
    <section className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><BarChart3 className="w-5 h-5 text-sky-400" /> Relatório da vitrine</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Visitas, conversão e produtos mais clicados na sua loja virtual.</p>
        </div>
        <div className="flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${days === d ? 'bg-sky-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
              {d} dias
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400 py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>
      ) : !data ? (
        <p className="text-sm text-zinc-500 py-4">Não foi possível carregar o relatório.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Metric label="Visitas" value={String(data.visits)} accent="text-sky-400" />
            <Metric label="Pedidos" value={String(data.orders)} accent="text-indigo-400" />
            <Metric label="Conversão" value={`${data.conversion}%`} accent="text-emerald-400" hint="pedidos ÷ visitas" />
            <Metric label="Receita" value={brl(data.revenue)} accent="text-emerald-400" hint={`${brl(data.paidRevenue)} pago`} />
          </div>

          <p className="text-sm text-zinc-300 font-medium mt-5 mb-2">Produtos mais clicados</p>
          {data.topProducts.length === 0 ? (
            <p className="text-sm text-zinc-500">Ainda sem cliques registrados no período.</p>
          ) : (
            <div className="space-y-1.5">
              {data.topProducts.map((p, i) => {
                const max = data.topProducts[0]?.clicks || 1;
                return (
                  <div key={p.id} className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500 w-5 text-right">{i + 1}.</span>
                    <span className="text-sm text-zinc-200 flex-1 truncate">{p.name}</span>
                    <div className="hidden sm:block w-40 h-2 rounded-full bg-zinc-800 overflow-hidden">
                      <div className="h-full bg-sky-500/70" style={{ width: `${Math.max(6, (p.clicks / max) * 100)}%` }} />
                    </div>
                    <span className="text-xs font-mono text-zinc-400 w-12 text-right">{p.clicks}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[11px] text-zinc-600 mt-4">As visitas e cliques começam a ser contados a partir de agora (após o deploy desta versão).</p>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, accent, hint }: { label: string; value: string; accent: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-bold mt-1 ${accent}`}>{value}</p>
      {hint && <p className="text-[10px] text-zinc-600 mt-0.5">{hint}</p>}
    </div>
  );
}

type Coupon = {
  id: string; code: string; type: 'percent' | 'fixed'; value: number; min_order: number;
  active: boolean; expires_at: string | null; usage_limit: number | null; used_count: number;
};

// Seção de cupons de desconto da vitrine (CRUD próprio).
function CouponsSection() {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: '', type: 'percent', value: '', min_order: '', expires_at: '', usage_limit: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const d = await apiFetch('/api/storefront/coupons').then((r) => r.json());
      setCoupons(Array.isArray(d) ? d : []);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!form.code.trim()) { toast.error('Informe o código.'); return; }
    if (!(Number(form.value) > 0)) { toast.error('Informe um valor de desconto válido.'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/storefront/coupons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: form.code, type: form.type, value: Number(form.value),
          min_order: form.min_order ? Number(form.min_order) : 0,
          expires_at: form.expires_at || null,
          usage_limit: form.usage_limit || null,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Erro ao criar cupom.'); return; }
      toast.success('Cupom criado.');
      setForm({ code: '', type: 'percent', value: '', min_order: '', expires_at: '', usage_limit: '' });
      setShowForm(false); load();
    } catch (e) { toast.error('Erro ao criar cupom.'); }
    finally { setSaving(false); }
  };

  const toggle = async (c: Coupon) => {
    setCoupons((list) => list.map((x) => (x.id === c.id ? { ...x, active: !x.active } : x)));
    try { await apiFetch(`/api/storefront/coupons/${c.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !c.active }) }); }
    catch (e) { load(); }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Excluir este cupom?')) return;
    setCoupons((list) => list.filter((x) => x.id !== id));
    try { await apiFetch(`/api/storefront/coupons/${id}`, { method: 'DELETE' }); }
    catch (e) { load(); }
  };

  const fmtVal = (c: Coupon) => (c.type === 'percent' ? `${c.value}%` : `R$ ${Number(c.value).toFixed(2)}`);

  return (
    <section className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Tag className="w-5 h-5 text-emerald-400" /> Cupons de desconto</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Crie cupons (% ou valor fixo). O cliente aplica no carrinho da vitrine.</p>
        </div>
        <Button variant="outline" className="border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10" onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-4 h-4 mr-2" /> Novo cupom
        </Button>
      </div>

      {showForm && (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Código"><input className={`${inputClass} uppercase`} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="BEMVINDO10" /></Field>
          <Field label="Tipo">
            <select className={inputClass} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="percent">Percentual (%)</option>
              <option value="fixed">Valor fixo (R$)</option>
            </select>
          </Field>
          <Field label={form.type === 'percent' ? 'Desconto (%)' : 'Desconto (R$)'}><input className={inputClass} type="number" min="0" step="0.01" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></Field>
          <Field label="Pedido mínimo (R$, opcional)"><input className={inputClass} type="number" min="0" step="0.01" value={form.min_order} onChange={(e) => setForm({ ...form, min_order: e.target.value })} placeholder="0" /></Field>
          <Field label="Validade (opcional)"><input className={inputClass} type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></Field>
          <Field label="Limite de usos (opcional)"><input className={inputClass} type="number" min="1" value={form.usage_limit} onChange={(e) => setForm({ ...form, usage_limit: e.target.value })} placeholder="ilimitado" /></Field>
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowForm(false)}>Cancelar</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={create} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Criar cupom'}</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400 py-6 justify-center"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>
      ) : coupons.length === 0 ? (
        <p className="text-sm text-zinc-500 py-4">Nenhum cupom ainda.</p>
      ) : (
        <div className="space-y-2 mt-3">
          {coupons.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-4 py-2.5 gap-3">
              <div className="min-w-0">
                <p className="text-sm font-mono font-semibold text-zinc-100">{c.code} <span className="text-emerald-400">· {fmtVal(c)}</span></p>
                <p className="text-[11px] text-zinc-500 truncate">
                  {c.min_order > 0 ? `mín. R$ ${Number(c.min_order).toFixed(2)} · ` : ''}
                  {c.expires_at ? `até ${new Date(c.expires_at).toLocaleDateString('pt-BR')} · ` : ''}
                  {c.usage_limit != null ? `${c.used_count}/${c.usage_limit} usos` : `${c.used_count} uso(s)`}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={() => toggle(c)}
                  className={`text-xs px-2 py-1 rounded border ${c.active ? 'border-emerald-500/40 text-emerald-300' : 'border-zinc-700 text-zinc-500'}`}>
                  {c.active ? 'Ativo' : 'Inativo'}
                </button>
                <button onClick={() => remove(c.id)} title="Excluir" className="text-zinc-400 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const inputClass = 'w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm text-zinc-400 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

// Carrega um File como <img> (para desenhar no canvas).
function loadImageEl(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// Redimensiona e comprime a imagem no navegador antes do upload. Assim, fotos
// grandes (banners/logos em alta resolução) passam sem estourar limites de
// tamanho. Usa WebP para preservar transparência (logos) com bom tamanho.
// SVG/GIF passam intactos (vetor/animação).
async function compressImage(file: File, maxDim = 1920, quality = 0.85): Promise<File> {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return file;
  try {
    const img = await loadImageEl(file);
    const big = Math.max(img.width, img.height);
    // Já é pequena o bastante: não recomprime.
    if (big <= maxDim && file.size <= 1_200_000) return file;
    const scale = Math.min(1, maxDim / big);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob || blob.size === 0) return file;
    // Se a "compressão" ficou maior que o original, mantém o original.
    if (blob.size >= file.size && big <= maxDim) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' });
  } catch {
    return file;
  }
}

// Faz upload de um arquivo de imagem e devolve a URL pública (/media/...).
export async function uploadImageFile(file: File): Promise<string> {
  const prepared = await compressImage(file);
  const fd = new FormData();
  fd.append('file', prepared);
  const res = await apiFetch('/api/uploads/image', { method: 'POST', body: fd });
  if (res.status === 413) throw new Error('Imagem muito grande. Tente uma imagem menor.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha no upload da imagem.');
  return data.url as string;
}

// Campo de imagem com upload (botão) + URL manual + preview + dica de dimensões.
function ImageUploadInput({
  label, hint, value, onChange, previewClass = 'h-16 w-16 rounded-lg object-cover',
}: {
  label: string; hint: string; value: string;
  onChange: (url: string) => void; previewClass?: string;
}) {
  const [busy, setBusy] = useState(false);
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadImageFile(file);
      onChange(url);
      toast.success('Imagem enviada!');
    } catch (err: any) {
      toast.error(err.message || 'Falha no upload.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label={label}>
      <div className="flex items-start gap-3">
        {value ? (
          <img src={value} alt="" className={`${previewClass} border border-zinc-800 bg-zinc-900`} />
        ) : (
          <div className={`${previewClass} flex items-center justify-center border border-dashed border-zinc-700 bg-zinc-900 text-zinc-600`}>
            <ImageIcon className="h-5 w-5" />
          </div>
        )}
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="https://... ou envie um arquivo"
            />
            <label className="shrink-0 inline-flex cursor-pointer items-center gap-1.5 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
              Enviar
              <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={busy} />
            </label>
            {value && (
              <button type="button" onClick={() => onChange('')} className="shrink-0 rounded border border-zinc-800 px-2 text-zinc-500 hover:text-zinc-300" title="Remover">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="text-xs text-zinc-500">{hint}</p>
        </div>
      </div>
    </Field>
  );
}

function normalizeProduct(p: any): StorefrontProduct {
  return {
    id: p.id,
    name: p.name,
    price: Number(p.price ?? 0),
    currency: p.currency || 'BRL',
    description: p.description || '',
    sale_mode: (['unit', 'slice', 'size', 'weight', 'volume'].includes(p.sale_mode) ? p.sale_mode : 'unit') as SaleMode,
    sale_options: p.sale_options || {},
    storefront_visible: p.storefront_visible ? 1 : 0,
    featured: !!p.featured,
    images: Array.isArray(p.images) ? p.images : [],
  };
}

type ProductRowProps = {
  product: StorefrontProduct;
  onPatch: (updates: Partial<StorefrontProduct>) => void;
  onDelete: () => void;
  onEdit: () => void;
  dragHandleProps?: any;
};

const ProductRow: React.FC<ProductRowProps> = ({ product, onPatch, onDelete, onEdit, dragHandleProps }) => {
  // texto editável das opções de venda (size/weight/volume)
  const optionsToText = (mode: SaleMode, opts: any): string => {
    if (mode === 'size') return Array.isArray(opts?.sizes) ? opts.sizes.join(',') : '';
    if (mode === 'weight' || mode === 'volume') return Array.isArray(opts?.steps) ? opts.steps.join(',') : '';
    return '';
  };

  const [optionsText, setOptionsText] = useState(() => optionsToText(product.sale_mode, product.sale_options));
  const [imageUrl, setImageUrl] = useState('');
  const [uploadingImg, setUploadingImg] = useState(false);
  const [savingOptions, setSavingOptions] = useState(false);

  const persist = async (updates: Partial<StorefrontProduct> & { sale_options?: any }) => {
    const body: any = {};
    if (updates.sale_mode !== undefined) body.sale_mode = updates.sale_mode;
    if (updates.sale_options !== undefined) body.sale_options = updates.sale_options;
    if (updates.storefront_visible !== undefined) body.storefront_visible = !!updates.storefront_visible;
    if (updates.featured !== undefined) body.featured = updates.featured;
    try {
      const res = await apiFetch(`/api/storefront/products/${product.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Erro ao salvar produto.');
        return false;
      }
      return true;
    } catch {
      toast.error('Erro ao salvar produto.');
      return false;
    }
  };

  const toggleVisible = async () => {
    const next = product.storefront_visible ? 0 : 1;
    onPatch({ storefront_visible: next });
    const ok = await persist({ storefront_visible: next });
    if (!ok) onPatch({ storefront_visible: product.storefront_visible });
  };

  const toggleFeatured = async () => {
    const next = !product.featured;
    onPatch({ featured: next });
    const ok = await persist({ featured: next });
    if (!ok) onPatch({ featured: product.featured });
  };

  const changeMode = async (mode: SaleMode) => {
    const text = optionsToText(mode, product.sale_options);
    setOptionsText(text);
    onPatch({ sale_mode: mode });
    await persist({ sale_mode: mode });
  };

  const parseOptions = (mode: SaleMode, text: string): any => {
    const parts = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (mode === 'size') return { sizes: parts };
    if (mode === 'weight' || mode === 'volume') {
      const steps = parts.map((s) => Number(s)).filter((n) => !Number.isNaN(n));
      return { steps };
    }
    return {};
  };

  const saveOptions = async () => {
    setSavingOptions(true);
    const opts = parseOptions(product.sale_mode, optionsText);
    onPatch({ sale_options: opts });
    const ok = await persist({ sale_options: opts });
    setSavingOptions(false);
    if (ok) toast.success('Opções de venda salvas.');
  };

  const addImage = async (rawUrl?: string) => {
    const url = (rawUrl ?? imageUrl).trim();
    if (!url) return;
    try {
      const res = await apiFetch(`/api/storefront/products/${product.id}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.id) {
        onPatch({ images: [...product.images, data] });
        if (rawUrl === undefined) setImageUrl('');
      } else {
        toast.error(data?.error || 'Erro ao adicionar imagem.');
      }
    } catch {
      toast.error('Erro ao adicionar imagem.');
    }
  };

  const uploadProductImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingImg(true);
    try {
      const url = await uploadImageFile(file);
      await addImage(url);
    } catch (err: any) {
      toast.error(err.message || 'Falha no upload.');
    } finally {
      setUploadingImg(false);
    }
  };

  const removeImage = async (imageId: string) => {
    try {
      const res = await apiFetch(`/api/storefront/products/${product.id}/images/${imageId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        onPatch({ images: product.images.filter((img) => img.id !== imageId) });
      } else {
        toast.error('Erro ao remover imagem.');
      }
    } catch {
      toast.error('Erro ao remover imagem.');
    }
  };

  const sortedImages = [...product.images].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const optionsPlaceholder =
    product.sale_mode === 'size'
      ? 'P,M,G,GG'
      : product.sale_mode === 'weight'
      ? '100,250,500,1000 (g)'
      : product.sale_mode === 'volume'
      ? '250,500,1000 (ml)'
      : '';

  const optionsLabel =
    product.sale_mode === 'size'
      ? 'Tamanhos (separados por vírgula)'
      : product.sale_mode === 'weight'
      ? 'Pesos em gramas (separados por vírgula)'
      : product.sale_mode === 'volume'
      ? 'Volumes em ml (separados por vírgula)'
      : '';

  return (
    <div className="p-4 rounded-xl border border-zinc-800 bg-zinc-950/50">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          {dragHandleProps && (
            <span {...dragHandleProps} className="mt-0.5 cursor-grab text-zinc-500 hover:text-zinc-300 active:cursor-grabbing" title="Arrastar para reordenar">
              <GripVertical className="w-4 h-4" />
            </span>
          )}
          <div className="min-w-0">
            <h4 className="font-semibold text-zinc-100 truncate">{product.name}</h4>
            <p className="font-mono text-sm text-zinc-400 mt-0.5">
              {product.currency} {product.price.toFixed(2)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-indigo-500/50 hover:text-indigo-300"
          >
            <Pencil className="w-3.5 h-3.5" /> Editar
          </button>
          <button
            type="button"
            onClick={toggleVisible}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              product.storefront_visible
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {product.storefront_visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            {product.storefront_visible ? 'Visível' : 'Oculto'}
          </button>
          <button
            type="button"
            onClick={toggleFeatured}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
              product.featured
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Star className={`w-3.5 h-3.5 ${product.featured ? 'fill-amber-400' : ''}`} />
            Destaque
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Excluir produto do catálogo e da loja"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-rose-500/40 hover:text-rose-300"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Excluir
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Modo de venda</label>
          <select
            className={inputClass}
            value={product.sale_mode}
            onChange={(e) => changeMode(e.target.value as SaleMode)}
          >
            <option value="unit">Unidade</option>
            <option value="slice">Fatia</option>
            <option value="size">Tamanho</option>
            <option value="weight">Peso</option>
            <option value="volume">Volume</option>
          </select>
        </div>

        {(product.sale_mode === 'size' || product.sale_mode === 'weight' || product.sale_mode === 'volume') && (
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">{optionsLabel}</label>
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                onBlur={saveOptions}
                placeholder={optionsPlaceholder}
              />
              <Button
                size="sm"
                onClick={saveOptions}
                disabled={savingOptions}
                className="bg-indigo-600 hover:bg-indigo-700 text-white shrink-0"
              >
                {savingOptions ? <Loader2 className="w-4 h-4 animate-spin" /> : 'OK'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Imagens */}
      <div className="mt-4">
        <label className="text-xs text-zinc-400 mb-2 block">Imagens (a primeira é a capa)</label>
        <div className="flex flex-wrap gap-3">
          {sortedImages.map((img, idx) => (
            <div key={img.id} className="relative group">
              <img
                src={img.url}
                alt=""
                className="h-20 w-20 object-cover rounded-lg border border-zinc-800 bg-zinc-900"
              />
              {idx === 0 && (
                <span className="absolute bottom-1 left-1 text-[10px] font-medium bg-black/70 text-white px-1.5 py-0.5 rounded">
                  Capa
                </span>
              )}
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center rounded-full bg-rose-600 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                title="Remover imagem"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          {sortedImages.length === 0 && (
            <div className="h-20 w-20 flex items-center justify-center rounded-lg border border-dashed border-zinc-800 text-zinc-600">
              <ImageIcon className="w-5 h-5" />
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2 mt-3 items-center">
          {/* Upload do dispositivo — ação principal, sempre ativa */}
          <label className="shrink-0 inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 px-3 py-2 text-sm font-medium text-white">
            {uploadingImg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {uploadingImg ? 'Enviando...' : 'Adicionar foto'}
            <input type="file" accept="image/*" className="hidden" onChange={uploadProductImage} disabled={uploadingImg} />
          </label>
          <span className="text-xs text-zinc-600">ou cole o link de uma imagem:</span>
          <input
            className={`${inputClass} flex-1 min-w-[160px]`}
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addImage();
              }
            }}
            placeholder="https://url-da-imagem.jpg"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => addImage()}
            disabled={!imageUrl.trim()}
            className="border-zinc-700 text-zinc-200 shrink-0"
          >
            Usar link
          </Button>
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">Recomendado: quadrado, 1000×1000 px (1:1). JPG/PNG/WEBP, máx. 5 MB. A 1ª imagem é a capa.</p>
      </div>
    </div>
  );
};
