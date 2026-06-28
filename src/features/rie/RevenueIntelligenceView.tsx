import { useState } from 'react';
import { Gauge, FileDown, Sparkles } from 'lucide-react';
import { Skeleton } from '@/src/components/ui/Skeleton';

/**
 * Revenue Intelligence Center — shell navegável (PR 1 do roadmap de front).
 *
 * Esta é a casca: header com seletor de período + botão de exportar, e o grid
 * da Home com SKELETONS nos lugares exatos onde os cards entram nos próximos
 * PRs (faixa de dinheiro, IQR + drivers, painel do Diretor IA, top ações,
 * fontes da perda, tendência e simulador). Ver
 * docs/PRD-UXUI-REVENUE-INTELLIGENCE-CENTER.md.
 *
 * Identidade: usa os tokens ric-* (cabine de comando), evoluindo o dark+indigo
 * do app — fundo mais profundo, ciano exclusivo da IA, radius 16px.
 */

const PERIODS: { id: 'today' | 'week' | 'month' | 'all'; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: 'week', label: '7 dias' },
  { id: 'month', label: '30 dias' },
  { id: 'all', label: 'Tudo' },
];

// Cartão base do RIC — superfície + borda + radius command-center.
function Card({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-ric-card border border-ric-border bg-ric-surface p-5 ${className}`}>
      {children}
    </div>
  );
}

export function RevenueIntelligenceView() {
  const [period, setPeriod] = useState<typeof PERIODS[number]['id']>('month');

  return (
    <div className="flex-1 overflow-y-auto bg-ric-bg custom-scroll">
      <div className="mx-auto w-full max-w-[1400px] p-6">
        {/* ===== Header ===== */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-ric-card bg-ric-primary/15 ring-1 ring-ric-primary/30">
              <Gauge className="h-5 w-5 text-ric-primary-2" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight text-slate-100">Revenue Intelligence</h2>
              <p className="text-sm text-slate-400">Onde está o dinheiro que sua empresa está deixando na mesa.</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Seletor de período */}
            <div className="flex items-center gap-1 rounded-ric-card border border-ric-border bg-ric-surface p-1">
              {PERIODS.map(p => (
                <button
                  key={p.id}
                  onClick={() => setPeriod(p.id)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    period === p.id
                      ? 'bg-ric-primary text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Exportar PDF (wiring real no PR 4) */}
            <button
              disabled
              title="Disponível em breve"
              className="flex items-center gap-2 rounded-ric-card border border-ric-border bg-ric-surface px-3 py-2 text-xs font-semibold text-slate-400 opacity-60"
            >
              <FileDown className="h-4 w-4" /> Exportar PDF
            </button>
          </div>
        </div>

        {/* ===== Faixa de dinheiro (4 KPI) ===== */}
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {['Receita em risco', 'Receita recuperável', 'Receita recuperada', 'Ticket-base'].map((label, i) => (
            <Card key={label}>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
              <Skeleton className="mt-3 h-9 w-32 bg-slate-700/40" />
              <Skeleton className="mt-2 h-3 w-24 bg-slate-700/30" />
              {/* faixinha de cor semântica no topo (placeholder) */}
              <div
                className="mt-4 h-1 w-full rounded-full"
                style={{ background: [ '#ff8a4c', '#ffb648', '#36e39a', '#6366f1' ][i], opacity: 0.35 }}
              />
            </Card>
          ))}
        </div>

        {/* ===== IQR + drivers (8) | Diretor IA (4) ===== */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">IQR · Índice de Qualidade da Receita</p>
            <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-4">
              {/* gauge */}
              <div className="flex flex-col items-center justify-center sm:col-span-1">
                <Skeleton className="h-24 w-24 rounded-full bg-slate-700/40" />
                <Skeleton className="mt-3 h-3 w-16 bg-slate-700/30" />
              </div>
              {/* 3 drivers */}
              {['Atendimento', 'Comercial', 'Operacional'].map(d => (
                <div key={d} className="rounded-xl border border-ric-border bg-ric-bg/40 p-3">
                  <p className="text-xs font-medium text-slate-400">{d}</p>
                  <Skeleton className="mt-2 h-7 w-12 bg-slate-700/40" />
                  <Skeleton className="mt-2 h-2 w-full bg-slate-700/30" />
                  <Skeleton className="mt-2 h-2 w-3/4 bg-slate-700/20" />
                </div>
              ))}
            </div>
          </Card>

          {/* Diretor IA — painel fixo, glow ciano */}
          <div className="rounded-ric-hero border border-ric-ai/30 bg-ric-surface-2 p-5 ric-ai-glow lg:col-span-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-ric-ai" />
              <p className="text-sm font-semibold text-ric-ai">Diretor Executivo IA</p>
            </div>
            <Skeleton className="mt-4 h-3 w-full bg-slate-700/30" />
            <Skeleton className="mt-2 h-3 w-5/6 bg-slate-700/30" />
            <Skeleton className="mt-2 h-3 w-4/6 bg-slate-700/30" />
            <Skeleton className="mt-5 h-9 w-40 rounded-lg bg-slate-700/40" />
          </div>
        </div>

        {/* ===== Top 5 ações (8) | Fontes da perda (4) ===== */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Top 5 ações prioritárias</p>
            <div className="mt-4 space-y-3">
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-7 w-7 rounded-full bg-slate-700/40" />
                  <Skeleton className="h-4 flex-1 bg-slate-700/30" />
                  <Skeleton className="h-4 w-20 bg-slate-700/30" />
                </div>
              ))}
            </div>
          </Card>

          <Card className="lg:col-span-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Fontes da perda</p>
            <div className="mt-4 space-y-4">
              {[0, 1, 2, 3].map(i => (
                <div key={i}>
                  <Skeleton className="h-3 w-32 bg-slate-700/30" />
                  <Skeleton className="mt-2 h-2 w-full bg-slate-700/20" />
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ===== Tendência (8) | Simulador (4) ===== */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Tendência — desde a conexão</p>
            <Skeleton className="mt-4 h-40 w-full bg-slate-700/25" />
          </Card>

          <Card className="lg:col-span-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Simulador rápido</p>
            <Skeleton className="mt-4 h-3 w-40 bg-slate-700/30" />
            <Skeleton className="mt-4 h-2 w-full bg-slate-700/20" />
            <Skeleton className="mt-6 h-8 w-28 bg-slate-700/40" />
          </Card>
        </div>

        {/* Nota de rodapé honesta enquanto os dados não chegam */}
        <p className="mt-6 text-center text-xs text-slate-600">
          Conectando aos seus dados em tempo real — os indicadores aparecem assim que houver movimento.
        </p>
      </div>
    </div>
  );
}
