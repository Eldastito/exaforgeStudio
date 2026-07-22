import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, FileDown, Loader2, TrendingDown, Plus, Sparkles, ArrowUpRight, ArrowDownRight, Minus, Receipt, UserCog, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

const brl = (v: number) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
const int = (v: number) => String(Math.round(Number(v || 0)));
const fmtCard = (c: any) => c.format === 'brl' ? brl(c.value) : c.format === 'int' ? int(c.value) : String(c.value);

interface Report {
  vertical: string;
  coreCards: any[];
  verticalCards: any[];
  topProducts: { name: string; qty: number; total: number }[];
  options: { categories: string[]; sellers: { id: string; name: string }[]; channels: string[] };
}

const PERIODS = [
  { v: '7', label: '7 dias' }, { v: '30', label: '30 dias' }, { v: '90', label: '90 dias' },
  { v: 'month', label: 'Mês corrente' }, { v: 'prev_month', label: 'Mês anterior' },
];
const CHANNEL_LABEL: Record<string, string> = { loja: 'Loja virtual', whatsapp: 'WhatsApp/IA', pdv: 'PDV/manual' };

export function ReportsPanel() {
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState('30');
  const [category, setCategory] = useState('');
  const [channel, setChannel] = useState('');
  const [seller, setSeller] = useState('');

  const query = useCallback(() => {
    const p = new URLSearchParams({ period });
    if (category) p.set('category', category);
    if (channel) p.set('channel', channel);
    if (seller) p.set('seller', seller);
    return p.toString();
  }, [period, category, channel, seller]);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch(`/api/analytics/sales-report?${query()}`)
      .then(r => r.json())
      .then((d) => setData(d && d.coreCards ? d : null))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(() => { load(); }, [load]);

  const exportPdf = async () => {
    setExporting(true);
    try {
      const r = await apiFetch(`/api/analytics/sales-report/pdf?${query()}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.url) { window.open(d.url, '_blank'); toast.success('PDF gerado.'); }
      else toast.error(d.error || 'Não foi possível gerar o PDF.');
    } catch { toast.error('Falha ao gerar o PDF.'); }
    finally { setExporting(false); }
  };

  const allCards = data ? [...data.coreCards, ...data.verticalCards] : [];
  const selectCls = 'rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none';

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="flex justify-between items-center mb-4 flex-wrap gap-3">
        <div>
          <p className="zf-kicker mb-1">Relatório de Vendas</p>
          <h2 className="zf-page-title flex items-center gap-2">
            <BarChart3 className="w-6 h-6" style={{ color: 'var(--color-flow)' }} />
            Relatórios de vendas
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Indicadores por período, com cards do seu segmento. Exporte em PDF com a marca da loja.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
          </button>
          <button onClick={exportPdf} disabled={exporting || !data}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 px-3 py-2 text-sm text-white disabled:opacity-50">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />} Exportar PDF
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 mb-6">
        <select value={period} onChange={e => setPeriod(e.target.value)} className={selectCls}>
          {PERIODS.map(p => <option key={p.v} value={p.v}>{p.label}</option>)}
        </select>
        {data && data.options.categories.length > 0 && (
          <select value={category} onChange={e => setCategory(e.target.value)} className={selectCls}>
            <option value="">Todas as categorias</option>
            {data.options.categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <select value={channel} onChange={e => setChannel(e.target.value)} className={selectCls}>
          <option value="">Todos os canais</option>
          {(data?.options.channels || ['loja', 'whatsapp', 'pdv']).map(c => <option key={c} value={c}>{CHANNEL_LABEL[c] || c}</option>)}
        </select>
        {data && data.options.sellers.length > 0 && (
          <select value={seller} onChange={e => setSeller(e.target.value)} className={selectCls}>
            <option value="">Todos os vendedores</option>
            {data.options.sellers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20 text-zinc-500">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Carregando…
        </div>
      ) : !data ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center text-zinc-400">
          Não foi possível carregar os relatórios agora. Tente atualizar.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {allCards.map((c, i) => (
              <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4" title={c.hint || ''}>
                <div className="text-zinc-400 text-sm">{c.label}</div>
                <p className="mt-2 text-2xl font-bold text-emerald-400 truncate">{fmtCard(c)}</p>
                {c.hint && <p className="mt-1 text-[11px] text-zinc-500">{c.hint}</p>}
              </div>
            ))}
          </div>

          {data.topProducts.length > 0 && (
            <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <p className="text-sm font-medium text-zinc-100 mb-3">Itens mais vendidos</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-zinc-500">
                      <th className="pb-2">Item</th><th className="pb-2 text-right">Qtd</th><th className="pb-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topProducts.map((p, i) => (
                      <tr key={i} className="border-t border-zinc-800/60">
                        <td className="py-2 text-zinc-200">{p.name}</td>
                        <td className="py-2 text-right text-zinc-300">{int(p.qty)}</td>
                        <td className="py-2 text-right text-zinc-300">{brl(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <DreSection />
      <OwnerSection />
      <LossMarginSection />
    </div>
  );
}

// ── Empresa × Proprietário (ADR-129) — separar o dinheiro do dono ────────────
const DRAW_LABEL: Record<string, string> = {
  pro_labore: 'Pró-labore', distribuicao: 'Distribuição de lucro', despesa_pessoal: 'Despesa pessoal',
  emprestimo_socio: 'Empréstimo ao sócio', despesa_empresarial: 'Despesa da empresa (aporte)',
};
const ALERTA_CLS: Record<string, string> = {
  ok: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/5',
  atencao: 'text-amber-300 border-amber-500/30 bg-amber-500/5',
  excesso: 'text-red-300 border-red-500/30 bg-red-500/5',
};
function OwnerSection() {
  const [d, setD] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiFetch('/api/owner').then((r) => r.json()).then((x: any) => { if (x?.byKind) setD(x); }).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  const registrar = async () => {
    const kinds = Object.keys(DRAW_LABEL);
    const kind = window.prompt(`Tipo da retirada:\n${kinds.map((k, i) => `${i + 1}) ${DRAW_LABEL[k]}`).join('\n')}\n\nDigite o número (1-5):`);
    if (kind == null) return;
    const idx = Number(kind) - 1;
    if (!(idx >= 0 && idx < kinds.length)) return;
    const v = window.prompt('Valor (R$):'); if (v == null) return;
    const amount = Number(v.replace(',', '.')); if (!(amount > 0)) return;
    setBusy(true);
    try {
      const r = await apiFetch('/api/owner/draws', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: kinds[idx], amount }) });
      if (r.ok) { toast.success('Retirada registrada.'); load(); } else toast.error('Não consegui registrar.');
    } catch { toast.error('Falha ao registrar.'); } finally { setBusy(false); }
  };

  if (!d) return null;
  const al = ALERTA_CLS[d.alerta?.nivel] || ALERTA_CLS.ok;
  return (
    <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <h3 className="text-zinc-100 font-semibold flex items-center gap-2"><UserCog className="w-5 h-5 text-violet-300" /> Empresa × Proprietário <span className="text-xs font-normal text-zinc-500">· {d.period}</span></h3>
        <button disabled={busy} onClick={registrar} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm px-3 py-1.5 disabled:opacity-50"><Plus className="w-4 h-4" /> Registrar retirada</button>
      </div>

      <div className={`rounded-lg border p-3 text-[13px] mb-3 flex items-start gap-2 ${al}`}>
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          {d.alerta?.msg}
          {d.pctDoResultado != null && <span className="block text-[11px] opacity-80 mt-0.5">Retiradas do mês: {brl(d.retiradas)} · {d.pctDoResultado}% do resultado operacional.</span>}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Retiradas por tipo</div>
          {Object.keys(DRAW_LABEL).map((k) => (
            <div key={k} className="flex items-center justify-between py-0.5 text-[13px]">
              <span className={k === 'despesa_empresarial' ? 'text-emerald-300/80' : 'text-zinc-300'}>{DRAW_LABEL[k]}</span>
              <span className="text-zinc-200 tabular-nums">{brl(d.byKind[k])}</span>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-violet-500/25 bg-violet-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-violet-300/80 mb-1">Pró-labore sustentável</div>
          <div className="text-xl font-semibold text-violet-200">{brl(d.proLaboreSugerido)}<span className="text-[11px] text-zinc-500">/mês</span></div>
          <ul className="mt-1.5 space-y-0.5">{d.premissas?.map((p: string, i: number) => <li key={i} className="text-[11px] text-zinc-500">• {p}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}

// ── DRE Gerencial Simplificada (ADR-128) — venda × lucro × caixa ─────────────
function DreSection() {
  const [d, setD] = useState<any | null>(null);
  useEffect(() => { apiFetch('/api/dre').then((r) => r.json()).then((x: any) => { if (x?.linhas) setD(x); }).catch(() => {}); }, []);
  if (!d) return null;
  const l = d.linhas;
  const cmp = d.comparacao || {};
  const Delta = ({ k }: { k: string }) => {
    const c = cmp[k]; if (!c || !c.anterior) return null;
    const up = c.delta >= 0;
    return <span className={`ml-2 text-[10px] ${up ? 'text-emerald-400/80' : 'text-red-400/80'}`}>{up ? '▲' : '▼'} {brl(Math.abs(c.delta))} vs mês ant.</span>;
  };
  const Row = ({ label, value, op, strong, muted, deltaKey }: { label: string; value: number | null; op?: string; strong?: boolean; muted?: boolean; deltaKey?: string }) => (
    <div className={`flex items-center justify-between py-1.5 ${strong ? 'border-t border-zinc-800 mt-1 pt-2' : ''}`}>
      <span className={`text-[13px] ${strong ? 'font-semibold text-zinc-100' : muted ? 'text-zinc-500' : 'text-zinc-300'}`}>{op && <span className="text-zinc-600 mr-1">{op}</span>}{label}{deltaKey && <Delta k={deltaKey} />}</span>
      <span className={`text-[13px] tabular-nums ${strong ? 'font-semibold text-zinc-100' : muted ? 'text-zinc-500' : 'text-zinc-200'}`}>{value == null ? '—' : brl(value)}</span>
    </div>
  );
  return (
    <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
        <h3 className="text-zinc-100 font-semibold flex items-center gap-2"><Receipt className="w-5 h-5 text-sky-300" /> DRE gerencial <span className="text-xs font-normal text-zinc-500">· {d.period}</span></h3>
        {l.margemPct != null && <span className="text-xs rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-300 px-2.5 py-1">margem bruta {l.margemPct}%</span>}
      </div>
      <div className="max-w-md">
        <Row label="Receita bruta" value={l.receitaBruta} deltaKey="receitaBruta" />
        <Row label="Descontos" value={l.descontos} op="(-)" muted />
        {l.devolucoes > 0 && <Row label="Devoluções" value={l.devolucoes} op="(-)" muted />}
        <Row label="Receita líquida" value={l.receitaLiquida} strong deltaKey="receitaLiquida" />
        <Row label="Custo dos produtos/serviços (CMV)" value={l.cmv} op="(-)" muted />
        <Row label="Margem bruta" value={l.margemBruta} strong deltaKey="margemBruta" />
        <Row label="Despesas" value={l.despesas} op="(-)" muted deltaKey="despesas" />
        <div className="flex items-center justify-between py-0.5 pl-4 text-[11px] text-zinc-600">
          <span>fixas {brl(l.despesasFixas)} · variáveis {brl(l.despesasVariaveis)}</span>
        </div>
        <Row label="Resultado operacional" value={l.resultadoOperacional} strong deltaKey="resultadoOperacional" />
        <Row label="Retiradas dos sócios" value={l.retiradas} op="(-)" muted />
        <Row label={l.sobra >= 0 ? 'Sobra (reinveste)' : 'Consumo (tira do caixa)'} value={l.sobra} strong deltaKey="sobra" />
      </div>
      {(d.breakdown?.comigo?.revenue > 0 || d.breakdown?.core?.revenue > 0) && (
        <p className="mt-2 text-[11px] text-zinc-500">Receita: loja/serviço {brl(d.breakdown.core.revenue)} · Balcão (Comigo) {brl(d.breakdown.comigo.revenue)}.</p>
      )}
      <p className="mt-1 text-[11px] text-zinc-500">{d.notas?.despesas}</p>
      <p className="mt-2 text-[11px] text-amber-200/70 border-t border-zinc-800 pt-2">{d.disclaimer}</p>
    </div>
  );
}

// ── Margem de perda aceitável (ADR-114) — indicador global de perdas ─────────
const DRIVER_LABEL: Record<string, string> = {
  merma: 'Merma', quebra: 'Quebra', vencimento: 'Vencimento', furto: 'Furto', desconto: 'Desconto',
  devolucao: 'Devolução', calote: 'Calote', divergencia: 'Divergência', retrabalho: 'Retrabalho', no_show: 'No-show', outro: 'Outro',
};
const LOSS_STATUS: Record<string, { label: string; cls: string }> = {
  dentro: { label: 'Dentro da meta', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  acima: { label: 'Acima da meta', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  sem_meta: { label: 'Sem meta definida', cls: 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30' },
};
const TREND_UI: Record<string, { label: string; cls: string; Icon: any }> = {
  piorando: { label: 'piorando', cls: 'text-red-300', Icon: ArrowUpRight },
  melhorando: { label: 'melhorando', cls: 'text-emerald-300', Icon: ArrowDownRight },
  estavel: { label: 'estável', cls: 'text-zinc-300', Icon: Minus },
  sem_base: { label: 'sem base ainda', cls: 'text-zinc-500', Icon: Minus },
};

function LossMarginSection() {
  const [d, setD] = useState<any | null>(null);
  const [driver, setDriver] = useState('merma');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { apiFetch('/api/loss').then((r) => r.json()).then((r: any) => { if (r?.current) setD(r); }).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  const saveMeta = async () => {
    const v = window.prompt('Margem de perda aceitável por mês (% do faturamento):', String(d?.config?.acceptablePct ?? 0));
    if (v == null) return;
    await apiFetch('/api/loss/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acceptablePct: Number(v.replace(',', '.')) || 0 }) });
    load();
  };
  const lancar = async () => {
    const a = Number(amount.replace(',', '.'));
    if (!(a > 0)) return;
    setBusy(true);
    try { await apiFetch('/api/loss/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driver, amount: a }) }); setAmount(''); load(); toast.success('Perda lançada.'); }
    catch { toast.error('Não consegui lançar.'); } finally { setBusy(false); }
  };

  if (!d) return null;
  const c = d.current;
  const st = LOSS_STATUS[c.status] || LOSS_STATUS.sem_meta;
  const maxPct = Math.max(1, ...d.history.map((h: any) => h.lossPct));

  return (
    <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex justify-between items-center flex-wrap gap-2 mb-3">
        <h3 className="text-zinc-100 font-semibold flex items-center gap-2"><TrendingDown className="w-5 h-5 text-amber-300" /> Margem de perda</h3>
        <button onClick={saveMeta} className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-3 py-1.5">
          Meta: {d.config.acceptablePct}% — alterar
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Perda no mês</div>
          <div className="text-lg font-semibold text-zinc-100 mt-1">{c.lossPct}%</div>
          <div className="text-[11px] text-zinc-500">{brl(c.lossAmount)}</div>
        </div>
        <div className={`rounded-lg border p-3 ${st.cls}`}>
          <div className="text-[11px] uppercase tracking-wide opacity-80">Situação</div>
          <div className="text-sm font-semibold mt-1">{st.label}</div>
          {c.status !== 'sem_meta' && <div className="text-[11px] opacity-80">meta {c.acceptablePct}%</div>}
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Média (3 meses)</div>
          <div className="text-lg font-semibold text-zinc-100 mt-1">{d.trailingAverage}%</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Onde mais perde</div>
          <div className="text-sm font-medium text-zinc-100 mt-1">{c.topDriver ? DRIVER_LABEL[c.topDriver.driver] : '—'}</div>
          {c.topDriver && <div className="text-[11px] text-zinc-500">{brl(c.topDriver.amount)}</div>}
        </div>
      </div>

      {/* Histórico (loss_pct por mês) */}
      <div className="flex items-end gap-1.5 h-16 mt-4">
        {d.history.map((h: any) => (
          <div key={h.period} className="flex-1 flex flex-col items-center gap-1" title={`${h.period}: ${h.lossPct}%`}>
            <div className="w-full bg-amber-500/70 rounded-t" style={{ height: `${Math.round((h.lossPct / maxPct) * 100)}%`, minHeight: h.lossPct > 0 ? 2 : 0 }} />
            <span className="text-[9px] text-zinc-600">{h.period.slice(5)}</span>
          </div>
        ))}
      </div>

      {/* Diagnóstico da IA (ADR-114 Fatia 3) — atribui onde perde e sugere reduzir */}
      {d.diagnosis && (
        <div className="mt-4 rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-4">
          <div className="flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-indigo-300 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm text-zinc-100">{d.diagnosis.headline}</div>
              {d.diagnosis.trend !== 'sem_base' && (() => { const t = TREND_UI[d.diagnosis.trend] || TREND_UI.estavel; const TI = t.Icon; return (
                <div className={`mt-1 inline-flex items-center gap-1 text-[11px] ${t.cls}`}><TI className="w-3.5 h-3.5" /> tendência {t.label} · média {d.diagnosis.trailingAverage}%</div>
              ); })()}
            </div>
          </div>
          {d.diagnosis.findings?.length > 0 && (
            <ul className="mt-3 space-y-2">
              {d.diagnosis.findings.map((f: any) => (
                <li key={f.driver} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-zinc-100">{DRIVER_LABEL[f.driver] || f.driver}</span>
                    <span className="text-[11px] text-zinc-400">{brl(f.amount)} · {f.share}%</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden"><div className="h-full bg-indigo-500/70 rounded-full" style={{ width: `${Math.min(100, f.share)}%` }} /></div>
                  <p className="mt-1.5 text-[12px] text-zinc-400">{f.suggestion}</p>
                </li>
              ))}
            </ul>
          )}
          {d.diagnosis.actions?.length > 0 && (
            <div className="mt-3 border-t border-indigo-500/15 pt-2.5">
              <div className="text-[11px] uppercase tracking-wide text-indigo-300/80">Próximos passos</div>
              <ul className="mt-1 space-y-1">
                {d.diagnosis.actions.map((a: string, i: number) => (
                  <li key={i} className="flex items-start gap-1.5 text-[12px] text-zinc-300"><span className="text-indigo-400 mt-px">→</span><span>{a}</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Lançar perda */}
      <div className="flex flex-wrap items-end gap-2 mt-4 border-t border-zinc-800 pt-4">
        <div>
          <div className="text-[11px] text-zinc-500 mb-1">Tipo de perda</div>
          <select value={driver} onChange={(e) => setDriver(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
            {(d.drivers as string[]).map((k) => <option key={k} value={k}>{DRIVER_LABEL[k] || k}</option>)}
          </select>
        </div>
        <div>
          <div className="text-[11px] text-zinc-500 mb-1">Valor (R$)</div>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0,00"
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 w-28" />
        </div>
        <button disabled={busy} onClick={lancar} className="inline-flex items-center gap-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm px-3 py-2 disabled:opacity-40">
          <Plus className="w-4 h-4" /> Lançar
        </button>
        <p className="text-[11px] text-zinc-500 basis-full">Registre suas perdas por tipo — a IA usa isso pra aprender onde você perde e, no futuro, sugerir como reduzir.</p>
      </div>
    </div>
  );
}
