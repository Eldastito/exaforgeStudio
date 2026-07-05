import { useEffect, useState } from 'react';
import { ArrowUpRight, Inbox, Loader2, Send, UserPlus } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { brl, RIC_TONE } from '../lib/format';

interface TopAction {
  rank: number;
  sourceKey: string;
  action: string;
  label: string;
  amount: number;
  contactsCount: number;
  impactPercent: number;
}

// Mapeamento tom por fonte de perda.
const TONE_BY_SOURCE: Record<string, keyof typeof RIC_TONE> = {
  slow_response: 'risk',
  stale_quotes: 'recoverable',
  abandoned: 'recoverable',
  inactive: 'risk',
};

/**
 * Top 5 acoes prioritarias — agora consumidas do endpoint server-side
 * /api/analytics/revenue-intelligence/top-actions. Mostra impacto % e
 * contagem de contatos alem do valor em R$.
 */
export function TopActionsList({ period, onAct, actingKey, onDelegate }: {
  period: string;
  onAct?: (sourceKey: string) => void;
  actingKey?: string | null;
  onDelegate?: (sourceKey: string, label: string) => void;
}) {
  const [actions, setActions] = useState<TopAction[] | null>(null);

  useEffect(() => {
    let alive = true;
    setActions(null);
    apiFetch(`/api/analytics/revenue-intelligence/top-actions?period=${period}`)
      .then(r => r.json())
      .then((data: TopAction[]) => { if (alive) setActions(Array.isArray(data) ? data : []); })
      .catch(() => { if (alive) setActions([]); });
    return () => { alive = false; };
  }, [period]);

  if (actions === null) {
    return (
      <div className="mt-4 space-y-3">
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-7 w-7 rounded-full bg-slate-700/40" />
            <Skeleton className="h-4 flex-1 bg-slate-700/30" />
            <Skeleton className="h-4 w-20 bg-slate-700/30" />
          </div>
        ))}
      </div>
    );
  }

  if (actions.length === 0) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center py-8 text-center">
        <Inbox className="h-6 w-6 text-slate-600" />
        <p className="mt-2 text-sm text-slate-500">Nenhuma perda relevante no periodo. Bom sinal.</p>
        <p className="text-xs text-slate-600">Conforme houver movimento, as acoes de maior retorno aparecem aqui.</p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      {actions.map((a) => {
        const tone = TONE_BY_SOURCE[a.sourceKey] || 'info';
        return (
          <div
            key={a.sourceKey}
            className="flex items-center gap-3 rounded-xl border border-ric-border bg-ric-bg/40 px-3 py-2.5 transition-colors hover:bg-ric-bg/70"
          >
            <span
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold"
              style={{ color: RIC_TONE[tone], backgroundColor: `${RIC_TONE[tone]}1f` }}
            >
              {a.rank}
            </span>
            <div className="flex flex-1 flex-col">
              <span className="text-sm text-slate-200">{a.action}</span>
              <span className="text-[11px] text-slate-500">
                {a.contactsCount} contato(s) · {a.impactPercent}% do risco
              </span>
            </div>
            <span className="text-sm font-bold tabular-nums" style={{ color: RIC_TONE[tone] }}>
              {brl(a.amount)}
            </span>
            {onDelegate && (
              <button
                onClick={() => onDelegate(a.sourceKey, a.action)}
                title="Criar uma tarefa interna para a equipe cuidar disso"
                className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-slate-600/50 bg-slate-700/20 px-2.5 py-1 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-700/40"
              >
                <UserPlus className="h-3.5 w-3.5" /> Delegar
              </button>
            )}
            {onAct ? (
              <button
                onClick={() => onAct(a.sourceKey)}
                disabled={actingKey === a.sourceKey}
                title="Criar campanha de recuperacao (rascunho) para estes contatos"
                className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-ric-primary/40 bg-ric-primary/10 px-2.5 py-1 text-xs font-semibold text-ric-primary-2 transition-colors hover:bg-ric-primary/20 disabled:opacity-50"
              >
                {actingKey === a.sourceKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                Recuperar
              </button>
            ) : (
              <ArrowUpRight className="h-4 w-4 flex-shrink-0 text-slate-600" />
            )}
          </div>
        );
      })}
    </div>
  );
}
