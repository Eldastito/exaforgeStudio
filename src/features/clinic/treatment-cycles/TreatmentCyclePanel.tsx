/**
 * TreatmentCyclePanel — Módulo Clínica Fatia 53 (UI da ADR-146).
 * -------------------------------------------------------------------
 * Terceira superfície visual da Jornada de Tratamento. Consome:
 *   - F38 (ciclos: listByEpisode / create / renew / usage / cancel)
 *   - F47 (renewalQueue + renewal-tasks/business_signals)
 *
 * Duas visões numa mesma tela:
 *   1) **Fila de renovação** (topo, org-wide): ciclos ativos com
 *      `remaining <= threshold` ou `renewal_due` ou `pending_authorization`,
 *      + sinais publicados no `business_signals` (F47 sweep).
 *      Recepção enxerga tudo o que precisa ação sem varrer paciente
 *      por paciente.
 *   2) **Detalhe por paciente** (embaixo): seleciona contato → lista
 *      episódios → escolhe um → mostra ciclos históricos + atual com
 *      saldo derivado (RN-004: nunca contador mutável).
 *
 * Guardrails (ADR-146 §Guardrails + ADR-145 §RN-014):
 *   - `renew` e `cancel` são `owner|admin` — recepção enxerga o botão,
 *     backend retorna 403 se não for permitido.
 *   - IA (F47) só publica sinal — a UI mostra e humano confirma. Nunca
 *     renova sozinho.
 *   - Saldo é query-derived — o `usage` vem sempre do backend, sem cache
 *     agressivo (revalida a cada ação).
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Loader2, Repeat, Ban, Info, Layers, Users, RotateCcw, PlayCircle,
  ClipboardList, AlertTriangle, X, Stethoscope, TrendingUp, Plus, ArrowRight,
} from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';
import { useVisibleLimit, ShowMore } from '@/src/components/ShowMore';

type ContactLite = { id: string; name: string; identifier?: string | null };
type Specialty = { id: string; name: string; color?: string | null; defaultCycleSessions: number };
type ProfessionalLite = { id: string; name: string; color?: string | null; active?: boolean | number };

type CycleStatus =
  | 'draft' | 'pending_authorization' | 'active' | 'renewal_due'
  | 'exhausted' | 'renewed' | 'cancelled' | 'expired';

type Cycle = {
  id: string;
  episodeId: string;
  cycleNumber: number;
  previousCycleId: string | null;
  plannedSessions: number;
  noShowConsumesSession: boolean;
  status: CycleStatus;
  guideId?: string | null;
  authorizationId?: string | null;
  startsAt?: string | null;
  renewalRequestedAt?: string | null;
  renewedAt?: string | null;
  cancelledAt?: string | null;
  cancelledReason?: string | null;
  createdAt: string;
};

type CycleUsage = {
  cycleId: string;
  planned: number;
  completed: number;
  noShowConsumed: number;
  scheduled: number;
  remaining: number;
  availableToSchedule: number;
  status: CycleStatus;
};

type Episode = {
  id: string;
  contactId: string;
  specialtyId: string;
  primaryProfessionalId: string;
  status: 'active' | 'on_hold' | 'discharged' | 'cancelled';
  startedAt: string;
};

// Item da renewalQueue (rota GET /treatment-cycles/renewal-queue).
type QueueItem = {
  cycle: Cycle;
  usage: CycleUsage;
  patientName: string | null;
  specialtyName: string | null;
  professionalName: string | null;
};

type BusinessSignal = {
  id: string;
  domain: string;
  signal_type: string;
  severity: string;
  detected_at: string;
  status: string;
  source_entity_id?: string | null;
  evidence?: any;
};

const STATUS_META: Record<CycleStatus, { label: string; cls: string }> = {
  draft:                 { label: 'Rascunho',              cls: 'text-zinc-400 border-zinc-700 bg-zinc-800/40' },
  pending_authorization: { label: 'Aguarda autorização',   cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  active:                { label: 'Ativo',                 cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  renewal_due:           { label: 'Renovar',               cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
  exhausted:             { label: 'Esgotado',              cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
  renewed:               { label: 'Renovado',              cls: 'text-zinc-400 border-zinc-700 bg-zinc-800/40' },
  cancelled:             { label: 'Cancelado',             cls: 'text-zinc-500 border-zinc-700 bg-zinc-800/40' },
  expired:               { label: 'Expirado',              cls: 'text-zinc-500 border-zinc-700 bg-zinc-800/40' },
};

const SEVERITY_META: Record<string, { label: string; cls: string }> = {
  critical:  { label: 'Crítico',   cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
  risk:      { label: 'Alto',      cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
  attention: { label: 'Atenção',   cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  info:      { label: 'Info',      cls: 'text-zinc-300 border-zinc-700 bg-zinc-800/40' },
};

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

export default function TreatmentCyclePanel() {
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalLite[]>([]);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [signals, setSignals] = useState<BusinessSignal[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);

  const [contactId, setContactId] = useState<string>('');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string>('');
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [usageByCycle, setUsageByCycle] = useState<Map<string, CycleUsage>>(new Map());
  const [detailLoading, setDetailLoading] = useState(false);

  const loadBase = useCallback(async () => {
    try {
      const [rC, rS, rP] = await Promise.all([
        apiFetch('/api/contacts'),
        apiFetch('/api/clinic/specialties'),
        apiFetch('/api/clinic/professionals'),
      ]);
      const [dC, dS, dP] = await Promise.all([
        rC.json().catch(() => []),
        rS.json().catch(() => ({})),
        rP.json().catch(() => []),
      ]);
      setContacts(Array.isArray(dC) ? dC : []);
      setSpecialties(Array.isArray(dS?.specialties) ? dS.specialties : []);
      setProfessionals(Array.isArray(dP) ? dP : []);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar dados base.');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const [rQ, rS] = await Promise.all([
        apiFetch('/api/clinic/treatment-cycles/renewal-queue'),
        apiFetch('/api/clinic/renewal-tasks'),
      ]);
      const dQ = await rQ.json().catch(() => ({}));
      const dS = await rS.json().catch(() => ({}));
      setQueue(Array.isArray(dQ?.queue) ? dQ.queue : []);
      setSignals(Array.isArray(dS?.signals) ? dS.signals.filter((s: any) => s.status === 'open') : []);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar fila de renovação.');
    } finally {
      setQueueLoading(false);
    }
  }, []);

  const loadEpisodes = useCallback(async () => {
    if (!contactId) { setEpisodes([]); setSelectedEpisodeId(''); return; }
    try {
      const r = await apiFetch(`/api/clinic/patients/${contactId}/care-episodes`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao carregar episódios.');
      const list: Episode[] = Array.isArray(d?.episodes) ? d.episodes : [];
      setEpisodes(list);
      // Auto-seleciona o 1º ativo, senão o 1º da lista.
      const firstActive = list.find(ep => ep.status === 'active') || list[0];
      setSelectedEpisodeId(firstActive?.id || '');
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar episódios.');
      setEpisodes([]);
      setSelectedEpisodeId('');
    }
  }, [contactId]);

  const loadCycles = useCallback(async () => {
    if (!selectedEpisodeId) { setCycles([]); setUsageByCycle(new Map()); return; }
    setDetailLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/care-episodes/${selectedEpisodeId}/cycles`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao carregar ciclos.');
      const list: Cycle[] = Array.isArray(d?.cycles) ? d.cycles : [];
      setCycles(list);
      // Carrega usage só dos ciclos "vivos" (active-like) — histórico não muda.
      const alive = list.filter(c =>
        c.status === 'active' || c.status === 'renewal_due' || c.status === 'pending_authorization',
      );
      const results = await Promise.all(alive.map(async c => {
        try {
          const rr = await apiFetch(`/api/clinic/treatment-cycles/${c.id}/usage`);
          const dd = await rr.json().catch(() => ({}));
          return rr.ok ? [c.id, dd?.usage as CycleUsage] as const : null;
        } catch { return null; }
      }));
      const m = new Map<string, CycleUsage>();
      for (const it of results) if (it) m.set(it[0], it[1]);
      setUsageByCycle(m);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar ciclos.');
      setCycles([]); setUsageByCycle(new Map());
    } finally {
      setDetailLoading(false);
    }
  }, [selectedEpisodeId]);

  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => { loadQueue(); }, [loadQueue]);
  useEffect(() => { loadEpisodes(); }, [loadEpisodes]);
  useEffect(() => { loadCycles(); }, [loadCycles]);

  const specialtyById = useMemo(() => new Map(specialties.map(s => [s.id, s])), [specialties]);
  const professionalById = useMemo(() => new Map(professionals.map(p => [p.id, p])), [professionals]);
  const contactById = useMemo(() => new Map(contacts.map(c => [c.id, c])), [contacts]);

  const reloadAll = () => { loadQueue(); loadCycles(); };

  // Ao clicar num item da fila, joga o usuário direto pro detalhe do episódio.
  const jumpToEpisode = (item: QueueItem) => {
    const ep = episodes.find(e => e.id === item.cycle.episodeId);
    if (ep) {
      setContactId(ep.contactId);
      setSelectedEpisodeId(ep.id);
    } else {
      // Não temos o paciente carregado ainda — precisa buscar via cycle.
      // Faz o hop indireto: seta o contactId (se conhecido) via patientName vs contacts.
      const c = contacts.find(x => (item.patientName || '').trim() === (x.name || '').trim());
      if (c) {
        setContactId(c.id);
        setSelectedEpisodeId(item.cycle.episodeId);
      } else {
        toast.info('Paciente do ciclo não está na sua lista atual. Selecione manualmente para ver o detalhe.');
      }
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-2.5 text-xs text-emerald-100">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="leading-relaxed">
          O <b>saldo do ciclo</b> vem sempre da agenda real (RN-004 — nunca contador mutável).
          A IA <b>só sinaliza</b> a fila de renovação; renovar e cancelar continuam sendo decisão humana.
        </span>
      </div>

      <RenewalQueueSection
        queue={queue}
        signals={signals}
        loading={queueLoading}
        onRenewed={reloadAll}
        onJump={jumpToEpisode}
      />

      <hr className="border-zinc-800 my-6" />

      {/* Detalhe por paciente */}
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <Layers className="w-4 h-4 text-emerald-400" />
        <h3 className="text-base font-semibold text-zinc-100">Ciclos por paciente</h3>
      </div>

      <div className="mb-4 flex items-end gap-3 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="flex flex-col gap-1 min-w-[240px] flex-1">
          <span className="text-[11px] text-zinc-400">Paciente</span>
          <select value={contactId} onChange={e => setContactId(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— selecione —</option>
            {contacts.map(c => (
              <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` · ${c.identifier}` : ''}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 min-w-[240px] flex-1">
          <span className="text-[11px] text-zinc-400">Episódio</span>
          <select value={selectedEpisodeId} onChange={e => setSelectedEpisodeId(e.target.value)}
            disabled={!contactId || episodes.length === 0}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 disabled:opacity-50">
            {!contactId && <option value="">— selecione paciente antes —</option>}
            {contactId && episodes.length === 0 && <option value="">— sem episódios —</option>}
            {episodes.map(ep => {
              const sp = specialtyById.get(ep.specialtyId);
              const st = ep.status === 'active' ? '' : ` (${ep.status})`;
              return (
                <option key={ep.id} value={ep.id}>
                  {sp?.name || 'Especialidade removida'}{st}
                </option>
              );
            })}
          </select>
        </label>
      </div>

      {!contactId ? (
        <div className="py-14 text-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30">
          <ClipboardList className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">
            Selecione um paciente para ver seus ciclos.
          </p>
          <p className="text-[12px] text-zinc-600 mt-1">
            Cada episódio tem N ciclos históricos + no máximo 1 ciclo vivo por vez.
          </p>
        </div>
      ) : detailLoading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando ciclos…
        </div>
      ) : !selectedEpisodeId ? (
        <div className="py-14 text-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30">
          <ClipboardList className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Este paciente não tem episódios abertos.</p>
          <p className="text-[12px] text-zinc-600 mt-1">Abra um episódio na aba "Episódios" para começar.</p>
        </div>
      ) : (
        <CycleDetail
          episode={episodes.find(e => e.id === selectedEpisodeId) || null}
          cycles={cycles}
          usageByCycle={usageByCycle}
          specialty={specialties.find(s => s.id === episodes.find(e => e.id === selectedEpisodeId)?.specialtyId) || null}
          professional={professionalById.get(episodes.find(e => e.id === selectedEpisodeId)?.primaryProfessionalId || '') || null}
          patient={contactById.get(contactId) || null}
          onChanged={reloadAll}
        />
      )}
    </div>
  );
}

// ── Seção: Fila de renovação (topo) ────────────────────────────────────
function RenewalQueueSection({ queue, signals, loading, onRenewed, onJump }: {
  queue: QueueItem[];
  signals: BusinessSignal[];
  loading: boolean;
  onRenewed: () => void;
  onJump: (item: QueueItem) => void;
}) {
  const [runningSweep, setRunningSweep] = useState(false);
  const [renewingId, setRenewingId] = useState<string | null>(null);
  const queuePage = useVisibleLimit(queue);

  const runSweep = async () => {
    setRunningSweep(true);
    try {
      const r = await apiFetch('/api/clinic/renewal-tasks/run', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha no sweep.');
      const res = d?.result || {};
      toast.success(
        `Sweep OK — ${res.published ?? 0} novos, ${res.deduped ?? 0} atualizados, ${res.resolved ?? 0} resolvidos.`,
      );
      onRenewed();
    } catch (e: any) {
      toast.error(e?.message || 'Falha no sweep.');
    } finally {
      setRunningSweep(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <TrendingUp className="w-4 h-4 text-amber-300" />
        <h3 className="text-base font-semibold text-zinc-100">Fila de renovação</h3>
        <span className="text-[11px] text-zinc-500">
          {queue.length} ciclo(s) · {signals.length} sinal(is) aberto(s)
        </span>
        <button onClick={runSweep} disabled={runningSweep}
          className="ml-auto h-7 px-2 text-[11px] rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1 disabled:opacity-60">
          {runningSweep ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          Reprocessar
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-6">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando fila…
        </div>
      ) : queue.length === 0 ? (
        <div className="py-8 text-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30">
          <p className="text-sm text-zinc-300">Nenhum ciclo aguardando renovação. 🎯</p>
          <p className="text-[12px] text-zinc-600 mt-1">O sweep roda automaticamente no Scheduler.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {queuePage.visible.map(item => (
            <React.Fragment key={item.cycle.id}>
              <QueueRow item={item}
                signalForCycle={signals.find(s => s.source_entity_id === item.cycle.id) || null}
                renewingId={renewingId} setRenewingId={setRenewingId}
                onRenewed={onRenewed}
                onJump={() => onJump(item)} />
            </React.Fragment>
          ))}
          <ShowMore page={queuePage} noun="ciclos" />
        </div>
      )}
    </div>
  );
}

function QueueRow({ item, signalForCycle, renewingId, setRenewingId, onRenewed, onJump }: {
  item: QueueItem;
  signalForCycle: BusinessSignal | null;
  renewingId: string | null;
  setRenewingId: (id: string | null) => void;
  onRenewed: () => void;
  onJump: () => void;
}) {
  const [showRenew, setShowRenew] = useState(false);
  const meta = STATUS_META[item.cycle.status];
  const sev = signalForCycle ? SEVERITY_META[signalForCycle.severity] : null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-100 truncate">
              {item.patientName || 'Paciente'}
            </span>
            <span className="text-[11px] text-zinc-500">·</span>
            <span className="text-xs text-zinc-300 truncate">{item.specialtyName || 'Especialidade'}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label}</span>
            {sev && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${sev.cls}`}>
                Sinal: {sev.label}
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500 mt-1 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <Users className="w-3 h-3" /> {item.professionalName || 'Sem profissional'}
            </span>
            <span>Ciclo {item.cycle.cycleNumber}</span>
            <span>·</span>
            <span>
              {item.usage.completed}/{item.usage.planned} feitas
              {' · '}
              {item.usage.remaining} restante(s)
              {' · '}
              {item.usage.scheduled} agendada(s)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button onClick={onJump}
            className="h-7 px-2 text-[11px] rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1">
            Detalhes <ArrowRight className="w-3 h-3" />
          </button>
          <button onClick={() => setShowRenew(true)}
            disabled={renewingId === item.cycle.id || item.cycle.status === 'pending_authorization'}
            title={item.cycle.status === 'pending_authorization' ? 'Aguardando guia emitida' : undefined}
            className="h-7 px-2 text-[11px] rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center gap-1 disabled:opacity-50 disabled:hover:bg-transparent">
            <Repeat className="w-3 h-3" /> Renovar
          </button>
        </div>
      </div>

      {showRenew && (
        <RenewModal cycle={item.cycle}
          patientName={item.patientName}
          onClose={() => setShowRenew(false)}
          onDone={() => { setShowRenew(false); onRenewed(); }}
          setRenewingId={setRenewingId} />
      )}
    </div>
  );
}

// ── Detalhe por paciente ──────────────────────────────────────────────
function CycleDetail({ episode, cycles, usageByCycle, specialty, professional, patient, onChanged }: {
  episode: Episode | null;
  cycles: Cycle[];
  usageByCycle: Map<string, CycleUsage>;
  specialty: Specialty | null;
  professional: ProfessionalLite | null;
  patient: ContactLite | null;
  onChanged: () => void;
}) {
  const [showNew, setShowNew] = useState(false);
  if (!episode) return null;

  const activeCycle = cycles.find(c =>
    c.status === 'active' || c.status === 'renewal_due' || c.status === 'pending_authorization',
  );
  const history = cycles.filter(c => c !== activeCycle);

  return (
    <div className="space-y-4">
      {/* Cabeçalho do episódio */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-block w-3 h-3 rounded-full border border-zinc-600"
            style={{ backgroundColor: specialty?.color || '#71717a' }} />
          <span className="text-sm font-medium text-zinc-100">{patient?.name || 'Paciente'}</span>
          <span className="text-[11px] text-zinc-500">·</span>
          <span className="text-xs text-zinc-300">{specialty?.name || 'Especialidade'}</span>
          <span className="text-[11px] text-zinc-500">·</span>
          <span className="text-xs text-zinc-400 inline-flex items-center gap-1">
            <Stethoscope className="w-3 h-3" /> {professional?.name || 'Sem profissional'}
          </span>
        </div>
      </div>

      {/* Ciclo atual */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <PlayCircle className="w-4 h-4 text-emerald-400" />
          <h4 className="text-sm font-semibold text-zinc-100">Ciclo atual</h4>
          {activeCycle && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_META[activeCycle.status].cls}`}>
              {STATUS_META[activeCycle.status].label}
            </span>
          )}
          {!activeCycle && (episode.status === 'active' || episode.status === 'on_hold') && (
            <Button onClick={() => setShowNew(true)}
              className="ml-auto bg-emerald-600 hover:bg-emerald-700 text-white h-7 px-2 text-[11px]">
              <Plus className="w-3.5 h-3.5 mr-1" /> Abrir 1º ciclo
            </Button>
          )}
        </div>

        {activeCycle ? (
          <CycleCard cycle={activeCycle}
            usage={usageByCycle.get(activeCycle.id) || null}
            isCurrent
            onChanged={onChanged} />
        ) : (
          <div className="py-6 text-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30">
            <p className="text-sm text-zinc-300">Nenhum ciclo vivo neste episódio.</p>
            <p className="text-[12px] text-zinc-600 mt-1">
              {episode.status !== 'active' && episode.status !== 'on_hold'
                ? 'Episódio não está ativo — não é possível abrir ciclo.'
                : 'Abra o 1º ciclo para começar o tratamento.'}
            </p>
          </div>
        )}
      </div>

      {/* Histórico */}
      {history.length > 0 && (
        <div>
          <h4 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">
            Histórico ({history.length})
          </h4>
          <div className="space-y-2">
            {history.map(c => (
              <React.Fragment key={c.id}>
                <CycleCard cycle={c} usage={null} isCurrent={false} onChanged={onChanged} />
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {showNew && episode && (
        <NewCycleModal episode={episode}
          defaultPlanned={specialty?.defaultCycleSessions || 10}
          onClose={() => setShowNew(false)}
          onDone={() => { setShowNew(false); onChanged(); }} />
      )}
    </div>
  );
}

function CycleCard({ cycle, usage, isCurrent, onChanged }: {
  cycle: Cycle;
  usage: CycleUsage | null;
  isCurrent: boolean;
  onChanged: () => void;
}) {
  const [showRenew, setShowRenew] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = STATUS_META[cycle.status];

  const cancel = async () => {
    const ok = await confirmDialog(
      'Cancelar um ciclo é diferente de encerrar por esgotamento: significa que ele foi aberto por engano ou não deve ser considerado. Prosseguir?',
      { title: `Cancelar ciclo ${cycle.cycleNumber}`, confirmText: 'Cancelar ciclo', danger: true },
    );
    if (!ok) return;
    const reason = window.prompt('Motivo do cancelamento:') ?? '';
    if (!reason.trim()) { toast.error('Motivo é obrigatório.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/treatment-cycles/${cycle.id}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao cancelar.');
      toast.success('Ciclo cancelado.');
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally { setBusy(false); }
  };

  const pct = usage && usage.planned > 0
    ? Math.min(100, Math.round((usage.completed / usage.planned) * 100))
    : 0;

  return (
    <div className={`rounded-xl border p-3 ${
      isCurrent ? 'border-zinc-700 bg-zinc-900/60' : 'border-zinc-800 bg-zinc-900/30'
    }`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-zinc-100">Ciclo #{cycle.cycleNumber}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label}</span>
            {cycle.status === 'pending_authorization' && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-300">
                <AlertTriangle className="w-3 h-3" /> aguarda guia
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-3 flex-wrap">
            <span>Criado em {fmtDate(cycle.createdAt)}</span>
            {cycle.renewedAt && <span>· renovado em {fmtDate(cycle.renewedAt)}</span>}
            {cycle.cancelledAt && <span>· cancelado em {fmtDate(cycle.cancelledAt)}</span>}
            <span>· {cycle.plannedSessions} sessão(ões) planejada(s)</span>
            {cycle.noShowConsumesSession && <span>· falta consome sessão</span>}
          </div>
          {cycle.cancelledReason && (
            <p className="text-[11px] text-zinc-400 mt-1 italic">"{cycle.cancelledReason}"</p>
          )}
        </div>
        {isCurrent && cycle.status !== 'pending_authorization' && (
          <div className="flex items-center gap-1.5">
            <button onClick={() => setShowRenew(true)} disabled={busy}
              className="h-7 px-2 text-[11px] rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center gap-1">
              <Repeat className="w-3 h-3" /> Renovar
            </button>
            <button onClick={cancel} disabled={busy}
              className="h-7 px-2 text-[11px] rounded-lg border border-rose-500/40 text-rose-200 hover:bg-rose-500/10 inline-flex items-center gap-1">
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Cancelar
            </button>
          </div>
        )}
      </div>

      {usage && isCurrent && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-[11px] text-zinc-400 mb-1">
            <span>{usage.completed}/{usage.planned} feitas</span>
            <span>{usage.remaining} restante(s) · {usage.scheduled} agendada(s)</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className={`h-full ${
              usage.remaining <= 0 ? 'bg-rose-500' : usage.remaining <= 2 ? 'bg-amber-400' : 'bg-emerald-500'
            }`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {showRenew && (
        <RenewModal cycle={cycle}
          patientName={null}
          onClose={() => setShowRenew(false)}
          onDone={() => { setShowRenew(false); onChanged(); }}
          setRenewingId={() => {}} />
      )}
    </div>
  );
}

// ── Modais ─────────────────────────────────────────────────────────────
function RenewModal({ cycle, patientName, onClose, onDone, setRenewingId }: {
  cycle: Cycle;
  patientName: string | null;
  onClose: () => void;
  onDone: () => void;
  setRenewingId: (id: string | null) => void;
}) {
  const [planned, setPlanned] = useState<number>(cycle.plannedSessions);
  const [noShowConsumes, setNoShowConsumes] = useState<boolean>(cycle.noShowConsumesSession);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (planned < 1 || planned > 200) { toast.error('Sessões planejadas entre 1 e 200.'); return; }
    setBusy(true);
    setRenewingId(cycle.id);
    try {
      const r = await apiFetch(`/api/clinic/treatment-cycles/${cycle.id}/renew`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plannedSessions: planned, noShowConsumesSession: noShowConsumes }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao renovar.');
      toast.success(`Ciclo #${d.current?.cycleNumber ?? '?'} aberto.`);
      onDone();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally {
      setBusy(false);
      setRenewingId(null);
    }
  };

  return (
    <ModalShell title={`Renovar ciclo #${cycle.cycleNumber}`}
      subtitle={patientName ? `Paciente: ${patientName}` : undefined}
      onClose={onClose}>
      <div className="space-y-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Sessões planejadas (novo ciclo)</span>
          <input type="number" min={1} max={200} value={planned}
            onChange={e => setPlanned(Number(e.target.value) || cycle.plannedSessions)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={noShowConsumes} onChange={e => setNoShowConsumes(e.target.checked)}
            className="accent-emerald-500" />
          <span className="text-xs text-zinc-300">Faltas (no-show) consomem sessão do ciclo</span>
        </label>
        <p className="text-[11px] text-zinc-500">
          Renovação é auditada — só owner/admin pode fazer. O ciclo anterior vira <b>renovado</b>
          e um novo é aberto com numeração sequencial.
        </p>
      </div>
      <ModalActions onClose={onClose}>
        <Button onClick={submit} disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Repeat className="w-3.5 h-3.5 mr-1" />}
          Renovar
        </Button>
      </ModalActions>
    </ModalShell>
  );
}

function NewCycleModal({ episode, defaultPlanned, onClose, onDone }: {
  episode: Episode;
  defaultPlanned: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [planned, setPlanned] = useState<number>(defaultPlanned);
  const [noShowConsumes, setNoShowConsumes] = useState<boolean>(false);
  const [requiresGuide, setRequiresGuide] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (planned < 1 || planned > 200) { toast.error('Sessões planejadas entre 1 e 200.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/care-episodes/${episode.id}/cycles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plannedSessions: planned,
          noShowConsumesSession: noShowConsumes,
          requiresGuide,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao abrir ciclo.');
      toast.success(`Ciclo #${d.cycle?.cycleNumber ?? 1} aberto.`);
      onDone();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally { setBusy(false); }
  };

  return (
    <ModalShell title="Abrir novo ciclo" onClose={onClose}>
      <div className="space-y-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Sessões planejadas</span>
          <input type="number" min={1} max={200} value={planned}
            onChange={e => setPlanned(Number(e.target.value) || defaultPlanned)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          <span className="text-[10px] text-zinc-600 mt-0.5">
            Default vem da especialidade ({defaultPlanned}).
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={noShowConsumes} onChange={e => setNoShowConsumes(e.target.checked)}
            className="accent-emerald-500" />
          <span className="text-xs text-zinc-300">Faltas consomem sessão do ciclo</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={requiresGuide} onChange={e => setRequiresGuide(e.target.checked)}
            className="accent-emerald-500" />
          <span className="text-xs text-zinc-300">
            Exige guia emitida antes de agendar (nasce "aguarda autorização")
          </span>
        </label>
      </div>
      <ModalActions onClose={onClose}>
        <Button onClick={submit} disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
          Abrir ciclo
        </Button>
      </ModalActions>
    </ModalShell>
  );
}

function ModalShell({ title, subtitle, onClose, children }: {
  title: string; subtitle?: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-800">
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
