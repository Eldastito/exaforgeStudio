import { useEffect, useRef, useState } from 'react';
import { Sparkles, RefreshCw, Send, Zap } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { Skeleton } from '@/src/components/ui/Skeleton';

type QA = { role: 'user' | 'ai'; text: string };

/**
 * Painel fixo do Diretor Executivo IA (não chat escondido). Mostra o briefing
 * do dia — que já inclui os números do RIC, pois o BusinessContextService injeta
 * o snapshot — e permite uma pergunta inline. CTA "Recuperar Agora" rola até as
 * Top 5 ações priorizadas. Voz ciano + glow, conforme o PRD UX/UI.
 */
export function DirectorPanel({ onRecover }: { onRecover?: () => void }) {
  const [briefing, setBriefing] = useState('');
  const [loading, setLoading] = useState(true);
  const [qa, setQa] = useState<QA[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const loadBriefing = () => {
    setLoading(true);
    apiFetch('/api/executive/briefing')
      .then(r => r.json())
      .then(d => setBriefing(d.text || ''))
      .catch(() => setBriefing(''))
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadBriefing(); }, []);
  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }); }, [qa, thinking]);

  const ask = async () => {
    const q = input.trim();
    if (!q || thinking) return;
    setInput('');
    setQa(m => [...m, { role: 'user', text: q }]);
    setThinking(true);
    try {
      const res = await apiFetch('/api/executive/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const d = await res.json();
      setQa(m => [...m, { role: 'ai', text: d.text || 'Sem resposta.' }]);
    } catch {
      setQa(m => [...m, { role: 'ai', text: 'Não consegui responder agora.' }]);
    } finally {
      setThinking(false);
    }
  };

  return (
    <div className="flex flex-col rounded-ric-hero border border-ric-ai/30 bg-ric-surface-2 p-5 ric-ai-glow lg:col-span-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-ric-ai" />
          <p className="text-sm font-semibold text-ric-ai">Diretor Executivo IA</p>
        </div>
        <button onClick={loadBriefing} title="Atualizar" className="text-slate-500 hover:text-slate-300">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div ref={bodyRef} className="custom-scroll mt-4 max-h-[260px] flex-1 overflow-y-auto pr-1">
        {loading ? (
          <>
            <Skeleton className="h-3 w-full bg-slate-700/30" />
            <Skeleton className="mt-2 h-3 w-5/6 bg-slate-700/30" />
            <Skeleton className="mt-2 h-3 w-4/6 bg-slate-700/30" />
          </>
        ) : (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-200">
            {briefing || 'Sem dados suficientes ainda. Conforme o sistema for usado, o briefing fica mais rico.'}
          </p>
        )}

        {qa.map((m, i) => (
          <div key={i} className={`mt-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[90%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[12px] leading-relaxed ${
              m.role === 'user' ? 'bg-ric-primary text-white' : 'border border-ric-border bg-ric-bg/60 text-slate-200'
            }`}>
              {m.text}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="mt-3 flex items-center gap-2 text-[12px] text-slate-400">
            <RefreshCw className="h-3 w-3 animate-spin" /> Analisando…
          </div>
        )}
      </div>

      <button
        onClick={onRecover}
        className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-ric-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-ric-primary-2"
      >
        <Zap className="h-4 w-4" /> Recuperar Agora
      </button>

      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') ask(); }}
          placeholder="Pergunte ao seu Diretor IA…"
          className="flex-1 rounded-lg border border-ric-border bg-ric-bg px-3 py-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-ric-ai/50"
        />
        <button
          onClick={ask}
          disabled={thinking || !input.trim()}
          className="rounded-lg border border-ric-border bg-ric-bg px-3 text-slate-300 hover:text-ric-ai disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
