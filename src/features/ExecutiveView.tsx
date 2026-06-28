import React, { useEffect, useState, useRef } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { BrainCircuit, Send, Sparkles, RefreshCw } from 'lucide-react';

type Msg = { role: 'user' | 'ai'; text: string };

const SUGESTOES = [
  'Por que minhas vendas mudaram este mês?',
  'Onde estou perdendo dinheiro?',
  'Quais clientes têm risco de cancelar?',
  'O que devo priorizar hoje?',
  'Qual produto devo promover?',
];

export function ExecutiveView() {
  const [briefing, setBriefing] = useState<string>('');
  const [loadingBriefing, setLoadingBriefing] = useState(true);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadBriefing = () => {
    setLoadingBriefing(true);
    apiFetch('/api/executive/briefing').then(r => r.json()).then(d => setBriefing(d.text || '')).catch(() => {}).finally(() => setLoadingBriefing(false));
  };
  useEffect(() => { loadBriefing(); }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, thinking]);

  const ask = async (q: string) => {
    const question = (q ?? input).trim();
    if (!question || thinking) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text: question }]);
    setThinking(true);
    try {
      const res = await apiFetch('/api/executive/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      const d = await res.json();
      setMessages(m => [...m, { role: 'ai', text: d.text || 'Sem resposta.' }]);
    } catch {
      setMessages(m => [...m, { role: 'ai', text: 'Não consegui responder agora. Tente de novo.' }]);
    } finally { setThinking(false); }
  };

  return (
    <div className="flex-1 flex flex-col bg-zinc-950 overflow-hidden">
      <div className="p-6 border-b border-zinc-800">
        <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <BrainCircuit className="h-6 w-6 text-indigo-400" /> Diretor Executivo IA
        </h2>
        <p className="text-sm text-zinc-400 mt-1">Pergunte qualquer coisa sobre o seu negócio. As respostas usam os dados reais do sistema — nada é inventado.</p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* Briefing do dia */}
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-indigo-300 flex items-center gap-2"><Sparkles className="h-4 w-4" /> Briefing de hoje</p>
            <button onClick={loadBriefing} className="text-zinc-500 hover:text-zinc-300" title="Atualizar"><RefreshCw className={`h-4 w-4 ${loadingBriefing ? 'animate-spin' : ''}`} /></button>
          </div>
          {loadingBriefing ? (
            <p className="text-sm text-zinc-500">Analisando seu negócio…</p>
          ) : (
            <p className="text-sm text-zinc-200 whitespace-pre-wrap leading-relaxed">{briefing || 'Sem dados suficientes ainda. Conforme o sistema for usado, o briefing fica mais rico.'}</p>
          )}
        </div>

        {/* Conversa */}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-zinc-800 text-zinc-100 rounded-tl-sm border border-zinc-700'}`}>
              {m.text}
            </div>
          </div>
        ))}
        {thinking && <div className="flex justify-start"><div className="bg-zinc-800 border border-zinc-700 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm text-zinc-400 flex items-center gap-2"><RefreshCw className="h-3 w-3 animate-spin" /> Analisando os dados…</div></div>}

        {/* Sugestões (só quando ainda não conversou) */}
        {messages.length === 0 && !thinking && (
          <div className="flex flex-wrap gap-2 pt-2">
            {SUGESTOES.map(s => (
              <button key={s} onClick={() => ask(s)} className="text-xs px-3 py-1.5 rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">{s}</button>
            ))}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-4 border-t border-zinc-800">
        <div className="flex gap-2">
          <textarea
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-100 resize-none h-12 focus:border-indigo-500 outline-none"
            placeholder="Pergunte ao seu Diretor IA…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); } }}
          />
          <Button onClick={() => ask(input)} disabled={thinking || !input.trim()} className="bg-indigo-600 hover:bg-indigo-700 text-white h-12 px-4">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
