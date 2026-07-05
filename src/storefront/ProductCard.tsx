import type { FC } from 'react';
import { motion } from 'motion/react';
import { Heart, Sparkles, ImageOff, Shirt } from 'lucide-react';
import type { Mode, Product } from './types';
import { hexToRgba, unitPriceLabel } from './utils';

interface Props {
  product: Product;
  accent: string;
  mode: Mode;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onOpen: (product: Product) => void;
  /** Provador Virtual (ADR-041): peça vestível elegível ganha o botão "Provar". */
  canTryOn?: boolean;
  isTryOnPicked?: boolean;
  onToggleTryOn?: (id: string) => void;
}

export const ProductCard: FC<Props> = ({
  product,
  accent,
  mode,
  isFavorite,
  onToggleFavorite,
  onOpen,
  canTryOn,
  isTryOnPicked,
  onToggleTryOn,
}) => {
  const cover = product.images?.[0] ?? null;
  const sold = product.available === false;
  const night = mode === 'night';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      whileHover={{ y: -6 }}
      transition={{ type: 'spring', stiffness: 260, damping: 24 }}
      className={[
        'group relative flex flex-col overflow-hidden rounded-2xl border backdrop-blur-xl cursor-pointer',
        night
          ? 'bg-white/5 border-white/10 shadow-[0_8px_30px_rgba(0,0,0,0.35)]'
          : 'bg-white/60 border-white/70 shadow-[0_8px_30px_rgba(15,23,42,0.10)]',
      ].join(' ')}
      style={{ boxShadow: `0 10px 40px ${hexToRgba(accent, night ? 0.12 : 0.18)}` }}
      onClick={() => onOpen(product)}
    >
      {/* Imagem de capa */}
      <div className="relative aspect-square w-full overflow-hidden">
        {cover ? (
          <img
            src={cover}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div
            className={[
              'flex h-full w-full items-center justify-center',
              night ? 'bg-white/5 text-white/30' : 'bg-slate-100 text-slate-300',
            ].join(' ')}
          >
            <ImageOff className="h-10 w-10" />
          </div>
        )}

        {product.featured && (
          <span
            className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md"
            style={{ backgroundColor: hexToRgba(accent, 0.9) }}
          >
            <Sparkles className="h-3 w-3" /> Destaque
          </span>
        )}

        <button
          type="button"
          aria-label="Favoritar"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(product.id);
          }}
          className={[
            'absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full backdrop-blur-md transition',
            night ? 'bg-black/30 hover:bg-black/50' : 'bg-white/70 hover:bg-white',
          ].join(' ')}
        >
          <Heart
            className="h-[18px] w-[18px] transition"
            style={{
              color: isFavorite ? accent : night ? '#ffffff' : '#64748b',
              fill: isFavorite ? accent : 'transparent',
            }}
          />
        </button>

        {/* Provar no Provador Virtual (ADR-041) — só em peça vestível elegível */}
        {canTryOn && !sold && (
          <button
            type="button"
            aria-label={isTryOnPicked ? 'Remover do provador' : 'Provar esta peça'}
            title={isTryOnPicked ? 'Remover do provador' : 'Provar esta peça'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleTryOn?.(product.id);
            }}
            className={[
              'absolute right-3 top-[3.4rem] grid h-9 w-9 place-items-center rounded-full backdrop-blur-md transition',
              night ? 'bg-black/30 hover:bg-black/50' : 'bg-white/70 hover:bg-white',
            ].join(' ')}
            style={isTryOnPicked ? { backgroundColor: accent } : undefined}
          >
            <Shirt
              className="h-[18px] w-[18px] transition"
              style={{ color: isTryOnPicked ? '#fff' : night ? '#ffffff' : '#64748b' }}
            />
          </button>
        )}

        {sold && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
            <span className="rounded-full border border-white/40 bg-black/40 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white">
              Esgotado
            </span>
          </div>
        )}
      </div>

      {/* Conteúdo */}
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3
          className={[
            'line-clamp-1 text-sm font-semibold',
            night ? 'text-white' : 'text-slate-800',
          ].join(' ')}
        >
          {product.name}
        </h3>
        {product.description && (
          <p
            className={[
              'line-clamp-2 text-xs',
              night ? 'text-white/50' : 'text-slate-500',
            ].join(' ')}
          >
            {product.description}
          </p>
        )}
        <div
          className="mt-auto pt-2 text-base font-bold"
          style={{ color: accent }}
        >
          {unitPriceLabel(product)}
        </div>
      </div>
    </motion.div>
  );
}
