import { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { useCountUp } from '../hooks/useCountUp';
import { brl, RIC_TONE } from '../lib/format';

type Tone = 'risk' | 'recoverable' | 'recovered' | 'info';

interface Props {
  label: string;
  value: number;
  tone: Tone;
  decimals?: number;
  sublabel?: string;
  chip?: string;        // ex.: "potencial em risco"
  info?: string;        // tooltip com a premissa/fórmula
  pulseOnIncrease?: boolean; // pulso verde + "+R$" quando o valor sobe (RRI)
  suffix?: string;       // ex.: "×" para ROI em vez de "R$"
}

/**
 * Card de um número de dinheiro da faixa-herói do RIC. Count-up no mount/refresh,
 * faixa de cor semântica e — quando aplicável — chip "potencial em risco" + tooltip
 * com a premissa (honestidade: o número nunca aparece sem o "como foi calculado").
 * Com pulseOnIncrease, pulsa verde e exibe "+R$ X" quando o valor sobe (sensação
 * de "recuperação ao vivo").
 */
export function MoneyKpiCard({ label, value, tone, decimals = 0, sublabel, chip, info, pulseOnIncrease, suffix }: Props) {
  const n = useCountUp(value);
  const color = RIC_TONE[tone];

  // Pulso + delta flutuante quando o valor aumenta (somente se pulseOnIncrease).
  const prev = useRef(value);
  const [pulse, setPulse] = useState(false);
  const [delta, setDelta] = useState(0);
  useEffect(() => {
    if (!pulseOnIncrease) { prev.current = value; return; }
    if (value > prev.current) {
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const diff = value - prev.current;
      prev.current = value;
      if (!reduce) {
        setDelta(diff);
        setPulse(true);
        const t = setTimeout(() => setPulse(false), 1400);
        return () => clearTimeout(t);
      }
    } else {
      prev.current = value;
    }
  }, [value, pulseOnIncrease]);

  return (
    <div className={`group relative rounded-ric-card border border-ric-border bg-ric-surface p-5 transition-colors hover:bg-ric-surface-2 ${pulse ? 'ric-pulse' : ''}`}>
      {pulse && delta > 0 && (
        <span className="ric-floatup pointer-events-none absolute right-4 top-10 text-sm font-bold" style={{ color: RIC_TONE.recovered }}>
          +{brl(delta, decimals)} ✓
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        {info && (
          <span className="relative flex">
            <Info className="h-3.5 w-3.5 cursor-help text-slate-600 hover:text-slate-400" tabIndex={0} />
            <span className="pointer-events-none absolute right-0 top-5 z-20 w-56 rounded-lg border border-ric-border bg-ric-bg p-2.5 text-[11px] leading-relaxed text-slate-300 opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
              {info}
            </span>
          </span>
        )}
      </div>

      <p className="mt-3 text-3xl font-bold tracking-tight text-slate-100 tabular-nums">
        {suffix ? `${n.toFixed(decimals)}${suffix}` : brl(n, decimals)}
      </p>

      {chip && (
        <span
          className="mt-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color, backgroundColor: `${color}1f` }}
        >
          {chip}
        </span>
      )}
      {sublabel && <p className="mt-1.5 text-xs text-slate-500">{sublabel}</p>}

      <div className="mt-4 h-1 w-full rounded-full" style={{ backgroundColor: color, opacity: 0.5 }} />
    </div>
  );
}
