import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { FalatuAuth } from './FalatuAuth';
import { FalaTuView } from '@/src/features/FalaTuView';
import { Smartphone, RefreshCw, CheckCircle2, LogOut, Loader2 } from 'lucide-react';

// ADR-154 F7.1 — root do app FalaTu STANDALONE (subdomínio dedicado).
//
// Roteamento mínimo, sem react-router (o app tem 3 estados só):
//   loading           → spinner (AuthContext validando token)
//   sem sessão        → FalatuAuth (login/cadastro)
//   sessão + !conectado → FalatuConnect (QR persistente)
//   sessão + conectado  → FalaTuView (o app de verdade)
//
// A checagem de status do WhatsApp roda a cada mount de sessão. Enquanto
// não conecta, o app fica na tela de QR — e como a sessão JÁ está no
// localStorage (persistida no auth), o refresh mantém o usuário aqui em vez
// de jogá-lo pro login. Resolve a queixa de persistência direto.
//
// F7.1b — porteiro pós-login. O /api/auth/login aceita QUALQUER conta do
// backend compartilhado (inclusive contas da suíte ZappFlow). Sem gate, uma
// conta suíte caía na tela de QR e o provision devolvia 403 em loop ("org
// não tem blueprint solo"). Agora classificamos o acesso após o login:
//   'solo'   → org com WhatsApp dedicado (kind='dedicated') → fluxo QR
//   'shared' → org suíte COM FalaTu habilitado (ou master admin) → app
//              direto, sem exigir QR (o canal da suíte é gerido no painel)
//   'denied' → conta ZappFlow sem FalaTu → tela explicativa, sem loop de 403

type WaStatus = { kind: string; connected: boolean; hasQr: boolean } | null;
type Access = 'checking' | 'solo' | 'shared' | 'denied';

function Shell({ email, onLogout, children }: { email?: string; onLogout: () => void; children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-zinc-950">
      <header className="flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-4 backdrop-blur-sm shrink-0">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
            <Smartphone className="w-4 h-4 text-emerald-300" />
          </span>
          <span className="font-semibold text-zinc-100">Fala<span className="text-emerald-400">Tu</span></span>
        </div>
        <div className="flex items-center gap-3">
          {email && <span className="text-xs text-zinc-500 hidden sm:inline">{email}</span>}
          <button onClick={onLogout} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200" title="Sair">
            <LogOut className="w-4 h-4" /> <span className="hidden sm:inline">Sair</span>
          </button>
        </div>
      </header>
      <main className="flex-1 min-h-0 flex flex-col">{children}</main>
    </div>
  );
}

// Tela de conexão do WhatsApp — QR + polling. Persistente: a sessão já está
// gravada, então dar refresh aqui mantém o usuário nesta tela (não no login).
function FalatuConnect({ token, onConnected }: { token: string; onConnected: () => void }) {
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
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">Conecte seu WhatsApp</h2>
        <p className="text-sm text-zinc-400 mb-5">Escaneie o código pra ativar seu assistente.</p>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm">{error}</div>
        )}

        {qrSrc ? (
          <div className="bg-white rounded-xl p-4 inline-block mx-auto">
            <img src={qrSrc} alt="QR do WhatsApp" className="w-64 h-64" />
          </div>
        ) : (
          <div className="w-64 h-64 mx-auto rounded-xl border border-dashed border-zinc-700 bg-zinc-900 flex items-center justify-center text-zinc-500 text-sm">
            {provisioning ? <Loader2 className="w-6 h-6 animate-spin" /> : 'QR indisponível — gere abaixo'}
          </div>
        )}

        <ol className="text-left text-xs text-zinc-400 space-y-1 max-w-xs mx-auto mt-5">
          <li>1. Abra o WhatsApp no celular</li>
          <li>2. <b>Menu → Aparelhos conectados → Conectar aparelho</b></li>
          <li>3. Aponte a câmera pro QR acima</li>
        </ol>

        <div className="flex flex-col items-center gap-2 mt-4">
          <button type="button" onClick={provision} disabled={provisioning}
            className="text-sm text-emerald-400 hover:text-emerald-300 flex items-center gap-1 disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${provisioning ? 'animate-spin' : ''}`} />
            {provisioning ? 'Gerando…' : qr ? 'Gerar QR novamente' : 'Gerar QR agora'}
          </button>
          <p className="text-[11px] text-zinc-500">Aguardando conexão… {elapsed > 0 ? `(${elapsed}s)` : ''}</p>
        </div>
      </div>
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
        <h2 className="text-lg font-semibold text-zinc-100 mb-2">Esta conta não tem o FalaTu</h2>
        <p className="text-sm text-zinc-400 mb-5">
          O email <span className="text-zinc-200">{email}</span> pertence a uma conta ZappFlow sem o módulo FalaTu habilitado.
        </p>
        <div className="flex flex-col gap-2 max-w-xs mx-auto">
          <button onClick={onLogout}
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm py-2.5 font-medium">
            Sair e criar uma conta FalaTu (outro email)
          </button>
          <a href="https://zapflowia.tesseractauto.com.br"
            className="w-full rounded-md border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-sm py-2.5 font-medium">
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
    return <div className="min-h-screen flex items-center justify-center bg-zinc-950"><Loader2 className="w-8 h-8 text-emerald-400 animate-spin" /></div>;
  }
  if (!user || !token) return <FalatuAuth />;

  if (access === 'checking') {
    return (
      <Shell email={user.email} onLogout={logout}>
        <div className="flex-1 flex items-center justify-center"><Loader2 className="w-6 h-6 text-emerald-400 animate-spin" /></div>
      </Shell>
    );
  }

  if (access === 'denied') {
    return (
      <Shell email={user.email} onLogout={logout}>
        <FalatuNoAccess email={user.email} onLogout={logout} />
      </Shell>
    );
  }

  // Solo sem WhatsApp conectado → tela de pareamento. Suíte ('shared') nunca
  // passa por aqui: o canal WhatsApp da suíte é gerido no painel ZappFlow.
  if (access === 'solo' && !wa?.connected) {
    return (
      <Shell email={user.email} onLogout={logout}>
        <FalatuConnect token={token} onConnected={() => setWa({ kind: 'dedicated', connected: true, hasQr: false })} />
      </Shell>
    );
  }

  return (
    <Shell email={user.email} onLogout={logout}>
      <FalaTuView />
    </Shell>
  );
}
