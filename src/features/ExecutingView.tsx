/**
 * ExecutingView (ADR-203 F2.4) — "Executando": o que está andando e o que depende de você, em 4 etapas.
 * Só RENDERIZA `GET /api/ux/executing-board` (RN-F2-4). Missão, tarefa e ação aparecem como o MESMO cartão;
 * o tipo interno só decide para onde o cartão abre. "Concluído" mostra se o resultado foi confirmado ou só executado.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Hand, Loader2, ArrowRight } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';
import { trackAction } from '@/src/lib/uxTelemetry';

interface Item {
  id: string; kind: string; title: string; state: string; tone: string; detail: string | null; at: string | null;
  impact: { amount: number | null; unit: string | null; restricted: boolean } | null;
  assurance: { state: string; label: string } | null; viewMode: string;
}
interface Board { lanes: Record<'needsYou' | 'running' | 'waiting' | 'done', { total: number; items: Item[] }>; missionsAvailable: boolean }

const LANES: Array<{ key: 'needsYou' | 'running' | 'waiting' | 'done'; title: string; empty: string; icon: React.ReactNode; accent: string }> = [
  { key: 'needsYou', title: 'Precisa de você', empty: 'Nada esperando a sua decisão.', icon: <Hand className="h-4 w-4" />, accent: 'text-amber-300' },
  { key: 'running', title: 'Em andamento', empty: 'Nada em andamento agora.', icon: <Loader2 className="h-4 w-4" />, accent: 'text-sky-300' },
  { key: 'waiting', title: 'Aguardando', empty: 'Nada na fila de espera.', icon: <Clock className="h-4 w-4" />, accent: 'text-slate-300' },
  { key: 'done', title: 'Concluído (7 dias)', empty: 'Nada concluído nos últimos 7 dias.', icon: <CheckCircle2 className="h-4 w-4" />, accent: 'text-emerald-300' },
];

export function ExecutingView() {
  const setViewMode = useStore(s => s.setViewMode);
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/ux/executing-board').then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  if (error) return <div className="p-6 text-sm text-slate-400">Não consegui carregar o Executando agora. Tente de novo em instantes.</div>;
  if (!data) return <div className="p-6 text-sm text-slate-500">Carregando…</div>;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6" data-testid="executing-view">
      {LANES.map(l => {
        const lane = data.lanes[l.key];
        return (
          <section key={l.key} aria-label={l.title} data-testid={`lane-${l.key}`}>
            <h3 className={`mb-2 flex items-center gap-2 text-sm font-semibold ${l.accent}`}>{l.icon}{l.title}<span className="text-xs font-normal text-slate-500">{lane.total > 0 ? lane.total : ''}</span></h3>
            {lane.items.length === 0 ? <p className="text-sm text-slate-500">{l.empty}</p> : (
              <div className="space-y-2">
                {lane.items.map(it => (
                  <button key={`${it.kind}:${it.id}`} onClick={() => { trackAction('executando_abrir', it.viewMode); setViewMode(it.viewMode as any); }}
                    className="zf-panel-subtle flex w-full items-start gap-3 p-3 text-left hover:border-teal-500/40">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-slate-100">{it.title}</p>
                      <p className={`mt-0.5 text-xs ${it.tone === 'failed' ? 'text-rose-300' : 'text-slate-400'}`}>
                        {it.tone === 'failed' && <AlertTriangle className="mr-1 inline h-3 w-3" />}{it.state}{it.detail ? ` — ${it.detail}` : ''}
                      </p>
                      {it.assurance && <p className={`mt-0.5 text-xs ${it.assurance.state === 'assured' || it.assurance.state === 'impact_measured' || it.assurance.state === 'effect_confirmed' ? 'text-emerald-300' : 'text-amber-300'}`}>{it.assurance.label}</p>}
                      {it.impact && !it.impact.restricted && it.impact.amount != null && <p className="mt-0.5 text-xs text-slate-500">Impacto esperado: {it.impact.unit === 'BRL' ? it.impact.amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : it.impact.amount}</p>}
                    </div>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-500" />
                  </button>
                ))}
                {lane.total > lane.items.length && <p className="px-1 text-xs text-slate-500">+ {lane.total - lane.items.length} {lane.total - lane.items.length === 1 ? 'outro' : 'outros'}.</p>}
              </div>
            )}
          </section>
        );
      })}
      {data.missionsAvailable && <button onClick={() => setViewMode('missoes' as any)} className="text-sm text-teal-300 hover:underline">Ver todas as missões →</button>}
    </div>
  );
}
