import React, { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { FileText, Check, X as XIcon, Clock } from 'lucide-react';

type Quote = {
  id: string; status: 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired';
  total_amount: number; sent_at: string; accepted_at: string | null; declined_at: string | null;
  valid_until: string | null; followup_count: number;
  contact_name: string | null; contact_identifier: string | null;
  items_snapshot: string;
};

type Settings = { validityHours: number; followupHours: number; followupMax: number };

const brl = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  sent: { label: 'Enviado', cls: 'bg-amber-500/20 text-amber-300' },
  viewed: { label: 'Visto', cls: 'bg-blue-500/20 text-blue-300' },
  accepted: { label: 'Aceito', cls: 'bg-emerald-500/20 text-emerald-300' },
  declined: { label: 'Recusado', cls: 'bg-rose-500/20 text-rose-300' },
  expired: { label: 'Expirado', cls: 'bg-zinc-700 text-zinc-300' },
};

export function QuotesView() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [filter, setFilter] = useState<string>('');

  const load = () => apiFetch('/api/quotes').then(r => r.json()).then(d => setQuotes(Array.isArray(d) ? d : [])).catch(() => {});
  const loadSettings = () => apiFetch('/api/quotes/settings').then(r => r.json()).then(setSettings).catch(() => {});
  useEffect(() => { load(); loadSettings(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const saveSettings = async (patch: Partial<Settings>) => {
    const next = { ...(settings || { validityHours: 72, followupHours: 24, followupMax: 2 }), ...patch };
    setSettings(next);
    await apiFetch('/api/quotes/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
  };

  const accept = async (id: string) => { await apiFetch(`/api/quotes/${id}/accept`, { method: 'POST' }); load(); };
  const decline = async (id: string) => { await apiFetch(`/api/quotes/${id}/decline`, { method: 'POST' }); load(); };

  const visible = filter ? quotes.filter(q => q.status === filter) : quotes;
  const counts = {
    sent: quotes.filter(q => q.status === 'sent' || q.status === 'viewed').length,
    accepted: quotes.filter(q => q.status === 'accepted').length,
    declined: quotes.filter(q => q.status === 'declined').length,
    expired: quotes.filter(q => q.status === 'expired').length,
  };
  const acceptRate = quotes.length ? Math.round((counts.accepted / quotes.length) * 100) : 0;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2 mb-1">
        <FileText className="h-6 w-6 text-indigo-400" /> Orçamentos
      </h2>
      <p className="text-sm text-zinc-400 mb-6">A IA monta o orçamento na conversa e ele aparece aqui rastreado. Follow-up automático até X tentativas; expira na validade.</p>

      {/* Configuração */}
      {settings && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 text-xs text-zinc-400">
          ⚙️ Validade do orçamento:{' '}
          <input type="number" min={1} value={settings.validityHours}
            onChange={e => setSettings({ ...settings, validityHours: parseInt(e.target.value, 10) || 72 })}
            onBlur={e => saveSettings({ validityHours: parseInt(e.target.value, 10) || 72 })}
            className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-center text-zinc-200" /> h.
          Follow-up a cada{' '}
          <input type="number" min={1} value={settings.followupHours}
            onChange={e => setSettings({ ...settings, followupHours: parseInt(e.target.value, 10) || 24 })}
            onBlur={e => saveSettings({ followupHours: parseInt(e.target.value, 10) || 24 })}
            className="w-16 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-center text-zinc-200" /> h, até{' '}
          <input type="number" min={0} max={5} value={settings.followupMax}
            onChange={e => setSettings({ ...settings, followupMax: parseInt(e.target.value, 10) || 2 })}
            onBlur={e => saveSettings({ followupMax: parseInt(e.target.value, 10) || 2 })}
            className="w-12 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-center text-zinc-200" /> tentativa(s).
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <KPI label="Em aberto" value={counts.sent} cls="text-amber-300" />
        <KPI label="Aceitos" value={counts.accepted} cls="text-emerald-300" />
        <KPI label="Recusados" value={counts.declined} cls="text-rose-300" />
        <KPI label="Expirados" value={counts.expired} cls="text-zinc-400" />
        <KPI label="Taxa de aceite" value={`${acceptRate}%`} cls="text-indigo-300" />
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 mb-4">
        {['', 'sent', 'accepted', 'declined', 'expired'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1 text-xs rounded-full border ${filter === f ? 'border-indigo-500 text-indigo-300 bg-indigo-500/10' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}>
            {f === '' ? 'Todos' : STATUS_LABEL[f]?.label || f}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-zinc-500">Nenhum orçamento {filter ? `com status ${STATUS_LABEL[filter]?.label}` : 'ainda'}.</p>
      ) : (
        <div className="space-y-2">
          {visible.map(q => {
            let items: any[] = [];
            try { items = JSON.parse(q.items_snapshot || '[]'); } catch {}
            const st = STATUS_LABEL[q.status];
            const isOpen = q.status === 'sent' || q.status === 'viewed';
            return (
              <div key={q.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <p className="text-sm text-zinc-100">
                      {q.contact_name || q.contact_identifier || 'Sem contato'} <span className="text-zinc-500">· {brl(q.total_amount)}</span>
                    </p>
                    <p className="text-[11px] text-zinc-500 mt-0.5">
                      Enviado {new Date(q.sent_at).toLocaleString('pt-BR')}
                      {q.valid_until && q.status === 'sent' && <> · <Clock className="inline w-3 h-3" /> vale até {new Date(q.valid_until).toLocaleString('pt-BR')}</>}
                      {q.followup_count > 0 && <> · {q.followup_count} follow-up(s) enviado(s)</>}
                    </p>
                    {items.length > 0 && (
                      <p className="text-xs text-zinc-400 mt-2">
                        {items.map((i, ix) => <span key={ix}>{i.qty}× {i.name}{ix < items.length - 1 ? ' · ' : ''}</span>)}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {st && <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${st.cls}`}>{st.label}</span>}
                    {isOpen && (
                      <div className="flex gap-1">
                        <button onClick={() => accept(q.id)} title="Marcar como aceito" className="text-zinc-400 hover:text-emerald-400"><Check className="w-4 h-4" /></button>
                        <button onClick={() => decline(q.id)} title="Marcar como recusado" className="text-zinc-400 hover:text-rose-400"><XIcon className="w-4 h-4" /></button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KPI({ label, value, cls }: { label: string; value: any; cls: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`text-2xl font-bold ${cls}`}>{value}</p>
    </div>
  );
}
