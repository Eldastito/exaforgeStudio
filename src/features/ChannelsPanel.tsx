import React, { useState, useRef, useEffect } from 'react';
import { toast, confirmDialog } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';
import { Smartphone, Instagram, AlertCircle, CheckCircle2, RefreshCw, UploadCloud, BrainCircuit, FileText, Loader2, Check, X } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Badge } from '@/src/components/ui/badge';
import { format } from 'date-fns';
import { apiFetch } from '@/src/lib/api';
import { InstagramConnectModal } from '@/src/features/InstagramConnectModal';

export function ChannelsPanel() {
  const { channels, ragDocuments, addRagDocument, setRagDocumentStatus, removeRagDocument, loadRagDocuments, fetchChannels, updateChannel, removeChannel } = useStore();

  const handleDisconnect = async (id: string, label: string) => {
    if (!(await confirmDialog(`Desconectar ${label}? O canal será removido e as mensagens deixarão de chegar até reconectar.`, { danger: true }))) return;
    removeChannel(id);
  };
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [evolutionStatus, setEvolutionStatus] = useState<'disconnected' | 'connecting_evo' | 'connected_evo'>('disconnected');
  const [evolutionQr, setEvolutionQr] = useState<string | null>(null);
  const [showInstagram, setShowInstagram] = useState(false);
  const [forwardWhats, setForwardWhats] = useState('');

  useEffect(() => {
    fetchChannels();
    loadRagDocuments();
    apiFetch('/api/channels/forward-whatsapp').then(r => r.json()).then(d => setForwardWhats(d.forward_whatsapp || '')).catch(() => {});
  }, []);

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
                    <h3 className="text-lg font-semibold text-slate-100">WhatsApp Ilimitado (Evolution API / Go)</h3>
                    <p className="text-sm text-slate-400">Motor não-oficial para envio gratuito</p>
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

            <div className="text-sm text-slate-300 mb-6 relative z-10 bg-slate-950/50 p-4 rounded-lg border border-yellow-800/80">
              <p className="font-semibold text-yellow-500 mb-2">Atenção: Limitações da Evolution</p>
              <ol className="list-decimal pl-4 space-y-2 text-xs md:text-sm">
                <li>Uma instância da Evolution representa <strong>exatamente 1 número de WhatsApp conectado</strong>. Não é possível conectar vários números diferentes na mesma instância.</li>
                <li>Se você deseja atender vários clientes isoladamente com diferentes números, precisará criar <strong>múltiplas instâncias</strong> lá na Evolution e adaptar este sistema.</li>
                <li>Deixamos pré-configurado com a URL e Instância <code>ExaForge</code> solicitadas, ou seja, vai conectar a apenas ao número associado ao ExaForge.</li>
              </ol>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 relative z-10 flex-1">
               <div className="space-y-2 md:col-span-2">
                 <label className="text-xs text-slate-400 font-medium">3. Nome da Instância (Instance Name)</label>
                 <input 
                   type="text" 
                   defaultValue="ExaForge"
                   id="evo_inst"
                   placeholder="Ex: whatsapp01"
                   className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 transition-colors" 
                 />
               </div>
            </div>

            {/* Area de QR Code do Evolution */}
            {evolutionStatus === 'connecting_evo' ? (
              <div className="mt-6 flex flex-col items-center justify-center p-6 bg-white/5 rounded-xl border border-slate-800">
                {evolutionQr ? (
                  <>
                    <div className="bg-white p-2 rounded-xl mb-4">
                      <img src={evolutionQr} alt="QR Code" className="w-48 h-48" />
                    </div>
                    <p className="text-sm font-medium text-slate-200">Leia o QR Code com o WhatsApp</p>
                    <p className="text-xs text-slate-400 text-center mt-1">Logo após a leitura, a conexão estará ativa (aguarde uns segundos).</p>
                  </>
                ) : (
                  <>
                    <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-3" />
                    <p className="text-sm text-slate-300">Solicitando QR Code na Evolution Go...</p>
                  </>
                )}
              </div>
            ) : evolutionStatus === 'connected_evo' ? (
              <div className="mt-6 flex flex-col items-center justify-center p-6 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
                <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-3" />
                <p className="text-sm font-medium text-slate-200">Instância Conectada!</p>
                <p className="text-xs text-emerald-400 text-center mt-1">O WhatsApp está vinculado com sucesso.</p>
              </div>
            ) : null}

            <div className="mt-6 pt-6 border-t border-slate-800 flex flex-col md:flex-row gap-4 relative z-10 w-full justify-stretch">
               <Button 
                variant="outline"
                className="flex-1 bg-slate-900 hover:bg-slate-800 text-slate-300 border-slate-700 transition-colors h-11" 
                onClick={async () => {
                  const instanceName = (document.getElementById('evo_inst') as HTMLInputElement).value;
                  
                  try {
                    await fetch('/api/evolution/config', { 
                      method: 'POST', 
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ instanceName })
                    });
                    toast.success('Configuração Salva! Siga para o Passo 4.');
                  } catch (e) {
                    console.error(e);
                  }
                }}
               >
                 Salvar Configurações
               </Button>
               
               <Button 
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white border-0 transition-colors h-11" 
                onClick={async () => {
                  setEvolutionStatus('connecting_evo');
                  setEvolutionQr(null);
                  
                  const instanceName = (document.getElementById('evo_inst') as HTMLInputElement).value;

                  try {
                    const resp = await fetch('/api/evolution/instance/connect', { 
                      method: 'POST', 
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ instanceName })
                    });
                    const data = await resp.json();
                    
                    if (data.base64) {
                       setEvolutionQr(data.base64);
                    } else if (data.instance?.state === 'open' || data.state === 'open') {
                       setEvolutionStatus('connected_evo');
                    } else {
                       toast.error('Não foi possível gerar QR Code. Talvez a instância já esteja conectada?');
                       setEvolutionStatus('disconnected');
                    }
                  } catch (e) {
                    console.error(e);
                    toast.error('Erro ao conectar Evolution.');
                    setEvolutionStatus('disconnected');
                  }
                }}
               >
                 Conectar / Gerar QR Code
               </Button>
            </div>
            
            <div className="bg-slate-950 border border-slate-800 p-3 rounded-lg mt-4 h-full">
              <p className="text-xs text-slate-400 font-medium mb-1">Passo 4. URL de Webhook para colocar na Evolution:</p>
              <code className="text-[11px] text-blue-400 break-all select-all font-mono">
                {window.location.origin}/api/webhooks/evolution
              </code>
              <p className="text-[10px] text-slate-500 mt-2">Dica: O botão "Conectar" já tenta auto-configurar o Webhook, mas é sempre bom confirmar.</p>
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
                className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500 w-64"
              />
              <Button onClick={saveForward} className="bg-emerald-600 hover:bg-emerald-700 text-white">Salvar</Button>
            </div>
          </div>
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
               <div className="flex items-center gap-3 text-sm">
                 <span className="text-slate-400">Canal:</span>
                 <select className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg focus:ring-primary focus:border-primary block p-2">
                    <option>Global (Todos os Canais)</option>
                    <option>Somente WhatsApp</option>
                    <option>Somente Instagram</option>
                 </select>
               </div>
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
