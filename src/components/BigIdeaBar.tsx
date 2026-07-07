import { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Sparkles, Loader2, RefreshCw } from 'lucide-react';

// Big Idea Bar (Knaflic) — cabeçalho gerado por IA que sintetiza o dado
// do painel em UMA frase ("e daí?") + ação recomendada. Não substitui os
// gráficos; antecede eles com significado. Cachea por hash do dado no
// backend, então re-renders da UI não custam LLM.

interface Props {
  panelKey: string;
  data: any;
  className?: string;
  /** Quando true, mostra botão de regenerar (força chamada nova ignorando cache). */
  allowRegenerate?: boolean;
}

interface BigIdea {
  headline: string;
  recommendedAction: string;
  confidence: number;
  createdAt: string;
  stale?: boolean;
}

export function BigIdeaBar({ panelKey, data, className = '', allowRegenerate = true }: Props) {
  const [idea, setIdea] = useState<BigIdea | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const fetchIdea = async (force = false) => {
    setLoading(!force);
    setRegenerating(force);
    try {
      const res = await apiFetch('/api/big-idea/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panel_key: panelKey, data, force }),
      });
      const d = await res.json().catch(() => null);
      setIdea(d && d.headline ? d : null);
    } catch { /* silent */ }
    finally { setLoading(false); setRegenerating(false); }
  };

  useEffect(() => {
    // Só refetch se panel_key mudar OU o hash do data mudar significativamente.
    fetchIdea(false);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [panelKey, JSON.stringify(data)]);

  if (loading && !idea) {
    return (
      <div className={`rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 flex items-center gap-3 ${className}`}>
        <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
        <span className="text-sm text-purple-300">Interpretando o dado…</span>
      </div>
    );
  }

  if (!idea) return null;

  const confColor = idea.confidence >= 80 ? 'text-emerald-400' : idea.confidence >= 60 ? 'text-amber-400' : 'text-orange-400';

  return (
    <div className={`rounded-xl border border-purple-500/30 bg-gradient-to-r from-purple-500/10 to-indigo-500/5 p-4 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="rounded-lg bg-purple-500/20 p-2 shrink-0">
            <Sparkles className="w-4 h-4 text-purple-300" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-[10px] uppercase tracking-wide text-purple-300 font-semibold">💡 Big Idea (Knaflic)</span>
              <span className={`text-[10px] ${confColor}`}>confiança {idea.confidence}%</span>
              {idea.stale && <span className="text-[10px] text-amber-300 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded">gerada com dado antigo</span>}
            </div>
            <p className="text-sm text-zinc-100 font-medium leading-snug">{idea.headline}</p>
            {idea.recommendedAction && (
              <p className="text-xs text-zinc-300 mt-1.5 leading-relaxed"><span className="text-purple-300 font-semibold">Ação recomendada: </span>{idea.recommendedAction}</p>
            )}
          </div>
        </div>
        {allowRegenerate && (
          <button onClick={() => fetchIdea(true)} disabled={regenerating}
            title="Gerar nova leitura"
            className="text-xs text-zinc-400 hover:text-zinc-100 shrink-0 inline-flex items-center gap-1">
            {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
        )}
      </div>
    </div>
  );
}
