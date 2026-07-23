import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, signInWithRedirect, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { HardDrive, Webhook as WebhookIcon, Link2, Plus, Download, RefreshCw, X, Play, Trash2, AlertTriangle, ShieldCheck, Copy, Check, RotateCcw, Activity } from 'lucide-react';
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
  const [backupCfg, setBackupCfg] = useState<{ enabled: boolean; frequency: string; retention: number; toDrive: boolean; lastRun: string | null }>({ enabled: false, frequency: 'daily', retention: 30, toDrive: true, lastRun: null });
  const [savingBackupCfg, setSavingBackupCfg] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleStatus, setGoogleStatus] = useState<{ configured: boolean; connected: boolean; email: string; name: string } | null>(null);
  const [driveBusy, setDriveBusy] = useState<string | null>(null);
  const [waWebhook, setWaWebhook] = useState<{ url: string; enforced: boolean; usingEnv: boolean; lastHit?: { at: number; ok: boolean; reason: string } | null } | null>(null);
  const [waCopied, setWaCopied] = useState(false);

  const [auto, setAuto] = useState({ logOrders: false, emailAppointments: false, emailOrders: false, liveSync: false });
  const [syncLastRun, setSyncLastRun] = useState<string | null>(null);
  const loadGoogleStatus = () => {
    apiFetch('/api/integrations/google/status').then(r => r.json()).then(setGoogleStatus).catch(() => {});
    apiFetch('/api/integrations/google/automations').then(r => r.json()).then(d => { setAuto({ logOrders: !!d.logOrders, emailAppointments: !!d.emailAppointments, emailOrders: !!d.emailOrders, liveSync: !!d.syncEnabled }); setSyncLastRun(d.syncLastRun || null); }).catch(() => {});
  };
  const toggleAuto = async (key: 'logOrders' | 'emailAppointments' | 'emailOrders' | 'liveSync') => {
    const next = { ...auto, [key]: !auto[key] };
    setAuto(next);
    try {
      await apiFetch('/api/integrations/google/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: next[key] }) });
    } catch { setAuto(auto); toast.error('Erro ao salvar.'); }
  };
  const [syncBusy, setSyncBusy] = useState(false);
  const syncNow = async () => {
    setSyncBusy(true);
    try {
      const res = await apiFetch('/api/integrations/google/sheets/sync-now', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao sincronizar.'); return; }
      setAuto((a) => ({ ...a, liveSync: true }));
      setSyncLastRun(new Date().toISOString());
      toast.success('Painel sincronizado! Abrindo a planilha...');
      if (d.sheetUrl) window.open(d.sheetUrl, '_blank');
    } catch { toast.error('Falha ao sincronizar.'); }
    finally { setSyncBusy(false); }
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
  const exportSheets = async (dataset: 'orders' | 'contacts' | 'appointments' | 'summary') => {
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
  const [gmailBusy, setGmailBusy] = useState(false);
  const sendGmailTest = async () => {
    setGmailBusy(true);
    try {
      const res = await apiFetch('/api/integrations/google/gmail/test', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao enviar o e-mail.'); return; }
      toast.success('E-mail de teste enviado! Confira sua caixa de entrada. ✉️');
    } catch { toast.error('Falha ao enviar o e-mail.'); }
    finally { setGmailBusy(false); }
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
    apiFetch('/api/integrations/backups/settings').then(r => r.json()).then(d => { if (d && typeof d === 'object' && !d.error) setBackupCfg({ enabled: !!d.enabled, frequency: d.frequency || 'daily', retention: d.retention ?? 30, toDrive: !!d.toDrive, lastRun: d.lastRun || null }); }).catch(console.error);
  };

  const saveBackupCfg = async (patch: Partial<typeof backupCfg>) => {
    const next = { ...backupCfg, ...patch };
    setBackupCfg(next);
    setSavingBackupCfg(true);
    try {
      const r = await apiFetch('/api/integrations/backups/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next.enabled, frequency: next.frequency, retention: next.retention, toDrive: next.toDrive }),
      });
      if (!r.ok) toast.error('Não foi possível salvar a configuração de backup.');
    } catch { toast.error('Não foi possível salvar a configuração de backup.'); }
    finally { setSavingBackupCfg(false); }
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

  const [restoringId, setRestoringId] = useState<string | null>(null);
  const handleRestoreBackup = async (id: string) => {
    // Dupla confirmação — operação sobrescreve os dados atuais.
    if (!(await confirmDialog('Restaurar este backup vai SUBSTITUIR seus dados atuais (contatos, conversas, pedidos, catálogo) pelo estado deste arquivo. Antes de sobrescrever, geramos um backup de segurança automático. Deseja continuar?', { danger: true, confirmText: 'Continuar' }))) return;
    if (!(await confirmDialog('Tem certeza absoluta? Esta ação substitui os dados atuais da sua conta pelo backup selecionado.', { danger: true, confirmText: 'Restaurar agora' }))) return;
    setRestoringId(id);
    try {
      const r = await apiFetch(`/api/integrations/backups/${id}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { toast.success('Backup restaurado. Recarregue a página para ver os dados restaurados.'); loadData(); }
      else toast.error(d?.error || 'Falha ao restaurar o backup.');
    } catch { toast.error('Falha ao restaurar o backup.'); }
    finally { setRestoringId(null); }
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
        <p className="zf-kicker mb-1">Conexões Externas</p>
        <h2 className="zf-page-title flex items-center gap-2">
          <Link2 className="w-6 h-6" style={{ color: 'var(--color-flow)' }} />
          Integrações e Backups
        </h2>
        <p className="text-zinc-400 text-sm mt-1">Gerencie integrações com Google e Webhooks</p>
      </div>

      <AlterdataConnectorPanel />

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
              <code className="flex-1 min-w-0 text-[11px] text-indigo-300 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 break-all">{waWebhook.url}</code>
              <button onClick={copyWaUrl} className="shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10">
                {waCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {waCopied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
            {!waWebhook.usingEnv ? (
              <button onClick={rotateWaSecret} className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300">Gerar novo segredo</button>
            ) : (
              <p className="mt-2 text-[11px] text-zinc-500">Segredo definido por variável de ambiente (sempre exigido).</p>
            )}
            {/* Diagnóstico: última chamada recebida do WhatsApp */}
            {waWebhook.lastHit && (
              <p className={`mt-2 text-[11px] ${waWebhook.lastHit.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                Última chamada do WhatsApp: há {Math.max(0, Math.round((Date.now() - waWebhook.lastHit.at) / 1000))}s — {waWebhook.lastHit.ok
                  ? 'recebida e aceita ✅'
                  : 'REJEITADA ❌ (o segredo na Evolution não confere — copie a URL acima e cole de novo na Evolution).'}
              </p>
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
                    Conectado com acesso offline — a IA/servidor usa Drive, Agenda, Gmail e Sheets mesmo com você offline. Agendamentos viram eventos no Google Calendar.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={sendGmailTest} disabled={gmailBusy} className="border-zinc-700 text-zinc-200">
                      {gmailBusy ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Enviar e-mail de teste (Gmail)
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => exportSheets('orders')} disabled={sheetsBusy === 'orders'} className="border-zinc-700 text-zinc-200">
                      {sheetsBusy === 'orders' ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Exportar pedidos p/ Sheets
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => exportSheets('contacts')} disabled={sheetsBusy === 'contacts'} className="border-zinc-700 text-zinc-200">
                      {sheetsBusy === 'contacts' ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Exportar contatos p/ Sheets
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => exportSheets('appointments')} disabled={sheetsBusy === 'appointments'} className="border-zinc-700 text-zinc-200">
                      {sheetsBusy === 'appointments' ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Exportar agendamentos p/ Sheets
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => exportSheets('summary')} disabled={sheetsBusy === 'summary'} className="border-zinc-700 text-zinc-200">
                      {sheetsBusy === 'summary' ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Relatório de vendas (resumo) p/ Sheets
                    </Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    <p className="text-[11px] uppercase tracking-wider text-zinc-500">Automações</p>
                    {([
                      { key: 'logOrders', label: '📊 Registrar novos pedidos numa planilha do Sheets' },
                      { key: 'emailAppointments', label: '📅 Confirmar agendamento por e-mail ao cliente' },
                      { key: 'emailOrders', label: '🛒 Confirmar pedido por e-mail ao cliente' },
                    ] as const).map(({ key, label }) => (
                      <div key={key} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                        <span className="text-xs text-zinc-300">{label}</span>
                        <button onClick={() => toggleAuto(key)}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${auto[key] ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${auto[key] ? 'translate-x-5' : 'translate-x-1'}`} />
                        </button>
                      </div>
                    ))}
                    <p className="text-[10px] text-zinc-600">As confirmações por e-mail só são enviadas quando o cliente tem e-mail cadastrado (informado no agendamento ou no checkout da vitrine).</p>

                    <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/10 px-3 py-2 mt-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-zinc-200">🔄 Painel vivo no Sheets (Vendas · Estoque · Resumo)</span>
                        <button onClick={() => toggleAuto('liveSync')}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${auto.liveSync ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
                          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${auto.liveSync ? 'translate-x-5' : 'translate-x-1'}`} />
                        </button>
                      </div>
                      <p className="text-[10px] text-zinc-500 mt-1">
                        Uma planilha que se atualiza sozinha (de hora em hora): pedidos com status/pagamento atuais, níveis de estoque e um resumo de 30 dias. Fixe, filtre ou compartilhe como dashboard.
                        {syncLastRun ? ` Última sincronização: ${new Date(syncLastRun).toLocaleString('pt-BR')}.` : ''}
                      </p>
                      <Button variant="outline" size="sm" onClick={syncNow} disabled={syncBusy} className="mt-2 border-zinc-700 text-zinc-200">
                        {syncBusy ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : null} Sincronizar agora e abrir
                      </Button>
                    </div>
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
                       <p className="text-xs text-zinc-500 break-all">{wh.url}</p>
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

        {/* Backup automático (ADR-097) */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 mb-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-zinc-100">🔄 Backup automático</p>
              <p className="text-xs text-zinc-500 mt-0.5">Gera backups sozinho e envia ao seu Google Drive. Além disso, guardamos uma cópia de redundância na nossa infraestrutura toda semana.</p>
            </div>
            <button onClick={() => saveBackupCfg({ enabled: !backupCfg.enabled })} disabled={savingBackupCfg}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${backupCfg.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${backupCfg.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          {backupCfg.enabled && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
              <label className="text-xs text-zinc-400">Frequência
                <select value={backupCfg.frequency} onChange={e => saveBackupCfg({ frequency: e.target.value })}
                  className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100">
                  <option value="daily">Diário (madrugada)</option>
                  <option value="2x_week">2x por semana</option>
                  <option value="weekly">Semanal</option>
                </select>
              </label>
              <label className="text-xs text-zinc-400">Manter últimos (nº)
                <input type="number" min={1} max={365} defaultValue={backupCfg.retention}
                  onBlur={e => { const v = Math.min(365, Math.max(1, parseInt(e.target.value, 10) || 30)); if (v !== backupCfg.retention) saveBackupCfg({ retention: v }); }}
                  className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" />
              </label>
              <label className="text-xs text-zinc-400 flex flex-col justify-between">Enviar ao Google Drive
                <button onClick={() => saveBackupCfg({ toDrive: !backupCfg.toDrive })} disabled={savingBackupCfg}
                  className={`mt-1 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${backupCfg.toDrive ? 'bg-blue-600' : 'bg-zinc-700'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${backupCfg.toDrive ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </label>
            </div>
          )}
          {backupCfg.enabled && backupCfg.toDrive && !googleStatus?.connected && (
            <p className="mt-3 text-xs text-amber-400">⚠️ Conecte sua conta Google acima para o envio automático ao Drive funcionar. Sem isso, o backup fica só no servidor.</p>
          )}
          {backupCfg.lastRun && (
            <p className="mt-3 text-[11px] text-zinc-500">Último backup automático: {new Date(backupCfg.lastRun).toLocaleString('pt-BR')}</p>
          )}
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
                  {ready && (
                    <Button variant="ghost" size="sm" onClick={() => handleRestoreBackup(b.id)} disabled={restoringId === b.id} className="h-7 px-2 text-amber-300 hover:text-amber-200" title="Restaurar (substitui os dados atuais)">
                      {restoringId === b.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
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
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[calc(100%-2rem)] max-w-[400px] max-h-[90vh] overflow-y-auto">
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

// ============================================================================
// Conector Alterdata/ModaUp (ADR-105) — cola credenciais CIFRADAS + rede/filial.
// A sincronização real (Fase 1) liga quando a Alterdata fornecer token +
// homologação; aqui é a config, pronta pra plugar. Segredos nunca voltam do
// servidor (só hasCredentials/hasToken).
// ============================================================================
function AlterdataConnectorPanel() {
  const [st, setSt] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [rede, setRede] = useState('');
  const [filiais, setFiliais] = useState('');
  const [environment, setEnvironment] = useState('homolog');
  const [basePattern, setBasePattern] = useState('');
  const [priceTable, setPriceTable] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [testing, setTesting] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<{ at: string; ok: boolean; text: string } | null>(null);
  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await apiFetch('/api/integrations/alterdata/sync', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) {
        const s = d.summary || {};
        const text = `${s.referencias || 0} produtos · ${s.variantes || 0} variantes · ${s.saldos?.applied || 0} saldos · ${s.precos?.applied || 0} preços`;
        toast.success(`Sincronizado: ${text}.`);
        setLastSync({ at: new Date().toISOString(), ok: true, text });
      } else {
        const err = d.error || 'Falha ao sincronizar.';
        toast.error(err);
        setLastSync({ at: new Date().toISOString(), ok: false, text: err });
      }
    } catch {
      toast.error('Falha ao sincronizar.');
      setLastSync({ at: new Date().toISOString(), ok: false, text: 'Falha de conexão.' });
    } finally { setSyncing(false); }
  };

  const [probing, setProbing] = useState(false);
  const [probes, setProbes] = useState<Array<{ resource: string; status: number; ok: boolean; snippet: string; path: string }> | null>(null);
  const runProbe = async () => {
    setProbing(true);
    try {
      const res = await apiFetch('/api/integrations/alterdata/probe', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok && Array.isArray(d.probes)) {
        setProbes(d.probes);
        const bad = d.probes.filter((p: any) => !p.ok);
        if (bad.length === 0) toast.success('Todos os módulos responderam OK.');
        else toast.error(`${bad.length} módulo(s) com falha: ${bad.map((p: any) => `${p.resource} (HTTP ${p.status})`).join(', ')}.`);
      } else {
        toast.error(d.error || 'Falha ao testar os módulos.');
      }
    } catch {
      toast.error('Falha ao testar os módulos.');
    } finally { setProbing(false); }
  };

  const testToken = async () => {
    setTesting(true);
    try {
      const res = await apiFetch('/api/integrations/alterdata/test-token', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) { toast.success(`Conexão OK! Token emitido pelo Guardian (expira ${new Date(d.tokenExpiresAt).toLocaleString('pt-BR')}).`); if (d.status) setSt(d.status); }
      else toast.error(d.error || 'Falha ao emitir o token no Guardian.');
    } finally { setTesting(false); }
  };

  const load = () => apiFetch('/api/integrations/alterdata/status').then(r => r.json()).then((d) => {
    setSt(d);
    setRede(d.rede || '');
    setFiliais(Array.isArray(d.filiais) ? d.filiais.join(', ') : '');
    setEnvironment(d.environment || 'homolog');
    setBasePattern(d.basePattern || 'toulon-{module}.apimodaup.com.br');
    setPriceTable(d.priceTable || '');
  }).catch(() => {});
  useEffect(() => { load(); }, []);

  const save = async (patch: any = {}) => {
    setSaving(true);
    try {
      const body: any = {
        environment, rede: rede.trim() || null,
        filiais: filiais.split(',').map(s => s.trim()).filter(Boolean),
        basePattern: basePattern.trim() || null,
        priceTable: priceTable.trim() || null,
        ...patch,
      };
      // Só manda credencial se o lojista digitou algo (não sobrescreve com vazio).
      if (clientId.trim() || clientSecret.trim()) body.authConfig = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
      const res = await apiFetch('/api/integrations/alterdata/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Configuração da Alterdata salva.'); setClientId(''); setClientSecret(''); setSt(d); }
      else toast.error(d.error || 'Falha ao salvar.');
    } finally { setSaving(false); }
  };

  const inputCls = 'w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100';
  const Badge = ({ ok, on, off }: { ok: boolean; on: string; off: string }) => (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${ok ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>{ok ? on : off}</span>
  );

  return (
    <div className="mb-6 p-6 rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link2 className="w-6 h-6 text-indigo-400" />
          <div>
            <h3 className="font-semibold text-zinc-100">ERP Alterdata / ModaUp</h3>
            <p className="text-sm text-zinc-400">Sincroniza produto, estoque e preço do seu ERP (sem digitação dupla).</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge ok={!!st?.hasCredentials} on="Credenciais salvas" off="Sem credenciais" />
          <Badge ok={!!st?.hasToken} on="Token ativo" off="Aguardando token" />
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-[12px] text-sky-200/90">
        O token é emitido pelo <strong>Guardian da ModaUp</strong>: o <strong>Client ID é o e-mail</strong> e o <strong>Client Secret é a senha</strong> de um usuário de <strong>retaguarda com acesso total</strong>. Salve as credenciais (guardadas cifradas) e clique em <strong>Testar conexão</strong> para validar.
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-xs text-zinc-400">Rede
          <input className={inputCls} value={rede} onChange={e => setRede(e.target.value)} placeholder="rede da TOULON no ERP" />
        </label>
        <label className="text-xs text-zinc-400">Filiais (separadas por vírgula)
          <input className={inputCls} value={filiais} onChange={e => setFiliais(e.target.value)} placeholder="ex.: 1, 2" />
        </label>
        <label className="text-xs text-zinc-400">Ambiente
          <select className={inputCls} value={environment} onChange={e => setEnvironment(e.target.value)}>
            <option value="homolog">Homologação (recomendado no início)</option>
            <option value="prod">Produção</option>
          </select>
        </label>
        <label className="text-xs text-zinc-400">Padrão de URL dos módulos
          <input className={inputCls} value={basePattern} onChange={e => setBasePattern(e.target.value)} placeholder="toulon-fq-grande-rio-{module}.apimodaup.com.br" />
          {basePattern.includes('{module}') ? (
            <div className="mt-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-[11px] text-zinc-500 space-y-0.5">
              <div>SUPPLY → <span className="text-zinc-300">https://{basePattern.replace('{module}', 'supply').replace(/^https?:\/\//, '').replace(/\/$/, '')}</span></div>
              <div>PRICES → <span className="text-zinc-300">https://{basePattern.replace('{module}', 'price').replace(/^https?:\/\//, '').replace(/\/$/, '')}</span></div>
              <div className="text-zinc-600">Confira se batem com as URLs que a Alterdata enviou (o <code>{'{module}'}</code> vira supply/price automaticamente).</div>
            </div>
          ) : <span className="mt-1 block text-[11px] text-amber-300/80">Use o marcador <code>{'{module}'}</code> — ele vira supply/price. Ex.: toulon-fq-grande-rio-{'{module}'}.apimodaup.com.br</span>}
        </label>
        <label className="text-xs text-zinc-400">Tabela de preço (módulo Price)
          <input className={inputCls} value={priceTable} onChange={e => setPriceTable(e.target.value)} placeholder="nº da tabela de preço da rede (ex.: 1)" />
        </label>
        <label className="text-xs text-zinc-400">Client ID — e-mail do usuário {st?.hasCredentials && <span className="text-emerald-400">(já salvo)</span>}
          <input className={inputCls} value={clientId} onChange={e => setClientId(e.target.value)} placeholder={st?.hasCredentials ? '•••••• (deixe em branco p/ manter)' : 'e-mail do usuário de retaguarda (acesso total)'} autoComplete="off" />
        </label>
        <label className="text-xs text-zinc-400">Client Secret — senha {st?.hasCredentials && <span className="text-emerald-400">(já salvo)</span>}
          <input type="password" className={inputCls} value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder={st?.hasCredentials ? '•••••• (deixe em branco p/ manter)' : 'senha do usuário de retaguarda'} autoComplete="new-password" />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <Button onClick={() => save()} disabled={saving} className="zf-button zf-button-primary">
          {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
          Salvar configuração
        </Button>
        <Button onClick={testToken} disabled={testing || !st?.hasCredentials} className="zf-button zf-button-secondary" title={!st?.hasCredentials ? 'Salve as credenciais primeiro' : 'Emite um token no Guardian para validar as credenciais'}>
          {testing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
          Testar conexão
        </Button>
        {/* Sync manual funciona com credenciais válidas — não exige a integração
            ativa (o toggle governa só a sincronização automática/agendada). */}
        <Button onClick={runSync} disabled={syncing || !st?.hasCredentials} className="zf-button zf-button-secondary" title={!st?.hasCredentials ? 'Salve as credenciais e teste a conexão primeiro' : 'Puxa produtos, variantes, estoque e preços da Alterdata agora (funciona em homologação sem ativar)'}>
          {syncing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Sincronizar agora
        </Button>
        {/* Diagnóstico: probe cada endpoint separadamente para isolar qual está
            devolvendo 500 na homologação (por eliminação). */}
        <Button onClick={runProbe} disabled={probing || !st?.hasCredentials} className="zf-button zf-button-secondary" title={!st?.hasCredentials ? 'Salve as credenciais e teste a conexão primeiro' : 'Testa cada endpoint (produtos, códigos de barras, saldo, preço) separadamente e mostra o HTTP de cada um — para isolar qual falha'}>
          {probing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Activity className="w-4 h-4 mr-2" />}
          Testar módulos
        </Button>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={!!st?.enabled} onChange={e => save({ enabled: e.target.checked })} disabled={saving} />
          Integração ativa
        </label>
        {st?.tokenExpiresAt && <span className="text-[11px] text-zinc-500">token expira: {new Date(st.tokenExpiresAt).toLocaleString('pt-BR')}</span>}
      </div>

      {/* Resultado da última sincronização — fica na tela (o toast some rápido). */}
      {lastSync && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${lastSync.ok ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200' : 'border-rose-500/30 bg-rose-500/5 text-rose-200'}`}>
          <span className="font-semibold">{lastSync.ok ? 'Última sincronização: ' : 'Falha na sincronização: '}</span>
          {lastSync.text}
          <span className="text-zinc-500"> · {new Date(lastSync.at).toLocaleString('pt-BR')}</span>
        </div>
      )}

      {/* Diagnóstico por endpoint — verde = OK, vermelho = falha (com o HTTP e um
          trecho do corpo), para isolar por eliminação qual módulo está em 500. */}
      {probes && (
        <div className="mt-3 rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-3 py-2 text-xs">
          <div className="font-semibold text-zinc-200 mb-2">Teste de módulos (por endpoint)</div>
          <div className="space-y-1">
            {probes.map((p, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className={`mt-0.5 inline-block w-2 h-2 rounded-full flex-shrink-0 ${p.ok ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                <div className="min-w-0">
                  <span className={`font-medium ${p.ok ? 'text-emerald-200' : 'text-rose-200'}`}>{p.resource}</span>
                  <span className="text-zinc-500"> · HTTP {p.status || '—'}</span>
                  <span className="text-zinc-600 ml-2 font-mono text-[10px]">{p.path}</span>
                  {!p.ok && p.snippet && <div className="text-rose-300/80 mt-0.5 break-words">{p.snippet}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
