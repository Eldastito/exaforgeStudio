import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw, FileDown, Loader2 } from 'lucide-react';
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
    </div>
  );
}
