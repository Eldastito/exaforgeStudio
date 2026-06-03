import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, signInWithRedirect, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { HardDrive, Webhook as WebhookIcon, Link2, Plus, Download, RefreshCw, X, Play, Trash2, AlertTriangle, ShieldCheck, Copy, Check } from 'lucide-react';
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
      return `Este domínio (${window.location.hostname}) não está autorizado no projeto Firebase "${(firebaseConfig as any).projectId}". ` +
        `ATENÇÃO: precisa ser exatamente esse projeto (${(firebaseConfig as any).projectId}), não outro. ` +
        `Abra https://console.firebase.google.com/project/${(firebaseConfig as any).projectId}/authentication/settings → Authorized domains → Add domain → "${window.location.hostname}".`;
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
  const [googleStatus, setGoogleStatus] = useState<{ configured: boolean; connected: boolean; email: string; name: string } | null>(null);
  const [driveBusy, setDriveBusy] = useState<string | null>(null);
  const [waWebhook, setWaWebhook] = useState<{ url: string; enforced: boolean; usingEnv: boolean } | null>(null);
  const [waCopied, setWaCopied] = useState(false);

  const loadGoogleStatus = () => {
    apiFetch('/api/integrations/google/status').then(r => r.json()).then(setGoogleStatus).catch(() => {});
  };
  const connectGoogle = async () => {
    setGoogleError(null);
    try {
      const d = await apiFetch('/api/integrations/google/login-url').then(r => r.json());
      if (d.url) { window.location.href = d.url; } else { setGoogleError(d.error || 'Integração Google não configurada no servidor.'); }
    } catch { setGoogleError('Não foi possível iniciar a conexão com o Google.'); }
  };
  const disconnectGoogle = async () => {
    if (!(await confirmDialog('Desconectar a conta Google?', { danger: true }))) return;
    try { await apiFetch('/api/integrations/google/disconnect', { method: 'POST' }); loadGoogleStatus(); } catch {}
  };
  const [sheetsBusy, setSheetsBusy] = useState<string | null>(null);
  const exportSheets = async (dataset: 'orders' | 'contacts') => {
    setSheetsBusy(dataset);
    try {
      const res = await apiFetch('/api/integrations/google/sheets/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao exportar.'); return; }
      toast.success(`Planilha criada (${d.count} linhas)! Abrindo...`);
      if (d.url) window.open(d.url, '_blank');
    } catch { toast.error('Falha ao exportar.'); }
    finally { setSheetsBusy(null); }
  };
  const sendBackupToDrive = async (id: string) => {
    setDriveBusy(id);
    try {
      const res = await apiFetch(`/api/integrations/backups/${id}/drive`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao enviar ao Drive.'); return; }
      toast.success('Backup enviado ao Google Drive! ✅');
    } catch { toast.error('Falha ao enviar ao Drive.'); }
    finally { setDriveBusy(null); }
  };

  const loadWaWebhook = () => {
    apiFetch('/api/integrations/whatsapp-webhook').then(r => r.json()).then(setWaWebhook).catch(() => {});
  };
  useEffect(() => { loadWaWebhook(); }, []);

  const copyWaUrl = () => {
    if (!waWebhook) return;
    navigator.clipboard?.writeText(waWebhook.url);
    setWaCopied(true); setTimeout(() => setWaCopied(false), 1800);
  };
  const toggleWaEnforce = async () => {
    if (!waWebhook) return;
    const next = !waWebhook.enforced;
    if (next && !window.confirm('Ativar a exigência do segredo? IMPORTANTE: só ative DEPOIS de colar a URL com ?secret=... na Evolution, senão as mensagens param de entrar. Continuar?')) return;
    try {
      const res = await apiFetch('/api/integrations/whatsapp-webhook/enforce', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Erro ao alterar.'); return; }
      toast.success(next ? 'Segredo do webhook EXIGIDO.' : 'Exigência desativada.');
      loadWaWebhook();
    } catch { toast.error('Erro ao alterar.'); }
  };
  const rotateWaSecret = async () => {
    if (!window.confirm('Gerar um novo segredo? A URL antiga deixa de valer; você terá que colar a nova na Evolution.')) return;
    try {
      const res = await apiFetch('/api/integrations/whatsapp-webhook/rotate', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Erro ao girar.'); return; }
      toast.success('Novo segredo gerado. Atualize a URL na Evolution.');
      loadWaWebhook();
    } catch { toast.error('Erro ao girar.'); }
  };

  const loadData = () => {
    apiFetch('/api/integrations/webhooks').then(r => r.json()).then(d => setWebhooks(Array.isArray(d) ? d : [])).catch(console.error);
    apiFetch('/api/integrations/backups').then(r => r.json()).then(d => setBackups(Array.isArray(d) ? d : [])).catch(console.error);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setGoogleUser(user);
    });
    loadData();
    loadGoogleStatus();
    // Retorno do callback OAuth do Google (?google=conectado|erro).
    try {
      const u = new URL(window.location.href);
      const g = u.searchParams.get('google');
      if (g) {
        if (g === 'conectado') toast.success('Google conectado! ✅'); else toast.error('Não foi possível conectar ao Google.');
        u.searchParams.delete('google');
        window.history.replaceState({}, '', u.pathname + u.search);
        loadGoogleStatus();
      }
    } catch {}
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

      {/* Segurança do Webhook do WhatsApp */}
      {waWebhook && (
        <div className="mb-6 p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <ShieldCheck className={`w-6 h-6 ${waWebhook.enforced ? 'text-emerald-400' : 'text-amber-400'}`} />
              <div>
                <h3 className="font-semibold text-zinc-100">Segurança do WhatsApp (Webhook)</h3>
                <p className="text-sm text-zinc-400">
                  {waWebhook.enforced
                    ? 'Protegido: o webhook exige o segredo. ✅'
                    : 'Aberto: qualquer um poderia chamar o webhook. Recomendado proteger.'}
                </p>
              </div>
            </div>
            {!waWebhook.usingEnv && (
              <button onClick={toggleWaEnforce}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${waWebhook.enforced ? 'bg-emerald-600' : 'bg-zinc-700'}`}
                title="Exigir o segredo no webhook">
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${waWebhook.enforced ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            )}
          </div>

          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <p className="text-xs text-zinc-400 mb-2">
              <strong className="text-zinc-200">Passo a passo:</strong> 1) copie a URL abaixo; 2) cole no campo de webhook da sua <strong>Evolution</strong> (substituindo a URL atual); 3) volte aqui e ative o interruptor.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-[11px] text-indigo-300 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 truncate">{waWebhook.url}</code>
              <button onClick={copyWaUrl} className="shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10">
                {waCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {waCopied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
            {!waWebhook.usingEnv ? (
              <button onClick={rotateWaSecret} className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300">Gerar novo segredo</button>
            ) : (
              <p className="mt-2 text-[11px] text-zinc-500">Segredo definido por variável de ambiente (sempre exigido).</p>
            )}
          </div>
        </div>
      )}

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
                {googleStatus?.connected ? (
                  <span className="text-xs font-semibold px-2 py-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded">Conectado</span>
                ) : (
                  <span className="text-xs font-semibold px-2 py-1 bg-zinc-800 text-zinc-400 rounded">Desconectado</span>
                )}
             </div>
          </div>
          
          <div className="flex-1 mt-4">
            {googleStatus?.connected ? (
               <div className="space-y-4">
                  <div className="flex items-center gap-3 p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                     <div className="flex items-center justify-center w-8 h-8 rounded-full bg-blue-500/20 text-blue-300 text-sm font-bold">
                       {(googleStatus.name || googleStatus.email || 'G').slice(0, 1).toUpperCase()}
                     </div>
                     <div className="flex-1 text-sm min-w-0">
                        <p className="text-zinc-100 truncate">{googleStatus.name || 'Conta Google'}</p>
                        <p className="text-zinc-500 truncate">{googleStatus.email}</p>
                     </div>
                     <Button variant="ghost" size="sm" onClick={disconnectGoogle} className="text-rose-400 hover:text-rose-300">Desconectar</Button>
                  </div>
                  <p className="text-xs text-emerald-400/80 text-center">
                    Conectado com acesso offline — a IA/servidor usa Drive e Agenda (e em breve Gmail e Sheets) mesmo com você offline. Agendamentos criados aqui viram eventos no seu Google Calendar.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => exportSheets('orders')} disabled={sheetsBusy === 'orders'} className="border-zinc-700 text-zinc-200">
                      {sheetsBusy === 'orders' ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Exportar pedidos p/ Sheets
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => exportSheets('contacts')} disabled={sheetsBusy === 'contacts'} className="border-zinc-700 text-zinc-200">
                      {sheetsBusy === 'contacts' ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Exportar contatos p/ Sheets
                    </Button>
                  </div>
               </div>
            ) : (
               <div className="flex flex-col items-center justify-center p-6 bg-zinc-950 rounded-lg border border-zinc-800 h-full">
                  <Button onClick={connectGoogle} className="bg-white text-black hover:bg-zinc-100">
                    Conectar conta Google
                  </Button>
                  <p className="text-xs text-zinc-500 mt-4 text-center">Necessário para Drive, Agenda, Gmail e Sheets (acesso server-side, offline).</p>
                  {googleStatus && !googleStatus.configured && (
                    <div className="mt-4 w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                      <p className="text-xs text-amber-200/90">Falta configurar no servidor: <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> e <code>APP_URL</code> (e cadastrar a URL de callback no Google Cloud).</p>
                    </div>
                  )}
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
                  {ready && googleStatus?.connected && (
                    <Button variant="ghost" size="sm" onClick={() => sendBackupToDrive(b.id)} disabled={driveBusy === b.id} className="h-7 px-2 text-blue-300 hover:text-blue-200" title="Salvar no Google Drive">
                      {driveBusy === b.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <HardDrive className="w-4 h-4" />}
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
