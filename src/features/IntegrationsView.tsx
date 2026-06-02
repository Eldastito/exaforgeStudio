import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, signInWithRedirect, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { HardDrive, Webhook as WebhookIcon, Link2, Plus, Download, RefreshCw, X, Play, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

let app;
try {
  app = initializeApp(firebaseConfig);
} catch (e: any) {
  // If already initialized
}
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.addScope('https://www.googleapis.com/auth/calendar.events');
provider.addScope('https://www.googleapis.com/auth/spreadsheets');
provider.addScope('https://www.googleapis.com/auth/gmail.send');

// Traduz os erros mais comuns do Firebase Auth para uma mensagem acionável.
function explainAuthError(err: any): string {
  const code = err?.code || '';
  switch (code) {
    case 'auth/unauthorized-domain':
      return `Este domínio (${window.location.hostname}) não está autorizado no Firebase. Vá em Firebase Console → Authentication → Settings → Authorized domains e adicione "${window.location.hostname}".`;
    case 'auth/operation-not-allowed':
      return 'O provedor Google não está habilitado. Ative em Firebase Console → Authentication → Sign-in method → Google.';
    case 'auth/popup-blocked':
      return 'O navegador bloqueou o popup. Permita popups para este site e tente de novo (vamos tentar via redirecionamento).';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'A janela de login foi fechada antes de concluir. Tente novamente.';
    case 'auth/configuration-not-found':
      return 'Configuração de Authentication não encontrada no projeto Firebase. Habilite o Google Sign-in no console.';
    default:
      return `Não foi possível conectar ao Google${code ? ` (${code})` : ''}: ${err?.message || 'erro desconhecido'}. ` +
        'Se os escopos (Drive/Calendar/Sheets/Gmail) ainda não passaram pela verificação do Google, só "usuários de teste" conseguem entrar.';
  }
}

export function IntegrationsView() {
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [webhooks, setWebhooks] = useState<any[]>([]);
  const [backups, setBackups] = useState<any[]>([]);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [webhookForm, setWebhookForm] = useState({ name: '', url: '', secret: '' });
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  const loadData = () => {
    apiFetch('/api/integrations/webhooks').then(r => r.json()).then(d => setWebhooks(Array.isArray(d) ? d : [])).catch(console.error);
    apiFetch('/api/integrations/backups').then(r => r.json()).then(d => setBackups(Array.isArray(d) ? d : [])).catch(console.error);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setGoogleUser(user);
    });
    loadData();
    const interval = setInterval(loadData, 5000); // Polling for backup status
    return () => { unsub(); clearInterval(interval); };
  }, []);

  const handleGoogleSignIn = async () => {
    setGoogleError(null);
    try {
      await signInWithPopup(auth, provider);
    } catch (e: any) {
      console.error('[GoogleLogin]', e?.code, e?.message);
      // Popup bloqueado/fechado: tenta o fluxo por redirecionamento (mais robusto).
      if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/cancelled-popup-request') {
        try { await signInWithRedirect(auth, provider); return; } catch (e2: any) {
          setGoogleError(explainAuthError(e2));
          return;
        }
      }
      setGoogleError(explainAuthError(e));
    }
  };

  const handleGoogleSignOut = async () => {
    await auth.signOut();
  };

  const handleGenerateBackup = async () => {
    setIsBackingUp(true);
    try {
      await apiFetch('/api/integrations/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'manual' })
      });
      loadData();
    } catch (e) {} finally {
      setIsBackingUp(false);
    }
  };

  // Download autenticado: apiFetch adiciona o Bearer; baixa via blob (window.location
  // não enviava o token, então o download retornava 401).
  const handleDownloadBackup = async (id: string) => {
    try {
      const res = await apiFetch(`/api/integrations/backups/${id}/download`);
      if (!res.ok) { toast.error('Não foi possível baixar o backup.'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `backup-${id}.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error('Não foi possível baixar o backup.'); }
  };

  const handleDeleteBackup = async (id: string) => {
    if (!(await confirmDialog('Apagar este backup? Esta ação é permanente.', { danger: true, confirmText: 'Excluir' }))) return;
    try {
      await apiFetch(`/api/integrations/backups/${id}`, { method: 'DELETE' });
      loadData();
    } catch (e) {}
  };

  const handleAddWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/integrations/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookForm)
      });
      setShowWebhookModal(false);
      setWebhookForm({ name: '', url: '', secret: '' });
      loadData();
    } catch(e) {}
  };

  const handleTestWebhook = async (id: string) => {
    try {
      const res = await apiFetch(`/api/integrations/webhooks/${id}/test`, { method: 'POST' });
      const data = await res.json();
      toast.info(`Webhook teste: ${data.status}`);
      loadData();
    } catch (e) {}
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
          <Link2 className="w-6 h-6 text-fuchsia-400" />
          Integrações e Backups
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Gerencie integrações com Google e Webhooks</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Google Integration Card */}
        <div className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/50 flex flex-col gap-4">
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-3">
               <HardDrive className="w-6 h-6 text-blue-400" />
               <div>
                  <h3 className="font-semibold text-zinc-100">Google Workspace</h3>
                  <p className="text-sm text-zinc-400">Drive, Calendar, Sheets, Gmail</p>
               </div>
             </div>
             <div>
                {googleUser ? (
                  <span className="text-xs font-semibold px-2 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded">Conectado</span>
                ) : (
                  <span className="text-xs font-semibold px-2 py-1 bg-zinc-800 text-zinc-400 rounded">Desconectado</span>
                )}
             </div>
          </div>
          
          <div className="flex-1 mt-4">
            {googleUser ? (
               <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                     <img src={googleUser.photoURL || ''} alt="User" className="w-8 h-8 rounded-full" />
                     <div className="flex-1 text-sm">
                        <p className="text-zinc-100">{googleUser.displayName}</p>
                        <p className="text-zinc-500">{googleUser.email}</p>
                     </div>
                     <Button variant="ghost" size="sm" onClick={handleGoogleSignOut} className="text-rose-400 hover:text-rose-300">Desconectar</Button>
                  </div>
                  <p className="text-xs text-zinc-500 text-center">
                    Conexão usada para Drive, Calendar, Sheets e Gmail (em desenvolvimento).
                  </p>
               </div>
            ) : (
               <div className="flex flex-col items-center justify-center p-6 bg-zinc-950 rounded-lg border border-zinc-800 h-full">
                  <button className="gsi-material-button w-full max-w-[240px]" onClick={handleGoogleSignIn}>
                    <div className="gsi-material-button-state"></div>
                    <div className="gsi-material-button-content-wrapper flex items-center justify-center py-2 px-4 bg-white text-black rounded-sm shadow-sm font-roboto border border-zinc-200">
                      <div className="gsi-material-button-icon mr-3">
                        <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" xmlnsXlink="http://www.w3.org/1999/xlink" style={{display: 'block', width: '18px', height: '18px'}}>
                          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                          <path fill="none" d="M0 0h48v48H0z"></path>
                        </svg>
                      </div>
                      <span className="text-sm font-medium">Sign in with Google</span>
                    </div>
                  </button>
                  <p className="text-xs text-zinc-500 mt-4 text-center">Necessário para agenda, e-mail e mais serviços do Google.</p>
                  {googleError && (
                    <div className="mt-4 w-full rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-rose-200/90">{googleError}</p>
                    </div>
                  )}
               </div>
            )}
          </div>
        </div>

        {/* Webhooks Card */}
        <div className="p-6 rounded-xl border border-zinc-800 bg-zinc-900/50 flex flex-col gap-4">
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-3">
               <WebhookIcon className="w-6 h-6 text-fuchsia-400" />
               <div>
                  <h3 className="font-semibold text-zinc-100">Webhooks</h3>
                  <p className="text-sm text-zinc-400">Endpoints para envio de eventos</p>
               </div>
             </div>
             <Button size="sm" className="bg-fuchsia-600 hover:bg-fuchsia-700" onClick={() => setShowWebhookModal(true)}>
               <Plus className="w-4 h-4 mr-2" /> Novo
             </Button>
          </div>

          <div className="flex-1 mt-4 space-y-3 overflow-auto max-h-[300px] pr-2">
            {webhooks.length === 0 ? (
               <p className="text-sm text-zinc-500 text-center py-4">Nenhum webhook configurado</p>
            ) : (
               webhooks.map(wh => (
                 <div key={wh.id} className="p-3 bg-zinc-950 rounded-lg border border-zinc-800 flex justify-between items-center group">
                    <div>
                       <p className="text-sm font-medium text-zinc-200">{wh.name}</p>
                       <p className="text-xs text-zinc-500 truncate max-w-[200px]">{wh.url}</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => handleTestWebhook(wh.id)} className="opacity-0 group-hover:opacity-100">
                       <Play className="w-4 h-4 text-indigo-400" />
                    </Button>
                 </div>
               ))
            )}
          </div>
        </div>
      </div>

      {/* Backups do Banco (real, sem dependência do Google) */}
      <div className="mt-6 p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-zinc-100 flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-emerald-400" /> Backups da Conta
            </h3>
            <p className="text-sm text-zinc-400 mt-1">Snapshot completo dos seus dados em JSON. Fica em disco no servidor; você pode baixar a qualquer momento.</p>
          </div>
          <Button onClick={handleGenerateBackup} disabled={isBackingUp} className="bg-emerald-600 hover:bg-emerald-700">
            {isBackingUp ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <HardDrive className="w-4 h-4 mr-2" />}
            {isBackingUp ? 'Gerando...' : 'Gerar backup agora'}
          </Button>
        </div>

        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-start gap-2 mb-4">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-200/80">
            O arquivo contém dados sensíveis do seu negócio (contatos, conversas, pedidos). Guarde em local seguro depois de baixar.
          </p>
        </div>

        <div className="space-y-2">
          {backups.length === 0 ? (
            <p className="text-zinc-500 text-sm text-center py-6">Nenhum backup gerado ainda. Clique em "Gerar backup agora".</p>
          ) : backups.map(b => {
            const ready = b.status === 'completed' && b.file_url;
            const failed = b.status === 'failed';
            return (
              <div key={b.id} className="flex items-center justify-between gap-3 p-3 border border-zinc-800/50 rounded-lg text-sm bg-zinc-950/40 flex-wrap">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {ready ? <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
                    : failed ? <X className="w-4 h-4 text-rose-400 shrink-0" />
                    : <RefreshCw className="w-4 h-4 text-amber-400 animate-spin shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-zinc-200 capitalize truncate">{b.type || 'manual'} Backup</p>
                    <p className="text-xs text-zinc-500">{new Date(b.created_at).toLocaleString('pt-BR')}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {ready ? (
                    <span className="text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-1 rounded">Pronto</span>
                  ) : failed ? (
                    <span className="text-xs bg-rose-500/10 text-rose-400 border border-rose-500/20 px-2 py-1 rounded">Falhou</span>
                  ) : (
                    <span className="text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-1 rounded">Processando</span>
                  )}
                  {ready && (
                    <Button variant="ghost" size="sm" onClick={() => handleDownloadBackup(b.id)} className="h-7 px-2 text-indigo-300 hover:text-indigo-200" title="Baixar">
                      <Download className="w-4 h-4" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => handleDeleteBackup(b.id)} className="h-7 px-2 text-rose-400 hover:text-rose-300" title="Apagar">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showWebhookModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[400px]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100">Novo Webhook</h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => setShowWebhookModal(false)}><X className="w-5 h-5"/></button>
            </div>
            <form onSubmit={handleAddWebhook} className="space-y-4">
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Nome da Integração</label>
                <input required className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={webhookForm.name} onChange={(e) => setWebhookForm({...webhookForm, name: e.target.value})} placeholder="Ex: ERP Integrador" />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">URL do Endpoint</label>
                <input required type="url" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={webhookForm.url} onChange={(e) => setWebhookForm({...webhookForm, url: e.target.value})} placeholder="https://api.exemplo.com/hook" />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Secret (Assinatura JWT/HMAC)</label>
                <input className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={webhookForm.secret} onChange={(e) => setWebhookForm({...webhookForm, secret: e.target.value})} placeholder="Autogerado se vazio" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setShowWebhookModal(false)}>Cancelar</Button>
                <Button type="submit" variant="default" className="bg-fuchsia-600 hover:bg-fuchsia-700 text-white">Criar Webhook</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
