import React, { useEffect, useState } from 'react';
import { CalendarCheck, Plus, X, Check, Ban, BedDouble, RefreshCw } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useStore } from '@/src/store/useStore';
import { EmptyState } from '@/src/components/EmptyState';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

const INP = 'w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500';

type Resource = { id: string; name: string; price: number; capacity: number; reservation_unit: string };
type Reservation = {
  id: string; resource_name: string; reservation_unit: string; contact_name: string | null;
  start_at: string; end_at: string; units: number; status: string; total_amount: number;
  guests?: number | null; adults?: number | null; children?: number | null;
  pets?: number | null; special_requests?: string | null; budget?: number | null;
};

const UNIT_LABEL: Record<string, string> = { night: 'diária', day: 'dia', hour: 'hora', slot: 'turno' };
const STATUS_LABEL: Record<string, string> = {
  pending: 'pendente', confirmed: 'confirmada', cancelled: 'cancelada', completed: 'concluída', no_show: 'não compareceu',
};
const brl = (v: number) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

export function ReservasView() {
  const { contacts } = useStore();
  const [resources, setResources] = useState<Resource[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRes, setShowRes] = useState(false);
  const [showResource, setShowResource] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([
      apiFetch('/api/reservations/resources').then(r => r.json()).catch(() => []),
      apiFetch('/api/reservations').then(r => r.json()).catch(() => []),
    ]).then(([rs, rv]) => {
      setResources(Array.isArray(rs) ? rs : []);
      setReservations(Array.isArray(rv) ? rv : []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const setStatus = async (id: string, status: string) => {
    try {
      await apiFetch(`/api/reservations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      load();
    } catch { toast.error('Falha ao atualizar.'); }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 relative">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <CalendarCheck className="w-6 h-6 text-emerald-400" /> Reservas
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Reserve quartos, mesas, equipamentos ou espaços por período, com controle de disponibilidade.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-zinc-700 text-zinc-200" onClick={() => setShowResource(true)}>
            <BedDouble className="w-4 h-4 mr-2" /> Recurso reservável
          </Button>
          <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" disabled={resources.length === 0} onClick={() => setShowRes(true)}>
            <Plus className="w-4 h-4 mr-2" /> Nova reserva
          </Button>
        </div>
      </div>

      {/* Recursos reserváveis */}
      <div className="mb-6">
        <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Recursos reserváveis</p>
        {resources.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhum recurso ainda. Crie um (ex.: "Quarto Standard", capacidade 5, por diária).</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {resources.map(r => (
              <div key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-sm font-semibold text-zinc-100">{r.name}</p>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {brl(r.price)} / {UNIT_LABEL[r.reservation_unit] || r.reservation_unit} · capacidade {r.capacity}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Lista de reservas */}
      <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Reservas</p>
      {loading ? (
        <div className="flex items-center text-zinc-500 py-10"><RefreshCw className="w-4 h-4 animate-spin mr-2" /> Carregando…</div>
      ) : reservations.length === 0 ? (
        <EmptyState icon={<CalendarCheck className="w-6 h-6" />} title="Nenhuma reserva ainda"
          description="Crie um recurso reservável e registre a primeira reserva. A disponibilidade é checada automaticamente." />
      ) : (
        <div className="space-y-3">
          {reservations.map(r => (
            <div key={r.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 flex justify-between items-center">
              <div>
                <h3 className="font-semibold text-zinc-100">{r.resource_name || 'Recurso'} {r.units > 1 && <span className="text-zinc-400 text-sm">× {r.units}</span>}</h3>
                <p className="text-sm text-zinc-400">{r.contact_name || 'Sem contato'} · {brl(r.total_amount)}</p>
                <p className="text-xs text-zinc-500 font-mono mt-1">
                  {format(new Date(r.start_at), 'Pp', { locale: ptBR })} → {format(new Date(r.end_at), 'Pp', { locale: ptBR })}
                </p>
                {/* Hotelaria: detalhes estruturados da hospedagem. */}
                {(() => {
                  const parts: string[] = [];
                  if (r.adults != null || r.children != null) parts.push(`👤 ${r.adults ?? 0} adulto(s)${(r.children ?? 0) > 0 ? ` · 🧒 ${r.children} criança(s)` : ''}`);
                  else if (r.guests != null) parts.push(`👤 ${r.guests} hóspede(s)`);
                  if (r.pets) parts.push('🐾 pet');
                  if (r.budget != null) parts.push(`💰 orçamento ${brl(r.budget)}`);
                  return parts.length ? <p className="text-xs text-zinc-400 mt-1">{parts.join(' · ')}</p> : null;
                })()}
                {r.special_requests && <p className="text-xs text-indigo-300/80 mt-1">📝 {r.special_requests}</p>}
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className={`text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded ${
                  r.status === 'confirmed' ? 'bg-emerald-500/15 text-emerald-400'
                  : r.status === 'cancelled' ? 'bg-rose-500/15 text-rose-400'
                  : r.status === 'completed' ? 'bg-zinc-700 text-zinc-300'
                  : 'bg-amber-500/15 text-amber-400'}`}>{STATUS_LABEL[r.status] || r.status}</span>
                {r.status !== 'cancelled' && r.status !== 'completed' && (
                  <div className="flex items-center gap-2">
                    {r.status !== 'confirmed' && (
                      <button onClick={() => setStatus(r.id, 'confirmed')} title="Confirmar" className="text-zinc-400 hover:text-emerald-400"><Check className="w-4 h-4" /></button>
                    )}
                    <button onClick={() => setStatus(r.id, 'cancelled')} title="Cancelar" className="text-zinc-400 hover:text-rose-400"><Ban className="w-4 h-4" /></button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showResource && <ResourceModal onClose={() => setShowResource(false)} onSaved={() => { setShowResource(false); load(); }} />}
      {showRes && <ReservationModal resources={resources} contacts={Object.values(contacts)} onClose={() => setShowRes(false)} onSaved={() => { setShowRes(false); load(); }} />}
    </div>
  );
}

// ---- Modal: criar recurso reservável (products_services type reservation) ----
function ResourceModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', price: '', capacity: '1', reservation_unit: 'night' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/api/reservations/resources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(), price: Number(form.price) || 0,
          capacity: Number(form.capacity) || 1, reservation_unit: form.reservation_unit,
        }),
      });
      toast.success('Recurso criado!');
      onSaved();
    } catch { toast.error('Falha ao criar o recurso.'); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="Novo recurso reservável" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Nome (ex.: Quarto Standard, Mesa 4 lugares)">
          <input className={INP} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Preço por unidade de tempo">
            <input type="number" min="0" step="0.01" className={INP} value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label="Unidade de tempo">
            <select className={INP} value={form.reservation_unit} onChange={e => setForm({ ...form, reservation_unit: e.target.value })}>
              <option value="night">Diária (por noite)</option>
              <option value="day">Por dia</option>
              <option value="hour">Por hora</option>
              <option value="slot">Por turno</option>
            </select>
          </Field>
        </div>
        <Field label="Capacidade (unidades simultâneas: nº de quartos/mesas iguais)">
          <input type="number" min="1" className={INP} value={form.capacity} onChange={e => setForm({ ...form, capacity: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={saving || !form.name.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white">{saving ? 'Salvando…' : 'Criar'}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Modal: criar reserva com checagem de disponibilidade ----
function ReservationModal({ resources, contacts, onClose, onSaved }: {
  resources: Resource[]; contacts: any[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ resourceId: resources[0]?.id || '', contactId: '', start: '', end: '', units: '1' });
  const [avail, setAvail] = useState<{ bookable: boolean; livres: number; capacity: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAvail(null);
    if (!form.resourceId || !form.start || !form.end) return;
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const qs = new URLSearchParams({ resource: form.resourceId, start: new Date(form.start).toISOString(), end: new Date(form.end).toISOString(), units: String(form.units || 1) });
        const d = await apiFetch(`/api/reservations/availability?${qs}`).then(r => r.json());
        setAvail(d?.ok ? d : null);
      } catch { setAvail(null); }
      finally { setChecking(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [form.resourceId, form.start, form.end, form.units]);

  const save = async () => {
    if (!form.resourceId || !form.start || !form.end) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceId: form.resourceId, contactId: form.contactId || undefined,
          startAt: new Date(form.start).toISOString(), endAt: new Date(form.end).toISOString(),
          units: Number(form.units) || 1,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao reservar.'); return; }
      toast.success('Reserva criada!');
      onSaved();
    } catch { toast.error('Falha ao reservar.'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Nova reserva" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Recurso">
          <select className={INP} value={form.resourceId} onChange={e => setForm({ ...form, resourceId: e.target.value })}>
            {resources.map(r => <option key={r.id} value={r.id}>{r.name} (cap. {r.capacity})</option>)}
          </select>
        </Field>
        <Field label="Cliente (opcional)">
          <select className={INP} value={form.contactId} onChange={e => setForm({ ...form, contactId: e.target.value })}>
            <option value="">Sem contato</option>
            {contacts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Início (check-in)"><input type="datetime-local" className={INP} value={form.start} onChange={e => setForm({ ...form, start: e.target.value })} /></Field>
          <Field label="Fim (check-out)"><input type="datetime-local" className={INP} value={form.end} onChange={e => setForm({ ...form, end: e.target.value })} /></Field>
        </div>
        <Field label="Unidades (quantos quartos/mesas)"><input type="number" min="1" className={INP} value={form.units} onChange={e => setForm({ ...form, units: e.target.value })} /></Field>

        {checking ? (
          <p className="text-xs text-zinc-500 flex items-center gap-1"><RefreshCw className="w-3 h-3 animate-spin" /> Checando disponibilidade…</p>
        ) : avail ? (
          <p className={`text-xs font-medium ${avail.bookable ? 'text-emerald-400' : 'text-rose-400'}`}>
            {avail.bookable ? `✓ Disponível — ${avail.livres} de ${avail.capacity} livre(s) no período.` : `✗ Sem disponibilidade (${avail.livres} de ${avail.capacity} livre(s)).`}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={saving || !form.start || !form.end || (avail !== null && !avail.bookable)} className="bg-emerald-600 hover:bg-emerald-700 text-white">{saving ? 'Salvando…' : 'Reservar'}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ---- helpers de UI ----
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[440px] max-h-[90vh] overflow-auto">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">{title}</h3>
          <button className="text-zinc-400 hover:text-white" onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm text-zinc-400 mb-1 block">{label}</label>
      {children}
    </div>
  );
}
