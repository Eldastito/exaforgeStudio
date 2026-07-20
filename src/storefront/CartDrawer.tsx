import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  X, Minus, Plus, Trash2, ShoppingBag, CheckCircle2, Loader2, ImageOff, MessageCircle, Tag, Copy, Check, ExternalLink,
} from 'lucide-react';
import type { CartItem, Customer, Mode, OrderResponse } from './types';
import { formatBRL, hexToRgba } from './utils';

interface Props {
  open: boolean;
  items: CartItem[];
  accent: string;
  mode: Mode;
  customer: Customer | null;
  slug: string;
  onClose: () => void;
  onChangeQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onSubmit: (extra: { name: string; phone: string; email?: string; cpf?: string; coupon?: string }) => Promise<OrderResponse | null>;
  onClear: () => void;
}

export function CartDrawer({
  open,
  items,
  accent,
  mode,
  customer,
  slug,
  onClose,
  onChangeQty,
  onRemove,
  onSubmit,
  onClear,
}: Props) {
  const night = mode === 'night';
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [cpf, setCpf] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OrderResponse | null>(null);

  const [coupon, setCoupon] = useState('');
  const [copiedPix, setCopiedPix] = useState(false);
  const [applying, setApplying] = useState(false);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [applied, setApplied] = useState<{ code: string; discount: number } | null>(null);

  const total = items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);
  const discount = applied ? Math.min(applied.discount, total) : 0;
  const finalTotal = Math.max(0, total - discount);

  // Se o carrinho muda, o cupom aplicado deixa de valer (revalidar).
  useEffect(() => { setApplied(null); setCouponMsg(null); }, [total]);

  async function applyCoupon() {
    const code = coupon.trim().toUpperCase();
    if (!code) return;
    setApplying(true); setCouponMsg(null);
    try {
      const res = await fetch(`/api/public/store/${encodeURIComponent(slug)}/coupon`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, subtotal: total }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.valid) {
        setApplied({ code: d.code, discount: d.discount });
        setCouponMsg(null);
      } else {
        setApplied(null);
        setCouponMsg(d.message || 'Cupom inválido.');
      }
    } catch {
      setCouponMsg('Não foi possível validar o cupom.');
    } finally {
      setApplying(false);
    }
  }

  const panel = night
    ? 'bg-slate-900/85 border-white/10 text-white'
    : 'bg-white/90 border-white/70 text-slate-800';

  async function handleSubmit() {
    setError(null);
    // Só exige o nome se o cliente NÃO veio pelo link (sem contato vinculado).
    if (!customer && !name.trim()) {
      setError('Informe seu nome.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await onSubmit({ name: name.trim(), phone: phone.trim(), email: email.trim(), cpf: cpf.trim(), coupon: applied?.code });
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

            {/* Estado de sucesso — paga na própria loja (PIX) */}
            {result ? (
              (() => {
                const pay = result.payment;
                const hasPix = pay?.method === 'mercadopago' && pay.pix && (pay.pix.qrCode || pay.pix.ticketUrl);
                const hasManual = pay?.method === 'pix_manual' && pay.manual?.key;
                const copyPix = (text: string) => {
                  navigator.clipboard?.writeText(text);
                  setCopiedPix(true); setTimeout(() => setCopiedPix(false), 1800);
                };
                return (
                  <div className="flex-1 overflow-y-auto p-6 text-center">
                    <CheckCircle2 className="mx-auto h-14 w-14" style={{ color: accent }} />
                    <p className="mt-3 text-lg font-bold">Pedido criado!</p>
                    <p className="mt-1 text-sm opacity-60">
                      Nº <span className="font-mono font-semibold">#{result.orderId.slice(0, 8)}</span> · Total {formatBRL(result.total)}
                    </p>

                    {/* PIX dinâmico (Mercado Pago) — confirma sozinho */}
                    {hasPix && (
                      <div className="mt-5 text-left">
                        <p className="text-center text-sm font-semibold">Pague com Pix para confirmar na hora</p>
                        {pay!.pix!.qrCodeBase64 && (
                          <img
                            src={`data:image/png;base64,${pay!.pix!.qrCodeBase64}`}
                            alt="QR Code Pix"
                            className="mx-auto my-4 h-48 w-48 rounded-xl bg-white p-2"
                          />
                        )}
                        {pay!.pix!.qrCode && (
                          <>
                            <p className="mb-1 text-xs opacity-60">Pix copia e cola:</p>
                            <div className="flex items-center gap-2">
                              <code className={['flex-1 truncate rounded-lg border px-2 py-2 text-[11px]', night ? 'border-white/15 bg-white/5' : 'border-slate-200 bg-white/70'].join(' ')}>
                                {pay!.pix!.qrCode}
                              </code>
                              <button
                                type="button"
                                onClick={() => copyPix(pay!.pix!.qrCode)}
                                className="shrink-0 rounded-lg px-3 py-2 text-sm font-bold text-white"
                                style={{ backgroundColor: accent }}
                              >
                                {copiedPix ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                              </button>
                            </div>
                          </>
                        )}
                        {pay!.pix!.ticketUrl && (
                          <a
                            href={pay!.pix!.ticketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white"
                            style={{ backgroundColor: accent }}
                          >
                            <ExternalLink className="h-4 w-4" /> Pagar pelo app do banco
                          </a>
                        )}
                        <p className="mt-3 text-center text-xs opacity-60">Assim que o pagamento cair, seu pedido é confirmado automaticamente. ✅</p>
                      </div>
                    )}

                    {/* PIX manual (chave do lojista) */}
                    {hasManual && (
                      <div className="mt-5 text-left">
                        <p className="text-center text-sm font-semibold">Pague com Pix</p>
                        <p className="mb-1 mt-3 text-xs opacity-60">Chave Pix:</p>
                        <div className="flex items-center gap-2">
                          <code className={['flex-1 truncate rounded-lg border px-2 py-2 text-sm', night ? 'border-white/15 bg-white/5' : 'border-slate-200 bg-white/70'].join(' ')}>
                            {pay!.manual!.key}
                          </code>
                          <button
                            type="button"
                            onClick={() => copyPix(pay!.manual!.key)}
                            className="shrink-0 rounded-lg px-3 py-2 text-sm font-bold text-white"
                            style={{ backgroundColor: accent }}
                          >
                            {copiedPix ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </button>
                        </div>
                        {pay!.manual!.name && <p className="mt-1 text-xs opacity-60">Em nome de {pay!.manual!.name}</p>}
                        {pay!.manual!.instructions && <p className="mt-2 text-xs opacity-70">{pay!.manual!.instructions}</p>}
                        <p className="mt-2 text-center text-xs opacity-60">Depois de pagar, envie o comprovante no WhatsApp. 🙏</p>
                      </div>
                    )}

                    {/* Sem pagamento na loja: o pedido já caiu no atendimento.
                        Confirma aqui mesmo, sem forçar o WhatsApp. */}
                    {!hasPix && !hasManual && (
                      <div className="mt-5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
                        <p className="font-semibold text-emerald-500">Recebemos seu pedido! 🎉</p>
                        <p className="mt-1 opacity-70">A loja já foi avisada e vai te chamar para combinar o pagamento e a entrega.</p>
                      </div>
                    )}

                    {/* WhatsApp é sempre OPCIONAL (o cliente não precisa voltar pra lá). */}
                    {result.whatsappUrl && (
                      <a
                        href={result.whatsappUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-4 flex items-center justify-center gap-1.5 text-sm font-medium underline opacity-70 hover:opacity-100"
                      >
                        <MessageCircle className="h-4 w-4" /> Falar no WhatsApp (opcional)
                      </a>
                    )}

                    <button
                      type="button"
                      onClick={handleClose}
                      className="mt-5 text-sm font-medium underline opacity-70 hover:opacity-100"
                    >
                      Continuar comprando
                    </button>
                  </div>
                );
              })()
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
                  {customer ? (
                    // Cliente veio pelo link (WhatsApp): já sabemos quem é — não
                    // pedimos NADA (nem e-mail: se a IA já capturou na conversa,
                    // está no contato). Checkout de 1 clique (ADR-096).
                    <p className="text-sm opacity-70">
                      Comprando como <span className="font-semibold opacity-100">{customer.name || 'cliente'}</span>. É só confirmar. 🙌
                    </p>
                  ) : (
                    <>
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

                      {/* E-mail opcional — SÓ para o cliente anônimo. Quem vem do
                          WhatsApp não precisa: a IA já capturou na conversa. */}
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="E-mail (opcional — para receber a confirmação)"
                        inputMode="email"
                        className={[
                          'w-full rounded-xl border px-3 py-2.5 text-sm outline-none',
                          night ? 'border-white/15 bg-white/5 text-white placeholder:text-white/40' : 'border-slate-200 bg-white/70 text-slate-700 placeholder:text-slate-400',
                        ].join(' ')}
                      />
                    </>
                  )}

                  {/* CPF na nota — opcional e não bloqueante (ADR-096). A loja não
                      emite NF-e no piloto; é só para quem quiser o CPF no cupom. */}
                  <input
                    value={cpf}
                    onChange={(e) => setCpf(e.target.value)}
                    placeholder="CPF na nota (opcional)"
                    inputMode="numeric"
                    className={[
                      'w-full rounded-xl border px-3 py-2.5 text-sm outline-none',
                      night ? 'border-white/15 bg-white/5 text-white placeholder:text-white/40' : 'border-slate-200 bg-white/70 text-slate-700 placeholder:text-slate-400',
                    ].join(' ')}
                  />

                  {/* Cupom de desconto */}
                  <div>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Tag className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 opacity-40" />
                        <input
                          value={coupon}
                          onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyCoupon(); } }}
                          placeholder="Cupom de desconto"
                          className={[
                            'w-full rounded-xl border pl-8 pr-3 py-2.5 text-sm outline-none uppercase',
                            night ? 'border-white/15 bg-white/5 text-white placeholder:text-white/40' : 'border-slate-200 bg-white/70 text-slate-700 placeholder:text-slate-400',
                          ].join(' ')}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={applyCoupon}
                        disabled={applying || !coupon.trim()}
                        className="shrink-0 rounded-xl border px-3 text-sm font-semibold disabled:opacity-50"
                        style={{ borderColor: hexToRgba(accent, 0.5), color: accent }}
                      >
                        {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Aplicar'}
                      </button>
                    </div>
                    {couponMsg && <p className="mt-1 text-xs font-medium text-red-500">{couponMsg}</p>}
                    {applied && <p className="mt-1 text-xs font-medium text-emerald-500">Cupom {applied.code} aplicado! 🎉</p>}
                  </div>

                  {error && <p className="text-sm font-medium text-red-500">{error}</p>}

                  {discount > 0 && (
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center justify-between opacity-70">
                        <span>Subtotal</span><span>{formatBRL(total)}</span>
                      </div>
                      <div className="flex items-center justify-between text-emerald-500">
                        <span>Desconto ({applied?.code})</span><span>-{formatBRL(discount)}</span>
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-base">
                    <span className="opacity-60">Total</span>
                    <span className="text-xl font-extrabold" style={{ color: accent }}>
                      {formatBRL(finalTotal)}
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
                    {submitting ? 'Enviando...' : customer ? 'Confirmar pedido' : 'Finalizar pedido'}
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
