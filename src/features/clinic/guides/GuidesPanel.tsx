/**
 * GuidesPanel — Módulo Clínica Fatia 55 (UI da ADR-146).
 * -------------------------------------------------------------------
 * Quinta e última superfície visual da Jornada de Tratamento. Consome:
 *   - F44 (clinical_guides polimorfo: 3 tipos)
 *   - F45 (PDF por tipo + envio HMAC)
 *   - F46 (ligação guide↔cycle: emissão ativa ciclo em pending_authorization)
 *   - F48 (draft IA — pré-preenche com missing:true no que falta)
 *
 * Substitui a gambiarra clássica "recepção emite guia num Word e cola a
 * autorização à mão" — agora guia é primeira classe:
 *   - 3 tipos polimorfos (TISS/encaminhamento/pedido médico)
 *   - Numeração série própria por tipo (TISS-000123, REF-000045, PM-000078)
 *   - Emissão congela snapshot canônico (Fase 29) — renomear paciente
 *     depois NÃO altera guia
 *   - PDF autenticado + envio via canal do paciente com HMAC
 *
 * Layout:
 *   - Filtros (contact opcional, status, tipo)
 *   - Lista de guias (mais recentes primeiro), badge por status
 *   - Ações por status:
 *     draft → Editar / Emitir / Cancelar
 *     issued → PDF / Enviar / Cancelar
 *     submitted/approved/denied/expired/cancelled → PDF (histórico)
 *   - Modal Nova/Editar guia (polimorfo por tipo) com botão IA (F48)
 *
 * Guardrails RN-014 (headers dos services + UI reforça visualmente):
 *   - GuideDraftButton NUNCA persiste (só sugere).
 *   - Campos que a IA marca {missing:true} vêm com aviso âmbar no form;
 *     humano PRECISA preencher (TUSS, carteirinha, autorização) — a IA
 *     não inventa.
 *   - Cancelar guia restrito a owner|admin — botão sempre visível,
 *     backend 403 se necessário.
 *   - Envio checa consent LGPD (backend) — mensagem clara em 403.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Loader2, Plus, X, Info, FileText, Send, Eye, Ban, Sparkles,
  AlertTriangle, ClipboardList, ArrowUpRight, Pencil, Check, User,
} from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

type ContactLite = { id: string; name: string; identifier?: string | null };
type ProfessionalLite = { id: string; name: string; active?: boolean | number };
type Operator = { id: string; name: string; ansCode?: string | null };
type Procedure = { id: string; code: string; description: string; tussCode?: string | null };

type GuideType = 'tiss_authorization' | 'referral' | 'medical_order';
type GuideStatus = 'draft' | 'issued' | 'submitted' | 'approved' | 'denied' | 'expired' | 'cancelled';

type Guide = {
  id: string;
  internalNumber: string;
  guideType: GuideType;
  contactId: string;
  episodeId: string | null;
  cycleId: string | null;
  authorizationId: string | null;
  operatorId: string | null;
  procedureId: string | null;
  professionalId: string | null;
  totalSessions: number | null;
  validFrom: string | null;
  validUntil: string | null;
  status: GuideStatus;
  snapshotJson: any | null;
  cancelledReason: string | null;
  cancelledAt: string | null;
  issuedAt: string | null;
  createdAt: string;
};

type DraftField = { value: any; missing: boolean; source?: string; reason?: string };
type DraftResponse = {
  guideType: GuideType;
  contactId: string;
  contactName: string | null;
  professionalId: string | null;
  episodeId: string | null;
  cycleId: string | null;
  fields: Record<string, DraftField>;
  warnings: string[];
};

const TYPE_META: Record<GuideType, { label: string; short: string; icon: React.ReactNode; hint: string }> = {
  tiss_authorization: {
    label: 'Autorização TISS',
    short: 'TISS',
    icon: <ClipboardList className="w-3.5 h-3.5" />,
    hint: 'Guia p/ convênio (TUSS + carteirinha + operadora + validade).',
  },
  referral: {
    label: 'Encaminhamento',
    short: 'REF',
    icon: <ArrowUpRight className="w-3.5 h-3.5" />,
    hint: 'Envia paciente pra outra especialidade — motivo é sempre novo (RN-014).',
  },
  medical_order: {
    label: 'Pedido médico',
    short: 'PM',
    icon: <FileText className="w-3.5 h-3.5" />,
    hint: 'Solicitação de exames/procedimentos com CID + lista de itens.',
  },
};

const STATUS_META: Record<GuideStatus, { label: string; cls: string }> = {
  draft:      { label: 'Rascunho',    cls: 'text-zinc-300 border-zinc-700 bg-zinc-800/40' },
  issued:     { label: 'Emitida',     cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  submitted:  { label: 'Enviada',     cls: 'text-sky-300 border-sky-500/40 bg-sky-500/10' },
  approved:   { label: 'Aprovada',    cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
  denied:     { label: 'Negada',      cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
  expired:    { label: 'Expirada',    cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10' },
  cancelled:  { label: 'Cancelada',   cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
};

const fmtDate = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
};

export default function GuidesPanel() {
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalLite[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);

  const [filterContact, setFilterContact] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [guides, setGuides] = useState<Guide[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState<{ mode: 'new' } | { mode: 'edit'; guide: Guide } | null>(null);

  const loadBase = useCallback(async () => {
    try {
      const [rC, rP, rO, rProc] = await Promise.all([
        apiFetch('/api/contacts'),
        apiFetch('/api/clinic/professionals'),
        apiFetch('/api/clinic/operators'),
        apiFetch('/api/clinic/procedures'),
      ]);
      const [dC, dP, dO, dProc] = await Promise.all([
        rC.json().catch(() => []),
        rP.json().catch(() => []),
        rO.json().catch(() => []),
        rProc.json().catch(() => []),
      ]);
      setContacts(Array.isArray(dC) ? dC : []);
      setProfessionals(Array.isArray(dP) ? dP : []);
      // /operators e /procedures retornam array direto ou { items } — trata os dois.
      setOperators(Array.isArray(dO) ? dO : Array.isArray(dO?.operators) ? dO.operators : Array.isArray(dO?.items) ? dO.items : []);
      setProcedures(Array.isArray(dProc) ? dProc : Array.isArray(dProc?.procedures) ? dProc.procedures : Array.isArray(dProc?.items) ? dProc.items : []);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar dados base.');
    }
  }, []);

  const loadGuides = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (filterContact) qs.set('contactId', filterContact);
      if (filterStatus) qs.set('status', filterStatus);
      if (filterType) qs.set('type', filterType);
      const r = await apiFetch(`/api/clinic/guides${qs.toString() ? '?' + qs.toString() : ''}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao carregar guias.');
      setGuides(Array.isArray(d?.guides) ? d.guides : []);
    } catch (e: any) {
      toast.error(e?.message || 'Falha.');
      setGuides([]);
    } finally { setLoading(false); }
  }, [filterContact, filterStatus, filterType]);

  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => { loadGuides(); }, [loadGuides]);

  const contactById = useMemo(() => new Map<string, ContactLite>(contacts.map(c => [c.id, c])), [contacts]);
  const professionalById = useMemo(() => new Map<string, ProfessionalLite>(professionals.map(p => [p.id, p])), [professionals]);
  const operatorById = useMemo(() => new Map<string, Operator>(operators.map(o => [o.id, o])), [operators]);
  const procedureById = useMemo(() => new Map<string, Procedure>(procedures.map(p => [p.id, p])), [procedures]);

  return (
    <div>
      <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-2.5 text-xs text-emerald-100">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        <span className="leading-relaxed">
          <b>3 tipos de guia</b>: TISS (convênio) · Encaminhamento · Pedido médico. Numeração
          série própria. Emissão congela snapshot canônico — renomear paciente depois não
          altera a guia. <b>Rascunho IA</b> pré-preenche com o que existe e marca em âmbar
          o que a IA <b>não pode inventar</b> (TUSS, carteirinha, autorização).
        </span>
      </div>

      {/* Filtros */}
      <div className="mb-4 flex items-end gap-3 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <label className="flex flex-col gap-1 min-w-[220px] flex-1">
          <span className="text-[11px] text-zinc-400">Paciente (opcional)</span>
          <select value={filterContact} onChange={e => setFilterContact(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— todos —</option>
            {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Tipo</span>
          <select value={filterType} onChange={e => setFilterType(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— todos —</option>
            {(Object.keys(TYPE_META) as GuideType[]).map(t => (
              <option key={t} value={t}>{TYPE_META[t].label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-400">Status</span>
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
            <option value="">— todos —</option>
            {(Object.keys(STATUS_META) as GuideStatus[]).map(s => (
              <option key={s} value={s}>{STATUS_META[s].label}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <Button className="zf-button zf-button-primary" onClick={() => setShowForm({ mode: 'new' })}
            disabled={contacts.length === 0}>
            <Plus className="w-4 h-4 mr-2" /> Nova guia
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando guias…
        </div>
      ) : guides.length === 0 ? (
        <div className="py-14 text-center rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30">
          <FileText className="w-8 h-8 text-emerald-400/70 mx-auto mb-2" />
          <p className="text-sm text-zinc-300 font-medium">Nenhuma guia neste filtro.</p>
          <p className="text-[12px] text-zinc-600 mt-1">Clique em "Nova guia" para criar uma.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {guides.map(g => (
            <GuideRow key={g.id}
              guide={g}
              contact={contactById.get(g.contactId) || null}
              professional={g.professionalId ? professionalById.get(g.professionalId) || null : null}
              operator={g.operatorId ? operatorById.get(g.operatorId) || null : null}
              procedure={g.procedureId ? procedureById.get(g.procedureId) || null : null}
              onChanged={loadGuides}
              onEdit={() => setShowForm({ mode: 'edit', guide: g })}
            />
          ))}
        </div>
      )}

      {showForm && (
        <GuideFormModal
          mode={showForm.mode}
          initial={showForm.mode === 'edit' ? showForm.guide : null}
          contacts={contacts}
          professionals={professionals}
          operators={operators}
          procedures={procedures}
          onClose={() => setShowForm(null)}
          onSaved={() => { setShowForm(null); loadGuides(); }}
        />
      )}
    </div>
  );
}

// ── Linha da guia + ações contextuais ────────────────────────────────
type GuideRowProps = {
  guide: Guide;
  contact: ContactLite | null;
  professional: ProfessionalLite | null;
  operator: Operator | null;
  procedure: Procedure | null;
  onChanged: () => void;
  onEdit: () => void;
};

const GuideRow: React.FC<GuideRowProps> = ({ guide, contact, professional, operator, procedure, onChanged, onEdit }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const t = TYPE_META[guide.guideType];
  const s = STATUS_META[guide.status];
  const isDraft = guide.status === 'draft';
  const isIssued = guide.status === 'issued';
  const isTerminal = ['approved', 'denied', 'expired', 'cancelled'].includes(guide.status);
  const canCancel = isDraft || isIssued;

  const issue = async () => {
    const ok = await confirmDialog(
      `Emitir a guia ${guide.internalNumber}? Após emissão, o snapshot fica congelado (imutável).`,
      { title: 'Emitir guia', confirmText: 'Emitir' },
    );
    if (!ok) return;
    setBusy('issue');
    try {
      const r = await apiFetch(`/api/clinic/guides/${guide.id}/issue`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao emitir.');
      toast.success('Guia emitida.');
      onChanged();
    } catch (e: any) { toast.error(e?.message || 'Falha.'); }
    finally { setBusy(null); }
  };

  const cancel = async () => {
    const ok = await confirmDialog(
      `Cancelar a guia ${guide.internalNumber}? A linha é preservada no histórico.`,
      { title: 'Cancelar guia', confirmText: 'Cancelar guia', danger: true },
    );
    if (!ok) return;
    const reason = window.prompt('Motivo do cancelamento:') ?? '';
    if (!reason.trim()) { toast.error('Motivo é obrigatório.'); return; }
    setBusy('cancel');
    try {
      const r = await apiFetch(`/api/clinic/guides/${guide.id}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao cancelar.');
      toast.success('Guia cancelada.');
      onChanged();
    } catch (e: any) { toast.error(e?.message || 'Falha.'); }
    finally { setBusy(null); }
  };

  const openPdf = () => {
    window.open(`/api/clinic/guides/${guide.id}/pdf`, '_blank', 'noopener');
  };

  const send = async () => {
    const ok = await confirmDialog(
      `Enviar a guia ${guide.internalNumber} pelo canal do paciente?`,
      { title: 'Enviar guia', confirmText: 'Enviar' },
    );
    if (!ok) return;
    setBusy('send');
    try {
      const r = await apiFetch(`/api/clinic/guides/${guide.id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const code = d?.code;
        if (code === 'LGPD_CONSENT_REQUIRED' || code === 'LGPD_COMMS_CONSENT_REQUIRED') {
          throw new Error('Paciente não deu consent LGPD para envio. Configure na ficha do contato.');
        }
        throw new Error(d?.error || 'Falha ao enviar.');
      }
      toast.success('Guia enviada.');
      onChanged();
    } catch (e: any) { toast.error(e?.message || 'Falha.'); }
    finally { setBusy(null); }
  };

  const specialtyLabel =
    guide.guideType === 'referral'
      ? (guide.snapshotJson?.fields?.referralSpecialty || guide.snapshotJson?.referralSpecialty)
      : null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-emerald-300/80 inline-flex items-center gap-1 border border-emerald-500/30 rounded px-1.5 py-0.5">
              {t.icon} {t.short}
            </span>
            <span className="text-sm font-semibold text-zinc-100">{guide.internalNumber}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${s.cls}`}>{s.label}</span>
          </div>
          <div className="text-[11px] text-zinc-400 mt-1 flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1">
              <User className="w-3 h-3" /> {contact?.name || 'Paciente'}
            </span>
            {professional && <span>· {professional.name}</span>}
            {operator && <span>· Operadora: {operator.name}</span>}
            {procedure && <span>· TUSS: {procedure.code}</span>}
            {specialtyLabel && <span>· para {specialtyLabel}</span>}
            {guide.totalSessions && <span>· {guide.totalSessions} sessões</span>}
            {guide.validUntil && <span>· válida até {fmtDate(guide.validUntil)}</span>}
          </div>
          {guide.cancelledReason && (
            <p className="text-[11px] text-zinc-400 mt-1 italic">"{guide.cancelledReason}"</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isDraft && (
            <button onClick={onEdit}
              className="h-7 px-2 text-[11px] rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1">
              <Pencil className="w-3 h-3" /> Editar
            </button>
          )}
          {isDraft && (
            <button onClick={issue} disabled={busy === 'issue'}
              className="h-7 px-2 text-[11px] rounded-lg border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center gap-1">
              {busy === 'issue' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Emitir
            </button>
          )}
          {!isDraft && (
            <button onClick={openPdf}
              className="h-7 px-2 text-[11px] rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1">
              <Eye className="w-3 h-3" /> PDF
            </button>
          )}
          {isIssued && (
            <button onClick={send} disabled={busy === 'send'}
              className="h-7 px-2 text-[11px] rounded-lg border border-sky-500/40 text-sky-200 hover:bg-sky-500/10 inline-flex items-center gap-1">
              {busy === 'send' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              Enviar
            </button>
          )}
          {canCancel && !isTerminal && (
            <button onClick={cancel} disabled={busy === 'cancel'}
              className="h-7 px-2 text-[11px] rounded-lg border border-rose-500/40 text-rose-200 hover:bg-rose-500/10 inline-flex items-center gap-1">
              {busy === 'cancel' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// ── Modal polimorfo (nova/editar) + GuideDraftButton (IA F48) ────────
function GuideFormModal({ mode, initial, contacts, professionals, operators, procedures, onClose, onSaved }: {
  mode: 'new' | 'edit';
  initial: Guide | null;
  contacts: ContactLite[];
  professionals: ProfessionalLite[];
  operators: Operator[];
  procedures: Procedure[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [guideType, setGuideType] = useState<GuideType>(initial?.guideType || 'tiss_authorization');
  const [contactId, setContactId] = useState(initial?.contactId || '');
  const [professionalId, setProfessionalId] = useState(initial?.professionalId || '');
  const [operatorId, setOperatorId] = useState(initial?.operatorId || '');
  const [procedureId, setProcedureId] = useState(initial?.procedureId || '');
  const [totalSessions, setTotalSessions] = useState<string>(initial?.totalSessions ? String(initial.totalSessions) : '');
  const [validFrom, setValidFrom] = useState(initial?.validFrom || '');
  const [validUntil, setValidUntil] = useState(initial?.validUntil || '');
  const [authorizationNumber, setAuthorizationNumber] = useState<string>(
    initial?.snapshotJson?.fields?.authorizationNumber || initial?.snapshotJson?.authorizationNumber || '',
  );
  const [referralSpecialty, setReferralSpecialty] = useState<string>(
    initial?.snapshotJson?.fields?.referralSpecialty || initial?.snapshotJson?.referralSpecialty || '',
  );
  const [referralReason, setReferralReason] = useState<string>(
    initial?.snapshotJson?.fields?.referralReason || initial?.snapshotJson?.referralReason || '',
  );
  const [cid, setCid] = useState<string>(
    initial?.snapshotJson?.fields?.cid || initial?.snapshotJson?.cid || '',
  );
  const [items, setItems] = useState<Array<{ description: string; qty?: string }>>(
    (initial?.snapshotJson?.fields?.items || initial?.snapshotJson?.items || [{ description: '' }]) as any,
  );

  // Rastreia campos vindos com missing:true da IA — pra destacar visualmente.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const isEdit = mode === 'edit';

  const applyDraft = async () => {
    if (!contactId) { toast.error('Selecione o paciente antes de pedir rascunho.'); return; }
    setDraftBusy(true);
    try {
      const r = await apiFetch('/api/clinic/guides/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guideType, contactId,
          professionalId: professionalId || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao gerar rascunho.');
      const draft: DraftResponse = d.draft;
      const miss = new Set<string>();

      // Aplica campos preenchidos + rastreia missing.
      const apply = (key: string, setter: (v: string) => void) => {
        const f = draft.fields[key];
        if (!f) return;
        if (f.missing) { miss.add(key); return; }
        const v = f.value == null ? '' : String(f.value);
        if (v) setter(v);
      };
      apply('operatorId', setOperatorId);
      apply('procedureId', setProcedureId);
      apply('totalSessions', v => setTotalSessions(String(v)));
      apply('authorizationNumber', setAuthorizationNumber);
      apply('validFrom', setValidFrom);
      apply('validUntil', setValidUntil);
      apply('referralSpecialty', setReferralSpecialty);
      apply('cid', setCid);
      // referralReason: IA NUNCA herda (RN-014) — sempre missing.
      if (draft.fields.referralReason?.missing) miss.add('referralReason');

      if (draft.professionalId && !professionalId) setProfessionalId(draft.professionalId);

      setMissing(miss);
      setWarnings(Array.isArray(draft.warnings) ? draft.warnings : []);
      if (miss.size > 0) {
        toast.success(`Rascunho aplicado — ${miss.size} campo(s) precisam de preenchimento humano.`);
      } else {
        toast.success('Rascunho aplicado.');
      }
    } catch (e: any) { toast.error(e?.message || 'Falha.'); }
    finally { setDraftBusy(false); }
  };

  const buildFields = () => {
    if (guideType === 'tiss_authorization') {
      return { authorizationNumber: authorizationNumber.trim() || null };
    }
    if (guideType === 'referral') {
      return {
        referralSpecialty: referralSpecialty.trim(),
        referralReason: referralReason.trim(),
      };
    }
    if (guideType === 'medical_order') {
      return {
        cid: cid.trim() || null,
        items: items
          .map(it => ({ description: (it.description || '').trim(), qty: it.qty ? Number(it.qty) || null : null }))
          .filter(it => it.description),
      };
    }
    return {};
  };

  const submit = async () => {
    if (!contactId) { toast.error('Selecione o paciente.'); return; }
    setBusy(true);
    try {
      const body: any = {
        contactId,
        professionalId: professionalId || null,
        operatorId: operatorId || null,
        procedureId: procedureId || null,
        totalSessions: totalSessions ? Number(totalSessions) : null,
        validFrom: validFrom || null,
        validUntil: validUntil || null,
        fields: buildFields(),
      };
      let r: Response;
      if (isEdit && initial) {
        r = await apiFetch(`/api/clinic/guides/${initial.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        body.guideType = guideType;
        r = await apiFetch('/api/clinic/guides', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao salvar.');
      toast.success(isEdit ? 'Guia atualizada.' : 'Guia criada em rascunho.');
      onSaved();
    } catch (e: any) { toast.error(e?.message || 'Falha.'); }
    finally { setBusy(false); }
  };

  const missingCls = (k: string) => missing.has(k)
    ? 'border-amber-500/60 bg-amber-500/5'
    : 'border-zinc-800 bg-zinc-900';

  return (
    <ModalShell title={isEdit ? `Editar guia ${initial?.internalNumber || ''}` : 'Nova guia'}
      subtitle={TYPE_META[guideType].hint} onClose={onClose}>
      <div className="space-y-3">
        {/* Tipo (só na criação) */}
        {!isEdit && (
          <div>
            <span className="text-[11px] text-zinc-400 block mb-1">Tipo de guia</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {(Object.keys(TYPE_META) as GuideType[]).map(t => {
                const meta = TYPE_META[t];
                const active = t === guideType;
                return (
                  <button key={t} onClick={() => { setGuideType(t); setMissing(new Set()); setWarnings([]); }}
                    className={`h-7 px-2 text-[11px] rounded-lg border inline-flex items-center gap-1 ${
                      active ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-100'
                             : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
                    {meta.icon} {meta.short}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Comuns */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Paciente</span>
            <select value={contactId} onChange={e => setContactId(e.target.value)} disabled={isEdit}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 disabled:opacity-60">
              <option value="">— selecione —</option>
              {contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Profissional (opcional)</span>
            <select value={professionalId} onChange={e => setProfessionalId(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500">
              <option value="">— sem —</option>
              {professionals.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>

        {/* GuideDraftButton (F48) */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
            <span className="text-[11px] text-zinc-300 font-medium">
              Rascunho IA — pré-preenche do histórico
            </span>
            <button onClick={applyDraft} disabled={draftBusy || !contactId}
              className="ml-auto h-6 px-2 text-[10px] rounded border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/10 inline-flex items-center gap-1 disabled:opacity-50">
              {draftBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              Gerar rascunho
            </button>
          </div>
          <p className="text-[10px] text-zinc-600 mt-1">
            IA NUNCA inventa TUSS, carteirinha, número de autorização, validade, motivo de
            encaminhamento ou lista de itens (RN-014). Campos ausentes vêm marcados em âmbar.
          </p>
          {warnings.length > 0 && (
            <div className="mt-2 space-y-1">
              {warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-amber-200">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Campos por tipo */}
        {guideType === 'tiss_authorization' && (
          <div className="space-y-2.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-400">
                  Operadora{missing.has('operatorId') && <span className="text-amber-300"> · IA não achou</span>}
                </span>
                <select value={operatorId} onChange={e => setOperatorId(e.target.value)}
                  className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('operatorId')}`}>
                  <option value="">— selecione —</option>
                  {operators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-400">
                  Procedimento (TUSS){missing.has('procedureId') && <span className="text-amber-300"> · IA não achou</span>}
                </span>
                <select value={procedureId} onChange={e => setProcedureId(e.target.value)}
                  className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('procedureId')}`}>
                  <option value="">— selecione —</option>
                  {procedures.map(p => <option key={p.id} value={p.id}>{p.code} · {p.description}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-400">
                  Nº autorização{missing.has('authorizationNumber') && <span className="text-amber-300"> · IA não inventa</span>}
                </span>
                <input value={authorizationNumber} onChange={e => setAuthorizationNumber(e.target.value)}
                  placeholder="Preencher manualmente com o nº devolvido pela operadora"
                  className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('authorizationNumber')}`} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-400">Total de sessões</span>
                <input type="number" min={1} value={totalSessions} onChange={e => setTotalSessions(e.target.value)}
                  placeholder="Ex.: 10"
                  className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('totalSessions')}`} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-400">
                  Válida de{missing.has('validFrom') && <span className="text-amber-300"> · IA não inventa</span>}
                </span>
                <input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)}
                  className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('validFrom')}`} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-zinc-400">
                  Válida até{missing.has('validUntil') && <span className="text-amber-300"> · IA não inventa</span>}
                </span>
                <input type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)}
                  className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('validUntil')}`} />
              </label>
            </div>
          </div>
        )}

        {guideType === 'referral' && (
          <div className="space-y-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">
                Especialidade destino{missing.has('referralSpecialty') && <span className="text-amber-300"> · IA não achou</span>}
              </span>
              <input value={referralSpecialty} onChange={e => setReferralSpecialty(e.target.value)}
                placeholder="Ex.: Cardiologia"
                className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('referralSpecialty')}`} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">
                Motivo do encaminhamento (obrigatório, novo a cada guia — RN-014)
              </span>
              <textarea value={referralReason} onChange={e => setReferralReason(e.target.value)} rows={3}
                placeholder="Descreva o motivo clínico — IA nunca herda de encaminhamento anterior."
                className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 resize-y ${missingCls('referralReason')}`} />
              <span className="text-[10px] text-zinc-600">Mín. 3 caracteres na emissão.</span>
            </label>
          </div>
        )}

        {guideType === 'medical_order' && (
          <div className="space-y-2.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-400">
                CID (opcional){missing.has('cid') && <span className="text-amber-300"> · IA não achou</span>}
              </span>
              <input value={cid} onChange={e => setCid(e.target.value)}
                placeholder="Ex.: M79.7"
                className={`border rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500 ${missingCls('cid')}`} />
            </label>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] text-zinc-400">
                  Itens (≥1 obrigatório na emissão — IA nunca fabrica)
                </span>
                <button onClick={() => setItems([...items, { description: '' }])}
                  className="ml-auto h-6 px-2 text-[10px] rounded border border-zinc-700 text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1">
                  <Plus className="w-3 h-3" /> Adicionar item
                </button>
              </div>
              <div className="space-y-1.5">
                {items.map((it, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={it.description}
                      onChange={e => {
                        const next = [...items]; next[i] = { ...next[i], description: e.target.value }; setItems(next);
                      }}
                      placeholder={`Item ${i + 1} (descrição)`}
                      className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
                    <input value={it.qty || ''} type="number" min={1}
                      onChange={e => {
                        const next = [...items]; next[i] = { ...next[i], qty: e.target.value }; setItems(next);
                      }}
                      placeholder="Qtd"
                      className="w-20 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
                    {items.length > 1 && (
                      <button onClick={() => setItems(items.filter((_, j) => j !== i))}
                        className="h-8 w-8 rounded-lg border border-rose-500/30 text-rose-200 hover:bg-rose-500/10 inline-flex items-center justify-center">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <p className="text-[11px] text-zinc-500 inline-flex items-start gap-1">
          <Info className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            Salvar cria um <b>rascunho</b>. Emissão congela snapshot e libera PDF/envio.
            Após emissão, campos ficam imutáveis (Fase 29).
          </span>
        </p>
      </div>

      <ModalActions onClose={onClose}>
        <Button onClick={submit} disabled={busy}
          className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
          {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1" />}
          {isEdit ? 'Salvar rascunho' : 'Criar rascunho'}
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
              <FileText className="w-4 h-4 text-emerald-400" />
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
