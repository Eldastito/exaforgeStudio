import { useCallback, useEffect, useState } from 'react';
import { HeartPulse, Loader2, ArrowRight, TrendingUp, Wallet, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';
import type { ViewMode } from '@/src/store/useStore';

// Central de Saúde e Decisão (ADR-126 Fatia 1) — a tela-síntese: status geral +
// as 3 prioridades do dia com impacto em R$ e uma ação. Global (todas as verticais).

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;

const STATUS_UI: Record<string, { label: string; cls: string; bar: string }> = {
  saudavel: { label: 'Saudável', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/5', bar: 'bg-emerald-500' },
  atencao: { label: 'Atenção', cls: 'text-sky-300 border-sky-500/40 bg-sky-500/5', bar: 'bg-sky-500' },
  risco: { label: 'Risco', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/5', bar: 'bg-amber-500' },
  critico: { label: 'Crítico', cls: 'text-red-300 border-red-500/40 bg-red-500/5', bar: 'bg-red-500' },
};

export function HealthCenterView() {
  const [d, setD] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const setViewMode = useStore((s) => s.setViewMode);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch('/api/health-center').then((r) => r.json()).then((x: any) => setD(x)).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Analisando seu negócio…</div>;
  const st = STATUS_UI[d?.status] || STATUS_UI.saudavel;

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/30 p-2.5"><HeartPulse className="w-6 h-6 text-indigo-300" /></div>
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Central de Saúde</h2>
            <p className="text-sm text-zinc-400">O que mudou, por que importa e o que fazer primeiro — no máximo 3 prioridades por dia.</p>
          </div>
        </div>

        {/* Status geral + síntese */}
        <div className={`rounded-xl border p-4 ${st.cls}`}>
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${st.bar}`} />
            <span className="text-sm font-semibold uppercase tracking-wide">{st.label}</span>
          </div>
          <p className="mt-1.5 text-[15px] text-zinc-100">{d?.synthesis}</p>
          {d?.triggers?.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {d.triggers.map((t: any, i: number) => (
                <li key={i} className="text-[12px] text-zinc-300/80 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />{t.label}</li>
              ))}
            </ul>
          )}
        </div>

        {/* KPIs rápidos */}
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-[13px]">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500 flex items-center gap-1"><Wallet className="w-3 h-3" /> Caixa</div><div className="text-zinc-100 font-semibold mt-0.5">{brl(d?.kpis?.caixaAtual)}</div></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500">A receber</div><div className="text-amber-200 font-semibold mt-0.5">{brl(d?.kpis?.aReceber)}</div></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500">A pagar</div><div className="text-red-200 font-semibold mt-0.5">{brl(d?.kpis?.aPagar)}</div></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500">Dias de caixa</div><div className="text-zinc-100 font-semibold mt-0.5">{d?.kpis?.survivalDays != null ? `~${d.kpis.survivalDays}` : '—'}</div></div>
        </div>

        {/* Prioridades do dia */}
        <div className="mt-5">
          <h3 className="text-sm font-medium text-zinc-200 mb-2 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-indigo-300" /> Prioridades de hoje</h3>
          {(!d?.priorities || d.priorities.length === 0) ? (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-[13px] text-emerald-200">Nenhuma prioridade urgente hoje. Continue cuidando do caixa e das vendas. 👊</div>
          ) : (
            <ol className="space-y-2">
              {d.priorities.map((p: any, i: number) => (
                <li key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 shrink-0 rounded-full bg-indigo-500/20 text-indigo-300 text-[11px] font-semibold flex items-center justify-center">{i + 1}</span>
                        <span className="text-[14px] font-medium text-zinc-100">{p.title}</span>
                      </div>
                      <div className="mt-1 text-[12px] text-zinc-400">{p.fato}</div>
                      <div className="mt-0.5 text-[12px] text-zinc-500">{p.interpretacao} <span className="text-amber-300/80">{p.risco}</span></div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[15px] font-semibold text-indigo-200">{brl(p.impact)}</div>
                      <div className={`text-[10px] uppercase tracking-wide ${p.basis === 'fato' ? 'text-emerald-400/70' : 'text-zinc-500'}`}>{p.basis}</div>
                    </div>
                  </div>
                  <button onClick={() => setViewMode(p.action.view as ViewMode)} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] px-3 py-1.5">
                    {p.action.label} <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
