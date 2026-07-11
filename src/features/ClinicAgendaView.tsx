import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Stethoscope, Plus, X, Clock, User, DoorOpen, ShieldCheck, Timer, LogIn, Play, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Loader2, MoreHorizontal } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

// ---- Tipos ----
type Professional = { id: string; name: string; specialty?: string | null; color?: string | null; user_id?: string | null; active?: boolean | number };
type Room = { id: string; name: string };
type ContactLite = { id: string; name: string; identifier?: string };
type OverrunState = 'idle' | 'on_time' | 'near_end' | 'over_time' | 'done';
type ContinuationStatus = 'pending' | 'continue' | 'finish' | 'reschedule' | null;
type Appointment = {
  id: string;
  contact_id: string;
  contact_name?: string;
  contact_identifier?: string;
  title?: string;
  scheduled_start: string;
  scheduled_end?: string;
  status: 'confirmed' | 'arrived' | 'in_care' | 'completed' | 'cancelled' | 'no_show';
  professional_id?: string | null;
  professional_name?: string | null;
  professional_color?: string | null;
  room_name_snapshot?: string | null;
  insurance_name?: string | null;
  current_plan_name?: string | null;
  duration_minutes?: number | null;
  effective_end?: string | null;
  overrun_state?: OverrunState;
  warning_minutes?: number | null;
  checkin_at?: string | null;
  care_started_at?: string | null;
  checkout_at?: string | null;
  continuation_status?: ContinuationStatus;
};
type Conflict = { id: string; title?: string; reason?: string; start?: string };

// ---- Helpers ----
const todayISO = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ISO -> HH:mm em horário local.
const fmtTime = (iso?: string | null) => {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Data ISO (YYYY-MM-DD) + hora local padrão -> valor para datetime-local.
const defaultDateTimeLocal = (dateISO: string) => {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dateISO}T${p(now.getHours())}:00`;
};

const STATUS_BADGE: Record<Appointment['status'], { label: string; cls: string }> = {
  confirmed: { label: 'Confirmado', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  arrived: { label: 'Chegou', cls: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30' },
  in_care: { label: 'Em atendimento', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  completed: { label: 'Finalizado', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  cancelled: { label: 'Cancelado', cls: 'text-zinc-500 bg-zinc-500/10 border-zinc-700' },
  no_show: { label: 'Não compareceu', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
};

const OVERRUN_BADGE: Record<OverrunState, { label: string; cls: string; dot: string }> = {
  idle: { label: 'Aguardando', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700', dot: 'bg-zinc-500' },
  on_time: { label: 'No horário', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400' },
  near_end: { label: 'Próximo do fim', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30', dot: 'bg-amber-400' },
  over_time: { label: 'Excedeu o tempo', cls: 'text-red-300 bg-red-500/10 border-red-500/30', dot: 'bg-red-400' },
  done: { label: 'Finalizado', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700', dot: 'bg-zinc-500' },
};

const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'Todos os status' },
  { id: 'confirmed', label: 'Confirmado' },
  { id: 'arrived', label: 'Chegou' },
  { id: 'in_care', label: 'Em atendimento' },
  { id: 'completed', label: 'Finalizado' },
  { id: 'cancelled', label: 'Cancelado' },
  { id: 'no_show', label: 'Não compareceu' },
];

// Recalcula o estado de permanência no cliente a partir de effective_end + warning_minutes (ADR-080 D3).
function computeOverrun(a: Appointment, now: number): OverrunState {
  if (a.status === 'completed' || a.overrun_state === 'done' || a.checkout_at) return 'done';
  if (!a.care_started_at || !a.effective_end) return a.overrun_state || 'idle';
  const end = new Date(a.effective_end).getTime();
  if (isNaN(end)) return a.overrun_state || 'on_time';
  const warnMs = Math.max(0, (a.warning_minutes || 0)) * 60000;
  if (now >= end) return 'over_time';
  if (now >= end - warnMs) return 'near_end';
  return 'on_time';
}

export function ClinicAgendaView() {
  const [date, setDate] = useState<string>(todayISO());
  const [filterProfessional, setFilterProfessional] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [tick, setTick] = useState(Date.now()); // força re-render p/ recalcular a permanência
  const [busyId, setBusyId] = useState<string>(''); // id+ação em execução
  const [extendFor, setExtendFor] = useState<string>(''); // id do card com o menu "Estender" aberto

  const loadAppointments = useCallback(() => {
    const params = new URLSearchParams({ date });
    if (filterProfessional) params.set('professionalId', filterProfessional);
    if (filterStatus) params.set('status', filterStatus);
    return apiFetch(`/api/clinic/agenda?${params.toString()}`)
      .then(r => r.json())
      .then(d => setAppointments(Array.isArray(d?.appointments) ? d.appointments : []))
      .catch(() => setAppointments([]));
  }, [date, filterProfessional, filterStatus]);

  const loadProfessionals = useCallback(() => apiFetch('/api/clinic/professionals').then(r => r.json()).then(d => setProfessionals(Array.isArray(d) ? d : [])).catch(() => {}), []);
  const loadRooms = useCallback(() => apiFetch('/api/clinic/rooms').then(r => r.json()).then(d => setRooms(Array.isArray(d) ? d : [])).catch(() => {}), []);
  const loadContacts = useCallback(() => apiFetch('/api/contacts').then(r => r.json()).then(d => setContacts(Array.isArray(d) ? d : [])).catch(() => {}), []);

  useEffect(() => { loadProfessionals(); loadRooms(); loadContacts(); }, [loadProfessionals, loadRooms, loadContacts]);
  useEffect(() => { setLoading(true); loadAppointments().finally(() => setLoading(false)); }, [loadAppointments]);

  // Alerta de permanência client-side: a cada 30s força recomputar as cores sem recarregar (ADR-080 D3).
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Ordena por horário. O estado de permanência é recomputado no cliente (usa `tick`).
  const rows = useMemo<Appointment[]>(() => {
    return [...appointments].sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime());
  }, [appointments]);

  const overCount = rows.filter(r => computeOverrun(r, tick) === 'over_time').length;

  // Executa uma ação de card (checkin/start-care/complete/continuation) com toast + reload.
  const action = async (key: string, path: string, okMsg: string, body?: any) => {
    setBusyId(key);
    try {
      const r = await apiFetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível concluir a ação.');
      toast.success(okMsg);
      await loadAppointments();
    } catch (e: any) {
      toast.error(e.message || 'Falha na ação.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 relative">
      <div className="flex justify-between items-start mb-5 gap-3 flex-wrap">
        <div>
          <p className="zf-kicker mb-1">Clínica</p>
          <h2 className="zf-page-title flex items-center gap-2">
            <Stethoscope className="w-6 h-6 text-emerald-400" /> Agenda Clínica
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Fluxo do dia: chegada, atendimento e controle de permanência por paciente.</p>
        </div>
        <Button className="zf-button zf-button-primary" onClick={() => setShowNew(true)}>
          <Plus className="w-4 h-4 mr-2" /> Novo agendamento
        </Button>
      </div>

      {/* Filtros */}
      <div className="mb-5 flex items-end gap-3 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Data</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value || todayISO())}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </label>
        <label className="flex flex-col gap-1 min-w-[180px]">
          <span className="text-[11px] text-zinc-400">Profissional</span>
          <select value={filterProfessional} onChange={e => setFilterProfessional(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">Todos</option>
            {professionals.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 min-w-[160px]">
          <span className="text-[11px] text-zinc-400">Status</span>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            {STATUS_FILTERS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <span className="text-[11px] text-zinc-600 ml-auto self-center">{rows.length} agendamento(s)</span>
      </div>

      {/* Alerta de permanência */}
      {overCount > 0 && (
        <div className="mb-5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span className="text-sm text-red-200">
            {overCount === 1 ? '1 paciente excedeu o tempo previsto.' : `${overCount} pacientes excederam o tempo previsto.`}
          </span>
        </div>
      )}

      {/* Lista de agendamentos */}
      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10"><Loader2 className="w-4 h-4 animate-spin" /> Carregando agenda…</div>
      ) : rows.length === 0 ? (
        <div className="py-14 text-center rounded-xl border border-zinc-800 bg-zinc-900/40">
          <Stethoscope className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Nenhum agendamento para esta data</p>
          <p className="text-[12px] text-zinc-600 mt-1">Ajuste os filtros ou crie um novo agendamento.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(a => (
            <div key={a.id}>
            <AppointmentCard
              a={a}
              overrun={computeOverrun(a, tick)}
              busyId={busyId}
              extendOpen={extendFor === a.id}
              onToggleExtend={() => setExtendFor(cur => (cur === a.id ? '' : a.id))}
              onCheckin={() => action(`${a.id}:checkin`, `/api/clinic/appointments/${a.id}/checkin`, 'Check-in registrado.')}
              onStartCare={() => action(`${a.id}:start`, `/api/clinic/appointments/${a.id}/start-care`, 'Atendimento iniciado.')}
              onComplete={() => action(`${a.id}:complete`, `/api/clinic/appointments/${a.id}/complete`, 'Atendimento finalizado.')}
              onContinuation={(status) => action(`${a.id}:cont`, `/api/clinic/appointments/${a.id}/continuation`, status === 'continue' ? 'Marcado para continuar.' : status === 'finish' ? 'Marcado para finalizar.' : 'Marcado para remarcar.', { status })}
              onExtended={() => { setExtendFor(''); loadAppointments(); }}
            />
            </div>
          ))}
        </div>
      )}

      {/* Painel colapsável — Profissionais e salas */}
      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50">
        <button onClick={() => setShowManage(s => !s)} className="w-full flex items-center justify-between px-5 py-3 text-left">
          <span className="text-sm font-medium text-zinc-100 flex items-center gap-2"><User className="w-4 h-4 text-emerald-400" /> Profissionais e salas</span>
          {showManage ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
        </button>
        {showManage && (
          <div className="px-5 pb-5 grid grid-cols-1 lg:grid-cols-2 gap-5 border-t border-zinc-800 pt-4">
            <ProfessionalsPanel professionals={professionals} onChanged={loadProfessionals} />
            <RoomsPanel rooms={rooms} onChanged={loadRooms} />
          </div>
        )}
      </div>

      {showNew && (
        <NewAppointmentModal
          dateISO={date}
          contacts={contacts}
          professionals={professionals}
          rooms={rooms}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); loadAppointments(); }}
        />
      )}
    </div>
  );
}

// ---- Card de agendamento ----
function AppointmentCard({ a, overrun, busyId, extendOpen, onToggleExtend, onCheckin, onStartCare, onComplete, onContinuation, onExtended }: {
  a: Appointment;
  overrun: OverrunState;
  busyId: string;
  extendOpen: boolean;
  onToggleExtend: () => void;
  onCheckin: () => void;
  onStartCare: () => void;
  onComplete: () => void;
  onContinuation: (status: 'continue' | 'finish' | 'reschedule') => void;
  onExtended: () => void;
}) {
  const st = STATUS_BADGE[a.status] || STATUS_BADGE.confirmed;
  const ov = OVERRUN_BADGE[overrun] || OVERRUN_BADGE.idle;
  const color = a.professional_color || '#71717a';
  const plan = [a.insurance_name, a.current_plan_name].filter(Boolean).join(' · ');
  const inCare = a.status === 'in_care' || (!!a.care_started_at && !a.checkout_at && a.status !== 'completed' && a.status !== 'cancelled');
  const canCheckin = !a.checkin_at && a.status !== 'cancelled' && a.status !== 'completed' && a.status !== 'no_show';
  const canStart = !!a.checkin_at && !a.care_started_at && a.status !== 'cancelled' && a.status !== 'completed';
  const busy = (k: string) => busyId === `${a.id}:${k}`;

  const borderCls =
    overrun === 'over_time' ? 'border-red-500/50' :
    overrun === 'near_end' ? 'border-amber-500/40' :
    'border-zinc-800';

  return (
    <div className={`rounded-xl border ${borderCls} bg-zinc-900/50 p-4`} style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        {/* Info */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-zinc-200 inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-zinc-500" /> {fmtTime(a.scheduled_start)}</span>
            <h3 className="font-semibold text-zinc-100 truncate">{a.contact_name || 'Paciente'}</h3>
            {a.contact_identifier && <span className="text-[11px] text-zinc-500">{a.contact_identifier}</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full border border-zinc-600" style={{ backgroundColor: color }} />
              {a.professional_name || 'Sem profissional'}
            </span>
            {a.room_name_snapshot && <span className="inline-flex items-center gap-1"><DoorOpen className="w-3.5 h-3.5 text-zinc-500" /> {a.room_name_snapshot}</span>}
            {plan && <span className="inline-flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5 text-zinc-500" /> {plan}</span>}
            {a.duration_minutes ? <span className="inline-flex items-center gap-1"><Timer className="w-3.5 h-3.5 text-zinc-500" /> {a.duration_minutes} min</span> : null}
          </div>
          {a.title && <p className="mt-1 text-[12px] text-zinc-500">Procedimento: <span className="text-zinc-300">{a.title}</span></p>}
        </div>

        {/* Chips */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1 ${ov.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${ov.dot}`} /> {ov.label}
          </span>
        </div>
      </div>

      {/* Ações */}
      <div className="mt-3 flex flex-wrap items-center gap-2 relative">
        {canCheckin && (
          <button onClick={onCheckin} disabled={busy('checkin')} className="text-[11px] px-2 py-1 rounded-lg bg-cyan-600/90 hover:bg-cyan-600 text-white inline-flex items-center gap-1 disabled:opacity-60">
            {busy('checkin') ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogIn className="w-3 h-3" />} Check-in
          </button>
        )}
        {canStart && (
          <button onClick={onStartCare} disabled={busy('start')} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-60">
            {busy('start') ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Iniciar atendimento
          </button>
        )}

        {inCare && (
          <>
            <div className="relative">
              <button onClick={onToggleExtend} className="text-[11px] px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 inline-flex items-center gap-1">
                <MoreHorizontal className="w-3 h-3" /> Estender
              </button>
              {extendOpen && (
                <ExtendMenu appointmentId={a.id} onDone={onExtended} onCloseMenu={onToggleExtend} />
              )}
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1">
              <span className="text-[10px] text-zinc-500">Continuará?</span>
              <button onClick={() => onContinuation('continue')} disabled={busy('cont')} className="text-[11px] text-emerald-300 hover:text-emerald-200 disabled:opacity-60">Continuar</button>
              <span className="text-zinc-700">·</span>
              <button onClick={() => onContinuation('finish')} disabled={busy('cont')} className="text-[11px] text-zinc-300 hover:text-zinc-100 disabled:opacity-60">Finalizar</button>
              <span className="text-zinc-700">·</span>
              <button onClick={() => onContinuation('reschedule')} disabled={busy('cont')} className="text-[11px] text-amber-300 hover:text-amber-200 disabled:opacity-60">Remarcar</button>
            </div>

            <button onClick={onComplete} disabled={busy('complete')} className="text-[11px] px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 inline-flex items-center gap-1 disabled:opacity-60">
              {busy('complete') ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Finalizar
            </button>
          </>
        )}

        {a.continuation_status && a.continuation_status !== 'pending' && (
          <span className="text-[10px] text-zinc-500 ml-auto">
            {a.continuation_status === 'continue' ? 'Vai continuar' : a.continuation_status === 'finish' ? 'Vai finalizar' : 'Vai remarcar'}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- Menu de extensão (com tratamento de conflito 409) ----
function ExtendMenu({ appointmentId, onDone, onCloseMenu }: { appointmentId: string; onDone: () => void; onCloseMenu: () => void }) {
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [pendingMinutes, setPendingMinutes] = useState(0);

  const submit = async (addMinutes: number, force = false) => {
    if (!addMinutes || addMinutes <= 0) { toast.error('Informe quantos minutos adicionar.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/appointments/${appointmentId}/extend`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addMinutes, force }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) { setConflicts(Array.isArray(d?.conflicts) ? d.conflicts : []); setPendingMinutes(addMinutes); return; }
      if (!r.ok) throw new Error(d?.error || 'Não foi possível estender.');
      toast.success(`Atendimento estendido em ${addMinutes} min.`);
      onDone();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao estender.');
    } finally {
      setBusy(false);
    }
  };

  if (conflicts) {
    return (
      <div className="absolute right-0 top-full mt-1 z-30 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl p-3">
        <ConflictList conflicts={conflicts} />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={() => { setConflicts(null); onCloseMenu(); }} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancelar</button>
          <button onClick={() => submit(pendingMinutes, true)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-60">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Estender mesmo assim'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl p-2">
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        {[15, 30, 60].map(m => (
          <button key={m} onClick={() => submit(m)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-60">+{m}</button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input value={custom} onChange={e => setCustom(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="min"
          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
        <button onClick={() => submit(parseInt(custom, 10) || 0)} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white shrink-0 disabled:opacity-60">OK</button>
      </div>
    </div>
  );
}

function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <div>
      <p className="text-xs text-amber-300 font-medium flex items-center gap-1 mb-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Conflito de horário</p>
      {conflicts.length === 0 ? (
        <p className="text-[11px] text-zinc-400">Há sobreposição com outro agendamento.</p>
      ) : (
        <ul className="space-y-1">
          {conflicts.map(c => (
            <li key={c.id} className="text-[11px] text-zinc-300 rounded border border-zinc-800 bg-zinc-950 px-2 py-1">
              <span className="text-zinc-100">{c.title || 'Agendamento'}</span>
              {c.start && <span className="text-zinc-500"> · {fmtTime(c.start)}</span>}
              {c.reason && <span className="text-zinc-500 block">{c.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Modal: Novo agendamento ----
function NewAppointmentModal({ dateISO, contacts, professionals, rooms, onClose, onCreated }: {
  dateISO: string;
  contacts: ContactLite[];
  professionals: Professional[];
  rooms: Room[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [contactId, setContactId] = useState('');
  const [title, setTitle] = useState('');
  const [scheduledStart, setScheduledStart] = useState(defaultDateTimeLocal(dateISO));
  const [professionalId, setProfessionalId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);

  const submit = async (force = false) => {
    if (!contactId) { toast.error('Selecione o paciente.'); return; }
    if (!scheduledStart) { toast.error('Informe a data e hora.'); return; }
    setBusy(true);
    try {
      const payload: any = {
        contactId,
        title: title.trim() || undefined,
        scheduledStart: new Date(scheduledStart).toISOString(),
        professionalId: professionalId || undefined,
        roomId: roomId || undefined,
        durationMinutes: duration ? parseInt(duration, 10) : undefined,
        force,
      };
      const r = await apiFetch('/api/clinic/appointments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) { setConflicts(Array.isArray(d?.conflicts) ? d.conflicts : []); return; }
      if (!r.ok) throw new Error(d?.error || 'Não foi possível agendar.');
      toast.success('Agendamento criado.');
      onCreated();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao agendar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[440px] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><Plus className="w-5 h-5 text-emerald-400" /> Novo agendamento</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>

        {conflicts ? (
          <div className="space-y-3">
            <ConflictList conflicts={conflicts} />
            <p className="text-[11px] text-zinc-500">Deseja agendar mesmo assim, mantendo os dois no mesmo horário?</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConflicts(null)} disabled={busy}>Voltar</Button>
              <Button onClick={() => submit(true)} disabled={busy} className="bg-amber-600 hover:bg-amber-700 text-white">
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Agendar mesmo assim
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={e => { e.preventDefault(); submit(false); }} className="space-y-4">
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Paciente</label>
              <select required value={contactId} onChange={e => setContactId(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
                <option value="">Selecione um paciente</option>
                {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` — ${c.identifier}` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Procedimento <span className="text-zinc-600">(opcional)</span></label>
              <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex.: Sessão de hemodiálise"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Data e hora</label>
              <input required type="datetime-local" value={scheduledStart} onChange={e => setScheduledStart(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Profissional</label>
                <select value={professionalId} onChange={e => setProfessionalId(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
                  <option value="">—</option>
                  {professionals.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Sala</label>
                <select value={roomId} onChange={e => setRoomId(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
                  <option value="">—</option>
                  {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-sm text-zinc-400 mb-1 block">Duração prevista (min)</label>
              <input value={duration} onChange={e => setDuration(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="ex.: 240"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
              <Button type="submit" disabled={busy} className="zf-button zf-button-primary">
                {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Agendar
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ---- Painel: Profissionais ----
function ProfessionalsPanel({ professionals, onChanged }: { professionals: Professional[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [color, setColor] = useState('#34d399');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) { toast.error('Informe o nome do profissional.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/clinic/professionals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), specialty: specialty.trim() || undefined, color }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível cadastrar.');
      toast.success('Profissional cadastrado.');
      setName(''); setSpecialty('');
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao cadastrar.');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (p: Professional) => {
    try {
      const r = await apiFetch(`/api/clinic/professionals/${p.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !(p.active === true || p.active === 1) }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d?.error || 'Falha'); }
      onChanged();
    } catch (e: any) { toast.error(e.message || 'Não foi possível atualizar.'); }
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-zinc-100 mb-2">Profissionais</h4>
      <div className="space-y-1.5 mb-3">
        {professionals.length === 0 ? (
          <p className="text-[11px] text-zinc-600">Nenhum profissional cadastrado.</p>
        ) : professionals.map(p => {
          const active = p.active === true || p.active === 1;
          return (
            <div key={p.id} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full border border-zinc-600" style={{ backgroundColor: p.color || '#71717a' }} />
              <span className="text-sm text-zinc-200 truncate">{p.name}</span>
              {p.specialty && <span className="text-[11px] text-zinc-500 truncate">{p.specialty}</span>}
              <button onClick={() => toggleActive(p)} className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${active ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-zinc-500 border-zinc-700'}`}>
                {active ? 'Ativo' : 'Inativo'}
              </button>
            </div>
          );
        })}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
        <div className="flex items-center gap-2">
          <input value={specialty} onChange={e => setSpecialty(e.target.value)} placeholder="Especialidade (opcional)"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          <input type="color" value={color} onChange={e => setColor(e.target.value)} title="Cor" className="w-9 h-8 bg-transparent border border-zinc-800 rounded cursor-pointer shrink-0" />
        </div>
        <div className="flex justify-end">
          <Button onClick={create} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />} Adicionar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Painel: Salas ----
function RoomsPanel({ rooms, onChanged }: { rooms: Room[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) { toast.error('Informe o nome da sala.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/clinic/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível cadastrar.');
      toast.success('Sala cadastrada.');
      setName('');
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao cadastrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-zinc-100 mb-2">Salas</h4>
      <div className="space-y-1.5 mb-3">
        {rooms.length === 0 ? (
          <p className="text-[11px] text-zinc-600">Nenhuma sala cadastrada.</p>
        ) : rooms.map(r => (
          <div key={r.id} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
            <DoorOpen className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-sm text-zinc-200 truncate">{r.name}</span>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex items-center gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome da sala"
          onKeyDown={e => { if (e.key === 'Enter') create(); }}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
        <Button onClick={create} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs shrink-0">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />} Adicionar
        </Button>
      </div>
    </div>
  );
}
