import { ArrowUpRight, Inbox, Loader2, Send } from 'lucide-react';
import type { RicSnapshot } from '../types';
import { brl, RIC_TONE } from '../lib/format';

// Verbo de ação + tom por fonte de perda. O que priorizar hoje sai daqui.
const ACTION_BY_SOURCE: Record<string, { verb: (n: number) => string; tone: keyof typeof RIC_TONE }> = {
  slow_response: { verb: n => `Acelerar resposta a ${n} lead(s) lento(s)`, tone: 'risk' },
  stale_quotes: { verb: n => `Cobrar ${n} orçamento(s) parado(s)`, tone: 'recoverable' },
  abandoned: { verb: n => `Recuperar ${n} conversa(s) abandonada(s)`, tone: 'recoverable' },
  inactive: { verb: n => `Reativar ${n} cliente(s) inativo(s)`, tone: 'risk' },
};

/**
 * Top 5 ações prioritárias — derivadas client-side das fontes de perda do
 * snapshot (ordenadas por R$ em jogo). Responde "o que priorizar hoje?".
 */
export function TopActionsList({ snapshot, onAct, actingKey }: {
  snapshot: RicSnapshot;
  onAct?: (sourceKey: string) => void;
  actingKey?: string | null;
}) {
  const actions = snapshot.lossSources
    .filter(s => s.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map(s => {
      const def = ACTION_BY_SOURCE[s.key] || { verb: () => s.label, tone: 'info' as const };
      return { key: s.key, label: def.verb(s.count), amount: s.amount, tone: def.tone, recoverable: s.recoverable };
    });

  if (actions.length === 0) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center py-8 text-center">
        <Inbox className="h-6 w-6 text-slate-600" />
        <p className="mt-2 text-sm text-slate-500">Nenhuma perda relevante no período. Bom sinal.</p>
        <p className="text-xs text-slate-600">Conforme houver movimento, as ações de maior retorno aparecem aqui.</p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2">
      {actions.map((a, i) => (
        <div
          key={a.key}
          className="flex items-center gap-3 rounded-xl border border-ric-border bg-ric-bg/40 px-3 py-2.5 transition-colors hover:bg-ric-bg/70"
        >
          <span
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ color: RIC_TONE[a.tone], backgroundColor: `${RIC_TONE[a.tone]}1f` }}
          >
            {i + 1}
          </span>
          <span className="flex-1 text-sm text-slate-200">{a.label}</span>
          <span className="text-sm font-bold tabular-nums" style={{ color: RIC_TONE[a.tone] }}>
            {brl(a.amount)}
          </span>
          {onAct ? (
            <button
              onClick={() => onAct(a.key)}
              disabled={actingKey === a.key}
              title="Criar campanha de recuperação (rascunho) para estes contatos"
              className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-ric-primary/40 bg-ric-primary/10 px-2.5 py-1 text-xs font-semibold text-ric-primary-2 transition-colors hover:bg-ric-primary/20 disabled:opacity-50"
            >
              {actingKey === a.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Recuperar
            </button>
          ) : (
            <ArrowUpRight className="h-4 w-4 flex-shrink-0 text-slate-600" />
          )}
        </div>
      ))}
    </div>
  );
}
