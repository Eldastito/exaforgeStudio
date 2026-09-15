import React, { useState, useRef, useEffect } from 'react';
import { toast, confirmDialog } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';
import { Smartphone, Instagram, AlertCircle, CheckCircle2, RefreshCw, UploadCloud, BrainCircuit, FileText, Loader2, Check, X, Trash2 } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Badge } from '@/src/components/ui/badge';
import { format } from 'date-fns';
import { apiFetch } from '@/src/lib/api';
import { InstagramConnectModal } from '@/src/features/InstagramConnectModal';
import { useAuth } from '@/src/contexts/AuthContext';

export function ChannelsPanel() {
  const { channels, ragDocuments, addRagDocument, setRagDocumentStatus, removeRagDocument, loadRagDocuments, fetchChannels, updateChannel, removeChannel } = useStore();

  const handleDisconnect = async (id: string, label: string) => {
    if (!(await confirmDialog(`Desconectar ${label}? O canal será removido e as mensagens deixarão de chegar até reconectar.`, { danger: true }))) return;
    removeChannel(id);
  };
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [evolutionStatus, setEvolutionStatus] = useState<'disconnected' | 'connecting_evo' | 'connected_evo'>('disconnected');
  const [evolutionQr, setEvolutionQr] = useState<string | null>(null);
  // W1 — conexão simplificada: o caminho padrão cria a instância sozinho (mode
  // 'new', nome automático); importar instância existente vira opção avançada.
  const [evoAdvanced, setEvoAdvanced] = useState(false);
  const [evoBusy, setEvoBusy] = useState(false);
  const [evoInstanceName, setEvoInstanceName] = useState<string | null>(null);
  // W1 — luzes honestas do canal (ChannelStateService/F1.2d): sessão × recebimento × operação.
  const [evoState, setEvoState] = useState<any | null>(null);
  // W1 — quem pode falar com a IA do negócio por este WhatsApp (Gestores do Zapp).
  const [zappManagers, setZappManagers] = useState<any[]>([]);
  const [zappNumber, setZappNumber] = useState('');
  const [zappName, setZappName] = useState('');
  const [zappBusy, setZappBusy] = useState(false);
  // W3 — modo misto (um número = atendimento + gestão), opt-in do piloto.
  const [mixedMode, setMixedMode] = useState<{ enabled: boolean; managersCount: number } | null>(null);
  const [mixedBusy, setMixedBusy] = useState(false);
  // F2.2 (UI) — usos por finalidade (channel_feature_bindings).
  const [bindingFeatures, setBindingFeatures] = useState<string[]>([]);
  const [bindings, setBindings] = useState<any[]>([]);
  const [newBindFeature, setNewBindFeature] = useState('');
  const [newBindChannel, setNewBindChannel] = useState('');
  const [bindBusy, setBindBusy] = useState(false);
  const FEATURE_LABELS: Record<string, string> = {
    atendimento: 'Atendimento ao cliente', gestao: 'Gestão (Fala Tu / interno)', campanhas: 'Campanhas / marketing',
    cobranca: 'Cobrança / fiado', agenda: 'Agenda / lembretes', prospeccao: 'Prospecção', recompra: 'Recompra / carrinho',
    satisfacao: 'Pós-venda / satisfação', clinica: 'Avisos clínicos', escola: 'Comunicação escolar',
  };
  const [showInstagram, setShowInstagram] = useState(false);
  const [forwardWhats, setForwardWhats] = useState('');
  const [areas, setAreas] = useState<{ id: string; name: string }[]>([]);
  const [docAreaId, setDocAreaId] = useState('');
  const [rawChannels, setRawChannels] = useState<any[]>([]);

  const loadRaw = () => apiFetch('/api/channels').then(r => r.json()).then(d => setRawChannels(Array.isArray(d) ? d : [])).catch(() => {});
  useEffect(() => {
    fetchChannels();
    loadRagDocuments();
    loadRaw();
    apiFetch('/api/channels/forward-whatsapp').then(r => r.json()).then(d => setForwardWhats(d.forward_whatsapp || '')).catch(() => {});
    apiFetch('/api/areas').then(r => r.json()).then(d => setAreas(Array.isArray(d) ? d : [])).catch(() => {});
    loadEvoStatus();
    loadBindings();
    loadZappManagers();
    loadMixedMode();
  }, []);

  // F2.2 (UI) — usos por finalidade.
  const loadBindings = () => {
    apiFetch('/api/channels/bindings').then(r => r.json()).then((d: any) => {
      setBindingFeatures(Array.isArray(d?.features) ? d.features : []);
      setBindings(Array.isArray(d?.bindings) ? d.bindings : []);
    }).catch(() => {});
  };
  const addBinding = async () => {
    if (!newBindFeature || !newBindChannel) { toast.error('Escolha a finalidade e o número.'); return; }
    setBindBusy(true);
    try {
      const r = await apiFetch('/api/channels/bindings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureKey: newBindFeature, channelId: newBindChannel }),
      });
      if (r.ok) { toast.success('Uso configurado.'); setNewBindFeature(''); setNewBindChannel(''); loadBindings(); }
      else {
        const d = await r.json().catch(() => ({}));
        toast.error(d?.code === 'version_conflict' ? 'A configuração mudou; recarregue.' : (d?.error || 'Não foi possível salvar o uso.'));
      }
    } catch { toast.error('Falha ao salvar o uso.'); } finally { setBindBusy(false); }
  };
  const removeBinding = async (id: string) => {
    setBindBusy(true);
    try {
      const r = await apiFetch(`/api/channels/bindings/${id}`, { method: 'DELETE' });
      if (r.ok) { toast.success('Uso removido.'); loadBindings(); } else toast.error('Não foi possível remover.');
    } catch { toast.error('Falha ao remover.'); } finally { setBindBusy(false); }
  };
  const channelName = (id: string) => { const c = waChannels.find((x: any) => x.id === id); return c?.name || c?.identifier || id.slice(0, 8); };

  // F2.1b — retomada: reflete o estado real do canal Evolution da org ao abrir a
  // tela (endpoint autenticado). Se já há um canal conectado, mostra conectado.
  // W1 — também carrega as dimensões de estado (sessão/webhook/operação) pras luzes.
  const loadEvoStatus = () => {
    apiFetch('/api/channels/whatsapp/status').then(r => r.json()).then((d: any) => {
      const chs = Array.isArray(d?.channels) ? d.channels : [];
      const conn = chs.find((c: any) => c.connected);
      if (conn) {
        setEvolutionStatus('connected_evo');
        setEvoInstanceName(conn.instanceName || null);
      } else {
        setEvoInstanceName(chs[0]?.instanceName || null);
        setEvolutionStatus(s => (s === 'connecting_evo' ? s : 'disconnected'));
      }
    }).catch(() => {});
    apiFetch('/api/channels/states').then(r => r.json()).then((d: any) => {
      const chs = Array.isArray(d?.channels) ? d.channels : [];
      setEvoState(chs.find((c: any) => c.provider === 'evolution' || c.provider === 'evolution_go') || null);
    }).catch(() => {});
  };

  // W1 — enquanto o QR está na tela, confere a cada 4s se o celular já leu; ao
  // conectar, o "WhatsApp conectado ✅" aparece sozinho (o leigo não precisa
  // recarregar nada pra saber que deu certo).
  useEffect(() => {
    if (evolutionStatus !== 'connecting_evo' || !evolutionQr) return;
    const t = setInterval(() => {
      apiFetch('/api/channels/whatsapp/status').then(r => r.json()).then((d: any) => {
        const conn = (Array.isArray(d?.channels) ? d.channels : []).find((c: any) => c.connected);
        if (conn) {
          setEvolutionQr(null);
          setEvolutionStatus('connected_evo');
          setEvoInstanceName(conn.instanceName || null);
          toast.success('WhatsApp conectado!');
          loadRaw();
          loadEvoStatus();
        }
      }).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [evolutionStatus, evolutionQr]);

  // WZ-1 (relato do dono): o número pode ser desconectado DIRETO no celular
  // (WhatsApp → Aparelhos conectados → sair). O painel precisa perceber sozinho:
  // fora do fluxo de QR, reconsulta o estado a cada 20s — o card vira
  // "Desconectado" com o botão "Conectar WhatsApp" sem precisar recarregar.
  useEffect(() => {
    if (evolutionStatus === 'connecting_evo') return; // o poll do QR já cobre
    const t = setInterval(() => loadEvoStatus(), 20000);
    return () => clearInterval(t);
  }, [evolutionStatus]);

  // W1 — Gestores do Zapp (mesma fonte de Configurações → Usuários: /api/managers).
  const loadZappManagers = () => {
    apiFetch('/api/managers').then(r => (r.ok ? r.json() : [])).then((d: any) => setZappManagers(Array.isArray(d) ? d : [])).catch(() => {});
  };
  const addZappManager = async () => {
    if (!zappNumber.trim()) { toast.error('Informe o número com DDI+DDD (ex.: 5521999998888).'); return; }
    setZappBusy(true);
    try {
      const r = await apiFetch('/api/managers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: zappNumber, name: zappName }),
      });
      if (r.ok) { toast.success('Número autorizado a falar com a IA.'); setZappNumber(''); setZappName(''); loadZappManagers(); }
      else { const d = await r.json().catch(() => ({})); toast.error(d?.error || 'Não foi possível autorizar o número.'); }
    } catch { toast.error('Não foi possível autorizar o número.'); } finally { setZappBusy(false); }
  };
  const removeZappManager = async (id: string) => {
    if (!(await confirmDialog('Remover a autorização deste número?', { danger: true, confirmText: 'Remover' }))) return;
    try {
      const r = await apiFetch(`/api/managers/${id}`, { method: 'DELETE' });
      if (r.ok) loadZappManagers(); else toast.error('Não foi possível remover.');
    } catch { toast.error('Não foi possível remover.'); }
  };

  // W3 — modo misto (um número só pra tudo): estado + toggle (owner/admin).
  const loadMixedMode = () => {
    apiFetch('/api/channels/mixed-mode').then(r => r.json()).then((d: any) => {
      if (typeof d?.enabled === 'boolean') setMixedMode({ enabled: d.enabled, managersCount: Number(d.managersCount || 0) });
    }).catch(() => {});
  };
  const toggleMixedMode = async (enabled: boolean) => {
    if (enabled && zappManagers.length === 0) {
      toast.error('Autorize ao menos um número de gestor antes de ligar — sem gestor cadastrado, ninguém é reconhecido pra falar com a IA.');
      return;
    }
    if (enabled && !(await confirmDialog('Ligar o modo "um número só pra tudo"? Os gestores autorizados passam a falar com a IA pelo MESMO número do atendimento. Dá pra desligar a qualquer momento.', { confirmText: 'Ligar' }))) return;
    setMixedBusy(true);
    try {
      const r = await apiFetch('/api/channels/mixed-mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (r.ok) {
        const d = await r.json();
        setMixedMode({ enabled: !!d.enabled, managersCount: Number(d.managersCount || 0) });
        toast.success(enabled ? 'Modo misto ligado — um número serve atendimento e gestão.' : 'Modo misto desligado — o número volta a ser só atendimento.');
      } else {
        const d = await r.json().catch(() => ({}));
        toast.error(d?.error || 'Não foi possível alterar o modo misto.');
      }
    } catch { toast.error('Não foi possível alterar o modo misto.'); } finally { setMixedBusy(false); }
  };

  // W1 — traduz as dimensões da F1.2d em 3 luzes honestas pro leigo. "Recebimento
  // aguardando a primeira mensagem" NÃO é erro (webhook not_verified só vira
  // healthy com evento real — CA-02: saúde nunca inferida da criação da URL).
  const evoLights = (): Array<{ label: string; ok: boolean; warn?: boolean; text: string }> => {
    if (!evoState) return [];
    const s = evoState.session, w = evoState.webhook, o = evoState.operation;
    return [
      {
        label: 'Sessão do WhatsApp', ok: s === 'connected', warn: s === 'awaiting_pairing' || s === 'provisioning',
        text: s === 'connected' ? 'conectada' : s === 'awaiting_pairing' ? 'aguardando leitura do QR' : s === 'provisioning' ? 'preparando' : 'desconectada',
      },
      {
        label: 'Recebimento de mensagens', ok: w === 'healthy', warn: w === 'not_verified' || w === 'degraded',
        text: w === 'healthy' ? 'funcionando (automático)' : w === 'not_verified' ? 'aguardando a primeira mensagem' : w === 'degraded' ? 'instável' : 'bloqueado — fale com o suporte',
      },
      {
        label: 'Pronto para operar', ok: o === 'ready', warn: o === 'pending_validation',
        text: o === 'ready' ? 'sim — atendimento e envios ativos' : o === 'pending_validation' ? 'validando' : 'não',
      },
    ];
  };

  // F2.1b/W1 — conecta pelo endpoint AUTENTICADO (org vem da sessão). Caminho
  // padrão: mode 'new' (instância automática). Import de instância existente só
  // pelas opções avançadas ({existing:true}) ou reconexão ({instanceName}).
  const connectEvolution = async (opts?: { existing?: boolean; instanceName?: string }) => {
    setEvolutionStatus('connecting_evo');
    setEvolutionQr(null);
    setEvoBusy(true);
    const instanceName = opts?.instanceName ?? ((document.getElementById('evo_inst') as HTMLInputElement | null)?.value?.trim() || '');
    const useExisting = !!(opts?.existing || opts?.instanceName) && !!instanceName;
    try {
      const resp = await apiFetch('/api/channels/whatsapp/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(useExisting ? { mode: 'existing', instanceName } : { mode: 'new' }),
      });
      const data = await resp.json();
      if (resp.ok && data.qrBase64) {
        setEvolutionQr(data.qrBase64);
        if (data.imported) toast.success('Instância importada. Leia o QR Code para conectar.');
      } else if (resp.ok && data.state === 'open') {
        setEvolutionStatus('connected_evo');
        toast.success('Número já conectado.');
        loadEvoStatus();
      } else {
        // Erros tipados do backend (RF-01/§8).
        const code = data?.code;
        const msg = code === 'attributed_to_other_org' ? 'Esta instância já pertence a outra empresa.'
          : code === 'instance_not_found' ? 'Instância não encontrada no provedor. Use o botão "Conectar WhatsApp" para criar uma nova.'
          : code === 'evolution_failed' ? (data?.needsReset ? 'Não veio o QR. A instância pode estar travada — o operador pode reiniciá-la.' : 'Falha ao falar com o provedor. Tente de novo.')
          : (data?.error || 'Não foi possível gerar o QR Code.');
        toast.error(msg);
        setEvolutionStatus('disconnected');
      }
    } catch (e) {
      console.error(e);
      toast.error('Erro ao conectar WhatsApp.');
      setEvolutionStatus('disconnected');
    } finally {
      setEvoBusy(false);
    }
  };

  // Marca/desmarca um canal como INTERNO (número da equipe / Coordenador IA).
  const setChannelKind = async (id: string, internal: boolean) => {
    try {
      await apiFetch(`/api/channels/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: internal ? 'internal' : 'client' }) });
      toast.success(internal ? 'Número definido como interno (Coordenador IA).' : 'Número voltou a ser de atendimento ao cliente.');
      loadRaw();
    } catch { toast.error('Não foi possível atualizar o canal.'); }
  };
  const waChannels = rawChannels.filter(c => ['evolution', 'whatsapp_cloud', 'whatsapp_web'].includes(c.provider) && c.status !== 'disabled');

  const saveForward = async () => {
    await apiFetch('/api/channels/forward-whatsapp', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forward_whatsapp: forwardWhats }),
    }).catch(() => {});
  };

  const whatsappCloud = channels.find(c => c.provider === 'whatsapp_cloud');
  const instagram = channels.find(c => c.provider === 'instagram');
  const evolution = channels.find(c => c.provider === 'evolution');

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Adiciona de forma otimista (status "processando")
    const tempId = addRagDocument({
      name: file.name,
      size: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
      channelId: 'global'
    });

    const formData = new FormData();
    formData.append('document', file);
    formData.append('channelId', 'global');
    if (docAreaId) formData.append('areaId', docAreaId);

    try {
      const response = await apiFetch('/api/rag/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setRagDocumentStatus(tempId, 'ready', { id: data.documentId || tempId });
        // Recarrega a lista real do servidor (mantém ids/contagens corretos)
        loadRagDocuments();
      } else {
        console.error('RAG Upload failed:', data?.error);
        setRagDocumentStatus(tempId, 'error');
      }
    } catch (error) {
      console.error('RAG Upload failed:', error);
      setRagDocumentStatus(tempId, 'error');
    } finally {
      // Permite reenviar o mesmo arquivo
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDeleteDocument = async (id: string) => {
    // remoção otimista
    removeRagDocument(id);
    try {
      await apiFetch(`/api/rag/documents/${id}`, { method: 'DELETE' });
    } catch (error) {
      console.error('RAG delete failed:', error);
    } finally {
      loadRagDocuments();
    }
  };

  const handleSimulateWebhook = async () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1029384756102",
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "5511999999999",
                    text: {
                      body: "Olá, gostaria de saber os preços por favor."
                    }
                  }
                ]
              }
            }
          ]
        }
      ]
    };

    try {
      await fetch('/api/webhooks/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      console.log('Webhook simulado finalizado.');
    } catch (error) {
      console.error('Erro ao simular webhook', error);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scroll p-6 bg-background text-foreground">
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Cabecalho */}
        <div className="flex justify-between items-center mb-2">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-white mb-2">Canais e Automação</h2>
            <p className="text-sm text-slate-400">Conecte suas contas do Meta e gerencie o comportamento da IA (RAG) para cada canal.</p>
          </div>
          <Button onClick={handleSimulateWebhook} variant="outline" className="border-indigo-500/50 text-indigo-400 hover:bg-indigo-500/10">
            Simular Mensagem WhatsApp
          </Button>
        </div>

        {/* Status de Conexoes */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Card WhatsApp API */}
          <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/50 p-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <Smartphone className="w-24 h-24 text-emerald-500" />
            </div>
            
            <div className="flex items-center justify-between mb-6 relative z-10">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <Smartphone className="w-6 h-6 text-emerald-500" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-100">WhatsApp Business</h3>
                  <p className="text-xs text-slate-400">Cloud API (Oficial)</p>
                </div>
              </div>
              {whatsappCloud ? (
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Conectado
                </Badge>
              ) : (
                <Badge variant="outline" className="border-slate-700 text-slate-400 bg-slate-800/50">
                  Desconectado
                </Badge>
              )}
            </div>

            {whatsappCloud ? (
              <div className="space-y-4 relative z-10 flex-1">
                <div className="flex justify-between items-center text-sm gap-2">
                  <span className="text-slate-400 shrink-0">Número</span>
                  <span className="font-medium text-slate-200 truncate">{whatsappCloud.identifier}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-400">Modo IA</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={whatsappCloud.isActiveAI} onChange={(e) => updateChannel(whatsappCloud.id, { isActiveAI: e.target.checked })} />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                  </label>
                </div>
              </div>
            ) : (
              <div className="space-y-4 relative z-10 flex-1 flex flex-col justify-center items-center py-4">
               <AlertCircle className="w-8 h-8 text-slate-600 mb-2" />
               <p className="text-sm text-slate-400 text-center">Nenhum número de WhatsApp vinculado.</p>
              </div>
            )}

            <div className="mt-6 pt-6 border-t border-slate-800 flex gap-3 relative z-10">
              <Button variant="outline" className="flex-1 bg-slate-950 border-slate-800 text-slate-300 hover:text-white">
                <RefreshCw className="w-4 h-4 mr-2" /> Sincronizar
              </Button>
              {whatsappCloud && (
                <Button variant="outline" className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10" onClick={() => handleDisconnect(whatsappCloud.id, 'WhatsApp')}>
                  Desconectar
                </Button>
              )}
            </div>
          </div>

          {/* Card Instagram */}
          <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/50 p-6 relative overflow-hidden">
             <div className="absolute top-0 right-0 p-4 opacity-10">
              <Instagram className="w-24 h-24 text-pink-500" />
            </div>

            <div className="flex items-center justify-between mb-6 relative z-10">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-pink-500/10 border border-pink-500/20">
                  <Instagram className="w-6 h-6 text-pink-500" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-100">Instagram Direct</h3>
                  <p className="text-xs text-slate-400">Graph API</p>
                </div>
              </div>
              {instagram ? (
                <Badge variant="outline" className="border-pink-500/30 text-pink-400 bg-pink-500/10">
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Conectado
                </Badge>
              ) : (
                <Badge variant="outline" className="border-slate-700 text-slate-400 bg-slate-800/50">
                  Desconectado
                </Badge>
              )}
            </div>

            {instagram ? (
              <div className="space-y-4 relative z-10 flex-1">
                <div className="flex justify-between items-center text-sm gap-2">
                  <span className="text-slate-400 shrink-0">Conta</span>
                  <span className="font-medium text-slate-200 truncate">{instagram.name || instagram.identifier}</span>
                </div>
                <div className="flex justify-between items-center text-sm gap-2">
                  <span className="text-slate-400 shrink-0">IG Business ID</span>
                  <span className="font-mono text-xs text-slate-500 truncate">{instagram.identifier}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-400">Modo IA</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={instagram.isActiveAI} onChange={(e) => updateChannel(instagram.id, { isActiveAI: e.target.checked })} />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                  </label>
                </div>
              </div>
            ) : (
              <div className="space-y-4 relative z-10 flex-1 flex flex-col justify-center items-center py-4">
                 <AlertCircle className="w-8 h-8 text-slate-600 mb-2" />
                 <p className="text-sm text-slate-400 text-center">Nenhuma conta profissional do Instagram vinculada a esta plataforma.</p>
              </div>
            )}

            <div className="mt-6 pt-6 border-t border-slate-800 flex gap-3 relative z-10">
              {instagram ? (
                <>
                  <Button variant="outline" className="flex-1 bg-slate-950 border-slate-800 text-slate-300 hover:text-white" onClick={() => setShowInstagram(true)}>
                    <RefreshCw className="w-4 h-4 mr-2" /> Reconectar
                  </Button>
                  <Button variant="outline" className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10" onClick={() => handleDisconnect(instagram.id, 'Instagram')}>
                    Desconectar
                  </Button>
                </>
              ) : (
               <Button
                className="w-full bg-pink-600 hover:bg-pink-700 text-white border-0 transition-colors"
                onClick={() => setShowInstagram(true)}
               >
                 Conectar Instagram
               </Button>
              )}
            </div>
          </div>
          <MetaWebhookDiagnostics />
          {/* Card Evolution API */}
          <div className="flex flex-col rounded-xl border border-blue-900/40 bg-slate-900/50 p-6 relative overflow-hidden lg:col-span-2">
             <div className="absolute top-0 right-0 p-4 opacity-[0.03]">
              <Smartphone className="w-48 h-48 text-blue-500" />
            </div>

            <div className="flex items-center justify-between mb-4 relative z-10">
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-blue-500/20 border border-blue-500/30">
                    <RefreshCw className="w-6 h-6 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-slate-100">WhatsApp da empresa</h3>
                    <p className="text-sm text-slate-400">Um número conectado serve tudo: atendimento, cobranças, lembretes, campanhas e a conversa com a IA do negócio.</p>
                  </div>
                </div>
                
                <div className="flex flex-col items-end justify-center">
                  <span className="text-xs text-slate-400 font-medium mb-1">Modo IA:</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" className="sr-only peer" checked={evolution?.isActiveAI ?? true} onChange={(e) => {
                       if (evolution) {
                          updateChannel(evolution.id, { isActiveAI: e.target.checked });
                       }
                    }} />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                  </label>
                </div>
              </div>
            </div>

            {/* W1 — assistente em 3 estados: Desconectado → QR → Conectado. O webhook
                é auto-configurado no provisionamento (F1.4) — sem passo manual. */}
            {evolutionStatus === 'connected_evo' ? (
              <div className="relative z-10 space-y-4">
                <div className="flex flex-col items-center justify-center p-6 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                  <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-3" />
                  <p className="text-base font-semibold text-slate-100">WhatsApp conectado</p>
                  <p className="text-xs text-emerald-400 text-center mt-1">
                    Tudo pronto — este número já atende clientes e envia as mensagens do sistema.
                    {evoInstanceName ? <span className="text-slate-400"> (instância {evoInstanceName})</span> : null}
                  </p>
                </div>
                {evoState && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {evoLights().map(l => (
                      <div key={l.label} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${l.ok ? 'bg-emerald-500' : l.warn ? 'bg-amber-400' : 'bg-rose-500'}`} />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-200 truncate">{l.label}</p>
                          <p className="text-[11px] text-slate-400 truncate">{l.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                  <p className="text-[11px] text-slate-500">
                    Desconectou pelo celular (WhatsApp → Aparelhos conectados)? Este painel percebe sozinho em alguns segundos e volta a mostrar o botão <strong>Conectar WhatsApp</strong>.
                  </p>
                  <Button variant="outline" size="sm" disabled={evoBusy}
                    onClick={() => connectEvolution(evoInstanceName ? { instanceName: evoInstanceName } : undefined)}
                    className="border-slate-700 text-slate-300 hover:text-white shrink-0">
                    <RefreshCw className="w-4 h-4 mr-2" /> Gerar novo QR (reconectar)
                  </Button>
                </div>
              </div>
            ) : evolutionStatus === 'connecting_evo' ? (
              <div className="relative z-10 flex flex-col items-center justify-center p-6 bg-white/5 rounded-xl border border-slate-800">
                {evolutionQr ? (
                  <>
                    <div className="bg-white p-2 rounded-xl mb-4">
                      <img src={evolutionQr} alt="QR Code" className="w-48 h-48" />
                    </div>
                    <p className="text-sm font-medium text-slate-200">Aponte a câmera do celular para o código</p>
                    <p className="text-xs text-slate-400 text-center mt-1 max-w-md">
                      No celular da empresa: abra o <strong>WhatsApp</strong> → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> → aponte para o código. Assim que ler, esta tela confirma sozinha.
                    </p>
                  </>
                ) : (
                  <>
                    <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-3" />
                    <p className="text-sm text-slate-300">Preparando o QR Code…</p>
                  </>
                )}
              </div>
            ) : (
              <div className="relative z-10 space-y-4">
                <ol className="text-sm text-slate-300 space-y-1.5 list-decimal pl-5">
                  <li>Clique em <strong>Conectar WhatsApp</strong>.</li>
                  <li>Vai aparecer um QR Code aqui na tela.</li>
                  <li>Leia o código com o WhatsApp do celular da empresa (Aparelhos conectados → Conectar aparelho).</li>
                </ol>
                <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white border-0 transition-colors h-12 text-base"
                  disabled={evoBusy} onClick={() => connectEvolution()}>
                  {evoBusy ? 'Conectando…' : 'Conectar WhatsApp'}
                </Button>
                <div>
                  <button type="button" onClick={() => setEvoAdvanced(v => !v)} className="text-[11px] text-slate-500 hover:text-slate-300 underline">
                    {evoAdvanced ? 'Ocultar opções avançadas' : 'Opções avançadas (importar instância existente)'}
                  </button>
                  {evoAdvanced && (
                    <div className="mt-2 space-y-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                      <p className="text-[11px] text-slate-500">Só use se a sua empresa já tem uma instância criada no provedor. Só conecta se ela pertencer à sua empresa.</p>
                      <div className="flex gap-2">
                        <input type="text" id="evo_inst" placeholder="Nome da instância existente"
                          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 transition-colors" />
                        <Button variant="outline" disabled={evoBusy} onClick={() => connectEvolution({ existing: true })}
                          className="border-slate-700 text-slate-300 hover:text-white shrink-0">
                          Importar
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* W1 — quem pode falar com a IA do negócio por este WhatsApp. Mesma
                fonte de Configurações → Usuários (/api/managers) — sem 2ª lista. */}
            <div className="mt-6 pt-6 border-t border-slate-800 relative z-10">
              <h4 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-indigo-400" /> Falar com a IA do negócio
              </h4>
              <p className="text-xs text-slate-400 mt-1">
                Os números abaixo podem conversar com o <strong>Diretor IA</strong> por este WhatsApp — basta mandar uma mensagem começando com <strong className="text-indigo-300">"Zapp"</strong> (ex.: "Zapp, como foram as vendas hoje?").
              </p>
              <div className="mt-3 space-y-2">
                {zappManagers.length === 0 && (
                  <p className="text-xs text-slate-500">Nenhum número autorizado ainda — cadastre o número do dono abaixo.</p>
                )}
                {zappManagers.map((m: any) => (
                  <div key={m.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-200 truncate">{m.name || 'Sem nome'}</p>
                      <p className="text-xs text-slate-500 truncate">{m.identifier}</p>
                    </div>
                    <button onClick={() => removeZappManager(m.id)} className="shrink-0 text-slate-500 hover:text-red-400" title="Remover autorização">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <div className="flex flex-col md:flex-row gap-2 pt-2">
                  <input type="text" value={zappNumber} onChange={e => setZappNumber(e.target.value)} placeholder="5521999998888 (DDI+DDD+número)"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500" />
                  <input type="text" value={zappName} onChange={e => setZappName(e.target.value)} placeholder="Nome (ex.: Dono)"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500" />
                  <Button onClick={addZappManager} disabled={zappBusy || !zappNumber.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white shrink-0">
                    {zappBusy ? 'Salvando…' : 'Autorizar'}
                  </Button>
                </div>

                {/* W3 — um número só pra tudo (modo misto), opt-in do piloto. */}
                {mixedMode && (
                  <div className="flex items-start justify-between gap-3 rounded-lg border border-indigo-900/40 bg-slate-950/50 px-3 py-3 mt-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200">Um número só pra tudo (modo misto)</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Ligado: os gestores autorizados acima falam com a IA pelo <strong>mesmo número do atendimento</strong> — não precisa de um segundo chip. Clientes seguem no atendimento normal; se um gestor estiver no meio de um atendimento como cliente, a conversa dele continua no atendimento. Desligar volta tudo ao comportamento de hoje, na hora.
                      </p>
                      {mixedMode.enabled && zappManagers.length === 0 && (
                        <p className="text-[11px] text-amber-400 mt-1">⚠ Ligado, mas sem nenhum gestor autorizado — ninguém será reconhecido pra falar com a IA.</p>
                      )}
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                      <input type="checkbox" className="sr-only peer" checked={mixedMode.enabled} disabled={mixedBusy}
                        onChange={e => toggleMixedMode(e.target.checked)} />
                      <div className="w-9 h-5 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                    </label>
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>

        {/* Encaminhamento de leads (Instagram -> WhatsApp) */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-emerald-400" /> Encaminhamento para WhatsApp
              </h3>
              <p className="text-sm text-slate-400 mt-1">
                Número que a IA vai oferecer aos clientes do <strong>Instagram</strong> para continuar o atendimento no WhatsApp.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={forwardWhats}
                onChange={e => setForwardWhats(e.target.value)}
                placeholder="5521999998888 (DDI+DDD+número)"
                className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500 w-full md:w-64"
              />
              <Button onClick={saveForward} className="bg-emerald-600 hover:bg-emerald-700 text-white">Salvar</Button>
            </div>
          </div>
        </div>

        {/* Coordenador IA — número interno da equipe */}
        <div className="rounded-xl border border-indigo-900/40 bg-slate-900/50 p-6">
          <div className="flex items-start gap-3 mb-1">
            <BrainCircuit className="w-5 h-5 text-indigo-400 mt-0.5" />
            <div>
              <h3 className="text-lg font-semibold text-slate-100">Coordenador IA (número da equipe)</h3>
              <p className="text-sm text-slate-400 mt-1">
                Escolha um número de WhatsApp para ser a voz <strong>interna</strong>: os colaboradores conversam com o Coordenador IA para ver e concluir tarefas. Esse número <strong>não</strong> atende clientes.
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {waChannels.length === 0 && (
              <p className="text-sm text-slate-500">Conecte um número de WhatsApp acima para poder designá-lo ao Coordenador IA.</p>
            )}
            {waChannels.map(c => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-200 truncate">{c.name || c.identifier}</p>
                  <p className="text-xs text-slate-500 truncate">{c.identifier} · {c.kind === 'internal' ? 'Interno (equipe)' : 'Atendimento ao cliente'}</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input type="checkbox" className="sr-only peer" checked={c.kind === 'internal'} onChange={e => setChannelKind(c.id, e.target.checked)} />
                  <div className="w-9 h-5 bg-slate-700 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500"></div>
                </label>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-slate-500">Para o Coordenador reconhecer cada colaborador, cadastre o WhatsApp dele em <strong>Configurações → Usuários</strong>.</p>
        </div>

        {/* F2.2 (UI) — Usos por finalidade (channel_feature_bindings) */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="flex items-start gap-3 mb-1">
            <RefreshCw className="w-5 h-5 text-blue-400 mt-0.5" />
            <div>
              <h3 className="text-lg font-semibold text-slate-100">Usos por finalidade (opcional)</h3>
              <p className="text-sm text-slate-400 mt-1">
                Escolha qual número faz cada coisa — atendimento, campanhas, cobrança, agenda… <strong>Sem configurar, tudo segue como está hoje.</strong> Desligar uma finalidade bloqueia só ela, sem afetar as demais.
              </p>
            </div>
          </div>

          {waChannels.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">Conecte um número de WhatsApp acima para configurar os usos.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {/* Lista dos usos configurados */}
              {bindings.length === 0 ? (
                <p className="text-sm text-slate-500">Nenhum uso configurado — o sistema usa o comportamento padrão.</p>
              ) : (
                <ul className="space-y-2">
                  {bindings.map((b: any) => (
                    <li key={b.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-3 gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-200 truncate">{FEATURE_LABELS[b.feature_key] || b.feature_key}</p>
                        <p className="text-xs text-slate-500 truncate">
                          → {channelName(b.channel_id)}
                          {(b.inbound !== 1 || b.outbound !== 1) && (
                            <span className="ml-1 text-slate-400">· {b.inbound === 1 ? 'entrada' : ''}{b.inbound === 1 && b.outbound === 1 ? '+' : ''}{b.outbound === 1 ? 'saída' : ''}{b.inbound !== 1 && b.outbound !== 1 ? 'desligado' : ''}</span>
                          )}
                        </p>
                      </div>
                      <button onClick={() => removeBinding(b.id)} disabled={bindBusy} className="shrink-0 text-slate-400 hover:text-red-400 disabled:opacity-50" title="Remover uso">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Adicionar uso */}
              <div className="flex flex-col md:flex-row gap-2 pt-2 border-t border-slate-800/70">
                <select value={newBindFeature} onChange={e => setNewBindFeature(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 flex-1">
                  <option value="">Finalidade…</option>
                  {bindingFeatures.map(f => <option key={f} value={f}>{FEATURE_LABELS[f] || f}</option>)}
                </select>
                <select value={newBindChannel} onChange={e => setNewBindChannel(e.target.value)}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 flex-1">
                  <option value="">Número…</option>
                  {waChannels.map((c: any) => <option key={c.id} value={c.id}>{c.name || c.identifier}</option>)}
                </select>
                <Button onClick={addBinding} disabled={bindBusy || !newBindFeature || !newBindChannel} className="bg-blue-600 hover:bg-blue-700 text-white shrink-0">
                  {bindBusy ? 'Salvando…' : 'Configurar uso'}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Secao base de conhecimento RAG */}
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-4">
             <BrainCircuit className="w-5 h-5 text-indigo-400" />
             <h3 className="text-lg font-semibold text-slate-100">Base de Conhecimento RAG</h3>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-0 overflow-hidden">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center bg-slate-950/50">
              <div>
                 <h4 className="text-sm font-medium text-slate-200">Gerenciamento de Documentos</h4>
                 <p className="text-xs text-slate-500 mt-1">Faça upload de FAQs, catálogos e regras de negócio para treinar a IA do seu atendimento.</p>
              </div>
               {areas.length > 0 && (
                 <div className="flex items-center gap-3 text-sm">
                   <span className="text-slate-400">Área:</span>
                   <select value={docAreaId} onChange={(e) => setDocAreaId(e.target.value)}
                     className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg focus:ring-primary focus:border-primary block p-2">
                      <option value="">Geral (todas as áreas)</option>
                      {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                   </select>
                 </div>
               )}
            </div>
            
            <div className="p-6">
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept=".txt,.csv,.md,.json"
                onChange={handleFileUpload}
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center border-2 border-dashed border-slate-800 rounded-xl bg-slate-950/30 hover:bg-slate-800/30 transition-colors cursor-pointer py-10 mb-6"
              >
                 <UploadCloud className="w-10 h-10 text-slate-500 mb-4" />
                 <p className="text-sm text-slate-300 font-medium">Arraste seus arquivos de texto (.txt, .csv, .md) para cá</p>
                 <p className="text-xs text-slate-500 mt-1">Os documentos são vetorizados automaticamente e usados pela IA no atendimento.</p>
                 <Button variant="outline" className="mt-6 border-slate-700 text-slate-300 bg-slate-900 hover:text-white" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                   Selecionar Arquivos
                 </Button>
              </div>

              {/* Lista de Documentos Processados */}
              {ragDocuments.length > 0 && (
                <div className="space-y-3">
                  <h5 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Documentos Indexados</h5>
                  {ragDocuments.map(doc => (
                    <div key={doc.id} className="flex items-center justify-between p-3 rounded-lg border border-slate-800 bg-slate-950/50">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center justify-center w-8 h-8 rounded bg-slate-800 border border-slate-700">
                          <FileText className="w-4 h-4 text-slate-400" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-200">{doc.name}</p>
                          <p className="text-xs text-slate-500">{doc.size} • Enviado em {format(new Date(doc.uploadDate), "dd/MM/yyyy HH:mm")}</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-4">
                        <Badge variant="outline" className="border-slate-700 text-slate-400">
                          {doc.channelId === 'global' ? 'Global' : 'Específico'}
                        </Badge>
                        
                        {doc.status === 'processing' ? (
                          <div className="flex items-center text-xs text-indigo-400">
                            <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Processando...
                          </div>
                        ) : doc.status === 'ready' ? (
                          <div className="flex items-center text-xs text-emerald-400">
                            <Check className="w-3 h-3 mr-1" /> Vetorizado
                          </div>
                        ) : (
                          <div className="flex items-center text-xs text-red-400">
                            <X className="w-3 h-3 mr-1" /> Erro
                          </div>
                        )}
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-500 hover:text-red-400 hover:bg-red-400/10" onClick={() => handleDeleteDocument(doc.id)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

      </div>

      {showInstagram && (
        <InstagramConnectModal onClose={() => setShowInstagram(false)} onConnected={fetchChannels} />
      )}
    </div>
  );
}

// Console de diagnóstico dos webhooks Meta: mostra os últimos hits que a
// plataforma da Meta bateu no nosso endpoint /api/webhooks/meta — GET (verify)
// e POST (evento). Serve para responder "a Meta está mandando ou não?" quando
// uma DM aparentemente não chega. Sem isto, um webhook rejeitado silenciosamente
// (payload de objeto errado, verify token divergente, etc.) parece que "não
// veio nada" — foi exatamente o cenário do bug de DM do Instagram.
function MetaWebhookDiagnostics() {
  // Fonte única de verdade (ADR-106): flag do servidor, não e-mail hardcoded.
  // O backend já reforça via requireMasterAdmin; isto só controla a exibição.
  const isMasterAdmin = useStore((s) => s.isMasterAdmin);
  const [hits, setHits] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/meta-debug/hits?limit=50').then(x => x.json());
      setHits(Array.isArray(r?.hits) ? r.hits : []);
      setSummary(r?.summary || null);
    } catch { /* silencioso */ }
    finally { setLoading(false); }
  };
  useEffect(() => { if (isMasterAdmin) load(); }, [isMasterAdmin]);

  // Diagnóstico técnico da plataforma (payload global, pode ter PII de lead
  // entre tenants) — só o Master Admin enxerga (ADR-098).
  if (!isMasterAdmin) return null;

  const deleteOne = async (id: string) => {
    if (!(await confirmDialog('Apagar este hit do diagnóstico?'))) return;
    try {
      const r = await apiFetch(`/api/meta-debug/hits/${id}`, { method: 'DELETE' });
      if (r.ok) { setHits(hs => hs.filter(h => h.id !== id)); toast.success('Hit removido.'); }
      else toast.error('Falha ao remover.');
    } catch { toast.error('Falha ao remover.'); }
  };

  const clearAll = async () => {
    if (!(await confirmDialog('Limpar TODOS os hits do diagnóstico? Isso não afeta os webhooks futuros — a lista volta a encher conforme a Meta chama.'))) return;
    try {
      const r = await apiFetch('/api/meta-debug/hits', { method: 'DELETE' });
      if (r.ok) { setHits([]); setSummary(null); toast.success('Diagnóstico limpo.'); }
      else toast.error('Falha ao limpar.');
    } catch { toast.error('Falha ao limpar.'); }
  };

  const timeAgo = (iso: string) => {
    try {
      const t = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).getTime();
      const s = Math.round((Date.now() - t) / 1000);
      if (s < 60) return `${s}s atrás`;
      if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
      if (s < 86400) return `${Math.floor(s / 3600)}h atrás`;
      return `${Math.floor(s / 86400)}d atrás`;
    } catch { return iso; }
  };

  return (
    <div className="flex flex-col rounded-xl border border-emerald-900/40 bg-slate-900/50 p-6 relative overflow-hidden lg:col-span-2 mt-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-100 flex items-center gap-2">🩺 Diagnóstico Webhooks Meta</h3>
          <p className="text-xs text-slate-400 mt-1">
            Últimos hits que a Meta bateu em <code className="text-emerald-400">/api/webhooks/meta</code>. Se a lista estiver <b>vazia depois de você enviar DM</b>, a Meta não está enviando (config do app na Meta / conta em "solicitações"). Se aparecer hit mas com erro, o problema está no processamento.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="border-slate-700 text-slate-200">
            {loading ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />} Atualizar
          </Button>
          {hits.length > 0 && (
            <Button variant="outline" size="sm" onClick={clearAll} className="border-red-800/50 text-red-300 hover:bg-red-500/10">
              <Trash2 className="w-4 h-4 mr-1" /> Limpar tudo
            </Button>
          )}
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Últimas 24h</div>
            <div className="text-lg font-semibold text-slate-100">{summary.last24h}</div>
          </div>
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Último hit</div>
            <div className="text-sm text-slate-100">{summary.lastAt ? timeAgo(summary.lastAt) : '—'}</div>
          </div>
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Por método</div>
            <div className="text-xs text-slate-100">{Object.entries(summary.byMethod || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</div>
          </div>
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Por origem</div>
            <div className="text-xs text-slate-100">{Object.entries(summary.byObject || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</div>
          </div>
        </div>
      )}

      {hits.length === 0 ? (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 text-sm text-yellow-200">
          Nenhum hit registrado ainda. Isso significa que a Meta <b>não está chamando</b> nosso servidor. Cheque: (1) URL do webhook no painel da Meta = <code>https://SEU_DOMINIO/api/webhooks/meta</code>; (2) app do Instagram com Seção 3 verificada (verde); (3) conta subscrita ao webhook em Seção 2; (4) DM não caiu em "Solicitações de mensagens" na conta do Instagram.
        </div>
      ) : (
        <div className="space-y-2">
          {hits.map((h) => {
            const isExp = expanded === h.id;
            let payload: any = {};
            try { payload = JSON.parse(h.payload_json || '{}'); } catch { payload = { _raw: h.payload_json }; }
            return (
              <div key={h.id} className={`rounded-lg border ${h.error ? 'border-red-500/30 bg-red-500/5' : h.processed ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-slate-700 bg-slate-950/40'} p-3`}>
                <div className="flex items-center justify-between gap-3">
                  <button onClick={() => setExpanded(isExp ? null : h.id)} className="flex-1 min-w-0 text-left flex items-center gap-3">
                    <Badge variant="outline" className={h.method === 'GET' ? 'border-blue-500/30 text-blue-300' : 'border-purple-500/30 text-purple-300'}>{h.method}</Badge>
                    <span className="text-xs text-slate-400 shrink-0">{timeAgo(h.received_at)}</span>
                    <span className="text-xs text-slate-300 truncate">object=<code className="text-slate-100">{h.object || '—'}</code></span>
                    {h.error ? <span className="text-xs text-red-300 truncate">✗ {h.error}</span>
                      : h.processed ? <span className="text-xs text-emerald-300">✓ processado</span>
                      : <span className="text-xs text-slate-400">pendente</span>}
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => deleteOne(h.id)} title="Apagar este hit" className="text-slate-500 hover:text-red-400 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setExpanded(isExp ? null : h.id)} className="text-xs text-slate-500">{isExp ? '▲' : '▼'}</button>
                  </div>
                </div>
                {isExp && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-slate-400">Origem: <span className="text-slate-200">{h.source_ip || '—'}</span> · UA: <span className="text-slate-200">{(h.user_agent || '—').slice(0, 80)}</span></div>
                    <div className="text-xs text-slate-400 mb-1">Payload:</div>
                    <pre className="text-xs bg-slate-950 border border-slate-800 rounded p-3 overflow-x-auto text-slate-200 max-h-96">{JSON.stringify(payload, null, 2)}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
