/**
 * CareEpisodePanel — Módulo Clínica Fatia 52 (UI da ADR-146).
 * -------------------------------------------------------------------
 * Segunda superfície visual da Jornada de Tratamento. Consome:
 *   - F36: /patients/:contactId/care-episodes (CRUD + hold/resume/transfer/cancel)
 *   - F39: /care-episodes/:id/discharge + /reopen (com PIN, F28)
 *   - F40: /care-journey/counts (badge de fila operacional)
 *
 * Substitui as gambiarras "apagar paciente pra fingir alta" e
 * "recadastrar pra outra especialidade" — agora tudo é primeira
 * classe, com estado (`active`/`on_hold`/`discharged`/`cancelled`) e
 * auditoria (`dischargedBy`, `dischargeSignedWithPin`, `reopenedAt`).
 *
 * Layout:
 *   - Topo: contador operacional (fila F40 counts, link pra Agenda)
 *   - Filtro por paciente (contact_id)
 *   - Lista de episódios do paciente selecionado, agrupada por status:
 *     ATIVOS → EM PAUSA → ALTAS → CANCELADOS
 *   - Botões contextuais por estado:
 *     active  → Pausar / Transferir / Alta (PIN) / Cancelar
 *     on_hold → Retomar / Cancelar
 *     discharged → Reabrir (PIN) — só owner|admin
 *
 * Guardrails (ADR-146):
 *   - discharge/reopen SEMPRE via PinConfirmModal (nunca chama endpoint
 *     direto). Backend F28 mantém o lockout de 5×15min.
 *   - Alta NÃO cancela appointments futuros — só bloqueia novos (RN-007).
 *     UI só avisa ("Verifique agendamentos futuros na Agenda"); a decisão
 *     humana continua na Agenda.
 *   - transfer é owner|admin — o backend devolve 403; o botão continua
 *     visível pra recepção poder pedir pro gestor.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Loader2, Plus, ClipboardList, Info, PauseCircle, PlayCircle,
  Repeat, Ban, LogOut, LogIn, X, User, Stethoscope,
} from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';
import PinConfirmModal, { PinModalProfessional } from '../shared/PinConfirmModal';

type ContactLite = { id: string; name: string; identifier?: string | null };

type Specialty = {
  id: string; name: string; color?: string | null;
  defaultDurationMinutes: number; defaultCycleSessions: number;
  active: boolean;
};

type ProfessionalLite = { id: string; name: string; color?: string | null; active?: boolean | number };

type CareEpisode = {
  id: string;
  organizationId: string;
  contactId: string;
  specialtyId: string;
  primaryProfessionalId: string;
  status: 'active' | 'on_hold' | 'discharged' | 'cancelled';
  startedAt: string;
  onHoldAt?: string | null;
  onHoldReason?: string | null;
  dischargedAt?: string | null;
  dischargeType?: string | null;
  dischargeSummary?: string | null;
  dischargedByProfessionalId?: string | null;
  dischargeSignedWithPin?: boolean;
  reopenedAt?: string | null;
  reopenReason?: string | null;
  cancelledAt?: string | null;
  cancelledReason?: string | null;
  createdAt: string;
  updatedAt: string;
};

type JourneyCounts = {
  activeWithoutSchedule?: number;
  renewalPending?: number;
  transfersRecent?: number;
  futuresAfterDischarge?: number;
} & Record<string, any>;

const DISCHARGE_TYPES: { value: string; label: string }[] = [
  { value: 'clinical_discharge', label: 'Alta clínica (evolução completa)' },
  { value: 'goals_met',          label: 'Metas terapêuticas alcançadas' },
  { value: 'patient_request',    label: 'Solicitação do paciente' },
  { value: 'abandonment',        label: 'Abandono (faltas + sem contato)' },
  { value: 'transfer_out',       label: 'Transferido para fora' },
  { value: 'other',              label: 'Outro (explique no resumo)' },
];

const STATUS_META: Record<CareEpisode['status'], { label: string; cls: string; dot: string }> = {
  active:     { label: 'Ativo',      cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400' },
  on_hold:    { label: 'Em pausa',   cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30',       dot: 'bg-amber-400' },
  discharged: { label: 'Alta',       cls: 'text-zinc-300 bg-zinc-500/10 border-zinc-500/30',           dot: 'bg-zinc-400' },
  cancelled:  { label: 'Cancelado',  cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30',           dot: 'bg-rose-400' },
};

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
};

export default function CareEpisodePanel() {
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalLite[]>([]);
  const [counts, setCounts] = useState<JourneyCounts>({});
  const [contactId, setContactId] = useState<string>('');
  const [episodes, setEpisodes] = useState<CareEpisode[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const loadBase = useCallback(async () => {
    try {
      const [rC, rS, rP, rCounts] = await Promise.all([
        apiFetch('/api/contacts'),
        apiFetch('/api/clinic/specialties'),
        apiFetch('/api/clinic/professionals'),
        apiFetch('/api/clinic/care-journey/counts'),
      ]);
      const [dC, dS, dP, dCounts] = await Promise.all([
        rC.json().catch(() => []),
        rS.json().catch(() => ({})),
        rP.json().catch(() => []),
        rCounts.json().catch(() => ({})),
      ]);
      setContacts(Array.isArray(dC) ? dC : []);
      setSpecialties(Array.isArray(dS?.specialties) ? dS.specialties : []);
      setProfessionals(Array.isArray(dP) ? dP : []);
      setCounts(dCounts?.counts || {});
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar dados base.');
    }
  }, []);

  const loadEpisodes = useCallback(async () => {
    if (!contactId) { setEpisodes([]); return; }
    setLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/patients/${contactId}/care-episodes`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao carregar episódios.');
      setEpisodes(Array.isArray(d?.episodes) ? d.episodes : []);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar episódios.');
      setEpisodes([]);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => { loadEpisodes(); }, [loadEpisodes]);

  const specialtyById = useMemo(
    () => new Map(specialties.map(s => [s.id, s])),
    [specialties],
  );
  const professionalById = useMemo(
    () => new Map(professionals.map(p => [p.id, p])),
    [professionals],
  );

  const grouped = useMemo(() => {
    const g: Record<CareEpisode['status'], CareEpisode[]> = {
      active: [], on_hold: [], discharged: [], cancelled: [],
    };
    for (const ep of episodes) g[ep.status]?.push(ep);
    return g;
  }, [episodes]);

  return (
    <div>
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-2.5 text-xs text-emerald-100">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="leading-relaxed">
          Um <b>episódio</b> é o tratamento de um paciente em uma especialidade, com profissional fixo.
          Cancelar/dar alta <b>NUNCA</b> apaga o paciente — o histórico fica preservado (CFM 20 anos).
        </span>
      </div>

      <JourneyCountsBar counts={counts} />

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
        <div className="ml-auto">
          <Button className="zf-button zf-button-primary" onClick={() => setShowNew(true)} disabled={!contactId}>
            <Plus className="w-4 h-4 mr-2" /> Abrir novo episódio
          </Button>
        </div>
      </div>

      {!contactId ? (
        <div className="py-14 text-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30">
          <ClipboardList className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Selecione um paciente para ver os episódios de tratamento.</p>
          <p className="text-[12px] text-zinc-600 mt-1">Cada episódio agrupa consultas + prontuário + ciclos + guias por especialidade.</p>
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando episódios…
        </div>
      ) : episodes.length === 0 ? (
        <div className="py-14 text-center rounded-xl border border-zinc-800 bg-zinc-900/40">
          <ClipboardList className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Este paciente ainda não tem episódios abertos.</p>
          <p className="text-[12px] text-zinc-600 mt-1">Clique em "Abrir novo episódio" para iniciar o tratamento.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {(['active', 'on_hold', 'discharged', 'cancelled'] as const).map(st => {
            const items = grouped[st];
            if (items.length === 0) return null;
            return (
              <section key={st}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`inline-block w-2 h-2 rounded-full ${STATUS_META[st].dot}`} />
                  <h4 className="text-xs uppercase tracking-wider text-zinc-500">
                    {STATUS_META[st].label} ({items.length})
                  </h4>
                </div>
                <div className="space-y-2">
                  {items.map(ep => (
                    <React.Fragment key={ep.id}>
                      <EpisodeCard
                        episode={ep}
                        specialty={specialtyById.get(ep.specialtyId) || null}
                        professional={professionalById.get(ep.primaryProfessionalId) || null}
                        professionals={professionals}
                        onChanged={() => { loadEpisodes(); loadBase(); }}
                        onSwitchToNewEpisode={() => setShowNew(true)}
                      />
                    </React.Fragment>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {showNew && (
        <NewEpisodeModal
          contactId={contactId}
          patientName={contacts.find(c => c.id === contactId)?.name || null}
          specialties={specialties.filter(s => s.active)}
          professionals={professionals.filter(p => p.active === true || p.active === 1 || p.active === undefined)}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); loadEpisodes(); loadBase(); }}
        />
      )}
    </div>
  );
}

// ── Barra de counts operacionais (F40) ────────────────────────────────
function JourneyCountsBar({ counts }: { counts: JourneyCounts }) {
  const items = [
    { key: 'activeWithoutSchedule', label: 'Sem próximo horário',   cls: 'text-amber-300' },
    { key: 'renewalPending',        label: 'Renovação pendente',    cls: 'text-emerald-300' },
    { key: 'transfersRecent',       label: 'Transferências recentes', cls: 'text-zinc-300' },
    { key: 'futuresAfterDischarge', label: 'Consulta após alta',    cls: 'text-rose-300' },
  ];
  return (
    <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
      {items.map(it => {
        const n = Number((counts as any)?.[it.key] ?? 0);
        return (
          <div key={it.key}
            className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2">
            <div className="text-[11px] text-zinc-500">{it.label}</div>
            <div className={`text-lg font-semibold ${n > 0 ? it.cls : 'text-zinc-500'}`}>{n}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Card individual de episódio + ações ───────────────────────────────
function EpisodeCard({ episode, specialty, professional, professionals, onChanged, onSwitchToNewEpisode }: {
  episode: CareEpisode;
  specialty: Specialty | null;
  professional: ProfessionalLite | null;
  professionals: ProfessionalLite[];
  onChanged: () => void;
  onSwitchToNewEpisode?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showDischarge, setShowDischarge] = useState(false);
  const [showReopen, setShowReopen] = useState(false);

  const call = async (path: string, opts: RequestInit & { successMsg: string }) => {
    const { successMsg, ...init } = opts;
    setBusy(path);
    try {
      const r = await apiFetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha na ação.');
      toast.success(successMsg);
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally {
      setBusy(null);
    }
  };

  const hold = async () => {
    const reason = window.prompt('Motivo da pausa (opcional):') ?? undefined;
    if (reason === null) return;
    await call(`/api/clinic/care-episodes/${episode.id}/hold`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason?.trim() || undefined }),
      successMsg: 'Episódio pausado.',
    });
  };

  const resume = async () => {
    await call(`/api/clinic/care-episodes/${episode.id}/resume`, {
      method: 'POST', body: '{}',
      successMsg: 'Episódio retomado.',
    });
  };

  const cancel = async () => {
    const ok = await confirmDialog(
      'Cancelar um episódio é diferente de dar alta: significa que o episódio foi aberto por engano ou não deve ser mais considerado. O histórico é preservado, mas a UI marca o episódio como cancelado. Prosseguir?',
      { title: 'Cancelar episódio', confirmText: 'Cancelar episódio', danger: true },
    );
    if (!ok) return;
    const reason = window.prompt('Motivo do cancelamento:') ?? '';
    if (!reason.trim()) { toast.error('Motivo é obrigatório para cancelar.'); return; }
    await call(`/api/clinic/care-episodes/${episode.id}/cancel`, {
      method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      successMsg: 'Episódio cancelado.',
    });
  };

  const meta = STATUS_META[episode.status];

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="inline-block w-3 h-3 rounded-full border border-zinc-600"
            style={{ backgroundColor: specialty?.color || '#71717a' }} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-100 truncate">
                {specialty?.name || 'Especialidade removida'}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${meta.cls}`}>
                {meta.label}
              </span>
            </div>
            <div className="text-[11px] text-zinc-500 flex items-center gap-3 flex-wrap mt-0.5">
              <span className="inline-flex items-center gap-1">
                <User className="w-3 h-3" /> {professional?.name || 'Sem profissional'}
              </span>
              <span>Aberto em {fmtDate(episode.startedAt)}</span>
              {episode.status === 'on_hold' && episode.onHoldAt && (
                <span>· pausado em {fmtDate(episode.onHoldAt)}</span>
              )}
              {episode.status === 'discharged' && episode.dischargedAt && (
                <span>· alta em {fmtDate(episode.dischargedAt)}</span>
              )}
              {episode.status === 'cancelled' && episode.cancelledAt && (
                <span>· cancelado em {fmtDate(episode.cancelledAt)}</span>
              )}
            </div>
            {episode.status === 'discharged' && episode.dischargeSummary && (
              <p className="text-[11px] text-zinc-400 mt-1 italic">"{episode.dischargeSummary}"</p>
            )}
            {episode.status === 'on_hold' && episode.onHoldReason && (
              <p className="text-[11px] text-zinc-400 mt-1 italic">"{episode.onHoldReason}"</p>
            )}
            {episode.status === 'cancelled' && episode.cancelledReason && (
              <p className="text-[11px] text-zinc-400 mt-1 italic">"{episode.cancelledReason}"</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {episode.status === 'active' && (
            <>
              <ActionButton icon={PauseCircle} label="Pausar" onClick={hold} busy={busy === `/api/clinic/care-episodes/${episode.id}/hold`} />
              <ActionButton icon={Repeat} label="Transferir" onClick={() => setShowTransfer(true)} />
              <ActionButton icon={LogOut} label="Alta" tone="rose" onClick={() => setShowDischarge(true)} />
              <ActionButton icon={Ban} label="Cancelar" tone="rose" onClick={cancel} busy={busy === `/api/clinic/care-episodes/${episode.id}/cancel`} />
            </>
          )}
          {episode.status === 'on_hold' && (
            <>
              <ActionButton icon={PlayCircle} label="Retomar" onClick={resume} busy={busy === `/api/clinic/care-episodes/${episode.id}/resume`} />
              <ActionButton icon={Ban} label="Cancelar" tone="rose" onClick={cancel} busy={busy === `/api/clinic/care-episodes/${episode.id}/cancel`} />
            </>
          )}
          {episode.status === 'discharged' && (
            <ActionButton icon={LogIn} label="Reabrir" onClick={() => setShowReopen(true)} />
          )}
        </div>
      </div>

      {showTransfer && (
        <TransferEpisodeModal
          episode={episode}
          professionals={professionals}
          onClose={() => setShowTransfer(false)}
          onDone={() => { setShowTransfer(false); onChanged(); }}
          onSwitchToNewEpisode={onSwitchToNewEpisode ? () => {
            setShowTransfer(false);
            onSwitchToNewEpisode();
          } : undefined}
        />
      )}

      {showDischarge && (
        <DischargeModal
          episode={episode}
          professionals={professionals}
          onClose={() => setShowDischarge(false)}
          onDone={() => { setShowDischarge(false); onChanged(); }}
        />
      )}

      {showReopen && (
        <ReopenModal
          episode={episode}
          professionals={professionals}
          onClose={() => setShowReopen(false)}
          onDone={() => { setShowReopen(false); onChanged(); }}
        />
      )}
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, busy, tone }: {
  icon: any; label: string; onClick: () => void; busy?: boolean; tone?: 'rose' | 'default';
}) {
  const isDanger = tone === 'rose';
  return (
    <button onClick={onClick} disabled={busy}
      className={`h-7 px-2 text-[11px] rounded-lg border inline-flex items-center gap-1 ${
        isDanger
          ? 'border-rose-500/40 text-rose-200 hover:bg-rose-500/10'
          : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'
      } disabled:opacity-60`}>
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Icon className="w-3 h-3" />}
      {label}
    </button>
  );
}

// ── Modal: abrir novo episódio ────────────────────────────────────────
function NewEpisodeModal({ contactId, patientName, specialties, professionals, onClose, onCreated }: {
  contactId: string;
  patientName: string | null;
  specialties: Specialty[];
  professionals: ProfessionalLite[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [specialtyId, setSpecialtyId] = useState('');
  const [professionalId, setProfessionalId] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!specialtyId) { toast.error('Selecione a especialidade.'); return; }
    if (!professionalId) { toast.error('Selecione o profissional responsável.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/patients/${contactId}/care-episodes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specialtyId, primaryProfessionalId: professionalId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao abrir episódio.');
      toast.success('Episódio aberto.');
      onCreated();
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao abrir.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Abrir novo episódio" subtitle={patientName || undefined} onClose={onClose}>
      <div className="space-y-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Especialidade</span>
          <select value={specialtyId} onChange={e => setSpecialtyId(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— selecione —</option>
            {specialties.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Profissional responsável (fixo neste episódio)</span>
          <select value={professionalId} onChange={e => setProfessionalId(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— selecione —</option>
            {professionals.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <span className="text-[10px] text-zinc-600 mt-0.5">
            Trocar o profissional depois exige transferência formal (owner/admin).
          </span>
        </label>
      </div>
      <ModalActions onClose={onClose}>
        <Button onClick={submit} disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
          Abrir episódio
        </Button>
      </ModalActions>
    </ModalShell>
  );
}

// ── Modal: transferir profissional (owner|admin) ──────────────────────
function TransferEpisodeModal({ episode, professionals, onClose, onDone, onSwitchToNewEpisode }: {
  episode: CareEpisode;
  professionals: ProfessionalLite[];
  onClose: () => void;
  onDone: () => void;
  /** Ponte pro NewEpisodeModal — evita a confusão "trocar de
   *  especialidade" (que é abrir episódio novo, não transferir). */
  onSwitchToNewEpisode?: () => void;
}) {
  const [toProfessionalId, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!toProfessionalId) { toast.error('Selecione o novo profissional.'); return; }
    if (toProfessionalId === episode.primaryProfessionalId) {
      toast.error('Novo profissional precisa ser diferente do atual.'); return;
    }
    if (!reason.trim()) { toast.error('Motivo da transferência é obrigatório.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/clinic/care-episodes/${episode.id}/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toProfessionalId, reason: reason.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha na transferência.');
      toast.success('Transferência registrada.');
      onDone();
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Transferir episódio" onClose={onClose}
      subtitle="Troca o profissional responsável DENTRO da mesma especialidade.">
      <div className="space-y-3">
        {/* Hint UX: separação clara entre "trocar de profissional" (esta ação)
            e "adicionar/mudar especialidade" (que é abrir episódio novo — o
            paciente permanece; ADR-145 D1). Sem isso, a recepção fica confusa
            porque "transferir" no vocabulário comum é polissêmico. */}
        {onSwitchToNewEpisode && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-100">
            <div className="flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="leading-relaxed">
                  Precisa <b>trocar de especialidade</b> (ex.: paciente vai passar
                  a fazer Psicologia)? Isso é <b>abrir episódio novo</b> — o
                  paciente permanece, os dados cadastrais não são perdidos.
                </p>
                <button onClick={onSwitchToNewEpisode}
                  className="mt-1 h-6 px-2 text-[11px] rounded border border-amber-500/40 text-amber-100 hover:bg-amber-500/10 inline-flex items-center gap-1">
                  Abrir episódio em outra especialidade →
                </button>
              </div>
            </div>
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Novo profissional responsável</span>
          <select value={toProfessionalId} onChange={e => setTo(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— selecione —</option>
            {professionals
              .filter(p => p.id !== episode.primaryProfessionalId)
              .map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <span className="text-[10px] text-zinc-600 mt-0.5">
            Precisa estar vinculado à mesma especialidade. Somente owner/admin.
          </span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Motivo</span>
          <textarea value={reason} onChange={e => setReason(e.target.value)}
            rows={2}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        </label>
      </div>
      <ModalActions onClose={onClose}>
        <Button onClick={submit} disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Repeat className="w-3.5 h-3.5 mr-1" />}
          Transferir
        </Button>
      </ModalActions>
    </ModalShell>
  );
}

// ── Modal: alta com PIN (F39) ─────────────────────────────────────────
function DischargeModal({ episode, professionals, onClose, onDone }: {
  episode: CareEpisode;
  professionals: ProfessionalLite[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [dischargeType, setDischargeType] = useState<string>('clinical_discharge');
  const [summary, setSummary] = useState('');
  const [pinOpen, setPinOpen] = useState(true);

  const pinOptions: PinModalProfessional[] = professionals.map(p => ({ id: p.id, name: p.name }));

  const submit = async ({ professionalId, pin }: { professionalId: string; pin: string }) => {
    if (!summary.trim()) { throw new Error('Resumo da alta é obrigatório.'); }
    const r = await apiFetch(`/api/clinic/care-episodes/${episode.id}/discharge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        professionalId, pin,
        dischargeType,
        summary: summary.trim(),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Traduz mensagens do backend pra o usuário final.
      const code = d?.code || '';
      let msg = d?.error || 'Falha ao dar alta.';
      if (code === 'PIN_INVALID') msg = 'PIN inválido. Verifique e tente novamente.';
      else if (code === 'PIN_LOCKED') {
        const until = d?.until ? new Date(d.until) : null;
        msg = until && !isNaN(until.getTime())
          ? `Bloqueado por tentativas erradas. Tente novamente após ${until.toLocaleTimeString()}.`
          : 'Bloqueado por tentativas erradas. Tente novamente em alguns minutos.';
      }
      throw new Error(msg);
    }
    toast.success('Alta registrada.');
    setPinOpen(false);
    onDone();
  };

  return (
    <PinConfirmModal
      open={pinOpen}
      title="Alta do episódio"
      message="A alta bloqueia novos agendamentos, mas NÃO cancela horários futuros já marcados — verifique a Agenda."
      professionals={pinOptions}
      defaultProfessionalId={episode.primaryProfessionalId}
      confirmLabel="Confirmar alta"
      danger
      onConfirm={submit}
      onClose={() => { setPinOpen(false); onClose(); }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-400">Tipo de alta</span>
        <select value={dischargeType} onChange={e => setDischargeType(e.target.value)}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
          {DISCHARGE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-400">Resumo clínico da alta</span>
        <textarea value={summary} onChange={e => setSummary(e.target.value)}
          rows={3} required
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
      </label>
    </PinConfirmModal>
  );
}

// ── Modal: reabrir com PIN (F39, owner|admin) ─────────────────────────
function ReopenModal({ episode, professionals, onClose, onDone }: {
  episode: CareEpisode;
  professionals: ProfessionalLite[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pinOpen, setPinOpen] = useState(true);
  const pinOptions: PinModalProfessional[] = professionals.map(p => ({ id: p.id, name: p.name }));

  const submit = async ({ professionalId, pin }: { professionalId: string; pin: string }) => {
    if (!reason.trim()) { throw new Error('Motivo da reabertura é obrigatório.'); }
    const r = await apiFetch(`/api/clinic/care-episodes/${episode.id}/reopen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ professionalId, pin, reason: reason.trim() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = d?.code || '';
      let msg = d?.error || 'Falha ao reabrir.';
      if (code === 'PIN_INVALID') msg = 'PIN inválido.';
      else if (code === 'PIN_LOCKED') {
        const until = d?.until ? new Date(d.until) : null;
        msg = until && !isNaN(until.getTime())
          ? `Bloqueado por tentativas erradas. Tente após ${until.toLocaleTimeString()}.`
          : 'Bloqueado por tentativas erradas.';
      }
      throw new Error(msg);
    }
    toast.success('Episódio reaberto.');
    setPinOpen(false);
    onDone();
  };

  return (
    <PinConfirmModal
      open={pinOpen}
      title="Reabrir episódio"
      message="A reabertura é auditada. Somente owner/admin pode reabrir."
      professionals={pinOptions}
      defaultProfessionalId={episode.primaryProfessionalId}
      confirmLabel="Confirmar reabertura"
      onConfirm={submit}
      onClose={() => { setPinOpen(false); onClose(); }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-zinc-400">Motivo da reabertura</span>
        <textarea value={reason} onChange={e => setReason(e.target.value)}
          rows={3} required
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
      </label>
    </PinConfirmModal>
  );
}

// ── ModalShell + ModalActions (util interno) ──────────────────────────
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
              <Stethoscope className="w-4 h-4 text-emerald-400" />
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
      <button onClick={onClose}
        className="h-8 px-3 text-xs text-zinc-300 hover:text-zinc-100">
        Cancelar
      </button>
      {children}
    </div>
  );
}
