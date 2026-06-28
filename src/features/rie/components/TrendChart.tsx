import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { apiFetch } from '@/src/lib/api';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { brl } from '../lib/format';

const WINDOWS: { id: 'today' | 'week' | 'month'; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: 'week', label: '7 dias' },
  { id: 'month', label: '30 dias' },
];

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
 * Tendência — compara "Em risco" × "Recuperada" por janela de tempo
 * (Hoje / 7d / 30d). É dado real do tenant (1 fetch por janela). A série diária
 * persistida fica para a Fase 2 (precisa de armazenamento histórico) — por isso
 * a leitura honesta aqui é "quanto aparece conforme a janela cresce".
 */
export function TrendChart() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(
      WINDOWS.map(w =>
        apiFetch(`/api/analytics/revenue-intelligence?period=${w.id}`)
          .then(r => r.json())
          .then(d => ({ name: w.label, risco: d?.money?.estimatedLoss || 0, recuperada: d?.money?.recovered || 0 }))
          .catch(() => ({ name: w.label, risco: 0, recuperada: 0 }))
      )
    ).then(res => { if (alive) setRows(res); });
    return () => { alive = false; };
  }, []);

  if (!rows) return <Skeleton className="mt-4 h-44 w-full bg-slate-700/25" />;

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
      <p className="mt-1 text-[10px] text-slate-600">Acumulado por janela de tempo. Série diária na Fase 2.</p>
    </div>
  );
}
