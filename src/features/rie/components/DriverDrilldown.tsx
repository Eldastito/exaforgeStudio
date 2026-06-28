import { X } from 'lucide-react';
import type { RicSnapshot } from '../types';
import { scoreColor } from '../lib/format';

type DriverKey = 'atendimento' | 'comercial' | 'operacional';

const DRIVER_LABEL: Record<DriverKey, string> = {
  atendimento: 'Atendimento',
  comercial: 'Comercial',
  operacional: 'Operacional',
};

// Como cada driver se decompõe: métrica observada + score parcial que ela gera.
const ROWS: Record<DriverKey, { metric: string; valueKey: string; unit: string; scoreKey: string }[]> = {
  atendimento: [
    { metric: 'Tempo de 1ª resposta', valueKey: 'firstResponseSec', unit: 's', scoreKey: 'firstResponseScore' },
    { metric: 'Conversas abandonadas', valueKey: 'abandonRatePct', unit: '%', scoreKey: 'abandonScore' },
    { metric: 'Leads parados (>4h sem resposta)', valueKey: 'stalledLeads', unit: '', scoreKey: 'stalledLeadsScore' },
  ],
  comercial: [
    { metric: 'Conversão (vendas/atendimentos)', valueKey: 'conversionPct', unit: '%', scoreKey: 'conversionScore' },
    { metric: 'Orçamentos parados', valueKey: 'staleQuotes', unit: '', scoreKey: 'staleQuoteScore' },
    { metric: 'Negócios quentes sem retorno', valueKey: 'coldDeals', unit: '', scoreKey: 'coldDealsScore' },
  ],
  operacional: [
    { metric: 'Repasses para humano', valueKey: 'handoffRatePct', unit: '%', scoreKey: 'handoffScore' },
    { metric: 'Tempo médio até a venda', valueKey: 'avgTimeToSaleHours', unit: 'h', scoreKey: 'speedScore' },
  ],
};

/**
 * Drilldown de um driver do IQR: abre ao clicar no card e mostra o breakdown
 * COMPLETO (cada métrica observada e o score parcial que ela gera). Transparência
 * total de como o driver — e por consequência o IQR — foi composto.
 */
export function DriverDrilldown({ snapshot, driver, onClose }: { snapshot: RicSnapshot; driver: DriverKey | null; onClose: () => void }) {
  if (!driver) return null;
  const d = snapshot.drivers[driver];
  const b = d.breakdown;
  const color = scoreColor(d.score);
  const weight = snapshot.iqr.weights[driver];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-ric-hero border border-ric-border bg-ric-bg p-6 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Driver do IQR · peso {weight}%</p>
            <h3 className="mt-0.5 text-lg font-bold text-slate-100">{DRIVER_LABEL[driver]}</h3>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-3xl font-bold tabular-nums" style={{ color }}>{d.score}</span>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200"><X className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {ROWS[driver].map(row => {
            const value = Number(b[row.valueKey] ?? 0);
            const score = Number(b[row.scoreKey] ?? 0);
            return (
              <div key={row.valueKey}>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-300">{row.metric}</span>
                  <span className="font-semibold tabular-nums text-slate-100">{value}{row.unit}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ric-border">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: scoreColor(score) }} />
                  </div>
                  <span className="w-10 text-right text-[11px] tabular-nums text-slate-500">{score}/100</span>
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-5 text-[11px] leading-relaxed text-slate-500">
          O score do driver é a média dos scores parciais acima. O IQR é a média ponderada dos 3 drivers pelos pesos — ajustáveis em "Calibrar".
        </p>
      </div>
    </div>
  );
}
