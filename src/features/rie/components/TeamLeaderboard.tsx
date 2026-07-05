import { useEffect, useState } from 'react';
import { Trophy, Clock, Star, Inbox } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { pct } from '../lib/format';
import type { RicPeriod } from '../types';

interface Operator {
  user_id: string;
  name: string;
  role: string;
  tickets_handled: number;
  closed_won: number;
  conversion_rate: number;
  avg_first_response_seconds: number | null;
  csat_avg: number | null;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  agent: 'Agente',
  manager: 'Gestor',
};

const MEDAL: Record<number, { bg: string; text: string; ring: string }> = {
  1: { bg: 'bg-amber-500/15', text: 'text-amber-400', ring: 'ring-amber-500/30' },
  2: { bg: 'bg-slate-400/15', text: 'text-slate-300', ring: 'ring-slate-400/30' },
  3: { bg: 'bg-orange-600/15', text: 'text-orange-400', ring: 'ring-orange-600/30' },
};

function formatResponseTime(seconds: number | null): string {
  if (seconds == null) return '--';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * Leaderboard da equipe — ranking dos operadores por desempenho no periodo.
 * Segue o padrao dos demais componentes do RIC: fetch proprio, skeleton de
 * carregamento e estado vazio.
 */
export function TeamLeaderboard({ period }: { period: RicPeriod }) {
  const [operators, setOperators] = useState<Operator[] | null>(null);

  useEffect(() => {
    let alive = true;
    setOperators(null);
    apiFetch(`/api/analytics/team-performance?period=${period}`)
      .then(r => r.json())
      .then((data: Operator[]) => { if (alive) setOperators(Array.isArray(data) ? data : []); })
      .catch(() => { if (alive) setOperators([]); });
    return () => { alive = false; };
  }, [period]);

  // --- Loading skeleton ---
  if (operators === null) {
    return (
      <div className="rounded-ric-card border border-ric-border bg-ric-surface p-5">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-slate-500" />
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Leaderboard da equipe</p>
        </div>
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full bg-slate-700/40" />
              <Skeleton className="h-4 flex-1 bg-slate-700/30" />
              <Skeleton className="h-4 w-16 bg-slate-700/30" />
              <Skeleton className="h-4 w-16 bg-slate-700/30" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // --- Empty state ---
  if (operators.length === 0) {
    return (
      <div className="rounded-ric-card border border-ric-border bg-ric-surface p-5">
        <div className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-slate-500" />
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Leaderboard da equipe</p>
        </div>
        <div className="mt-4 flex flex-col items-center justify-center py-8 text-center">
          <Inbox className="h-6 w-6 text-slate-600" />
          <p className="mt-2 text-sm text-slate-500">Nenhum operador com tickets no periodo.</p>
          <p className="text-xs text-slate-600">Atribua tickets aos operadores para ver o ranking aqui.</p>
        </div>
      </div>
    );
  }

  const maxTickets = Math.max(1, ...operators.map(o => o.tickets_handled));

  return (
    <div className="rounded-ric-card border border-ric-border bg-ric-surface p-5">
      <div className="flex items-center gap-2">
        <Trophy className="h-4 w-4 text-amber-500" />
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Leaderboard da equipe</p>
      </div>

      {/* Header */}
      <div className="mt-4 hidden items-center gap-3 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600 sm:flex">
        <span className="w-8" />
        <span className="flex-1">Operador</span>
        <span className="w-16 text-right">Tickets</span>
        <span className="w-20 text-right">Conversoes</span>
        <span className="w-16 text-right">Conv %</span>
        <span className="w-16 text-right">1a resp</span>
        <span className="w-14 text-right">CSAT</span>
      </div>

      <div className="mt-2 space-y-1.5">
        {operators.map((op, idx) => {
          const rank = idx + 1;
          const medal = MEDAL[rank];
          const barWidth = Math.max(4, (op.tickets_handled / maxTickets) * 100);

          return (
            <div
              key={op.user_id}
              className="group relative overflow-hidden rounded-xl border border-ric-border bg-ric-bg/40 px-3 py-2.5 transition-colors hover:bg-ric-bg/70"
            >
              {/* Subtle relative-performance bar behind content */}
              <div
                className="absolute inset-y-0 left-0 bg-ric-primary/[0.04] transition-[width] duration-700"
                style={{ width: `${barWidth}%` }}
              />

              <div className="relative flex flex-wrap items-center gap-3 sm:flex-nowrap">
                {/* Position */}
                {medal ? (
                  <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ring-1 ${medal.bg} ${medal.text} ${medal.ring}`}>
                    {rank}
                  </span>
                ) : (
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-slate-700/30 text-xs font-medium text-slate-500 ring-1 ring-slate-600/30">
                    {rank}
                  </span>
                )}

                {/* Name + role */}
                <div className="flex flex-1 flex-col min-w-0">
                  <span className="truncate text-sm font-medium text-slate-200">{op.name}</span>
                  <span className="text-[10px] text-slate-500">{ROLE_LABEL[op.role] || op.role}</span>
                </div>

                {/* Stats */}
                <span className="w-16 text-right text-sm tabular-nums text-slate-300">{op.tickets_handled}</span>
                <span className="w-20 text-right text-sm font-semibold tabular-nums text-emerald-400">{op.closed_won}</span>
                <span className="w-16 text-right text-sm tabular-nums text-slate-300">{pct(op.conversion_rate)}</span>
                <span className="flex w-16 items-center justify-end gap-1 text-sm tabular-nums text-slate-400">
                  <Clock className="hidden h-3 w-3 sm:block" />
                  {formatResponseTime(op.avg_first_response_seconds)}
                </span>
                <span className="flex w-14 items-center justify-end gap-1 text-sm tabular-nums text-amber-400">
                  {op.csat_avg != null ? (
                    <>
                      <Star className="hidden h-3 w-3 sm:block" />
                      {op.csat_avg}
                    </>
                  ) : (
                    <span className="text-slate-600">--</span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
