import React, { useState } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { Eye, EyeOff, Sun, Moon } from 'lucide-react';
import { FalatuLogo } from '@/src/components/brand/FalatuLogo';
import type { FalatuTheme } from './useFalatuTheme';

// ADR-154 F7.1 — tela de auth do app FalaTu STANDALONE (subdomínio dedicado).
//
// Diferente do LoginView do ZappFlow: aqui NÃO existe suíte, master admin,
// nem `?solo=` — o app inteiro É o FalaTu. O login default é o do FalaTu.
//
// Isolamento de sessão: como este bundle roda em origem própria
// (falatu.tesseractauto.com.br), o localStorage é isolado pelo navegador da
// origem do ZappFlow. A sessão do painel NUNCA colide aqui — o bug de
// "sessão fantasma" da F2.1c não existe por construção.
//
// Diferença de fluxo importante vs. F6.1/F2.1c: aqui, ao cadastrar/logar,
// chamamos context.login() IMEDIATAMENTE (persiste a sessão), sem esperar o
// WhatsApp conectar. Não há suíte pra proteger de "cadastro-fantasma"; e
// persistir já resolve o problema do refresh cair no login. Quem decide se
// mostra QR ou app é o FalatuApp, checando o status do WhatsApp.
//
// F9.1 — identidade oficial: logo Ciclo Inteligente + paleta Cobalto/Ink/Nuvem
// (tokens --color-ft-*), no lugar do ícone/emerald placeholder.

type Mode = 'login' | 'register';

export function FalatuAuth({ blueprintKey = 'falatu_solo', theme, onToggleTheme }: {
  blueprintKey?: string; theme?: FalatuTheme; onToggleTheme?: () => void;
}) {
  const { login } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const doLogin = async (mail: string, pass: string) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: mail, password: pass }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Email ou senha inválidos');
    login(d.token, d.user); // persiste na origem do FalaTu — FalatuApp reavalia
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      if (mode === 'register') {
        const r = await fetch('/api/onboarding-solo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, phone, password, blueprintKey }),
        });
        const d = await r.json();
        if (!r.ok) {
          // 409 email_in_use: oferece login em vez de erro cru.
          if (r.status === 409 && d?.error === 'email_in_use') {
            setMode('login');
            setError('Este email já tem conta FalaTu. Faça login abaixo.');
            setLoading(false);
            return;
          }
          throw new Error(d.error || 'Erro no cadastro');
        }
        // Cadastro OK → loga na hora (mesmo email/senha que acabou de criar).
        await doLogin(email, password);
      } else {
        await doLogin(email, password);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Campos e botões usam a paleta oficial via tokens --color-ft-* (Cobalto é a
  // cor de ação/primária no app; Ink as superfícies; Nuvem o texto).
  const inputCls =
    'w-full rounded-md border px-3 py-2 text-[var(--color-ft-text)] placeholder:text-[var(--color-ft-text-muted)] focus:outline-none focus:ring-1';

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative" style={{ background: 'var(--color-ft-bg)' }}>
      {onToggleTheme && (
        <button type="button" onClick={onToggleTheme}
          className="absolute top-4 right-4 inline-flex items-center justify-center w-9 h-9 rounded-lg text-[var(--color-ft-text-muted)] hover:text-[var(--color-ft-text)] hover:bg-ft-surface-2 transition-colors"
          title={theme === 'dark' ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'}
          aria-label={theme === 'dark' ? 'Mudar para o modo claro' : 'Mudar para o modo escuro'}>
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      )}
      <div
        className="w-full max-w-md rounded-2xl shadow-2xl p-8"
        style={{ background: 'var(--color-ft-surface)', border: '1px solid var(--color-ft-border)' }}
      >
        <div className="flex flex-col items-center text-center mb-6">
          <FalatuLogo size={56} tile withWordmark withTagline />
          <p className="mt-4 text-sm" style={{ color: 'var(--color-ft-text-muted)' }}>
            {mode === 'register' ? 'Crie sua conta e comece falando' : 'Entre na sua conta'}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-ft-on-amber text-sm text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-ft-text)' }}>Nome completo</label>
              <input type="text" required value={name} onChange={e => setName(e.target.value)}
                className={inputCls}
                style={{ background: 'var(--color-ft-bg)', borderColor: 'var(--color-ft-border)', ['--tw-ring-color' as any]: 'var(--color-ft-cobalto)' }}
                placeholder="Seu nome" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-ft-text)' }}>Email</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
              className={inputCls}
              style={{ background: 'var(--color-ft-bg)', borderColor: 'var(--color-ft-border)', ['--tw-ring-color' as any]: 'var(--color-ft-cobalto)' }}
              placeholder="voce@exemplo.com" />
          </div>
          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-ft-text)' }}>Telefone WhatsApp (opcional)</label>
              <input type="text" value={phone} onChange={e => setPhone(e.target.value)}
                className={inputCls}
                style={{ background: 'var(--color-ft-bg)', borderColor: 'var(--color-ft-border)', ['--tw-ring-color' as any]: 'var(--color-ft-cobalto)' }}
                placeholder="+55 11 99999-9999" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-ft-text)' }}>Senha</label>
            <div className="relative">
              <input type={showPassword ? 'text' : 'password'} required value={password} onChange={e => setPassword(e.target.value)}
                className={`${inputCls} pr-10`}
                style={{ background: 'var(--color-ft-bg)', borderColor: 'var(--color-ft-border)', ['--tw-ring-color' as any]: 'var(--color-ft-cobalto)' }}
                placeholder={mode === 'register' ? 'Mínimo 8 caracteres, letras e números' : 'Sua senha'} />
              <button type="button" onClick={() => setShowPassword(s => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-ft-text-muted)] hover:text-[var(--color-ft-text)]"
                tabIndex={-1} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <button type="submit" disabled={loading}
            className="w-full rounded-md text-white py-2.5 font-semibold transition-colors disabled:opacity-60 hover:brightness-110"
            style={{ background: 'var(--color-ft-cobalto)' }}>
            {loading
              ? (mode === 'register' ? 'Criando conta…' : 'Entrando…')
              : (mode === 'register' ? 'Criar conta' : 'Entrar')}
          </button>
        </form>

        <div className="mt-5 text-center">
          {mode === 'login' ? (
            <button onClick={() => { setMode('register'); setError(''); }}
              className="text-sm font-medium hover:brightness-110" style={{ color: 'var(--color-ft-cobalto)' }}>
              Não tem conta? Criar agora
            </button>
          ) : (
            <button onClick={() => { setMode('login'); setError(''); }}
              className="text-sm hover:brightness-110" style={{ color: 'var(--color-ft-text-muted)' }}>
              Já tem conta? Fazer login
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
