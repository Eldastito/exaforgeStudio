import { useState } from 'react';
import { ClipboardCheck, ChevronDown, Loader2 } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useAuth } from '@/src/contexts/AuthContext';
import {
  periodLabel, splitAgenda, planLines, decisionLines, supplierLines, metricValue, evidenceLabel, reviewConfidenceLabel,
} from './boardReviewLabels';

/**
 * Revisão do mês (Board Review, ADR-205 F4.10) dentro da Central de Saúde — SEM menu novo. Só EXIBE o que o servidor compôs:
 * pauta de fatos primeiro, depois as fontes. Não conclui, não recomenda, não envia, não executa. Só carrega quando o dono abre.
 * Dinheiro é do gestor (§73): a rota recusa os demais e o cartão nem aparece pra eles.
 */
export function BoardReviewCard() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<'month' | 'quarter'>('month');
  const [data, setData] = useState<any | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'forbidden' | 'error'>('idle');

  if (user?.role !== 'owner' && user?.role !== 'admin') return null;

  const load = (p: 'month' | 'quarter') => {
    setPeriod(p); setState('loading');
    apiFetch(`/api/health-center/board-review?period=${p}`)
      .then(async (r) => {
        if (r.status === 403) { setState('forbidden'); setData(null); return; }
        if (!r.ok) { setState('error'); setData(null); return; }
        setData(await r.json()); setState('idle');
      })
      .catch(() => { setState('error'); setData(null); });
  };
  const toggle = () => { const next = !open; setOpen(next); if (next && !data && state !== 'loading') load(period); };
  const agenda = splitAgenda(data?.agenda);
  const sec = (key: string) => (data?.sections || []).find((s: any) => s.key === key);

  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button onClick={toggle} className="w-full flex items-center justify-between gap-3 p-4 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2 min-w-0">
          <ClipboardCheck className="w-4 h-4 text-indigo-300 shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">Revisão do mês</span>
            <span className="block text-[12px] text-zinc-400">O que conversar com a equipe sobre o mês que fechou — só fatos medidos.</span>
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <div className="inline-flex rounded-lg border border-zinc-800 overflow-hidden text-xs">
            {(['month', 'quarter'] as const).map((p) => (
              <button key={p} onClick={() => load(p)} className={`px-3 py-1.5 ${period === p ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/50'}`}>{p === 'month' ? 'Mês' : 'Trimestre'}</button>
            ))}
          </div>
          {state === 'loading' && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Montando a revisão…</div>}
          {state === 'forbidden' && <p className="text-sm text-zinc-400">Esta revisão mostra números do negócio e é só do gestor.</p>}
          {state === 'error' && <p className="text-sm text-zinc-400">Não consegui montar a revisão agora. Tente de novo em instantes.</p>}
          {data && state === 'idle' && (
            <>
              <div className="text-[12px] text-zinc-500">{periodLabel(data.periodKey)} · {reviewConfidenceLabel(data.confidence?.level)}</div>
              {!data.pilot?.validated && <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200/90">{data.pilot?.statement}</p>}

              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Pauta</div>
                {agenda.facts.length === 0
                  ? <p className="text-sm text-zinc-400">Nenhum ponto fora do esperado nas fontes que têm dado.</p>
                  : <ul className="space-y-1">{agenda.facts.map((a, i) => <li key={i} className="text-sm text-zinc-200">• {a.text}</li>)}</ul>}
              </div>

              {[
                ['resultado', (s: any) => (s.data?.sections || []).flatMap((x: any) => (x.lines || []) as string[])],
                ['plano', (s: any) => planLines(s.data)],
                ['decisoes', (s: any) => decisionLines(s.data)],
                ['fornecedores', (s: any) => supplierLines(s.data)],
              ].map(([key, lines]: any) => {
                const s = sec(key); if (!s?.available) return null;
                const ls: string[] = lines(s); if (!ls.length) return null;
                return <div key={key}><Block title={s.title} lines={ls} /></div>;
              })}

              {sec('lojas')?.available && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{sec('lojas').title}</div>
                  {sec('lojas').data.metrics.map((m: any) => (
                    <div key={m.key} className="mb-1.5">
                      <div className="text-sm text-zinc-200">{m.label}: mediana {metricValue(m.unit, m.median)}</div>
                      {(m.questions || []).map((q: string, i: number) => <div key={i} className="text-[12px] text-zinc-400">? {q}</div>)}
                    </div>
                  ))}
                </div>
              )}

              {sec('externo')?.available && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{sec('externo').title}</div>
                  {sec('externo').data.items.map((it: any, i: number) => (
                    <div key={i} className="mb-1.5">
                      <div className="text-sm text-zinc-200">{it.topic} <span className="text-[11px] text-zinc-500">· {evidenceLabel(it.label)}</span></div>
                      {it.summary && <div className="text-[12px] text-zinc-400">{it.summary}</div>}
                    </div>
                  ))}
                </div>
              )}

              {agenda.gaps.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Ainda sem dado</div>
                  <ul className="space-y-0.5">{agenda.gaps.map((a, i) => <li key={i} className="text-[12px] text-zinc-500">• {a.text}</li>)}</ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Block({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{title}</div>
      <ul className="space-y-0.5">{lines.map((l, i) => <li key={i} className="text-sm text-zinc-300">{l}</li>)}</ul>
    </div>
  );
}
