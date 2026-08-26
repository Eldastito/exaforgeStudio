import React, { useEffect, useMemo, useState, useCallback, Suspense } from 'react';

// ADR-146 F51: aba de especialidades entra como shell lazy. Mantém o
// bundle inicial da Agenda enxuto — o painel novo só baixa quando o
// usuário clica na aba. Padrão da ADR-146 D1 (extração incremental, sem
// reescrever este arquivo).
const SpecialtiesPanel = React.lazy(() => import('./clinic/specialties/SpecialtiesPanel'));

// ADR-146 F52: episódios de cuidado + alta/reopen com PIN. Também
// lazy — o painel puxa modais e o PinConfirmModal shared. Fica em
// chunk separado do agenda inicial.
const CareEpisodePanel = React.lazy(() => import('./clinic/care-episodes/CareEpisodePanel'));

// ADR-146 F53: ciclos + fila de renovação + sinais F47. Também lazy.
const TreatmentCyclePanel = React.lazy(() => import('./clinic/treatment-cycles/TreatmentCyclePanel'));

// ADR-146 F54: sessões em grupo (multi-paciente na mesma agenda) +
// AvailabilitySuggestions (IA F47). Também lazy.
const GroupSessionPanel = React.lazy(() => import('./clinic/group-sessions/GroupSessionPanel'));

// ADR-146 F55: guias polimorfas (TISS/encaminhamento/pedido médico) +
// GuideDraftButton (IA F48 com missing:true). Também lazy.
const GuidesPanel = React.lazy(() => import('./clinic/guides/GuidesPanel'));

// ADR-180 F4b: UI da Agenda Federada (rede de especialistas). Lazy — só carrega
// quando o operador abre a aba. Self-gated pela flag `professional_network_enabled`.
const ProfessionalNetworkPanel = React.lazy(() => import('./clinic/network/ProfessionalNetworkPanel'));

// ADR-146 F56: header de métricas F40 + badges nas abas. NÃO lazy —
// aparece imediatamente ao abrir a Clínica e alimenta os badges das
// tabs (que precisam do count antes de qualquer aba ser clicada).
// Bundle pequeno (~2KB gzip) sem dependências pesadas.
import JourneyMetricsHeader, { useJourneyCounts, TabBadge } from './clinic/journey/JourneyMetricsHeader';
import { Stethoscope, Plus, X, Clock, User, DoorOpen, ShieldCheck, Timer, LogIn, Play, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Loader2, MoreHorizontal, Printer, Download, Link2, Copy, Check, Ban, FileCheck2, Send, Building2, Info, ListChecks, KeyRound, Plug, Gauge, Award, ClipboardList, Lock, FileText, Trash2, CalendarPlus, RotateCcw, Paperclip, Image as ImageIcon, Upload, Bell, BarChart3, TrendingDown, TrendingUp } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';
import { clinicTerms, type ClinicTerms } from '@/src/lib/clinicTerms';

// Vertical Petshop F2 — vocabulário da vertical (pet/tutor × paciente/responsável).
// Hook fino: lê a vertical do store e devolve os rótulos. Não muda comportamento.
function useClinicTerms(): ClinicTerms {
  const vertical = useStore((s) => s.vertical);
  return clinicTerms(vertical);
}

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
  needs_manual_confirmation?: number | boolean | null;
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

// ADR-146 F56: barra de tabs com badges numéricos.
// Extraída pra poder chamar useJourneyCounts sem carregá-lo no
// componente principal (isola o re-render por refresh a 60s).
// Badges âmbar sinalizam trabalho pendente (RN-014: sinalizar, não
// decidir por conta própria — a decisão é do humano na aba).
type ClinicTab = 'agenda' | 'pets' | 'grooming' | 'especialidades' | 'rede' | 'episodios' | 'ciclos' | 'grupos' | 'guias' | 'autorizacoes' | 'conexao';
function ClinicTabsBar({ tab, setTab }: { tab: ClinicTab; setTab: (t: ClinicTab) => void }) {
  const { counts } = useJourneyCounts();
  const terms = useClinicTerms();
  const badgeFor = (id: ClinicTab): { n: number; hi: boolean } | null => {
    if (!counts) return null;
    if (id === 'episodios') return { n: counts.withoutSchedule, hi: true };
    if (id === 'ciclos')    return { n: counts.renewalDue,      hi: true };
    return null;
  };
  const items: Array<[ClinicTab, string]> = [
    ['agenda', 'Agenda'],
    // Petshop F3b/F4b: abas Pets e Banho & Tosa só na vertical petshop.
    ...(terms.isPet ? [['pets', 'Pets'] as [ClinicTab, string], ['grooming', 'Banho & Tosa'] as [ClinicTab, string]] : []),
    ['episodios', 'Episódios'],
    ['ciclos', 'Ciclos'],
    ['grupos', 'Grupos'],
    ['guias', 'Guias'],
    ['especialidades', 'Especialidades'],
    ['rede', 'Rede'],
    ['autorizacoes', 'Autorizações'],
    ['conexao', 'Conexão'],
  ];
  return (
    <div className="mb-5 flex items-center gap-1 border-b border-zinc-800 print:hidden overflow-x-auto">
      {items.map(([id, label]) => {
        const b = badgeFor(id);
        return (
          <button key={id} onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors whitespace-nowrap inline-flex items-center ${
              tab === id ? 'border-emerald-500 text-emerald-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}>
            {label}
            {b && <TabBadge n={b.n} highlight={b.hi} />}
          </button>
        );
      })}
    </div>
  );
}

export function ClinicAgendaView() {
  const terms = useClinicTerms();
  const [tab, setTab] = useState<'agenda' | 'especialidades' | 'rede' | 'episodios' | 'ciclos' | 'grupos' | 'guias' | 'autorizacoes' | 'conexao'>('agenda');
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
          <p className="text-zinc-400 text-sm mt-1">Fluxo do dia: chegada, atendimento e controle de permanência por {terms.patientLower}.</p>
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

      {/* ADR-146 F56: header operacional + badges nas abas.
          Aparece pra org com Jornada ativa; se não tem episódio, se auto-esconde. */}
      <JourneyMetricsHeader onNavigate={(t) => setTab(t)} />

      {/* Abas internas — badge numérico por aba vem do useJourneyCounts (F40 /counts) */}
      <ClinicTabsBar tab={tab} setTab={setTab} />

      {tab === 'pets' && <PetsTab contacts={contacts} />}
      {tab === 'grooming' && <GroomingTab contacts={contacts} professionals={professionals} />}
      {tab === 'autorizacoes' && <AuthorizationsTab contacts={contacts} />}

      {tab === 'conexao' && <ConnectionTab />}

      {tab === 'especialidades' && (
        <Suspense fallback={
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando especialidades…
          </div>
        }>
          <SpecialtiesPanel />
        </Suspense>
      )}

      {tab === 'rede' && (
        <Suspense fallback={
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando rede de especialistas…
          </div>
        }>
          <ProfessionalNetworkPanel contacts={contacts} />
        </Suspense>
      )}

      {tab === 'episodios' && (
        <Suspense fallback={
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando episódios de tratamento…
          </div>
        }>
          <CareEpisodePanel />
        </Suspense>
      )}

      {tab === 'ciclos' && (
        <Suspense fallback={
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando ciclos de tratamento…
          </div>
        }>
          <TreatmentCyclePanel />
        </Suspense>
      )}

      {tab === 'grupos' && (
        <Suspense fallback={
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando sessões de grupo…
          </div>
        }>
          <GroupSessionPanel />
        </Suspense>
      )}

      {tab === 'guias' && (
        <Suspense fallback={
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
            <Loader2 className="w-4 h-4 animate-spin" /> Carregando guias…
          </div>
        }>
          <GuidesPanel />
        </Suspense>
      )}

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
            {overCount === 1 ? `1 ${terms.patientLower} excedeu o tempo previsto.` : `${overCount} ${terms.patientPluralLower} excederam o tempo previsto.`}
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

      {/* Ofertas de vaga automáticas (ADR-080 Fase R) */}
      <VacancyOffersPanel />

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
  const terms = useClinicTerms();
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
            <h3 className="font-semibold text-zinc-100 truncate">{a.contact_name || terms.patient}</h3>
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
          <span className="text-[10px] rounded-full bg-emerald-500/20 text-emerald-200 border border-emerald-500/40 px-1.5 inline-flex items-center gap-1" title={`${terms.client} confirmou em ${new Date(a.patient_confirmed_at).toLocaleString('pt-BR')}`}>
            <Check className="w-3 h-3" /> confirmado pelo {terms.clientLower}
          </span>
        )}
        {a.cancelled_by === 'patient' && (
          <span className="text-[10px] rounded-full bg-red-500/15 text-red-300 border border-red-500/30 px-1.5 inline-flex items-center gap-1" title={`Cancelado pelo ${terms.clientLower} em ${a.cancelled_at ? new Date(a.cancelled_at).toLocaleString('pt-BR') : ''}`}>
            <Ban className="w-3 h-3" /> cancelado pelo {terms.clientLower}
          </span>
        )}
        {Number(a.needs_manual_confirmation) === 1 && !a.patient_confirmed_at && a.status !== 'cancelled' && a.status !== 'completed' && a.status !== 'no_show' && (
          <span className="text-[10px] rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5 inline-flex items-center gap-1" title={`${terms.client} não confirmou nos lembretes automáticos — recepção precisa ligar ou liberar a vaga.`}>
            <AlertTriangle className="w-3 h-3" /> aguarda confirmação
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
  const terms = useClinicTerms();
  const [contactId, setContactId] = useState('');
  const [title, setTitle] = useState('');
  const [scheduledStart, setScheduledStart] = useState(defaultDateTimeLocal(dateISO));
  const [professionalId, setProfessionalId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);

  const submit = async (force = false) => {
    if (!contactId) { toast.error(`Selecione o ${terms.patientLower}.`); return; }
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
              <label className="text-sm text-zinc-400 mb-1 block">{terms.patient}</label>
              <select required value={contactId} onChange={e => setContactId(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
                <option value="">Selecione um {terms.patientLower}</option>
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
// Aba: Banho & Tosa (Petshop F4b) — serviços + agendar + fila do dia
// ================================================================
const GROOM_STATUS: Record<string, { label: string; cls: string }> = {
  confirmed: { label: 'agendado', cls: 'text-zinc-300 bg-zinc-500/10 border-zinc-700' },
  checked_in: { label: 'chegou', cls: 'text-sky-300 bg-sky-500/15 border-sky-500/30' },
  in_care: { label: 'em atendimento', cls: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
  completed: { label: 'concluído', cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' },
  no_show: { label: 'não veio', cls: 'text-red-300 bg-red-500/15 border-red-500/30' },
};
const groomStatusMeta = (s: string) => GROOM_STATUS[s] || { label: s, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700' };

function GroomingTab({ contacts, professionals }: { contacts: ContactLite[]; professionals: Professional[] }) {
  const [services, setServices] = useState<any[]>([]);
  const [date, setDate] = useState<string>(todayISO());
  const [queue, setQueue] = useState<any[]>([]);
  const [loadingQ, setLoadingQ] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const [showSvc, setShowSvc] = useState(false);
  const [returns, setReturns] = useState<any[]>([]);

  const loadServices = async () => {
    try { const r = await apiFetch('/api/clinic/grooming-services?all=1').then((x) => (x.ok ? x.json() : { services: [] })); setServices(Array.isArray(r?.services) ? r.services : []); } catch { /* noop */ }
  };
  const loadReturns = async () => {
    try { const r = await apiFetch('/api/clinic/grooming/returns/due').then((x) => (x.ok ? x.json() : { due: [] })); setReturns(Array.isArray(r?.due) ? r.due : []); } catch { setReturns([]); }
  };
  const loadQueue = async () => {
    setLoadingQ(true);
    try { const r = await apiFetch(`/api/clinic/grooming/queue?date=${date}`).then((x) => (x.ok ? x.json() : { queue: [] })); setQueue(Array.isArray(r?.queue) ? r.queue : []); } catch { setQueue([]); } finally { setLoadingQ(false); }
  };
  useEffect(() => { loadServices(); loadReturns(); }, []);
  useEffect(() => { loadQueue(); /* eslint-disable-next-line */ }, [date]);

  const activeServices = services.filter((s) => s.active);

  return (
    <div className="space-y-5">
      {/* Ações */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-zinc-400">Dia
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" />
        </label>
        <button onClick={() => setShowBook(true)} disabled={activeServices.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50" title={activeServices.length === 0 ? 'Cadastre um serviço primeiro' : ''}>
          <Plus className="w-4 h-4" /> Agendar banho & tosa
        </button>
        <button onClick={() => setShowSvc((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">
          <ListChecks className="w-4 h-4" /> Serviços ({activeServices.length})
        </button>
      </div>

      {/* Gestão de serviços (colapsável) */}
      {showSvc && <GroomingServicesPanel services={services} onChanged={loadServices} />}

      {/* Retornos previstos (Petshop F8) — recompra: quem está na hora de voltar */}
      {returns.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-sm font-medium text-amber-300 mb-2">🔔 Retornos previstos ({returns.length})</div>
          <div className="space-y-1.5">
            {returns.map((r) => (
              <div key={`${r.petId}:${r.serviceId}`} className="flex items-center gap-2 text-[12px]">
                <span className="text-zinc-100 font-medium truncate">{r.petName}</span>
                <span className="text-zinc-500 truncate">{r.serviceName}</span>
                <span className="text-zinc-500">último {r.lastGroomAt}</span>
                <span className={`ml-auto rounded-full border px-1.5 py-0.5 text-[10px] ${r.status === 'overdue' ? 'text-rose-300 border-rose-500/30 bg-rose-500/10' : 'text-amber-300 border-amber-500/30 bg-amber-500/10'}`}>
                  {r.status === 'overdue' ? 'atrasado' : 'a vencer'} · {r.nextDueAt}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">Derivado do último banho + intervalo do serviço. Some da lista quando o tutor reagenda.</p>
        </div>
      )}

      {/* Fila do dia */}
      <div>
        <div className="text-sm font-medium text-zinc-200 mb-2">Fila do dia</div>
        {loadingQ ? (
          <p className="text-sm text-zinc-500 inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</p>
        ) : queue.length === 0 ? (
          <p className="text-sm text-zinc-500">Nenhum banho & tosa agendado para este dia.</p>
        ) : (
          <div className="space-y-2">
            {queue.map((q) => {
              const st = groomStatusMeta(q.status);
              return (
                <div key={q.appointmentId} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 flex items-center gap-3">
                  <span className="text-lg">{q.species === 'gato' ? '🐱' : q.species === 'ave' ? '🐦' : '🐶'}</span>
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-100 truncate"><span className="font-medium">{q.serviceName || 'Serviço'}</span> — {q.petName || 'Pet'}</div>
                    <div className="text-[11px] text-zinc-500 truncate">{fmtTime(q.scheduledStart)} · tutor {q.tutorName || '—'}{q.professional ? ` · ${q.professional}` : ''}</div>
                  </div>
                  <span className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] ${st.cls}`}>{st.label}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] text-zinc-500">A chegada, o atendimento e o encerramento são feitos na aba <strong>Agenda</strong> (mesma fila da vez).</p>
      </div>

      {showBook && <BookGroomingModal contacts={contacts} professionals={professionals} services={activeServices} defaultDate={date}
        onClose={() => setShowBook(false)} onBooked={() => { setShowBook(false); loadQueue(); loadReturns(); }} />}
    </div>
  );
}

function GroomingServicesPanel({ services, onChanged }: { services: any[]; onChanged: () => void }) {
  const [form, setForm] = useState({ name: '', durationMin: '60', priceCents: '', recurrenceDays: '' });
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!form.name.trim()) { toast.error('Informe o nome do serviço.'); return; }
    setBusy(true);
    try {
      const body: any = { name: form.name.trim(), durationMin: form.durationMin ? Number(form.durationMin) : 60, priceCents: form.priceCents ? Math.round(Number(form.priceCents) * 100) : null, recurrenceDays: form.recurrenceDays ? Number(form.recurrenceDays) : null };
      const r = await apiFetch('/api/clinic/grooming-services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha');
      toast.success('Serviço criado.'); setForm({ name: '', durationMin: '60', priceCents: '', recurrenceDays: '' }); onChanged();
    } catch (e: any) { toast.error(e.message || 'Erro'); } finally { setBusy(false); }
  };
  const toggle = async (s: any) => {
    try { await apiFetch(`/api/clinic/grooming-services/${s.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !s.active }) }); onChanged(); }
    catch { toast.error('Erro ao atualizar'); }
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <input className="col-span-2 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="Serviço (ex.: Banho, Tosa)" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="Duração (min)" inputMode="numeric" value={form.durationMin} onChange={(e) => setForm((f) => ({ ...f, durationMin: e.target.value }))} />
        <input className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="Preço (R$)" inputMode="decimal" value={form.priceCents} onChange={(e) => setForm((f) => ({ ...f, priceCents: e.target.value }))} />
        <label className="col-span-2 sm:col-span-4 text-[11px] text-zinc-500">Retorno a cada (dias) — opcional, liga o lembrete de recompra
          <input className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="ex.: 30 (banho mensal)" inputMode="numeric" value={form.recurrenceDays} onChange={(e) => setForm((f) => ({ ...f, recurrenceDays: e.target.value }))} />
        </label>
      </div>
      <div className="flex justify-end"><button onClick={add} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"><Plus className="w-4 h-4" /> Adicionar serviço</button></div>
      {services.length > 0 && (
        <div className="space-y-1">
          {services.map((s) => (
            <div key={s.id} className="flex items-center gap-2 text-[13px]">
              <span className={`font-medium ${s.active ? 'text-zinc-100' : 'text-zinc-500 line-through'}`}>{s.name}</span>
              <span className="text-[11px] text-zinc-500">{s.durationMin} min{typeof s.priceCents === 'number' ? ` · R$ ${(s.priceCents / 100).toFixed(2)}` : ''}{s.recurrenceDays ? ` · retorno ${s.recurrenceDays}d` : ''}</span>
              <button onClick={() => toggle(s)} className="ml-auto text-[11px] text-zinc-400 hover:text-zinc-200">{s.active ? 'desativar' : 'ativar'}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BookGroomingModal({ contacts, professionals, services, defaultDate, onClose, onBooked }: { contacts: ContactLite[]; professionals: Professional[]; services: any[]; defaultDate: string; onClose: () => void; onBooked: () => void }) {
  const terms = useClinicTerms();
  const [tutorId, setTutorId] = useState('');
  const [pets, setPets] = useState<any[]>([]);
  const [petId, setPetId] = useState('');
  const [serviceId, setServiceId] = useState(services[0]?.id || '');
  const [professionalId, setProfessionalId] = useState('');
  const [start, setStart] = useState(defaultDateTimeLocal(defaultDate));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tutorId) { setPets([]); setPetId(''); return; }
    apiFetch(`/api/clinic/pets?tutor=${encodeURIComponent(tutorId)}`).then((r) => (r.ok ? r.json() : { pets: [] })).then((d) => setPets(Array.isArray(d?.pets) ? d.pets : [])).catch(() => setPets([]));
  }, [tutorId]);

  const book = async () => {
    if (!petId) { toast.error(`Selecione o ${terms.patientLower}.`); return; }
    if (!serviceId) { toast.error('Selecione o serviço.'); return; }
    if (!start) { toast.error('Informe a data e hora.'); return; }
    setBusy(true);
    try {
      const body: any = { petId, groomingServiceId: serviceId, scheduledStart: new Date(start).toISOString(), professionalId: professionalId || undefined };
      const r = await apiFetch('/api/clinic/grooming/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha ao agendar');
      toast.success('Banho & tosa agendado.'); onBooked();
    } catch (e: any) { toast.error(e.message || 'Erro'); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">Agendar banho & tosa</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{terms.guardian}</label>
            <select value={tutorId} onChange={(e) => setTutorId(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100">
              <option value="">Selecione o {terms.guardianLower}…</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` — ${c.identifier}` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">{terms.patient}</label>
            <select value={petId} onChange={(e) => setPetId(e.target.value)} disabled={!tutorId} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 disabled:opacity-50">
              <option value="">{tutorId ? `Selecione o ${terms.patientLower}…` : `Escolha o ${terms.guardianLower} primeiro`}</option>
              {pets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Serviço</label>
            <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100">
              {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMin} min)</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Profissional (opcional)</label>
            <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100">
              <option value="">—</option>
              {professionals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm text-zinc-400 mb-1 block">Data e hora</label>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={book} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"><Plus className="w-4 h-4" /> {busy ? 'Agendando…' : 'Agendar'}</button>
        </div>
      </div>
    </div>
  );
}

// ================================================================
// Aba: Pets (Petshop F3b) — ficha do pet + carteira de vacinação
// ================================================================
const SPECIES_LABEL: Record<string, string> = { cachorro: 'Cachorro', gato: 'Gato', ave: 'Ave', roedor: 'Roedor', reptil: 'Réptil', outro: 'Outro' };
const SIZE_LABEL: Record<string, string> = { small: 'Pequeno', medium: 'Médio', large: 'Grande', giant: 'Gigante' };
const SEX_LABEL: Record<string, string> = { male: 'Macho', female: 'Fêmea', unknown: '—' };

// Situação de uma dose vs. hoje (espelha ClinicPetService.vaccinationStatus, janela 30d).
function vaxStatus(nextDueAt?: string | null): 'no_due' | 'ok' | 'due' | 'overdue' {
  if (!nextDueAt) return 'no_due';
  const due = new Date(nextDueAt.length <= 10 ? nextDueAt + 'T00:00:00' : nextDueAt);
  if (isNaN(due.getTime())) return 'no_due';
  const diff = Math.floor((due.getTime() - Date.now()) / 86400000);
  if (diff < 0) return 'overdue';
  if (diff <= 30) return 'due';
  return 'ok';
}
const VAX_CHIP: Record<string, { label: string; cls: string }> = {
  overdue: { label: 'vencida', cls: 'text-red-300 bg-red-500/15 border-red-500/30' },
  due: { label: 'a vencer', cls: 'text-amber-300 bg-amber-500/15 border-amber-500/30' },
  ok: { label: 'em dia', cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' },
  no_due: { label: 'sem próxima', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-700' },
};

// Petshop F9 — "Próximos cuidados" (vacina + vermífugo/antipulga + retorno de
// banho) de TODA a org, ordenado por vencimento. Só gestor (rota role-gated);
// pra não-gestor a lista vem vazia e o card não aparece.
const CARE_META: Record<string, { icon: string; label: string }> = {
  vaccine: { icon: '💉', label: 'Vacina' }, treatment: { icon: '💊', label: 'Preventivo' }, grooming: { icon: '🛁', label: 'Banho & tosa' },
};
function PetCareUpcomingCard() {
  const [items, setItems] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    apiFetch('/api/clinic/pets-care/upcoming').then((x) => (x.ok ? x.json() : { upcoming: [] }))
      .then((d) => setItems(Array.isArray(d?.upcoming) ? d.upcoming : []))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true));
  }, []);
  if (!loaded || items.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="text-sm font-medium text-amber-300 mb-2">🔔 Próximos cuidados ({items.length})</div>
      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {items.map((r, i) => {
          const m = CARE_META[r.kind] || { icon: '•', label: r.kind };
          return (
            <div key={`${r.kind}:${r.petId}:${i}`} className="flex items-center gap-2 text-[12px]">
              <span>{m.icon}</span>
              <span className="text-zinc-100 font-medium truncate">{r.petName}</span>
              <span className="text-zinc-500 truncate">{r.label}</span>
              <span className={`ml-auto rounded-full border px-1.5 py-0.5 text-[10px] ${r.status === 'overdue' ? 'text-rose-300 border-rose-500/30 bg-rose-500/10' : 'text-amber-300 border-amber-500/30 bg-amber-500/10'}`}>
                {r.status === 'overdue' ? 'atrasado' : 'a vencer'} · {r.nextDueAt}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">Pipeline de recompra: quem está na hora de voltar. Consolida vacina, vermífugo/antipulga e retorno de banho.</p>
    </div>
  );
}

function PetsTab({ contacts }: { contacts: ContactLite[] }) {
  const terms = useClinicTerms();
  const [tutorId, setTutorId] = useState('');
  const [pets, setPets] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadPets = async (tid: string) => {
    if (!tid) { setPets([]); return; }
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/pets?tutor=${encodeURIComponent(tid)}`).then((x) => (x.ok ? x.json() : { pets: [] }));
      setPets(Array.isArray(r?.pets) ? r.pets : []);
    } catch { setPets([]); } finally { setLoading(false); }
  };
  useEffect(() => { loadPets(tutorId); /* eslint-disable-next-line */ }, [tutorId]);

  return (
    <div className="space-y-4">
      {/* Petshop F9 — visão consolidada da pipeline de recompra (org-level) */}
      <PetCareUpcomingCard />

      <div className="flex items-end gap-3 flex-wrap">
        <div className="min-w-[16rem]">
          <label className="text-sm text-zinc-400 mb-1 block">{terms.guardian}</label>
          <select value={tutorId} onChange={(e) => setTutorId(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">Selecione o {terms.guardianLower}…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` — ${c.identifier}` : ''}</option>)}
          </select>
        </div>
        {tutorId && (
          <button onClick={() => setShowNew(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500">
            <Plus className="w-4 h-4" /> Novo {terms.patientLower}
          </button>
        )}
      </div>

      {!tutorId ? (
        <p className="text-sm text-zinc-500">Escolha um {terms.guardianLower} para ver e cadastrar os {terms.patientPluralLower}.</p>
      ) : loading ? (
        <p className="text-sm text-zinc-500 inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</p>
      ) : pets.length === 0 ? (
        <p className="text-sm text-zinc-500">Nenhum {terms.patientLower} cadastrado para este {terms.guardianLower}.</p>
      ) : (
        <div className="space-y-2">
          {pets.map((p) => (
            <div key={p.id}><PetCard pet={p} terms={terms} expanded={expanded === p.id} onToggle={() => { setExpanded(expanded === p.id ? null : p.id); }} onChanged={() => { loadPets(tutorId); }} /></div>
          ))}
        </div>
      )}

      {showNew && <NewPetModal tutorId={tutorId} terms={terms} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); loadPets(tutorId); }} />}
    </div>
  );
}

function PetCard({ pet, terms, expanded, onToggle, onChanged }: { pet: any; terms: ClinicTerms; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const meta = [SPECIES_LABEL[pet.species] || pet.species, pet.breed, pet.age?.label, SIZE_LABEL[pet.size] || null, pet.weightKg ? `${pet.weightKg} kg` : null].filter(Boolean).join(' · ');
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40">
      <button onClick={onToggle} className="w-full flex items-center gap-2 p-3 text-left">
        <span className="text-lg">{pet.species === 'gato' ? '🐱' : pet.species === 'ave' ? '🐦' : '🐶'}</span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100 truncate">{pet.name}{pet.status !== 'active' && <span className="ml-2 text-[10px] text-zinc-500">({pet.status})</span>}</div>
          <div className="text-[11px] text-zinc-500 truncate">{meta || '—'}</div>
        </div>
        {pet.healthPlanName && pet.healthPlanStatus === 'active' && <span className="ml-1 rounded-full border border-indigo-700/50 bg-indigo-950/30 text-indigo-300 px-2 py-0.5 text-[10px]">{pet.healthPlanName}</span>}
        {expanded ? <ChevronUp className="w-4 h-4 text-zinc-500 ml-auto" /> : <ChevronDown className="w-4 h-4 text-zinc-500 ml-auto" />}
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 p-3 space-y-4">
          <PetHealthPlanRow pet={pet} onChanged={onChanged} />
          <PetVaccinationCard petId={pet.id} terms={terms} />
          <PetTreatmentCard petId={pet.id} />
          <PetHospitalizationSection petId={pet.id} terms={terms} />
          <PetSurgerySection petId={pet.id} terms={terms} />
          <PetHistorySection petId={pet.id} />
        </div>
      )}
    </div>
  );
}

// Plano de saúde do pet (F5b) — atributo editável; cobrança recorrente é do Assinaturas.
function PetHealthPlanRow({ pet, onChanged }: { pet: any; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(pet.healthPlanName || '');
  const save = async (clear = false) => {
    try {
      const r = await apiFetch(`/api/clinic/pets/${pet.id}/health-plan`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: clear ? null : (name.trim() || null) }) });
      if (!r.ok) throw new Error();
      toast.success('Plano atualizado.'); setEditing(false); onChanged();
    } catch { toast.error('Erro ao salvar plano'); }
  };
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-zinc-400">Plano de saúde:</span>
      {editing ? (
        <>
          <input className="bg-zinc-950 border border-zinc-800 rounded p-1 text-xs text-zinc-100 w-44" placeholder="Nome do plano" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={() => save(false)} className="text-[11px] text-emerald-300 hover:text-emerald-200">salvar</button>
          <button onClick={() => { setEditing(false); setName(pet.healthPlanName || ''); }} className="text-[11px] text-zinc-500">cancelar</button>
        </>
      ) : (
        <>
          <span className="text-zinc-100">{pet.healthPlanName && pet.healthPlanStatus === 'active' ? pet.healthPlanName : 'sem plano'}</span>
          <button onClick={() => setEditing(true)} className="text-[11px] text-indigo-300 hover:text-indigo-200">{pet.healthPlanName ? 'editar' : 'definir'}</button>
          {pet.healthPlanName && <button onClick={() => save(true)} className="text-[11px] text-zinc-500 hover:text-zinc-300">remover</button>}
        </>
      )}
    </div>
  );
}

// Histórico de saúde do pet (F6) — timeline consolidado (read-only).
const HIST_META: Record<string, { icon: string; cls: string }> = {
  vaccination: { icon: '💉', cls: 'text-emerald-300' },
  hospitalization: { icon: '🏥', cls: 'text-amber-300' },
  surgery: { icon: '🔪', cls: 'text-red-300' },
  appointment: { icon: '🩺', cls: 'text-sky-300' },
  grooming: { icon: '🛁', cls: 'text-indigo-300' },
};
function PetHistorySection({ petId }: { petId: string }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || items !== null) return;
    apiFetch(`/api/clinic/pets/${petId}/history`).then((r) => (r.ok ? r.json() : { history: [] })).then((d) => setItems(Array.isArray(d?.history) ? d.history : [])).catch(() => setItems([]));
  }, [open, petId, items]);
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-zinc-300 inline-flex items-center gap-1">
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />} Histórico de saúde
      </button>
      {open && (
        items === null ? <p className="mt-1 text-xs text-zinc-500">Carregando…</p> :
        items.length === 0 ? <p className="mt-1 text-xs text-zinc-500">Sem eventos registrados ainda.</p> : (
          <ol className="mt-2 space-y-1.5 border-l border-zinc-800 pl-3">
            {items.map((e, i) => {
              const m = HIST_META[e.kind] || { icon: '•', cls: 'text-zinc-300' };
              return (
                <li key={`${e.refId}-${i}`} className="text-[12px] flex items-start gap-2">
                  <span>{m.icon}</span>
                  <div className="min-w-0">
                    <div className={`${m.cls} truncate`}>{e.title}{e.status ? <span className="text-zinc-600"> · {e.status}</span> : null}</div>
                    <div className="text-[10px] text-zinc-500">{e.at ? fmtDateTime(e.at) : '—'}{e.detail ? ` · ${e.detail}` : ''}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        )
      )}
    </div>
  );
}

// Internação do pet (F5b) — internar/dar alta + histórico.
function PetHospitalizationSection({ petId, terms }: { petId: string; terms: ClinicTerms }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdmit, setShowAdmit] = useState(false);
  const [reason, setReason] = useState('');
  const load = async () => {
    setLoading(true);
    try { const r = await apiFetch(`/api/clinic/pets/${petId}/hospitalizations`).then((x) => (x.ok ? x.json() : { hospitalizations: [] })); setItems(Array.isArray(r?.hospitalizations) ? r.hospitalizations : []); } catch { setItems([]); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [petId]);
  const admit = async () => {
    try { const r = await apiFetch(`/api/clinic/pets/${petId}/hospitalizations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() || null }) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha'); toast.success('Pet internado.'); setReason(''); setShowAdmit(false); load(); }
    catch (e: any) { toast.error(e.message || 'Erro'); }
  };
  const discharge = async (hid: string) => {
    try { await apiFetch(`/api/clinic/hospitalizations/${hid}/discharge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); toast.success('Alta registrada.'); load(); }
    catch { toast.error('Erro'); }
  };
  const active = items.find((i) => i.status === 'admitted');
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs font-medium text-zinc-300">Internação</div>
        {!active && <button onClick={() => setShowAdmit((v) => !v)} className="text-[11px] inline-flex items-center gap-1 text-amber-300 hover:text-amber-200"><Plus className="w-3 h-3" /> Internar</button>}
      </div>
      {showAdmit && !active && (
        <div className="flex items-center gap-2 mb-2">
          <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" placeholder="Motivo da internação" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button onClick={admit} className="text-[11px] rounded bg-amber-600 hover:bg-amber-500 text-white px-2.5 py-1">Confirmar</button>
        </div>
      )}
      {loading ? <p className="text-xs text-zinc-500">Carregando…</p> : active ? (
        <div className="rounded-lg border border-amber-700/40 bg-amber-950/10 p-2 flex items-center gap-2 text-[12px]">
          <span className="text-amber-300">🏥 Internado desde {fmtDateTime(active.admittedAt)}</span>
          {active.reason && <span className="text-zinc-400 truncate">· {active.reason}</span>}
          <button onClick={() => discharge(active.id)} className="ml-auto text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-1">Dar alta</button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-zinc-500">Sem internações.</p>
      ) : (
        <div className="text-[11px] text-zinc-500">Última: {fmtDateTime(items[0].admittedAt)} → alta {items[0].dischargedAt ? fmtDateTime(items[0].dischargedAt) : '—'}</div>
      )}
    </div>
  );
}

// Cirurgia + checklist pré-operatório (F5b).
function PetSurgerySection({ petId, terms }: { petId: string; terms: ClinicTerms }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [when, setWhen] = useState('');
  const load = async () => {
    setLoading(true);
    try { const r = await apiFetch(`/api/clinic/pets/${petId}/surgeries`).then((x) => (x.ok ? x.json() : { surgeries: [] })); setItems(Array.isArray(r?.surgeries) ? r.surgeries : []); } catch { setItems([]); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [petId]);
  const schedule = async () => {
    if (!name.trim()) { toast.error('Informe o procedimento.'); return; }
    try { const r = await apiFetch(`/api/clinic/pets/${petId}/surgeries`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ procedureName: name.trim(), scheduledAt: when ? new Date(when).toISOString() : null }) }); if (!r.ok) throw new Error(); toast.success('Cirurgia agendada.'); setName(''); setWhen(''); setShowAdd(false); load(); }
    catch { toast.error('Erro'); }
  };
  const toggleItem = async (sid: string, index: number, done: boolean) => {
    try { await apiFetch(`/api/clinic/surgeries/${sid}/checklist`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index, done }) }); load(); }
    catch { toast.error('Erro'); }
  };
  const setStatus = async (sid: string, status: 'done' | 'cancelled') => {
    try { const r = await apiFetch(`/api/clinic/surgeries/${sid}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha'); toast.success(status === 'done' ? 'Cirurgia concluída.' : 'Cirurgia cancelada.'); load(); }
    catch (e: any) { toast.error(e.message || 'Erro'); }
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs font-medium text-zinc-300">Cirurgias</div>
        <button onClick={() => setShowAdd((v) => !v)} className="text-[11px] inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200"><Plus className="w-3 h-3" /> Agendar</button>
      </div>
      {showAdd && (
        <div className="flex items-center gap-2 mb-2">
          <input className="flex-1 bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" placeholder="Procedimento (ex.: Castração)" value={name} onChange={(e) => setName(e.target.value)} />
          <input type="datetime-local" className="bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" value={when} onChange={(e) => setWhen(e.target.value)} />
          <button onClick={schedule} className="text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1">Agendar</button>
        </div>
      )}
      {loading ? <p className="text-xs text-zinc-500">Carregando…</p> : items.length === 0 ? (
        <p className="text-xs text-zinc-500">Nenhuma cirurgia.</p>
      ) : (
        <div className="space-y-2">
          {items.map((s) => {
            const total = s.checklist.length; const done = s.checklist.filter((c: any) => c.done).length;
            return (
              <div key={s.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-medium text-zinc-100">{s.procedureName}</span>
                  {s.scheduledAt && <span className="text-zinc-500">{fmtDateTime(s.scheduledAt)}</span>}
                  <span className={`ml-auto rounded-full border px-1.5 py-0.5 text-[10px] ${s.status === 'done' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : s.status === 'cancelled' ? 'text-zinc-500 border-zinc-700' : 'text-amber-300 border-amber-500/30 bg-amber-500/10'}`}>{s.status === 'done' ? 'realizada' : s.status === 'cancelled' ? 'cancelada' : 'agendada'}</span>
                </div>
                {s.status === 'scheduled' && (
                  <>
                    <div className="mt-2 space-y-1">
                      {s.checklist.map((c: any, i: number) => (
                        <label key={i} className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
                          <input type="checkbox" checked={c.done} onChange={(e) => toggleItem(s.id, i, e.target.checked)} /> {c.label}
                        </label>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[10px] text-zinc-500">checklist {done}/{total}</span>
                      <button onClick={() => setStatus(s.id, 'done')} disabled={done < total} title={done < total ? 'Complete o checklist' : ''}
                        className="ml-auto text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-2 py-1">Concluir</button>
                      <button onClick={() => setStatus(s.id, 'cancelled')} className="text-[11px] rounded border border-zinc-700 text-zinc-400 hover:bg-zinc-800 px-2 py-1">Cancelar</button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PetVaccinationCard({ petId, terms }: { petId: string; terms: ClinicTerms }) {
  const [vax, setVax] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ vaccine: '', dose: '', appliedAt: '', nextDueAt: '', lote: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/pets/${petId}/vaccinations`).then((x) => (x.ok ? x.json() : { vaccinations: [] }));
      setVax(Array.isArray(r?.vaccinations) ? r.vaccinations : []);
    } catch { setVax([]); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [petId]);

  const add = async () => {
    if (!form.vaccine.trim()) { toast.error('Informe a vacina.'); return; }
    setSaving(true);
    try {
      const r = await apiFetch(`/api/clinic/pets/${petId}/vaccinations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vaccine: form.vaccine.trim(), dose: form.dose.trim() || null, appliedAt: form.appliedAt || null, nextDueAt: form.nextDueAt || null, lote: form.lote.trim() || null }) });
      if (!r.ok) throw new Error();
      toast.success('Vacina registrada.'); setForm({ vaccine: '', dose: '', appliedAt: '', nextDueAt: '', lote: '' }); setShowAdd(false); load();
    } catch { toast.error('Erro ao registrar'); } finally { setSaving(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-zinc-300">Carteira de vacinação</div>
        <button onClick={() => setShowAdd((v) => !v)} className="text-[11px] inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200"><Plus className="w-3 h-3" /> Registrar vacina</button>
      </div>
      {showAdd && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2 mb-2 grid grid-cols-2 gap-2">
          <input className="bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" placeholder="Vacina (ex.: V10)" value={form.vaccine} onChange={(e) => setForm((f) => ({ ...f, vaccine: e.target.value }))} />
          <input className="bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" placeholder="Dose (ex.: anual)" value={form.dose} onChange={(e) => setForm((f) => ({ ...f, dose: e.target.value }))} />
          <label className="text-[10px] text-zinc-500">Aplicada em<input type="date" className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" value={form.appliedAt} onChange={(e) => setForm((f) => ({ ...f, appliedAt: e.target.value }))} /></label>
          <label className="text-[10px] text-zinc-500">Próxima dose<input type="date" className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" value={form.nextDueAt} onChange={(e) => setForm((f) => ({ ...f, nextDueAt: e.target.value }))} /></label>
          <input className="bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100 col-span-2" placeholder="Lote (opcional)" value={form.lote} onChange={(e) => setForm((f) => ({ ...f, lote: e.target.value }))} />
          <div className="col-span-2 flex justify-end">
            <button onClick={add} disabled={saving} className="text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 disabled:opacity-50">{saving ? 'Salvando…' : 'Salvar dose'}</button>
          </div>
        </div>
      )}
      {loading ? (
        <p className="text-xs text-zinc-500">Carregando…</p>
      ) : vax.length === 0 ? (
        <p className="text-xs text-zinc-500">Nenhuma vacina registrada ainda.</p>
      ) : (
        <div className="space-y-1">
          {vax.map((v) => {
            const st = VAX_CHIP[vaxStatus(v.nextDueAt)];
            return (
              <div key={v.id} className="flex items-center gap-2 text-[12px]">
                <span className="text-zinc-100 font-medium w-28 truncate">{v.vaccine}</span>
                {v.dose && <span className="text-zinc-500 text-[10px]">{v.dose}</span>}
                <span className="text-zinc-500">{v.appliedAt ? `aplicada ${v.appliedAt}` : ''}</span>
                {v.nextDueAt && <span className="text-zinc-400 ml-auto">próxima {v.nextDueAt}</span>}
                <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${st.cls} ${v.nextDueAt ? '' : 'ml-auto'}`}>{st.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Petshop F7 — tratamentos preventivos recorrentes (vermífugo/antipulga). Espelha
// o PetVaccinationCard; reusa vaxStatus/VAX_CHIP (mesma lógica de next_due_at).
const TREAT_LABEL: Record<string, string> = { vermifugo: 'Vermífugo', antipulga: 'Antipulgas', carrapaticida: 'Carrapaticida', outro: 'Outro' };
function PetTreatmentCard({ petId }: { petId: string }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ treatmentType: 'vermifugo', product: '', appliedAt: '', nextDueAt: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/pets/${petId}/treatments`).then((x) => (x.ok ? x.json() : { treatments: [] }));
      setItems(Array.isArray(r?.treatments) ? r.treatments : []);
    } catch { setItems([]); } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [petId]);

  const add = async () => {
    setSaving(true);
    try {
      const r = await apiFetch(`/api/clinic/pets/${petId}/treatments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ treatmentType: form.treatmentType, product: form.product.trim() || null, appliedAt: form.appliedAt || null, nextDueAt: form.nextDueAt || null }) });
      if (!r.ok) throw new Error();
      toast.success('Tratamento registrado.'); setForm({ treatmentType: 'vermifugo', product: '', appliedAt: '', nextDueAt: '' }); setShowAdd(false); load();
    } catch { toast.error('Erro ao registrar'); } finally { setSaving(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-zinc-300">Vermífugo & antipulgas</div>
        <button onClick={() => setShowAdd((v) => !v)} className="text-[11px] inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200"><Plus className="w-3 h-3" /> Registrar tratamento</button>
      </div>
      {showAdd && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2 mb-2 grid grid-cols-2 gap-2">
          <select className="bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" value={form.treatmentType} onChange={(e) => setForm((f) => ({ ...f, treatmentType: e.target.value }))}>
            {Object.entries(TREAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input className="bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" placeholder="Produto (ex.: Bravecto)" value={form.product} onChange={(e) => setForm((f) => ({ ...f, product: e.target.value }))} />
          <label className="text-[10px] text-zinc-500">Aplicado em<input type="date" className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" value={form.appliedAt} onChange={(e) => setForm((f) => ({ ...f, appliedAt: e.target.value }))} /></label>
          <label className="text-[10px] text-zinc-500">Próxima dose<input type="date" className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100" value={form.nextDueAt} onChange={(e) => setForm((f) => ({ ...f, nextDueAt: e.target.value }))} /></label>
          <div className="col-span-2 flex justify-end">
            <button onClick={add} disabled={saving} className="text-[11px] rounded bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 disabled:opacity-50">{saving ? 'Salvando…' : 'Salvar'}</button>
          </div>
        </div>
      )}
      {loading ? (
        <p className="text-xs text-zinc-500">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-zinc-500">Nenhum tratamento registrado ainda.</p>
      ) : (
        <div className="space-y-1">
          {items.map((t) => {
            const st = VAX_CHIP[vaxStatus(t.nextDueAt)];
            return (
              <div key={t.id} className="flex items-center gap-2 text-[12px]">
                <span className="text-zinc-100 font-medium w-28 truncate">{TREAT_LABEL[t.treatmentType] || t.treatmentType}</span>
                {t.product && <span className="text-zinc-500 text-[10px] truncate">{t.product}</span>}
                <span className="text-zinc-500">{t.appliedAt ? `aplicado ${t.appliedAt}` : ''}</span>
                {t.nextDueAt && <span className="text-zinc-400 ml-auto">próxima {t.nextDueAt}</span>}
                <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${st.cls} ${t.nextDueAt ? '' : 'ml-auto'}`}>{st.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NewPetModal({ tutorId, terms, onClose, onCreated }: { tutorId: string; terms: ClinicTerms; onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ name: '', species: 'cachorro', breed: '', sex: 'unknown', size: '', birthDate: '', weightKg: '', microchip: '', neutered: false, notes: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    if (!f.name.trim()) { toast.error('Informe o nome.'); return; }
    setBusy(true);
    try {
      const body: any = { tutorContactId: tutorId, name: f.name.trim(), species: f.species || null, breed: f.breed.trim() || null, sex: f.sex || null, size: f.size || null, birthDate: f.birthDate || null, weightKg: f.weightKg ? Number(f.weightKg) : null, microchip: f.microchip.trim() || null, neutered: f.neutered, notes: f.notes.trim() || null };
      const r = await apiFetch('/api/clinic/pets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha');
      toast.success(`${terms.patient} cadastrado.`); onCreated();
    } catch (e: any) { toast.error(e.message || 'Erro'); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-zinc-100">Novo {terms.patientLower}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <input className="col-span-2 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" placeholder="Nome do pet" value={f.name} onChange={(e) => set('name', e.target.value)} />
          <select className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" value={f.species} onChange={(e) => set('species', e.target.value)}>
            {Object.entries(SPECIES_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" placeholder="Raça" value={f.breed} onChange={(e) => set('breed', e.target.value)} />
          <select className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" value={f.sex} onChange={(e) => set('sex', e.target.value)}>
            {Object.entries(SEX_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" value={f.size} onChange={(e) => set('size', e.target.value)}>
            <option value="">Porte…</option>
            {Object.entries(SIZE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <label className="text-[11px] text-zinc-500">Nascimento<input type="date" className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} /></label>
          <input className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" placeholder="Peso (kg)" inputMode="decimal" value={f.weightKg} onChange={(e) => set('weightKg', e.target.value)} />
          <input className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100" placeholder="Microchip (opcional)" value={f.microchip} onChange={(e) => set('microchip', e.target.value)} />
          <label className="col-span-2 inline-flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={f.neutered} onChange={(e) => set('neutered', e.target.checked)} /> Castrado</label>
          <textarea className="col-span-2 h-16 bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 resize-none" placeholder="Observações" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"><Plus className="w-4 h-4" /> {busy ? 'Salvando…' : `Cadastrar ${terms.patientLower}`}</button>
        </div>
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
  const terms = useClinicTerms();
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
            <h3 className="font-semibold text-zinc-100 truncate">{auth.contact_name || terms.patient}</h3>
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
  const terms = useClinicTerms();
  const [contactId, setContactId] = useState('');
  const [operatorId, setOperatorId] = useState('');
  const [procedureId, setProcedureId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!contactId) { toast.error(`Selecione o ${terms.patientLower}.`); return; }
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
            <label className="text-sm text-zinc-400 mb-1 block">{terms.patient}</label>
            <select required value={contactId} onChange={e => setContactId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">Selecione um {terms.patientLower}</option>
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
  const terms = useClinicTerms();
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
    if (!contactId) { toast.error(`${terms.patient} não identificado.`); return; }
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
                  Prontuário contém <strong>dado sensível de saúde</strong>. Antes de abrir, o {terms.clientLower} precisa autorizar o registro (verbal ou por assinatura). Confirme com o {terms.clientLower} e registre abaixo — fica auditado.
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
                  rows={10} placeholder={`Queixa principal, história da doença, antecedentes relatados pelo ${terms.clientLower}…`}
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
  const terms = useClinicTerms();
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
    if (!(await confirmDialog(kind === 'prescription' ? `Enviar receita por WhatsApp para o ${terms.clientLower}?` : `Enviar atestado por WhatsApp para o ${terms.clientLower}?`))) return;
    setBusy(true);
    try {
      const path = kind === 'prescription' ? 'prescriptions' : 'certificates';
      const r = await apiFetch(`/api/clinic/${path}/${docId}/send`, { method: 'POST' });
      const out: any = await r.json().catch(() => ({}));
      if (r.status === 409 && (out?.code === 'LGPD_COMMS_CONSENT_REQUIRED' || out?.code === 'LGPD_CONSENT_REQUIRED')) {
        toast.error(out?.error || `Consentimento LGPD necessário — abra a Ficha do ${terms.patientLower} e registre.`);
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
      // 1ª tentativa sem PIN — se profissional não tem PIN cadastrado, emite direto.
      let r = await apiFetch(`/api/clinic/${kind}/${id}/issue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      let out = await r.json().catch(() => ({}));
      // 401 com code PIN_REQUIRED → pede PIN e reenvia (Fatia 14 / ADR-080 Fase T).
      if (r.status === 401 && (out?.code === 'PIN_REQUIRED' || out?.code === 'PIN_INVALID')) {
        // Loop simples: prompt até acertar ou cancelar. window.prompt é
        // suficiente pra fricção mínima; modal proper vem depois se preciso.
        while (true) {
          const pin = window.prompt(out?.code === 'PIN_INVALID' ? 'PIN incorreto. Tente de novo:' : 'Digite o PIN do profissional pra assinar:');
          if (pin === null || !pin.trim()) { setBusyId(''); return; }
          r = await apiFetch(`/api/clinic/${kind}/${id}/issue`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pin.trim() }),
          });
          out = await r.json().catch(() => ({}));
          if (r.ok) break;
          if (r.status !== 401 || (out?.code !== 'PIN_INVALID' && out?.code !== 'PIN_REQUIRED')) break;
        }
      }
      if (!r.ok) { toast.error(out?.error || 'Falha ao emitir.'); return; }
      toast.success(out?.signed_with_pin ? 'Emitido e assinado com PIN.' : 'Emitido.');
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
  const terms = useClinicTerms();
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
              <label className="text-[11px] text-zinc-400 inline-flex items-center gap-1 cursor-pointer select-none" title={`Compartilhar com o Portal do ${terms.client}`}>
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
  automations: {
    reschedule: { offered: number; chosen: number; abandoned: number; expired: number };
    vacancy: { offered: number; accepted: number; declined: number; expired: number; recoveredMinutes: number };
  };
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
  const terms = useClinicTerms();
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
        <StatCard label={`Confirmadas pelo ${terms.clientLower}`} value={`${m.appointments.patientConfirmedRate}%`} hint="do total agendado" />
      </div>

      <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><Bell className="w-3 h-3" /> Lembretes automáticos</h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <StatCard label="Enviados" value={String(m.reminders.sent)} hint={m.reminders.failed ? `${m.reminders.failed} falharam` : 'nenhuma falha'} tone={m.reminders.failed ? 'bad' : 'neutral'} />
        <StatCard label="Respondidos" value={String(m.reminders.replied)} hint={`${m.reminders.confirmationRate + m.reminders.cancellationRate}% de resposta`} />
        <StatCard label="Confirmação SIM" value={`${m.reminders.confirmationRate}%`} tone={confirmTone} />
        <StatCard label="Cancelamento NÃO" value={`${m.reminders.cancellationRate}%`} tone="neutral" />
      </div>

      <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><Send className="w-3 h-3" /> Automações WhatsApp</h4>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-1">
        <StatCard label="Vagas oferecidas" value={String(m.automations.vacancy.offered)} hint={`${m.automations.vacancy.accepted} aceitas · ${m.automations.vacancy.declined} recusadas`} />
        <StatCard label="Horário recuperado" value={`${Math.round(m.automations.vacancy.recoveredMinutes / 60 * 10) / 10}h`} hint="vagas aceitas × duração" tone={m.automations.vacancy.recoveredMinutes > 0 ? 'good' : 'neutral'} />
        <StatCard label="Reagendamentos ofertados" value={String(m.automations.reschedule.offered)} hint={`${m.automations.reschedule.chosen} escolheu`} />
        <StatCard label="Ofertas abandonadas/expiradas" value={String(m.automations.reschedule.abandoned + m.automations.reschedule.expired + m.automations.vacancy.expired)} hint={`${terms.clientLower} não respondeu`} tone="neutral" />
      </div>
      <p className="text-[10px] text-zinc-500 mb-4">Ofertas automáticas de vaga (para quem está na fila de retorno) e de reagendamento (quando o {terms.clientLower} responde REMARCAR).</p>

      <h4 className="text-[11px] text-zinc-400 uppercase tracking-wider mb-2 inline-flex items-center gap-1"><Ban className="w-3 h-3" /> Cancelamentos ({m.cancellations.total})</h4>
      <div className="grid grid-cols-3 gap-2 mb-4">
        <StatCard label={`Pelo ${terms.clientLower}`} value={String(m.cancellations.byOrigin.patient)} hint={`${m.cancellations.patientShare}% do total`} tone="neutral" />
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

// ---- Ofertas de vaga (painel colapsável — ADR-080 Fase R) ------------------
// Mostra as últimas ofertas automáticas de vaga: quem foi convidado, status,
// se aceitou. Load on-demand (só ao expandir).

type VacancyOfferDto = {
  id: string;
  sourceAppointmentId: string;
  candidateContactId: string;
  candidateName: string | null;
  professionalName: string | null;
  sourcePatientName: string | null;
  slotStart: string;
  slotDurationMinutes: number;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'superseded';
  createdAt: string;
  resolvedAt: string | null;
};

function VacancyOffersPanel() {
  const terms = useClinicTerms();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<VacancyOfferDto[] | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/clinic/vacancies?limit=20');
      setItems(r.ok ? await r.json() : []);
    } finally { setLoading(false); }
  };
  useEffect(() => { if (open && items === null) load(); /* eslint-disable-next-line */ }, [open]);

  const statusPill = (s: VacancyOfferDto['status']) => {
    const map: Record<string, { label: string; cls: string }> = {
      pending: { label: 'aguardando', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
      accepted: { label: 'aceita', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
      declined: { label: 'recusada', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
      expired: { label: 'expirada', cls: 'bg-zinc-700/40 text-zinc-400 border-zinc-700' },
      superseded: { label: 'substituída', cls: 'bg-zinc-700/40 text-zinc-400 border-zinc-700' },
    };
    const p = map[s] || map.pending;
    return <span className={`text-[10px] rounded-full border px-1.5 py-0.5 ${p.cls}`}>{p.label}</span>;
  };

  return (
    <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50 print:hidden">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-5 py-3 text-left">
        <span className="text-sm font-medium text-zinc-100 flex items-center gap-2">
          <Send className="w-4 h-4 text-emerald-300" /> Ofertas de vaga (automáticas)
          {items && items.length > 0 && (
            <span className="text-[10px] text-zinc-400 font-normal">{items.length} recentes</span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-500" />}
      </button>
      {open && (
        <div className="px-5 pb-5 border-t border-zinc-800 pt-4">
          {loading && <div className="text-xs text-zinc-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Carregando…</div>}
          {!loading && (!items || items.length === 0) && (
            <div className="text-xs text-zinc-500">Nenhuma vaga automática oferecida ainda. Quando alguém cancelar uma consulta futura, o sistema oferece o horário pra quem está na fila de retorno do mesmo profissional.</div>
          )}
          {!loading && items && items.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800">
              {items.map((v) => (
                <div key={v.id} className="p-3 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-zinc-100 font-medium">{v.candidateName || terms.patient}</span>
                    {statusPill(v.status)}
                    <span className="text-zinc-500">→ {new Date(v.slotStart).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {v.slotDurationMinutes}min</span>
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5">
                    Convidado por vaga aberta de <span className="text-zinc-400">{v.sourcePatientName || terms.patientLower}</span>
                    {v.professionalName && <> com <span className="text-zinc-400">{v.professionalName}</span></>}
                    <> · ofertada em {new Date(v.createdAt).toLocaleString('pt-BR')}</>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Fila de retornos pendentes (painel colapsável na Agenda) --------------
function FollowUpQueuePanel() {
  const terms = useClinicTerms();
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
            <div className="text-xs text-zinc-500">Nenhum retorno pendente na fila. Quando o profissional marcar "voltar em X dias" no prontuário, o {terms.patientLower} aparece aqui pra confirmação.</div>
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
