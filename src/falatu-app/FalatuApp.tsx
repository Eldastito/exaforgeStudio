import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { startOutboxFlusher } from '@/src/lib/continuity/sync';
import { FalatuAuth } from './FalatuAuth';
import { FalaTuView } from '@/src/features/FalaTuView';
import { FalatuLogo } from '@/src/components/brand/FalatuLogo';
import { useFalatuTheme, type FalatuTheme } from './useFalatuTheme';
import { RefreshCw, LogOut, Loader2, MessageCircle, X, ArrowLeft, Sun, Moon } from 'lucide-react';

// Botão de alternância claro/escuro — reusado no header (Shell) e na tela de
// auth. Sol quando está escuro (vai clarear), Lua quando está claro.
function ThemeToggle({ theme, onToggle }: { theme: FalatuTheme; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--color-ft-text-muted)] hover:text-[var(--color-ft-text)] hover:bg-ft-surface-2 transition-colors"
      title={theme === 'dark' ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'}
      aria-label={theme === 'dark' ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'}>
      {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

// F9.1 — branding de documento em RUNTIME (não em index.html, que segue
// ZappFlow pra suíte). Roda só aqui, no app standalone: título, theme-color
// Ink, favicon e manifest oficiais do Fala Tu. Idempotente (cria a <link> uma
// vez, reusa depois). Mantém as duas marcas separadas na MESMA casca HTML.
function applyFalatuDocumentBrand() {
  try {
    document.title = 'Fala Tu — Do pensamento para a vida';
    const setLink = (rel: string, href: string, extra?: Record<string, string>) => {
      let el = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      if (!el) { el = document.createElement('link'); el.rel = rel; document.head.appendChild(el); }
      el.href = href;
      if (extra) for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
    };
    setLink('icon', '/falatu-brand/icon.svg', { type: 'image/svg+xml' });
    setLink('apple-touch-icon', '/falatu-brand/apple-touch-icon.png');
    setLink('manifest', '/falatu.webmanifest');
    // O <meta theme-color> é gerido pelo useFalatuTheme (varia com claro/escuro).
  } catch { /* branding é cosmético — nunca derruba o app */ }
}

// ADR-154 F7.1 — root do app FalaTu STANDALONE (subdomínio dedicado).
//
// Roteamento mínimo, sem react-router:
//   loading     → spinner (AuthContext validando token)
//   sem sessão  → FalatuAuth (login/cadastro)
//   sessão      → FalaTuView (o app de verdade) DIRETO — ver F8.1 abaixo
//
// A sessão fica no localStorage (persistida no auth), então refresh mantém o
// usuário no app em vez de jogá-lo pro login.
//
// F7.1b — porteiro pós-login. O /api/auth/login aceita QUALQUER conta do
// backend compartilhado (inclusive contas da suíte ZappFlow). Sem gate, uma
// conta suíte caía na tela de QR e o provision devolvia 403 em loop ("org
// não tem blueprint solo"). Agora classificamos o acesso após o login:
//   'solo'   → org com WhatsApp dedicado (kind='dedicated')
//   'shared' → org suíte COM FalaTu habilitado (ou master admin) — o canal
//              WhatsApp da suíte é gerido no painel, nunca aqui
//   'denied' → conta ZappFlow sem FalaTu → tela explicativa, sem loop de 403
//
// F8.1 (Fase 8) — browser-first. A tela de QR DEIXOU de ser porteiro do
// solo: o pareamento por QR do Evolution nunca foi confiável e trancava o
// usuário fora de um app que funciona 100% pelo navegador (captura por
// microfone/foto/texto já é HTTP puro). Agora o solo entra direto na
// FalaTuView; conectar WhatsApp é um banner opcional que abre a FalatuConnect
// sob demanda. Efeito colateral desejado: o provision (que cria instância na
// Evolution) só roda quando o usuário PEDE a conexão — não mais no mount.

type WaStatus = { kind: string; connected: boolean; hasQr: boolean } | null;
type Access = 'checking' | 'solo' | 'shared' | 'denied';

function Shell({ email, onLogout, theme, onToggleTheme, children }: {
  email?: string; onLogout: () => void; theme: FalatuTheme; onToggleTheme: () => void; children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-ft-bg)' }}>
      <header
        className="flex h-14 items-center justify-between px-4 backdrop-blur-sm shrink-0"
        style={{ borderBottom: '1px solid var(--color-ft-border)', background: 'color-mix(in srgb, var(--color-ft-bg) 80%, transparent)' }}
      >
        <FalatuLogo size={28} withWordmark />
        <div className="flex items-center gap-2 sm:gap-3">
          {email && <span className="text-xs hidden sm:inline" style={{ color: 'var(--color-ft-text-muted)' }}>{email}</span>}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button onClick={onLogout}
            className="flex items-center gap-1.5 text-sm text-[var(--color-ft-text-muted)] hover:text-[var(--color-ft-text)]" title="Sair">
            <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Sair</span>
          </button>
        </div>
      </header>
      <main className="flex-1 min-h-0 flex flex-col">{children}</main>
    </div>
  );
}

// Tela de conexão do WhatsApp — QR + polling. Desde a F8.1 é OPT-IN (aberta
// pelo banner dentro do app), não porteiro — por isso o onBack: o usuário
// sempre pode voltar pro app sem parear.
function FalatuConnect({ token, onConnected, onBack }: { token: string; onConnected: () => void; onBack: () => void }) {
  const [qr, setQr] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');

  const provision = useCallback(async () => {
    setProvisioning(true); setError('');
    try {
      const r = await fetch('/api/falatu-solo/whatsapp/provision', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok || !d.qrBase64) throw new Error(d.error || 'QR indisponível — tente de novo em instantes.');
      setQr(d.qrBase64);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setProvisioning(false);
    }
  }, [token]);

  // Provisiona uma vez ao montar (best-effort) e liga o polling de status.
  useEffect(() => { void provision(); }, [provision]);
  useEffect(() => {
    let stopped = false;
    const start = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch('/api/falatu-solo/whatsapp/status', { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) {
          const s = await r.json();
          setElapsed(Math.floor((Date.now() - start) / 1000));
          if (s.connected) { onConnected(); return; }
        }
      } catch { /* próxima tentativa cobre */ }
      if (!stopped) setTimeout(tick, 3000);
    };
    const id = setTimeout(tick, 3000);
    return () => { stopped = true; clearTimeout(id); };
  }, [token, onConnected]);

  const qrSrc = qr ? (qr.startsWith('data:image') ? qr : `data:image/png;base64,${qr}`) : '';

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md text-center">
        <button type="button" onClick={onBack}
          className="mb-4 inline-flex items-center gap-1 text-sm text-ft-text-muted hover:text-ft-text">
          <ArrowLeft className="w-4 h-4" /> Voltar pro app
        </button>
        <h2 className="text-lg font-semibold text-ft-text mb-1">Conecte seu WhatsApp</h2>
        <p className="text-sm text-ft-text-muted mb-5">
          Opcional — o app já funciona pelo navegador. Conectando, você também captura mandando áudio pelo WhatsApp.
        </p>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-ft-on-amber text-sm">{error}</div>
        )}

        {qrSrc ? (
          <div className="bg-white rounded-xl p-4 inline-block mx-auto">
            <img src={qrSrc} alt="QR do WhatsApp" className="w-64 h-64" />
          </div>
        ) : (
          <div className="w-64 h-64 mx-auto rounded-xl border border-dashed border-ft-border bg-ft-surface flex items-center justify-center text-ft-text-faint text-sm">
            {provisioning ? <Loader2 className="w-6 h-6 animate-spin" /> : 'QR indisponível — gere abaixo'}
          </div>
        )}

        <ol className="text-left text-xs text-ft-text-muted space-y-1 max-w-xs mx-auto mt-5">
          <li>1. Abra o WhatsApp no celular</li>
          <li>2. <b>Menu → Aparelhos conectados → Conectar aparelho</b></li>
          <li>3. Aponte a câmera pro QR acima</li>
        </ol>

        <div className="flex flex-col items-center gap-2 mt-4">
          <button type="button" onClick={provision} disabled={provisioning}
            className="text-sm text-ft-menta hover:brightness-110 flex items-center gap-1 disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${provisioning ? 'animate-spin' : ''}`} />
            {provisioning ? 'Gerando…' : qr ? 'Gerar QR novamente' : 'Gerar QR agora'}
          </button>
          <p className="text-[11px] text-ft-text-faint">Aguardando conexão… {elapsed > 0 ? `(${elapsed}s)` : ''}</p>
        </div>
      </div>
    </div>
  );
}

// F8.1 — convite opcional de conexão do WhatsApp pro solo não-pareado.
// Dispensável só pra sessão (estado, não localStorage): enquanto não existe a
// FalaTuSettingsView (F3), o banner no próximo acesso é o único caminho de
// volta pra conexão — dispensa permanente trancaria o usuário fora do plugue.
function WhatsAppOptInBanner({ onConnect, onDismiss }: { onConnect: () => void; onDismiss: () => void }) {
  return (
    <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-ft-menta/25 bg-ft-menta/5 px-3 py-2.5">
      <MessageCircle className="w-4 h-4 text-ft-menta shrink-0" />
      <p className="flex-1 text-xs" style={{ color: 'var(--color-ft-text)' }}>
        Quer capturar mandando áudio pelo WhatsApp também? Conecte seu número quando quiser.
      </p>
      <button type="button" onClick={onConnect}
        className="text-xs font-medium text-ft-menta hover:brightness-110 shrink-0">
        Conectar
      </button>
      <button type="button" onClick={onDismiss} title="Agora não"
        className="text-ft-text-faint hover:text-ft-text shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// Conta ZappFlow sem FalaTu — explica em vez de deixar o provision 403ar em
// loop. O usuário decide: sair e criar conta Solo própria, ou voltar pro
// painel e habilitar o módulo no plano da empresa (decisão B.1: 1 email =
// 1 conta; não criamos conta paralela com o mesmo email).
function FalatuNoAccess({ email, onLogout }: { email?: string; onLogout: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md text-center">
        <h2 className="text-lg font-semibold text-ft-text mb-2">Esta conta não tem o FalaTu</h2>
        <p className="text-sm text-ft-text-muted mb-5">
          O email <span className="text-ft-text">{email}</span> pertence a uma conta ZappFlow sem o módulo FalaTu habilitado.
        </p>
        <div className="flex flex-col gap-2 max-w-xs mx-auto">
          <button onClick={onLogout}
            className="w-full rounded-md text-white text-sm py-2.5 font-medium hover:brightness-110"
            style={{ background: 'var(--color-ft-cobalto)' }}>
            Sair e criar uma conta FalaTu (outro email)
          </button>
          <a href="https://zapflowia.tesseractauto.com.br"
            className="w-full rounded-md border border-ft-border hover:border-ft-border-strong text-ft-text text-sm py-2.5 font-medium">
            Ir pro painel ZappFlow (habilitar no plano)
          </a>
        </div>
      </div>
    </div>
  );
}

export function FalatuApp() {
  const { user, token, loading, logout } = useAuth();
  const [wa, setWa] = useState<WaStatus>(null);
  const [access, setAccess] = useState<Access>('checking');
  const [showConnect, setShowConnect] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // F9.2 — tema claro/escuro (aplica a classe no <html>; escolha persiste).
  const { theme, toggle } = useFalatuTheme();

  // F8.2 — o standalone não passa pelo App.tsx da suíte (que já roda o
  // flusher do outbox): liga aqui o reenvio das capturas offline ao montar,
  // ao voltar 'online' e no intervalo de segurança. O sender de
  // FALATU_CAPTURE registra no import da FalaTuView (cadeia estática).
  useEffect(() => startOutboxFlusher(), []);

  // F9.1 — aplica a marca oficial ao documento assim que o app standalone monta.
  useEffect(() => { applyFalatuDocumentBrand(); }, []);

  // Ao ganhar sessão: classifica o acesso (entitlements) + status do WhatsApp
  // numa rodada só. Decide a rota sem nunca chamar provision pra org não-solo.
  useEffect(() => {
    if (!token) { setWa(null); setAccess('checking'); return; }
    let alive = true;
    (async () => {
      try {
        const [entR, waR] = await Promise.all([
          fetch('/api/entitlements/me', { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/api/falatu-solo/whatsapp/status', { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        const ent = entR.ok ? await entR.json() : null;
        const waS = waR.ok ? await waR.json() : null;
        if (!alive) return;
        setWa(waS);
        const canUse = !!ent?.meta?.falatuEnabled || !!ent?.meta?.isMasterAdmin;
        if (!canUse) setAccess('denied');
        else if (waS?.kind === 'dedicated') setAccess('solo');
        else setAccess('shared');
      } catch {
        // Backend fora do ar não é "sem acesso" — assume shared e deixa o
        // FalaTuView lidar com os erros de API (padrão de contingência).
        if (alive) setAccess('shared');
      }
    })();
    return () => { alive = false; };
  }, [token]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-ft-bg)' }}><Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--color-ft-cobalto)' }} /></div>;
  }
  if (!user || !token) return <FalatuAuth theme={theme} onToggleTheme={toggle} />;

  if (access === 'checking') {
    return (
      <Shell email={user.email} onLogout={logout} theme={theme} onToggleTheme={toggle}>
        <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-ft-cobalto)' }} /></div>
      </Shell>
    );
  }

  if (access === 'denied') {
    return (
      <Shell email={user.email} onLogout={logout} theme={theme} onToggleTheme={toggle}>
        <FalatuNoAccess email={user.email} onLogout={logout} />
      </Shell>
    );
  }

  // F8.1: a tela de pareamento só aparece quando o usuário PEDE (banner →
  // Conectar). Suíte ('shared') nunca chega aqui: o canal da suíte é gerido
  // no painel ZappFlow e o banner nem renderiza pra ela.
  if (showConnect) {
    return (
      <Shell email={user.email} onLogout={logout} theme={theme} onToggleTheme={toggle}>
        <FalatuConnect token={token} onBack={() => setShowConnect(false)}
          onConnected={() => { setWa({ kind: 'dedicated', connected: true, hasQr: false }); setShowConnect(false); }} />
      </Shell>
    );
  }

  return (
    <Shell email={user.email} onLogout={logout} theme={theme} onToggleTheme={toggle}>
      {access === 'solo' && !wa?.connected && !bannerDismissed && (
        <WhatsAppOptInBanner onConnect={() => setShowConnect(true)} onDismiss={() => setBannerDismissed(true)} />
      )}
      <FalaTuView />
    </Shell>
  );
}
