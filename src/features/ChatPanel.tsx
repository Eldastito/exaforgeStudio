import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '@/src/store/useStore';
import { Button } from '@/src/components/ui/button';
import { Send, Sparkles, Paperclip, Mic, User, BrainCircuit, X } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { suggestResponse, summarizeConversation } from '@/src/lib/gemini';

export function ChatPanel() {
  const { activeTicketId, tickets, contacts, messages, sendMessage } = useStore();
  const [inputText, setInputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeTicket = activeTicketId ? tickets[activeTicketId] : null;

  // Clear summary when switching tickets
  useEffect(() => {
    setSummary(null);
  }, [activeTicketId]);
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
      const suggestion = await suggestResponse(activeContact, activeMessages.slice(-5));
      setInputText(suggestion);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSummarize = async () => {
    setIsSummarizing(true);
    try {
      const result = await summarizeConversation(activeMessages);
      setSummary(result);
    } catch (e) {
      console.error(e);
    } finally {
      setIsSummarizing(false);
    }
  };

  return (
    <div className="flex h-full w-[400px] min-w-[400px] flex-col border-l border-zinc-800 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 p-4">
        <div className="flex items-center gap-3">
          {activeContact.avatar ? (
            <img src={activeContact.avatar} alt="" className="h-10 w-10 rounded-full border border-zinc-800" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800">
              <User className="h-5 w-5 text-zinc-400" />
            </div>
          )}
          <div>
            <h3 className="font-medium text-zinc-100">{activeContact.name}</h3>
            <span className="text-xs text-zinc-500">{activeContact.number}</span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
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
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.text}</p>
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
    </div>
  );
}

// Needed because I used MessageCircle above without importing it earlier
import { MessageCircle } from 'lucide-react';
