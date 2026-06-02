import React, { useEffect, useState } from 'react';
import { toast } from '@/src/lib/toast';
import { Users, Phone, Search, Flame, ThermometerSun, Snowflake, ShoppingBag, RefreshCw, Target, Download } from 'lucide-react';
import { Avatar } from '@/src/components/ui/Avatar';
import { apiFetch } from '@/src/lib/api';
import { EmptyState } from '@/src/components/EmptyState';

type Contact = {
  id: string; name?: string; identifier: string; profile_pic_url?: string;
  lead_temperature?: string; lead_score?: number; purchase_count?: number; total_spent?: number;
  avg_ticket?: number; last_purchase_at?: string; last_contact_at?: string; tags?: string;
};

const scoreBand = (s?: number): { label: string; cls: string; bar: string } => {
  const v = s || 0;
  if (v >= 70) return { label: 'Alto', cls: 'text-emerald-400', bar: 'bg-emerald-500' };
  if (v >= 40) return { label: 'Médio', cls: 'text-amber-400', bar: 'bg-amber-500' };
  return { label: 'Baixo', cls: 'text-zinc-400', bar: 'bg-zinc-600' };
};

const TEMP: Record<string, { label: string; cls: string; Icon: any }> = {
  quente: { label: 'Quente', cls: 'bg-rose-500/10 text-rose-400 border-rose-500/30', Icon: Flame },
  morno: { label: 'Morno', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30', Icon: ThermometerSun },
  frio: { label: 'Frio', cls: 'bg-sky-500/10 text-sky-400 border-sky-500/30', Icon: Snowflake },
};

const FILTERS = [
  { id: 'todos', label: 'Todos' },
  { id: 'score', label: '🎯 Score alto' },
  { id: 'quente', label: '🔥 Quentes' },
  { id: 'morno', label: 'Mornos' },
  { id: 'frio', label: 'Frios' },
  { id: 'inativos', label: 'Inativos +60d' },
];

export function ContactsView() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [segments, setSegments] = useState<any>(null);
  const [filter, setFilter] = useState('todos');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    let url = '/api/contacts';
    if (filter === 'quente' || filter === 'morno' || filter === 'frio') url += `?temperature=${filter}`;
    else if (filter === 'inativos') url += `?inactiveDays=60`;
    else if (filter === 'score') url += `?minScore=70`;
    Promise.all([
      apiFetch(url).then(r => r.json()).catch(() => []),
      apiFetch('/api/contacts/segments').then(r => r.json()).catch(() => null),
    ]).then(([cs, seg]) => {
      setContacts(Array.isArray(cs) ? cs : []);
      setSegments(seg);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  // Reaproveita o mesmo recorte do filtro atual para o CSV.
  const filterQuery = () => {
    if (filter === 'quente' || filter === 'morno' || filter === 'frio') return `?temperature=${filter}`;
    if (filter === 'inativos') return `?inactiveDays=60`;
    if (filter === 'score') return `?minScore=70`;
    return '';
  };

  const exportCsv = async () => {
    try {
      const res = await apiFetch(`/api/contacts/export.csv${filterQuery()}`);
      if (!res.ok) { toast.error('Não foi possível exportar.'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'contatos.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error('Não foi possível exportar.'); }
  };

  const recompute = async () => {
    await apiFetch('/api/contacts/recompute', { method: 'POST' }).catch(() => {});
    load();
  };

  const filtered = contacts.filter(c =>
    !q || (c.name || '').toLowerCase().includes(q.toLowerCase()) || (c.identifier || '').includes(q));

  const brl = (v?: number) => `R$ ${Number(v || 0).toFixed(2)}`;
  const daysAgo = (d?: string) => d ? `${Math.floor((Date.now() - new Date(d).getTime()) / 86400000)}d` : '—';

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <Users className="w-6 h-6 text-blue-400" /> Contatos &amp; CRM
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Base de clientes com temperatura do lead e histórico de compra</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} className="inline-flex items-center gap-2 text-sm text-zinc-300 border border-zinc-800 rounded-lg px-3 py-2 hover:border-indigo-500/40" title="Exportar contatos (CSV)">
            <Download className="w-4 h-4 text-indigo-400" /> CSV
          </button>
          <button onClick={recompute} className="inline-flex items-center gap-2 text-sm text-zinc-300 border border-zinc-800 rounded-lg px-3 py-2 hover:border-indigo-500/40" title="Recalcular métricas de CRM">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Recalcular
          </button>
        </div>
      </div>

      {/* Segmentos */}
      {segments && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Seg label="🎯 Score alto (≥70)" value={segments.byScore?.alto || 0} accent="text-emerald-400" />
          <Seg label="Score médio (40-69)" value={segments.byScore?.medio || 0} accent="text-amber-400" />
          <Seg label="🔥 Quentes" value={segments.byTemperature?.quente || 0} />
          <Seg label="Inativos +60d" value={segments.inactive60Days || 0} accent="text-rose-400" />
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${filter === f.id ? 'bg-indigo-600 text-white border-indigo-600' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'}`}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="mb-6 relative">
        <Search className="w-5 h-5 absolute left-3 top-2.5 text-zinc-500" />
        <input type="text" placeholder="Buscar por nome ou telefone..." value={q} onChange={e => setQ(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 transition-colors" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.length === 0 ? (
          loading ? (
            <div className="col-span-full py-12 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/30">
              Carregando...
            </div>
          ) : (q || filter !== 'todos') ? (
            <div className="col-span-full py-12 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/30">
              Nenhum contato neste filtro/busca.
            </div>
          ) : (
            <EmptyState
              icon={<Users className="w-6 h-6" />}
              title="Nenhum contato ainda"
              description="Assim que alguém mandar mensagem nos seus canais, o contato entra aqui automaticamente — com temperatura do lead, lead score e histórico de compra."
            />
          )
        ) : filtered.map(c => {
          const t = TEMP[c.lead_temperature || 'frio'] || TEMP.frio;
          return (
            <div key={c.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900 transition-colors">
              <div className="flex items-start gap-3">
                <Avatar name={c.name} src={c.profile_pic_url} size={44} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-semibold text-zinc-100 truncate">{c.name || 'Sem nome'}</h3>
                    <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border ${t.cls}`}>
                      <t.Icon className="w-3 h-3" /> {t.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5 text-xs text-zinc-500">
                    <Phone className="w-3 h-3" /> {c.identifier}
                  </div>
                </div>
              </div>
              {/* Lead Score */}
              {(() => {
                const sb = scoreBand(c.lead_score);
                return (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="flex items-center gap-1 text-zinc-500"><Target className="w-3 h-3" /> Lead Score</span>
                      <span className={`font-semibold ${sb.cls}`}>{c.lead_score || 0}/100 · {sb.label}</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                      <div className={`h-full rounded-full ${sb.bar}`} style={{ width: `${Math.min(100, c.lead_score || 0)}%` }} />
                    </div>
                  </div>
                );
              })()}
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Stat label="Compras" value={String(c.purchase_count || 0)} icon={<ShoppingBag className="w-3 h-3" />} />
                <Stat label="Total" value={brl(c.total_spent)} />
                <Stat label="Últ. contato" value={daysAgo(c.last_contact_at)} />
              </div>
              {c.tags && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.tags.split(',').filter(Boolean).map((tag, i) => (
                    <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{tag.trim()}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Seg({ label, value, accent = 'text-zinc-100' }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-xl font-bold mt-1 ${accent}`}>{value}</p>
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 py-1.5">
      <p className="text-sm font-semibold text-zinc-200 flex items-center justify-center gap-1">{icon}{value}</p>
      <p className="text-[10px] text-zinc-500">{label}</p>
    </div>
  );
}
