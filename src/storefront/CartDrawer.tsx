import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  X, Minus, Plus, Trash2, ShoppingBag, CheckCircle2, Loader2, ImageOff, MessageCircle,
} from 'lucide-react';
import type { CartItem, Customer, Mode, OrderResponse } from './types';
import { formatBRL, hexToRgba } from './utils';

interface Props {
  open: boolean;
  items: CartItem[];
  accent: string;
  mode: Mode;
  customer: Customer | null;
  onClose: () => void;
  onChangeQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onSubmit: (extra: { name: string; phone: string }) => Promise<OrderResponse | null>;
  onClear: () => void;
}

export function CartDrawer({
  open,
  items,
  accent,
  mode,
  customer,
  onClose,
  onChangeQty,
  onRemove,
  onSubmit,
  onClear,
}: Props) {
  const night = mode === 'night';
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OrderResponse | null>(null);

  const total = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

  const panel = night
    ? 'bg-slate-900/85 border-white/10 text-white'
    : 'bg-white/90 border-white/70 text-slate-800';

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError('Informe seu nome.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await onSubmit({ name: name.trim(), phone: phone.trim() });
      if (res && res.ok) {
        setResult(res);
        onClear();
      } else {
        setError('Não foi possível finalizar o pedido. Tente novamente.');
      }
    } catch {
      setError('Erro ao enviar o pedido. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    // Reseta o estado de sucesso ao fechar.
    setResult(null);
    setError(null);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
            className={[
              'absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l backdrop-blur-2xl',
              panel,
            ].join(' ')}
            style={{ boxShadow: `-20px 0 70px ${hexToRgba(accent, 0.2)}` }}
          >
            <header className="flex items-center justify-between border-b border-white/10 p-5">
              <h2 className="flex items-center gap-2 text-lg font-bold">
                <ShoppingBag className="h-5 w-5" style={{ color: accent }} />
                {result ? 'Pedido enviado' : 'Seu carrinho'}
              </h2>
              <button
                type="button"
                aria-label="Fechar carrinho"
                onClick={handleClose}
                className={[
                  'grid h-9 w-9 place-items-center rounded-full transition',
                  night ? 'hover:bg-white/10' : 'hover:bg-black/5',
                ].join(' ')}
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            {/* Estado de sucesso */}
            {result ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
                <CheckCircle2 className="h-16 w-16" style={{ color: accent }} />
                <div>
                  <p className="text-lg font-bold">Pedido confirmado!</p>
                  <p className="mt-1 text-sm opacity-60">
                    Nº do pedido: <span className="font-mono font-semibold">{result.orderId}</span>
                  </p>
                  <p className="mt-1 text-sm opacity-60">
                    Total: {formatBRL(result.total)}
                  </p>
                </div>
                {result.whatsappUrl && (
                  <a
                    href={result.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-[#25D366] px-4 py-3 text-base font-bold text-white transition hover:brightness-105"
                  >
                    <MessageCircle className="h-5 w-5" />
                    Finalizar no WhatsApp
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="text-sm font-medium underline opacity-70 hover:opacity-100"
                >
                  Continuar comprando
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center opacity-60">
                <ShoppingBag className="h-12 w-12" />
                <p className="text-sm">Seu carrinho está vazio.</p>
              </div>
            ) : (
              <>
                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                  {items.map((it) => (
                    <motion.div
                      key={it.key}
                      layout
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      className={[
                        'flex gap-3 rounded-2xl border p-3',
                        night ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-white/60',
                      ].join(' ')}
                    >
                      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl">
                        {it.image ? (
                          <img src={it.image} alt={it.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full w-full place-items-center bg-black/10 opacity-40">
                            <ImageOff className="h-6 w-6" />
                          </div>
                        )}
                      </div>
                      <div className="flex flex-1 flex-col">
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-1 text-sm font-semibold">{it.name}</p>
                          <button
                            type="button"
                            aria-label="Remover"
                            onClick={() => onRemove(it.key)}
                            className="shrink-0 opacity-50 transition hover:text-red-500 hover:opacity-100"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <p className="text-xs opacity-50">{it.optionLabel}</p>
                        <div className="mt-auto flex items-center justify-between pt-1">
                          <div
                            className={[
                              'flex items-center gap-0.5 rounded-lg border p-0.5',
                              night ? 'border-white/15' : 'border-slate-200',
                            ].join(' ')}
                          >
                            <button
                              type="button"
                              aria-label="Diminuir"
                              onClick={() => onChangeQty(it.key, it.quantity - 1)}
                              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/10"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <span className="w-6 text-center text-sm font-semibold">{it.quantity}</span>
                            <button
                              type="button"
                              aria-label="Aumentar"
                              onClick={() => onChangeQty(it.key, it.quantity + 1)}
                              className="grid h-7 w-7 place-items-center rounded-md hover:bg-black/10"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <span className="text-sm font-bold" style={{ color: accent }}>
                            {formatBRL(it.unitPrice * it.quantity)}
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>

                <footer className="space-y-3 border-t border-white/10 p-4">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Seu nome"
                      className={[
                        'rounded-xl border px-3 py-2.5 text-sm outline-none',
                        night ? 'border-white/15 bg-white/5 text-white placeholder:text-white/40' : 'border-slate-200 bg-white/70 text-slate-700 placeholder:text-slate-400',
                      ].join(' ')}
                    />
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="WhatsApp (opcional)"
                      inputMode="tel"
                      className={[
                        'rounded-xl border px-3 py-2.5 text-sm outline-none',
                        night ? 'border-white/15 bg-white/5 text-white placeholder:text-white/40' : 'border-slate-200 bg-white/70 text-slate-700 placeholder:text-slate-400',
                      ].join(' ')}
                    />
                  </div>

                  {error && <p className="text-sm font-medium text-red-500">{error}</p>}

                  <div className="flex items-center justify-between text-base">
                    <span className="opacity-60">Total</span>
                    <span className="text-xl font-extrabold" style={{ color: accent }}>
                      {formatBRL(total)}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={handleSubmit}
                    className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-base font-bold text-white transition disabled:opacity-60"
                    style={{ backgroundColor: accent }}
                  >
                    {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
                    {submitting ? 'Enviando...' : 'Finalizar pedido'}
                  </button>
                </footer>
              </>
            )}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
