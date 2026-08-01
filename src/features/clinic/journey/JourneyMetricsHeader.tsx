/**
 * JourneyMetricsHeader — Módulo Clínica Fatia 56 (UI da ADR-146).
 * -------------------------------------------------------------------
 * Sexta superfície visual da Jornada de Tratamento. Consome:
 *   - F40 (ClinicCareJourneyMetricsService.overview + counts)
 *   - F47 (ClinicRenewalTaskService — sinais IA de renovação abertos)
 *
 * Objetivo: dar VISIBILIDADE OPERACIONAL sem exigir do usuário navegar
 * entre abas pra saber onde tem trabalho pendente. É o "sinal
 * ambient" da recepção — abre a Clínica e já vê:
 *   - quantos episódios ativos hoje
 *   - quantos ciclos precisam decisão de renovação (RN-014 §"IA
 *     sinaliza, humano decide")
 *   - quantos pacientes ativos sem próximo horário (fila operacional)
 *   - quantas altas no mês
 *   - quantos sinais IA abertos (F47 renewal_hint)
 *
 * Também exporta `useJourneyCounts` — hook consumido por outros
 * componentes (nas abas Ciclos/Episódios/Grupos) pra desenhar badge
 * numérico consistente. Refresh a cada 60s (métricas não são real-time
 * — recepção não precisa de subscription websocket).
 *
 * Guardrails RN-014 (backend impõe; UI espelha):
 *   - Números vêm de query derivada (RN-004: nunca contador mutável).
 *   - Nenhum botão de ação aqui — só leitura. Ações ficam nas abas
 *     específicas (Ciclos → renovar, Episódios → alta, etc.).
 *   - Sinais IA abertos abrem link pra aba Ciclos (onde tem contexto
 *     completo) — não permitem "aceitar/rejeitar direto" (RN-014
 *     §"decisão é do humano com contexto").
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Loader2, Users, RefreshCw, Calendar, TrendingUp, Sparkles,
  ArrowRight,
} from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

// ── Tipos do backend F40 ─────────────────────────────────────────────
export type JourneyCounts = {
  active: number;
  onHold: number;
  renewalDue: number;
  withoutSchedule: number;
  futuresAfterDischarge: number;
  transfersRecent: number;
};

type OverviewMetrics = {
  episodes: {
    active: number; onHold: number;
    dischargedInPeriod: number; cancelledInPeriod: number;
    bySpecialty: Array<{ specialtyId: string; specialtyName: string; count: number }>;
    byProfessional: Array<{ professionalId: string; professionalName: string; count: number }>;
  };
  discharges: { total: number };
  cycles: { active: number; renewalDue: number; renewedInPeriod: number };
  transfers: { inPeriod: number };
  operational: { activeWithoutNextAppointment: number; futureAppointmentsAfterDischarge: number };
  window: { fromISO: string; toISO: string };
};

type RenewalSignal = {
  id: string;
  dedupeKey: string;
  createdAt: string;
  payload: any;
};

// Refresh compartilhado — 60s cobre o caso normal (recepção não é HFT).
const REFRESH_MS = 60_000;

// ── Hook público: `useJourneyCounts` ─────────────────────────────────
// Usado pelo header + por qualquer aba que queira desenhar badge
// numérico. Compartilha ciclo de refresh via `refreshTick` — quem
// depende re-fetcha em resposta.
export function useJourneyCounts(): { counts: JourneyCounts | null; loading: boolean; reload: () => void } {
  const [counts, setCounts] = useState<JourneyCounts | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch('/api/clinic/care-journey/counts')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        setCounts(d?.counts || null);
      })
      .catch(() => { if (!cancelled) setCounts(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    const iv = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(iv);
  }, [reload]);

  return { counts, loading, reload };
}

// ── Componente principal ─────────────────────────────────────────────
export default function JourneyMetricsHeader({ onNavigate }: {
  onNavigate?: (tab: 'episodios' | 'ciclos' | 'grupos' | 'guias') => void;
}) {
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [signals, setSignals] = useState<RenewalSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const { counts, reload: reloadCounts } = useJourneyCounts();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rM, rS] = await Promise.all([
        apiFetch('/api/clinic/care-journey/metrics'),
        apiFetch('/api/clinic/renewal-tasks'),
      ]);
      const [dM, dS] = await Promise.all([
        rM.json().catch(() => ({})),
        rS.json().catch(() => ({})),
      ]);
      setMetrics(dM?.metrics || null);
      setSignals(Array.isArray(dS?.signals) ? dS.signals : []);
    } catch {
      // Silencioso — o header degrada pra "—" nos tiles sem quebrar a aba.
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const iv = window.setInterval(load, REFRESH_MS);
    return () => window.clearInterval(iv);
  }, [load]);

  const tiles = useMemo(() => {
    const active = metrics?.episodes.active ?? counts?.active ?? null;
    const onHold = metrics?.episodes.onHold ?? counts?.onHold ?? null;
    const discharged = metrics?.episodes.dischargedInPeriod ?? null;
    const cyclesActive = metrics?.cycles.active ?? null;
    const renewalDue = metrics?.cycles.renewalDue ?? counts?.renewalDue ?? null;
    const withoutSchedule = metrics?.operational.activeWithoutNextAppointment ?? counts?.withoutSchedule ?? null;

    return [
      {
        key: 'active',
        label: 'Episódios ativos',
        value: active,
        sub: onHold != null && onHold > 0 ? `${onHold} em pausa` : null,
        icon: <Users className="w-4 h-4 text-emerald-400" />,
        onClick: () => onNavigate?.('episodios'),
      },
      {
        key: 'cycles',
        label: 'Ciclos ativos',
        value: cyclesActive,
        sub: renewalDue != null && renewalDue > 0 ? `${renewalDue} p/ decisão` : null,
        highlight: renewalDue != null && renewalDue > 0,
        icon: <RefreshCw className="w-4 h-4 text-emerald-400" />,
        onClick: () => onNavigate?.('ciclos'),
      },
      {
        key: 'without-schedule',
        label: 'Sem próximo horário',
        value: withoutSchedule,
        sub: withoutSchedule != null && withoutSchedule > 0 ? 'ativos sem agenda' : null,
        highlight: withoutSchedule != null && withoutSchedule > 0,
        icon: <Calendar className="w-4 h-4 text-emerald-400" />,
        onClick: () => onNavigate?.('episodios'),
      },
      {
        key: 'discharges',
        label: 'Altas (30d)',
        value: discharged,
        sub: null,
        icon: <TrendingUp className="w-4 h-4 text-emerald-400" />,
        onClick: () => onNavigate?.('episodios'),
      },
    ] as const;
  }, [metrics, counts, onNavigate]);

  const openSignals = signals.length;

  // Nada carregado ainda + counts também vazio → esconde silenciosamente
  // (a Jornada é módulo opt-in; org que não usa não vê header vazio).
  if (!loading && !metrics && (!counts || (counts.active + counts.onHold === 0))) {
    return null;
  }

  return (
    <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 print:hidden">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tiles.map(t => (
          <button key={t.key} onClick={t.onClick} disabled={!t.onClick}
            className={`text-left rounded-lg border px-3 py-2 transition-colors ${
              (t as any).highlight
                ? 'border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10'
                : 'border-zinc-800 bg-zinc-950/50 hover:bg-zinc-900'
            } ${t.onClick ? 'cursor-pointer' : 'cursor-default'}`}>
            <div className="flex items-center gap-2">
              {t.icon}
              <span className="text-[11px] text-zinc-400">{t.label}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-semibold text-zinc-100 tabular-nums">
                {loading && t.value == null ? '—' : (t.value ?? 0)}
              </span>
              {t.sub && (
                <span className={`text-[10px] ${
                  (t as any).highlight ? 'text-amber-300' : 'text-zinc-500'
                }`}>
                  {t.sub}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Faixa de sinais IA abertos (F47 renewal_hint). Único, compacto. */}
      {openSignals > 0 && (
        <button onClick={() => onNavigate?.('ciclos')}
          className="mt-2 w-full flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/10 transition-colors">
          <Sparkles className="w-3.5 h-3.5" />
          <span>
            <b>{openSignals}</b> sinal(is) IA de renovação aberto(s) — humano decide na aba Ciclos.
          </span>
          <ArrowRight className="w-3 h-3 ml-auto" />
        </button>
      )}

      {loading && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-600">
          <Loader2 className="w-2.5 h-2.5 animate-spin" /> atualizando…
        </div>
      )}

      {/* refresh manual escondido — o interval de 60s cobre o caso normal;
          reloadCounts força quando outra tab publicou algo. */}
      <button className="hidden" onClick={reloadCounts} aria-hidden />
    </div>
  );
}

// ── Utilitário: TabBadge (badge numérico consistente nas abas) ───────
export function TabBadge({ n, highlight }: { n: number | null | undefined; highlight?: boolean }) {
  if (!n || n <= 0) return null;
  return (
    <span className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] tabular-nums ${
      highlight
        ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
        : 'bg-zinc-800 text-zinc-300 border border-zinc-700'
    }`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
