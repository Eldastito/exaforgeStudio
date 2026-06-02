import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  X, ChevronLeft, ChevronRight, Heart, Minus, Plus, ShoppingCart, Zap, ImageOff,
} from 'lucide-react';
import type { ChosenOption, Mode, Product } from './types';
import {
  computeUnitPrice,
  formatBRL,
  getSizes,
  getVolumeSteps,
  getWeightSteps,
  gramsLabel,
  hexToRgba,
  mlLabel,
  optionLabel,
  unitPriceLabel,
} from './utils';

interface Props {
  product: Product;
  accent: string;
  mode: Mode;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onClose: () => void;
  onAdd: (product: Product, option: ChosenOption, qty: number) => void;
  onBuyNow: (product: Product, option: ChosenOption, qty: number) => void;
}

export function ProductModal({
  product,
  accent,
  mode,
  isFavorite,
  onToggleFavorite,
  onClose,
  onAdd,
  onBuyNow,
}: Props) {
  const night = mode === 'night';
  const images = product.images?.length ? product.images : [];
  const [imgIndex, setImgIndex] = useState(0);
  const [qty, setQty] = useState(1);

  const sizes = getSizes(product.sale_options);
  const weightSteps = getWeightSteps(product.sale_options);
  const volumeSteps = getVolumeSteps(product.sale_options);

  const [size, setSize] = useState<string>(sizes[0]);
  const [grams, setGrams] = useState<number>(weightSteps[Math.floor(weightSteps.length / 2)] ?? 500);
  const [ml, setMl] = useState<number>(volumeSteps[Math.floor(volumeSteps.length / 2)] ?? 500);

  const option: ChosenOption = useMemo(() => {
    switch (product.sale_mode) {
      case 'size':
        return { type: 'size', value: size };
      case 'weight':
        return { type: 'weight', grams };
      case 'volume':
        return { type: 'volume', ml };
      default:
        return null;
    }
  }, [product.sale_mode, size, grams, ml]);

  const unitPrice = computeUnitPrice(product, option);
  const lineTotal = unitPrice * qty;
  const sold = product.available === false;

  const chipBase = (active: boolean) =>
    [
      'rounded-xl border px-3 py-2 text-sm font-medium transition',
      active
        ? 'text-white'
        : night
          ? 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10'
          : 'border-slate-200 bg-white/70 text-slate-600 hover:bg-white',
    ].join(' ');

  const chipStyle = (active: boolean) =>
    active ? { backgroundColor: accent, borderColor: accent } : undefined;

  const panel = night
    ? 'bg-slate-900/80 border-white/10 text-white'
    : 'bg-white/85 border-white/70 text-slate-800';

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />
        <motion.div
          initial={{ y: 40, opacity: 0, scale: 0.98 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: 40, opacity: 0, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          className={[
            'relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border backdrop-blur-2xl sm:rounded-3xl md:flex-row',
            panel,
          ].join(' ')}
          style={{ boxShadow: `0 20px 70px ${hexToRgba(accent, 0.25)}` }}
        >
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className={[
              'absolute right-3 top-3 z-20 grid h-9 w-9 place-items-center rounded-full backdrop-blur-md transition',
              night ? 'bg-black/40 text-white hover:bg-black/60' : 'bg-white/70 text-slate-700 hover:bg-white',
            ].join(' ')}
          >
            <X className="h-5 w-5" />
          </button>

          {/* Carrossel */}
          <div className="relative aspect-square w-full shrink-0 overflow-hidden md:w-1/2">
            {images.length ? (
              <img
                src={images[imgIndex]}
                alt={product.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div
                className={[
                  'flex h-full w-full items-center justify-center',
                  night ? 'bg-white/5 text-white/30' : 'bg-slate-100 text-slate-300',
                ].join(' ')}
              >
                <ImageOff className="h-12 w-12" />
              </div>
            )}

            {images.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label="Imagem anterior"
                  onClick={() => setImgIndex((i) => (i - 1 + images.length) % images.length)}
                  className="absolute left-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur-md hover:bg-black/60"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  aria-label="Próxima imagem"
                  onClick={() => setImgIndex((i) => (i + 1) % images.length)}
                  className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white backdrop-blur-md hover:bg-black/60"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
                <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5">
                  {images.map((_, i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label={`Ir para imagem ${i + 1}`}
                      onClick={() => setImgIndex(i)}
                      className="h-2 rounded-full transition-all"
                      style={{
                        width: i === imgIndex ? 18 : 8,
                        backgroundColor: i === imgIndex ? accent : 'rgba(255,255,255,0.6)',
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            {product.featured && (
              <span
                className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md"
                style={{ backgroundColor: hexToRgba(accent, 0.9) }}
              >
                Destaque
              </span>
            )}
          </div>

          {/* Detalhes */}
          <div className="flex w-full flex-col overflow-y-auto p-5 md:w-1/2">
            <h2 className="pr-8 text-xl font-bold">{product.name}</h2>
            <div className="mt-1 text-lg font-bold" style={{ color: accent }}>
              {unitPriceLabel(product)}
            </div>
            {product.description && (
              <p className={['mt-3 text-sm leading-relaxed', night ? 'text-white/60' : 'text-slate-500'].join(' ')}>
                {product.description}
              </p>
            )}

            {/* Seletores por modo de venda */}
            <div className="mt-5 space-y-4">
              {product.sale_mode === 'size' && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">Tamanho</p>
                  <div className="flex flex-wrap gap-2">
                    {sizes.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={chipBase(s === size)}
                        style={chipStyle(s === size)}
                        onClick={() => setSize(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {product.sale_mode === 'weight' && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">Peso</p>
                  <div className="flex flex-wrap gap-2">
                    {weightSteps.map((g) => (
                      <button
                        key={g}
                        type="button"
                        className={chipBase(g === grams)}
                        style={chipStyle(g === grams)}
                        onClick={() => setGrams(g)}
                      >
                        {gramsLabel(g)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={grams}
                      onChange={(e) => setGrams(Math.max(1, Number(e.target.value) || 0))}
                      className={[
                        'w-28 rounded-xl border px-3 py-2 text-sm outline-none',
                        night ? 'border-white/15 bg-white/5 text-white' : 'border-slate-200 bg-white/70 text-slate-700',
                      ].join(' ')}
                    />
                    <span className="text-sm opacity-60">gramas</span>
                  </div>
                </div>
              )}

              {product.sale_mode === 'volume' && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">Volume</p>
                  <div className="flex flex-wrap gap-2">
                    {volumeSteps.map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={chipBase(v === ml)}
                        style={chipStyle(v === ml)}
                        onClick={() => setMl(v)}
                      >
                        {mlLabel(v)}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={ml}
                      onChange={(e) => setMl(Math.max(1, Number(e.target.value) || 0))}
                      className={[
                        'w-28 rounded-xl border px-3 py-2 text-sm outline-none',
                        night ? 'border-white/15 bg-white/5 text-white' : 'border-slate-200 bg-white/70 text-slate-700',
                      ].join(' ')}
                    />
                    <span className="text-sm opacity-60">ml</span>
                  </div>
                </div>
              )}

              {/* Quantidade */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">Quantidade</p>
                <div className="flex items-center gap-3">
                  <div
                    className={[
                      'flex items-center gap-1 rounded-xl border p-1',
                      night ? 'border-white/15 bg-white/5' : 'border-slate-200 bg-white/70',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      aria-label="Diminuir"
                      onClick={() => setQty((q) => Math.max(1, q - 1))}
                      className="grid h-8 w-8 place-items-center rounded-lg hover:bg-black/10"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <span className="w-8 text-center text-sm font-semibold">{qty}</span>
                    <button
                      type="button"
                      aria-label="Aumentar"
                      onClick={() => setQty((q) => q + 1)}
                      className="grid h-8 w-8 place-items-center rounded-lg hover:bg-black/10"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="text-sm opacity-70">{optionLabel(product, option)}</div>
                </div>
              </div>
            </div>

            {/* Total */}
            <div className="mt-5 flex items-baseline justify-between">
              <span className="text-sm opacity-60">Total</span>
              <span className="text-2xl font-extrabold" style={{ color: accent }}>
                {formatBRL(lineTotal, product.currency)}
              </span>
            </div>

            {/* Ações */}
            <div className="mt-4 flex flex-col gap-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={sold}
                  onClick={() => onAdd(product, option, qty)}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ backgroundColor: accent }}
                >
                  <ShoppingCart className="h-4 w-4" />
                  {sold ? 'Esgotado' : 'Adicionar ao carrinho'}
                </button>
                <button
                  type="button"
                  aria-label="Favoritar"
                  onClick={() => onToggleFavorite(product.id)}
                  className={[
                    'grid h-12 w-12 shrink-0 place-items-center rounded-xl border transition',
                    night ? 'border-white/15 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white/70 hover:bg-white',
                  ].join(' ')}
                >
                  <Heart
                    className="h-5 w-5"
                    style={{
                      color: isFavorite ? accent : night ? '#fff' : '#64748b',
                      fill: isFavorite ? accent : 'transparent',
                    }}
                  />
                </button>
              </div>
              <button
                type="button"
                disabled={sold}
                onClick={() => onBuyNow(product, option, qty)}
                className={[
                  'flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
                  night ? 'border-white/20 text-white hover:bg-white/10' : 'border-slate-300 text-slate-700 hover:bg-white',
                ].join(' ')}
                style={{ borderColor: hexToRgba(accent, 0.6) }}
              >
                <Zap className="h-4 w-4" style={{ color: accent }} />
                Comprar agora
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
