import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

/**
 * "Entendi o que aconteceu… Quer que eu execute?" (PRD Fase 1, critério de sucesso).
 * Mostra o briefing do sinal (o que houve · causa mais provável · dados que sustentam · ação recomendada) ANTES de a ação ser criada.
 * Só chama `onConfirm` (que cria a ação governada, como antes) quando a pessoa diz "Sim". Se o briefing falhar, mostra o que já
 * temos do sinal (`fallback`) e ainda deixa decidir — nunca trava o fluxo antigo.
 */
type Brief = {
  understood: string; meaning?: string; domainLabel?: string; basis?: string | null;
  operationAffected?: 'yes' | 'no' | 'unknown';
  cause: { known: boolean; text: string; confidencePct: number | null; alternatives: string[] };
  evidence: Array<{ label: string; value: string }>;
  diagnosis?: { enough: boolean; reason?: string; findings: Array<{ kind: 'fact' | 'hypothesis'; text: string }> };
  impact?: { amount: number | null; unit: string | null; basis: string | null; restricted: boolean } | null;
  recommendation: { label: string; willDo: string };
  governance: string; question: string;
};

const fmtImpact = (i: NonNullable<Brief['impact']>) => {
  if (i.restricted || i.amount === null) return 'há impacto (valor reservado ao gestor)';
  const n = i.amount.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  if (i.unit === 'BRL') return `R$ ${n}`;
  return `${n}${i.unit ? ` ${i.unit === 'units' ? 'un' : i.unit === 'items' ? 'itens' : i.unit}` : ''}`;
};

export default function SignalBriefDialog({ signal, onClose, onConfirm }: { signal: any; onClose: () => void; onConfirm: () => Promise<void> | void }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setFailed(false); setBrief(null);
    apiFetch(`/api/insights/brief/${encodeURIComponent(signal.signalId)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('brief'))))
      .then(d => { if (alive) setBrief(d); })
      .catch(() => { if (alive) setFailed(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [signal.signalId]);

  const confirm = async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  const pres = signal.presentation || {};

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          <h3 className="flex-1 text-sm font-semibold text-zinc-100">{brief?.understood || (pres.title ? `Entendi o que aconteceu: ${pres.title}.` : 'Entendi o que aconteceu.')}</h3>
          <button onClick={onClose} aria-label="Fechar" className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
        </div>

        {loading && <div className="mt-4 flex items-center gap-2 text-[12px] text-zinc-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reunindo os dados…</div>}

        {failed && (
          <div className="mt-3 space-y-2 text-[12px] text-zinc-300">
            <p className="text-amber-300/90">Não consegui montar o resumo completo agora. Mesmo assim, aqui está o que sei:</p>
            {pres.meaning && <p>{pres.meaning}</p>}
            <p><span className="text-zinc-500">Ação recomendada:</span> {pres.actionLabel || 'Registrar e acompanhar'}{pres.actionWillDo ? ` — ${pres.actionWillDo}` : ''}</p>
          </div>
        )}

        {brief && (
          <div className="mt-3 space-y-3 text-[12px] text-zinc-300">
            {brief.meaning && <p>{brief.meaning}</p>}
            <section>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Causa</div>
              <p className={brief.cause.known ? 'text-zinc-200' : 'text-zinc-400'}>{brief.cause.text}{brief.cause.confidencePct !== null ? ` Confiança ${brief.cause.confidencePct}%.` : ''}</p>
              {brief.cause.alternatives.length > 0 && <p className="mt-0.5 text-zinc-500">Outras possibilidades: {brief.cause.alternatives.join('; ')}.</p>}
            </section>
            {(brief.evidence.length > 0 || brief.impact) && (
              <section>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Dados que sustentam{brief.basis ? ` (${brief.basis})` : ''}</div>
                <ul className="mt-0.5 space-y-0.5">
                  {brief.evidence.map(e => <li key={e.label}><span className="text-zinc-500">{e.label}:</span> {e.value}</li>)}
                  {brief.impact && <li><span className="text-zinc-500">Impacto{brief.impact.basis ? ` (${brief.impact.basis})` : ''}:</span> {fmtImpact(brief.impact)}</li>}
                </ul>
              </section>
            )}
            {brief.diagnosis && (
              <section>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Desempenho da pessoa</div>
                {!brief.diagnosis.enough ? (
                  <p className="text-zinc-400">{brief.diagnosis.reason}</p>
                ) : (
                  <ul className="mt-0.5 space-y-0.5">
                    {brief.diagnosis.findings.map((f, i) => (
                      <li key={i} className={f.kind === 'hypothesis' ? 'text-amber-300/90' : 'text-zinc-300'}>
                        <span className="text-zinc-500">{f.kind === 'hypothesis' ? 'Hipótese: ' : 'Fato: '}</span>{f.text}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <section>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Ação que recomendo</div>
              <p className="text-zinc-200">{brief.recommendation.label}</p>
              <p className="text-zinc-500">{brief.recommendation.willDo}</p>
            </section>
            <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-zinc-400">{brief.governance}</p>
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="mr-auto text-sm font-medium text-zinc-200">{brief?.question || 'Quer que eu execute?'}</span>
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">Agora não</button>
          <button onClick={confirm} disabled={busy || loading} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{busy && <Loader2 className="w-3 h-3 animate-spin" />}Sim, executar</button>
        </div>
      </div>
    </div>
  );
}
