import { useCountUp } from '../hooks/useCountUp';
import { scoreColor, scoreLabel } from '../lib/format';

interface Props {
  score: number;
  narrative?: string;
}

/**
 * Medidor semicircular do IQR (índice mestre 0–100). Arco SVG animado (0→score
 * via stroke-dashoffset), cor por faixa e rótulo qualitativo. Abaixo, a narrativa
 * determinística vinda do backend ("IQR X — driver mais fraco: Y").
 */
export function IqrGauge({ score, narrative }: Props) {
  const clamped = Math.max(0, Math.min(100, score));
  const n = useCountUp(clamped);
  const color = scoreColor(clamped);

  // Geometria do semicírculo.
  const r = 52;
  const len = Math.PI * r;                 // comprimento do arco (180°)
  const offset = len * (1 - clamped / 100);

  return (
    <div className="flex flex-col items-center justify-center text-center">
      <div className="relative">
        <svg width="150" height="86" viewBox="0 0 150 86">
          {/* trilho */}
          <path
            d="M 23 75 A 52 52 0 0 1 127 75"
            fill="none"
            stroke="#243152"
            strokeWidth="12"
            strokeLinecap="round"
          />
          {/* arco preenchido (anima) */}
          <path
            d="M 23 75 A 52 52 0 0 1 127 75"
            fill="none"
            stroke={color}
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={len}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 800ms cubic-bezier(0.22,1,0.36,1)' }}
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="text-3xl font-bold leading-none tabular-nums" style={{ color }}>
            {Math.round(n)}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
            {scoreLabel(clamped)}
          </span>
        </div>
      </div>
      <p className="mt-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">IQR · 0–100</p>
      {narrative && <p className="mt-2 max-w-[180px] text-[11px] leading-relaxed text-slate-400">{narrative}</p>}
    </div>
  );
}
