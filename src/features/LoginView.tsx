import React, { useState, useEffect } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { Button } from '@/src/components/ui/button';
import { Eye, EyeOff, Smartphone, RefreshCw, CheckCircle2 } from 'lucide-react';

// ADR-154 F6.1 — sub-etapas da view 'solo'. Onboarding standalone termina
// SÓ quando o WhatsApp conecta (canal fica utilizável). Se parar em 'qr' sem
// escanear, o usuário nunca vira "logado" no app — evita cadastro-fantasma.
type SoloStep = 'form' | 'qr' | 'connecting';
// F2.1c — dentro do `form`, ainda existe o toggle "cadastro vs. login" pra
// quem já tem conta (evita loop "email in use" → tela morta).
type SoloMode = 'register' | 'login';

export function LoginView() {
  const { login } = useAuth();
  const [view, setView] = useState<'login' | 'register' | 'forgot' | 'reset' | 'plans' | 'solo'>('login');
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [phone, setPhone] = useState('');
  const [sizeRange, setSizeRange] = useState('');
  const [token, setToken] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [hasInvite, setHasInvite] = useState(false);
  // Convite de NOVA EMPRESA (cortesia): cria a empresa do convidado já com acesso definido.
  const [orgInviteToken, setOrgInviteToken] = useState('');
  const [orgInviteInfo, setOrgInviteInfo] = useState<{ businessName: string; recipientName: string; planName: string; modules: string[] } | null>(null);
  // Self-service: escolha de plano no cadastro (inicia teste grátis).
  const [plans, setPlans] = useState<any[]>([]);
  const [planId, setPlanId] = useState('');
  // Vertical (ramo) escolhida no cadastro — configura a conta já aqui e pula o
  // onboarding do 1º login. Substitui o antigo "Segmento" texto-livre.
  const [verticals, setVerticals] = useState<any[]>([]);
  const [vertical, setVertical] = useState('');
  // Bundle vertical recomendado pro ramo escolhido (ex.: Advocacia → Growth +
  // Advocacia). Escolher o bundle no cadastro ativa o add-on do módulo central,
  // então o 1º login já mostra a tela da vertical.
  const [bundles, setBundles] = useState<any[]>([]);
  const [bundleKey, setBundleKey] = useState('');

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  // ADR-154 F6.1 — estado do fluxo Solo. O token do auto-login fica AQUI
  // (não no localStorage/context) até o WhatsApp conectar; só aí chamamos
  // context.login(), que grava e re-renderiza pro FalaTuView. Sem isso, um
  // cadastro abandonado deixaria conta logada num app sem canal — pior UX.
  const [soloBlueprint, setSoloBlueprint] = useState('');
  const [soloStep, setSoloStep] = useState<SoloStep>('form');
  const [soloMode, setSoloMode] = useState<SoloMode>('register');
  const [soloQr, setSoloQr] = useState('');
  const [soloToken, setSoloToken] = useState('');
  const [soloUser, setSoloUser] = useState<any>(null);
  const [soloOrgId, setSoloOrgId] = useState('');
  const [soloReprovisioning, setSoloReprovisioning] = useState(false);
  const [soloElapsed, setSoloElapsed] = useState(0);
  // F2.1c — resposta 409 "email_in_use" traz `falatuInPlan`; usamos pra
  // sugerir "login normal" (se tem FalaTu no plano) ou "ver planos" (se não).
  const [soloFalatuInPlan, setSoloFalatuInPlan] = useState<boolean | null>(null);

  // Link de convite: ?invite=TOKEN&email=... abre o cadastro já preenchido.
  // (o app não envia e-mail, então o owner compartilha esse link manualmente)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const invite = params.get('invite') || params.get('token');
      const inviteEmail = params.get('email');
      const orgInvite = params.get('orgInvite');
      if (orgInvite) {
        // Convite de nova empresa: busca os dados e abre o cadastro de empresa.
        setView('register');
        setOrgInviteToken(orgInvite);
        fetch(`/api/auth/org-invite/${encodeURIComponent(orgInvite)}`)
          .then(r => r.json())
          .then(info => {
            if (info?.valid) {
              setOrgInviteInfo(info);
              if (info.businessName) setOrganizationName(info.businessName);
              if (info.recipientName) setName(info.recipientName);
            } else {
              setOrgInviteToken('');
              setError('Este convite é inválido ou expirou. Peça um novo link.');
            }
          })
          .catch(() => {});
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (invite) {
        setView('register');
        setHasInvite(true);
        setInviteToken(invite);
        if (inviteEmail) setEmail(inviteEmail);
        // Limpa a URL para não deixar o código exposto no histórico/barra.
        window.history.replaceState({}, document.title, window.location.pathname);
      } else {
        // ADR-154 F6.1 — link direto pro onboarding Solo (assistente pessoal
        // FalaTu). Aceita ?solo=<key> ou ?blueprint=<key>. Blueprint precisa
        // ser mode='solo' publicado; o backend valida em POST /api/onboarding-solo.
        const solo = params.get('solo') || params.get('blueprint');
        if (solo) {
          setView('solo');
          setSoloBlueprint(solo);
          window.history.replaceState({}, document.title, window.location.pathname);
        } else {
          const plan = params.get('plan');
          if (plan) { setPlanId(plan); setView('register'); window.history.replaceState({}, document.title, window.location.pathname); }
        }
      }
    } catch { /* noop */ }
  }, []);

  // Carrega os planos para a tela de "Ver planos" e a nota no cadastro.
  useEffect(() => {
    fetch('/api/plans').then(r => r.json()).then(d => setPlans(Array.isArray(d) ? d : [])).catch(() => {});
    fetch('/api/verticals').then(r => r.json()).then(d => setVerticals(Array.isArray(d) ? d : [])).catch(() => {});
    fetch('/api/plans/bundles').then(r => r.json()).then(d => setBundles(Array.isArray(d?.bundles) ? d.bundles : [])).catch(() => {});
  }, []);

  const brl = (v?: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR')}`;
  const selectedPlan = plans.find(p => p.id === planId);
  // Bundle recomendado pro ramo escolhido (verticalHints). Trocar de ramo limpa
  // a escolha do bundle (evita mandar bundle de outra vertical).
  const recommendedBundle = vertical ? bundles.find((b: any) => Array.isArray(b?.verticalHints) && b.verticalHints.includes(vertical)) : null;
  useEffect(() => { setBundleKey(''); }, [vertical]);

  // ADR-154 F6.1 — cadastro Solo. Passos: POST /api/onboarding-solo → guarda
  // orgId + qrBase64 → auto-login em background pra guardar Bearer necessário
  // pro polling /status → soloStep='qr'. Provision é best-effort no backend;
  // se qr vier vazio, mostra tela QR mesmo assim com botão pra gerar.
  const handleSoloRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true); setSoloFalatuInPlan(null);
    try {
      const res = await fetch('/api/onboarding-solo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, phone, password, blueprintKey: soloBlueprint || 'falatu_solo' }),
      });
      const data = await res.json();
      if (!res.ok) {
        // F2.1c: 409 com error='email_in_use' vem do backend com contexto
        // (`falatuInPlan`). Guarda o flag e mostra mensagem específica —
        // NÃO cai no throw genérico (que só mostraria "email in use" sem
        // ação clara pro usuário).
        if (res.status === 409 && data?.error === 'email_in_use') {
          setSoloFalatuInPlan(!!data.falatuInPlan);
          setError(data.message || 'Este email já tem conta.');
          setLoading(false);
          return;
        }
        throw new Error(data.error || 'Erro no cadastro');
      }
      setSoloOrgId(data.organizationId);

      // Auto-login em background — token ainda NÃO vai pro context (senão o
      // App re-renderiza e sai desta tela antes do QR aparecer). Só usamos
      // pra chamar /status com Authorization no polling.
      const rL = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const dL = await rL.json();
      if (!rL.ok) throw new Error(dL.error || 'Erro no login automático');
      setSoloToken(dL.token);
      setSoloUser(dL.user);

      if (data.whatsapp?.qrBase64) {
        setSoloQr(data.whatsapp.qrBase64);
      } else if (data.whatsapp?.provisionError) {
        setError(`WhatsApp offline: ${data.whatsapp.provisionError}. Clique em "Gerar QR" pra tentar de novo.`);
      }
      setSoloStep('qr');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // F2.1c — modo login dentro da view solo. Se o usuário já criou conta Solo
  // antes e voltou pelo mesmo link `?solo=<key>`, ele precisa LOGAR (não
  // recadastrar). Fluxo: POST /api/auth/login → se der certo, checamos o
  // WhatsApp status: se já conectado, chama context.login e o App leva pra
  // FalaTuView pelo default_landing_view; se não conectado, mostramos QR
  // pra ele terminar o pareamento.
  const handleSoloLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      const rL = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const dL = await rL.json();
      if (!rL.ok) throw new Error(dL.error || 'Email ou senha inválidos');
      setSoloToken(dL.token);
      setSoloUser(dL.user);

      // Consulta status do WhatsApp: se já conectado, entra direto no app;
      // se não, cai na tela QR pra terminar o pareamento.
      try {
        const rS = await fetch('/api/falatu-solo/whatsapp/status', {
          headers: { 'Authorization': `Bearer ${dL.token}` },
        });
        const s = rS.ok ? await rS.json() : null;
        if (s?.connected) {
          setSoloStep('connecting');
          login(dL.token, dL.user);
          return;
        }
      } catch { /* segue pra QR mesmo assim */ }

      setSoloQr('');
      setSoloStep('qr'); // dispara o effect de polling; usuário reautoriza QR se precisar
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReprovision = async () => {
    if (!soloToken) return;
    setSoloReprovisioning(true); setError('');
    try {
      const r = await fetch('/api/falatu-solo/whatsapp/provision', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${soloToken}` },
      });
      const d = await r.json();
      if (!r.ok || !d.qrBase64) throw new Error(d.error || 'Falha ao gerar QR');
      setSoloQr(d.qrBase64);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSoloReprovisioning(false);
    }
  };

  // Polling do status enquanto na etapa 'qr'. Para quando conectar (aí
  // dispara context.login e o App sobe). Intervalo curto (3s) — usuário está
  // olhando pra tela esperando.
  useEffect(() => {
    if (view !== 'solo' || soloStep !== 'qr' || !soloToken) return;
    let stopped = false;
    const start = Date.now();
    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch('/api/falatu-solo/whatsapp/status', {
          headers: { 'Authorization': `Bearer ${soloToken}` },
        });
        if (r.ok) {
          const s = await r.json();
          setSoloElapsed(Math.floor((Date.now() - start) / 1000));
          if (s.connected) {
            setSoloStep('connecting');
            login(soloToken, soloUser); // desmonta a view; efeito é limpado
            return;
          }
        }
      } catch { /* silencioso — próxima tentativa cobre */ }
      if (!stopped) setTimeout(tick, 3000);
    };
    tick();
    return () => { stopped = true; };
  }, [view, soloStep, soloToken, soloUser, login]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (view === 'register') {
        const payload: any = { name, email, password, phone };
        if (orgInviteToken) {
          payload.orgInviteToken = orgInviteToken;
          payload.organizationName = organizationName;
        } else if (hasInvite) {
          payload.inviteToken = inviteToken;
        } else {
          payload.organizationName = organizationName;
          payload.vertical = vertical;       // ramo → configura a conta e pula o onboarding
          payload.sizeRange = sizeRange;
          if (bundleKey) payload.bundleKey = bundleKey;  // bundle do ramo: plano-base + add-on do módulo central
          if (planId) payload.planId = planId;           // ignorado se bundleKey vier (basePlan tem prioridade)
        }
        
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro no registro');
        
        // Auto login after register
        const resLogin = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const dataLogin = await resLogin.json();
        if (!resLogin.ok) throw new Error(dataLogin.error || 'Erro no login automático');
        
        login(dataLogin.token, dataLogin.user);
      } else if (view === 'login') {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, mfaToken: mfaCode || undefined })
        });
        const data = await res.json();
        if (data.mfaRequired) {
          // 1º fator OK; pede o código do app autenticador (ou backup).
          setMfaRequired(true);
          if (mfaCode) setError(data.error || 'Código 2FA inválido.');
          return;
        }
        if (!res.ok) throw new Error(data.error || 'Erro no login');

        login(data.token, data.user);
      } else if (view === 'forgot') {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro.');
        
        setSuccess(data.message);
        setView('reset');
      } else if (view === 'reset') {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, token, newPassword: password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro.');
        
        setSuccess('Senha alterada com sucesso! Faça login.');
        setView('login');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
       <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-zinc-100">Zapp<span style={{ color: 'var(--color-zf-teal)' }}>Flow</span></h1>
            <p className="text-[11px] uppercase tracking-widest text-zinc-500 mt-0.5">Inteligência Operacional</p>
            <p className="text-zinc-400 mt-2">
               {view === 'register' && 'Crie sua conta para começar'}
               {view === 'login' && 'Faça login na sua conta'}
               {view === 'forgot' && 'Recuperar Senha'}
               {view === 'reset' && 'Redefinir Senha'}
               {view === 'plans' && 'Escolha seu plano e comece o teste grátis'}
               {view === 'solo' && soloStep === 'form' && 'Cadastro do assistente FalaTu'}
               {view === 'solo' && soloStep === 'qr' && 'Conecte seu WhatsApp'}
               {view === 'solo' && soloStep === 'connecting' && 'Tudo pronto!'}
            </p>
          </div>

          {error && (
             <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm text-center">
               {error}
             </div>
          )}

          {success && (
             <div className="mb-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm text-center">
               {success}
             </div>
          )}

          {view === 'plans' && (
            <div className="space-y-3">
              {plans.length === 0 && <p className="text-sm text-zinc-500 text-center">Carregando planos…</p>}
              {plans.filter(p => p.id !== 'cortesia').map(p => {
                const f = p.features || {};
                return (
                  <button key={p.id} type="button"
                    onClick={() => { setPlanId(p.id); setView('register'); }}
                    className="w-full text-left rounded-xl border border-zinc-800 bg-zinc-950 p-4 hover:border-indigo-500/60 transition-colors">
                    <div className="flex items-baseline justify-between">
                      <span className="font-semibold text-zinc-100">{p.name}</span>
                      <span className="text-zinc-100 font-bold">{brl(p.price)}<span className="text-xs font-normal text-zinc-500">/mês</span></span>
                    </div>
                    <div className="text-xs text-zinc-500 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      {f.ai_monthly_limit ? <span>{Number(f.ai_monthly_limit).toLocaleString('pt-BR')} respostas IA/mês</span> : null}
                      {f.contacts_limit ? <span>{Number(f.contacts_limit).toLocaleString('pt-BR')} contatos</span> : null}
                      {f.users_limit ? <span>{f.users_limit} usuários</span> : null}
                      {f.trial_days ? <span className="text-emerald-400">{f.trial_days} dias grátis</span> : null}
                    </div>
                  </button>
                );
              })}
              <p className="text-xs text-zinc-500 text-center pt-1">Sem cartão para começar — você só decide na hora de assinar.</p>
            </div>
          )}

          {view === 'solo' && soloStep === 'form' && (
            <form onSubmit={soloMode === 'register' ? handleSoloRegister : handleSoloLogin} className="space-y-4">
              <div className="mb-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-300">
                <div className="flex items-center gap-2 font-medium">
                  <Smartphone className="w-4 h-4" /> FalaTu — seu assistente pessoal
                </div>
                <p className="text-xs text-emerald-400/80 mt-1">
                  Fale, fotografe ou digite. Ele registra pra você e responde no seu WhatsApp.
                </p>
              </div>

              {/* F2.1c — quando o backend devolveu 409 email_in_use, mostramos
                  ação contextual em vez do erro genérico vermelho. */}
              {soloFalatuInPlan !== null && (
                <div className="mb-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm">
                  <p className="text-amber-200 font-medium mb-2">Este email já tem conta ZappFlow</p>
                  {soloFalatuInPlan ? (
                    <>
                      <p className="text-xs text-amber-100/80 mb-2">O FalaTu já está no seu plano. É só fazer login.</p>
                      <button type="button" onClick={() => { setSoloMode('login'); setSoloFalatuInPlan(null); setError(''); }}
                        className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm py-2">
                        Fazer login →
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-xs text-amber-100/80 mb-2">Pra usar o FalaTu, adicione ao seu plano atual (não crie uma segunda conta).</p>
                      <button type="button" onClick={() => setView('login')}
                        className="w-full rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm py-2">
                        Ir para meu login (upgrade lá dentro)
                      </button>
                    </>
                  )}
                </div>
              )}

              {soloMode === 'register' && (
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">Nome completo</label>
                  <input type="text" required value={name} onChange={e => setName(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                    placeholder="Seu nome" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Email</label>
                <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  placeholder="voce@exemplo.com" />
              </div>
              {soloMode === 'register' && (
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">Telefone WhatsApp (opcional)</label>
                  <input type="text" value={phone} onChange={e => setPhone(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                    placeholder="+55 11 99999-9999" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Senha</label>
                <div className="relative">
                  <input type={showPassword ? 'text' : 'password'} required value={password} onChange={e => setPassword(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 pr-10 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                    placeholder={soloMode === 'register' ? 'Mínimo 8 caracteres, letras e números' : 'Sua senha'} />
                  <button type="button" onClick={() => setShowPassword(s => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    tabIndex={-1} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <Button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white mt-4">
                {loading
                  ? (soloMode === 'register' ? 'Criando conta…' : 'Entrando…')
                  : (soloMode === 'register' ? 'Continuar → conectar WhatsApp' : 'Entrar no FalaTu')}
              </Button>

              {/* F2.1c — toggle explícito entre cadastro e login DENTRO da view solo,
                  evita loop "email in use" (usuário volta pela URL, cai no cadastro,
                  descobre que já tem conta, tem que ir pro login normal — chato). */}
              <div className="text-center pt-1">
                {soloMode === 'register' ? (
                  <button type="button" onClick={() => { setSoloMode('login'); setError(''); setSoloFalatuInPlan(null); }}
                    className="text-xs text-emerald-400 hover:text-emerald-300 underline">
                    Já tem conta FalaTu? Fazer login
                  </button>
                ) : (
                  <button type="button" onClick={() => { setSoloMode('register'); setError(''); setSoloFalatuInPlan(null); }}
                    className="text-xs text-zinc-400 hover:text-zinc-300 underline">
                    Não tem conta? Criar agora
                  </button>
                )}
              </div>
            </form>
          )}

          {view === 'solo' && soloStep === 'qr' && (
            <div className="space-y-4 text-center">
              <div className="mb-1 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-300 text-left">
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="w-4 h-4" /> Conta criada
                </div>
                <p className="text-xs text-emerald-400/80 mt-1">
                  Agora conecte o WhatsApp que o FalaTu vai usar pra falar com você.
                </p>
              </div>
              {soloQr ? (
                <div className="bg-white rounded-xl p-4 inline-block mx-auto">
                  <img src={`data:image/png;base64,${soloQr}`} alt="QR do WhatsApp" className="w-64 h-64" />
                </div>
              ) : (
                <div className="w-64 h-64 mx-auto rounded-xl border border-dashed border-zinc-700 bg-zinc-950 flex items-center justify-center text-zinc-500 text-sm">
                  QR indisponível — gere abaixo
                </div>
              )}
              <ol className="text-left text-xs text-zinc-400 space-y-1 max-w-xs mx-auto">
                <li>1. Abra o WhatsApp no celular</li>
                <li>2. <b>Menu → Aparelhos conectados → Conectar aparelho</b></li>
                <li>3. Aponte a câmera pro QR acima</li>
              </ol>
              <div className="flex flex-col gap-2 items-center pt-1">
                <button type="button" onClick={handleReprovision} disabled={soloReprovisioning}
                  className="text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1 disabled:opacity-50">
                  <RefreshCw className={`w-3 h-3 ${soloReprovisioning ? 'animate-spin' : ''}`} />
                  {soloReprovisioning ? 'Gerando…' : soloQr ? 'Gerar QR novamente' : 'Gerar QR agora'}
                </button>
                <p className="text-[11px] text-zinc-500">
                  Aguardando conexão… {soloElapsed > 0 ? `(${soloElapsed}s)` : ''}
                </p>
              </div>
            </div>
          )}

          {view === 'solo' && soloStep === 'connecting' && (
            <div className="text-center py-8">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
              <p className="text-zinc-200 font-medium">WhatsApp conectado!</p>
              <p className="text-xs text-zinc-500 mt-1">Abrindo seu FalaTu…</p>
            </div>
          )}

          {view !== 'plans' && view !== 'solo' && (
          <form onSubmit={handleSubmit} className="space-y-4">
             {view === 'register' && (
                <>
                  {!orgInviteToken && !hasInvite && selectedPlan && (
                    <div className="mb-4 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-sm text-indigo-300 flex items-center justify-between gap-2">
                      <span>Plano <b className="text-indigo-200">{selectedPlan.name}</b>{selectedPlan.features?.trial_days ? ` · ${selectedPlan.features.trial_days} dias grátis` : ''}</span>
                      <button type="button" onClick={() => setView('plans')} className="text-xs text-indigo-400 hover:text-indigo-300 underline shrink-0">trocar</button>
                    </div>
                  )}
                  {orgInviteToken && orgInviteInfo ? (
                    <div className="mb-4 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-300">
                      🎉 Você foi convidado para criar a empresa <b className="text-emerald-200">{orgInviteInfo.businessName || 'sua empresa'}</b> no ZappFlow.
                      <div className="text-xs text-emerald-400/80 mt-1">
                        Plano: <b>{orgInviteInfo.planName}</b>{orgInviteInfo.modules?.length ? ` · ${orgInviteInfo.modules.length} módulo(s) liberado(s)` : ' · acesso completo'}. É só criar seu acesso abaixo.
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 mb-4">
                       <input type="checkbox" id="hasInvite" checked={hasInvite} onChange={e => setHasInvite(e.target.checked)} className="rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500" />
                       <label htmlFor="hasInvite" className="text-sm text-zinc-300 cursor-pointer">Recebi um código de convite</label>
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-1">Nome Completo</label>
                    <input
                      type="text" required value={name} onChange={e => setName(e.target.value)}
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                      placeholder="Jane Doe"
                    />
                  </div>

                  {orgInviteToken ? (
                    <div>
                      <label className="block text-sm font-medium text-zinc-300 mb-1">Nome da Empresa</label>
                      <input
                        type="text" required value={organizationName} onChange={e => setOrganizationName(e.target.value)}
                        className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                        placeholder="Minha Empresa Ltda"
                      />
                    </div>
                  ) : hasInvite ? (
                    <div>
                      <label className="block text-sm font-medium text-zinc-300 mb-1">Código do Convite</label>
                      <input 
                        type="text" required value={inviteToken} onChange={e => setInviteToken(e.target.value)}
                        className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                        placeholder="Cole o código recebido"
                      />
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1">Nome da Empresa</label>
                        <input 
                          type="text" required={!hasInvite} value={organizationName} onChange={e => setOrganizationName(e.target.value)}
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                          placeholder="Minha Empresa Ltda"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1">Ramo do negócio</label>
                        <select
                          value={vertical} onChange={e => setVertical(e.target.value)}
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                        >
                          <option value="">Selecione o ramo…</option>
                          {verticals.map((v: any) => (
                            <option key={v.key} value={v.key}>{v.icon ? `${v.icon} ` : ''}{v.label}</option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-zinc-500">Já deixa o ZapFlow configurado para o seu tipo de negócio — sem passo extra depois.</p>
                      </div>

                      {/* Bundle recomendado pro ramo (ADR-153 F2.2): quando o ramo
                          tem um módulo central de tier alto (Clínica/Advocacia/
                          Escola), o bundle Growth+add-on desbloqueia esse módulo
                          já no cadastro — senão a tela da vertical não apareceria. */}
                      {recommendedBundle && (
                        <button
                          type="button"
                          onClick={() => setBundleKey(bundleKey === recommendedBundle.key ? '' : recommendedBundle.key)}
                          className={`w-full text-left rounded-md border p-3 transition-colors ${bundleKey === recommendedBundle.key ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-950 hover:border-emerald-500/50'}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-emerald-300">🎯 Recomendado: {recommendedBundle.name}</span>
                            {bundleKey === recommendedBundle.key && <span className="text-emerald-400">✓</span>}
                          </div>
                          <p className="mt-0.5 text-xs text-zinc-400">
                            {brl(recommendedBundle.priceMonthly)}/mês
                            {recommendedBundle.bundleDiscount?.savingsPercent ? ` · economia de ${recommendedBundle.bundleDiscount.savingsPercent}%` : ''}
                            {' '}— já habilita a tela completa do seu ramo.
                          </p>
                        </button>
                      )}
                      <div>
                        <label className="block text-sm font-medium text-zinc-300 mb-1">Tamanho da Empresa</label>
                        <select 
                          value={sizeRange} onChange={e => setSizeRange(e.target.value)}
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                        >
                          <option value="">Selecione...</option>
                          <option value="1-5">1 a 5 funcionários</option>
                          <option value="6-20">6 a 20 funcionários</option>
                          <option value="21-50">21 a 50 funcionários</option>
                          <option value="50+">Mais de 50 funcionários</option>
                        </select>
                      </div>
                    </>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-1">Telefone (Opcional)</label>
                    <input 
                      type="text" value={phone} onChange={e => setPhone(e.target.value)}
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                      placeholder="(11) 99999-9999"
                    />
                  </div>
                </>
             )}

             {view === 'reset' && (
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">Token recebido</label>
                  <input 
                    type="text" required value={token} onChange={e => setToken(e.target.value)}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  />
                </div>
             )}

             <div>
               <label className="block text-sm font-medium text-zinc-300 mb-1">Email</label>
               <input 
                 type="email" required value={email} onChange={e => setEmail(e.target.value)}
                 className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                 placeholder="jane@example.com"
               />
             </div>
             
             {view !== 'forgot' && !mfaRequired && (
               <div>
                 <label className="block text-sm font-medium text-zinc-300 mb-1">
                   {view === 'reset' ? 'Nova Senha' : 'Senha'}
                 </label>
                 <div className="relative">
                   <input
                     type={showPassword ? 'text' : 'password'} required value={password} onChange={e => setPassword(e.target.value)}
                     className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 pr-10 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                     placeholder="••••••••"
                   />
                   <button
                     type="button"
                     onClick={() => setShowPassword(s => !s)}
                     className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                     tabIndex={-1}
                     aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                   >
                     {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                   </button>
                 </div>
               </div>
             )}

             {view === 'login' && mfaRequired && (
               <div>
                 <label className="block text-sm font-medium text-zinc-300 mb-1">Código de verificação (2FA)</label>
                 <input
                   type="text" inputMode="numeric" autoComplete="one-time-code" required value={mfaCode}
                   onChange={e => setMfaCode(e.target.value)}
                   className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-center text-lg tracking-widest text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                   placeholder="000000" autoFocus
                 />
                 <p className="text-xs text-zinc-500 mt-1">Abra seu app autenticador (ou use um código de backup).</p>
               </div>
             )}

             <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white mt-6">
                {loading ? 'Processando...' :
                  view === 'register' ? 'Criar Conta' :
                  view === 'login' ? (mfaRequired ? 'Verificar' : 'Entrar') :
                  view === 'forgot' ? 'Enviar' :
                  'Redefinir'}
             </Button>
          </form>
          )}

          <div className="mt-6 flex flex-col items-center gap-3">
             {view === 'login' && (
               <>
                 <button onClick={() => setView('forgot')} className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                   Esqueci minha senha
                 </button>
                 <button onClick={() => setView('plans')} className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors font-medium">
                   Ver planos e começar grátis
                 </button>
                 <button onClick={() => setView('register')} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                   Não tem conta? Registre-se agora
                 </button>
               </>
             )}
             {view === 'register' && (
                 <button onClick={() => setView('login')} className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors">
                   Já tem uma conta? Faça login
                 </button>
             )}
             {view === 'plans' && (
                 <button onClick={() => setView('login')} className="text-sm text-zinc-400 hover:text-zinc-300 transition-colors">
                   Voltar para o login
                 </button>
             )}
             {(view === 'forgot' || view === 'reset') && (
                 <button onClick={() => setView('login')} className="text-sm text-zinc-400 hover:text-zinc-300 transition-colors">
                   Voltar para o login
                 </button>
             )}
             {view === 'solo' && soloStep === 'qr' && (
                 // F2.1c — antes: "Voltar para o login" saía da view solo pro
                 // login do ZappFlow (confuso). Agora limpa só o QR e volta pro
                 // form da mesma view solo — usuário decide se quer tentar
                 // outro cadastro OU logar naquela mesma tela.
                 <button onClick={() => { setSoloStep('form'); setSoloQr(''); setSoloToken(''); setSoloUser(null); setSoloOrgId(''); setSoloElapsed(0); setError(''); }}
                   className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                   Cancelar
                 </button>
             )}
             {view === 'solo' && soloStep === 'form' && (
                 <button onClick={() => { setView('login'); setSoloStep('form'); setSoloQr(''); setSoloToken(''); setError(''); setSoloFalatuInPlan(null); }}
                   className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                   Voltar para o login do ZappFlow
                 </button>
             )}
          </div>
       </div>
    </div>
  );
}
