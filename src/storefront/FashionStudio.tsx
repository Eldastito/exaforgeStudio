import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Camera, CheckCircle2, ChevronLeft, Loader2, LogOut, Shirt, Trash2, X } from 'lucide-react';
import type { Mode } from './types';
import { hexToRgba, lsGet, lsSet } from './utils';

// ============================================================================
// PROVADOR VIRTUAL — UI guiada (Fashion AI Studio FAS-1, ADR-035).
// Autocontido: descobre sozinho se a loja tem o módulo ligado (probe no
// endpoint elegível do FAS-0 — 404 = não renderiza nada), gerencia a própria
// sessão (token próprio do provador em localStorage, NUNCA o token do painel)
// e conduz o fluxo: conta -> consentimento -> guia da foto -> envio ->
// validação -> status. As próximas fases (looks/geração) plugam aqui.
// ============================================================================

type Step = 'intro' | 'auth' | 'consent' | 'guide' | 'status' | 'quiz' | 'looks';
type Avatar = { id: string; status: string; url: string | null; expiresAt: string | null };
type Me = { name: string; email: string; consents: { avatar_processing: boolean }; avatars: Avatar[]; retentionDays: number };
type LookItem = { productId: string; name: string; price: number; image: string | null; role: string };
type Look = { id: string; explanation: string; total: number; items: LookItem[]; saved?: boolean };

const STYLES = ['discreto', 'clássico', 'elegante', 'moderno', 'romântico', 'casual', 'marcante'];

const POLICY_VERSION = 'v1-2026-07';

async function api(path: string, opts: RequestInit = {}, token?: string | null): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = { ...(opts.headers as any || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api/public/fashion${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function FashionStudio({ slug, accent, mode }: { slug: string; accent: string; mode: Mode }) {
  const night = mode === 'night';
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('intro');
  const [token, setToken] = useState<string | null>(() => lsGet<string | null>(`fashion_token_${slug}`, null));
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Probe do FAS-0: 404 = módulo desligado nesta loja, não renderiza nada.
  useEffect(() => {
    let alive = true;
    fetch(`/api/public/store/${encodeURIComponent(slug)}/fashion/eligible`)
      .then((r) => { if (alive && r.ok) setEnabled(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => { lsSet(`fashion_token_${slug}`, token); }, [token, slug]);

  async function loadMe(tk: string | null = token): Promise<Me | null> {
    if (!tk) return null;
    const r = await api('/me', {}, tk);
    if (!r.ok) { setToken(null); setMe(null); return null; }
    setMe(r.data);
    return r.data;
  }

  async function openStudio() {
    setOpen(true);
    setError('');
    setReasons([]);
    if (!token) { setStep('intro'); return; }
    setBusy(true);
    const m = await loadMe();
    setBusy(false);
    if (!m) { setStep('intro'); return; }
    setStep(!m.consents.avatar_processing ? 'consent' : m.avatars.length ? 'status' : 'guide');
  }

  // ---- auth ----
  const [authTab, setAuthTab] = useState<'login' | 'register'>('register');
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', birthDate: '' });

  // ---- consultora por ocasião (FAS-2) ----
  const [quiz, setQuiz] = useState({ occasion: '', dayNight: '', style: '', colorsAvoid: '', piecesAvoid: '', budgetMax: '' });
  const [looks, setLooks] = useState<Look[]>([]);

  async function submitQuiz() {
    if (!quiz.occasion.trim()) { setError('Conte para a consultora qual é a ocasião.'); return; }
    setBusy(true); setError('');
    const r = await api('/look-requests', {
      method: 'POST',
      body: JSON.stringify({
        occasion: quiz.occasion, dayNight: quiz.dayNight || null, style: quiz.style || null,
        colorsAvoid: quiz.colorsAvoid, piecesAvoid: quiz.piecesAvoid, budgetMax: quiz.budgetMax || null,
      }),
    }, token);
    setBusy(false);
    if (!r.ok) { setError(r.data?.error || 'Não foi possível montar seus looks agora.'); return; }
    setLooks(r.data.looks || []);
    setStep('looks');
  }

  async function saveLook(id: string) {
    const r = await api(`/looks/${id}/save`, { method: 'POST' }, token);
    if (r.ok) setLooks((ls) => ls.map((l) => (l.id === id ? { ...l, saved: true } : l)));
  }

  async function submitAuth() {
    setBusy(true); setError('');
    const path = authTab === 'register' ? `/store/${encodeURIComponent(slug)}/register` : `/store/${encodeURIComponent(slug)}/login`;
    const body = authTab === 'register'
      ? JSON.stringify({ name: form.name, email: form.email, phone: form.phone, password: form.password, birthDate: form.birthDate })
      : JSON.stringify({ email: form.email, password: form.password });
    const r = await api(path, { method: 'POST', body });
    setBusy(false);
    if (!r.ok) { setError(r.data?.error || 'Não foi possível continuar.'); return; }
    setToken(r.data.token);
    const m = await loadMe(r.data.token);
    setStep(m && m.consents.avatar_processing ? (m.avatars.length ? 'status' : 'guide') : 'consent');
  }

  async function grantConsent() {
    setBusy(true); setError('');
    const r = await api('/consents', { method: 'POST', body: JSON.stringify({ type: 'avatar_processing', policyVersion: POLICY_VERSION }) }, token);
    setBusy(false);
    if (!r.ok) { setError(r.data?.error || 'Não foi possível registrar o aceite.'); return; }
    await loadMe();
    setStep('guide');
  }

  async function uploadPhoto(file: File) {
    setBusy(true); setError(''); setReasons([]);
    const fd = new FormData();
    fd.append('file', file);
    const r = await api('/avatars', { method: 'POST', body: fd }, token);
    setBusy(false);
    if (!r.ok) { setError(r.data?.error || 'Falha no envio da foto.'); return; }
    setReasons(r.data.reasons || []);
    await loadMe();
    setStep('status');
  }

  async function deleteAvatar(id: string) {
    setBusy(true);
    await api(`/avatars/${id}`, { method: 'DELETE' }, token);
    await loadMe();
    setBusy(false);
    setStep('guide');
  }

  async function deleteEverything() {
    if (!window.confirm('Apagar sua foto, preferências e conta do provador? Essa ação não pode ser desfeita.')) return;
    setBusy(true);
    await api('/me', { method: 'DELETE' }, token);
    setBusy(false);
    setToken(null); setMe(null); setStep('intro');
  }

  if (!enabled) return null;

  const panelBg = night ? 'bg-zinc-900 text-zinc-100' : 'bg-white text-zinc-900';
  const inputCls = `w-full rounded-xl border px-3 py-2 text-sm outline-none ${night ? 'border-zinc-700 bg-zinc-950 text-zinc-100' : 'border-zinc-300 bg-white'}`;
  const primaryBtn = 'w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50';

  const approved = me?.avatars.find((a) => a.status === 'approved') || null;

  return (
    <>
      {/* Botão de entrada (flutuante, só quando o módulo está ligado) */}
      <button
        type="button"
        onClick={openStudio}
        className="fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-full px-4 py-3 text-sm font-semibold text-white shadow-lg"
        style={{ background: accent }}
      >
        <Shirt className="h-4 w-4" /> Provador Virtual
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
              className={`w-full max-w-md rounded-3xl p-6 shadow-2xl ${panelBg}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-lg font-bold">
                  <Shirt className="h-5 w-5" style={{ color: accent }} /> Provador Virtual
                </h2>
                <div className="flex items-center gap-1">
                  {token && (
                    <button type="button" title="Sair" onClick={() => { setToken(null); setMe(null); setStep('intro'); }} className="rounded-full p-2 opacity-60 hover:opacity-100">
                      <LogOut className="h-4 w-4" />
                    </button>
                  )}
                  <button type="button" onClick={() => setOpen(false)} className="rounded-full p-2 opacity-60 hover:opacity-100">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {error && <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{error}</p>}

              {step === 'intro' && (
                <div className="space-y-4">
                  <p className="text-sm opacity-80">
                    Veja como as peças da loja ficam <span className="font-semibold">em você</span>. Envie uma foto de corpo inteiro,
                    conte para a nossa consultora o que procura e receba looks completos prontos para comprar.
                  </p>
                  <p className="text-xs opacity-60">Para maiores de 18 anos. Sua foto é privada, usada só para as prévias, e você pode apagá-la quando quiser.</p>
                  <button type="button" className={primaryBtn} style={{ background: accent }} onClick={() => { setStep('auth'); setError(''); }}>
                    Começar
                  </button>
                </div>
              )}

              {step === 'auth' && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    {(['register', 'login'] as const).map((t) => (
                      <button key={t} type="button" onClick={() => { setAuthTab(t); setError(''); }}
                        className="flex-1 rounded-xl px-3 py-2 text-sm font-semibold"
                        style={authTab === t ? { background: hexToRgba(accent, 0.18), color: accent } : { opacity: 0.6 }}>
                        {t === 'register' ? 'Criar conta' : 'Já tenho conta'}
                      </button>
                    ))}
                  </div>
                  {authTab === 'register' && (
                    <>
                      <input className={inputCls} placeholder="Seu nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                      <input className={inputCls} placeholder="WhatsApp (opcional)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                      <div>
                        <label className="mb-1 block text-xs opacity-60">Data de nascimento</label>
                        <input className={inputCls} type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
                      </div>
                    </>
                  )}
                  <input className={inputCls} type="email" placeholder="E-mail" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  <input className={inputCls} type="password" placeholder="Senha (mín. 8 caracteres)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  <button type="button" className={primaryBtn} style={{ background: accent }} disabled={busy} onClick={submitAuth}>
                    {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : authTab === 'register' ? 'Criar conta' : 'Entrar'}
                  </button>
                </div>
              )}

              {step === 'consent' && (
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold">Uso da sua foto</h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm opacity-80">
                    <li>Sua foto é usada <span className="font-semibold">somente</span> para gerar as prévias de look em você.</li>
                    <li>Ela é privada: não aparece para outras pessoas nem vira material da loja.</li>
                    <li>É apagada automaticamente após {me?.retentionDays ?? 30} dias — ou na hora, se você pedir.</li>
                    <li>Você pode revogar este aceite e apagar tudo a qualquer momento.</li>
                  </ul>
                  <button type="button" className={primaryBtn} style={{ background: accent }} disabled={busy} onClick={grantConsent}>
                    {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Aceito e quero continuar'}
                  </button>
                </div>
              )}

              {step === 'guide' && (
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold">Como tirar a foto ideal</h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm opacity-80">
                    <li>Corpo inteiro: cabeça e pés visíveis.</li>
                    <li>De frente para a câmera, braços levemente afastados.</li>
                    <li>Boa iluminação e fundo simples.</li>
                    <li>Evite espelho, filtros, foto sentada ou de lado.</li>
                  </ul>
                  <input
                    ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = ''; }}
                  />
                  <button type="button" className={`${primaryBtn} flex items-center justify-center gap-2`} style={{ background: accent }} disabled={busy} onClick={() => fileRef.current?.click()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Camera className="h-4 w-4" /> Enviar minha foto</>}
                  </button>
                  {busy && <p className="text-center text-xs opacity-60">Validando sua foto…</p>}
                </div>
              )}

              {step === 'status' && (
                <div className="space-y-4">
                  {approved ? (
                    <>
                      <p className="flex items-center gap-2 text-sm font-semibold text-emerald-500">
                        <CheckCircle2 className="h-4 w-4" /> Foto aprovada!
                      </p>
                      {approved.url && (
                        <img src={approved.url} alt="Sua foto do provador" className="mx-auto max-h-64 rounded-2xl object-contain" />
                      )}
                      <button type="button" className={primaryBtn} style={{ background: accent }} onClick={() => { setError(''); setStep('quiz'); }}>
                        Montar meu look por ocasião
                      </button>
                      <div className="flex gap-2">
                        <button type="button" className="flex-1 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: hexToRgba(accent, 0.4) }} onClick={() => setStep('guide')}>
                          Trocar foto
                        </button>
                        <button type="button" className="flex items-center gap-1 rounded-xl border border-red-500/40 px-3 py-2 text-sm text-red-500" disabled={busy} onClick={() => deleteAvatar(approved.id)}>
                          <Trash2 className="h-4 w-4" /> Apagar
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold">Essa foto não passou na validação:</p>
                      <ul className="list-disc space-y-1 pl-5 text-sm opacity-80">
                        {(reasons.length ? reasons : ['Não foi possível validar a imagem com segurança. Tente outra foto.']).map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                      <button type="button" className={`${primaryBtn} flex items-center justify-center gap-2`} style={{ background: accent }} onClick={() => setStep('guide')}>
                        <ChevronLeft className="h-4 w-4" /> Tentar outra foto
                      </button>
                    </>
                  )}
                  <button type="button" className="w-full text-center text-xs text-red-500/80 underline-offset-2 hover:underline" onClick={deleteEverything}>
                    Apagar minha foto, preferências e conta do provador
                  </button>
                </div>
              )}

              {step === 'quiz' && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold">Conte para a consultora</h3>
                  <input className={inputCls} placeholder="Qual é a ocasião? (ex.: casamento, entrevista, jantar)" value={quiz.occasion} onChange={(e) => setQuiz({ ...quiz, occasion: e.target.value })} />
                  <div className="flex gap-2">
                    {['dia', 'noite', 'ambos'].map((d) => (
                      <button key={d} type="button" onClick={() => setQuiz({ ...quiz, dayNight: quiz.dayNight === d ? '' : d })}
                        className="flex-1 rounded-xl border px-2 py-1.5 text-xs capitalize"
                        style={quiz.dayNight === d ? { background: hexToRgba(accent, 0.18), color: accent, borderColor: accent } : { borderColor: hexToRgba(accent, 0.25), opacity: 0.7 }}>
                        {d}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {STYLES.map((s) => (
                      <button key={s} type="button" onClick={() => setQuiz({ ...quiz, style: quiz.style === s ? '' : s })}
                        className="rounded-full border px-2.5 py-1 text-xs capitalize"
                        style={quiz.style === s ? { background: hexToRgba(accent, 0.18), color: accent, borderColor: accent } : { borderColor: hexToRgba(accent, 0.25), opacity: 0.7 }}>
                        {s}
                      </button>
                    ))}
                  </div>
                  <input className={inputCls} placeholder="Cores que você evita (separe por vírgula)" value={quiz.colorsAvoid} onChange={(e) => setQuiz({ ...quiz, colorsAvoid: e.target.value })} />
                  <input className={inputCls} placeholder="Peças que você evita (ex.: saia, regata)" value={quiz.piecesAvoid} onChange={(e) => setQuiz({ ...quiz, piecesAvoid: e.target.value })} />
                  <input className={inputCls} type="number" min={0} placeholder="Orçamento máximo do look (R$, opcional)" value={quiz.budgetMax} onChange={(e) => setQuiz({ ...quiz, budgetMax: e.target.value })} />
                  <button type="button" className={primaryBtn} style={{ background: accent }} disabled={busy} onClick={submitQuiz}>
                    {busy ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Montar meus looks'}
                  </button>
                  <button type="button" className="w-full text-center text-xs opacity-60 hover:opacity-100" onClick={() => setStep('status')}>Voltar</button>
                </div>
              )}

              {step === 'looks' && (
                <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                  <h3 className="text-sm font-semibold">Seus looks para {quiz.occasion || 'a ocasião'}</h3>
                  {looks.map((look, i) => (
                    <div key={look.id} className="rounded-2xl border p-3" style={{ borderColor: hexToRgba(accent, 0.3) }}>
                      <p className="mb-2 text-xs font-semibold" style={{ color: accent }}>Look {i + 1} — R$ {look.total.toFixed(2)}</p>
                      <div className="mb-2 space-y-1.5">
                        {look.items.map((it) => (
                          <div key={it.productId} className="flex items-center gap-2 text-sm">
                            {it.image && <img src={it.image} alt="" className="h-10 w-10 rounded-lg object-cover" />}
                            <span className="flex-1">{it.name}</span>
                            <span className="text-xs opacity-70">R$ {it.price.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                      <p className="mb-2 text-xs opacity-70">{look.explanation}</p>
                      <button type="button" disabled={!!look.saved} className="w-full rounded-xl border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                        style={{ borderColor: hexToRgba(accent, 0.4), color: accent }} onClick={() => saveLook(look.id)}>
                        {look.saved ? '✓ Look salvo' : 'Salvar este look'}
                      </button>
                    </div>
                  ))}
                  <p className="text-center text-[11px] opacity-50">Ver o look em você (prévia na sua foto) chega na próxima etapa do provador.</p>
                  <button type="button" className="w-full text-center text-xs opacity-60 hover:opacity-100" onClick={() => setStep('quiz')}>Ajustar respostas</button>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
