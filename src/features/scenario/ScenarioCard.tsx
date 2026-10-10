import { useState } from 'react';
import { FlaskConical, ChevronDown, Loader2 } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useAuth } from '@/src/contexts/AuthContext';
import {
  buildScenarioInputs, sourceLabel, confidenceLabel, assumptionValue, metricDisplay, sensitivityLine,
  type ScenarioKindSpec,
} from './scenarioLabels';

/**
 * Cenário "e se?" (ADR-205 F4.1 → tela F4.14) dentro da Central de Saúde — SEM menu novo. O dono escolhe o que quer simular, digita as premissas
 * e vê a faixa do resultado, as premissas usadas (com a origem de cada uma) e o que mais mexe no resultado. Só EXIBE o que o `ScenarioEngine` devolveu:
 * não calcula, não prevê, não recomenda e NÃO executa nada (cenário ≠ previsão). Só carrega quando o dono abre. Dinheiro é do gestor (§73).
 */
export function ScenarioCard() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<ScenarioKindSpec[] | null>(null);
  const [kind, setKind] = useState<string>('');
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [state, setState] = useState<'idle' | 'loading' | 'forbidden' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<any | null>(null);

  if (user?.role !== 'owner' && user?.role !== 'admin') return null;

  const spec = kinds?.find((k) => k.kind === kind);

  const loadKinds = () => {
    setState('loading');
    apiFetch('/api/health-center/simulate/scenario/kinds')
      .then(async (r) => {
        if (!r.ok) { setState('error'); return; }
        const j = await r.json(); setKinds(j.kinds || []); setState('idle');
      })
      .catch(() => setState('error'));
  };
  const toggle = () => { const next = !open; setOpen(next); if (next && !kinds && state !== 'loading') loadKinds(); };
  const pick = (k: string) => { setKind(k); setRaw({}); setOut(null); setErr(null); };

  const run = () => {
    const built = buildScenarioInputs(spec, raw);
    if ("error" in built) { setErr(built.error); setOut(null); return; }
    setErr(null); setState('loading');
    apiFetch('/api/health-center/simulate/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, inputs: built.inputs }) })
      .then(async (r) => {
        if (r.status === 403) { setState('forbidden'); setOut(null); return; }
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) { setErr(j?.message || j?.error || 'Não consegui simular agora.'); setOut(null); setState('idle'); return; }
        setOut(j); setState('idle');
      })
      .catch(() => { setState('error'); setOut(null); });
  };

  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button onClick={toggle} className="w-full flex items-center justify-between gap-3 p-4 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2 min-w-0">
          <FlaskConical className="w-4 h-4 text-indigo-300 shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">E se...?</span>
            <span className="block text-[12px] text-zinc-400">Simule uma compra, uma queda ou alta de vendas, ou uma contratação — sem executar nada.</span>
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          {state === 'forbidden' && <p className="text-sm text-zinc-400">A simulação mostra caixa, margem e receita e é só do gestor.</p>}
          {state === 'error' && <p className="text-sm text-zinc-400">Não consegui simular agora. Tente de novo em instantes.</p>}
          {!kinds && state === 'loading' && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>}
          {kinds && (
            <>
              <div className="flex flex-wrap gap-2">
                {kinds.map((k) => (
                  <button key={k.kind} onClick={() => pick(k.kind)} className={`px-3 py-1.5 rounded-lg border text-xs ${kind === k.kind ? 'border-indigo-400/60 bg-indigo-500/10 text-zinc-100' : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800/50'}`}>{k.label}</button>
                ))}
              </div>
              {spec && (
                <div className="space-y-2">
                  {spec.inputs.map((f) => (
                    <label key={f.key} className="block">
                      <span className="block text-[12px] text-zinc-400 mb-1">{f.label}{f.required ? '' : ' (opcional)'}</span>
                      <input
                        value={raw[f.key] ?? ''} onChange={(e) => setRaw({ ...raw, [f.key]: e.target.value })}
                        inputMode="decimal" placeholder={f.unit === 'pct' ? 'ex.: -20' : f.unit === 'BRL' ? 'ex.: 50.000' : ''}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100"
                      />
                    </label>
                  ))}
                  <button onClick={run} disabled={state === 'loading'} className="px-3 py-2 rounded-lg bg-indigo-500/80 hover:bg-indigo-500 text-sm text-white disabled:opacity-60">
                    {state === 'loading' ? 'Simulando…' : 'Simular'}
                  </button>
                </div>
              )}
              {err && <p className="text-sm text-amber-200/90">{err}</p>}
            </>
          )}

          {out && (
            <div className="space-y-3 border-t border-zinc-800 pt-3">
              <p className="text-sm text-zinc-100">{out.statement}</p>
              <div className="text-[12px] text-zinc-500">{out.horizon} · {confidenceLabel(out.confidence?.level)} · simulação, não previsão — nada foi executado</div>

              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Resultado (faixa aproximada)</div>
                <ul className="space-y-0.5">{(out.metrics || []).map((m: any) => <li key={m.key} className="text-sm text-zinc-300">{m.label}: <span className="text-zinc-100">{metricDisplay(m)}</span></li>)}</ul>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Premissas usadas</div>
                <ul className="space-y-0.5">{(out.assumptions || []).map((a: any) => (
                  <li key={a.key} className="text-[12px] text-zinc-300">{a.label}: {assumptionValue(a)} <span className="text-zinc-500">· {sourceLabel(a.source)}</span>{a.note ? <span className="text-zinc-500"> — {a.note}</span> : null}</li>
                ))}</ul>
              </div>

              {(out.sensitivity || []).length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">O que mais mexe no resultado</div>
                  <ul className="space-y-0.5">{out.sensitivity.map((r: any) => <li key={r.driver} className="text-[12px] text-zinc-300">{sensitivityLine(r)}</li>)}</ul>
                </div>
              )}

              {(out.confidence?.reasons || []).length > 0 && (
                <ul className="space-y-0.5">{out.confidence.reasons.map((x: string, i: number) => <li key={i} className="text-[12px] text-zinc-500">• {x}</li>)}</ul>
              )}
              {(out.caveats || []).length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">O que esta simulação não cobre</div>
                  <ul className="space-y-0.5">{out.caveats.map((x: string, i: number) => <li key={i} className="text-[12px] text-zinc-500">• {x}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
