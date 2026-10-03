/**
 * TodayView (ADR-203 F2.3) — o "Hoje" como cockpit por exceção. Só RENDERIZA o que
 * `GET /api/ux/today` já calculou (RN-F2-4: nenhuma regra de negócio aqui): até 3 prioridades
 * com causa + verbo, a rede (meta do mês + parcial do PDV com "último dado às HH:MM"),
 * e o resolvido nas últimas 24h. Sem linguagem técnica; estado desconhecido aparece como "—".
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, ArrowRight } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';
import { trackAction } from '@/src/lib/uxTelemetry';

interface MetricText { state: string; text: string; reason: string | null }
interface Priority { id: string; kind: string; title: string; cause: string; verb: string; viewMode: string; severity: string | null }
interface Cockpit {
  greeting: string; todayLine: string; calm: boolean; priorities: Priority[]; moreCount: number;
  network: null | {
    freshness: { hhmm: string | null; stale: boolean };
    monthGoal: MetricText; monthClosed: MetricText; monthRemaining: MetricText; todayPartial: MetricText;
    coverage: { stores: number; withMonthGoal: number; withClosing: number };
  };
  resolved: { count: number; valueRecovered: MetricText | null; windowHours: number };
}

function Stat({ label, m, hint }: { label: string; m: MetricText; hint?: string }) {
  const unknown = m.state !== 'value' && m.state !== 'estimate';
  return (
    <div className="zf-panel-subtle p-3">
      <p className="text-[11px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${unknown ? 'text-slate-500' : 'text-slate-100'}`}>{m.text}</p>
      {(hint || (unknown && m.reason)) && <p className="mt-1 text-xs text-slate-500">{unknown && m.reason ? m.reason : hint}</p>}
    </div>
  );
}

export function TodayView() {
  const setViewMode = useStore(s => s.setViewMode);
  const [data, setData] = useState<Cockpit | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/ux/today').then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="p-6 text-sm text-slate-400">Não consegui carregar o Hoje agora. Tente de novo em instantes.</div>;
  if (!data) return <div className="p-6 text-sm text-slate-500">Carregando…</div>;
  const n = data.network;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6" data-testid="today-view">
      <header>
        <h2 className="text-2xl font-semibold text-slate-100">{data.greeting}.</h2>
        <p className="mt-1 text-sm text-slate-400">{data.todayLine}</p>
      </header>

      {data.calm ? (
        <div className="zf-panel flex items-center gap-3 p-5 text-slate-200"><CheckCircle2 className="h-5 w-5 text-emerald-400" />Nada pede a sua atenção agora.</div>
      ) : (
        <section aria-label="Prioridades" className="space-y-3">
          {data.priorities.map((p, i) => (
            <div key={p.id} className="zf-panel p-4" data-testid="priority">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-xs font-bold text-amber-300">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-slate-100">{p.title}</p>
                  <p className="mt-1 text-sm text-slate-400">{p.cause}</p>
                  <button onClick={() => { trackAction('hoje_acao', p.viewMode); setViewMode(p.viewMode as any); }}
                    className="mt-3 inline-flex items-center gap-2 rounded-lg bg-teal-500/15 px-3 py-1.5 text-sm font-medium text-teal-300 hover:bg-teal-500/25">
                    {p.verb}<ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {data.moreCount > 0 && <p className="px-1 text-xs text-slate-500">+ {data.moreCount} {data.moreCount === 1 ? 'outro assunto' : 'outros assuntos'} acompanhado{data.moreCount === 1 ? '' : 's'} — veja na Central de Saúde.</p>}
        </section>
      )}

      {n && (
        <section aria-label="Rede" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-200">Rede</h3>
            <span className={`inline-flex items-center gap-1 text-xs ${n.freshness.stale ? 'text-amber-300' : 'text-slate-500'}`}>
              {n.freshness.stale ? <AlertTriangle className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
              {n.freshness.hhmm ? `Último dado do PDV às ${n.freshness.hhmm}${n.freshness.stale ? ' — pode estar atrasado' : ''}` : 'PDV ainda não sincronizou'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Meta do mês" m={n.monthGoal} />
            <Stat label="Já fechado" m={n.monthClosed} hint="dias com fechamento enviado" />
            <Stat label="Falta no mês" m={n.monthRemaining} />
            <Stat label="Vendido hoje" m={n.todayPartial} hint="parcial do PDV, não é o fechamento" />
          </div>
        </section>
      )}

      {data.resolved.count > 0 && (
        <p className="flex items-center gap-2 text-sm text-slate-400"><CheckCircle2 className="h-4 w-4 text-emerald-400" />
          {data.resolved.count} {data.resolved.count === 1 ? 'caso resolvido' : 'casos resolvidos'} nas últimas {data.resolved.windowHours}h
          {data.resolved.valueRecovered ? ` — ${data.resolved.valueRecovered.text} recuperados` : ''}.
        </p>
      )}
    </div>
  );
}
