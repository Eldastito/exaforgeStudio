/**
 * FiscalProfilePanel — ADR-181 F8b (UI): Perfil Fiscal do lojista + advisor Simples híbrido +
 * simulação de tributos. Consome as rotas /api/fiscal/* (owner/admin). Honesto: reflete o que o
 * backend diz (incompleto/aguardando alíquota), nunca inventa número.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Landmark, Save, Loader2, Info, Calculator } from 'lucide-react';
import { toast } from '@/src/lib/toast';
import { apiFetch } from '@/src/lib/api';

const REGIME_LABEL: Record<string, string> = {
  mei: 'MEI', simples: 'Simples Nacional', simples_hibrido: 'Simples híbrido (regime regular)',
  presumido: 'Lucro Presumido', real: 'Lucro Real',
};
const MISSING_LABEL: Record<string, string> = {
  cnpj: 'CNPJ', regime: 'Regime tributário', municipalityIbge: 'Código IBGE do município', uf: 'UF',
};
const brl = (n: number | null | undefined) => n == null ? '—' : `R$ ${Number(n).toFixed(2).replace('.', ',')}`;

export function FiscalProfilePanel() {
  const [data, setData] = useState<any>(null);
  const [advice, setAdvice] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<any>({ regime: '', municipalityIbge: '', municipalityName: '', municipalRegistration: '', stateRegistration: '' });
  const [sim, setSim] = useState<{ base: string; date: string; result: any }>({ base: '1000', date: new Date().toISOString().slice(0, 10), result: null });

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/fiscal/profile');
      if (r.ok) {
        const j = await r.json();
        setData(j);
        setForm({
          regime: j.profile.regime || '', municipalityIbge: j.profile.municipalityIbge || '',
          municipalityName: j.profile.municipalityName || '', municipalRegistration: j.profile.municipalRegistration || '',
          stateRegistration: j.profile.stateRegistration || '',
        });
      }
      const a = await apiFetch('/api/fiscal/simples-advisor');
      if (a.ok) setAdvice(await a.json());
    } catch { /* noop */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiFetch('/api/fiscal/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha ao salvar');
      toast.success('Perfil fiscal salvo.');
      load();
    } catch (e: any) { toast.error(e.message || 'Erro ao salvar'); }
    finally { setSaving(false); }
  };

  const setChoice = async (optIn: boolean) => {
    try {
      const r = await apiFetch('/api/fiscal/simples-advisor/choice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optIn }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha');
      toast.success(optIn ? 'Regime regular (híbrido) marcado.' : 'Recolhimento no DAS marcado.');
      load();
    } catch (e: any) { toast.error(e.message || 'Erro'); }
  };

  const simulate = async () => {
    try {
      const r = await apiFetch('/api/fiscal/compute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseValue: Number(sim.base), date: sim.date }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha');
      const result = await r.json();
      setSim((s) => ({ ...s, result }));
    } catch (e: any) { toast.error(e.message || 'Erro ao simular'); }
  };

  const c = data?.completeness;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="zf-page-title flex items-center gap-2"><Landmark className="w-5 h-5 text-teal-400" /> Perfil Fiscal — Reforma Tributária</h2>
        <p className="text-sm text-zinc-500 mt-1">Declare o regime e o município para o ZapFlow calcular CBS/IBS/IS pela data do fato gerador. Sem esses dados, o cálculo fica indisponível — o sistema nunca chuta.</p>
      </div>

      {/* Completeness */}
      {c && !c.complete && (
        <div className="rounded-xl border border-amber-700/50 bg-amber-500/5 p-3 text-sm text-amber-200 flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Falta preencher: {c.missing.map((m: string) => MISSING_LABEL[m] || m).join(', ')}.</span>
        </div>
      )}

      {/* Formulário do perfil */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-sm text-zinc-400">Regime tributário
            <select className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={form.regime} onChange={(e) => setForm({ ...form, regime: e.target.value })}>
              <option value="">— não declarado —</option>
              {(data?.regimes || []).map((r: string) => <option key={r} value={r}>{REGIME_LABEL[r] || r}</option>)}
            </select>
          </label>
          <label className="text-sm text-zinc-400">CNPJ <span className="text-zinc-600">(do cadastro)</span>
            <input disabled className="mt-1 w-full bg-zinc-950/60 border border-zinc-800 rounded p-2 text-sm text-zinc-500" value={data?.profile?.cnpj || '—'} />
          </label>
          <label className="text-sm text-zinc-400">Código IBGE do município
            <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="ex.: 4314902" value={form.municipalityIbge} onChange={(e) => setForm({ ...form, municipalityIbge: e.target.value })} />
          </label>
          <label className="text-sm text-zinc-400">Município
            <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="ex.: Porto Alegre" value={form.municipalityName} onChange={(e) => setForm({ ...form, municipalityName: e.target.value })} />
          </label>
          <label className="text-sm text-zinc-400">Inscrição municipal
            <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={form.municipalRegistration} onChange={(e) => setForm({ ...form, municipalRegistration: e.target.value })} />
          </label>
          <label className="text-sm text-zinc-400">Inscrição estadual
            <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={form.stateRegistration} onChange={(e) => setForm({ ...form, stateRegistration: e.target.value })} />
          </label>
        </div>
        <div className="flex justify-end">
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Salvar perfil
          </button>
        </div>
      </div>

      {/* Advisor Simples híbrido */}
      {advice?.applicable && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h3 className="text-sm font-semibold text-zinc-100 mb-1">DAS × Regime regular (Simples híbrido)</h3>
          <p className="text-[13px] text-zinc-500 mb-3">{advice.disclaimer}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            {['das', 'regime_regular'].map((path) => (
              <div key={path} className={`rounded-xl border p-3 ${advice.currentChoice === path ? 'border-teal-600/60 bg-teal-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
                <div className="text-sm font-medium text-zinc-200 mb-1">{path === 'das' ? 'Dentro do DAS' : 'Regime regular (por fora)'} {advice.currentChoice === path && <span className="text-[10px] text-teal-300">· atual</span>}</div>
                <ul className="text-[12px] text-zinc-400 space-y-1 list-disc pl-4">
                  {advice.factors.filter((f: any) => f.path === path).map((f: any, i: number) => <li key={i}>{f.text}</li>)}
                </ul>
                <button onClick={() => setChoice(path === 'regime_regular')} className="mt-2 text-[11px] rounded bg-zinc-800 hover:bg-teal-600/70 text-zinc-200 px-2 py-1">Marcar como minha escolha</button>
              </div>
            ))}
          </div>
          {advice.signals?.hasCreditableInputs && <p className="text-[11px] text-zinc-500">Você tem custo de insumos lançado — no regime regular esse crédito pode ser aproveitado.</p>}
        </div>
      )}

      {/* Simulação */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5 mb-3"><Calculator className="w-4 h-4 text-teal-400" /> Simular tributos de uma venda</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-zinc-400">Valor (R$)
            <input className="mt-1 w-32 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={sim.base} onChange={(e) => setSim({ ...sim, base: e.target.value })} />
          </label>
          <label className="text-sm text-zinc-400">Data
            <input type="date" className="mt-1 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" value={sim.date} onChange={(e) => setSim({ ...sim, date: e.target.value })} />
          </label>
          <button onClick={simulate} className="rounded-lg bg-zinc-800 hover:bg-teal-600/70 text-zinc-100 px-3 py-2 text-sm">Calcular</button>
        </div>
        {sim.result && (
          <div className="mt-3 text-sm">
            {sim.result.status === 'profile_incomplete' ? (
              <p className="text-amber-300">{sim.result.note}</p>
            ) : (
              <div className="space-y-1">
                {(['cbs', 'ibs', 'is'] as const).map((t) => {
                  const line = sim.result.taxes[t];
                  return <div key={t} className="flex justify-between text-zinc-300"><span>{t.toUpperCase()}{line.rate != null ? ` (${line.rate}%)` : ''}</span><span>{line.status === 'computed' ? brl(line.amount) : line.status === 'not_applicable' ? '—' : 'aguardando alíquota'}</span></div>;
                })}
                <div className="flex justify-between text-zinc-100 font-medium border-t border-zinc-800 pt-1"><span>Total{sim.result.partial ? ' (parcial)' : ''}</span><span>{brl(sim.result.totalTax)}</span></div>
                <p className="text-[11px] text-zinc-500 mt-1">{sim.result.note}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default FiscalProfilePanel;
