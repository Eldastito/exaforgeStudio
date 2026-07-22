import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, FileDown, Loader2, TrendingDown, Plus } from 'lucide-react';
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

      <LossMarginSection />
    </div>
  );
}

// ── Margem de perda aceitável (ADR-114) — indicador global de perdas ─────────
const DRIVER_LABEL: Record<string, string> = {
  merma: 'Merma', quebra: 'Quebra', vencimento: 'Vencimento', furto: 'Furto', desconto: 'Desconto',
  calote: 'Calote', divergencia: 'Divergência', retrabalho: 'Retrabalho', no_show: 'No-show', outro: 'Outro',
};
const LOSS_STATUS: Record<string, { label: string; cls: string }> = {
  dentro: { label: 'Dentro da meta', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  acima: { label: 'Acima da meta', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  sem_meta: { label: 'Sem meta definida', cls: 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30' },
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
