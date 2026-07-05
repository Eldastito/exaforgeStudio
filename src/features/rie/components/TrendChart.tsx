import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { apiFetch } from '@/src/lib/api';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { brl } from '../lib/format';

type Row = { name: string; risco: number; recuperada: number };

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-ric-border bg-ric-bg/95 px-3 py-2 shadow-xl">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-[12px]">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="font-semibold text-white tabular-nums">{brl(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Tendencia — serie diaria persistida de "Em risco" x "Recuperada",
 * consumida do endpoint /api/analytics/revenue-intelligence/trend.
 */
export function TrendChart() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch(`/api/analytics/revenue-intelligence/trend?days=30`)
      .then(r => r.json())
      .then((points: any[]) => {
        if (!alive) return;
        if (!Array.isArray(points) || points.length === 0) {
          setRows([]);
          return;
        }
        const data: Row[] = points.map((p: any) => ({
          name: p.snapshot_date?.slice(5) || '', // MM-DD
          risco: p.estimated_loss || 0,
          recuperada: p.recovered || 0,
        }));
        setRows(data);
      })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  if (rows === null) return <Skeleton className="mt-4 h-44 w-full bg-slate-700/25" />;

  if (rows.length === 0) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center py-8 text-center">
        <p className="text-sm text-slate-500">Ainda sem dados historicos.</p>
        <p className="text-xs text-slate-600">O sistema registra um snapshot por dia. A serie aparece a partir do segundo dia.</p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={rows} barGap={6} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1b2440" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `R$${(v / 1000).toFixed(0)}k`} />
          <Tooltip cursor={{ fill: '#ffffff08' }} content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} iconType="circle" />
          <Bar dataKey="risco" name="Em risco" fill="#ff8a4c" radius={[4, 4, 0, 0]} maxBarSize={34} />
          <Bar dataKey="recuperada" name="Recuperada" fill="#36e39a" radius={[4, 4, 0, 0]} maxBarSize={34} />
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-1 text-[10px] text-slate-600">Serie diaria persistida (ultimos 30 dias).</p>
    </div>
  );
}
