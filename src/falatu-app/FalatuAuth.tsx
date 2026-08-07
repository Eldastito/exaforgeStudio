import React, { useState } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { Eye, EyeOff, Smartphone } from 'lucide-react';

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

type Mode = 'login' | 'register';

export function FalatuAuth({ blueprintKey = 'falatu_solo' }: { blueprintKey?: string }) {
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl p-8">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 mb-3">
            <Smartphone className="w-6 h-6 text-emerald-300" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Fala<span className="text-emerald-400">Tu</span></h1>
          <p className="text-[11px] uppercase tracking-widest text-zinc-500 mt-0.5">Do pensamento para a vida</p>
          <p className="text-zinc-400 mt-2 text-sm">
            {mode === 'register' ? 'Crie sua conta e comece falando' : 'Entre na sua conta'}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">Nome completo</label>
              <input type="text" required value={name} onChange={e => setName(e.target.value)}
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                placeholder="Seu nome" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Email</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              placeholder="voce@exemplo.com" />
          </div>
          {mode === 'register' && (
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">Telefone WhatsApp (opcional)</label>
              <input type="text" value={phone} onChange={e => setPhone(e.target.value)}
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                placeholder="+55 11 99999-9999" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Senha</label>
            <div className="relative">
              <input type={showPassword ? 'text' : 'password'} required value={password} onChange={e => setPassword(e.target.value)}
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 pr-10 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                placeholder={mode === 'register' ? 'Mínimo 8 caracteres, letras e números' : 'Sua senha'} />
              <button type="button" onClick={() => setShowPassword(s => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                tabIndex={-1} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <button type="submit" disabled={loading}
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white py-2.5 font-medium transition-colors">
            {loading
              ? (mode === 'register' ? 'Criando conta…' : 'Entrando…')
              : (mode === 'register' ? 'Criar conta' : 'Entrar')}
          </button>
        </form>

        <div className="mt-5 text-center">
          {mode === 'login' ? (
            <button onClick={() => { setMode('register'); setError(''); }}
              className="text-sm text-emerald-400 hover:text-emerald-300">
              Não tem conta? Criar agora
            </button>
          ) : (
            <button onClick={() => { setMode('login'); setError(''); }}
              className="text-sm text-zinc-400 hover:text-zinc-300">
              Já tem conta? Fazer login
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
