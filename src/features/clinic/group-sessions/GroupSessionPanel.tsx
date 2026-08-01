/**
 * GroupSessionPanel — Módulo Clínica Fatia 54 (UI da ADR-146).
 * -------------------------------------------------------------------
 * Quarta superfície visual da Jornada de Tratamento. Consome:
 *   - F41-F43 (schedule_sessions: create/addParticipant/remove/cancel;
 *              occupation por profissional/período)
 *   - F47 (availability — sugestão determinística de horários do
 *          MESMO profissional; RN-014 guardrail — nunca sugere outro)
 *
 * Substitui a gambiarra clássica "grupo é um appointment só com vários
 * pacientes" ou "vários appointments com force=true". Agora:
 *   - 1 `schedule_session` amarra N participantes.
 *   - Cada participante mantém `appointment` individual (prontuário,
 *     lembrete, presença, portal — tudo isolado).
 *   - Ocupação do profissional conta 1× por sessão de grupo (RN-006),
 *     não N×.
 *
 * Layout:
 *   - Filtro (data + profissional obrigatórios pra listar).
 *   - "Nova sessão de grupo" (modal com Sugestão IA de horário).
 *   - Cards de sessão do dia com participantes + ações.
 *
 * Guardrails (ADR-146 §Guardrails + ADR-145 §RN-014):
 *   - AvailabilitySuggestions NUNCA propõe outro profissional (a
 *     rota `availability` só recebe 1 professionalId).
 *   - Nunca lista participantes de sessão de grupo no portal do
 *     paciente (isso é backend F43; a UI daqui é ADMIN).
 *   - Cancelar sessão restrito a owner|admin — botão sempre visível;
 *     backend retorna 403 se não pode.
 *   - AddParticipant valida specialty do episódio == specialty da
 *     sessão (código SESSION_SPECIALTY_MISMATCH) — a UI ajuda
 *     filtrando na fonte.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Loader2, Plus, X, Info, Users, Ban, DoorOpen, Clock, User,
  Sparkles, Trash2, Layers, Stethoscope, AlertTriangle,
} from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

type ContactLite = { id: string; name: string; identifier?: string | null };
type Specialty = {
  id: string; name: string; color?: string | null; active: boolean;
  defaultDurationMinutes: number;
};
type ProfessionalLite = { id: string; name: string; color?: string | null; active?: boolean | number };
type Room = { id: string; name: string; capacity?: number | null };

type SessionType = 'individual' | 'group';
type SessionStatus = 'scheduled' | 'in_care' | 'completed' | 'cancelled';

type ScheduleSession = {
  id: string;
  specialtyId: string;
  professionalId: string;
  roomId: string | null;
  sessionType: SessionType;
  title: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  durationMinutes: number;
  capacity: number;
  status: SessionStatus;
  cancelledAt: string | null;
  cancelledReason: string | null;
  participantsCount?: number;
};

type Participant = {
  appointmentId: string;
  contactId: string;
  contactName: string | null;
  careEpisodeId: string | null;
  treatmentCycleId: string | null;
  appointmentStatus: string;
  scheduledStart: string;
};

type AvailabilitySlot = { startISO: string; endISO: string; durationMinutes: number };

type CareEpisodeLite = {
  id: string;
  contactId: string;
  specialtyId: string;
  primaryProfessionalId: string;
  status: 'active' | 'on_hold' | 'discharged' | 'cancelled';
};

const STATUS_META: Record<SessionStatus, { label: string; cls: string }> = {
  scheduled: { label: 'Agendada',  cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  in_care:   { label: 'Em curso',  cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  completed: { label: 'Concluída', cls: 'text-zinc-300 border-zinc-700 bg-zinc-800/40' },
  cancelled: { label: 'Cancelada', cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
};

const todayISO = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function GroupSessionPanel() {
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalLite[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);

  const [date, setDate] = useState<string>(todayISO());
  const [professionalId, setProfessionalId] = useState<string>('');
  const [sessions, setSessions] = useState<ScheduleSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const loadBase = useCallback(async () => {
    try {
      const [rC, rS, rP, rR] = await Promise.all([
        apiFetch('/api/contacts'),
        apiFetch('/api/clinic/specialties'),
        apiFetch('/api/clinic/professionals'),
        apiFetch('/api/clinic/rooms'),
      ]);
      const [dC, dS, dP, dR] = await Promise.all([
        rC.json().catch(() => []),
        rS.json().catch(() => ({})),
        rP.json().catch(() => []),
        rR.json().catch(() => []),
      ]);
      setContacts(Array.isArray(dC) ? dC : []);
      setSpecialties(Array.isArray(dS?.specialties) ? dS.specialties : []);
      const profs = Array.isArray(dP) ? dP : [];
      setProfessionals(profs);
      setRooms(Array.isArray(dR) ? dR : []);
      // Auto-seleciona o 1º profissional ativo se nada estiver escolhido.
      if (!professionalId && profs.length > 0) {
        const active = profs.find((p: any) => p.active === true || p.active === 1) || profs[0];
        setProfessionalId(active.id);
      }
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar dados base.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSessions = useCallback(async () => {
    if (!date || !professionalId) { setSessions([]); return; }
    setLoading(true);
    try {
      const qs = new URLSearchParams({ date, professionalId }).toString();
      const r = await apiFetch(`/api/clinic/schedule-sessions?${qs}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao carregar sessões.');
      setSessions(Array.isArray(d?.sessions) ? d.sessions : []);
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
      setSessions([]);
    } finally { setLoading(false); }
  }, [date, professionalId]);

  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => { loadSessions(); }, [loadSessions]);

  const specialtyById = useMemo(() => new Map(specialties.map(s => [s.id, s])), [specialties]);
  const professionalById = useMemo(() => new Map(professionals.map(p => [p.id, p])), [professionals]);
  const roomById = useMemo(() => new Map(rooms.map(r => [r.id, r])), [rooms]);
  const contactById = useMemo(() => new Map(contacts.map(c => [c.id, c])), [contacts]);

  return (
    <div>
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-2.5 text-xs text-emerald-100">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="leading-relaxed">
          Uma <b>sessão de grupo</b> reúne N pacientes num mesmo horário/profissional/sala.
          Cada participante mantém <b>appointment próprio</b> (prontuário, lembrete, presença,
          portal — tudo isolado). Ocupação do profissional conta 1×, não N× (RN-006).
        </span>
      </div>

      {/* Filtros */}
      <div className="mb-4 flex items-end gap-3 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Data</span>
          <input type="date" value={date} onChange={e => setDate(e.target.value || todayISO())}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </label>
        <label className="flex flex-col gap-1 min-w-[220px] flex-1">
          <span className="text-[11px] text-zinc-400">Profissional</span>
          <select value={professionalId} onChange={e => setProfessionalId(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— selecione —</option>
            {professionals.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <Button className="zf-button zf-button-primary" onClick={() => setShowNew(true)}
            disabled={professionals.length === 0}>
            <Plus className="w-4 h-4 mr-2" /> Nova sessão de grupo
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando sessões…
        </div>
      ) : !professionalId ? (
        <div className="py-14 text-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30">
          <Users className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Selecione o profissional pra ver as sessões do dia.</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="py-14 text-center rounded-xl border border-zinc-800 bg-zinc-900/40">
          <Users className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Nenhuma sessão de grupo neste dia.</p>
          <p className="text-[12px] text-zinc-600 mt-1">Clique em "Nova sessão de grupo" para criar.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map(s => (
            <React.Fragment key={s.id}>
              <SessionCard
                session={s}
                specialty={specialtyById.get(s.specialtyId) || null}
                professional={professionalById.get(s.professionalId) || null}
                room={s.roomId ? roomById.get(s.roomId) || null : null}
                contacts={contacts}
                contactById={contactById}
                onChanged={loadSessions}
              />
            </React.Fragment>
          ))}
        </div>
      )}

      {showNew && (
        <NewSessionModal
          specialties={specialties.filter(s => s.active)}
          professionals={professionals.filter(p => p.active === true || p.active === 1 || p.active === undefined)}
          rooms={rooms}
          defaultDate={date}
          defaultProfessionalId={professionalId}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); loadSessions(); }}
        />
      )}
    </div>
  );
}

// ── Card de sessão + participantes ───────────────────────────────────
function SessionCard({ session, specialty, professional, room, contacts, contactById, onChanged }: {
  session: ScheduleSession;
  specialty: Specialty | null;
  professional: ProfessionalLite | null;
  room: Room | null;
  contacts: ContactLite[];
  contactById: Map<string, ContactLite>;
  onChanged: () => void;
}) {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const meta = STATUS_META[session.status];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/schedule-sessions/${session.id}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha.');
      setParticipants(Array.isArray(d?.participants) ? d.participants : []);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar participantes.');
    } finally { setLoading(false); }
  }, [session.id]);

  useEffect(() => { load(); }, [load]);

  const remove = async (p: Participant) => {
    const ok = await confirmDialog(
      `Remover ${p.contactName || 'paciente'} da sessão? O appointment individual é cancelado.`,
      { title: 'Remover participante', confirmText: 'Remover', danger: true },
    );
    if (!ok) return;
    setBusy(p.appointmentId);
    try {
      const r = await apiFetch(
        `/api/clinic/schedule-sessions/${session.id}/participants/${p.appointmentId}`,
        { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao remover.');
      toast.success('Participante removido.');
      load();
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally { setBusy(null); }
  };

  const cancel = async () => {
    const ok = await confirmDialog(
      'Cancelar a sessão inteira cancela TODOS os appointments dos participantes. Prosseguir?',
      { title: 'Cancelar sessão de grupo', confirmText: 'Cancelar sessão', danger: true },
    );
    if (!ok) return;
    const reason = window.prompt('Motivo do cancelamento:') ?? '';
    if (!reason.trim()) { toast.error('Motivo é obrigatório.'); return; }
    setBusy('__cancel__');
    try {
      const r = await apiFetch(`/api/clinic/schedule-sessions/${session.id}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao cancelar.');
      toast.success('Sessão cancelada.');
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally { setBusy(null); }
  };

  const alreadyIn = useMemo(
    () => new Set(participants.map(p => p.contactId)),
    [participants],
  );
  const filled = participants.length;
  const cap = session.capacity;
  const pct = cap > 0 ? Math.min(100, Math.round((filled / cap) * 100)) : 0;
  const closable = session.status === 'scheduled' || session.status === 'in_care';

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Clock className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-sm font-semibold text-zinc-100">
              {fmtTime(session.scheduledStart)}–{fmtTime(session.scheduledEnd)}
            </span>
            <span className="text-[11px] text-zinc-500">·</span>
            <span className="inline-block w-2.5 h-2.5 rounded-full border border-zinc-600"
              style={{ backgroundColor: specialty?.color || '#71717a' }} />
            <span className="text-xs text-zinc-300 truncate">{specialty?.name || 'Especialidade'}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label}</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-1 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <Stethoscope className="w-3 h-3" /> {professional?.name || 'Profissional'}
            </span>
            {room && (
              <span className="inline-flex items-center gap-1">
                <DoorOpen className="w-3 h-3" /> {room.name}
              </span>
            )}
            <span>{session.durationMinutes} min</span>
          </div>
          {session.cancelledReason && (
            <p className="text-[11px] text-zinc-400 mt-1 italic">"{session.cancelledReason}"</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-zinc-400">
            {filled}/{cap} vaga(s)
          </span>
          {closable && filled < cap && (
            <button onClick={() => setShowAdd(true)}
              className="h-7 px-2 text-[11px] rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center gap-1">
              <Plus className="w-3 h-3" /> Adicionar
            </button>
          )}
          {closable && (
            <button onClick={cancel} disabled={busy === '__cancel__'}
              className="h-7 px-2 text-[11px] rounded-lg border border-rose-500/40 text-rose-200 hover:bg-rose-500/10 inline-flex items-center gap-1">
              {busy === '__cancel__' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
              Cancelar
            </button>
          )}
        </div>
      </div>

      {/* Barra de vagas */}
      <div className="mt-3">
        <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
          <div className={`h-full ${pct >= 100 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-400' : 'bg-emerald-500'}`}
            style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Participantes */}
      <div className="mt-3">
        {loading ? (
          <div className="flex items-center gap-2 text-zinc-500 text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando participantes…
          </div>
        ) : participants.length === 0 ? (
          <p className="text-[11px] text-zinc-600">Nenhum participante — a sessão está vazia.</p>
        ) : (
          <div className="space-y-1">
            {participants.map(p => (
              <div key={p.appointmentId}
                className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1.5">
                <User className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="text-xs text-zinc-200 truncate">{p.contactName || 'Paciente'}</span>
                <span className="text-[10px] text-zinc-500 ml-auto">{p.appointmentStatus}</span>
                {closable && (
                  <button onClick={() => remove(p)} disabled={busy === p.appointmentId}
                    className="h-6 px-1.5 text-[10px] rounded border border-rose-500/30 text-rose-200 hover:bg-rose-500/10 inline-flex items-center gap-1">
                    {busy === p.appointmentId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    Remover
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showAdd && (
        <AddParticipantModal
          sessionId={session.id}
          specialtyId={session.specialtyId}
          professionalId={session.professionalId}
          contacts={contacts.filter(c => !alreadyIn.has(c.id))}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); load(); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Modal: nova sessão de grupo (com AvailabilitySuggestions) ────────
function NewSessionModal({ specialties, professionals, rooms, defaultDate, defaultProfessionalId, onClose, onCreated }: {
  specialties: Specialty[];
  professionals: ProfessionalLite[];
  rooms: Room[];
  defaultDate: string;
  defaultProfessionalId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [specialtyId, setSpecialtyId] = useState('');
  const [professionalId, setProfessionalId] = useState(defaultProfessionalId);
  const [roomId, setRoomId] = useState<string>('');
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState<number>(60);
  const [capacity, setCapacity] = useState<number>(5);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  // Slots sugeridos pela IA (F47).
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  // Ao mudar specialty → ajusta duration default.
  useEffect(() => {
    const sp = specialties.find(s => s.id === specialtyId);
    if (sp?.defaultDurationMinutes) setDuration(sp.defaultDurationMinutes);
  }, [specialtyId, specialties]);

  const suggest = async () => {
    if (!professionalId) { toast.error('Selecione o profissional antes.'); return; }
    if (!date) { toast.error('Escolha a data.'); return; }
    setLoadingSlots(true);
    setSlotsError(null);
    setSlots([]);
    try {
      const from = new Date(`${date}T08:00:00.000`).toISOString();
      const to = new Date(`${date}T20:00:00.000`).toISOString();
      const qs = new URLSearchParams({
        professionalId,
        durationMinutes: String(duration),
        from, to,
        maxSuggestions: '3',
      });
      if (roomId) qs.set('roomId', roomId);
      const r = await apiFetch(`/api/clinic/schedule-sessions/availability?${qs.toString()}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao sugerir horários.');
      setSlots(Array.isArray(d?.suggestions) ? d.suggestions : []);
      if ((d?.suggestions || []).length === 0) {
        setSlotsError('Nenhum horário livre no dia — tente outra data ou reduza a duração.');
      }
    } catch (e: any) {
      setSlotsError(e?.message || 'Falha.');
    } finally { setLoadingSlots(false); }
  };

  const submit = async () => {
    if (!specialtyId) { toast.error('Selecione a especialidade.'); return; }
    if (!professionalId) { toast.error('Selecione o profissional.'); return; }
    if (!date || !time) { toast.error('Data e hora obrigatórias.'); return; }
    if (duration < 5 || duration > 480) { toast.error('Duração entre 5 e 480 min.'); return; }
    if (capacity < 1 || capacity > 100) { toast.error('Capacidade entre 1 e 100.'); return; }
    setBusy(true);
    try {
      const scheduledStart = new Date(`${date}T${time}:00`).toISOString();
      const r = await apiFetch('/api/clinic/schedule-sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specialtyId, professionalId,
          roomId: roomId || null,
          sessionType: 'group',
          title: title.trim() || null,
          scheduledStart,
          durationMinutes: duration,
          capacity,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao criar sessão.');
      toast.success('Sessão de grupo criada.');
      onCreated();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally { setBusy(false); }
  };

  return (
    <ModalShell title="Nova sessão de grupo" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Especialidade</span>
            <select value={specialtyId} onChange={e => setSpecialtyId(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">— selecione —</option>
              {specialties.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Profissional</span>
            <select value={professionalId} onChange={e => setProfessionalId(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">— selecione —</option>
              {professionals.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Sala (opcional)</span>
            <select value={roomId} onChange={e => setRoomId(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">— sem sala —</option>
              {rooms.map(r => <option key={r.id} value={r.id}>{r.name}{r.capacity ? ` (cap. ${r.capacity})` : ''}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Título / rótulo (opcional)</span>
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="Ex.: Grupo TCC — quinta"
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Data</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Hora</span>
            <input type="time" value={time} onChange={e => setTime(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Duração (min)</span>
            <input type="number" min={5} max={480} value={duration}
              onChange={e => setDuration(Number(e.target.value) || 60)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Capacidade (nº de vagas)</span>
            <input type="number" min={1} max={100} value={capacity}
              onChange={e => setCapacity(Number(e.target.value) || 5)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
        </div>

        {/* AvailabilitySuggestions (F47) */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
            <span className="text-[11px] text-zinc-300 font-medium">
              Sugerir horários livres do profissional (mesma agenda)
            </span>
            <button onClick={suggest} disabled={loadingSlots || !professionalId || !date}
              className="ml-auto h-6 px-2 text-[10px] rounded border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center gap-1 disabled:opacity-50">
              {loadingSlots ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Sugerir
            </button>
          </div>
          {slots.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {slots.map(s => {
                const d = new Date(s.startISO);
                const p = (n: number) => String(n).padStart(2, '0');
                const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;
                return (
                  <button key={s.startISO}
                    onClick={() => { setTime(hhmm); }}
                    className="h-7 px-2 text-[11px] rounded-lg border border-zinc-700 text-zinc-100 hover:bg-zinc-800">
                    {hhmm}
                  </button>
                );
              })}
            </div>
          )}
          {slotsError && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-200 mt-1">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{slotsError}</span>
            </div>
          )}
          {!loadingSlots && slots.length === 0 && !slotsError && (
            <p className="text-[10px] text-zinc-600">
              A IA sugere apenas horários do <b>mesmo profissional</b> — nunca substitui a escolha do responsável.
            </p>
          )}
        </div>

        <p className="text-[11px] text-zinc-500">
          O profissional precisa estar vinculado à especialidade (aba Especialidades).
        </p>
      </div>
      <ModalActions onClose={onClose}>
        <Button onClick={submit} disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
          Criar sessão
        </Button>
      </ModalActions>
    </ModalShell>
  );
}

// ── Modal: adicionar participante (com filtro por episódio ativo) ────
function AddParticipantModal({ sessionId, specialtyId, professionalId, contacts, onClose, onAdded }: {
  sessionId: string;
  specialtyId: string;
  professionalId: string;
  contacts: ContactLite[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [contactId, setContactId] = useState('');
  const [episodes, setEpisodes] = useState<CareEpisodeLite[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>('');
  const [loadingEps, setLoadingEps] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!contactId) { setEpisodes([]); setSelectedEpisodeId(''); return; }
    setLoadingEps(true);
    apiFetch(`/api/clinic/patients/${contactId}/care-episodes`)
      .then(r => r.json())
      .then(d => {
        const arr: CareEpisodeLite[] = Array.isArray(d?.episodes) ? d.episodes : [];
        // Só considera episódios da mesma specialty da sessão + ativos.
        const filtered = arr.filter(ep =>
          ep.specialtyId === specialtyId &&
          (ep.status === 'active' || ep.status === 'on_hold') &&
          ep.primaryProfessionalId === professionalId,
        );
        setEpisodes(filtered);
        setSelectedEpisodeId(filtered[0]?.id || '');
      })
      .catch(() => setEpisodes([]))
      .finally(() => setLoadingEps(false));
  }, [contactId, specialtyId, professionalId]);

  const submit = async () => {
    if (!contactId) { toast.error('Selecione o paciente.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/schedule-sessions/${sessionId}/participants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId,
          careEpisodeId: selectedEpisodeId || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao adicionar.');
      toast.success('Participante adicionado.');
      onAdded();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally { setBusy(false); }
  };

  return (
    <ModalShell title="Adicionar participante" onClose={onClose}>
      <div className="space-y-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Paciente</span>
          <select value={contactId} onChange={e => setContactId(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— selecione —</option>
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` · ${c.identifier}` : ''}</option>
            ))}
          </select>
        </label>
        {contactId && (
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">
              Episódio de tratamento (mesma especialidade + profissional da sessão)
            </span>
            {loadingEps ? (
              <div className="flex items-center gap-2 text-zinc-500 text-xs">
                <Loader2 className="w-3 h-3 animate-spin" /> Carregando episódios…
              </div>
            ) : episodes.length === 0 ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-100">
                Este paciente não tem episódio ativo na especialidade/profissional desta sessão.
                O backend pode aceitar mesmo assim (só cria appointment sem vínculo), mas o ideal
                é abrir episódio primeiro na aba Episódios.
              </div>
            ) : (
              <select value={selectedEpisodeId} onChange={e => setSelectedEpisodeId(e.target.value)}
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
                {episodes.map(ep => (
                  <option key={ep.id} value={ep.id}>
                    Episódio {ep.status === 'active' ? 'ativo' : 'em pausa'} · aberto em {ep.id.slice(0, 6)}…
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        <p className="text-[11px] text-zinc-500 inline-flex items-start gap-1">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            Cada participante gera um <b>appointment individual</b> ligado à sessão. Prontuário,
            lembrete e portal continuam isolados por paciente.
          </span>
        </p>
      </div>
      <ModalActions onClose={onClose}>
        <Button onClick={submit} disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
          Adicionar
        </Button>
      </ModalActions>
    </ModalShell>
  );
}

// ── util ────────────────────────────────────────────────────────────
function ModalShell({ title, subtitle, onClose, children }: {
  title: string; subtitle?: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              {title}
            </h3>
            {subtitle && <p className="text-xs text-zinc-400 mt-1">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 shrink-0" aria-label="Fechar">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-zinc-800">
      <button onClick={onClose} className="h-8 px-3 text-xs text-zinc-300 hover:text-zinc-100">
        Cancelar
      </button>
      {children}
    </div>
  );
}
