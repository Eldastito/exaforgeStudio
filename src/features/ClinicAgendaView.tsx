import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Stethoscope, Plus, X, Clock, User, DoorOpen, ShieldCheck, Timer, LogIn, Play, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Loader2, MoreHorizontal, Printer, Download, Link2, Copy, Check, Ban, FileCheck2, Send, Building2, Info, ListChecks, KeyRound, Plug, Gauge, Award } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

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

// ---- Convênios e Autorizações (Fase E1) ----
type Operator = { id: string; name: string; ans_registry?: string | null; portal_url?: string | null; active?: boolean | number };
type Procedure = {
  id: string;
  name: string;
  tuss_code?: string | null;
  default_duration_minutes?: number | null;
  requires_authorization?: boolean | number;
  requires_medical_request?: boolean | number;
};
type Authorization = {
  id: string;
  contact_id: string;
  contact_name?: string | null;
  operator_id?: string | null;
  operator_name?: string | null;
  procedure_id?: string | null;
  procedure_name?: string | null;
  tuss_code?: string | null;
  status: string;
  protocol_number?: string | null;
  authorization_number?: string | null;
  denial_reason?: string | null;
  pending_requirements?: string | null;
  plan_snapshot?: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  denied_at?: string | null;
  expires_at?: string | null;
  updated_at?: string | null;
};

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

// Chips de status das autorizações (rótulos pt-BR + cores coerentes com o restante da tela).
const AUTH_STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700' },
  ready_to_submit: { label: 'Pronta p/ envio', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  submitted: { label: 'Enviada', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  pending_documents: { label: 'Docs pendentes', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  pending_operator: { label: 'Em análise', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'Aprovada', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  denied: { label: 'Negada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  expired: { label: 'Expirada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  cancelled: { label: 'Cancelada', cls: 'text-zinc-500 bg-zinc-500/10 border-zinc-700' },
  manual_required: { label: 'Manual', cls: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30' },
};

const authStatusMeta = (status: string) => AUTH_STATUS_META[status] || { label: status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700' };

const AUTH_STATUS_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'Todos os status' },
  { id: 'draft', label: 'Rascunho' },
  { id: 'ready_to_submit', label: 'Pronta p/ envio' },
  { id: 'submitted', label: 'Enviada' },
  { id: 'pending_documents', label: 'Docs pendentes' },
  { id: 'pending_operator', label: 'Em análise' },
  { id: 'approved', label: 'Aprovada' },
  { id: 'denied', label: 'Negada' },
  { id: 'expired', label: 'Expirada' },
  { id: 'cancelled', label: 'Cancelada' },
  { id: 'manual_required', label: 'Manual' },
];

// Status de retorno manual do convênio (PATCH /status).
const RETURN_STATUS_OPTIONS: { id: string; label: string }[] = [
  { id: 'approved', label: 'Aprovada' },
  { id: 'denied', label: 'Negada' },
  { id: 'pending_operator', label: 'Em análise' },
  { id: 'expired', label: 'Expirada' },
  { id: 'cancelled', label: 'Cancelada' },
  { id: 'manual_required', label: 'Manual' },
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
  const [tab, setTab] = useState<'agenda' | 'autorizacoes' | 'conexao'>('agenda');
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

  // Exporta a agenda do dia (respeitando o filtro de profissional) em CSV.
  // O download não passa pelo apiFetch se usarmos <a href> direto (rota /api/clinic
  // exige token), então buscamos via apiFetch e geramos um Blob local.
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ date });
      if (filterProfessional) params.set('professionalId', filterProfessional);
      const r = await apiFetch(`/api/clinic/agenda/export.csv?${params.toString()}`);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error || 'Não foi possível exportar.');
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `agenda-${date}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('CSV exportado.');
    } catch (e: any) {
      toast.error(e.message || 'Falha ao exportar CSV.');
    } finally {
      setExporting(false);
    }
  };

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
        {tab === 'agenda' && (
          <div className="flex items-center gap-2 flex-wrap print:hidden">
            <button onClick={() => window.print()}
              className="h-9 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-3 text-sm text-zinc-100">
              <Printer className="w-4 h-4" /> Imprimir
            </button>
            <button onClick={exportCsv} disabled={exporting}
              className="h-9 inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-3 text-sm text-zinc-100 disabled:opacity-60">
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Exportar CSV
            </button>
            <Button className="zf-button zf-button-primary" onClick={() => setShowNew(true)}>
              <Plus className="w-4 h-4 mr-2" /> Novo agendamento
            </Button>
          </div>
        )}
      </div>

      {/* Abas internas */}
      <div className="mb-5 flex items-center gap-1 border-b border-zinc-800 print:hidden">
        {([['agenda', 'Agenda'], ['autorizacoes', 'Autorizações'], ['conexao', 'Conexão']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${tab === id ? 'border-emerald-500 text-emerald-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'autorizacoes' && <AuthorizationsTab contacts={contacts} />}

      {tab === 'conexao' && <ConnectionTab />}

      {tab === 'agenda' && (<>
      {/* Filtros */}
      <div className="mb-5 flex items-end gap-3 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 print:hidden">
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
      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 print:hidden">
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
      </>)}
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
      <div className="mt-3 flex flex-wrap items-center gap-2 relative print:hidden">
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
            <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full border border-zinc-600" style={{ backgroundColor: p.color || '#71717a' }} />
                <span className="text-sm text-zinc-200 truncate">{p.name}</span>
                {p.specialty && <span className="text-[11px] text-zinc-500 truncate">{p.specialty}</span>}
                <button onClick={() => toggleActive(p)} className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${active ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-zinc-500 border-zinc-700'}`}>
                  {active ? 'Ativo' : 'Inativo'}
                </button>
              </div>
              <PortalControl professionalId={p.id} />
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

// ---- Controle do Portal do Profissional (Fase D2) ----
// ISO -> "11/07/2026 14:30" (local).
const fmtDateTime = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

type PortalStatus = { active: boolean; expiresAt: string | null; lastAccessAt: string | null };

function PortalControl({ professionalId }: { professionalId: string }) {
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string>(''); // URL absoluta recém-gerada
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/professionals/${professionalId}/portal`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao consultar o portal.');
      setStatus({ active: !!d.active, expiresAt: d.expiresAt ?? null, lastAccessAt: d.lastAccessAt ?? null });
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [professionalId]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const generate = async () => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/professionals/${professionalId}/portal`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível gerar o link.');
      setLinkUrl(window.location.origin + d.path);
      setStatus(s => ({ active: true, expiresAt: d.expiresAt ?? null, lastAccessAt: s?.lastAccessAt ?? null }));
      toast.success('Link do portal gerado.');
    } catch (e: any) {
      toast.error(e.message || 'Falha ao gerar o link.');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('Link copiado.');
    } catch {
      toast.error('Não foi possível copiar o link.');
    }
  };

  const revoke = async () => {
    const ok = await confirmDialog('Revogar o link de acesso deste profissional? O link atual deixará de funcionar.', {
      title: 'Revogar acesso', confirmText: 'Revogar', danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/professionals/${professionalId}/portal`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível revogar.');
      setLinkUrl('');
      setStatus({ active: false, expiresAt: null, lastAccessAt: status?.lastAccessAt ?? null });
      toast.success('Acesso revogado.');
    } catch (e: any) {
      toast.error(e.message || 'Falha ao revogar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800/80">
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <Link2 className="w-3.5 h-3.5 text-zinc-500" />
        <span className="text-zinc-400">Portal:</span>
        {loading ? (
          <span className="text-zinc-600 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> …</span>
        ) : status?.active ? (
          <span className="text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10">Ativo</span>
        ) : (
          <span className="text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-700">Inativo</span>
        )}
        {status?.active && status.expiresAt && (
          <span className="text-zinc-500">Válido até {fmtDateTime(status.expiresAt)}</span>
        )}
        {status?.lastAccessAt && (
          <span className="text-zinc-600">Último acesso: {fmtDateTime(status.lastAccessAt)}</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button onClick={generate} disabled={busy}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white disabled:opacity-60">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />} {status?.active ? 'Novo link' : 'Gerar link'}
          </button>
          {status?.active && (
            <button onClick={revoke} disabled={busy}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-60">
              <Ban className="w-3 h-3" /> Revogar
            </button>
          )}
        </div>
      </div>

      {linkUrl && (
        <div className="mt-2 flex items-center gap-1.5">
          <input readOnly value={linkUrl} onFocus={e => e.currentTarget.select()}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-[11px] text-zinc-200 outline-none focus:border-emerald-500 font-mono" />
          <button onClick={copy}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-[11px]">
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      )}
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

// ================================================================
// Aba: Convênios e Autorizações (Fase E1)
// ================================================================
function AuthorizationsTab({ contacts }: { contacts: ContactLite[] }) {
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Authorization[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showCadastro, setShowCadastro] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    setLoading(true);
    return apiFetch(`/api/clinic/authorizations?${params.toString()}`)
      .then(r => r.json())
      .then(d => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [status]);

  const loadOperators = useCallback(() => apiFetch('/api/clinic/operators').then(r => r.json()).then(d => setOperators(Array.isArray(d) ? d : [])).catch(() => {}), []);
  const loadProcedures = useCallback(() => apiFetch('/api/clinic/procedures').then(r => r.json()).then(d => setProcedures(Array.isArray(d) ? d : [])).catch(() => {}), []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadOperators(); loadProcedures(); }, [loadOperators, loadProcedures]);

  return (
    <div>
      {/* Aviso de guardrail — a IA nunca promete cobertura, envio é sempre manual. */}
      <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="leading-relaxed">
          A IA <b>nunca promete cobertura</b> nem garante autorização: ela apenas organiza documentos e pendências.
          O <b>envio ao convênio é sempre manual</b> e o retorno é registrado por um humano.
        </span>
      </div>

      {/* Filtro + ação */}
      <div className="mb-5 flex items-end gap-3 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="flex flex-col gap-1 min-w-[180px]">
          <span className="text-[11px] text-zinc-400">Status</span>
          <select value={status} onChange={e => setStatus(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            {AUTH_STATUS_FILTERS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <span className="text-[11px] text-zinc-600 self-center">{items.length} solicitação(ões)</span>
        <div className="ml-auto">
          <Button className="zf-button zf-button-primary" onClick={() => setShowNew(true)}>
            <Plus className="w-4 h-4 mr-2" /> Nova solicitação
          </Button>
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10"><Loader2 className="w-4 h-4 animate-spin" /> Carregando autorizações…</div>
      ) : items.length === 0 ? (
        <div className="py-14 text-center rounded-xl border border-zinc-800 bg-zinc-900/40">
          <FileCheck2 className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Nenhuma solicitação de autorização</p>
          <p className="text-[12px] text-zinc-600 mt-1">Crie uma nova solicitação ou ajuste o filtro de status.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(a => <div key={a.id}><AuthCard auth={a} onChanged={load} /></div>)}
        </div>
      )}

      {/* Painel colapsável — Operadoras e procedimentos */}
      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50">
        <button onClick={() => setShowCadastro(s => !s)} className="w-full flex items-center justify-between px-5 py-3 text-left">
          <span className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Building2 className="w-4 h-4 text-emerald-400" /> Operadoras e procedimentos</span>
          {showCadastro ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
        </button>
        {showCadastro && (
          <div className="px-5 pb-5 grid grid-cols-1 lg:grid-cols-2 gap-5 border-t border-zinc-800 pt-4">
            <OperatorsPanel operators={operators} onChanged={loadOperators} />
            <ProceduresPanel procedures={procedures} onChanged={loadProcedures} />
          </div>
        )}
      </div>

      {showNew && (
        <NewAuthorizationModal
          contacts={contacts}
          operators={operators}
          procedures={procedures}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); load(); }}
        />
      )}
    </div>
  );
}

// ---- Card de autorização ----
function AuthCard({ auth, onChanged }: { auth: Authorization; onChanged: () => void }) {
  const [form, setForm] = useState<'' | 'prepare' | 'submit' | 'return'>('');
  const meta = authStatusMeta(auth.status);
  const canPrepare = auth.status === 'draft' || auth.status === 'pending_documents';
  const canSubmit = auth.status === 'ready_to_submit';
  const canRegisterReturn = auth.status === 'submitted' || auth.status === 'pending_operator';

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <User className="w-3.5 h-3.5 text-zinc-500" />
            <h3 className="font-semibold text-zinc-100 truncate">{auth.contact_name || 'Paciente'}</h3>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-zinc-400">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-zinc-500" /> {auth.operator_name || 'Sem operadora'}</span>
            <span className="inline-flex items-center gap-1.5">
              <Stethoscope className="w-3.5 h-3.5 text-zinc-500" /> {auth.procedure_name || 'Sem procedimento'}
              {auth.tuss_code && <span className="font-mono text-[11px] text-zinc-500">TUSS {auth.tuss_code}</span>}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
            {auth.protocol_number && <span>Protocolo: <span className="text-zinc-300 font-mono">{auth.protocol_number}</span></span>}
            {auth.authorization_number && <span>Nº autorização: <span className="text-emerald-300 font-mono">{auth.authorization_number}</span></span>}
            {auth.expires_at && <span>Válida até {fmtDateTime(auth.expires_at)}</span>}
            <span>Atualizada em {fmtDateTime(auth.updated_at)}</span>
          </div>
          {auth.pending_requirements && (
            <p className="mt-2 text-[12px] text-amber-200/90 flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
              <ListChecks className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Pendências: {auth.pending_requirements}
            </p>
          )}
          {auth.denial_reason && (
            <p className="mt-2 text-[12px] text-red-200/90 flex items-start gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-2 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Motivo da negativa: {auth.denial_reason}
            </p>
          )}
        </div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${meta.cls}`}>{meta.label}</span>
      </div>

      {/* Ações */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canPrepare && (
          <button onClick={() => setForm(f => (f === 'prepare' ? '' : 'prepare'))}
            className="text-[11px] px-2 py-1 rounded-lg bg-sky-600/90 hover:bg-sky-600 text-white inline-flex items-center gap-1">
            <ListChecks className="w-3 h-3" /> Preparar
          </button>
        )}
        {canSubmit && (
          <button onClick={() => setForm(f => (f === 'submit' ? '' : 'submit'))}
            className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white inline-flex items-center gap-1">
            <Send className="w-3 h-3" /> Enviar ao convênio
          </button>
        )}
        {canRegisterReturn && (
          <button onClick={() => setForm(f => (f === 'return' ? '' : 'return'))}
            className="text-[11px] px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 inline-flex items-center gap-1">
            <FileCheck2 className="w-3 h-3" /> Registrar retorno
          </button>
        )}
      </div>

      {form === 'prepare' && <PrepareForm auth={auth} onClose={() => setForm('')} onDone={() => { setForm(''); onChanged(); }} />}
      {form === 'submit' && <SubmitForm auth={auth} onClose={() => setForm('')} onDone={() => { setForm(''); onChanged(); }} />}
      {form === 'return' && <RegisterReturnForm auth={auth} onClose={() => setForm('')} onDone={() => { setForm(''); onChanged(); }} />}
    </div>
  );
}

// ---- Form inline: Preparar (draft / pending_documents) ----
function PrepareForm({ auth, onClose, onDone }: { auth: Authorization; onClose: () => void; onDone: () => void }) {
  const [pending, setPending] = useState(auth.pending_requirements || '');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/authorizations/${auth.id}/prepare`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingRequirements: pending.trim() || undefined, ready }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível preparar a solicitação.');
      toast.success('Solicitação atualizada.');
      onDone();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao preparar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
      <label className="text-[11px] text-zinc-400 block">Pendências (documentos / requisitos)</label>
      <textarea value={pending} onChange={e => setPending(e.target.value)} rows={2} placeholder="Ex.: Falta pedido médico assinado e carteirinha."
        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500 resize-y" />
      <label className="flex items-center gap-2 text-[12px] text-zinc-300 cursor-pointer">
        <input type="checkbox" checked={ready} onChange={e => setReady(e.target.checked)}
          className="accent-emerald-500 w-3.5 h-3.5" />
        Pronta para envio (sem pendências)
      </label>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} disabled={busy} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancelar</button>
        <button onClick={submit} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1 disabled:opacity-60">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Salvar
        </button>
      </div>
    </div>
  );
}

// ---- Form inline: Enviar ao convênio (ready_to_submit) ----
function SubmitForm({ auth, onClose, onDone }: { auth: Authorization; onClose: () => void; onDone: () => void }) {
  const [protocol, setProtocol] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/authorizations/${auth.id}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolNumber: protocol.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível enviar ao convênio.');
      toast.success('Solicitação enviada ao convênio.');
      onDone();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao enviar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
      <p className="text-[11px] text-zinc-500">O envio é manual: registre aqui o protocolo devolvido pelo portal do convênio (opcional).</p>
      <label className="text-[11px] text-zinc-400 block">Nº de protocolo (opcional)</label>
      <input value={protocol} onChange={e => setProtocol(e.target.value)} placeholder="Ex.: 2026070100123"
        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
      <div className="flex justify-end gap-2">
        <button onClick={onClose} disabled={busy} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancelar</button>
        <button onClick={submit} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1 disabled:opacity-60">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Confirmar envio
        </button>
      </div>
    </div>
  );
}

// ---- Form inline: Registrar retorno manual (submitted / pending_operator) ----
function RegisterReturnForm({ auth, onClose, onDone }: { auth: Authorization; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState('approved');
  const [authorizationNumber, setAuthorizationNumber] = useState('');
  const [denialReason, setDenialReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [protocol, setProtocol] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (status === 'denied' && !denialReason.trim()) { toast.error('Informe o motivo da negativa.'); return; }
    setBusy(true);
    try {
      const payload: any = { status, protocolNumber: protocol.trim() || undefined };
      if (status === 'approved') {
        payload.authorizationNumber = authorizationNumber.trim() || undefined;
        payload.expiresAt = expiresAt ? new Date(expiresAt).toISOString() : undefined;
      }
      if (status === 'denied') payload.denialReason = denialReason.trim() || undefined;
      const r = await apiFetch(`/api/clinic/authorizations/${auth.id}/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível registrar o retorno.');
      toast.success('Retorno do convênio registrado.');
      onDone();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao registrar retorno.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
      <label className="text-[11px] text-zinc-400 block">Retorno do convênio</label>
      <select value={status} onChange={e => setStatus(e.target.value)}
        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500">
        {RETURN_STATUS_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>

      {status === 'approved' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-zinc-400 block mb-1">Nº de autorização</label>
            <input value={authorizationNumber} onChange={e => setAuthorizationNumber(e.target.value)} placeholder="Ex.: AUT-998877"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          </div>
          <div>
            <label className="text-[11px] text-zinc-400 block mb-1">Validade</label>
            <input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          </div>
        </div>
      )}

      {status === 'denied' && (
        <div>
          <label className="text-[11px] text-zinc-400 block mb-1">Motivo da negativa</label>
          <textarea value={denialReason} onChange={e => setDenialReason(e.target.value)} rows={2} placeholder="Ex.: Procedimento fora de cobertura contratual."
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500 resize-y" />
        </div>
      )}

      <div>
        <label className="text-[11px] text-zinc-400 block mb-1">Nº de protocolo (opcional)</label>
        <input value={protocol} onChange={e => setProtocol(e.target.value)} placeholder="Protocolo do convênio"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onClose} disabled={busy} className="text-[11px] text-zinc-500 hover:text-zinc-300">Cancelar</button>
        <button onClick={submit} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1 disabled:opacity-60">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Registrar
        </button>
      </div>
    </div>
  );
}

// ---- Modal: Nova solicitação de autorização ----
function NewAuthorizationModal({ contacts, operators, procedures, onClose, onCreated }: {
  contacts: ContactLite[];
  operators: Operator[];
  procedures: Procedure[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [contactId, setContactId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [procedureId, setProcedureId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!contactId) { toast.error('Selecione o paciente.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/clinic/authorizations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId,
          operatorId: operatorId || undefined,
          procedureId: procedureId || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível criar a solicitação.');
      toast.success('Solicitação criada.');
      onCreated();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao criar solicitação.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[440px] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><FileCheck2 className="w-5 h-5 text-emerald-400" /> Nova solicitação</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={e => { e.preventDefault(); submit(); }} className="space-y-4">
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Paciente</label>
            <select required value={contactId} onChange={e => setContactId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">Selecione um paciente</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` — ${c.identifier}` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Operadora <span className="text-zinc-600">(opcional)</span></label>
            <select value={operatorId} onChange={e => setOperatorId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">—</option>
              {operators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Procedimento <span className="text-zinc-600">(opcional)</span></label>
            <select value={procedureId} onChange={e => setProcedureId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">—</option>
              {procedures.map(p => <option key={p.id} value={p.id}>{p.name}{p.tuss_code ? ` — TUSS ${p.tuss_code}` : ''}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={busy} className="zf-button zf-button-primary">
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null} Criar
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Painel: Operadoras + credenciais ----
function OperatorsPanel({ operators, onChanged }: { operators: Operator[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [ansRegistry, setAnsRegistry] = useState('');
  const [portalUrl, setPortalUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) { toast.error('Informe o nome da operadora.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/clinic/operators', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), ansRegistry: ansRegistry.trim() || undefined, portalUrl: portalUrl.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível cadastrar.');
      toast.success('Operadora cadastrada.');
      setName(''); setAnsRegistry(''); setPortalUrl('');
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao cadastrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-zinc-100 mb-2">Operadoras</h4>
      <div className="space-y-1.5 mb-3">
        {operators.length === 0 ? (
          <p className="text-[11px] text-zinc-600">Nenhuma operadora cadastrada.</p>
        ) : operators.map(o => (
          <div key={o.id} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <ShieldCheck className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-sm text-zinc-200 truncate">{o.name}</span>
              {o.ans_registry && <span className="text-[11px] text-zinc-500">ANS {o.ans_registry}</span>}
              {o.portal_url && <a href={o.portal_url} target="_blank" rel="noreferrer" className="text-[11px] text-sky-400 hover:text-sky-300 inline-flex items-center gap-1"><Link2 className="w-3 h-3" /> portal</a>}
            </div>
            <OperatorCredentials operatorId={o.id} />
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome da operadora"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
        <div className="flex items-center gap-2">
          <input value={ansRegistry} onChange={e => setAnsRegistry(e.target.value)} placeholder="Registro ANS (opcional)"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          <input value={portalUrl} onChange={e => setPortalUrl(e.target.value)} placeholder="URL do portal (opcional)"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
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

// ---- Credenciais da operadora (nunca exibe valores; só status configurado/não) ----
function OperatorCredentials({ operatorId }: { operatorId: string }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [providerCode, setProviderCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Campos de edição (nunca preenchidos com valores existentes por segurança).
  const [editCode, setEditCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/operators/${operatorId}/credentials`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao consultar credenciais.');
      setConfigured(!!d.configured);
      setProviderCode(d.providerCode || '');
    } catch {
      setConfigured(null);
    } finally {
      setLoading(false);
    }
  }, [operatorId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/operators/${operatorId}/credentials`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerCode: editCode.trim() || undefined,
          username: username.trim() || undefined,
          password: password || undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível salvar as credenciais.');
      setConfigured(!!d.configured);
      setEditCode(''); setUsername(''); setPassword('');
      setOpen(false);
      toast.success('Credenciais salvas.');
      load();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao salvar credenciais.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800/80">
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <KeyRound className="w-3.5 h-3.5 text-zinc-500" />
        <span className="text-zinc-400">Credenciais:</span>
        {loading ? (
          <span className="text-zinc-600 inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> …</span>
        ) : configured ? (
          <span className="text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10">Configurado</span>
        ) : (
          <span className="text-zinc-500 px-1.5 py-0.5 rounded border border-zinc-700">Não configurado</span>
        )}
        {providerCode && <span className="text-zinc-600">Cód. prestador: {providerCode}</span>}
        <button onClick={() => setOpen(o => !o)} className="ml-auto text-[11px] text-zinc-400 hover:text-emerald-300">
          {open ? 'Fechar' : configured ? 'Atualizar' : 'Configurar'}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-2">
          <input value={editCode} onChange={e => setEditCode(e.target.value)} placeholder="Código do prestador"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="off" placeholder="Usuário"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" placeholder="Senha"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          <p className="text-[10px] text-zinc-600">As credenciais são armazenadas com segurança e nunca reexibidas — informe novamente para atualizar.</p>
          <div className="flex justify-end">
            <button onClick={save} disabled={busy} className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1 disabled:opacity-60">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Salvar credenciais
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Painel: Procedimentos ----
function ProceduresPanel({ procedures, onChanged }: { procedures: Procedure[]; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [tussCode, setTussCode] = useState('');
  const [duration, setDuration] = useState('');
  const [requiresAuthorization, setRequiresAuthorization] = useState(false);
  const [requiresMedicalRequest, setRequiresMedicalRequest] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim()) { toast.error('Informe o nome do procedimento.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/clinic/procedures', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          tussCode: tussCode.trim() || undefined,
          defaultDurationMinutes: duration ? parseInt(duration, 10) : undefined,
          requiresAuthorization,
          requiresMedicalRequest,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível cadastrar.');
      toast.success('Procedimento cadastrado.');
      setName(''); setTussCode(''); setDuration(''); setRequiresAuthorization(false); setRequiresMedicalRequest(false);
      onChanged();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao cadastrar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h4 className="text-sm font-medium text-zinc-100 mb-2">Procedimentos</h4>
      <div className="space-y-1.5 mb-3">
        {procedures.length === 0 ? (
          <p className="text-[11px] text-zinc-600">Nenhum procedimento cadastrado.</p>
        ) : procedures.map(p => (
          <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Stethoscope className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-sm text-zinc-200 truncate">{p.name}</span>
              {p.tuss_code && <span className="text-[11px] text-zinc-500 font-mono">TUSS {p.tuss_code}</span>}
              {p.default_duration_minutes ? <span className="text-[11px] text-zinc-500 inline-flex items-center gap-1"><Timer className="w-3 h-3" /> {p.default_duration_minutes} min</span> : null}
            </div>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              {(p.requires_authorization === true || p.requires_authorization === 1) && <span className="text-[10px] px-1.5 py-0.5 rounded border text-amber-300 border-amber-500/30 bg-amber-500/10">Requer autorização</span>}
              {(p.requires_medical_request === true || p.requires_medical_request === 1) && <span className="text-[10px] px-1.5 py-0.5 rounded border text-sky-300 border-sky-500/30 bg-sky-500/10">Requer pedido médico</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome do procedimento"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
        <div className="flex items-center gap-2">
          <input value={tussCode} onChange={e => setTussCode(e.target.value)} placeholder="Código TUSS (opcional)"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
          <input value={duration} onChange={e => setDuration(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="Duração (min)"
            className="w-32 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <label className="flex items-center gap-2 text-[12px] text-zinc-300 cursor-pointer">
          <input type="checkbox" checked={requiresAuthorization} onChange={e => setRequiresAuthorization(e.target.checked)} className="accent-emerald-500 w-3.5 h-3.5" />
          Requer autorização
        </label>
        <label className="flex items-center gap-2 text-[12px] text-zinc-300 cursor-pointer">
          <input type="checkbox" checked={requiresMedicalRequest} onChange={e => setRequiresMedicalRequest(e.target.checked)} className="accent-emerald-500 w-3.5 h-3.5" />
          Requer pedido médico
        </label>
        <div className="flex justify-end">
          <Button onClick={create} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />} Adicionar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ================================================================
// Aba: Conexão (onboarding aos planos de saúde / TISS — Fase F0.1)
// ================================================================
type CertificateType = 'unknown' | 'none' | 'a1' | 'a3';
type ConnectionProfile = {
  organization_id?: string;
  legal_name?: string | null;
  cnpj?: string | null;
  cnes?: string | null;
  certificate_type?: CertificateType;
  certificate_valid_until?: string | null;
  responsible_name?: string | null;
  responsible_registry?: string | null;
  monthly_authorizations?: number | null;
  notes?: string | null;
};
type ConnectionOperator = {
  id: string;
  name: string;
  ans_registry?: string | null;
  portal_url?: string | null;
  active?: boolean | number;
  credentialed?: boolean | number;
  provider_code?: string | null;
  has_homolog_access?: boolean | number;
  tiss_version?: string | null;
  accepts_webservice?: boolean | number;
  monthly_volume?: number | null;
  unimed_singular?: string | null;
  connector_type?: string | null;
};
type ReadinessStatus = 'blocked_certificate' | 'gathering' | 'ready_to_homologate' | 'connected';
type ConnectionCeiling = 'manual' | 'signed_xml' | 'webservice';
type ReadinessOperator = {
  id: string;
  name: string;
  unimed_singular?: string | null;
  credentialed?: boolean | number;
  has_homolog_access?: boolean | number;
  tiss_version?: string | null;
  accepts_webservice?: boolean | number;
  connector_type?: string | null;
  status: ReadinessStatus;
  connectionCeiling: ConnectionCeiling;
  missing: string[];
};
type Readiness = {
  profile: ConnectionProfile;
  orgBlocking: string[];
  operators: ReadinessOperator[];
  summary: {
    operators: number;
    readyToHomologate: number;
    blockedByCertificate: number;
    suggestedPilot: { id: string; name: string; volume?: number } | null;
  };
};

// true tanto para boolean quanto para 0/1 vindos do backend.
const truthy = (v?: boolean | number | null) => v === true || v === 1;

const READINESS_STATUS_META: Record<ReadinessStatus, { label: string; cls: string; dot: string }> = {
  blocked_certificate: { label: 'Bloqueada — certificado', cls: 'text-red-300 bg-red-500/10 border-red-500/30', dot: 'bg-red-400' },
  gathering: { label: 'Reunindo dados', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30', dot: 'bg-amber-400' },
  ready_to_homologate: { label: 'Pronta p/ homologar', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400' },
  connected: { label: 'Conectada', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30', dot: 'bg-sky-400' },
};
const readinessStatusMeta = (s: string) => READINESS_STATUS_META[s as ReadinessStatus] || { label: s, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700', dot: 'bg-zinc-500' };

const CEILING_LABEL: Record<ConnectionCeiling, string> = {
  manual: 'Manual',
  signed_xml: 'Guia assinada (Nível 2)',
  webservice: 'WebService (Nível 3)',
};
const ceilingLabel = (c: string) => CEILING_LABEL[c as ConnectionCeiling] || c;

const CERTIFICATE_OPTIONS: { id: CertificateType; label: string }[] = [
  { id: 'unknown', label: 'Não sei' },
  { id: 'none', label: 'Não tenho' },
  { id: 'a1', label: 'A1 (arquivo)' },
  { id: 'a3', label: 'A3 (token/cartão)' },
];

function ConnectionTab() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [operators, setOperators] = useState<ConnectionOperator[]>([]);
  const [loading, setLoading] = useState(true);

  const loadReadiness = useCallback(
    () => apiFetch('/api/clinic/connection/readiness').then(r => r.json()).then(d => setReadiness(d && typeof d === 'object' ? d : null)).catch(() => setReadiness(null)),
    [],
  );
  const loadOperators = useCallback(
    () => apiFetch('/api/clinic/operators').then(r => r.json()).then(d => setOperators(Array.isArray(d) ? d : [])).catch(() => setOperators([])),
    [],
  );

  useEffect(() => {
    setLoading(true);
    Promise.all([loadReadiness(), loadOperators()]).finally(() => setLoading(false));
  }, [loadReadiness, loadOperators]);

  const profile = readiness?.profile ?? null;

  return (
    <div>
      {/* Texto de topo */}
      <div className="mb-5 flex items-start gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-300">
        <Plug className="w-4 h-4 mt-0.5 shrink-0 text-emerald-400" />
        <span className="leading-relaxed">
          Preencha os dados de conexão aos planos. O sistema valida o que falta e indica por onde começar a integração TISS.
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10"><Loader2 className="w-4 h-4 animate-spin" /> Carregando prontidão…</div>
      ) : (
        <>
          <ReadinessPanel readiness={readiness} />
          <ProfileForm profile={profile} onSaved={loadReadiness} />
          <OperatorsReadinessSection operators={operators} onSaved={() => { loadOperators(); loadReadiness(); }} />
        </>
      )}
    </div>
  );
}

// ---- Painel de prontidão (GET /connection/readiness) ----
function ReadinessPanel({ readiness }: { readiness: Readiness | null }) {
  if (!readiness) {
    return (
      <div className="mb-6 py-10 text-center rounded-xl border border-zinc-800 bg-zinc-900/40">
        <Gauge className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
        <p className="text-sm text-zinc-300 font-medium">Não foi possível carregar a prontidão</p>
        <p className="text-[12px] text-zinc-600 mt-1">Preencha o perfil abaixo para começar.</p>
      </div>
    );
  }

  const { summary, orgBlocking, operators } = readiness;

  return (
    <div className="mb-6 space-y-4">
      {/* Cards-resumo */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="text-[11px] text-zinc-500 flex items-center gap-1.5"><Building2 className="w-3.5 h-3.5" /> Operadoras</div>
          <div className="mt-1 text-2xl font-semibold text-zinc-100">{summary.operators}</div>
        </div>
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
          <div className="text-[11px] text-emerald-300/90 flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Prontas p/ homologar</div>
          <div className="mt-1 text-2xl font-semibold text-emerald-300">{summary.readyToHomologate}</div>
        </div>
        <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-4">
          <div className="text-[11px] text-red-300/90 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Bloqueadas por certificado</div>
          <div className="mt-1 text-2xl font-semibold text-red-300">{summary.blockedByCertificate}</div>
        </div>
      </div>

      {/* Operadora sugerida para piloto */}
      {summary.suggestedPilot && (
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 flex items-center gap-2 text-sm text-sky-100">
          <Award className="w-4 h-4 text-sky-300 shrink-0" />
          <span>Operadora sugerida para piloto: <b>{summary.suggestedPilot.name}</b>
            {typeof summary.suggestedPilot.volume === 'number' && summary.suggestedPilot.volume > 0 && (
              <span className="text-sky-300/80"> · ~{summary.suggestedPilot.volume} autorizações/mês</span>
            )}
          </span>
        </div>
      )}

      {/* Bloqueios de nível organização */}
      {orgBlocking && orgBlocking.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-200 font-medium flex items-center gap-1.5 mb-1.5"><AlertTriangle className="w-4 h-4" /> Pendências da organização</p>
          <ul className="space-y-1">
            {orgBlocking.map((b, i) => (
              <li key={`${i}-${b}`} className="text-[12px] text-amber-200/90 flex items-start gap-1.5">
                <span className="mt-1 w-1 h-1 rounded-full bg-amber-400 shrink-0" /> {b}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Lista por operadora */}
      <div>
        <h4 className="text-sm font-medium text-zinc-100 mb-2">Prontidão por operadora</h4>
        {operators.length === 0 ? (
          <p className="text-[12px] text-zinc-600 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">Nenhuma operadora cadastrada ainda.</p>
        ) : (
          <div className="space-y-2">
            {operators.map(op => {
              const meta = readinessStatusMeta(op.status);
              return (
                <div key={op.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <ShieldCheck className="w-3.5 h-3.5 text-zinc-500" />
                        <span className="font-semibold text-zinc-100 truncate">{op.name}</span>
                        {op.unimed_singular && <span className="text-[11px] text-zinc-500">Singular: {op.unimed_singular}</span>}
                      </div>
                      <div className="mt-1.5 text-[12px] text-zinc-400 inline-flex items-center gap-1.5">
                        <Gauge className="w-3.5 h-3.5 text-zinc-500" /> Teto de automação: <span className="text-zinc-200">{ceilingLabel(op.connectionCeiling)}</span>
                      </div>
                      {op.missing && op.missing.length > 0 && (
                        <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
                          <p className="text-[11px] text-amber-200/90 flex items-center gap-1.5 mb-1"><ListChecks className="w-3.5 h-3.5" /> Falta:</p>
                          <ul className="space-y-0.5">
                            {op.missing.map((m, i) => (
                              <li key={`${i}-${m}`} className="text-[11px] text-amber-200/80 flex items-start gap-1.5">
                                <span className="mt-1 w-1 h-1 rounded-full bg-amber-400 shrink-0" /> {m}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1 shrink-0 ${meta.cls}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} /> {meta.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Formulário: perfil da organização (GET/PUT /connection/profile) ----
function ProfileForm({ profile, onSaved }: { profile: ConnectionProfile | null; onSaved: () => void }) {
  const [legalName, setLegalName] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [cnes, setCnes] = useState('');
  const [certificateType, setCertificateType] = useState<CertificateType>('unknown');
  const [certificateValidUntil, setCertificateValidUntil] = useState('');
  const [responsibleName, setResponsibleName] = useState('');
  const [responsibleRegistry, setResponsibleRegistry] = useState('');
  const [monthlyAuthorizations, setMonthlyAuthorizations] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Preenche os campos a partir do perfil carregado (a validade vem ISO → YYYY-MM-DD).
  useEffect(() => {
    if (!profile) return;
    setLegalName(profile.legal_name || '');
    setCnpj(profile.cnpj || '');
    setCnes(profile.cnes || '');
    setCertificateType((profile.certificate_type as CertificateType) || 'unknown');
    setCertificateValidUntil(profile.certificate_valid_until ? String(profile.certificate_valid_until).slice(0, 10) : '');
    setResponsibleName(profile.responsible_name || '');
    setResponsibleRegistry(profile.responsible_registry || '');
    setMonthlyAuthorizations(profile.monthly_authorizations != null ? String(profile.monthly_authorizations) : '');
    setNotes(profile.notes || '');
  }, [profile]);

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        legalName: legalName.trim() || undefined,
        cnpj: cnpj.trim() || undefined,
        cnes: cnes.trim() || undefined,
        certificateType,
        certificateValidUntil: certificateValidUntil || undefined,
        responsibleName: responsibleName.trim() || undefined,
        responsibleRegistry: responsibleRegistry.trim() || undefined,
        monthlyAuthorizations: monthlyAuthorizations ? parseInt(monthlyAuthorizations, 10) : undefined,
        notes: notes.trim() || undefined,
      };
      const r = await apiFetch('/api/clinic/connection/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível salvar o perfil.');
      toast.success('Perfil de conexão salvo.');
      onSaved();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao salvar o perfil.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h4 className="text-sm font-medium text-zinc-100 mb-3 flex items-center gap-2"><Building2 className="w-4 h-4 text-emerald-400" /> Perfil da organização</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className="text-[11px] text-zinc-400 mb-1 block">Razão social</label>
          <input value={legalName} onChange={e => setLegalName(e.target.value)} placeholder="Ex.: Clínica Exemplo Ltda."
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label className="text-[11px] text-zinc-400 mb-1 block">CNPJ</label>
          <input value={cnpj} onChange={e => setCnpj(e.target.value)} placeholder="00.000.000/0000-00"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label className="text-[11px] text-zinc-400 mb-1 block">CNES</label>
          <input value={cnes} onChange={e => setCnes(e.target.value)} placeholder="Código do estabelecimento"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label className="text-[11px] text-zinc-400 mb-1 block">Tipo de certificado digital</label>
          <select value={certificateType} onChange={e => setCertificateType(e.target.value as CertificateType)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            {CERTIFICATE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-zinc-400 mb-1 block">Validade do certificado</label>
          <input type="date" value={certificateValidUntil} onChange={e => setCertificateValidUntil(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label className="text-[11px] text-zinc-400 mb-1 block">Responsável</label>
          <input value={responsibleName} onChange={e => setResponsibleName(e.target.value)} placeholder="Nome do responsável"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label className="text-[11px] text-zinc-400 mb-1 block">Registro do responsável</label>
          <input value={responsibleRegistry} onChange={e => setResponsibleRegistry(e.target.value)} placeholder="Ex.: CRM 12345 / SP"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <div>
          <label className="text-[11px] text-zinc-400 mb-1 block">Autorizações por mês</label>
          <input value={monthlyAuthorizations} onChange={e => setMonthlyAuthorizations(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="ex.: 120"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </div>
        <div className="sm:col-span-2">
          <label className="text-[11px] text-zinc-400 mb-1 block">Observações</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Notas internas sobre a conexão."
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 resize-y" />
        </div>
      </div>

      <p className="mt-3 text-[11px] text-amber-200/90 flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> A3 (token/cartão) não é suportado na integração automática — nesses casos, a autorização segue no modo manual.
      </p>

      <div className="mt-3 flex justify-end">
        <Button onClick={save} disabled={busy} className="bg-emerald-600 hover:bg-emerald-700 text-white h-9 px-4 text-sm">
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />} Salvar
        </Button>
      </div>
    </div>
  );
}

// ---- Prontidão por operadora (PATCH /operators/:id/readiness) ----
function OperatorsReadinessSection({ operators, onSaved }: { operators: ConnectionOperator[]; onSaved: () => void }) {
  return (
    <div className="mb-6">
      <h4 className="text-sm font-medium text-zinc-100 mb-2 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-400" /> Prontidão por operadora</h4>
      {operators.length === 0 ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[12px] text-amber-200 flex items-start gap-2">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Nenhuma operadora cadastrada. As operadoras são cadastradas na aba <b>Autorizações</b>, no painel “Operadoras e procedimentos”.</span>
        </div>
      ) : (
        <div className="space-y-2">
          {operators.map(op => <div key={op.id}><OperatorReadinessRow operator={op} onSaved={onSaved} /></div>)}
        </div>
      )}
    </div>
  );
}

function OperatorReadinessRow({ operator, onSaved }: { operator: ConnectionOperator; onSaved: () => void }) {
  const [credentialed, setCredentialed] = useState(truthy(operator.credentialed));
  const [providerCode, setProviderCode] = useState(operator.provider_code || '');
  const [hasHomologAccess, setHasHomologAccess] = useState(truthy(operator.has_homolog_access));
  const [tissVersion, setTissVersion] = useState(operator.tiss_version || '');
  const [acceptsWebservice, setAcceptsWebservice] = useState(truthy(operator.accepts_webservice));
  const [monthlyVolume, setMonthlyVolume] = useState(operator.monthly_volume != null ? String(operator.monthly_volume) : '');
  const [unimedSingular, setUnimedSingular] = useState(operator.unimed_singular || '');
  const [busy, setBusy] = useState(false);
  const isUnimed = /unimed/i.test(operator.name);

  const save = async () => {
    setBusy(true);
    try {
      const payload: any = {
        credentialed,
        providerCode: providerCode.trim() || undefined,
        hasHomologAccess,
        tissVersion: tissVersion.trim() || undefined,
        acceptsWebservice,
        monthlyVolume: monthlyVolume ? parseInt(monthlyVolume, 10) : undefined,
      };
      if (isUnimed) payload.unimedSingular = unimedSingular.trim() || undefined;
      const r = await apiFetch(`/api/clinic/operators/${operator.id}/readiness`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não foi possível salvar a prontidão.');
      toast.success('Prontidão da operadora salva.');
      onSaved();
    } catch (e: any) {
      toast.error(e.message || 'Falha ao salvar a prontidão.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <ShieldCheck className="w-3.5 h-3.5 text-zinc-500" />
        <span className="font-semibold text-zinc-100 truncate">{operator.name}</span>
        {operator.ans_registry && <span className="text-[11px] text-zinc-500">ANS {operator.ans_registry}</span>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex flex-col justify-end gap-2">
          <label className="flex items-center gap-2 text-[12px] text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={credentialed} onChange={e => setCredentialed(e.target.checked)} className="accent-emerald-500 w-3.5 h-3.5" />
            Credenciada
          </label>
          <label className="flex items-center gap-2 text-[12px] text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={hasHomologAccess} onChange={e => setHasHomologAccess(e.target.checked)} className="accent-emerald-500 w-3.5 h-3.5" />
            Tem acesso à homologação
          </label>
          <label className="flex items-center gap-2 text-[12px] text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={acceptsWebservice} onChange={e => setAcceptsWebservice(e.target.checked)} className="accent-emerald-500 w-3.5 h-3.5" />
            Aceita WebService
          </label>
        </div>
        <div className="space-y-2">
          <div>
            <label className="text-[11px] text-zinc-400 mb-1 block">Código do prestador</label>
            <input value={providerCode} onChange={e => setProviderCode(e.target.value)} placeholder="Ex.: 998877"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <label className="text-[11px] text-zinc-400 mb-1 block">Versão TISS</label>
              <input value={tissVersion} onChange={e => setTissVersion(e.target.value)} placeholder="Ex.: 4.01.00"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
            </div>
            <div className="w-28">
              <label className="text-[11px] text-zinc-400 mb-1 block">Volume/mês</label>
              <input value={monthlyVolume} onChange={e => setMonthlyVolume(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="ex.: 40"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
            </div>
          </div>
          {isUnimed && (
            <div>
              <label className="text-[11px] text-zinc-400 mb-1 block">Singular (Unimed)</label>
              <input value={unimedSingular} onChange={e => setUnimedSingular(e.target.value)} placeholder="Ex.: Unimed Campinas"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <button onClick={save} disabled={busy} className="text-[12px] px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1 disabled:opacity-60">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Salvar
        </button>
      </div>
    </div>
  );
}
