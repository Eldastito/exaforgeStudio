import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Heart, ShoppingCart, Store as StoreIcon, AlertCircle, Sparkles } from 'lucide-react';
import type {
  CartItem,
  ChosenOption,
  Mode,
  OrderResponse,
  Product,
  StoreResponse,
} from './types';
import {
  cartKey,
  computeUnitPrice,
  hexToRgba,
  lsGet,
  lsSet,
  optionLabel,
} from './utils';
import { ThemeToggle } from './ThemeToggle';
import { ProductCard } from './ProductCard';
import { ProductModal } from './ProductModal';
import { CartDrawer } from './CartDrawer';

// Lê o slug do pathname (/loja/:slug) e o token ?c=.
function readUrl(): { slug: string; token: string | null } {
  const path = window.location.pathname;
  const prefix = '/loja/';
  let slug = '';
  if (path.startsWith(prefix)) {
    slug = decodeURIComponent(path.slice(prefix.length).split('/')[0] ?? '');
  }
  const token = new URLSearchParams(window.location.search).get('c');
  return { slug, token };
}

const DEFAULT_ACCENT = '#6366f1';

export function Storefront() {
  const { slug, token } = useMemo(readUrl, []);

  const [data, setData] = useState<StoreResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [mode, setMode] = useState<Mode>('night');
  const [favorites, setFavorites] = useState<string[]>(() => lsGet<string[]>(`storefront_favs_${slug}`, []));
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [cart, setCart] = useState<CartItem[]>(() => lsGet<CartItem[]>(`storefront_cart_${slug}`, []));

  const [activeProduct, setActiveProduct] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);

  const accent = data?.store.accent_color || DEFAULT_ACCENT;

  // Fetch inicial.
  useEffect(() => {
    let alive = true;
    if (!slug) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/public/store/${encodeURIComponent(slug)}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as StoreResponse;
        if (!alive) return;
        setData(json);
        // Inicializa o tema a partir do default da loja (com persistência).
        const stored = lsGet<Mode | null>(`storefront_mode_${slug}`, null);
        setMode(stored ?? json.store.default_mode ?? 'night');
      } catch {
        if (alive) setNotFound(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [slug]);

  // Persistências.
  useEffect(() => { lsSet(`storefront_favs_${slug}`, favorites); }, [favorites, slug]);
  useEffect(() => { lsSet(`storefront_cart_${slug}`, cart); }, [cart, slug]);
  useEffect(() => { lsSet(`storefront_mode_${slug}`, mode); }, [mode, slug]);

  const night = mode === 'night';

  const toggleMode = useCallback(() => setMode((m) => (m === 'night' ? 'day' : 'night')), []);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const addToCart = useCallback((product: Product, option: ChosenOption, qty: number) => {
    const key = cartKey(product.id, option);
    const unitPrice = computeUnitPrice(product, option);
    setCart((prev) => {
      const existing = prev.find((i) => i.key === key);
      if (existing) {
        return prev.map((i) => (i.key === key ? { ...i, quantity: i.quantity + qty } : i));
      }
      const item: CartItem = {
        key,
        productId: product.id,
        name: product.name,
        image: product.images?.[0] ?? null,
        unitPrice,
        quantity: qty,
        optionLabel: optionLabel(product, option),
        option,
      };
      return [...prev, item];
    });
  }, []);

  const changeQty = useCallback((key: string, qty: number) => {
    setCart((prev) =>
      qty <= 0 ? prev.filter((i) => i.key !== key) : prev.map((i) => (i.key === key ? { ...i, quantity: qty } : i)),
    );
  }, []);

  const removeItem = useCallback((key: string) => {
    setCart((prev) => prev.filter((i) => i.key !== key));
  }, []);

  const handleAdd = useCallback((product: Product, option: ChosenOption, qty: number) => {
    addToCart(product, option, qty);
    setActiveProduct(null);
  }, [addToCart]);

  const handleBuyNow = useCallback((product: Product, option: ChosenOption, qty: number) => {
    addToCart(product, option, qty);
    setActiveProduct(null);
    setCartOpen(true);
  }, [addToCart]);

  const submitOrder = useCallback(
    async (extra: { name: string; phone: string }): Promise<OrderResponse | null> => {
      const body = {
        token: token ?? undefined,
        customer: { name: extra.name, phone: extra.phone },
        items: cart.map((i) => ({ productId: i.productId, quantity: i.quantity, option: i.option })),
      };
      const res = await fetch(`/api/public/store/${encodeURIComponent(slug)}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return (await res.json()) as OrderResponse;
    },
    [cart, slug, token],
  );

  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

  // Ordena: destaques primeiro, depois disponíveis.
  const products = useMemo(() => {
    if (!data) return [];
    let list = [...data.products];
    if (onlyFavs) list = list.filter((p) => favorites.includes(p.id));
    list.sort((a, b) => {
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      if (a.available !== b.available) return a.available ? -1 : 1;
      return 0;
    });
    return list;
  }, [data, onlyFavs, favorites]);

  const productById = useMemo(() => {
    const m: Record<string, Product> = {};
    (data?.products || []).forEach((p) => { m[p.id] = p; });
    return m;
  }, [data]);

  // Coleções (curadoria da IA): cada uma vira uma seção com seus produtos.
  // Ocultas quando o cliente filtra só favoritos.
  const collectionSections = useMemo(() => {
    if (!data?.collections || onlyFavs) return [];
    return data.collections
      .map((c) => ({ id: c.id, title: c.title, items: c.productIds.map((id) => productById[id]).filter(Boolean) as Product[] }))
      .filter((c) => c.items.length > 0);
  }, [data, onlyFavs, productById]);

  // Fundo conforme tema.
  const pageBg = night
    ? 'bg-[#070914] text-white'
    : 'bg-[#eef2fb] text-slate-800';

  return (
    <div className={['relative min-h-screen overflow-x-hidden transition-colors duration-700', pageBg].join(' ')}>
      {/* Camada de gradiente cósmico / airoso */}
      <BackgroundLayer mode={mode} accent={accent} />

      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-24 pt-4 sm:px-6">
        {loading ? (
          <SkeletonView night={night} />
        ) : notFound || !data ? (
          <NotFoundView night={night} />
        ) : (
          <>
            <Header
              title={data.store.title}
              subtitle={data.store.subtitle}
              logoUrl={data.store.logo_url}
              accent={accent}
              mode={mode}
              favCount={favorites.length}
              cartCount={cartCount}
              onToggleMode={toggleMode}
              onOpenCart={() => setCartOpen(true)}
              onToggleFavFilter={() => setOnlyFavs((v) => !v)}
              onlyFavs={onlyFavs}
            />

            {data.store.banner_url && (
              <div
                className="mt-4 overflow-hidden rounded-3xl border"
                style={{ borderColor: hexToRgba(accent, 0.3) }}
              >
                <img src={data.store.banner_url} alt="" className="h-40 w-full object-cover sm:h-56" />
              </div>
            )}

            {data.customer && (
              <p className="mt-5 flex items-center gap-2 text-sm opacity-80">
                <Sparkles className="h-4 w-4" style={{ color: accent }} />
                Olá, <span className="font-semibold">{data.customer.name}</span>! Que bom te ver por aqui.
              </p>
            )}

            {/* Coleções (seções curadas pela IA) */}
            {collectionSections.map((sec) => (
              <section key={sec.id} className="mt-8">
                <h2 className="mb-3 text-lg font-semibold tracking-tight">{sec.title}</h2>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  {sec.items.map((p) => (
                    <ProductCard
                      key={`${sec.id}-${p.id}`}
                      product={p}
                      accent={accent}
                      mode={mode}
                      isFavorite={favorites.includes(p.id)}
                      onToggleFavorite={toggleFavorite}
                      onOpen={setActiveProduct}
                    />
                  ))}
                </div>
              </section>
            ))}

            {/* Grid */}
            <div className="mt-8">
              {collectionSections.length > 0 && products.length > 0 && (
                <h2 className="mb-3 text-lg font-semibold tracking-tight">Todos os produtos</h2>
              )}
              {products.length === 0 ? (
                <div className="grid place-items-center rounded-3xl border border-dashed py-20 text-center opacity-60"
                  style={{ borderColor: hexToRgba(accent, 0.3) }}>
                  <Heart className="mb-2 h-8 w-8" />
                  <p className="text-sm">
                    {onlyFavs ? 'Você ainda não favoritou nenhum produto.' : 'Nenhum produto disponível no momento.'}
                  </p>
                </div>
              ) : (
                <motion.div layout className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                  <AnimatePresence>
                    {products.map((p) => (
                      <ProductCard
                        key={p.id}
                        product={p}
                        accent={accent}
                        mode={mode}
                        isFavorite={favorites.includes(p.id)}
                        onToggleFavorite={toggleFavorite}
                        onOpen={setActiveProduct}
                      />
                    ))}
                  </AnimatePresence>
                </motion.div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Modal de produto */}
      {activeProduct && (
        <ProductModal
          product={activeProduct}
          accent={accent}
          mode={mode}
          isFavorite={favorites.includes(activeProduct.id)}
          onToggleFavorite={toggleFavorite}
          onClose={() => setActiveProduct(null)}
          onAdd={handleAdd}
          onBuyNow={handleBuyNow}
        />
      )}

      {/* Carrinho */}
      <CartDrawer
        open={cartOpen}
        items={cart}
        accent={accent}
        mode={mode}
        customer={data?.customer ?? null}
        onClose={() => setCartOpen(false)}
        onChangeQty={changeQty}
        onRemove={removeItem}
        onSubmit={submitOrder}
        onClear={() => setCart([])}
      />
    </div>
  );
}

// ---- Subviews ----

function BackgroundLayer({ mode, accent }: { mode: Mode; accent: string }) {
  const night = mode === 'night';
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <AnimatePresence mode="wait">
        <motion.div
          key={mode}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7 }}
          className="absolute inset-0"
        >
          {night ? (
            <>
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,#1a1f3a_0%,#070914_55%)]" />
              <div
                className="absolute -top-32 left-1/4 h-96 w-96 rounded-full blur-3xl"
                style={{ backgroundColor: hexToRgba(accent, 0.25) }}
              />
              <div
                className="absolute bottom-0 right-0 h-96 w-96 rounded-full blur-3xl"
                style={{ backgroundColor: hexToRgba(accent, 0.18) }}
              />
              <Stars />
            </>
          ) : (
            <>
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,#ffffff_0%,#eef2fb_60%)]" />
              <div
                className="absolute -top-24 left-1/4 h-96 w-96 rounded-full blur-3xl"
                style={{ backgroundColor: hexToRgba(accent, 0.18) }}
              />
              <div
                className="absolute bottom-0 right-10 h-80 w-80 rounded-full blur-3xl"
                style={{ backgroundColor: hexToRgba(accent, 0.12) }}
              />
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Stars() {
  // Pequenas estrelas estáticas para o tema noturno.
  const stars = useMemo(
    () =>
      Array.from({ length: 40 }).map((_, i) => ({
        id: i,
        top: Math.random() * 100,
        left: Math.random() * 100,
        size: Math.random() * 2 + 1,
        delay: Math.random() * 3,
      })),
    [],
  );
  return (
    <>
      {stars.map((s) => (
        <motion.span
          key={s.id}
          className="absolute rounded-full bg-white"
          style={{ top: `${s.top}%`, left: `${s.left}%`, width: s.size, height: s.size }}
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ duration: 2 + s.delay, repeat: Infinity, delay: s.delay }}
        />
      ))}
    </>
  );
}

interface HeaderProps {
  title: string;
  subtitle: string;
  logoUrl: string | null;
  accent: string;
  mode: Mode;
  favCount: number;
  cartCount: number;
  onlyFavs: boolean;
  onToggleMode: () => void;
  onOpenCart: () => void;
  onToggleFavFilter: () => void;
}

function Header({
  title, subtitle, logoUrl, accent, mode, favCount, cartCount, onlyFavs,
  onToggleMode, onOpenCart, onToggleFavFilter,
}: HeaderProps) {
  const night = mode === 'night';
  const glass = night
    ? 'bg-white/5 border-white/10'
    : 'bg-white/60 border-white/70';

  return (
    <header
      className={['flex items-center gap-3 rounded-3xl border p-3 backdrop-blur-2xl sm:p-4', glass].join(' ')}
      style={{ boxShadow: `0 10px 40px ${hexToRgba(accent, night ? 0.18 : 0.12)}` }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={title}
            className="h-11 w-11 shrink-0 rounded-2xl object-cover"
            style={{ boxShadow: `0 0 0 2px ${hexToRgba(accent, 0.4)}` }}
          />
        ) : (
          <div
            className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-white"
            style={{ backgroundColor: accent }}
          >
            <StoreIcon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold leading-tight sm:text-lg">{title}</h1>
          {subtitle && <p className="truncate text-xs opacity-60 sm:text-sm">{subtitle}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden sm:block">
          <ThemeToggle mode={mode} accent={accent} onToggle={onToggleMode} />
        </div>

        <IconButton
          night={night}
          active={onlyFavs}
          accent={accent}
          onClick={onToggleFavFilter}
          label="Favoritos"
          count={favCount}
        >
          <Heart
            className="h-5 w-5"
            style={{ color: onlyFavs ? '#fff' : undefined, fill: onlyFavs ? '#fff' : 'transparent' }}
          />
        </IconButton>

        <IconButton
          night={night}
          accent={accent}
          onClick={onOpenCart}
          label="Carrinho"
          count={cartCount}
        >
          <ShoppingCart className="h-5 w-5" />
        </IconButton>
      </div>

      {/* Toggle no mobile (abaixo) */}
      <div className="sm:hidden">
        <ThemeToggle mode={mode} accent={accent} onToggle={onToggleMode} />
      </div>
    </header>
  );
}

function IconButton({
  children, night, accent, onClick, label, count, active,
}: {
  children: ReactNode;
  night: boolean;
  accent: string;
  onClick: () => void;
  label: string;
  count?: number;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={[
        'relative grid h-11 w-11 place-items-center rounded-2xl border backdrop-blur-md transition',
        night ? 'border-white/10 hover:bg-white/10' : 'border-white/70 hover:bg-white',
      ].join(' ')}
      style={active ? { backgroundColor: accent, borderColor: accent, color: '#fff' } : undefined}
    >
      {children}
      {!!count && count > 0 && (
        <span
          className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] font-bold text-white"
          style={{ backgroundColor: accent }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function SkeletonView({ night }: { night: boolean }) {
  const block = night ? 'bg-white/10' : 'bg-slate-200/70';
  return (
    <div className="animate-pulse">
      <div className={['h-20 rounded-3xl', block].join(' ')} />
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={['aspect-[3/4] rounded-2xl', block].join(' ')} />
        ))}
      </div>
    </div>
  );
}

function NotFoundView({ night }: { night: boolean }) {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center gap-4 text-center">
      <div
        className={[
          'grid h-20 w-20 place-items-center rounded-3xl border backdrop-blur-xl',
          night ? 'border-white/10 bg-white/5' : 'border-white/70 bg-white/60',
        ].join(' ')}
      >
        <AlertCircle className="h-9 w-9 opacity-70" />
      </div>
      <div>
        <h1 className="text-2xl font-bold">Loja não encontrada</h1>
        <p className="mt-1 text-sm opacity-60">
          Verifique o endereço e tente novamente.
        </p>
      </div>
    </div>
  );
}
