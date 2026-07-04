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

type Step = 'intro' | 'auth' | 'consent' | 'guide' | 'status' | 'quiz' | 'looks' | 'shared' | 'prefs';
type Preference = { id: string; type: string; value: any };
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

type SharedLook = { lookId: string; explanation: string; items: { productId: string; name: string; image: string | null; price: number; available: boolean }[]; total: number };

export function FashionStudio({ slug, accent, mode, onAddLookItems }: {
  slug: string; accent: string; mode: Mode;
  onAddLookItems?: (items: { productId: string; name: string; image: string | null; price: number }[], lookId: string) => void;
}) {
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

  // ---- memória de estilo (FAS-5) ----
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [personalization, setPersonalization] = useState(true);
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, string>>({});

  async function loadProfile() {
    const r = await api('/profile', {}, token);
    if (!r.ok) return null;
    setPrefs(r.data.preferences || []);
    setPersonalization(!!r.data.personalizationEnabled);
    return r.data;
  }

  // Cliente recorrente (J-004): abrir o quiz pré-preenche com as preferências
  // salvas — ocasião sempre em branco (é o contexto de HOJE).
  async function openQuiz() {
    setError('');
    const p = await loadProfile();
    if (p?.personalizationEnabled && (p.preferences || []).length) {
      const byType = (t: string) => (p.preferences as Preference[]).filter((x) => x.type === t).map((x) => x.value);
      setQuiz((q) => ({
        ...q,
        occasion: '',
        style: q.style || byType('style_like')[0] || '',
        colorsAvoid: q.colorsAvoid || byType('color_avoid').join(', '),
        piecesAvoid: q.piecesAvoid || byType('fit_avoid').join(', '),
        budgetMax: q.budgetMax || (byType('budget_range')[0]?.max ? String(byType('budget_range')[0].max) : ''),
      }));
    }
    setStep('quiz');
  }

  async function sendFeedback(lookId: string, verdict: string) {
    const r = await api(`/looks/${lookId}/feedback`, { method: 'POST', body: JSON.stringify({ verdict }) }, token);
    if (!r.ok) { setError(r.data?.error || 'Não foi possível registrar.'); return; }
    setFeedbackGiven((f) => ({ ...f, [lookId]: verdict }));
  }

  async function togglePersonalization() {
    const next = !personalization;
    const r = await api('/profile', { method: 'PATCH', body: JSON.stringify({ personalizationEnabled: next }) }, token);
    if (r.ok) setPersonalization(next);
  }

  async function deletePref(id: string) {
    await api(`/profile/preferences/${id}`, { method: 'DELETE' }, token);
    setPrefs((p) => p.filter((x) => x.id !== id));
  }

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

  // ---- try-on: "look em você" (FAS-3) ----
  type TryOnState = { jobId: string; status: string; url: string | null; error: string | null };
  const [tryon, setTryon] = useState<Record<string, TryOnState>>({});
  const [credits, setCredits] = useState<{ available: number; limit: number } | null>(null);

  async function pollJob(lookId: string, jobId: string) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const r = await api(`/tryon-jobs/${jobId}`, {}, token);
      if (!r.ok) return;
      setCredits(r.data.credits || null);
      setTryon((t) => ({ ...t, [lookId]: { jobId, status: r.data.status, url: r.data.url, error: r.data.error } }));
      if (['SUCCEEDED', 'FAILED_FINAL', 'EXPIRED', 'DELETED'].includes(r.data.status)) return;
    }
  }

  // ---- carrinho do look + compartilhamento (FAS-4) ----
  const [cartNotes, setCartNotes] = useState<Record<string, string[]>>({});
  const [shareCopied, setShareCopied] = useState<string | null>(null);
  const [sharedLook, setSharedLook] = useState<SharedLook | null>(null);

  // Link compartilhado (?look=token): abre o look em modo leitura, sem login.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('look');
    if (!t) return;
    fetch(`/api/public/fashion/shared-looks/${encodeURIComponent(t)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) { setSharedLook(data); setStep('shared'); setOpen(true); } })
      .catch(() => {});
  }, []);

  async function buyLook(lookId: string) {
    setError('');
    const r = await api(`/looks/${lookId}/add-to-cart`, { method: 'POST' }, token);
    if (!r.ok) { setError(r.data?.error || 'Não foi possível adicionar o look.'); return; }
    const notes: string[] = [];
    for (const it of r.data.items || []) {
      if (!it.available) notes.push(`${it.name}: ${it.reason || 'indisponível'}`);
      else if (it.priceChanged) notes.push(`${it.name}: preço atualizado para R$ ${Number(it.price).toFixed(2)}`);
    }
    setCartNotes((n) => ({ ...n, [lookId]: notes }));
    const available = (r.data.items || []).filter((it: any) => it.available);
    if (!available.length) { setError('Nenhuma peça deste look está disponível agora.'); return; }
    onAddLookItems?.(available.map((it: any) => ({ productId: it.productId, name: it.name, image: it.image, price: it.price })), lookId);
    setOpen(false);
  }

  async function shareLook(lookId: string) {
    const r = await api(`/looks/${lookId}/share`, { method: 'POST' }, token);
    if (!r.ok) { setError(r.data?.error || 'Não foi possível gerar o link.'); return; }
    const url = `${window.location.origin}/loja/${encodeURIComponent(slug)}?look=${encodeURIComponent(r.data.token)}`;
    try { await navigator.clipboard.writeText(url); setShareCopied(lookId); setTimeout(() => setShareCopied(null), 2500); } catch { /* noop */ }
    window.open(`https://wa.me/?text=${encodeURIComponent(`Olha o look que montei: ${url}`)}`, '_blank');
  }

  async function generateTryOn(lookId: string) {
    setError('');
    setTryon((t) => ({ ...t, [lookId]: { jobId: '', status: 'QUEUED', url: null, error: null } }));
    const r = await api(`/looks/${lookId}/generate`, { method: 'POST' }, token);
    if (!r.ok) {
      setTryon((t) => { const { [lookId]: _drop, ...rest } = t; return rest; });
      setError(r.data?.error || 'Não foi possível gerar a prévia agora.');
      return;
    }
    setCredits(r.data.credits || null);
    setTryon((t) => ({ ...t, [lookId]: { jobId: r.data.jobId, status: r.data.status, url: null, error: null } }));
    if (r.data.status === 'SUCCEEDED') {
      const j = await api(`/tryon-jobs/${r.data.jobId}`, {}, token);
      if (j.ok) setTryon((t) => ({ ...t, [lookId]: { jobId: r.data.jobId, status: j.data.status, url: j.data.url, error: j.data.error } }));
      return;
    }
    pollJob(lookId, r.data.jobId);
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
                      <button type="button" className={primaryBtn} style={{ background: accent }} onClick={openQuiz}>
                        Montar meu look por ocasião
                      </button>
                      <button type="button" className="w-full text-center text-xs opacity-60 underline-offset-2 hover:underline" onClick={async () => { await loadProfile(); setStep('prefs'); }}>
                        Minhas preferências e personalização
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
                      {tryon[look.id]?.url && (
                        <img src={tryon[look.id].url!} alt="Prévia do look em você" className="mb-2 w-full rounded-xl object-contain" />
                      )}
                      {tryon[look.id]?.error && <p className="mb-2 text-xs text-red-500">{tryon[look.id].error}</p>}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={!!tryon[look.id] && !['SUCCEEDED', 'FAILED_FINAL', 'EXPIRED', 'DELETED'].includes(tryon[look.id].status)}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                          style={{ background: accent }}
                          onClick={() => generateTryOn(look.id)}
                        >
                          {tryon[look.id] && !['SUCCEEDED', 'FAILED_FINAL', 'EXPIRED', 'DELETED'].includes(tryon[look.id].status)
                            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Gerando…</>
                            : tryon[look.id]?.status === 'SUCCEEDED' ? 'Gerar de novo' : 'Ver em mim'}
                        </button>
                        <button type="button" disabled={!!look.saved} className="flex-1 rounded-xl border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                          style={{ borderColor: hexToRgba(accent, 0.4), color: accent }} onClick={() => saveLook(look.id)}>
                          {look.saved ? '✓ Look salvo' : 'Salvar este look'}
                        </button>
                      </div>
                      {cartNotes[look.id]?.length > 0 && (
                        <ul className="mt-2 list-disc pl-4 text-[11px] text-amber-500">
                          {cartNotes[look.id].map((n, j) => <li key={j}>{n}</li>)}
                        </ul>
                      )}
                      <div className="mt-2 flex gap-2">
                        <button type="button" className="flex-1 rounded-xl border px-3 py-1.5 text-xs font-bold"
                          style={{ borderColor: accent, color: accent }} onClick={() => buyLook(look.id)}>
                          🛒 Comprar este look
                        </button>
                        <button type="button" className="rounded-xl border px-3 py-1.5 text-xs"
                          style={{ borderColor: hexToRgba(accent, 0.4) }} onClick={() => shareLook(look.id)}>
                          {shareCopied === look.id ? '✓ Link copiado' : 'Compartilhar'}
                        </button>
                      </div>
                      <div className="mt-2 flex items-center justify-center gap-2 text-[11px]">
                        {feedbackGiven[look.id] ? (
                          <span className="opacity-60">Obrigada pelo feedback! ✓</span>
                        ) : (
                          <>
                            <span className="opacity-50">Esse look:</span>
                            <button type="button" className="rounded-full border px-2 py-0.5 opacity-70 hover:opacity-100" style={{ borderColor: hexToRgba(accent, 0.3) }} onClick={() => sendFeedback(look.id, 'liked')}>👍 Gostei</button>
                            <button type="button" className="rounded-full border px-2 py-0.5 opacity-70 hover:opacity-100" style={{ borderColor: hexToRgba(accent, 0.3) }} onClick={() => sendFeedback(look.id, 'disliked')}>👎 Não gostei</button>
                            <button type="button" className="rounded-full border px-2 py-0.5 opacity-70 hover:opacity-100" style={{ borderColor: hexToRgba(accent, 0.3) }} onClick={() => sendFeedback(look.id, 'would_not_wear')}>🚫 Não usaria</button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {credits && <p className="text-center text-[11px] opacity-50">{credits.available} de {credits.limit} prévias restantes hoje.</p>}
                  <button type="button" className="w-full text-center text-xs opacity-60 hover:opacity-100" onClick={() => setStep('quiz')}>Ajustar respostas</button>
                </div>
              )}

              {step === 'prefs' && (
                <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                  <h3 className="text-sm font-semibold">Minhas preferências</h3>
                  <div className="flex items-center justify-between rounded-xl border px-3 py-2" style={{ borderColor: hexToRgba(accent, 0.3) }}>
                    <div>
                      <p className="text-xs font-semibold">Personalização</p>
                      <p className="text-[11px] opacity-60">Ligada: suas respostas e feedbacks melhoram as próximas sugestões. Desligada: nada é salvo nem usado.</p>
                    </div>
                    <button type="button" role="switch" aria-checked={personalization} onClick={togglePersonalization}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${personalization ? '' : 'bg-zinc-600'}`}
                      style={personalization ? { background: accent } : {}}>
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${personalization ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </div>
                  {prefs.length === 0 ? (
                    <p className="text-xs opacity-60">Nenhuma preferência salva ainda — responda o questionário para começar.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {prefs.map((p) => (
                        <div key={p.id} className="flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs" style={{ borderColor: hexToRgba(accent, 0.2) }}>
                          <span className="flex-1">
                            {p.type === 'occasion' ? `Ocasião: ${p.value}` :
                             p.type === 'style_like' ? `Estilo: ${p.value}` :
                             p.type === 'color_avoid' ? `Evita a cor: ${p.value}` :
                             p.type === 'fit_avoid' ? `Evita: ${p.value}` :
                             p.type === 'budget_range' ? `Orçamento: até R$ ${p.value?.max}` :
                             p.type === 'look_feedback' ? `Feedback de look: ${p.value?.verdict === 'liked' ? 'gostei' : p.value?.verdict === 'disliked' ? 'não gostei' : 'não usaria'}${p.value?.categories?.length ? ` (${p.value.categories.join(', ')})` : ''}` :
                             `${p.type}`}
                          </span>
                          <button type="button" className="text-red-500/70 hover:text-red-500" onClick={() => deletePref(p.id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button type="button" className="w-full text-center text-xs opacity-60 hover:opacity-100" onClick={() => setStep('status')}>Voltar</button>
                </div>
              )}

              {step === 'shared' && sharedLook && (
                <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                  <h3 className="text-sm font-semibold">Um look compartilhado com você ✨</h3>
                  <div className="rounded-2xl border p-3" style={{ borderColor: hexToRgba(accent, 0.3) }}>
                    <div className="mb-2 space-y-1.5">
                      {sharedLook.items.map((it) => (
                        <div key={it.productId} className="flex items-center gap-2 text-sm">
                          {it.image && <img src={it.image} alt="" className="h-10 w-10 rounded-lg object-cover" />}
                          <span className={`flex-1 ${it.available ? '' : 'line-through opacity-50'}`}>{it.name}</span>
                          <span className="text-xs opacity-70">{it.available ? `R$ ${it.price.toFixed(2)}` : 'esgotado'}</span>
                        </div>
                      ))}
                    </div>
                    {sharedLook.explanation && <p className="mb-2 text-xs opacity-70">{sharedLook.explanation}</p>}
                    <p className="mb-2 text-xs font-semibold" style={{ color: accent }}>Total disponível: R$ {sharedLook.total.toFixed(2)}</p>
                    <button type="button" className={primaryBtn} style={{ background: accent }}
                      onClick={() => {
                        const available = sharedLook.items.filter((i) => i.available);
                        if (available.length) { onAddLookItems?.(available.map((i) => ({ productId: i.productId, name: i.name, image: i.image, price: i.price })), sharedLook.lookId); setOpen(false); }
                      }}>
                      Adicionar tudo ao carrinho
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
