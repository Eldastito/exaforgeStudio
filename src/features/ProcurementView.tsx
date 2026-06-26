import React, { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { PackageCheck, Check, X as XIcon, AlertTriangle } from 'lucide-react';

type ReqItem = {
  id: string;
  product_service_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  current_stock: number;
  threshold: number;
  suggested_qty: number;
  avg_daily_consumption: number | null;
  days_of_cover: number | null;
  unit_price: number | null;
};

type Settings = { enabled: boolean; targetDays: number };

const brl = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

export function ProcurementView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [requisition, setRequisition] = useState<any>(null);
  const [items, setItems] = useState<ReqItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSettings = () => apiFetch('/api/procurement/settings').then(r => r.json()).then(setSettings).catch(() => {});
  const loadRequisition = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/procurement/requisition');
      const data = await r.json();
      setRequisition(data.requisition || null);
      setItems(Array.isArray(data.items) ? data.items : []);
    } finally { setLoading(false); }
  };

  useEffect(() => { loadSettings(); loadRequisition(); const t = setInterval(loadRequisition, 60_000); return () => clearInterval(t); }, []);

  const saveSettings = async (patch: Partial<Settings>) => {
    const next = { enabled: settings?.enabled || false, targetDays: settings?.targetDays || 14, ...patch };
    setSettings(next);
    await apiFetch('/api/procurement/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
    loadRequisition();
  };

  const approve = async () => {
    if (!requisition?.id) return;
    await apiFetch(`/api/procurement/requisition/${requisition.id}/approve`, { method: 'POST' });
    loadRequisition();
  };
  const dismiss = async () => {
    if (!requisition?.id) return;
    await apiFetch(`/api/procurement/requisition/${requisition.id}/dismiss`, { method: 'POST' });
    loadRequisition();
  };

  const totalEstimado = items.reduce((acc, it) => acc + ((it.unit_price || 0) * (it.suggested_qty || 0)), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <PackageCheck className="h-6 w-6 text-indigo-400" /> Compras / Reposição
        </h2>
      </div>
      <p className="text-sm text-zinc-400 mb-6">
        A IA observa o estoque e propõe uma <b>lista de reposição</b> quando os
        produtos passam do mínimo crítico. Você revisa e aprova com um clique.
      </p>

      {/* Configuração */}
      {settings && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">⚙️ Reposição inteligente</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Cobre os próximos{' '}
                <input type="number" min="1" value={settings.targetDays}
                  onChange={e => setSettings({ ...settings, targetDays: parseInt(e.target.value, 10) || 14 })}
                  onBlur={e => saveSettings({ targetDays: parseInt(e.target.value, 10) || 14 })}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1 text-center text-zinc-200" /> dias com base no consumo médio (saídas dos últimos 30 dias).
              </p>
            </div>
            <button onClick={() => saveSettings({ enabled: !settings.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Requisição aberta */}
      {loading ? (
        <p className="text-sm text-zinc-500">Carregando...</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-emerald-700/30 bg-emerald-500/5 p-6 text-center">
          <p className="text-emerald-300 font-medium">✅ Tudo em ordem por aqui</p>
          <p className="text-xs text-zinc-500 mt-1">Nenhum produto abaixo do mínimo crítico no momento.</p>
          <p className="text-xs text-zinc-500 mt-3">Defina o mínimo crítico em <i>Catálogo</i> para que a IA monitore o item.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between p-4 border-b border-zinc-800">
            <div>
              <p className="text-sm font-medium text-zinc-100 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                {items.length} item(ns) abaixo do mínimo crítico
              </p>
              <p className="text-xs text-zinc-500 mt-1">Estimativa total: <b className="text-zinc-200">{brl(totalEstimado)}</b> (com base no preço de venda — não no custo).</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="h-8 bg-zinc-900 border-zinc-700 hover:bg-zinc-800" onClick={dismiss}>
                <XIcon className="w-3 h-3 mr-2" /> Descartar
              </Button>
              <Button size="sm" className="h-8 bg-emerald-600 hover:bg-emerald-700" onClick={approve}>
                <Check className="w-3 h-3 mr-2" /> Aprovar lista
              </Button>
            </div>
          </div>

          <div className="divide-y divide-zinc-800">
            {items.map(it => (
              <div key={it.id} className="p-4 grid grid-cols-12 gap-3 items-center">
                <div className="col-span-5">
                  <p className="text-sm text-zinc-100">
                    {it.product_name}{it.variant_name ? <span className="text-zinc-400"> ({it.variant_name})</span> : null}
                  </p>
                  <p className="text-xs text-zinc-500">
                    consumo médio: {it.avg_daily_consumption ? `${it.avg_daily_consumption}/dia` : 'sem histórico'}
                  </p>
                </div>
                <div className="col-span-2 text-xs">
                  <p className="text-zinc-400">Em estoque</p>
                  <p className="font-mono text-rose-300 font-semibold">{it.current_stock}</p>
                </div>
                <div className="col-span-2 text-xs">
                  <p className="text-zinc-400">Mínimo</p>
                  <p className="font-mono text-zinc-300">{it.threshold}</p>
                </div>
                <div className="col-span-1 text-xs">
                  <p className="text-zinc-400">Cobertura</p>
                  <p className="font-mono text-amber-300">
                    {it.days_of_cover != null ? `${it.days_of_cover} d` : '—'}
                  </p>
                </div>
                <div className="col-span-2 text-right">
                  <p className="text-xs text-zinc-400">Sugerido comprar</p>
                  <p className="text-lg font-bold text-emerald-300">{it.suggested_qty}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="p-3 text-[11px] text-zinc-500 border-t border-zinc-800">
            Sugestão = maior valor entre <i>repor até o mínimo</i> e <i>cobrir os próximos {settings?.targetDays ?? 14} dias</i> de consumo médio.
            Após aprovar, a próxima fase cota com fornecedores (em breve).
          </div>
        </div>
      )}
    </div>
  );
}
