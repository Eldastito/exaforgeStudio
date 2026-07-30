import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Stethoscope, Plus, X, Clock, User, DoorOpen, ShieldCheck, Timer, LogIn, Play, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Loader2, MoreHorizontal, Printer, Download, Link2, Copy, Check, Ban, FileCheck2, Send, Building2, Info, ListChecks, KeyRound, Plug, Gauge, Award, ClipboardList, Lock, FileText, Trash2, CalendarPlus, RotateCcw, Paperclip, Image as ImageIcon, Upload, Bell, BarChart3, TrendingDown, TrendingUp } from 'lucide-react';
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
  reminder_sent_at?: string | null;
  patient_confirmed_at?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  cancellation_reason?: string | null;
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
  const [chartApptId, setChartApptId] = useState<string>(''); // appointment com modal de Prontuário aberto

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
              onOpenChart={() => setChartApptId(a.id)}
            />
            </div>
          ))}
        </div>
      )}

      {/* Indicadores da clínica (ADR-080 Fase O) */}
      <ClinicMetricsPanel />

      {/* Fila de retornos pendentes (ADR-080 Fase I) */}
      <FollowUpQueuePanel />

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

      {chartApptId && (
        <EncounterModal
          appointmentId={chartApptId}
          onClose={() => setChartApptId('')}
        />
      )}
      </>)}
    </div>
  );
}

// ---- Card de agendamento ----
function AppointmentCard({ a, overrun, busyId, extendOpen, onToggleExtend, onCheckin, onStartCare, onComplete, onContinuation, onExtended, onOpenChart }: {
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
  onOpenChart: () => void;
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

        {/* Prontuário — disponível durante o atendimento e após completed (leitura ou finalização). */}
        {(inCare || a.status === 'completed' || a.status === 'in_care') && (
          <button onClick={onOpenChart} className="text-[11px] px-2 py-1 rounded-lg border border-indigo-500/40 bg-indigo-500/10 text-indigo-200 hover:bg-indigo-500/20 inline-flex items-center gap-1">
            <ClipboardList className="w-3 h-3" /> Prontuário
          </button>
        )}

        {a.reminder_sent_at && (
          <span className="text-[10px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1.5 inline-flex items-center gap-1" title={`Lembrete enviado em ${new Date(a.reminder_sent_at).toLocaleString('pt-BR')}`}>
            <Bell className="w-3 h-3" /> lembrete enviado
          </span>
        )}
        {a.patient_confirmed_at && (
          <span className="text-[10px] rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 px-1.5 inline-flex items-center gap-1" title={`Paciente confirmou em ${new Date(a.patient_confirmed_at).toLocaleString('pt-BR')}`}>
            <Check className="w-3 h-3" /> confirmado pelo paciente
          </span>
        )}
        {a.cancelled_by === 'patient' && (
          <span className="text-[10px] rounded-full bg-red-500/15 text-red-300 border border-red-500/30 px-1.5 inline-flex items-center gap-1" title={`Cancelado pelo paciente em ${a.cancelled_at ? new Date(a.cancelled_at).toLocaleString('pt-BR') : ''}`}>
            <Ban className="w-3 h-3" /> cancelado pelo paciente
          </span>
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

// ---- Prontuário/SOAP (ADR-080 Fase G) --------------------------------------
// Modal reusa o padrão dos outros modais do arquivo. 4 abas SOAP + placeholder
// "Ficha" (extensível via `form_data` — Fatia 1b carrega schema por especialidade
// a partir de foto de ficha em papel). Botão "Finalizar" bloqueia updates
// futuros (server retorna ENCOUNTER_SIGNED em PATCH). Consentimento LGPD Art.11
// (dado sensível) exigido antes de abrir: se falhar, a UI dispara o registro
// no mesmo modal e reabre.
type Encounter = {
  id: string; appointmentId: string; contactId: string;
  professionalId: string | null; professionalNameSnapshot: string | null;
  status: 'draft' | 'signed';
  subjective: string | null; objective: string | null; assessment: string | null; plan: string | null;
  formData: any | null;
  followUpRecommendedDays: number | null;
  signedBy: string | null; signedAt: string | null;
  createdAt: string; updatedAt: string;
};

function EncounterModal({ appointmentId, onClose }: { appointmentId: string; onClose: () => void }) {
  const [encounter, setEncounter] = useState<Encounter | null>(null);
  const [contactId, setContactId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'S' | 'O' | 'A' | 'P' | 'F' | 'D' | 'X'>('S');
  const [needConsent, setNeedConsent] = useState(false);
  const [dirty, setDirty] = useState<{ subjective?: string; objective?: string; assessment?: string; plan?: string; formData?: string }>({});

  const load = async () => {
    setLoading(true);
    try {
      const [encRes, aptRes] = await Promise.all([
        apiFetch(`/api/clinic/appointments/${appointmentId}/encounter`).then(r => r.json()).catch(() => null),
        apiFetch(`/api/clinic/agenda?date=${new Date().toISOString().slice(0, 10)}`).then(r => r.json()).catch(() => ({})),
      ]);
      // apt vem via encounter; se não veio, faz um GET direto (contacto pra consent)
      if (encRes && encRes.id) {
        setEncounter(encRes);
        setContactId(encRes.contactId);
        setDirty({});
        setNeedConsent(false);
      } else {
        // Tenta abrir; se der LGPD 409, marca precisa consentimento.
        await tryOpen();
      }
    } finally { setLoading(false); }
  };

  const tryOpen = async () => {
    const res = await apiFetch(`/api/clinic/appointments/${appointmentId}/encounter`, { method: 'POST' });
    const out = await res.json().catch(() => ({}));
    if (res.status === 409 && out?.code === 'LGPD_CONSENT_REQUIRED') {
      // Precisa do contactId pra registrar consentimento — pega da lista de appointments.
      const list = await apiFetch(`/api/clinic/agenda?date=${new Date().toISOString().slice(0, 10)}`).then(r => r.json()).catch(() => []);
      const apt = Array.isArray(list) ? list.find((x: any) => x.id === appointmentId) : null;
      setContactId(apt?.contact_id || '');
      setNeedConsent(true);
      return;
    }
    if (!res.ok) { toast.error(out?.error || 'Não consegui abrir o prontuário.'); return; }
    setEncounter(out);
    setContactId(out.contactId);
    setDirty({});
    setNeedConsent(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [appointmentId]);

  const grantConsent = async () => {
    if (!contactId) { toast.error('Paciente não identificado.'); return; }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/clinic/patients/${contactId}/consent/sensitive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'in_person', legalBasis: 'consent' }),
      });
      if (!res.ok) { toast.error('Falha ao registrar consentimento.'); return; }
      toast.success('Consentimento registrado.');
      await tryOpen();
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!encounter) return;
    setBusy(true);
    try {
      const patch: any = {};
      if (dirty.subjective !== undefined) patch.subjective = dirty.subjective;
      if (dirty.objective !== undefined) patch.objective = dirty.objective;
      if (dirty.assessment !== undefined) patch.assessment = dirty.assessment;
      if (dirty.plan !== undefined) patch.plan = dirty.plan;
      if (dirty.formData !== undefined) {
        try { patch.formData = dirty.formData ? JSON.parse(dirty.formData) : null; }
        catch { toast.error('Ficha: JSON inválido.'); return; }
      }
      if (Object.keys(patch).length === 0) { toast.error('Nada pra salvar.'); return; }
      const res = await apiFetch(`/api/clinic/encounters/${encounter.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(out?.error || 'Falha ao salvar prontuário.'); return; }
      setEncounter(out);
      setDirty({});
      toast.success('Prontuário salvo.');
    } finally { setBusy(false); }
  };

  const finalize = async () => {
    if (!encounter) return;
    if (!(await confirmDialog('Finalizar (assinar) o prontuário? Depois disso não é possível editar sem addendum.'))) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/clinic/encounters/${encounter.id}/finalize`, { method: 'POST' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(out?.error || 'Falha ao finalizar.'); return; }
      setEncounter(out);
      toast.success('Prontuário assinado.');
    } finally { setBusy(false); }
  };

  const val = (field: 'subjective' | 'objective' | 'assessment' | 'plan') =>
    dirty[field] !== undefined ? dirty[field]! : (encounter?.[field] ?? '');
  const setVal = (field: 'subjective' | 'objective' | 'assessment' | 'plan') => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    setDirty(d => ({ ...d, [field]: e.target.value }));

  const isSigned = encounter?.status === 'signed';
  const hasDirty = Object.keys(dirty).length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-indigo-300" /> Prontuário
            {isSigned && <span className="text-[10px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1.5 inline-flex items-center gap-1"><Lock className="w-3 h-3" /> assinado</span>}
          </h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>

        {loading && <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>}

        {!loading && needConsent && (
          <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm text-amber-100 font-medium">Consentimento LGPD Art.11 necessário</div>
                <p className="text-xs text-amber-200/90 mt-1">
                  Prontuário contém <strong>dado sensível de saúde</strong>. Antes de abrir, o paciente precisa autorizar o registro (verbal ou por assinatura). Confirme com o paciente e registre abaixo — fica auditado.
                </p>
                <button onClick={grantConsent} disabled={busy} className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />} Confirmar consentimento e abrir prontuário
                </button>
              </div>
            </div>
          </div>
        )}

        {!loading && encounter && (
          <>
            <div className="mt-4 flex gap-1 border-b border-zinc-800 flex-wrap">
              {([
                { k: 'S', label: 'S · Anamnese' },
                { k: 'O', label: 'O · Exame' },
                { k: 'A', label: 'A · Avaliação' },
                { k: 'P', label: 'P · Plano' },
                { k: 'F', label: 'Ficha' },
                { k: 'D', label: 'Docs' },
                { k: 'X', label: 'Anexos' },
              ] as const).map(t => (
                <button key={t.k} onClick={() => setTab(t.k)}
                  className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${tab === t.k ? 'border-indigo-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="mt-3">
              {tab === 'S' && (
                <textarea disabled={isSigned} value={val('subjective')} onChange={setVal('subjective')}
                  rows={10} placeholder="Queixa principal, história da doença, antecedentes relatados pelo paciente…"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 disabled:opacity-60" />
              )}
              {tab === 'O' && (
                <textarea disabled={isSigned} value={val('objective')} onChange={setVal('objective')}
                  rows={10} placeholder="Sinais vitais, exame físico, achados mensuráveis…"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 disabled:opacity-60" />
              )}
              {tab === 'A' && (
                <textarea disabled={isSigned} value={val('assessment')} onChange={setVal('assessment')}
                  rows={10} placeholder="Hipóteses diagnósticas, evolução, análise clínica…"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 disabled:opacity-60" />
              )}
              {tab === 'P' && (
                <textarea disabled={isSigned} value={val('plan')} onChange={setVal('plan')}
                  rows={10} placeholder="Conduta, medicação, procedimentos, retorno, encaminhamentos…"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100 disabled:opacity-60" />
              )}
              {tab === 'F' && (
                <div>
                  <p className="text-[11px] text-zinc-500 mb-1">Ficha personalizada da especialidade (JSON extensível). Assim que você mandar as imagens da ficha em papel, essa aba vira formulário com os campos exatos.</p>
                  <textarea disabled={isSigned}
                    value={dirty.formData !== undefined ? dirty.formData : (encounter.formData ? JSON.stringify(encounter.formData, null, 2) : '')}
                    onChange={e => setDirty(d => ({ ...d, formData: e.target.value }))}
                    rows={10} placeholder='{"escala_dor": 7, "sono": "ruim"}'
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-100 disabled:opacity-60" />
                </div>
              )}
              {tab === 'D' && (
                <EncounterDocsPanel encounterId={encounter.id} />
              )}
              {tab === 'X' && (
                <EncounterAttachmentsPanel encounterId={encounter.id} isSigned={isSigned} />
              )}
            </div>

            {/* Retorno em 1 clique (ADR-080 Fase I) — não bloqueado por signed. */}
            <FollowUpBlock encounter={encounter} onChanged={(next) => setEncounter(next)} />

            <div className="mt-4 flex items-center justify-between gap-2">
              <div className="text-[11px] text-zinc-500">
                {isSigned ? (
                  <>Assinado em {new Date(encounter.signedAt!).toLocaleString('pt-BR')}</>
                ) : hasDirty ? (
                  <span className="text-amber-300">Alterações não salvas</span>
                ) : (
                  <>Rascunho — atualizado em {new Date(encounter.updatedAt).toLocaleString('pt-BR')}</>
                )}
              </div>
              <div className="flex gap-2">
                {!isSigned && (
                  <>
                    <button onClick={save} disabled={busy || !hasDirty}
                      className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 inline-flex items-center gap-1 disabled:opacity-60">
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Salvar rascunho
                    </button>
                    <button onClick={finalize} disabled={busy}
                      className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />} Finalizar (assinar)
                    </button>
                  </>
                )}
                {isSigned && (
                  <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                    Fechar
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Docs: Receita + Atestado (ADR-080 Fase H) ----------------------------
// Painel embutido na aba "Docs" do EncounterModal. Lista o que já existe,
// deixa criar novo (draft), editar rascunho, emitir (imutável) e baixar PDF.

type PrescriptionItemDto = { drug: string; dosage?: string; quantity?: string; instructions?: string; tarja?: string };
type PrescriptionDto = {
  id: string; status: 'draft' | 'issued';
  headerNotes: string | null; items: PrescriptionItemDto[];
  repeatsAllowed: number; validUntil: string | null;
  professionalNameSnapshot: string | null; professionalRegistrationSnapshot: string | null; professionalCouncilSnapshot: string | null;
  issuedAt: string | null; createdAt: string;
};
type CertificateDto = {
  id: string; status: 'draft' | 'issued';
  cid: string | null; cidDescription: string | null;
  days: number; purpose: 'rest' | 'comparecimento' | 'other'; notes: string | null;
  professionalNameSnapshot: string | null; professionalRegistrationSnapshot: string | null; professionalCouncilSnapshot: string | null;
  issuedAt: string | null; createdAt: string;
};

function downloadPdf(url: string, filename: string) {
  // Padrão do ExportAuditButton — apiFetch garante o Authorization header.
  apiFetch(url).then(async (res) => {
    if (!res.ok) { toast.error('Não consegui baixar o PDF.'); return; }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }).catch(() => toast.error('Falha na rede ao baixar PDF.'));
}

// ---- Enviar doc por WhatsApp (ADR-080 Fase K) ----------------------------
// Botão embutido nos cards issued. Guarda estado local do último delivery
// pra badge (sent/failed). Sem polling — próxima abertura da aba recarrega.

type DeliveryDto = { id: string; status: 'queued' | 'sent' | 'failed'; providerMessageId: string | null; error: string | null; sentAt: string };

function DocSendButton({ kind, docId }: { kind: 'prescription' | 'certificate'; docId: string }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<DeliveryDto | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadHistory = async () => {
    const r = await apiFetch(`/api/clinic/documents/${kind}/${docId}/deliveries`);
    const list: DeliveryDto[] = await r.json().catch(() => []);
    setLast(Array.isArray(list) && list.length ? list[0] : null);
    setLoaded(true);
  };
  useEffect(() => { loadHistory(); /* eslint-disable-next-line */ }, [kind, docId]);

  const send = async () => {
    if (!(await confirmDialog(kind === 'prescription' ? 'Enviar receita por WhatsApp para o paciente?' : 'Enviar atestado por WhatsApp para o paciente?'))) return;
    setBusy(true);
    try {
      const path = kind === 'prescription' ? 'prescriptions' : 'certificates';
      const r = await apiFetch(`/api/clinic/${path}/${docId}/send`, { method: 'POST' });
      const out: any = await r.json().catch(() => ({}));
      if (r.status === 409 && (out?.code === 'LGPD_COMMS_CONSENT_REQUIRED' || out?.code === 'LGPD_CONSENT_REQUIRED')) {
        toast.error(out?.error || 'Consentimento LGPD necessário — abra a Ficha do paciente e registre.');
        return;
      }
      if (!r.ok) { toast.error(out?.error || 'Falha ao enviar.'); return; }
      // status pode ser 'sent' ou 'failed' — o service não relança falha do provider.
      setLast(out);
      if (out?.status === 'sent') toast.success('Enviado por WhatsApp.');
      else if (out?.status === 'failed') toast.error(`Falha ao enviar: ${out?.error || 'provider indisponível'}`);
    } finally { setBusy(false); }
  };

  const badge = loaded && last && (
    <span className={`text-[10px] rounded-full px-1.5 inline-flex items-center gap-1 border ${
      last.status === 'sent' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
        : last.status === 'failed' ? 'bg-red-500/15 text-red-300 border-red-500/30'
          : 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30'
    }`} title={`Última tentativa: ${new Date(last.sentAt).toLocaleString('pt-BR')}${last.error ? ` — ${last.error}` : ''}`}>
      {last.status === 'sent' ? 'enviado' : last.status === 'failed' ? 'falhou' : 'enfileirado'}
    </span>
  );

  return (
    <>
      <button onClick={send} disabled={busy} className="text-[11px] px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center gap-1 disabled:opacity-60" title="Enviar por WhatsApp">
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} {last?.status === 'sent' ? 'Reenviar' : 'WhatsApp'}
      </button>
      {badge}
    </>
  );
}

function EncounterDocsPanel({ encounterId }: { encounterId: string }) {
  const [loading, setLoading] = useState(true);
  const [prescriptions, setPrescriptions] = useState<PrescriptionDto[]>([]);
  const [certificates, setCertificates] = useState<CertificateDto[]>([]);
  const [showRx, setShowRx] = useState(false);
  const [showCert, setShowCert] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/encounters/${encounterId}/documents`);
      const d = await r.json().catch(() => ({}));
      setPrescriptions(d?.prescriptions || []);
      setCertificates(d?.certificates || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [encounterId]);

  const issue = async (kind: 'prescriptions' | 'certificates', id: string) => {
    if (!(await confirmDialog(kind === 'prescriptions' ? 'Emitir receita? Depois disso ela vira imutável.' : 'Emitir atestado? Depois disso ele vira imutável.'))) return;
    setBusyId(id);
    try {
      const r = await apiFetch(`/api/clinic/${kind}/${id}/issue`, { method: 'POST' });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(out?.error || 'Falha ao emitir.'); return; }
      toast.success('Emitido.');
      await load();
    } finally { setBusyId(''); }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        <button onClick={() => setShowRx(true)} className="text-[11px] px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white inline-flex items-center gap-1">
          <Plus className="w-3 h-3" /> Nova receita
        </button>
        <button onClick={() => setShowCert(true)} className="text-[11px] px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 inline-flex items-center gap-1">
          <Plus className="w-3 h-3" /> Novo atestado
        </button>
      </div>

      {loading && <div className="text-xs text-zinc-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Carregando…</div>}

      {!loading && prescriptions.length === 0 && certificates.length === 0 && (
        <div className="text-xs text-zinc-500 py-4">Nenhum documento emitido nesta consulta.</div>
      )}

      {prescriptions.map((rx) => (
        <div key={rx.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 mb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-zinc-100 inline-flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-indigo-300" /> Receita — {rx.items.length} item(ns)
              {rx.status === 'issued' ? (
                <span className="ml-1 text-[10px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1.5 inline-flex items-center gap-1"><Lock className="w-3 h-3" /> emitida</span>
              ) : (
                <span className="ml-1 text-[10px] rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5">rascunho</span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {rx.status === 'draft' && (
                <button onClick={() => issue('prescriptions', rx.id)} disabled={busyId === rx.id} className="text-[11px] px-2 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
                  {busyId === rx.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />} Emitir
                </button>
              )}
              <button onClick={() => downloadPdf(`/api/clinic/prescriptions/${rx.id}/pdf`, `receita-${rx.id}.pdf`)} className="text-[11px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1">
                <Download className="w-3 h-3" /> PDF
              </button>
              {rx.status === 'issued' && <DocSendButton kind="prescription" docId={rx.id} />}
            </div>
          </div>
          <ul className="mt-2 text-[11px] text-zinc-400 space-y-0.5">
            {rx.items.map((it, i) => (
              <li key={i}>• <span className="text-zinc-200">{it.drug}</span>{it.dosage ? ` — ${it.dosage}` : ''}{it.quantity ? ` — ${it.quantity}` : ''}{it.instructions ? ` · ${it.instructions}` : ''}</li>
            ))}
          </ul>
          {(rx.repeatsAllowed > 0 || rx.validUntil) && (
            <div className="mt-1 text-[10px] text-zinc-500">
              {rx.repeatsAllowed > 0 && `Uso continuado (${rx.repeatsAllowed}× repetição). `}
              {rx.validUntil && `Válida até ${new Date(rx.validUntil).toLocaleDateString('pt-BR')}.`}
            </div>
          )}
        </div>
      ))}

      {certificates.map((c) => (
        <div key={c.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 mb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-zinc-100 inline-flex items-center gap-1.5">
              <FileCheck2 className="w-3.5 h-3.5 text-emerald-300" /> Atestado — {c.days} dia(s)
              {c.status === 'issued' ? (
                <span className="ml-1 text-[10px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1.5 inline-flex items-center gap-1"><Lock className="w-3 h-3" /> emitido</span>
              ) : (
                <span className="ml-1 text-[10px] rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5">rascunho</span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {c.status === 'draft' && (
                <button onClick={() => issue('certificates', c.id)} disabled={busyId === c.id} className="text-[11px] px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
                  {busyId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lock className="w-3 h-3" />} Emitir
                </button>
              )}
              <button onClick={() => downloadPdf(`/api/clinic/certificates/${c.id}/pdf`, `atestado-${c.id}.pdf`)} className="text-[11px] px-2 py-1 rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1">
                <Download className="w-3 h-3" /> PDF
              </button>
              {c.status === 'issued' && <DocSendButton kind="certificate" docId={c.id} />}
            </div>
          </div>
          {c.cid && <div className="mt-1 text-[11px] text-zinc-300">CID: <span className="font-mono">{c.cid}</span>{c.cidDescription ? ` · ${c.cidDescription}` : ''}</div>}
          {c.notes && <div className="mt-1 text-[11px] text-zinc-400">{c.notes}</div>}
        </div>
      ))}

      {showRx && <NewPrescriptionModal encounterId={encounterId} onClose={() => setShowRx(false)} onCreated={() => { setShowRx(false); load(); }} />}
      {showCert && <NewCertificateModal encounterId={encounterId} onClose={() => setShowCert(false)} onCreated={() => { setShowCert(false); load(); }} />}
    </div>
  );
}

function NewPrescriptionModal({ encounterId, onClose, onCreated }: { encounterId: string; onClose: () => void; onCreated: () => void }) {
  const [items, setItems] = useState<PrescriptionItemDto[]>([{ drug: '', dosage: '', quantity: '', instructions: '', tarja: '' }]);
  const [headerNotes, setHeaderNotes] = useState('');
  const [repeats, setRepeats] = useState<number>(0);
  const [validUntil, setValidUntil] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const setItem = (i: number, patch: Partial<PrescriptionItemDto>) => setItems(arr => arr.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  const addItem = () => setItems(arr => [...arr, { drug: '', dosage: '', quantity: '', instructions: '', tarja: '' }]);
  const rmItem = (i: number) => setItems(arr => arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr);

  const submit = async () => {
    const clean = items.filter(i => i.drug.trim());
    if (!clean.length) { toast.error('Adicione ao menos 1 item com nome do medicamento.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/encounters/${encounterId}/prescriptions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: clean, headerNotes: headerNotes || null, repeatsAllowed: repeats, validUntil: validUntil || null }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(out?.error || 'Falha ao criar receita.'); return; }
      toast.success('Receita criada. Emita quando estiver pronta.');
      onCreated();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-900 p-5 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100 inline-flex items-center gap-2"><FileText className="w-4 h-4 text-indigo-300" /> Nova receita</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>

        <label className="text-[11px] text-zinc-400 mt-3 block">Observações no topo (opcional)</label>
        <input value={headerNotes} onChange={e => setHeaderNotes(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" placeholder="Uso conforme prescrição" />

        <div className="mt-3 space-y-2">
          {items.map((it, i) => (
            <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950 p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-zinc-500">Item {i + 1}</span>
                {items.length > 1 && (
                  <button onClick={() => rmItem(i)} className="text-[11px] text-red-300 hover:text-red-200 inline-flex items-center gap-1"><Trash2 className="w-3 h-3" /> Remover</button>
                )}
              </div>
              <input value={it.drug} onChange={e => setItem(i, { drug: e.target.value })} placeholder="Medicamento (ex.: Amoxicilina 500mg)"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100 mb-1" />
              <div className="grid grid-cols-2 gap-1">
                <input value={it.dosage || ''} onChange={e => setItem(i, { dosage: e.target.value })} placeholder="Dose (ex.: 1 cápsula)" className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100" />
                <input value={it.quantity || ''} onChange={e => setItem(i, { quantity: e.target.value })} placeholder="Qtde (ex.: 21 cápsulas)" className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100" />
              </div>
              <input value={it.instructions || ''} onChange={e => setItem(i, { instructions: e.target.value })} placeholder="Posologia (ex.: 1 cápsula de 8/8h por 7 dias)"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100 mt-1" />
              <input value={it.tarja || ''} onChange={e => setItem(i, { tarja: e.target.value })} placeholder="Tarja (opcional — livre / vermelha / preta)"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100 mt-1" />
            </div>
          ))}
          <button onClick={addItem} className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1"><Plus className="w-3 h-3" /> Adicionar item</button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-zinc-400 block">Repetições permitidas</label>
            <input type="number" min={0} value={repeats} onChange={e => setRepeats(Math.max(0, Number(e.target.value) || 0))} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100" />
          </div>
          <div>
            <label className="text-[11px] text-zinc-400 block">Válida até (opcional)</label>
            <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100" />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={submit} disabled={busy} className="text-xs px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Salvar rascunho
          </button>
        </div>
      </div>
    </div>
  );
}

function NewCertificateModal({ encounterId, onClose, onCreated }: { encounterId: string; onClose: () => void; onCreated: () => void }) {
  const [days, setDays] = useState<number>(1);
  const [cid, setCid] = useState('');
  const [cidDescription, setCidDescription] = useState('');
  const [purpose, setPurpose] = useState<'rest' | 'comparecimento' | 'other'>('rest');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!(days >= 1)) { toast.error('Informe ao menos 1 dia.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/encounters/${encounterId}/certificates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, cid: cid || null, cidDescription: cidDescription || null, purpose, notes: notes || null }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(out?.error || 'Falha ao criar atestado.'); return; }
      toast.success('Atestado criado. Emita quando estiver pronto.');
      onCreated();
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100 inline-flex items-center gap-2"><FileCheck2 className="w-4 h-4 text-emerald-300" /> Novo atestado</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-zinc-400 block">Dias de afastamento</label>
            <input type="number" min={1} value={days} onChange={e => setDays(Math.max(1, Number(e.target.value) || 1))} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100" />
          </div>
          <div>
            <label className="text-[11px] text-zinc-400 block">Motivo</label>
            <select value={purpose} onChange={e => setPurpose(e.target.value as any)} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100">
              <option value="rest">Afastamento (repouso)</option>
              <option value="comparecimento">Comparecimento à consulta</option>
              <option value="other">Outro</option>
            </select>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] text-zinc-400 block">CID-10 (opcional)</label>
            <input value={cid} onChange={e => setCid(e.target.value.toUpperCase())} placeholder="Ex.: J06.9" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100 font-mono" />
          </div>
          <div>
            <label className="text-[11px] text-zinc-400 block">Descrição do CID (opcional)</label>
            <input value={cidDescription} onChange={e => setCidDescription(e.target.value)} placeholder="Ex.: Infecção aguda das vias aéreas" className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100" />
          </div>
        </div>

        <label className="text-[11px] text-zinc-400 mt-3 block">Observações (opcional)</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100" placeholder="Repouso relativo, reavaliar em 5 dias…" />

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={submit} disabled={busy} className="text-xs px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Salvar rascunho
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Retorno em 1 clique (ADR-080 Fase I) ---------------------------------
// Bloco embutido no rodapé do EncounterModal: profissional marca "voltar em
// X dias" (intenção clínica, permanece editável mesmo pós-signed); botão
// "Agendar retorno" cria appointment novo herdando profissional/duração e
// vira parent-child rastreado por parent_appointment_id.

function FollowUpBlock({ encounter, onChanged }: { encounter: Encounter; onChanged: (next: Encounter) => void }) {
  const [days, setDays] = useState<string>(encounter.followUpRecommendedDays ? String(encounter.followUpRecommendedDays) : '');
  const [busy, setBusy] = useState<'save' | 'schedule' | ''>('');
  const [scheduledId, setScheduledId] = useState<string>('');

  useEffect(() => { setDays(encounter.followUpRecommendedDays ? String(encounter.followUpRecommendedDays) : ''); }, [encounter.followUpRecommendedDays]);

  const saveRec = async () => {
    setBusy('save');
    try {
      const parsed = days.trim() === '' ? null : Math.floor(Number(days));
      if (parsed !== null && (!Number.isFinite(parsed) || parsed < 1)) { toast.error('Informe ao menos 1 dia (ou deixe em branco pra limpar).'); return; }
      const r = await apiFetch(`/api/clinic/encounters/${encounter.id}/follow-up-recommendation`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: parsed }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(out?.error || 'Falha ao salvar recomendação.'); return; }
      onChanged(out);
      toast.success(parsed ? `Retorno recomendado em ${parsed} dias.` : 'Recomendação removida.');
    } finally { setBusy(''); }
  };

  const schedule = async () => {
    const parsed = days.trim() === '' ? (encounter.followUpRecommendedDays || 0) : Math.floor(Number(days));
    if (!parsed || parsed < 1) { toast.error('Defina em quantos dias primeiro.'); return; }
    if (!(await confirmDialog(`Agendar retorno em ${parsed} dias no mesmo profissional?`))) return;
    setBusy('schedule');
    try {
      const r = await apiFetch(`/api/clinic/appointments/${encounter.appointmentId}/follow-up`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inDays: parsed }),
      });
      const out = await r.json().catch(() => ({}));
      if (r.status === 409 && out?.code === 'CONFLICT') {
        const forceIt = await confirmDialog(`Conflito de horário: ${(out.conflicts || []).map((c: any) => c.title || 'agendamento').join(', ')}. Agendar mesmo assim?`);
        if (!forceIt) return;
        const r2 = await apiFetch(`/api/clinic/appointments/${encounter.appointmentId}/follow-up`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inDays: parsed, force: true }),
        });
        const out2 = await r2.json().catch(() => ({}));
        if (!r2.ok) { toast.error(out2?.error || 'Falha ao agendar retorno.'); return; }
        setScheduledId(out2.id);
        toast.success('Retorno agendado (com override de conflito).');
        return;
      }
      if (!r.ok) { toast.error(out?.error || 'Falha ao agendar retorno.'); return; }
      setScheduledId(out.id);
      const dt = new Date(out.scheduled_start).toLocaleString('pt-BR');
      toast.success(`Retorno agendado para ${dt}.`);
    } finally { setBusy(''); }
  };

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center gap-2 mb-2">
        <RotateCcw className="w-4 h-4 text-indigo-300" />
        <span className="text-xs font-medium text-zinc-100">Retorno</span>
        <span className="text-[10px] text-zinc-500">Recomendação clínica + agendamento em 1 clique</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-zinc-400">Voltar em</label>
        <input type="number" min={1} value={days} onChange={e => setDays(e.target.value)}
          className="w-16 bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100" placeholder="15" />
        <span className="text-[11px] text-zinc-400">dias</span>
        <button onClick={saveRec} disabled={busy !== ''} className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1 disabled:opacity-60">
          {busy === 'save' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Salvar
        </button>
        <button onClick={schedule} disabled={busy !== '' || !!scheduledId} className="text-[11px] px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
          {busy === 'schedule' ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarPlus className="w-3 h-3" />} Agendar retorno
        </button>
        {scheduledId && (
          <span className="text-[10px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1.5 inline-flex items-center gap-1">
            <Check className="w-3 h-3" /> retorno agendado
          </span>
        )}
      </div>
      <p className="text-[10px] text-zinc-500 mt-1">A recomendação fica na fila de retornos até que o retorno seja agendado. Editável mesmo depois de assinar o prontuário.</p>
    </div>
  );
}

// ---- Anexos ao prontuário (ADR-080 Fase J) --------------------------------
// Upload multipart via FormData (padrão radar.ts / RadarView.tsx). Download
// autenticado (Bearer) — imagens viram blob URL pra `<img>`; PDFs abrem em
// nova aba via blob. Delete só quando encounter=draft (bloqueio no server
// também: ATTACHMENT_FROZEN → 409).

type AttachmentDto = {
  id: string; encounterId: string; kind: 'image' | 'pdf' | 'other';
  mimeType: string; originalFilename: string | null; label: string | null;
  storageKey: string; sizeBytes: number; uploadedAt: string;
  shareWithPatient: boolean;
};

function AttachmentThumb({ att }: { att: AttachmentDto }) {
  const [url, setUrl] = useState<string>('');
  useEffect(() => {
    let mounted = true;
    let objectUrl = '';
    (async () => {
      const r = await apiFetch(`/api/clinic/attachments/${att.id}/download`);
      if (!r.ok || !mounted) return;
      const blob = await r.blob();
      objectUrl = URL.createObjectURL(blob);
      if (mounted) setUrl(objectUrl);
    })();
    return () => { mounted = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [att.id]);
  if (att.kind !== 'image') return null;
  if (!url) return <div className="w-24 h-24 rounded bg-zinc-900 border border-zinc-800 animate-pulse" />;
  return <img src={url} alt={att.label || att.originalFilename || 'anexo'} className="w-24 h-24 rounded object-cover border border-zinc-800" />;
}

function EncounterAttachmentsPanel({ encounterId, isSigned }: { encounterId: string; isSigned: boolean }) {
  const [items, setItems] = useState<AttachmentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [label, setLabel] = useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/encounters/${encounterId}/attachments`);
      const d = await r.json().catch(() => []);
      setItems(Array.isArray(d) ? d : []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [encounterId]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (label.trim()) fd.append('label', label.trim());
      const r = await apiFetch(`/api/clinic/encounters/${encounterId}/attachments`, { method: 'POST', body: fd });
      const out = await r.json().catch(() => ({}));
      if (r.status === 409 && out?.code === 'LGPD_CONSENT_REQUIRED') {
        toast.error('Consentimento LGPD sensível necessário — abra o prontuário e confirme antes.');
        return;
      }
      if (!r.ok) { toast.error(out?.error || 'Falha no upload.'); return; }
      toast.success('Anexo adicionado.');
      setLabel('');
      if (inputRef.current) inputRef.current.value = '';
      await load();
    } finally { setUploading(false); }
  };

  const toggleShare = async (att: AttachmentDto, share: boolean) => {
    // Otimista: já reflete no UI, reverte em caso de erro.
    setItems(arr => arr.map(a => a.id === att.id ? { ...a, shareWithPatient: share } : a));
    const r = await apiFetch(`/api/clinic/attachments/${att.id}/share`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ share }),
    });
    if (!r.ok) {
      toast.error('Falha ao atualizar visibilidade no portal.');
      setItems(arr => arr.map(a => a.id === att.id ? { ...a, shareWithPatient: !share } : a));
    } else {
      toast.success(share ? 'Anexo compartilhado no portal.' : 'Removido do portal.');
    }
  };

  const remove = async (att: AttachmentDto) => {
    if (!(await confirmDialog(`Remover "${att.label || att.originalFilename || att.storageKey}"?`))) return;
    const r = await apiFetch(`/api/clinic/attachments/${att.id}`, { method: 'DELETE' });
    const out = await r.json().catch(() => ({}));
    if (r.status === 409 && out?.code === 'ATTACHMENT_FROZEN') {
      toast.error('Prontuário assinado — anexo não pode ser removido.');
      return;
    }
    if (!r.ok) { toast.error(out?.error || 'Falha ao remover.'); return; }
    toast.success('Anexo removido.');
    await load();
  };

  const openDownload = async (att: AttachmentDto) => {
    // Novo blob URL a cada clique (evita cache stale e revoga sozinho).
    const r = await apiFetch(`/api/clinic/attachments/${att.id}/download`);
    if (!r.ok) { toast.error('Não consegui abrir o anexo.'); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 mb-3">
        <div className="flex items-center gap-2 mb-2">
          <Upload className="w-4 h-4 text-indigo-300" />
          <span className="text-xs font-medium text-zinc-100">Adicionar anexo</span>
          <span className="text-[10px] text-zinc-500">PNG, JPG, WEBP ou PDF — até 15 MB</span>
        </div>
        <input
          type="text" value={label} onChange={e => setLabel(e.target.value)}
          placeholder="Rótulo (opcional — ex.: 'Raio-X pré-tratamento')"
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100 mb-2"
        />
        <input
          ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }}
          disabled={uploading}
          className="text-xs text-zinc-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-indigo-600 file:text-white hover:file:bg-indigo-500 disabled:opacity-60"
        />
        {uploading && <div className="mt-2 text-[11px] text-zinc-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Enviando…</div>}
      </div>

      {loading && <div className="text-xs text-zinc-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Carregando…</div>}
      {!loading && items.length === 0 && (
        <div className="text-xs text-zinc-500 py-4">Nenhum anexo. Adicione fotos de exame, PDFs de laudo, imagens antes/depois — ficam ligados a esta consulta.</div>
      )}

      <div className="space-y-2">
        {items.map((att) => (
          <div key={att.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-2">
            {att.kind === 'image' ? (
              <button onClick={() => openDownload(att)} className="shrink-0" title="Abrir em tamanho real">
                <AttachmentThumb att={att} />
              </button>
            ) : (
              <button onClick={() => openDownload(att)} className="w-24 h-24 shrink-0 rounded bg-zinc-900 border border-zinc-800 flex items-center justify-center hover:bg-zinc-800" title="Abrir PDF">
                <FileText className="w-8 h-8 text-zinc-400" />
              </button>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm text-zinc-100 truncate">{att.label || att.originalFilename || att.storageKey}</div>
              <div className="text-[11px] text-zinc-500">
                {att.kind === 'image' ? 'Imagem' : att.kind === 'pdf' ? 'PDF' : att.mimeType} · {Math.max(1, Math.round(att.sizeBytes / 1024))} KB · {new Date(att.uploadedAt).toLocaleString('pt-BR')}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] text-zinc-400 inline-flex items-center gap-1 cursor-pointer select-none" title="Compartilhar com o Portal do Paciente">
                <input type="checkbox" checked={att.shareWithPatient} onChange={(e) => toggleShare(att, e.target.checked)} className="accent-indigo-500" />
                Portal
              </label>
              <button onClick={() => openDownload(att)} className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1">
                <Download className="w-3 h-3" /> Abrir
              </button>
              {!isSigned && (
                <button onClick={() => remove(att)} className="text-[11px] px-2 py-1 rounded border border-red-500/30 text-red-300 hover:bg-red-500/10 inline-flex items-center gap-1">
                  <Trash2 className="w-3 h-3" /> Remover
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {isSigned && items.length > 0 && (
        <p className="mt-2 text-[10px] text-zinc-500 inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Prontuário assinado — anexos existentes ficam imutáveis (novos ainda podem ser adicionados).</p>
      )}
    </div>
  );
}

// ---- Indicadores da clínica (ADR-080 Fase O) -------------------------------
// Painel colapsável na Agenda. Chama /api/clinic/metrics apenas quando aberto
// (evita carregar dados que ninguém vai olhar). Cards visuais + linha por
// profissional. Zero chart heavy — só números + barras CSS.

type MetricsOverview = {
  window: { from: string; to: string; days: number };
  appointments: {
    total: number; past: number;
    byStatus: Record<string, number>;
    noShowRate: number; completedRate: number; patientConfirmedRate: number;
  };
  reminders: { sent: number; failed: number; replied: number; confirmationRate: number; cancellationRate: number };
  cancellations: { total: number; byOrigin: { patient: number; staff: number; system: number }; patientShare: number };
  documents: { prescriptionsIssued: number; certificatesIssued: number; sentByChannel: number };
  followUps: { recommended: number; scheduled: number; pending: number };
  professionals: { id: string; name: string; appointments: number; completed: number; cancelled: number; occupationMinutes: number }[];
};

function ClinicMetricsPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<MetricsOverview | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/clinic/metrics');
      setData(r.ok ? await r.json() : null);
    } finally { setLoading(false); }
  };
  useEffect(() => { if (open && !data) load(); /* eslint-disable-next-line */ }, [open]);

  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50 print:hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-5 py-3 text-left">
        <span className="text-sm font-medium text-zinc-100 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-emerald-300" /> Indicadores da clínica
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-zinc-800 pt-4">
          {loading && <div className="text-xs text-zinc-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Calculando…</div>}
          {!loading && !data && <div className="text-xs text-zinc-500">Sem dados no período.</div>}
          {!loading && data && <MetricsCards m={data} />}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'good' | 'bad' | 'neutral' }) {
  const toneCls = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-red-300' : 'text-zinc-100';
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${toneCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-zinc-500 mt-0.5">{hint}</div>}
    </div>
  );
}

function MetricsCards({ m }: { m: MetricsOverview }) {
  const noShowTone = m.appointments.noShowRate >= 20 ? 'bad' : m.appointments.noShowRate >= 10 ? 'neutral' : 'good';
  const confirmTone = m.reminders.confirmationRate >= 60 ? 'good' : m.reminders.confirmationRate >= 30 ? 'neutral' : 'bad';
  const days = m.window.days;

  return (
    <div>
      <div className="text-[11px] text-zinc-500 mb-3 inline-flex items-center gap-1">
        <Clock className="w-3 h-3" /> Janela: últimos {days} dias ({new Date(m.window.from).toLocaleDateString('pt-BR')} → {new Date(m.window.to).toLocaleDateString('pt-BR')})
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <StatCard label="Consultas" value={String(m.appointments.total)} hint={`${m.appointments.past} já passaram`} />
        <StatCard label="No-show" value={`${m.appointments.noShowRate}%`} hint={`base: ${m.appointments.past} passadas`} tone={noShowTone} />
        <StatCard label="Concluídas" value={`${m.appointments.completedRate}%`} hint={`${m.appointments.byStatus['completed'] || 0} completed`} tone="good" />
        <StatCard label="Confirmadas pelo paciente" value={`${m.appointments.patientConfirmedRate}%`} hint="do total agendado" />
      </div>

      <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><Bell className="w-3 h-3" /> Lembretes automáticos</h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <StatCard label="Enviados" value={String(m.reminders.sent)} hint={m.reminders.failed ? `${m.reminders.failed} falharam` : 'nenhuma falha'} tone={m.reminders.failed ? 'bad' : 'neutral'} />
        <StatCard label="Respondidos" value={String(m.reminders.replied)} hint={`${m.reminders.confirmationRate + m.reminders.cancellationRate}% de resposta`} />
        <StatCard label="Confirmação SIM" value={`${m.reminders.confirmationRate}%`} tone={confirmTone} />
        <StatCard label="Cancelamento NÃO" value={`${m.reminders.cancellationRate}%`} tone="neutral" />
      </div>

      <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><Ban className="w-3 h-3" /> Cancelamentos ({m.cancellations.total})</h4>
      <div className="grid grid-cols-3 gap-2 mb-4">
        <StatCard label="Pelo paciente" value={String(m.cancellations.byOrigin.patient)} hint={`${m.cancellations.patientShare}% do total`} tone="neutral" />
        <StatCard label="Pela equipe" value={String(m.cancellations.byOrigin.staff)} />
        <StatCard label="Pelo sistema" value={String(m.cancellations.byOrigin.system)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><FileText className="w-3 h-3" /> Documentos emitidos</h4>
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Receitas" value={String(m.documents.prescriptionsIssued)} />
            <StatCard label="Atestados" value={String(m.documents.certificatesIssued)} />
            <StatCard label="Enviados por canal" value={String(m.documents.sentByChannel)} />
          </div>
        </div>
        <div>
          <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Retornos</h4>
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="Recomendados" value={String(m.followUps.recommended)} />
            <StatCard label="Agendados" value={String(m.followUps.scheduled)} tone="good" />
            <StatCard label="Pendentes" value={String(m.followUps.pending)} tone={m.followUps.pending > 0 ? 'bad' : 'good'} hint="fila de retornos" />
          </div>
        </div>
      </div>

      {m.professionals.length > 0 && (
        <>
          <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><User className="w-3 h-3" /> Ocupação por profissional</h4>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800">
            {m.professionals.map((p) => {
              const hours = Math.round(p.occupationMinutes / 60 * 10) / 10;
              const cancRate = p.appointments > 0 ? Math.round((p.cancelled / p.appointments) * 100) : 0;
              return (
                <div key={p.id || p.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="flex-1 min-w-0 text-zinc-100 truncate">{p.name}</div>
                  <div className="text-[11px] text-zinc-400 tabular-nums">{p.appointments} consultas</div>
                  <div className="text-[11px] text-zinc-500 tabular-nums">{hours}h</div>
                  <div className="text-[11px] text-emerald-300 tabular-nums">{p.completed} feitas</div>
                  <div className={`text-[11px] tabular-nums ${cancRate >= 25 ? 'text-red-300' : 'text-zinc-500'}`}>{p.cancelled} canc ({cancRate}%)</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Fila de retornos pendentes (painel colapsável na Agenda) --------------
function FollowUpQueuePanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/clinic/follow-up-queue');
      const d = await r.json().catch(() => []);
      setItems(Array.isArray(d) ? d : []);
    } finally { setLoading(false); }
  };
  useEffect(() => { if (open) load(); }, [open]);

  const schedule = async (item: any) => {
    if (!(await confirmDialog(`Agendar retorno de ${item.patientName} em ${item.recommendedDays} dias?`))) return;
    setBusyId(item.encounterId);
    try {
      const r = await apiFetch(`/api/clinic/appointments/${item.sourceAppointmentId}/follow-up`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inDays: item.recommendedDays }),
      });
      const out = await r.json().catch(() => ({}));
      if (r.status === 409 && out?.code === 'CONFLICT') {
        const forceIt = await confirmDialog(`Conflito: ${(out.conflicts || []).map((c: any) => c.title || 'agendamento').join(', ')}. Agendar mesmo assim?`);
        if (!forceIt) return;
        const r2 = await apiFetch(`/api/clinic/appointments/${item.sourceAppointmentId}/follow-up`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inDays: item.recommendedDays, force: true }),
        });
        if (!r2.ok) { const o = await r2.json().catch(() => ({})); toast.error(o?.error || 'Falha ao agendar.'); return; }
        toast.success('Retorno agendado (com override).');
      } else if (!r.ok) {
        toast.error(out?.error || 'Falha ao agendar retorno.');
        return;
      } else {
        toast.success('Retorno agendado.');
      }
      await load();
    } finally { setBusyId(''); }
  };

  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50 print:hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-5 py-3 text-left">
        <span className="text-sm font-medium text-zinc-100 flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-indigo-300" /> Fila de retornos
          {items.length > 0 && (
            <span className="text-[10px] rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 px-1.5">{items.length}</span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
      </button>
      {open && (
        <div className="px-5 pb-4 border-t border-zinc-800 pt-3">
          {loading && <div className="text-xs text-zinc-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Carregando…</div>}
          {!loading && items.length === 0 && (
            <div className="text-xs text-zinc-500">Nenhum retorno pendente na fila. Quando o profissional marcar "voltar em X dias" no prontuário, o paciente aparece aqui pra confirmação.</div>
          )}
          {!loading && items.map((it) => (
            <div key={it.encounterId} className="flex items-center justify-between gap-3 py-2 border-b border-zinc-800 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-zinc-100 truncate">{it.patientName}</div>
                <div className="text-[11px] text-zinc-500">
                  {it.professionalName ? `com ${it.professionalName} · ` : ''}
                  sugerido para {new Date(it.suggestedAt).toLocaleDateString('pt-BR')} ({it.recommendedDays} dias)
                </div>
              </div>
              <button onClick={() => schedule(it)} disabled={busyId === it.encounterId} className="text-[11px] px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white inline-flex items-center gap-1 disabled:opacity-60">
                {busyId === it.encounterId ? <Loader2 className="w-3 h-3 animate-spin" /> : <CalendarPlus className="w-3 h-3" />} Agendar
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
