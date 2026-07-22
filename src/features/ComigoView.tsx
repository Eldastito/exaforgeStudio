import { useEffect, useState } from 'react';
import { HandCoins, Loader2, Calculator, Store, NotebookText, Sparkles } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

// ============================================================================
// ZappFlow Comigo — módulo `copiloto` do plano Autônomo (ADR-111/112/113).
// PR #1: registro do módulo + schema. Esta view confirma que o módulo está
// ligado e mostra os contadores da caderneta (via /api/comigo/overview). As
// telas operacionais — Balcão PDV por toque, Motor de Precificação e Caderneta
// (fiado, limite, lista negra, cobrança cortês) — entram nos PRs seguintes.
// ============================================================================

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;

type Overview = { recipes: number; openOrders: number; fiadoReceivable: number; blacklisted: number };

const TABS = [
  { key: 'balcao', label: 'Balcão', icon: Store, desc: 'PDV por toque: clica na foto, cobra (Pix ou dinheiro) — e o fiado com limite por cliente.' },
  { key: 'precificacao', label: 'Precificação', icon: Calculator, desc: 'Ficha técnica viva: quanto custa, quanto cobrar e quanto sobra de verdade em cada unidade / hora sua.' },
  { key: 'caderneta', label: 'Caderneta', icon: NotebookText, desc: 'Quem te deve, quanto, o limite de cada um, a lista negra e a cobrança amigável.' },
] as const;

export function ComigoView() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('balcao');
  const [ov, setOv] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/comigo/overview')
      .then((r) => r.json())
      .then((r: any) => { if (alive && r && typeof r.recipes === 'number') setOv(r); })
      .catch(() => { /* módulo pode estar sem dados ainda */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const active = TABS.find((t) => t.key === tab)!;

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
          <HandCoins className="w-5 h-5 text-emerald-300" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Comigo</h2>
          <p className="text-xs text-zinc-400">Seu sócio no celular: vende, precifica e mostra quanto sobra de verdade.</p>
        </div>
      </div>

      {/* Contadores da caderneta (dados reais do /overview) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 my-5">
        {[
          { label: 'Fichas de preço', value: loading ? '—' : String(ov?.recipes ?? 0) },
          { label: 'Pedidos em aberto', value: loading ? '—' : String(ov?.openOrders ?? 0) },
          { label: 'A receber (fiado)', value: loading ? '—' : brl(ov?.fiadoReceivable) },
          { label: 'Lista negra', value: loading ? '—' : String(ov?.blacklisted ?? 0) },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">{c.label}</div>
            <div className="text-xl font-semibold text-zinc-100 mt-1">{c.value}</div>
          </div>
        ))}
      </div>

      {/* Sub-abas */}
      <div className="flex gap-2 border-b border-zinc-800">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === t.key ? 'border-emerald-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 mt-4 text-center">
        <Sparkles className="w-6 h-6 text-emerald-300 mx-auto mb-2" />
        <div className="text-sm font-medium text-zinc-200">{active.label} — em construção</div>
        <p className="text-xs text-zinc-400 max-w-md mx-auto mt-1.5">{active.desc}</p>
        {loading && (
          <div className="flex items-center justify-center gap-2 text-xs text-zinc-500 mt-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> carregando…
          </div>
        )}
      </div>
    </div>
  );
}

export default ComigoView;
