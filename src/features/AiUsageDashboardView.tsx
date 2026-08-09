import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, ArrowLeft, RefreshCcw, Loader2, DollarSign, Layers, Cpu, UsersRound } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { apiFetch } from '@/src/lib/api';
import { useVisibleLimit, ShowMore } from '@/src/components/ShowMore';

/**
 * AiUsageDashboardView (ADR-154 Fatia 1.2) — tela master admin de gastos de
 * IA. Consome /api/admin/ai-usage (lista de orgs) e /api/admin/ai-usage/:orgId
 * (drill-down com série diária + breakdown por módulo/modelo/usuário).
 *
 * Só leitura nesta fatia. Ajuste de cota + sinais de warning/exceeded vem em
 * F1.3 (POST /api/admin/organizations/:id/ai-quota + business_signals).
 */

const DAYS_OPTIONS = [7, 30, 90] as const;

const brl = (cents: number) => `R$ ${(Number(cents || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: number) => Number(v || 0).toLocaleString('pt-BR');

const AiTooltip: React.FC<any> = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 shadow-xl">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-[12px]">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-zinc-300">{p.name}:</span>
          <span className="font-semibold text-white tabular-nums">
            {p.dataKey === 'cost' ? brl(p.value * 100) : num(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

export function AiUsageDashboardView() {
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<any[] | null>(null);
  const rowsPage = useVisibleLimit(rows ?? []);
  const [drilldownId, setDrilldownId] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<any | null>(null);
  const [loadingDrill, setLoadingDrill] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setRows(null);
    setError(null);
    apiFetch(`/api/admin/ai-usage?days=${days}`)
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d?.items)) setRows(d.items);
        else { setRows([]); setError(d?.error || 'sem dados'); }
      })
      .catch(e => { setRows([]); setError(String(e?.message || e)); });
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [days]);

  useEffect(() => {
    if (!drilldownId) { setDrilldown(null); return; }
    setLoadingDrill(true);
    setDrilldown(null);
    apiFetch(`/api/admin/ai-usage/${drilldownId}?days=${days}`)
      .then(r => r.json())
      .then(d => setDrilldown(d && !d.error ? d : null))
      .catch(() => setDrilldown(null))
      .finally(() => setLoadingDrill(false));
  }, [drilldownId, days]);

  const totals = useMemo(() => {
    if (!rows) return { orgs: 0, tokens: 0, cents: 0, calls: 0 };
    return rows.reduce((acc, r) => ({
      orgs: acc.orgs + 1,
      tokens: acc.tokens + Number(r.totalTokens || 0),
      cents: acc.cents + Number(r.costCents || 0),
      calls: acc.calls + Number(r.callCount || 0),
    }), { orgs: 0, tokens: 0, cents: 0, calls: 0 });
  }, [rows]);

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-6 h-6 text-emerald-400" />
          <div>
            <h1 className="text-xl font-bold text-zinc-100">Consumo de IA — todas as orgs</h1>
            <p className="text-xs text-zinc-500">Ledger ADR-154 F1.1 (`ai_usage_log`). Master Admin.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/50 p-1">
            {DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 text-xs rounded-md transition ${d === days ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={load}
            className="p-2 rounded-lg border border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:text-zinc-200"
            title="Recarregar"
          >
            <RefreshCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard icon={<Layers className="w-4 h-4" />} label="Orgs" value={num(totals.orgs)} />
        <SummaryCard icon={<Cpu className="w-4 h-4" />} label="Tokens (janela)" value={num(totals.tokens)} />
        <SummaryCard icon={<DollarSign className="w-4 h-4" />} label="Custo (janela)" value={brl(totals.cents)} />
        <SummaryCard icon={<BarChart3 className="w-4 h-4" />} label="Chamadas" value={num(totals.calls)} />
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-3 text-sm text-red-300">
          Erro ao carregar: {error}
        </div>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-950/60 text-[11px] uppercase text-zinc-500">
                <th className="text-left py-2.5 px-4">Organização</th>
                <th className="text-left py-2.5 px-4">Plano</th>
                <th className="text-right py-2.5 px-4">Chamadas</th>
                <th className="text-right py-2.5 px-4">Tokens</th>
                <th className="text-right py-2.5 px-4">Custo</th>
                <th className="text-left py-2.5 px-4">Módulo #1</th>
                <th className="text-left py-2.5 px-4">Última chamada</th>
                <th className="py-2.5 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr><td colSpan={8} className="p-6 text-center text-zinc-500 text-sm"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Carregando…</td></tr>
              )}
              {rows && rows.length === 0 && (
                <tr><td colSpan={8} className="p-6 text-center text-zinc-500 text-sm">Nenhuma org com consumo na janela.</td></tr>
              )}
              {rowsPage.visible.map((r: any) => (
                <tr key={r.organizationId} className="border-t border-zinc-800/50 hover:bg-zinc-900/60">
                  <td className="py-2.5 px-4">
                    <div className="text-zinc-100">{r.businessName || <span className="text-zinc-500 italic">sem nome</span>}</div>
                    <div className="font-mono text-[10px] text-zinc-500">{r.organizationId}</div>
                  </td>
                  <td className="py-2.5 px-4 text-zinc-400">{r.plan || '—'}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-zinc-300">{num(r.callCount)}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-zinc-300">{num(r.totalTokens)}</td>
                  <td className="py-2.5 px-4 text-right tabular-nums text-emerald-300 font-semibold">{brl(r.costCents)}</td>
                  <td className="py-2.5 px-4"><ModuleBadge module={r.topModule} /></td>
                  <td className="py-2.5 px-4 text-[11px] text-zinc-500 font-mono">{r.lastCallAt ? new Date(r.lastCallAt.replace(' ', 'T') + 'Z').toLocaleString('pt-BR') : '—'}</td>
                  <td className="py-2.5 px-4">
                    <button
                      onClick={() => setDrilldownId(r.organizationId)}
                      className="text-xs text-emerald-300 hover:text-emerald-200"
                    >
                      Detalhes →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ShowMore page={rowsPage} noun="organizações" />
        </div>
      </div>

      {drilldownId && (
        <DrilldownPanel
          orgId={drilldownId}
          orgName={rows?.find((r: any) => r.organizationId === drilldownId)?.businessName || drilldownId}
          days={days}
          data={drilldown}
          loading={loadingDrill}
          onClose={() => setDrilldownId(null)}
        />
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase text-zinc-500">{icon} {label}</div>
      <div className="text-xl font-bold text-zinc-100 mt-2 tabular-nums">{value}</div>
    </div>
  );
}

function ModuleBadge({ module }: { module: string | null }) {
  if (!module) return <span className="text-zinc-600 text-xs">—</span>;
  // Cores por módulo (cosmético; sem regra de negócio).
  const palette: Record<string, string> = {
    falatu: 'bg-emerald-500/15 text-emerald-300 border-emerald-800/50',
    clinica: 'bg-sky-500/15 text-sky-300 border-sky-800/50',
    comigo: 'bg-amber-500/15 text-amber-300 border-amber-800/50',
    retail: 'bg-purple-500/15 text-purple-300 border-purple-800/50',
    escola: 'bg-pink-500/15 text-pink-300 border-pink-800/50',
    legacy: 'bg-zinc-800/40 text-zinc-400 border-zinc-700/50',
  };
  const cls = palette[module] || palette.legacy;
  return <span className={`inline-block px-2 py-0.5 rounded-md border text-[10px] uppercase font-mono ${cls}`}>{module}</span>;
}

function DrilldownPanel({ orgId, orgName, days, data, loading, onClose }: {
  orgId: string;
  orgName: string;
  days: number;
  data: any | null;
  loading: boolean;
  onClose: () => void;
}) {
  const chartRows = (data?.series || []).map((s: any) => ({
    name: s.date.slice(5),
    tokens: s.totalTokens,
    cost: (s.costCents || 0) / 100,
    calls: s.callCount,
  }));
  return (
    <div className="rounded-xl border border-emerald-900/40 bg-zinc-900/60 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1 mb-1">
            <ArrowLeft className="w-3 h-3" /> Voltar
          </button>
          <h2 className="text-lg font-semibold text-zinc-100">{orgName}</h2>
          <p className="font-mono text-[11px] text-zinc-500">{orgId}</p>
        </div>
        {data && (
          <div className="text-right">
            <div className="text-2xl font-bold text-emerald-300 tabular-nums">{brl(data.totalCostCents)}</div>
            <div className="text-[11px] text-zinc-500">{num(data.totalTokens)} tokens · {num(data.totalCalls)} chamadas · {days}d</div>
          </div>
        )}
      </div>

      {loading && <div className="h-40 rounded-lg bg-zinc-900/40 border border-zinc-800 animate-pulse" />}

      {!loading && data && (
        <>
          {data.totalCalls === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">Sem consumo nos últimos {days} dias.</div>
          ) : (
            <>
              <div>
                <p className="text-[11px] uppercase text-zinc-500 mb-2">Série diária — tokens + custo</p>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={chartRows} barGap={4} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis yAxisId="tokens" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="cost" orientation="right" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: '#ffffff08' }} content={<AiTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }} iconType="circle" />
                    <Bar yAxisId="tokens" dataKey="tokens" name="Tokens" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={20} />
                    <Bar yAxisId="cost" dataKey="cost" name="Custo (R$)" fill="#a1a1aa" radius={[3, 3, 0, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <BreakdownCard title="Por módulo" icon={<Layers className="w-4 h-4" />} rows={data.byModule} labelKey="module" />
                <BreakdownCard title="Por modelo" icon={<Cpu className="w-4 h-4" />} rows={data.byModel} labelKey="model" />
                <BreakdownCard title="Por usuário" icon={<UsersRound className="w-4 h-4" />} rows={data.byUser} labelKey="userId" />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function BreakdownCard({ title, icon, rows, labelKey }: { title: string; icon: React.ReactNode; rows: any[]; labelKey: string }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-[11px] uppercase text-zinc-500 flex items-center gap-1 mb-2">{icon} {title}</div>
        <div className="text-xs text-zinc-600">—</div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="text-[11px] uppercase text-zinc-500 flex items-center gap-1 mb-2">{icon} {title}</div>
      <div className="space-y-1.5">
        {rows.slice(0, 6).map((r: any, i: number) => (
          <div key={String(r[labelKey] || 'null') + i} className="flex items-center justify-between text-xs">
            <span className="text-zinc-300 truncate max-w-[60%] font-mono">{r[labelKey] || <span className="italic text-zinc-600">null</span>}</span>
            <span className="text-emerald-300 tabular-nums font-semibold">{brl(r.costCents)}</span>
          </div>
        ))}
        {rows.length > 6 && <div className="text-[10px] text-zinc-600 pt-1">+ {rows.length - 6}</div>}
      </div>
    </div>
  );
}
