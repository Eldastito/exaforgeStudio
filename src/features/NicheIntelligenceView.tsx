import React, { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useVisibleLimit, ShowMore } from '@/src/components/ShowMore';
import { Brain, RefreshCcw, Loader2, Save, DollarSign, Layers, Plus, AlertTriangle, BellRing, BellOff, Zap, Clock, Trash2, TrendingUp, TrendingDown, Power } from 'lucide-react';

/**
 * NicheIntelligenceView (ADR-156, DI-UI-1) — painel MASTER ADMIN da External
 * Intelligence de vertical. O admin master COLA a pesquisa de mercado do nicho
 * (provider manual, DI-4.4) e ela é compartilhada (anonimizada) entre as contas
 * daquele nicho. Também ajusta o orçamento de pesquisa de plataforma (DI-4.2).
 *
 * NÃO é um menu do lojista (PRD §31) — é ferramenta de plataforma. As contas só
 * CONSOMEM (read-only), sem tela nova.
 */

const VERTICALS: Array<{ key: string; label: string }> = [
  { key: 'varejo', label: 'Varejo' }, { key: 'moda', label: 'Moda' }, { key: 'food', label: 'Alimentação' },
  { key: 'servicos', label: 'Serviços' }, { key: 'saude', label: 'Saúde' }, { key: 'educacao', label: 'Educação' },
  { key: 'hospitalidade', label: 'Hospitalidade' }, { key: 'outro', label: 'Outro' },
];

const brl = (cents: number) => `R$ ${(Number(cents || 0) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const verticalLabel = (k: string) => VERTICALS.find((v) => v.key === k)?.label || k;

const EMPTY_FORM = { vertical: 'varejo', topic: '', region: '', timeframe: '', summary: '', drivers: '', sources: '', ttlDays: 7 };

export function NicheIntelligenceView() {
  const [budget, setBudget] = useState<any>(null);
  const [budgetInput, setBudgetInput] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const itemsPage = useVisibleLimit(items);
  const [filterVertical, setFilterVertical] = useState('');
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<any>({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [due, setDue] = useState<any[]>([]);
  const [reminderOn, setReminderOn] = useState(true);
  const [automation, setAutomation] = useState<{ enabled: boolean; items: any[] }>({ enabled: true, items: [] });
  const [autoForm, setAutoForm] = useState<any>({ vertical: 'varejo', topic: '', region: '', timeframe: '', intervalDays: 7 });
  const [autoSubmitting, setAutoSubmitting] = useState(false);

  const loadDue = () => apiFetch('/api/decision-intelligence/research-refresh-due').then((r) => r.json()).then((d) => { setDue(Array.isArray(d?.due) ? d.due : []); setReminderOn(d?.enabled !== false); }).catch(() => {});
  const loadSchedule = () => apiFetch('/api/decision-intelligence/research-schedule').then((r) => r.json()).then((d) => setAutomation({ enabled: d?.enabled !== false, items: Array.isArray(d?.items) ? d.items : [] })).catch(() => {});
  const setAF = (k: string, v: any) => setAutoForm((f: any) => ({ ...f, [k]: v }));
  const toggleAutomation = () => {
    const next = !automation.enabled;
    apiFetch('/api/decision-intelligence/research-schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) })
      .then((r) => r.json()).then((d) => { setAutomation((a) => ({ ...a, enabled: d?.enabled !== false })); toast.success(next ? 'Automação ligada.' : 'Automação desligada.'); }).catch(() => toast.error('Falha ao alterar a automação.'));
  };
  const addNiche = () => {
    if (!autoForm.topic.trim()) { toast.error('Preencha o tópico do nicho.'); return; }
    setAutoSubmitting(true);
    apiFetch('/api/decision-intelligence/research-schedule/niche', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vertical: autoForm.vertical, topic: autoForm.topic.trim(), region: autoForm.region.trim() || undefined, timeframe: autoForm.timeframe.trim() || undefined, intervalDays: Number(autoForm.intervalDays) || 7 }) })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d?.error || 'Erro'); toast.success('Nicho adicionado à automação.'); setAutoForm({ ...autoForm, topic: '', region: '', timeframe: '' }); loadSchedule(); })
      .catch((e) => toast.error(String(e?.message || e))).finally(() => setAutoSubmitting(false));
  };
  const toggleNiche = (fp: string, on: boolean) => apiFetch(`/api/decision-intelligence/research-schedule/niche/${fp}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) }).then(() => loadSchedule()).catch(() => toast.error('Falha ao alterar o nicho.'));
  const removeNiche = (fp: string) => apiFetch(`/api/decision-intelligence/research-schedule/niche/${fp}`, { method: 'DELETE' }).then(() => { toast.success('Nicho removido da automação.'); loadSchedule(); }).catch(() => toast.error('Falha ao remover.'));
  const toggleReminder = () => {
    const next = !reminderOn;
    apiFetch('/api/decision-intelligence/research-refresh-due', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) })
      .then((r) => r.json()).then((d) => { setReminderOn(d?.enabled !== false); toast.success(next ? 'Lembrete semanal ligado.' : 'Lembrete semanal desligado.'); }).catch(() => toast.error('Falha ao alterar o lembrete.'));
  };

  const loadBudget = () => apiFetch('/api/decision-intelligence/research-budget').then((r) => r.json()).then(setBudget).catch(() => {});
  const loadItems = () => {
    setLoading(true);
    apiFetch(`/api/decision-intelligence/vertical-intelligence${filterVertical ? `?vertical=${filterVertical}` : ''}`)
      .then((r) => r.json()).then((d) => setItems(Array.isArray(d?.items) ? d.items : []))
      .catch(() => setItems([])).finally(() => setLoading(false));
  };

  useEffect(() => { loadBudget(); loadDue(); loadSchedule(); }, []);
  useEffect(() => { loadItems(); }, [filterVertical]);

  const saveBudget = () => {
    const reais = parseFloat(String(budgetInput).replace(',', '.')) || 0;
    setSavingBudget(true);
    apiFetch('/api/decision-intelligence/research-budget', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthlyBudgetCents: Math.round(reais * 100) }) })
      .then((r) => r.json()).then((d) => { setBudget(d); setBudgetInput(''); toast.success('Orçamento de pesquisa atualizado.'); })
      .catch(() => toast.error('Falha ao salvar o orçamento.')).finally(() => setSavingBudget(false));
  };

  const submit = () => {
    if (!form.topic.trim() || !form.summary.trim()) { toast.error('Preencha o tópico e o texto da pesquisa.'); return; }
    setSubmitting(true);
    apiFetch('/api/decision-intelligence/vertical-intelligence/manual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vertical: form.vertical, topic: form.topic.trim(),
        region: form.region.trim() || undefined, timeframe: form.timeframe.trim() || undefined,
        summary: form.summary.trim(),
        drivers: String(form.drivers).split(',').map((s: string) => s.trim()).filter(Boolean),
        sources: String(form.sources).split(',').map((s: string) => s.trim()).filter(Boolean),
        ttlDays: Number(form.ttlDays) || 7,
      }),
    }).then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Erro ao publicar.');
      toast.success(`Pesquisa publicada para o nicho ${verticalLabel(form.vertical)}.`);
      setForm({ ...EMPTY_FORM, vertical: form.vertical });
      loadItems();
    }).catch((e) => toast.error(String(e?.message || e))).finally(() => setSubmitting(false));
  };

  const setF = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const inputCls = 'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none';

  // DI-5.5 — tendência (delta da última pesquisa vs a anterior). Null na 1ª versão.
  const renderTrend = (delta: any) => {
    if (!delta || delta.isFirst) return null;
    const parts: React.ReactNode[] = [];
    if (delta.new?.length) parts.push(<span key="n" className="inline-flex items-center gap-0.5 text-emerald-300">✨ {delta.new.join(', ')}</span>);
    if (delta.grew?.length) parts.push(<span key="g" className="inline-flex items-center gap-0.5 text-emerald-300"><TrendingUp className="h-3 w-3" /> {delta.grew.join(', ')}</span>);
    if (delta.shrank?.length) parts.push(<span key="s" className="inline-flex items-center gap-0.5 text-amber-300"><TrendingDown className="h-3 w-3" /> {delta.shrank.join(', ')}</span>);
    if (delta.gone?.length) parts.push(<span key="x" className="text-zinc-500 line-through">{delta.gone.join(', ')}</span>);
    if (!parts.length) return null;
    return <div className="mt-1 flex flex-wrap gap-2 text-[11px]">{parts}</div>;
  };

  return (
    <div className="flex-1 overflow-y-auto mx-auto max-w-5xl space-y-6 p-4">
      <header className="flex items-center gap-3">
        <Brain className="h-6 w-6 text-indigo-400" />
        <div>
          <h1 className="text-lg font-semibold text-white">Inteligência de Nicho</h1>
          <p className="text-xs text-zinc-400">Pesquisa de mercado por vertical, compartilhada e anonimizada entre as contas do nicho. Você cola a pesquisa 1× e todas reaproveitam.</p>
        </div>
      </header>

      {/* Lembrete semanal + nichos a atualizar (DI-4.5) */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-zinc-200">Lembrete semanal por nicho</div>
          <button onClick={toggleReminder} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${reminderOn ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>
            {reminderOn ? <BellRing className="h-4 w-4" /> : <BellOff className="h-4 w-4" />} {reminderOn ? 'Ligado' : 'Desligado'}
          </button>
        </div>
        {due.length > 0 ? (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="mb-1 flex items-center gap-2 text-[13px] font-medium text-amber-200"><AlertTriangle className="h-4 w-4" /> {due.length} nicho(s) precisam de atualização</div>
            <div className="flex flex-wrap gap-1.5">
              {due.map((d) => (
                <span key={d.id} className={`rounded px-2 py-0.5 text-[11px] ${d.expired ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-200'}`}>{verticalLabel(d.vertical)} · {d.topic}{d.expired ? ' (vencida)' : ''}</span>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-[12px] text-zinc-500">Toda semana eu aviso aqui (e no seu inbox de sinais) os nichos com pesquisa vencendo, para você re-colar. Não rodo pesquisa sozinho — o conteúdo é sempre seu.</p>
        )}
      </section>

      {/* Automação de pesquisa (DI-5.4/5.5) */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Zap className="h-4 w-4 text-indigo-400" /> Automação de pesquisa</div>
          <button onClick={toggleAutomation} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ${automation.enabled ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>
            <Power className="h-4 w-4" /> {automation.enabled ? 'Ligada' : 'Desligada'}
          </button>
        </div>
        <p className="mt-1 text-[12px] text-zinc-500">Os nichos abaixo são pesquisados sozinhos pela IA no intervalo definido — curados e publicados automaticamente, dentro do orçamento. Nicho automatizado não recebe o lembrete manual.</p>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
          <select className={inputCls} value={autoForm.vertical} onChange={(e) => setAF('vertical', e.target.value)}>
            {VERTICALS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
          </select>
          <input className={inputCls} placeholder="tópico *" value={autoForm.topic} onChange={(e) => setAF('topic', e.target.value)} />
          <input className={inputCls} placeholder="região (opc.)" value={autoForm.region} onChange={(e) => setAF('region', e.target.value)} />
          <input className={inputCls} placeholder="período (opc.)" value={autoForm.timeframe} onChange={(e) => setAF('timeframe', e.target.value)} />
          <div className="flex gap-2">
            <input className={`${inputCls} w-20`} inputMode="numeric" title="intervalo em dias" value={autoForm.intervalDays} onChange={(e) => setAF('intervalDays', e.target.value)} />
            <button onClick={addNiche} disabled={autoSubmitting} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50" title="Adicionar nicho à automação">
              {autoSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {automation.items.length > 0 ? (
          <div className="mt-3 space-y-1.5">
            {automation.items.map((n: any) => (
              <div key={n.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
                <span className="rounded bg-indigo-500/15 px-2 py-0.5 text-[11px] font-medium text-indigo-300">{verticalLabel(n.vertical)}</span>
                <span className="font-medium text-white">{n.topic}</span>
                {n.region && <span className="text-xs text-zinc-500">· {n.region}</span>}
                {n.timeframe && <span className="text-xs text-zinc-500">· {n.timeframe}</span>}
                <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500"><Clock className="h-3 w-3" /> a cada {n.interval_days}d</span>
                {n.last_run_at && <span className="text-[11px] text-zinc-600">última: {new Date(n.last_run_at).toLocaleDateString('pt-BR')}</span>}
                <div className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => toggleNiche(n.fingerprint, !n.enabled)} className={`rounded px-2 py-0.5 text-[11px] ${n.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-400'}`}>{n.enabled ? 'ativo' : 'pausado'}</button>
                  <button onClick={() => removeNiche(n.fingerprint)} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-300" title="Remover"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] text-zinc-500">Nenhum nicho automatizado ainda. Adicione um acima para o ZapFlow pesquisar sozinho.</p>
        )}
      </section>

      {/* Orçamento de pesquisa (plataforma) */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200"><DollarSign className="h-4 w-4 text-emerald-400" /> Orçamento de pesquisa (mês)</div>
        {budget ? (
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><div className="text-[11px] uppercase text-zinc-500">Teto</div><div className="font-semibold text-white tabular-nums">{budget.unlimited ? 'Ilimitado' : brl(budget.budgetCents)}</div></div>
              <div><div className="text-[11px] uppercase text-zinc-500">Gasto</div><div className="font-semibold text-white tabular-nums">{brl(budget.spentCents)}</div></div>
              <div><div className="text-[11px] uppercase text-zinc-500">Situação</div><div className={`font-semibold ${budget.exhausted ? 'text-red-400' : 'text-emerald-400'}`}>{budget.unlimited ? '—' : budget.exhausted ? 'Esgotado' : `${budget.pct}% usado`}</div></div>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label className="mb-1 block text-[11px] uppercase text-zinc-500">Novo teto (R$/mês · 0 = ilimitado)</label>
                <input className={`${inputCls} w-44`} inputMode="decimal" placeholder="ex.: 500,00" value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} />
              </div>
              <button onClick={saveBudget} disabled={savingBudget || budgetInput === ''} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
                {savingBudget ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar
              </button>
            </div>
          </div>
        ) : <div className="text-sm text-zinc-500">Carregando…</div>}
        <p className="mt-2 text-[11px] text-zinc-500">O provider manual (colar) tem custo zero e não consome o orçamento — o teto protege só chamadas a um provider pago, se um dia for ligado.</p>
      </section>

      {/* Colar pesquisa */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200"><Plus className="h-4 w-4 text-indigo-400" /> Colar pesquisa do nicho</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-[11px] uppercase text-zinc-500">Vertical</label>
            <select className={inputCls} value={form.vertical} onChange={(e) => setF('vertical', e.target.value)}>
              {VERTICALS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase text-zinc-500">Tópico *</label>
            <input className={inputCls} placeholder="ex.: demanda de inverno" value={form.topic} onChange={(e) => setF('topic', e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase text-zinc-500">Região</label>
            <input className={inputCls} placeholder="ex.: Brasil / Sul" value={form.region} onChange={(e) => setF('region', e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] uppercase text-zinc-500">Período</label>
            <input className={inputCls} placeholder="ex.: 2026 / Q3" value={form.timeframe} onChange={(e) => setF('timeframe', e.target.value)} />
          </div>
        </div>
        <div className="mt-3">
          <label className="mb-1 block text-[11px] uppercase text-zinc-500">Texto da pesquisa *</label>
          <textarea className={`${inputCls} min-h-[120px]`} placeholder="Cole aqui o panorama de mercado do nicho (sem dados de clientes/pessoas — PII é removida automaticamente)." value={form.summary} onChange={(e) => setF('summary', e.target.value)} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <label className="mb-1 block text-[11px] uppercase text-zinc-500">Drivers (vírgula)</label>
            <input className={inputCls} placeholder="frio antecipado, retomada" value={form.drivers} onChange={(e) => setF('drivers', e.target.value)} />
          </div>
          <div className="sm:col-span-1">
            <label className="mb-1 block text-[11px] uppercase text-zinc-500">Fontes (vírgula)</label>
            <input className={inputCls} placeholder="Relatório setorial 2026" value={form.sources} onChange={(e) => setF('sources', e.target.value)} />
          </div>
          <div className="sm:col-span-1">
            <label className="mb-1 block text-[11px] uppercase text-zinc-500">Validade (dias)</label>
            <input className={inputCls} inputMode="numeric" value={form.ttlDays} onChange={(e) => setF('ttlDays', e.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={submit} disabled={submitting} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Publicar para o nicho
          </button>
        </div>
      </section>

      {/* Pesquisas publicadas */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Layers className="h-4 w-4 text-indigo-400" /> Pesquisas publicadas</div>
          <div className="flex items-center gap-2">
            <select className={`${inputCls} w-40`} value={filterVertical} onChange={(e) => setFilterVertical(e.target.value)}>
              <option value="">Todos os nichos</option>
              {VERTICALS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
            </select>
            <button onClick={loadItems} className="rounded-lg border border-zinc-700 p-2 text-zinc-300 hover:bg-zinc-800" title="Recarregar"><RefreshCcw className="h-4 w-4" /></button>
          </div>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
        ) : items.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">Nenhuma pesquisa publicada ainda.</div>
        ) : (
          <div className="space-y-2">
            {itemsPage.visible.map((it) => (
              <div key={it.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded bg-indigo-500/15 px-2 py-0.5 text-[11px] font-medium text-indigo-300">{verticalLabel(it.vertical)}</span>
                  <span className="font-medium text-white">{it.topic}</span>
                  {it.region && <span className="text-xs text-zinc-500">· {it.region}</span>}
                  {it.timeframe && <span className="text-xs text-zinc-500">· {it.timeframe}</span>}
                  {it.automated && <span className="inline-flex items-center gap-1 rounded bg-indigo-500/15 px-2 py-0.5 text-[11px] font-medium text-indigo-300" title="Pesquisado automaticamente"><Zap className="h-3 w-3" /> auto</span>}
                  <span className={`ml-auto rounded px-2 py-0.5 text-[11px] font-medium ${it.fresh ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-700/40 text-zinc-400'}`}>{it.fresh ? 'Fresca' : 'Expirada'}</span>
                </div>
                {it.content?.summary && <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{it.content.summary}</p>}
                {renderTrend(it.delta)}
                <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-zinc-500">
                  <span>provider: {it.provider}</span>
                  {it.confidence != null && <span>confiança: {Math.round(Number(it.confidence) * 100)}%</span>}
                  {it.valid_until && <span>válida até: {new Date(it.valid_until).toLocaleDateString('pt-BR')}</span>}
                </div>
              </div>
            ))}
            <ShowMore page={itemsPage} noun="pesquisas" />
          </div>
        )}
      </section>
    </div>
  );
}

export default NicheIntelligenceView;
