import React, { useState, useEffect } from 'react';
import { useAuth } from '@/src/contexts/AuthContext';
import { Button } from '@/src/components/ui/button';
import { Eye, EyeOff } from 'lucide-react';

export function LoginView() {
  const { login } = useAuth();
  const [view, setView] = useState<'login' | 'register' | 'forgot' | 'reset'>('login');
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [phone, setPhone] = useState('');
  const [segment, setSegment] = useState('');
  const [sizeRange, setSizeRange] = useState('');
  const [token, setToken] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [hasInvite, setHasInvite] = useState(false);
  
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Link de convite: ?invite=TOKEN&email=... abre o cadastro já preenchido.
  // (o app não envia e-mail, então o owner compartilha esse link manualmente)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const invite = params.get('invite') || params.get('token');
      const inviteEmail = params.get('email');
      if (invite) {
        setView('register');
        setHasInvite(true);
        setInviteToken(invite);
        if (inviteEmail) setEmail(inviteEmail);
        // Limpa a URL para não deixar o código exposto no histórico/barra.
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch { /* noop */ }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      if (view === 'register') {
        const payload: any = { name, email, password, phone };
        if (hasInvite) {
          payload.inviteToken = inviteToken;
        } else {
          payload.organizationName = organizationName;
          payload.segment = segment;
          payload.sizeRange = sizeRange;
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
          body: JSON.stringify({ email, password })
        });
        const data = await res.json();
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
            <h1 className="text-2xl font-bold text-zinc-100">Zappflow AI</h1>
            <p className="text-zinc-400 mt-2">
               {view === 'register' && 'Crie sua conta para começar'}
               {view === 'login' && 'Faça login na sua conta'}
               {view === 'forgot' && 'Recuperar Senha'}
               {view === 'reset' && 'Redefinir Senha'}
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

          <form onSubmit={handleSubmit} className="space-y-4">
             {view === 'register' && (
                <>
                  <div className="flex items-center gap-2 mb-4">
                     <input type="checkbox" id="hasInvite" checked={hasInvite} onChange={e => setHasInvite(e.target.checked)} className="rounded border-zinc-800 bg-zinc-950 text-indigo-600 focus:ring-indigo-500" />
                     <label htmlFor="hasInvite" className="text-sm text-zinc-300 cursor-pointer">Recebi um código de convite</label>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-zinc-300 mb-1">Nome Completo</label>
                    <input 
                      type="text" required value={name} onChange={e => setName(e.target.value)}
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                      placeholder="Jane Doe"
                    />
                  </div>
                  
                  {hasInvite ? (
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
                        <label className="block text-sm font-medium text-zinc-300 mb-1">Segmento</label>
                        <input 
                          type="text" value={segment} onChange={e => setSegment(e.target.value)}
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                          placeholder="Ex: Varejo, Serviços..."
                        />
                      </div>
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
             
             {view !== 'forgot' && (
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

             <Button type="submit" disabled={loading} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white mt-6">
                {loading ? 'Processando...' : 
                  view === 'register' ? 'Criar Conta' : 
                  view === 'login' ? 'Entrar' : 
                  view === 'forgot' ? 'Enviar' : 
                  'Redefinir'}
             </Button>
          </form>

          <div className="mt-6 flex flex-col items-center gap-3">
             {view === 'login' && (
               <>
                 <button onClick={() => setView('forgot')} className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
                   Esqueci minha senha
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
             {(view === 'forgot' || view === 'reset') && (
                 <button onClick={() => setView('login')} className="text-sm text-zinc-400 hover:text-zinc-300 transition-colors">
                   Voltar para o login
                 </button>
             )}
          </div>
       </div>
    </div>
  );
}
