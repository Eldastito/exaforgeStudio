import { useState } from 'react';
import { Target, ChevronDown, Loader2 } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useAuth } from '@/src/contexts/AuthContext';
import { periodLabel } from '@/src/features/boardreview/boardReviewLabels';
import { currentMonthKeySP, parseMoneyInput, withRevenueTarget, revenueTargetOf, revenueLine, previousLine, budgetLines, eventLines } from './planLabels';

/**
 * Plano do mês (ADR-205 F4.4/F4.12) dentro da Central de Saúde — SEM menu novo. O dono digita UMA coisa (a meta de faturamento do mês) e acompanha o
 * realizado. O plano é decisão dele: a tela não sugere meta nem prevê nada. Orçamento e eventos já cadastrados são preservados ao alterar a meta.
 * Só carrega ao abrir. Dinheiro é do gestor (§73): a rota recusa os demais e o cartão nem aparece pra eles.
 */
export function StrategicPlanCard() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'forbidden' | 'error'>('idle');
  const [plan, setPlan] = useState<any | null>(null);
  const [track, setTrack] = useState<any | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (user?.role !== 'owner' && user?.role !== 'admin') return null;
  const monthKey = currentMonthKeySP();

  const load = async () => {
    setState('loading'); setMsg(null);
    try {
      const r = await apiFetch('/api/health-center/plans?periodType=month');
      if (r.status === 403) { setState('forbidden'); return; }
      if (!r.ok) { setState('error'); return; }
      const list: any[] = (await r.json())?.plans || [];
      const mine = list.filter((p) => p.periodKey === monthKey && p.status !== 'closed').sort((a, b) => (a.status === 'active' ? -1 : 1) - (b.status === 'active' ? -1 : 1))[0];
      if (!mine) { setPlan(null); setTrack(null); setLoaded(true); setState('idle'); return; }
      const [pr, tr] = await Promise.all([apiFetch(`/api/health-center/plans/${mine.id}`), apiFetch(`/api/health-center/plans/${mine.id}/track`)]);
      if (!pr.ok || !tr.ok) { setState('error'); return; }
      setPlan(await pr.json()); setTrack(await tr.json()); setLoaded(true); setState('idle');
    } catch { setState('error'); }
  };
  const toggle = () => { const next = !open; setOpen(next); if (next && !loaded && state !== 'loading') load(); };

  const call = async (path: string, method: string, body?: any) => {
    const r = await apiFetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error || `Não consegui salvar (HTTP ${r.status}).`);
    return d;
  };

  const save = async () => {
    const amount = parseMoneyInput(value);
    if (amount == null) { setMsg('Digite a meta em reais, maior que zero (ex.: 150.000).'); return; }
    setBusy(true); setMsg(null);
    try {
      if (plan) {
        await call(`/api/health-center/plans/${plan.id}`, 'PUT', { lines: withRevenueTarget(plan.lines, amount), changeNote: 'Meta de faturamento alterada na Central de Saúde' });
      } else {
        const created = await call('/api/health-center/plans', 'POST', { periodType: 'month', periodKey: monthKey, title: `Plano de ${periodLabel(monthKey)}`, lines: [{ kind: 'revenue_target', label: 'Faturamento', amount }] });
        try { await call(`/api/health-center/plans/${created.id}/activate`, 'POST'); }
        catch (e: any) { setMsg(`Plano criado como rascunho, mas não consegui ativar: ${e.message}`); }
      }
      setEditing(false); setValue(''); await load();
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  };
  const activate = async () => {
    setBusy(true); setMsg(null);
    try { await call(`/api/health-center/plans/${plan.id}/activate`, 'POST'); await load(); } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  };

  const target = revenueTargetOf(plan);
  const showForm = loaded && (!plan || editing);

  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
      <button onClick={toggle} className="w-full flex items-center justify-between gap-3 p-4 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2 min-w-0">
          <Target className="w-4 h-4 text-emerald-300 shrink-0" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">Plano do mês</span>
            <span className="block text-[12px] text-zinc-400">Defina a meta de faturamento e acompanhe quanto já foi feito.</span>
          </span>
        </span>
        <ChevronDown className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          {state === 'loading' && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>}
          {state === 'forbidden' && <p className="text-sm text-zinc-400">O plano mostra faturamento e orçamento e é só do gestor.</p>}
          {state === 'error' && <p className="text-sm text-zinc-400">Não consegui carregar o plano agora. Tente de novo em instantes.</p>}
          {loaded && state === 'idle' && plan && (
            <>
              <div className="text-[12px] text-zinc-500">{periodLabel(plan.periodKey)}{plan.status === 'draft' ? ' · rascunho (ainda não ativado)' : ''}</div>
              {revenueLine(track) ? <p className="text-sm text-zinc-200">{revenueLine(track)}</p> : <p className="text-sm text-zinc-400">Este plano não tem meta de faturamento.</p>}
              {previousLine(track) && <p className="text-[12px] text-zinc-400">{previousLine(track)}</p>}
              {budgetLines(track).length > 0 && <ul className="space-y-0.5">{budgetLines(track).map((l, i) => <li key={i} className="text-[12px] text-zinc-400">• {l}</li>)}</ul>}
              {eventLines(track).length > 0 && <ul className="space-y-0.5">{eventLines(track).map((l, i) => <li key={i} className="text-[12px] text-zinc-400">• {l}</li>)}</ul>}
              <p className="text-[11px] text-zinc-500">É o seu plano, não uma previsão. O realizado vem dos fechamentos diários das lojas; o ritmo é uma régua simples de calendário.</p>
              <div className="flex gap-2">
                {plan.status === 'draft' && <button disabled={busy} onClick={activate} className="rounded-lg bg-emerald-600/80 hover:bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">Ativar plano</button>}
                {!editing && <button onClick={() => { setEditing(true); setValue(target != null ? String(target).replace('.', ',') : ''); setMsg(null); }} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">Alterar meta</button>}
              </div>
            </>
          )}
          {showForm && state === 'idle' && (
            <div className="space-y-2">
              {!plan && <p className="text-sm text-zinc-300">Você ainda não definiu a meta de faturamento de {periodLabel(monthKey)}.</p>}
              <label className="block text-[12px] text-zinc-400">Meta de faturamento do mês (R$)</label>
              <div className="flex gap-2">
                <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="ex.: 150.000" className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                <button disabled={busy} onClick={save} className="rounded-lg bg-emerald-600/80 hover:bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">{plan ? 'Salvar meta' : 'Definir meta do mês'}</button>
                {editing && <button onClick={() => { setEditing(false); setMsg(null); }} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300">Cancelar</button>}
              </div>
            </div>
          )}
          {msg && <p className="text-[12px] text-amber-300">{msg}</p>}
        </div>
      )}
    </div>
  );
}
