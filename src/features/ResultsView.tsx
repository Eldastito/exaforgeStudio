/**
 * ResultsView (ADR-203 F2.5) — "Resultados": a conclusão primeiro, depois a rede, as lojas (quem precisa de atenção
 * no topo) e o "Entender" de cada loja. Só RENDERIZA `GET /api/ux/results-story` (RN-F2-4). Sem fechamento = "—",
 * nunca "vendeu 0"; hipótese aparece rotulada como hipótese, nunca como causa.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, ChevronDown, Lightbulb } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { trackAction } from '@/src/lib/uxTelemetry';

interface MT { state: string; text: string; reason: string | null }
interface PT { venda: MT; cota: MT; atingimento: MT }
interface Store { storeId: string; name: string; status: 'below' | 'no_data' | 'hit'; day: PT; month: PT }
interface Story {
  date: string; restricted: boolean; hasRetail: boolean; headline: string | null; headlineReason: string | null; basis: string;
  network: null | { day: PT; week: PT; month: PT; storesHit: number | null; storesBelow: number | null; storesNoData: number };
  stores: Store[];
  solved: null | { categories: Record<string, Cat>; disclaimer: string };
}
type Cat = { unit: string; total: number | null; restricted: boolean; lineCount?: number; lines?: any[] };
interface Understand {
  periods: null | { day: PT; week: PT; month: PT };
  team: Array<{ sellerId: string; name: string; salesDeltaPct: number | null; findings: Array<{ kind: 'fact' | 'hypothesis'; text: string }> }>;
  notes: string[]; restricted: boolean;
}

const STATUS: Record<Store['status'], { label: string; cls: string; icon: React.ReactNode }> = {
  below: { label: 'Abaixo da meta', cls: 'text-rose-300', icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  no_data: { label: 'Sem dado para concluir', cls: 'text-slate-400', icon: <HelpCircle className="h-3.5 w-3.5" /> },
  hit: { label: 'Bateu a meta', cls: 'text-emerald-300', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
};
const line = (p: PT) => `${p.venda.text} de ${p.cota.text}${p.atingimento.state === 'value' ? ` (${p.atingimento.text})` : ''}`;

function Period({ label, p }: { label: string; p: PT }) {
  return <div className="zf-panel-subtle p-3"><p className="text-[11px] uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-sm font-medium text-slate-100">{line(p)}</p></div>;
}

const StoreRow: React.FC<{ s: Store }> = ({ s }) => {
  const [open, setOpen] = useState(false);
  const [u, setU] = useState<Understand | null>(null);
  const [err, setErr] = useState(false);
  const st = STATUS[s.status];
  const toggle = () => {
    setOpen(o => !o);
    if (!u && !err) {
      trackAction('resultados_entender', 'loja');
      apiFetch(`/api/ux/results-story/store/${s.storeId}/understand`).then(r => r.ok ? r.json() : Promise.reject()).then(setU).catch(() => setErr(true));
    }
  };
  return (
    <div className="zf-panel-subtle" data-testid="store-row">
      <button onClick={toggle} className="flex w-full items-center gap-3 p-3 text-left" aria-expanded={open}>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-slate-100">{s.name}</p>
          <p className={`mt-0.5 inline-flex items-center gap-1 text-xs ${st.cls}`}>{st.icon}{st.label}</p>
          <p className="mt-1 text-xs text-slate-400">Dia: {line(s.day)}</p>
          <p className="text-xs text-slate-400">Mês: {line(s.month)}</p>
        </div>
        <span className="flex items-center gap-1 text-xs text-teal-300">Entender<ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} /></span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-700/60 p-3 text-sm">
          {err && <p className="text-slate-400">Não consegui carregar agora.</p>}
          {!u && !err && <p className="text-slate-500">Carregando…</p>}
          {u && u.periods && <div className="grid grid-cols-1 gap-2 sm:grid-cols-3"><Period label="Dia" p={u.periods.day} /><Period label="Semana" p={u.periods.week} /><Period label="Mês" p={u.periods.month} /></div>}
          {u && u.team.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-300">Quem mais caiu nos últimos 30 dias</p>
              {u.team.map(t => (
                <div key={t.sellerId} className="mb-2">
                  <p className="text-slate-100">{t.name}{t.salesDeltaPct !== null ? ` — vendas ${t.salesDeltaPct}% contra o período anterior` : ''}</p>
                  <ul className="mt-1 space-y-1">
                    {t.findings.map((f, i) => <li key={i} className="flex gap-2 text-xs text-slate-400">{f.kind === 'hypothesis' ? <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" /> : <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />}<span>{f.kind === 'hypothesis' ? <em>Hipótese: </em> : null}{f.text}</span></li>)}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {u && u.notes.map((n, i) => <p key={i} className="text-xs text-slate-500">{n}</p>)}
        </div>
      )}
    </div>
  );
};

export function ResultsView() {
  const [data, setData] = useState<Story | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    apiFetch('/api/ux/results-story').then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);
  if (error) return <div className="p-6 text-sm text-slate-400">Não consegui carregar os Resultados agora. Tente de novo em instantes.</div>;
  if (!data) return <div className="p-6 text-sm text-slate-500">Carregando…</div>;
  const money = data.solved ? (Object.entries(data.solved.categories) as Array<[string, Cat]>).filter(([, c]) => !c.restricted && c.total != null && c.total !== 0) : [];

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6" data-testid="results-view">
      <header>
        <h2 className="text-xl font-semibold text-slate-100" data-testid="headline">{data.headline || 'Resultados'}</h2>
        {!data.headline && data.headlineReason && <p className="mt-1 text-sm text-slate-400">{data.headlineReason}</p>}
        {data.hasRetail && !data.restricted && <p className="mt-1 text-xs text-slate-500">Dia {data.date.slice(8, 10)}/{data.date.slice(5, 7)} · {data.basis}</p>}
      </header>

      {data.network && (
        <section aria-label="Rede" className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-200">Rede</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Period label="Dia" p={data.network.day} /><Period label="Semana" p={data.network.week} /><Period label="Mês" p={data.network.month} /></div>
          {data.network.storesNoData > 0 && <p className="text-xs text-slate-500">{data.network.storesNoData} {data.network.storesNoData === 1 ? 'loja sem dado' : 'lojas sem dado'} para concluir (fechamento ou meta do dia ausente).</p>}
        </section>
      )}

      {data.stores.length > 0 && (
        <section aria-label="Lojas" className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-200">Lojas</h3>
          {data.stores.map(s => <StoreRow key={s.storeId} s={s} />)}
        </section>
      )}

      {money.length > 0 && data.solved && (
        <section aria-label="Resolvido" className="space-y-1">
          <h3 className="text-sm font-semibold text-slate-200">O que o ZappFlow resolveu</h3>
          {money.map(([name, c]) => <p key={name} className="text-sm text-slate-300">{name}: {c.unit === 'BRL' ? (c.total as number).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : `${c.total} ${c.unit}`}</p>)}
          <p className="text-xs text-slate-500">{data.solved.disclaimer}</p>
        </section>
      )}
    </div>
  );
}
