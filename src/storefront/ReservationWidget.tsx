import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarCheck, X, Loader2, Check, Copy, ExternalLink, CheckCircle2, Users } from 'lucide-react';
import type { ReservableResource, Customer, Mode } from './types';
import { formatBRL, hexToRgba } from './utils';

const UNIT_LABEL: Record<string, string> = { night: 'diária', day: 'dia', hour: 'hora', slot: 'turno' };

interface Props {
  resources: ReservableResource[];
  slug: string;
  token: string | null;
  accent: string;
  mode: Mode;
  customer: Customer | null;
}

export function ReservationWidget({ resources, slug, token, accent, mode, customer }: Props) {
  const [active, setActive] = useState<ReservableResource | null>(null);
  if (!resources || resources.length === 0) return null;
  const night = mode === 'night';
  return (
    <section id="reservas" className="mt-8 scroll-mt-4">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
        <CalendarCheck className="h-5 w-5" style={{ color: accent }} /> Reservas
      </h2>
      <p className="mb-3 text-sm opacity-60">Escolha as datas e reserve em segundos — confirmação na hora.</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {resources.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setActive(r)}
            className={['group flex flex-col rounded-2xl border p-4 text-left transition hover:scale-[1.01]', night ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-white/60'].join(' ')}
          >
            <p className="font-semibold">{r.name}</p>
            {r.description && <p className="mt-0.5 line-clamp-2 text-xs opacity-60">{r.description}</p>}
            <p className="mt-2 text-sm opacity-60">a partir de</p>
            <p className="text-lg font-extrabold" style={{ color: accent }}>
              {formatBRL(r.price)} <span className="text-xs font-normal opacity-60">/ {UNIT_LABEL[r.reservation_unit] || r.reservation_unit}</span>
            </p>
            <span
              className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-white transition group-hover:opacity-90"
              style={{ backgroundColor: accent }}
            >
              <CalendarCheck className="h-4 w-4" /> Reservar
            </span>
          </button>
        ))}
      </div>
      <AnimatePresence>
        {active && <BookingModal resource={active} slug={slug} token={token} accent={accent} mode={mode} customer={customer} onClose={() => setActive(null)} />}
      </AnimatePresence>
    </section>
  );
}

function BookingModal({ resource, slug, token, accent, mode, customer, onClose }: {
  resource: ReservableResource; slug: string; token: string | null; accent: string; mode: Mode; customer: Customer | null; onClose: () => void;
}) {
  const night = mode === 'night';
  const dateMode = resource.reservation_unit === 'night' || resource.reservation_unit === 'day';
  // Pré-preenche datas (hoje → amanhã) para diárias, reduzindo o atrito.
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const [start, setStart] = useState(dateMode ? ymd(today) : '');
  const [end, setEnd] = useState(dateMode ? ymd(tomorrow) : '');
  const [units, setUnits] = useState(1);
  const [guests, setGuests] = useState('');
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [avail, setAvail] = useState<{ bookable: boolean; livres: number; capacity: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);

  // Converte os campos em ISO (diária: check-in 14:00 / check-out 12:00).
  const iso = useMemo(() => {
    if (!start || !end) return null;
    const s = dateMode ? new Date(`${start}T14:00:00`) : new Date(start);
    const e = dateMode ? new Date(`${end}T12:00:00`) : new Date(end);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) return null;
    return { start: s.toISOString(), end: e.toISOString() };
  }, [start, end, dateMode]);

  // Total estimado: períodos × preço × unidades (espelha o cálculo do servidor).
  const total = useMemo(() => {
    if (!iso) return 0;
    const ms = new Date(iso.end).getTime() - new Date(iso.start).getTime();
    let periods = 1;
    if (resource.reservation_unit === 'hour') periods = Math.ceil(ms / 3_600_000);
    else if (resource.reservation_unit === 'night' || resource.reservation_unit === 'day') periods = Math.max(1, Math.ceil(ms / 86_400_000));
    return resource.price * periods * units;
  }, [iso, units, resource.price, resource.reservation_unit]);

  useEffect(() => {
    setAvail(null);
    if (!iso) return;
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const qs = new URLSearchParams({ resource: resource.id, start: iso.start, end: iso.end, units: String(units) });
        const d = await fetch(`/api/public/store/${encodeURIComponent(slug)}/reservations/availability?${qs}`).then(r => r.json());
        setAvail(d?.ok ? d : null);
      } catch { setAvail(null); }
      finally { setChecking(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [iso, units, resource.id, slug]);

  const panel = night ? 'bg-slate-900/90 border-white/10 text-white' : 'bg-white/95 border-white/70 text-slate-800';
  const inp = ['w-full rounded-xl border px-3 py-2.5 text-sm outline-none', night ? 'border-white/15 bg-white/5 text-white placeholder:text-white/40' : 'border-slate-200 bg-white/70 text-slate-700 placeholder:text-slate-400'].join(' ');

  async function submit() {
    setError(null);
    if (!iso) { setError('Escolha as datas corretamente.'); return; }
    if (!customer && !name.trim()) { setError('Informe seu nome.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/store/${encodeURIComponent(slug)}/reservation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token ?? undefined, resourceId: resource.id, start: iso.start, end: iso.end, units, guests: guests ? Number(guests) : undefined, customer: { name: name.trim(), phone: phone.trim(), email: email.trim() } }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.error || 'Não foi possível reservar.'); return; }
      setResult(d);
    } catch { setError('Erro ao enviar a reserva.'); }
    finally { setSubmitting(false); }
  }

  const copy = (t: string) => { navigator.clipboard?.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 1600); };

  return (
    <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
        className={['absolute left-1/2 top-1/2 w-[92%] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-3xl border p-5 backdrop-blur-2xl', panel].join(' ')}
        style={{ boxShadow: `0 20px 70px ${hexToRgba(accent, 0.25)}` }}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-bold"><CalendarCheck className="h-5 w-5" style={{ color: accent }} /> {resource.name}</h3>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full hover:bg-black/10"><X className="h-5 w-5" /></button>
        </div>

        {result ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-12 w-12" style={{ color: accent }} />
            <p className="mt-2 text-lg font-bold">Reserva solicitada!</p>
            <p className="mt-1 text-sm opacity-60">Total {formatBRL(result.total)}{result.deposit > 0 ? ` · sinal ${formatBRL(result.deposit)}` : ''}</p>
            {result.payment?.method === 'mercadopago' && result.payment.pix && (
              <div className="mt-4 text-left">
                <p className="text-center text-sm font-semibold">Pague o sinal com Pix para confirmar</p>
                {result.payment.pix.qrCodeBase64 && <img src={`data:image/png;base64,${result.payment.pix.qrCodeBase64}`} alt="QR Pix" className="mx-auto my-3 h-44 w-44 rounded-xl bg-white p-2" />}
                {result.payment.pix.qrCode && (
                  <div className="flex items-center gap-2">
                    <code className={['flex-1 truncate rounded-lg border px-2 py-2 text-[11px]', night ? 'border-white/15 bg-white/5' : 'border-slate-200 bg-white/70'].join(' ')}>{result.payment.pix.qrCode}</code>
                    <button onClick={() => copy(result.payment.pix.qrCode)} className="shrink-0 rounded-lg px-3 py-2 text-white" style={{ backgroundColor: accent }}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</button>
                  </div>
                )}
                {result.payment.pix.ticketUrl && <a href={result.payment.pix.ticketUrl} target="_blank" rel="noopener noreferrer" className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold text-white" style={{ backgroundColor: accent }}><ExternalLink className="h-4 w-4" /> Pagar pelo app do banco</a>}
                <p className="mt-3 text-center text-xs opacity-60">Assim que o sinal cair, sua reserva é confirmada automaticamente. ✅</p>
              </div>
            )}
            {result.payment?.method === 'pix_manual' && result.payment.manual && (
              <div className="mt-4 text-left">
                <p className="mb-1 text-xs opacity-60">Chave Pix do sinal:</p>
                <div className="flex items-center gap-2">
                  <code className={['flex-1 truncate rounded-lg border px-2 py-2 text-sm', night ? 'border-white/15 bg-white/5' : 'border-slate-200 bg-white/70'].join(' ')}>{result.payment.manual.key}</code>
                  <button onClick={() => copy(result.payment.manual.key)} className="shrink-0 rounded-lg px-3 py-2 text-white" style={{ backgroundColor: accent }}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</button>
                </div>
                {result.payment.manual.name && <p className="mt-1 text-xs opacity-60">Em nome de {result.payment.manual.name}</p>}
              </div>
            )}
            {(!result.payment || result.payment.method === 'none') && (
              <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">Recebemos sua reserva! Em breve confirmamos com você. 🎉</p>
            )}
            <button onClick={onClose} className="mt-5 text-sm font-medium underline opacity-70 hover:opacity-100">Fechar</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label={dateMode ? 'Entrada (check-in)' : 'Início'}><input type={dateMode ? 'date' : 'datetime-local'} className={inp} value={start} onChange={e => setStart(e.target.value)} /></Field>
              <Field label={dateMode ? 'Saída (check-out)' : 'Fim'}><input type={dateMode ? 'date' : 'datetime-local'} className={inp} value={end} onChange={e => setEnd(e.target.value)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Unidades (até ${resource.capacity})`}><input type="number" min={1} max={resource.capacity} className={inp} value={units} onChange={e => setUnits(Math.max(1, Number(e.target.value) || 1))} /></Field>
              <Field label="Pessoas (opcional)"><div className="relative"><Users className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 opacity-40" /><input type="number" min={1} className={inp + ' pl-8'} value={guests} onChange={e => setGuests(e.target.value)} /></div></Field>
            </div>

            {checking ? <p className="text-xs opacity-60">Checando disponibilidade…</p>
              : avail ? <p className={`text-xs font-medium ${avail.bookable ? 'text-emerald-500' : 'text-red-500'}`}>{avail.bookable ? `✓ Disponível — ${avail.livres} de ${avail.capacity} livre(s).` : `✗ Sem disponibilidade (${avail.livres} de ${avail.capacity}).`}</p>
              : null}

            {total > 0 && (
              <div className="flex items-center justify-between rounded-xl px-1 text-sm">
                <span className="opacity-60">Total estimado</span>
                <span className="text-lg font-extrabold" style={{ color: accent }}>{formatBRL(total)}</span>
              </div>
            )}

            {!customer && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input className={inp} placeholder="Seu nome" value={name} onChange={e => setName(e.target.value)} />
                <input className={inp} placeholder="WhatsApp (opcional)" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} />
              </div>
            )}
            <input type="email" className={inp} placeholder="E-mail (opcional — para confirmação)" value={email} onChange={e => setEmail(e.target.value)} />

            {error && <p className="text-sm font-medium text-red-500">{error}</p>}
            <button type="button" disabled={submitting || (avail !== null && !avail.bookable)} onClick={submit}
              className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-base font-bold text-white transition disabled:opacity-60" style={{ backgroundColor: accent }}>
              {submitting ? <Loader2 className="h-5 w-5 animate-spin" /> : null}{submitting ? 'Enviando…' : (total > 0 ? `Reservar · ${formatBRL(total)}` : 'Reservar')}
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label className="mb-1 block text-xs opacity-60">{label}</label>{children}</div>;
}
