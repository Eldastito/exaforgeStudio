import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Clock, GitMerge, TrendingUp } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useCountUp } from '../hooks/useCountUp';
import { brl } from '../lib/format';

type Lever = 'response_time' | 'followup';

interface SimResult {
  lever: Lever;
  baseline: Record<string, number>;
  target: Record<string, number>;
  delta: { conversionPpt?: number; extraSales?: number; extraRevenue: number };
  assumptions: { key: string; label: string; value: number; editable: boolean; source: 'history' | 'assumption'; note?: string }[];
  dataSource: 'history' | 'assumption' | 'mixed';
  guardrail: string;
  formula: string;
}

// Premissas que o simulador aceita como override (mapeiam direto pro endpoint).
const OVERRIDE_KEYS = new Set(['leadsPerMonth', 'targetConversionPct', 'dormantLeads', 'salePerFollowupPct']);

/**
 * Simulador leve (Revenue Digital Twin) — 2 alavancas. Slider + premissas
 * editáveis; sempre mostra o guardrail de credibilidade (history vs assumption).
 * Nunca apresenta o número como certeza.
 */
export function SimulatorWidget() {
  const [lever, setLever] = useState<Lever>('response_time');
  const [targetSeconds, setTargetSeconds] = useState(60);
  const [targetReachPct, setTargetReachPct] = useState(80);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [result, setResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const extra = useCountUp(result?.delta.extraRevenue ?? 0);

  const run = useCallback(async () => {
    setLoading(true);
    const params = lever === 'response_time' ? { targetSeconds } : { targetReachPct };
    const assumptions: Record<string, number> = {};
    for (const [k, v] of Object.entries(edits)) if (OVERRIDE_KEYS.has(k)) assumptions[k] = v as number;
    try {
      const res = await apiFetch('/api/analytics/revenue-intelligence/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lever, params, assumptions }),
      });
      if (res.ok) setResult(await res.json());
    } catch { /* mantém o último resultado */ } finally {
      setLoading(false);
    }
  }, [lever, targetSeconds, targetReachPct, edits]);

  // Debounce: recalcula 350ms após a última interação.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [run]);

  // Ao trocar de alavanca, zera os overrides (premissas são específicas).
  const switchLever = (l: Lever) => { if (l !== lever) { setEdits({}); setResult(null); setLever(l); } };

  const okSource = result?.dataSource === 'history';
  const editable = (result?.assumptions || []).filter(a => a.editable && OVERRIDE_KEYS.has(a.key));
  const readonly = (result?.assumptions || []).filter(a => !(a.editable && OVERRIDE_KEYS.has(a.key)));

  return (
    <div>
      {/* Abas */}
      <div className="mt-4 flex gap-1 rounded-lg border border-ric-border bg-ric-bg/40 p-1">
        <TabBtn active={lever === 'response_time'} onClick={() => switchLever('response_time')} icon={<Clock className="h-3.5 w-3.5" />} label="Resposta" />
        <TabBtn active={lever === 'followup'} onClick={() => switchLever('followup')} icon={<GitMerge className="h-3.5 w-3.5" />} label="Follow-up" />
      </div>

      {/* Slider da alavanca */}
      <div className="mt-4">
        {lever === 'response_time' ? (
          <>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>1ª resposta em</span>
              <span className="font-semibold text-slate-200">{targetSeconds}s</span>
            </div>
            <input type="range" min={10} max={1800} step={10} value={targetSeconds}
              onChange={e => setTargetSeconds(Number(e.target.value))}
              className="mt-2 w-full accent-ric-primary" />
          </>
        ) : (
          <>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>cobrir dos dormentes</span>
              <span className="font-semibold text-slate-200">{targetReachPct}%</span>
            </div>
            <input type="range" min={0} max={100} step={5} value={targetReachPct}
              onChange={e => setTargetReachPct(Number(e.target.value))}
              className="mt-2 w-full accent-ric-primary" />
          </>
        )}
      </div>

      {/* Resultado */}
      <div className="mt-4 rounded-xl border border-ric-border bg-ric-bg/40 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Receita adicional estimada / mês</p>
        <p className="mt-1 flex items-center gap-1.5 text-2xl font-bold tabular-nums" style={{ color: '#36e39a' }}>
          <TrendingUp className="h-5 w-5" />{brl(extra)}
        </p>
        {result && (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {result.delta.extraSales != null ? `+${result.delta.extraSales} venda(s)` : ''}
            {result.delta.conversionPpt != null ? ` · +${result.delta.conversionPpt}pp conversão` : ''}
          </p>
        )}
      </div>

      {/* Guardrail */}
      {result && (
        <div
          className="mt-3 rounded-lg border p-2.5 text-[11px] leading-relaxed"
          style={{
            borderColor: okSource ? '#36e39a55' : '#ffb64855',
            backgroundColor: okSource ? '#36e39a14' : '#ffb64814',
            color: okSource ? '#9ff3cd' : '#ffd79a',
          }}
        >
          {result.guardrail}
        </div>
      )}

      {/* Premissas editáveis */}
      {editable.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Premissas (edite à vontade)</p>
          {editable.map(a => (
            <div key={a.key} className="flex items-center gap-2">
              <span className="flex-1 text-[11px] text-slate-400">{a.label}</span>
              <SourceBadge source={a.source} />
              <input
                type="number"
                value={edits[a.key] ?? a.value}
                onChange={e => setEdits(s => ({ ...s, [a.key]: Number(e.target.value) }))}
                className="w-20 rounded-md border border-ric-border bg-ric-bg px-2 py-1 text-right text-[11px] text-slate-100 outline-none focus:border-ric-primary-2"
              />
            </div>
          ))}
        </div>
      )}

      {/* Premissas só-leitura (contexto) */}
      {readonly.length > 0 && (
        <div className="mt-2 space-y-1">
          {readonly.map(a => (
            <div key={a.key} className="flex items-center gap-2 text-[11px]">
              <span className="flex-1 text-slate-500">{a.label}</span>
              <SourceBadge source={a.source} />
              <span className="w-20 text-right tabular-nums text-slate-400">{a.value}</span>
            </div>
          ))}
        </div>
      )}

      {loading && <p className="mt-2 text-[10px] text-slate-600">recalculando…</p>}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors ${
        active ? 'bg-ric-primary text-white' : 'text-slate-400 hover:text-slate-200'
      }`}
    >
      {icon} {label}
    </button>
  );
}

function SourceBadge({ source }: { source: 'history' | 'assumption' }) {
  const hist = source === 'history';
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
      style={{
        color: hist ? '#36e39a' : '#ffb648',
        backgroundColor: hist ? '#36e39a1f' : '#ffb6481f',
      }}
    >
      {hist ? 'histórico' : 'premissa'}
    </span>
  );
}
