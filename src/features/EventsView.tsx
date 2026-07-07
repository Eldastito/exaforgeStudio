import React, { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { CalendarRange, Users, MapPin, ChevronRight } from 'lucide-react';

type Inquiry = {
  id: string; status: 'novo' | 'qualificado' | 'proposta' | 'fechado' | 'perdido';
  event_type: string; headcount: number | null; event_date: string | null;
  halls: string | null; budget: number | null; special_requests: string | null;
  won_amount: number | null; loss_reason: string | null;
  contact_name: string | null; contact_identifier: string | null;
  created_at: string; updated_at: string;
};

const STAGES: { key: Inquiry['status']; label: string; cls: string }[] = [
  { key: 'novo', label: '🆕 Novo', cls: 'border-zinc-700' },
  { key: 'qualificado', label: '✅ Qualificado', cls: 'border-amber-500/40' },
  { key: 'proposta', label: '📄 Proposta', cls: 'border-blue-500/40' },
  { key: 'fechado', label: '🏆 Fechado', cls: 'border-emerald-500/40' },
  { key: 'perdido', label: '❌ Perdido', cls: 'border-rose-500/40' },
];

const TYPE_LABEL: Record<string, string> = {
  casamento: '💍 Casamento', convencao: '🏢 Convenção', day_use: '☀️ Day use',
  corporativo: '👔 Corporativo', aniversario: '🎉 Aniversário', outro: '🎪 Outro',
};

const brl = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

export function EventsView() {
  const [items, setItems] = useState<Inquiry[]>([]);
  const load = () => apiFetch('/api/events').then(r => r.json()).then(d => setItems(Array.isArray(d) ? d : [])).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const moveTo = async (id: string, status: Inquiry['status']) => {
    await apiFetch(`/api/events/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    load();
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <p className="zf-kicker mb-1">Pipeline Consultivo</p>
      <h2 className="zf-page-title flex items-center gap-2 mb-1">
        <CalendarRange className="h-6 w-6" style={{ color: 'var(--color-flow)' }} /> Eventos & Grupos
      </h2>
      <p className="text-sm text-zinc-400 mb-6">Pipeline de consultas consultivas: convenções, casamentos, day use, eventos corporativos. A IA detecta o pedido na conversa e cria a consulta aqui.</p>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        {STAGES.map(stage => {
          const cards = items.filter(i => i.status === stage.key);
          return (
            <div key={stage.key} className={`rounded-xl border ${stage.cls} bg-zinc-900/30 p-3 min-h-[200px]`}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-zinc-200">{stage.label}</p>
                <span className="text-[10px] font-mono text-zinc-500">{cards.length}</span>
              </div>
              <div className="space-y-2">
                {cards.length === 0 ? (
                  <p className="text-[11px] text-zinc-600 italic">vazio</p>
                ) : cards.map(c => (
                  <div key={c.id} className="rounded-lg bg-zinc-950/70 border border-zinc-800 p-3">
                    <p className="text-xs text-zinc-100">{TYPE_LABEL[c.event_type] || c.event_type}</p>
                    <p className="text-[11px] text-zinc-400 mt-0.5">{c.contact_name || c.contact_identifier || 'Sem contato'}</p>
                    <div className="mt-2 space-y-0.5 text-[11px] text-zinc-400">
                      {c.headcount != null && <p><Users className="inline w-3 h-3 mr-1" />{c.headcount} pessoas</p>}
                      {c.event_date && <p>📅 {c.event_date}</p>}
                      {c.halls && <p><MapPin className="inline w-3 h-3 mr-1" />{c.halls}</p>}
                      {c.budget != null && <p>💰 {brl(c.budget)}</p>}
                    </div>
                    {c.special_requests && <p className="text-[10px] text-indigo-300/70 mt-1">📝 {c.special_requests}</p>}
                    {c.status !== 'fechado' && c.status !== 'perdido' && (
                      <div className="mt-3 flex gap-1">
                        {STAGES.filter(s => s.key !== c.status && s.key !== 'novo').map(s => (
                          <button key={s.key} onClick={() => moveTo(c.id, s.key)}
                            className="text-[10px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800">
                            <ChevronRight className="inline w-2.5 h-2.5" />{s.label.replace(/[^a-zA-ZÀ-ÿ\s]/g, '').trim()}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
