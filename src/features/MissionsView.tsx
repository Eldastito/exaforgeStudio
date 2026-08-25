/**
 * MissionsView — ADR-189 F13 (UI do Mission OS). A tela onde o operador vê e opera missões,
 * consumindo /api/missions/* (F1–F11). Honesto: reflete o backend (planejamento reverso, prontidão,
 * trajetória, debrief), nunca inventa número. Só aparece com o Mission Layer ligado (gate server-side).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Rocket, Plus, Target, Gauge, TrendingUp, Loader2, Flag, AlertTriangle, CheckCircle2, X, Lightbulb, ArrowRight } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

const brl = (n: number | null | undefined) => n == null ? '—' : `R$ ${Number(n).toLocaleString('pt-BR')}`;
const num = (n: number | null | undefined) => n == null ? '—' : String(Math.round(Number(n)));

const STATUS_CLS: Record<string, string> = {
  achieved: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  at_risk: 'text-red-300 bg-red-500/10 border-red-500/30',
  waiting_approval: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  running: 'text-teal-300 bg-teal-500/10 border-teal-500/30',
  failed: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30',
  cancelled: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/30',
};
const clsFor = (s: string) => STATUS_CLS[s] || 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30';

export function MissionsView() {
  const [missions, setMissions] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any | null>(null);
  const [selected, setSelected] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<any>({ title: '', targetMetric: '', targetValue: '', deadline: '' });

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/missions');
      if (r.ok) setMissions((await r.json()).missions || []);
    } catch { /* noop */ }
    try {
      const r = await apiFetch('/api/missions/metrics');
      if (r.ok) setMetrics(await r.json());
    } catch { /* noop */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.title.trim()) { toast.error('Dê um título à missão.'); return; }
    try {
      const body: any = { title: form.title.trim(), deadline: form.deadline || null };
      if (form.targetMetric) body.targetMetric = form.targetMetric;
      if (form.targetValue) { body.targetValue = Number(form.targetValue); body.targetUnit = form.targetMetric === 'appointments' ? 'count' : 'BRL'; }
      const r = await apiFetch('/api/missions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha ao criar');
      toast.success('Missão criada.');
      setForm({ title: '', targetMetric: '', targetValue: '', deadline: '' });
      setCreating(false);
      load();
    } catch (e: any) { toast.error(e.message || 'Erro'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="zf-page-title flex items-center gap-2"><Rocket className="w-5 h-5 text-teal-400" /> Missões</h2>
          <p className="text-sm text-zinc-500 mt-1">Você escolhe o resultado; o ZapFlow planeja o caminho, verifica a prontidão e acompanha — pedindo você só quando precisa.</p>
        </div>
        <button onClick={() => setCreating((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-teal-500">
          <Plus className="w-4 h-4" /> Nova missão
        </button>
      </div>

      {metrics && metrics.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          <Kpi label="Missões" value={String(metrics.total)} />
          <Kpi label="Em andamento" value={String(metrics.inFlight)} tone="teal" />
          <Kpi label="Concluídas" value={String(metrics.achieved)} tone="emerald" />
          <Kpi label="Em risco" value={String(metrics.atRisk)} tone={metrics.atRisk > 0 ? 'red' : 'zinc'} />
          <Kpi label="Taxa de conclusão" value={metrics.achievedRatePct == null ? '—' : `${metrics.achievedRatePct}%`} />
          <Kpi label="Viraram ação" value={metrics.governedActionRatePct == null ? '—' : `${metrics.governedActionRatePct}%`} />
        </div>
      )}

      {creating && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm text-zinc-400 sm:col-span-2">O que você quer alcançar?
              <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="ex.: Recuperar R$ 20.000 de inadimplência" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label className="text-sm text-zinc-400">Métrica-alvo (opcional)
              <select className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={form.targetMetric} onChange={(e) => setForm({ ...form, targetMetric: e.target.value })}>
                <option value="">— qualitativa —</option>
                <option value="revenue">Receita (R$)</option>
                <option value="appointments">Atendimentos</option>
                <option value="receivables">Cobrança recuperada (R$)</option>
              </select>
            </label>
            <label className="text-sm text-zinc-400">Alvo
              <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="ex.: 20000" value={form.targetValue} onChange={(e) => setForm({ ...form, targetValue: e.target.value })} />
            </label>
            <label className="text-sm text-zinc-400">Prazo
              <input type="date" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setCreating(false)} className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700">Cancelar</button>
            <button onClick={create} className="rounded-lg bg-teal-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-teal-500">Criar</button>
          </div>
        </div>
      )}

      {!missions.length && !creating && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-zinc-500">
          Nenhuma missão ainda. Crie a primeira — ou deixe o ZapFlow propor a partir dos sinais do negócio.
        </div>
      )}

      <div className="grid grid-cols-1 gap-2">
        {missions.map((m) => (
          <button key={m.id} onClick={() => setSelected(m)} className="text-left rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 hover:border-zinc-700 transition-colors">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-zinc-100">{m.title}</span>
              <span className={`text-[11px] rounded-full border px-2.5 py-1 shrink-0 ${clsFor(m.status)}`}>{m.humanStatus}</span>
            </div>
            <div className="mt-1 text-[12px] text-zinc-500 flex flex-wrap gap-x-3">
              {m.targetMetric && <span>Alvo: {m.targetUnit === 'BRL' ? brl(m.targetValue) : num(m.targetValue)}</span>}
              {m.deadline && <span>Prazo: {m.deadline}</span>}
              {m.source !== 'user' && <span className="text-teal-400/70">proposta pelo ZapFlow</span>}
            </div>
          </button>
        ))}
      </div>

      {selected && <MissionDetail mission={selected} onClose={() => { setSelected(null); load(); }} />}
    </div>
  );
}

// ── Detalhe da missão: contrato + plano reverso + prontidão + trajetória + debrief ──
function MissionDetail({ mission, onClose }: { mission: any; onClose: () => void }) {
  const [plan, setPlan] = useState<any | null>(null);
  const [ready, setReady] = useState<any | null>(null);
  const [checkpoint, setCheckpoint] = useState<any | null>(null);
  const [debrief, setDebrief] = useState<any | null>(null);
  const [nextStep, setNextStep] = useState<any | null>(null);
  const [premises, setPremises] = useState<any>({});
  const [busy, setBusy] = useState<string | null>(null);

  const isAgenda = mission.targetMetric === 'appointments';
  // Converte % (ex.: 25) em fração (0.25); vazio → não envia (o backend deriva ou marca honesto).
  const pctToFrac = (v: any) => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n > 0 ? Math.min(1, n / 100) : undefined; };
  const numOrU = (v: any) => { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n > 0 ? n : undefined; };
  const premisesBody = () => {
    const b: any = {};
    if (isAgenda) {
      const sr = pctToFrac(premises.showRate); if (sr !== undefined) b.showRate = sr;
      const bc = pctToFrac(premises.bookingConversionRate); if (bc !== undefined) b.bookingConversionRate = bc;
    } else {
      const at = numOrU(premises.avgTicket); if (at !== undefined) b.avgTicket = at;
      const sc = pctToFrac(premises.saleConversionRate); if (sc !== undefined) b.saleConversionRate = sc;
      const cc = pctToFrac(premises.contactConversionRate); if (cc !== undefined) b.contactConversionRate = cc;
    }
    return b;
  };

  const call = async (key: string, url: string, method = 'GET', body?: any) => {
    setBusy(key);
    try {
      const r = await apiFetch(url, method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : undefined);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Falha');
      return j;
    } catch (e: any) { toast.error(e.message || 'Erro'); return null; }
    finally { setBusy(null); }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-2xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-zinc-800 bg-zinc-950 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-zinc-100">{mission.title}</h3>
            <span className={`mt-1 inline-block text-[11px] rounded-full border px-2.5 py-0.5 ${clsFor(mission.status)}`}>{mission.humanStatus}</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>

        {mission.desiredState && <p className="text-sm text-zinc-400">Estado desejado: {mission.desiredState}</p>}

        {/* Premissas do plano (opcionais) — vazio = derivado do seu histórico ou marcado honesto.
            Preenchê-las deixa o plano/próximo passo completos (senão a cadeia para na premissa). */}
        {mission.targetMetric && (
          <details className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
            <summary className="text-[13px] text-zinc-300 cursor-pointer">Premissas do plano <span className="text-zinc-500">(opcional — vazio = estimado do histórico)</span></summary>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {isAgenda ? (
                <>
                  <label className="text-[11px] text-zinc-400">Comparecimento %<input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100" placeholder="ex.: 80" value={premises.showRate ?? ''} onChange={(e) => setPremises({ ...premises, showRate: e.target.value })} /></label>
                  <label className="text-[11px] text-zinc-400">Contato → agendamento %<input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100" placeholder="ex.: 25" value={premises.bookingConversionRate ?? ''} onChange={(e) => setPremises({ ...premises, bookingConversionRate: e.target.value })} /></label>
                </>
              ) : (
                <>
                  <label className="text-[11px] text-zinc-400">Ticket médio R$<input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100" placeholder="derivado das vendas" value={premises.avgTicket ?? ''} onChange={(e) => setPremises({ ...premises, avgTicket: e.target.value })} /></label>
                  <label className="text-[11px] text-zinc-400">Oportunidade → venda %<input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100" placeholder="ex.: 25" value={premises.saleConversionRate ?? ''} onChange={(e) => setPremises({ ...premises, saleConversionRate: e.target.value })} /></label>
                  <label className="text-[11px] text-zinc-400">Contato → oportunidade %<input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-sm text-zinc-100" placeholder="ex.: 40" value={premises.contactConversionRate ?? ''} onChange={(e) => setPremises({ ...premises, contactConversionRate: e.target.value })} /></label>
                </>
              )}
            </div>
          </details>
        )}

        {/* Ações de análise */}
        <div className="flex flex-wrap gap-2">
          <button onClick={async () => setPlan(await call('plan', `/api/missions/${mission.id}/plan`, 'POST', premisesBody()))} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-[13px] text-zinc-200 hover:bg-zinc-700">{busy === 'plan' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Target className="w-3.5 h-3.5" />} Plano</button>
          <button onClick={async () => setReady(await call('ready', `/api/missions/${mission.id}/readiness`, 'POST', premisesBody()))} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-[13px] text-zinc-200 hover:bg-zinc-700">{busy === 'ready' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Gauge className="w-3.5 h-3.5" />} Prontidão</button>
          <button onClick={async () => setCheckpoint(await call('cp', `/api/missions/${mission.id}/checkpoint`))} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-[13px] text-zinc-200 hover:bg-zinc-700">{busy === 'cp' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5" />} Trajetória</button>
          <button onClick={async () => setDebrief(await call('deb', `/api/missions/${mission.id}/debrief`))} className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-[13px] text-zinc-200 hover:bg-zinc-700">{busy === 'deb' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Flag className="w-3.5 h-3.5" />} Debrief</button>
          <button onClick={async () => setNextStep(await call('next', `/api/missions/${mission.id}/next-step`, 'POST', premisesBody()))} className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600/20 border border-teal-600/40 px-3 py-1.5 text-[13px] text-teal-200 hover:bg-teal-600/30">{busy === 'next' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lightbulb className="w-3.5 h-3.5" />} O que eu faço agora?</button>
        </div>

        {/* Plano reverso */}
        {plan && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-[13px] font-medium text-zinc-200 mb-2">Plano reverso</div>
            {plan.applicable ? (
              <div className="space-y-1">
                {plan.chain.map((s: any, i: number) => (
                  <div key={i} className="flex justify-between text-[13px]">
                    <span className={s.stage === plan.criticalStage ? 'text-amber-300' : 'text-zinc-400'}>{s.label}{s.stage === plan.criticalStage ? ' · gargalo' : ''}</span>
                    <span className="text-zinc-200 tabular-nums">{s.value == null ? (s.basis === 'unknown' ? 'falta premissa' : '—') : s.unit === 'BRL' ? brl(s.value) : num(s.value)}</span>
                  </div>
                ))}
                {plan.gap && plan.gap.missing > 0 && <div className="text-[12px] text-amber-200 mt-1">Gap: faltam ~{num(plan.gap.missing)} contatos/oportunidades.</div>}
                {plan.lastSafeMoment && <div className="text-[11px] text-zinc-500 mt-1">Último momento seguro pra começar: {plan.lastSafeMoment.date}.</div>}
              </div>
            ) : <p className="text-[12px] text-zinc-500">{plan.note}</p>}
          </div>
        )}

        {/* Prontidão */}
        {ready && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="flex items-baseline justify-between mb-2"><span className="text-[13px] font-medium text-zinc-200">Prontidão</span><span className="text-sm font-semibold text-teal-300">{ready.readyPct}% · {ready.humanState}</span></div>
            <ul className="space-y-1">
              {ready.dimensions.map((d: any) => (
                <li key={d.key} className="flex items-start gap-2 text-[12px]">
                  {d.ready === true ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" /> : d.ready === false ? <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" /> : <span className="w-3.5 h-3.5 shrink-0 text-zinc-600 text-center">–</span>}
                  <span className="text-zinc-400"><span className="text-zinc-300">{d.label}:</span> {d.detail}</span>
                </li>
              ))}
            </ul>
            {ready.risks?.length > 0 && <p className="text-[12px] text-amber-200 mt-2">{ready.risks.length} risco(s) antecedente(s) a considerar.</p>}
          </div>
        )}

        {/* Trajetória */}
        {checkpoint && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-[13px] font-medium text-zinc-200 mb-1">Trajetória</div>
            <p className={`text-[13px] ${checkpoint.status === 'on_track' ? 'text-emerald-300' : checkpoint.status === 'not_applicable' ? 'text-zinc-400' : 'text-amber-200'}`}>{checkpoint.note}</p>
          </div>
        )}

        {/* Debrief */}
        {debrief && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
            <div className="text-[13px] font-medium text-zinc-200 mb-1">Debrief</div>
            <ul className="list-disc pl-4 space-y-0.5 text-[12px] text-zinc-400">{debrief.lessons.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
          </div>
        )}

        {/* Próximo passo (F15/F16) — alavanca sugerida a partir do gargalo, encaminhada pelo caminho governado */}
        {nextStep && (
          <div className="rounded-xl border border-teal-800/40 bg-teal-950/20 p-4">
            <div className="text-[13px] font-medium text-teal-200 mb-1 flex items-center gap-1.5"><Lightbulb className="w-3.5 h-3.5" /> Próximo passo</div>
            {nextStep.suggestable && nextStep.lever ? (
              <div className="space-y-2">
                <p className="text-[13px] text-zinc-200">{nextStep.lever.title}</p>
                <p className="text-[12px] text-zinc-400">{nextStep.lever.rationale}</p>
                <div className="text-[11px] text-zinc-500 flex flex-wrap gap-x-3">
                  {nextStep.criticalStage && <span>Gargalo: {nextStep.criticalStage}</span>}
                  {nextStep.lever.expectedImpact != null && <span>Impacto p/ a meta: {nextStep.lever.impactUnit === 'BRL' ? brl(nextStep.lever.expectedImpact) : num(nextStep.lever.expectedImpact)}</span>}
                </div>
                {nextStep.autonomyReady ? (
                  <button
                    onClick={async () => {
                      const r = await call('propose', `/api/missions/${mission.id}/next-step/propose`, 'POST', premisesBody());
                      if (r) { toast.success('Ação proposta — aguardando sua aprovação.'); setNextStep(await call('next', `/api/missions/${mission.id}/next-step`, 'POST', premisesBody())); }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-teal-500"
                  >{busy === 'propose' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />} Propor ação (governada)</button>
                ) : (
                  <p className="text-[11px] text-amber-200/80">Ligue a autonomia da missão (ao menos "sugerir") para propor esta ação — ela nunca executa sozinha.</p>
                )}
              </div>
            ) : <p className="text-[12px] text-zinc-500">{nextStep.reason}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// Chip de KPI do piloto (F21). Honesto: valor "—" quando a métrica é null (sem denominador).
function Kpi({ label, value, tone = 'zinc' }: { label: string; value: string; tone?: 'zinc' | 'teal' | 'emerald' | 'red' }) {
  const cls: Record<string, string> = {
    zinc: 'text-zinc-100', teal: 'text-teal-300', emerald: 'text-emerald-300', red: 'text-red-300',
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <p className={`text-lg font-semibold tabular-nums ${cls[tone]}`}>{value}</p>
      <p className="text-[11px] text-zinc-500 mt-0.5">{label}</p>
    </div>
  );
}

export default MissionsView;
