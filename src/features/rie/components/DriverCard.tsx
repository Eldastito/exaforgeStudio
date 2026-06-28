import { useCountUp } from '../hooks/useCountUp';
import { scoreColor } from '../lib/format';

interface Props {
  label: string;
  score: number;
  weight?: number;       // peso no IQR (%)
  items: { label: string; value: string }[];
  weakest?: boolean;     // destaca o driver mais fraco
}

/**
 * Card de um driver do IQR (Atendimento / Comercial / Operacional). Mostra o
 * score, uma barra proporcional e os itens do breakdown que mais explicam o
 * número — composição transparente, conforme o PRD.
 */
export function DriverCard({ label, score, weight, items, weakest }: Props) {
  const n = useCountUp(score);
  const color = scoreColor(score);

  return (
    <div
      className="rounded-xl border border-ric-border bg-ric-bg/40 p-3"
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-300">{label}</p>
        {weakest && (
          <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-400">
            mais fraco
          </span>
        )}
      </div>

      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums" style={{ color }}>{Math.round(n)}</span>
        <span className="text-[10px] text-slate-500">/100</span>
        {weight != null && <span className="ml-auto text-[10px] text-slate-600">peso {weight}%</span>}
      </div>

      {/* barra proporcional */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ric-border">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: color, transition: 'width 700ms cubic-bezier(0.22,1,0.36,1)' }}
        />
      </div>

      <ul className="mt-2.5 space-y-1">
        {items.map((it) => (
          <li key={it.label} className="flex items-center justify-between text-[11px]">
            <span className="text-slate-500">{it.label}</span>
            <span className="font-medium text-slate-300 tabular-nums">{it.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
