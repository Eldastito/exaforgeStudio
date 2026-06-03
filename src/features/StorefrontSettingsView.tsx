import React, { useEffect, useState } from 'react';
import { Store, Save, Copy, Plus, X, Star, Eye, EyeOff, Image as ImageIcon, Loader2 } from 'lucide-react';
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
};

type SaleMode = 'unit' | 'size' | 'weight' | 'volume';

type ProductImage = { id: string; url: string; position: number };

type StorefrontProduct = {
  id: string;
  name: string;
  price: number;
  currency: string;
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
          default_mode: (data.default_mode === 'night' ? 'night' : 'day'),
        });
      })
      .catch((e) => console.error(e))
      .finally(() => active && setLoadingSettings(false));

    apiFetch('/api/storefront/products')
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        setProducts(Array.isArray(data) ? data.map(normalizeProduct) : []);
      })
      .catch((e) => console.error(e))
      .finally(() => active && setLoadingProducts(false));

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
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSettings({
          ...emptySettings,
          ...data,
          published: !!data.published,
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
          <h3 className="text-lg font-semibold text-zinc-100 mb-4">Produtos na vitrine</h3>

          {loadingProducts ? (
            <div className="flex items-center gap-2 text-zinc-400 py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando produtos...
            </div>
          ) : products.length === 0 ? (
            <div className="grid grid-cols-1">
              <EmptyState
                icon={<Store className="w-6 h-6" />}
                title="Nenhum produto disponível"
                description="Cadastre produtos no Catálogo para poder exibi-los na sua loja virtual."
              />
            </div>
          ) : (
            <div className="space-y-4">
              {products.map((p: StorefrontProduct) => (
                <ProductRow key={p.id} product={p} onPatch={(u) => patchProduct(p.id, u)} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
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

// Faz upload de um arquivo de imagem e devolve a URL pública (/media/...).
export async function uploadImageFile(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await apiFetch('/api/uploads/image', { method: 'POST', body: fd });
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
    sale_mode: (['unit', 'size', 'weight', 'volume'].includes(p.sale_mode) ? p.sale_mode : 'unit') as SaleMode,
    sale_options: p.sale_options || {},
    storefront_visible: p.storefront_visible ? 1 : 0,
    featured: !!p.featured,
    images: Array.isArray(p.images) ? p.images : [],
  };
}

type ProductRowProps = {
  product: StorefrontProduct;
  onPatch: (updates: Partial<StorefrontProduct>) => void;
};

const ProductRow: React.FC<ProductRowProps> = ({ product, onPatch }) => {
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
        <div>
          <h4 className="font-semibold text-zinc-100">{product.name}</h4>
          <p className="font-mono text-sm text-zinc-400 mt-0.5">
            {product.currency} {product.price.toFixed(2)}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            <option value="size">Tamanho</option>
            <option value="weight">Peso</option>
            <option value="volume">Volume</option>
          </select>
        </div>

        {product.sale_mode !== 'unit' && (
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
        <div className="flex gap-2 mt-3">
          <input
            className={inputClass}
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
            <Plus className="w-4 h-4 mr-1" /> Adicionar
          </Button>
          <label className="shrink-0 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-200 hover:bg-zinc-700">
            {uploadingImg ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
            Enviar
            <input type="file" accept="image/*" className="hidden" onChange={uploadProductImage} disabled={uploadingImg} />
          </label>
        </div>
        <p className="text-xs text-zinc-500 mt-1.5">Recomendado: quadrado, 1000×1000 px (1:1). JPG/PNG/WEBP, máx. 5 MB. A 1ª imagem é a capa.</p>
      </div>
    </div>
  );
};
