import React, { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { startOutboxFlusher } from '@/src/lib/continuity/sync';
import { FalatuAuth } from './FalatuAuth';
import { FalaTuView } from '@/src/features/FalaTuView';
import { FalatuLogo } from '@/src/components/brand/FalatuLogo';
import { useFalatuTheme, type FalatuTheme } from './useFalatuTheme';
import { RefreshCw, LogOut, Loader2, MessageCircle, X, ArrowLeft, Sun, Moon, Settings, ShieldCheck, CheckCircle2, AlertTriangle } from 'lucide-react';

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

function Shell({ email, onLogout, theme, onToggleTheme, onOpenAccount, children }: {
  email?: string; onLogout: () => void; theme: FalatuTheme; onToggleTheme: () => void;
  onOpenAccount?: () => void; children: React.ReactNode;
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
          {/* F2.2 E.2 — entrada da tela "Conta" (garantia + reembolso). Só o solo
              a recebe (o onOpenAccount vem undefined pra suíte/checando/negado). */}
          {onOpenAccount && (
            <button type="button" onClick={onOpenAccount}
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--color-ft-text-muted)] hover:text-[var(--color-ft-text)] hover:bg-ft-surface-2 transition-colors"
              title="Conta e garantia" aria-label="Conta e garantia">
              <Settings className="w-4 h-4" />
            </button>
          )}
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

// ADR-154 F2.2 Fatia E.2 — UI do reembolso da garantia de 7 dias: a face
// visível dos endpoints da Fatia E. NENHUM comportamento de backend muda aqui.
//
// Lê GET /api/falatu/refund/eligibility pra mostrar quantos dias ainda restam
// e, DENTRO da janela, oferece o botão que dispara POST /api/falatu/refund
// (estorna no ASAAS + cancela a conta).
//
// Money-critical também no front: o reembolso é irreversível (cancela a conta
// e devolve o dinheiro), então exige confirmação explícita em DOIS passos e o
// botão trava enquanto o POST está em voo. O backend já é idempotente (RN-E3),
// mas a trava evita o duplo-clique virar UX confusa antes mesmo de sair da tela.
type RefundEligibility = {
  eligible: boolean;
  reason: string;     // 'ok' | 'not_falatu_plan' | 'already_refunded' | 'guarantee_expired' | 'guarantee_window_unknown'
  windowDays: number;
  daysLeft: number;
  deadline: string | null;
};

function formatBRL(n: number): string {
  try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n); }
  catch { return `R$ ${n.toFixed(2)}`; }
}

// O backend devolve só o código do motivo; a mensagem amigável mora aqui.
const REFUND_REASON_TEXT: Record<string, string> = {
  guarantee_expired: 'O prazo de garantia já passou. Você ainda pode cancelar pelo suporte.',
  already_refunded: 'Seu reembolso já foi processado e a conta está cancelada.',
  guarantee_window_unknown: 'Não conseguimos verificar o prazo da sua garantia. Fale com o suporte.',
  not_falatu_plan: 'O reembolso automático vale só para assinaturas do Fala Tu.',
};

function FalatuAccount({ token, onBack, onLogout }: { token: string; onBack: () => void; onLogout: () => void }) {
  const [elig, setElig] = useState<RefundEligibility | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState<{ refundedTotal: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const r = await fetch('/api/falatu/refund/eligibility', { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Não foi possível checar sua garantia.');
      setElig(d as RefundEligibility);
    } catch (e: any) {
      setLoadError(e.message || 'Falha ao carregar.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const submitRefund = useCallback(async () => {
    setSubmitting(true); setSubmitError('');
    try {
      const r = await fetch('/api/falatu/refund', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      // O backend responde { error, message } com o httpStatus do FalatuRefundError.
      if (!r.ok) throw new Error(d.message || d.error || 'Não foi possível concluir o reembolso.');
      setDone({ refundedTotal: Number(d.refundedTotal || 0) });
    } catch (e: any) {
      setSubmitError(e.message || 'Falha no reembolso.');
      setConfirming(false); // volta pro estado "Quero meu reembolso" pra permitir novo ciclo
    } finally {
      setSubmitting(false);
    }
  }, [token]);

  return (
    <div className="flex-1 flex items-start justify-center px-4 py-8 overflow-auto">
      <div className="w-full max-w-md">
        <button type="button" onClick={onBack}
          className="mb-4 inline-flex items-center gap-1 text-sm text-ft-text-muted hover:text-ft-text">
          <ArrowLeft className="w-4 h-4" /> Voltar pro app
        </button>

        <h2 className="text-lg font-semibold text-ft-text mb-1">Conta</h2>
        <p className="text-sm text-ft-text-muted mb-5">Sua assinatura e a garantia de 7 dias.</p>

        {done ? (
          // Estado terminal: reembolso concluído nesta sessão. A conta já está
          // cancelada no backend; o acesso à IA para pelo enforcement da Fatia C.
          <div className="rounded-xl border border-ft-border bg-ft-surface p-5 text-center">
            <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-ft-menta" />
            <h3 className="text-base font-semibold text-ft-text mb-1">Reembolso concluído</h3>
            <p className="text-sm text-ft-text-muted mb-4">
              {done.refundedTotal > 0
                ? `Devolvemos ${formatBRL(done.refundedTotal)} e cancelamos sua assinatura.`
                : 'Sua assinatura foi cancelada. Não havia pagamento confirmado para devolver.'}
              {' '}O acesso encerra ao sair.
            </p>
            <button onClick={onLogout}
              className="w-full rounded-md text-white text-sm py-2.5 font-medium hover:brightness-110"
              style={{ background: 'var(--color-ft-cobalto)' }}>
              Sair
            </button>
          </div>
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-ft-cobalto)' }} /></div>
        ) : loadError ? (
          <div className="rounded-xl border border-ft-border bg-ft-surface p-5">
            <p className="text-sm text-ft-text-muted mb-3">{loadError}</p>
            <button onClick={() => void load()} className="text-sm text-ft-menta hover:brightness-110 inline-flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> Tentar de novo
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-ft-border bg-ft-surface p-5">
            <div className="flex items-center gap-2 mb-2">
              <ShieldCheck className="w-5 h-5 text-ft-menta" />
              <h3 className="text-base font-semibold text-ft-text">Garantia de {elig?.windowDays ?? 7} dias</h3>
            </div>

            {elig?.eligible ? (
              <>
                <p className="text-sm text-ft-text-muted mb-1">
                  Não gostou? Você tem direito de arrependimento (CDC Art. 49): devolvemos o valor pago e cancelamos a conta.
                </p>
                <p className="text-sm text-ft-text mb-4">
                  {elig.daysLeft === 1 ? 'Resta 1 dia' : `Restam ${elig.daysLeft} dias`}
                  {elig.deadline ? ` — até ${new Date(elig.deadline).toLocaleDateString('pt-BR')}.` : '.'}
                </p>

                {submitError && (
                  <div className="mb-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-ft-on-amber text-sm">{submitError}</div>
                )}

                {!confirming ? (
                  <button onClick={() => { setSubmitError(''); setConfirming(true); }}
                    className="w-full rounded-md text-white text-sm py-2.5 font-medium hover:brightness-110"
                    style={{ background: 'var(--color-ft-cobalto)' }}>
                    Quero meu reembolso
                  </button>
                ) : (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <div className="flex items-start gap-2 mb-3">
                      <AlertTriangle className="w-4 h-4 text-ft-on-amber shrink-0 mt-0.5" />
                      <p className="text-sm text-ft-on-amber">
                        Isto <b>cancela sua conta do Fala Tu</b> e devolve o valor pago. Não dá pra desfazer.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => void submitRefund()} disabled={submitting}
                        className="flex-1 rounded-md text-white text-sm py-2.5 font-medium hover:brightness-110 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
                        style={{ background: 'var(--color-ft-cobalto)' }}>
                        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                        {submitting ? 'Processando…' : 'Confirmar reembolso'}
                      </button>
                      <button onClick={() => setConfirming(false)} disabled={submitting}
                        className="rounded-md border border-ft-border hover:border-ft-border-strong text-ft-text text-sm px-4 py-2.5 font-medium disabled:opacity-60">
                        Agora não
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-ft-text-muted mb-3">
                  {REFUND_REASON_TEXT[elig?.reason || ''] || 'Sua conta não está na janela de garantia.'}
                </p>
                <a href="/fala-tu/cancelamento.html" target="_blank" rel="noreferrer"
                  className="text-sm text-ft-menta hover:brightness-110">
                  Ver política de cancelamento
                </a>
                {elig?.reason === 'already_refunded' && (
                  <button onClick={onLogout}
                    className="mt-4 w-full rounded-md border border-ft-border hover:border-ft-border-strong text-ft-text text-sm py-2.5 font-medium">
                    Sair
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function FalatuApp() {
  const { user, token, loading, logout } = useAuth();
  const [wa, setWa] = useState<WaStatus>(null);
  const [access, setAccess] = useState<Access>('checking');
  const [showConnect, setShowConnect] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
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

  // F2.2 E.2 — tela "Conta" (garantia + reembolso). Só o solo chega aqui: o
  // botão que a abre só é renderizado quando access === 'solo'.
  if (showAccount) {
    return (
      <Shell email={user.email} onLogout={logout} theme={theme} onToggleTheme={toggle}>
        <FalatuAccount token={token} onBack={() => setShowAccount(false)} onLogout={logout} />
      </Shell>
    );
  }

  return (
    <Shell email={user.email} onLogout={logout} theme={theme} onToggleTheme={toggle}
      onOpenAccount={access === 'solo' ? () => setShowAccount(true) : undefined}>
      {access === 'solo' && !wa?.connected && !bannerDismissed && (
        <WhatsAppOptInBanner onConnect={() => setShowConnect(true)} onDismiss={() => setBannerDismissed(true)} />
      )}
      <FalaTuView />
    </Shell>
  );
}
