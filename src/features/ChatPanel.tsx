import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '@/src/store/useStore';
import { Button } from '@/src/components/ui/button';
import { Send, Sparkles, Paperclip, Mic, BrainCircuit, X, MessageCircle, Hand, Bot, CheckCircle, ArrowLeft } from 'lucide-react';
import { Avatar } from '@/src/components/ui/Avatar';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function ChatPanel() {
  const { activeTicketId, tickets, contacts, messages, sendMessage, takeOverTicket, returnToAI, closeTicket, loadMessages, setActiveTicket } = useStore();
  const [inputText, setInputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closeReason, setCloseReason] = useState('');
  const [closeStatus, setCloseStatus] = useState<'entregue_concluido' | 'perdido'>('entregue_concluido');
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeTicket = activeTicketId ? tickets[activeTicketId] : null;

  // Clear summary when switching tickets + carrega o histórico real do banco
  useEffect(() => {
    setSummary(null);
    if (activeTicketId) loadMessages(activeTicketId);
  }, [activeTicketId, loadMessages]);
  const activeContact = activeTicket ? contacts[activeTicket.contactId] : null;
  const activeMessages = activeTicketId ? (messages[activeTicketId] || []) : [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activeMessages]);

  if (!activeTicket || !activeContact) {
    return (
      <div className="flex h-full w-[400px] flex-col items-center justify-center border-l border-zinc-800 bg-zinc-950/50 p-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-900 mb-4">
          <MessageCircle className="h-8 w-8 text-zinc-600" />
        </div>
        <h3 className="text-lg font-medium text-zinc-300">Selecione uma conversa</h3>
        <p className="text-sm text-zinc-500 mt-2">Clique em um card no Kanban para visualizar o histórico e responder.</p>
      </div>
    );
  }

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputText.trim()) return;
    sendMessage(activeTicketId, inputText, 'human');
    setInputText('');
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      handleSend();
    }
  };

  const generateSuggestion = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch('/api/ai/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: activeContact, history: activeMessages.slice(-5) }),
      });
      if (!res.ok) throw new Error(`Falha na sugestão: ${res.status}`);
      const data = await res.json();
      setInputText(data.text || '');
    } catch (e) {
      console.error(e);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSummarize = async () => {
    setIsSummarizing(true);
    try {
      const res = await fetch('/api/ai/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: activeMessages }),
      });
      if (!res.ok) throw new Error(`Falha no resumo: ${res.status}`);
      const data = await res.json();
      setSummary(data.text || '');
    } catch (e) {
      console.error(e);
    } finally {
      setIsSummarizing(false);
    }
  };

  return (
    <div className="flex h-full w-full lg:w-[400px] lg:min-w-[400px] flex-col border-l border-zinc-800 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 p-4">
        <div className="flex items-center gap-3">
          {/* Voltar (somente mobile) */}
          <button onClick={() => setActiveTicket(null)} className="lg:hidden -ml-1 p-1 text-zinc-400 hover:text-zinc-100" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Avatar name={activeContact.name} src={activeContact.avatar} size={40} className="border border-zinc-800" />
          <div>
            <h3 className="font-medium text-zinc-100">{activeContact.name}</h3>
            <span className="text-xs text-zinc-500">{activeContact.number}</span>
          </div>
        </div>
        
        <div className="flex flex-col items-end gap-2">
           {!activeTicket?.aiPaused ? (
             <Button variant="outline" size="sm" className="h-7 text-xs bg-zinc-900 border-zinc-700 hover:bg-zinc-800" onClick={() => takeOverTicket(activeTicketId)}>
                <Hand className="w-3 h-3 mr-2" />
                Assumir (Handoff)
             </Button>
           ) : (
             <div className="flex items-center gap-2">
               <Button variant="outline" size="sm" className="h-7 text-xs bg-zinc-900 border-zinc-700 hover:bg-zinc-800 text-indigo-400" onClick={() => returnToAI(activeTicketId)}>
                  <Bot className="w-3 h-3 mr-2" />
                  Devolver IA
               </Button>
               <Button variant="default" size="sm" className="h-7 text-xs bg-green-600 hover:bg-green-700" onClick={() => setShowCloseModal(true)}>
                  <CheckCircle className="w-3 h-3 mr-2" />
                  Finalizar
               </Button>
             </div>
           )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Transição Invisível: resumo da IA para quem assume o atendimento, sem
            o cliente precisar repetir a história. */}
        {activeTicket?.aiPaused && activeTicket?.handoffSummary && (
          <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-3 text-xs text-zinc-200">
            <div className="mb-1.5 flex items-center gap-2 font-medium text-indigo-300">
              <BrainCircuit className="h-3.5 w-3.5" />
              Contexto do cliente (resumo da IA)
            </div>
            <p className="whitespace-pre-wrap leading-relaxed text-zinc-300">{activeTicket.handoffSummary}</p>
          </div>
        )}
        {activeMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Nenhuma mensagem ainda.
          </div>
        ) : (
          activeMessages.map((msg) => {
            const isContact = msg.sender === 'contact';
            const isBot = msg.sender === 'bot';
            return (
              <div key={msg.id} className={`flex flex-col ${isContact ? 'items-start' : 'items-end'}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-zinc-500">
                    {format(new Date(msg.timestamp), "HH:mm")}
                  </span>
                  {!isContact && isBot && (
                    <span className="text-[10px] text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">Bot</span>
                  )}
                </div>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm shadow-sm
                    ${isContact ? 'bg-zinc-800 text-zinc-100 rounded-tl-sm border border-zinc-700' :
                      isBot ? 'bg-zinc-700 text-zinc-100 rounded-tr-sm' : 'bg-primary text-primary-foreground rounded-tr-sm'}`}
                >
                  {msg.mediaUrl && (
                    <a href={msg.mediaUrl} target="_blank" rel="noreferrer">
                      <img src={msg.mediaUrl} alt="imagem" className="mb-2 max-h-60 w-auto rounded-lg border border-zinc-600/50" />
                    </a>
                  )}
                  {msg.text && <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 p-4">
        {summary && (
          <div className="mb-4 bg-indigo-950/30 border border-indigo-500/20 rounded-lg p-3 relative">
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-6 w-6 absolute top-2 right-2 text-indigo-400 hover:text-indigo-300"
              onClick={() => setSummary(null)}
            >
              <X className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2 mb-2 text-indigo-400">
              <BrainCircuit className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-wider">Resumo da Conversa</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-zinc-300">
              {summary}
            </p>
          </div>
        )}

        {/* Actions inside input area */}
        <div className="mb-2 flex items-center justify-start gap-2">
          <Button 
            variant="ghost" 
            size="sm" 
            className="text-xs text-zinc-400 hover:text-zinc-100 h-7"
            onClick={generateSuggestion}
            disabled={isGenerating}
          >
            <Sparkles className={`mr-2 h-3 w-3 ${isGenerating ? 'animate-spin' : 'text-purple-400'}`} />
            {isGenerating ? 'Gerando...' : 'Sugerir Resposta'}
          </Button>
          <Button 
            variant="ghost" 
            size="sm" 
            className="text-xs text-zinc-400 hover:text-zinc-100 h-7"
            onClick={handleSummarize}
            disabled={isSummarizing || activeMessages.length === 0}
          >
            <BrainCircuit className={`mr-2 h-3 w-3 ${isSummarizing ? 'animate-spin' : 'text-indigo-400'}`} />
            {isSummarizing ? 'Resumindo...' : 'Resumir Thread'}
          </Button>
        </div>
        
        <form onSubmit={handleSend} className="relative flex items-end gap-2 bg-zinc-900 border border-zinc-800 rounded-xl p-1 focus-within:border-zinc-500 transition-colors">
          <div className="flex flex-col justify-end pb-1">
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-zinc-100">
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>
          
          <textarea
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyPress}
            placeholder="Digite sua mensagem (/ para templates)..."
            className="max-h-[150px] min-h-[40px] flex-1 resize-none bg-transparent py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            rows={1}
          />

          <div className="flex flex-col justify-end pb-1 pr-1">
             {inputText.trim() ? (
                <Button type="submit" size="icon" className="h-8 w-8 rounded-lg bg-primary hover:bg-primary/90">
                  <Send className="h-4 w-4 ml-0.5" />
                </Button>
             ) : (
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-zinc-400 hover:text-zinc-100">
                  <Mic className="h-4 w-4" />
                </Button>
             )}
          </div>
        </form>
        <div className="mt-2 text-center text-[10px] text-zinc-600">
          Enter para enviar, Shift+Enter para quebrar linha
        </div>
      </div>

      {/* Close Modal */}
      {showCloseModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
           <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[320px]">
              <h3 className="text-lg font-semibold text-zinc-100 mb-4">Finalizar Atendimento</h3>
              <div className="space-y-4">
                 <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Status</label>
                    <select className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={closeStatus} onChange={(e: any) => setCloseStatus(e.target.value)}>
                       <option value="entregue_concluido">Sucesso / Fechado</option>
                       <option value="perdido">Perdido</option>
                    </select>
                 </div>
                 <div>
                    <label className="text-sm text-zinc-400 mb-1 block">Motivo</label>
                    <textarea 
                       className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none h-20" 
                       placeholder="Motivo do fechamento"
                       value={closeReason}
                       onChange={(e) => setCloseReason(e.target.value)}
                    />
                 </div>
                 <div className="flex gap-2 justify-end pt-2">
                    <Button variant="ghost" onClick={() => setShowCloseModal(false)}>Cancelar</Button>
                    <Button variant="default" className="bg-primary hover:bg-primary/90" onClick={() => {
                       closeTicket(activeTicketId, closeReason, closeStatus);
                       setShowCloseModal(false);
                    }}>Confirmar</Button>
                 </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
}
