import type { RicSnapshot } from '../types';
import { brl, RIC_TONE } from '../lib/format';

/**
 * Fontes da perda — barras horizontais por fonte, ordenadas por R$. Cor distingue
 * recuperável (âmbar) de não-recuperável (laranja-risco). O hover mostra a conta
 * (count × prob%) — transparência total da fórmula.
 */
export function LossSourcesBars({ snapshot }: { snapshot: RicSnapshot }) {
  const sources = snapshot.lossSources.slice().sort((a, b) => b.amount - a.amount);
  const max = Math.max(1, ...sources.map(s => s.amount));
  const anyPositive = sources.some(s => s.amount > 0);

  if (!anyPositive) {
    return <p className="mt-4 text-sm text-slate-500">Sem perda estimada no período.</p>;
  }

  return (
    <div className="mt-4 space-y-3.5">
      {sources.map(s => {
        const color = s.recoverable ? RIC_TONE.recoverable : RIC_TONE.risk;
        const width = Math.max(s.amount > 0 ? 4 : 0, (s.amount / max) * 100);
        return (
          <div key={s.key} title={`${s.count} × ${(s.prob * 100).toFixed(0)}% × ticket`}>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">{s.label}</span>
              <span className="font-semibold tabular-nums text-slate-300">{brl(s.amount)}</span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-ric-border">
              <div
                className="h-full rounded-full"
                style={{ width: `${width}%`, backgroundColor: color, transition: 'width 700ms cubic-bezier(0.22,1,0.36,1)' }}
              />
            </div>
            <p className="mt-1 text-[10px] text-slate-600">{s.count} × {(s.prob * 100).toFixed(0)}%</p>
          </div>
        );
      })}
    </div>
  );
}
