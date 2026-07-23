import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, ChangeEvent } from 'react';
import {
  Radar, Plus, ArrowLeft, ArrowRight, Loader2, HelpCircle, Sparkles, TrendingUp,
  Gauge, RefreshCw, ChevronRight, Paperclip, FileText, ListChecks, Share2, MessageCircle, Mail, Trash2,
} from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useAuth } from '@/src/contexts/AuthContext';

// ZappFlow Radar de Execução IA — painel autenticado (Fase 1). Reaproveita o
// MESMO motor de score do backend (RadarScoringEngine, compartilhado com o
// diagnóstico público em src/radar-public/RadarPublicWizard.tsx) e o mesmo
// vocabulário visual (pilares, níveis de maturidade). Ver docs/adr/ADR-013.

const teal = 'var(--color-zf-teal)';
const amber = 'var(--color-zf-amber)';

type Question = {
  id: string;
  pillar: string;
  title: string;
  help_text: string | null;
  display_order: number;
  options: { value: string; label: string; score: number }[] | null;
};
type Template = { id: string; questions: Question[] };

type Session = {
  id: string;
  status: string;
  template_id: string;
  company_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  segment: string | null;
  company_size: string | null;
  overall_maturity_score: number | null;
  maturity_level: string | null;
  confidence_score: number | null;
  updated_at: string;
  pillarScores?: { pillar: string; score: number | null; evidence_count: number }[];
  recommendations?: { priority_band: string; use_case_name: string }[];
  answers?: { id: string; question_id: string; respondent_id: string | null; answer_json: string; is_not_known: number; confidence_multiplier: number }[];
  evidence?: { id: string; answer_id: string; file_url: string; file_name: string | null; mime_type: string | null }[];
};

type VelocitySnapshot = {
  ivc_score: number | null;
  ivc_band: string | null;
  tickets_analyzed: number;
  sla_compliance_rate: number | null;
  out_of_hours_coverage_rate: number | null;
  created_at: string;
};

const PILLAR_LABEL: Record<string, string> = {
  estrategia: 'Estratégia e liderança',
  receita: 'Receita e atendimento',
  processos: 'Processos operacionais',
  dados: 'Dados e integração',
  pessoas: 'Pessoas e capacitação',
  governanca: 'Governança e segurança',
  metricas: 'Métricas e ROI',
};
const LEVEL_LABEL: Record<string, string> = {
  inerte: 'Inerte', experimental: 'Experimental', organizando: 'Organizando', integrada: 'Integrada', inteligente: 'Inteligente',
};
const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  in_progress: { label: 'Em andamento', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  needs_information: { label: 'Falta info', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  awaiting_review: { label: 'Aguardando revisão', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'Aprovado pelo consultor', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  completed: { label: 'Concluído', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
};
const IVC_BAND_LABEL: Record<string, string> = {
  critica: 'Crítica', reativa: 'Reativa', em_organizacao: 'Em organização', controlada: 'Controlada', otimizada: 'Otimizada',
};

async function api(path: string, opts: RequestInit = {}) {
  const res = await apiFetch(`/api/radar${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
  return json;
}

// Sem Content-Type manual — o browser define o boundary do multipart sozinho.
async function apiUpload(path: string, formData: FormData) {
  const res = await apiFetch(`/api/radar${path}`, { method: 'POST', body: formData });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
  return json;
}

type View = 'list' | 'new' | 'questions' | 'result';

export function RadarView() {
  const { user } = useAuth();
  const isManager = user?.role === 'owner' || user?.role === 'admin';
  const [view, setView] = useState<View>('list');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [velocity, setVelocity] = useState<VelocitySnapshot | null>(null);
  const [calcVelocity, setCalcVelocity] = useState(false);

  const loadSessions = useCallback(() => {
    setLoading(true);
    api('/sessions').then((d) => setSessions(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);
  useEffect(() => {
    api('/velocity/latest').then(setVelocity).catch(() => setVelocity(null));
  }, []);

  const openSession = useCallback(async (id: string) => {
    try {
      const s: Session = await api(`/sessions/${id}`);
      if (['completed', 'awaiting_review', 'approved'].includes(s.status)) {
        setActiveSession(s);
        setView('result');
        return;
      }
      const t: Template = await api(`/templates/${s.template_id}`);
      const answered = new Set((s.answers || []).map((a) => a.question_id));
      const firstUnanswered = t.questions.findIndex((q) => !answered.has(q.id));
      setActiveSession(s);
      setTemplate(t);
      setQIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
      setView('questions');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível abrir esse diagnóstico.');
    }
  }, []);

  const calculateVelocity = async () => {
    setCalcVelocity(true);
    try {
      const snap = await api('/velocity/calculate', { method: 'POST', body: JSON.stringify({}) });
      setVelocity(snap);
      toast.success('Índice de Velocidade de Conversão calculado.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível calcular o índice.');
    } finally {
      setCalcVelocity(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 text-white">
      {view === 'list' && (
        <ListView
          sessions={sessions} loading={loading} isManager={isManager}
          velocity={velocity} calculating={calcVelocity} onCalculateVelocity={calculateVelocity}
          onOpen={openSession} onNew={() => setView('new')}
        />
      )}
      {view === 'new' && (
        <NewSessionForm
          onBack={() => setView('list')}
          onCreated={(s, t) => { setActiveSession(s); setTemplate(t); setQIndex(0); setView('questions'); }}
        />
      )}
      {view === 'questions' && activeSession && template && (
        <QuestionsView
          session={activeSession} template={template} qIndex={qIndex} setQIndex={setQIndex}
          onSessionUpdate={setActiveSession}
          onBack={() => { setView('list'); loadSessions(); }}
          onDone={async () => {
            const result = await api(`/sessions/${activeSession.id}/complete`, { method: 'POST' });
            setActiveSession(result);
            setView('result');
            loadSessions();
          }}
        />
      )}
      {view === 'result' && activeSession && (
        <ResultView session={activeSession} onBack={() => { setView('list'); loadSessions(); }} />
      )}
    </div>
  );
}

const Card: React.FC<{ children?: ReactNode; className?: string }> = ({ children, className = '' }) => {
  return <div className={`rounded-xl border border-white/10 bg-white/[0.03] p-5 ${className}`}>{children}</div>;
}

function ListView({
  sessions, loading, isManager, velocity, calculating, onCalculateVelocity, onOpen, onNew,
}: {
  sessions: Session[]; loading: boolean; isManager: boolean;
  velocity: VelocitySnapshot | null; calculating: boolean; onCalculateVelocity: () => void;
  onOpen: (id: string) => void; onNew: () => void;
}) {
  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Radar size={20} style={{ color: teal }} /> Radar de Execução IA
          </h1>
          <p className="text-sm text-white/50 mt-1">Diagnóstico de maturidade em IA e velocidade de conversão medida.</p>
        </div>
        {isManager && (
          <button
            onClick={onNew}
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-[#0b0f12] hover:opacity-90"
            style={{ background: teal }}
          >
            <Plus size={16} /> Novo diagnóstico
          </button>
        )}
      </div>

      <Card className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Gauge size={18} style={{ color: amber }} />
            <div>
              <div className="text-sm font-semibold">Índice de Velocidade de Conversão (IVC)</div>
              <div className="text-xs text-white/50">Medido a partir dos seus próprios atendimentos — não é autodeclarado.</div>
            </div>
          </div>
          {isManager && (
            <button
              onClick={onCalculateVelocity}
              disabled={calculating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-white/80 hover:border-white/30 disabled:opacity-50"
            >
              {calculating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Calcular agora
            </button>
          )}
        </div>
        {velocity ? (
          <div className="mt-4 flex items-center gap-6">
            <div className="text-3xl font-bold tabular-nums" style={{ color: teal }}>
              {velocity.ivc_score != null ? Math.round(velocity.ivc_score) : '—'}
            </div>
            <div>
              <div className="text-sm font-semibold">{velocity.ivc_band ? IVC_BAND_LABEL[velocity.ivc_band] || velocity.ivc_band : 'Sem dados suficientes'}</div>
              <div className="text-xs text-white/40">{velocity.tickets_analyzed} atendimento(s) analisados nos últimos 30 dias</div>
            </div>
          </div>
        ) : (
          <div className="mt-4 text-sm text-white/40">Ainda não calculado. {isManager ? 'Clique em "Calcular agora".' : 'Peça a um administrador para calcular.'}</div>
        )}
      </Card>

      <ConsultationRequests isManager={isManager} />

      <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wide mb-3">Diagnósticos</h2>
      {loading ? (
        <div className="text-sm text-white/40">Carregando...</div>
      ) : sessions.length === 0 ? (
        <Card className="text-sm text-white/50">
          Nenhum diagnóstico ainda. {isManager ? 'Crie o primeiro para descobrir onde priorizar IA na operação.' : 'Peça a um administrador para iniciar um.'}
        </Card>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => {
            const st = STATUS_LABEL[s.status] || { label: s.status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
            return (
              <button
                key={s.id}
                onClick={() => onOpen(s.id)}
                className="w-full flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3.5 text-left hover:border-white/25 transition"
              >
                <div>
                  <div className="font-medium text-sm">{s.company_name || 'Diagnóstico sem nome'}</div>
                  <div className="text-xs text-white/40 mt-0.5">{s.segment || '—'} · atualizado em {new Date(s.updated_at.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR')}</div>
                </div>
                <div className="flex items-center gap-3">
                  {s.overall_maturity_score != null && (
                    <div className="text-sm tabular-nums text-white/70">{Math.round(s.overall_maturity_score)}/100</div>
                  )}
                  <span className={`text-xs px-2 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
                  <ChevronRight size={16} className="text-white/30" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Solicitações de consultoria vindas do diagnóstico público (Radar Fase 2).
// Só a organização de destino do funil (RADAR_LEADS_ORGANIZATION_ID) recebe
// linhas aqui — para as demais o endpoint devolve [] e o bloco não aparece.
type ConsultationRequest = {
  id: string; contact_name: string; contact_email: string | null; contact_phone: string | null;
  message: string | null; overall_score: number | null; maturity_level: string | null;
  status: string; created_at: string;
};
const CONSULT_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pendente', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  contacted: { label: 'Contatado', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  closed: { label: 'Encerrado', cls: 'text-white/50 bg-white/5 border-white/15' },
};

function ConsultationRequests({ isManager }: { isManager: boolean }) {
  const [items, setItems] = useState<ConsultationRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    try { const r = await api('/consultation-requests'); setItems(Array.isArray(r) ? r : []); }
    catch { setItems([]); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (id: string, status: string) => {
    try {
      await api(`/consultation-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status } : it)));
    } catch { /* silencioso — recarrega abaixo se preciso */ }
  };

  if (!loaded || items.length === 0) return null;
  const pendingCount = items.filter((it) => it.status === 'pending').length;

  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wide mb-3">
        Solicitações de consultoria{pendingCount > 0 ? ` · ${pendingCount} pendente(s)` : ''}
      </h2>
      <div className="space-y-2">
        {items.map((it) => {
          const st = CONSULT_STATUS[it.status] || CONSULT_STATUS.pending;
          return (
            <Card key={it.id} className="!p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{it.contact_name}</div>
                  <div className="text-xs text-white/50 mt-0.5">
                    {[it.contact_email, it.contact_phone].filter(Boolean).join(' · ') || 'sem contato'}
                  </div>
                  <div className="text-xs text-white/40 mt-1">
                    Maturidade {it.maturity_level || '—'}{it.overall_score != null ? ` · score ${Math.round(it.overall_score)}/100` : ''}
                    {' · '}{new Date(it.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('pt-BR')}
                  </div>
                  {it.message && <div className="text-xs text-white/60 mt-2 border-l-2 border-white/10 pl-2 whitespace-pre-wrap">{it.message}</div>}
                </div>
                <span className={`shrink-0 text-xs px-2 py-1 rounded-full border ${st.cls}`}>{st.label}</span>
              </div>
              {isManager && (
                <div className="flex items-center gap-2 mt-3">
                  {it.status !== 'contacted' && (
                    <button onClick={() => setStatus(it.id, 'contacted')} className="text-xs px-2.5 py-1.5 rounded-lg border border-white/15 hover:border-white/35 text-white/80">Marcar como contatado</button>
                  )}
                  {it.status !== 'closed' && (
                    <button onClick={() => setStatus(it.id, 'closed')} className="text-xs px-2.5 py-1.5 rounded-lg border border-white/15 hover:border-white/35 text-white/60">Encerrar</button>
                  )}
                  {it.status !== 'pending' && (
                    <button onClick={() => setStatus(it.id, 'pending')} className="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 hover:border-white/25 text-white/40">Reabrir</button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-white/40';
const selectStyle = { colorScheme: 'dark' as const };
const optionStyle = { backgroundColor: '#18181b', color: '#ffffff' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-white/50 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

const SEGMENTS = [
  'Comércio varejista', 'Serviços profissionais', 'Clínicas/saúde', 'Hotelaria/pousadas', 'Educação',
  'Logística/transporte', 'Imobiliário', 'Alimentação', 'Oficinas/manutenção', 'Indústria leve', 'E-commerce', 'Outros',
];
const SIZES = ['1-9', '10-49', '50-99', '100-249', '250+'];

function NewSessionForm({ onBack, onCreated }: { onBack: () => void; onCreated: (s: Session, t: Template) => void }) {
  const [form, setForm] = useState({ companyName: '', contactName: '', segment: '', companySize: '', primaryGoal: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const templates = await api('/templates');
      const templateId = templates?.[0]?.id;
      if (!templateId) throw new Error('Nenhum template de diagnóstico disponível.');
      const session: Session = await api('/sessions', { method: 'POST', body: JSON.stringify({ templateId, ...form }) });
      const template: Template = await api(`/templates/${templateId}`);
      onCreated(session, template);
    } catch (e: any) {
      setError(e.message || 'Não foi possível criar o diagnóstico.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={onBack} className="text-sm text-white/50 hover:text-white/80 inline-flex items-center gap-1 mb-5">
        <ArrowLeft size={14} /> Voltar
      </button>
      <h2 className="text-xl font-bold">Novo diagnóstico de maturidade em IA</h2>
      <p className="mt-1 text-sm text-white/50">18 perguntas em 7 pilares — resultado com score, nível de maturidade e recomendações priorizadas.</p>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Empresa"><input className={inputCls} value={form.companyName} onChange={set('companyName')} placeholder="Nome da empresa avaliada" /></Field>
        <Field label="Responsável pelas respostas"><input className={inputCls} value={form.contactName} onChange={set('contactName')} /></Field>
        <Field label="Segmento">
          <select className={inputCls} style={selectStyle} value={form.segment} onChange={set('segment')}>
            <option value="" style={optionStyle}>Selecione</option>
            {SEGMENTS.map((s) => <option key={s} value={s} style={optionStyle}>{s}</option>)}
          </select>
        </Field>
        <Field label="Porte (nº de pessoas)">
          <select className={inputCls} style={selectStyle} value={form.companySize} onChange={set('companySize')}>
            <option value="" style={optionStyle}>Selecione</option>
            {SIZES.map((s) => <option key={s} value={s} style={optionStyle}>{s}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Objetivo principal nos próximos 90 dias">
            <input className={inputCls} value={form.primaryGoal} onChange={set('primaryGoal')} placeholder="Ex.: aumentar vendas, organizar a operação..." />
          </Field>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="mt-6 inline-flex items-center gap-2 rounded-lg px-6 py-3 font-semibold text-[#0b0f12] transition disabled:opacity-40 hover:opacity-90"
        style={{ background: teal }}
      >
        {submitting ? <Loader2 className="animate-spin" size={18} /> : <>Começar diagnóstico <ArrowRight size={18} /></>}
      </button>
    </div>
  );
}

function QuestionsView({
  session, template, qIndex, setQIndex, onBack, onDone, onSessionUpdate,
}: {
  session: Session; template: Template; qIndex: number; setQIndex: (n: number) => void; onBack: () => void; onDone: () => Promise<void>;
  onSessionUpdate: (s: Session) => void;
}) {
  const { user } = useAuth();
  const isManager = user?.role === 'owner' || user?.role === 'admin';
  const questions = template.questions;
  const q = questions[qIndex];
  const answeredMap = useMemo(() => {
    const m = new Map<string, { value: string | null; isNotKnown: boolean }>();
    for (const a of session.answers || []) {
      let value: string | null = null;
      try { value = JSON.parse(a.answer_json); } catch { /* noop */ }
      m.set(a.question_id, { value, isNotKnown: !!a.is_not_known });
    }
    return m;
  }, [session.answers]);

  const [selected, setSelected] = useState<string | null>(answeredMap.get(q.id)?.value ?? null);
  const [notKnown, setNotKnown] = useState(!!answeredMap.get(q.id)?.isNotKnown);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);

  useEffect(() => {
    setSelected(answeredMap.get(q.id)?.value ?? null);
    setNotKnown(!!answeredMap.get(q.id)?.isNotKnown);
    setComment('');
  }, [q.id, answeredMap]);

  const currentAnswer = (session.answers || []).find((a) => a.question_id === q.id && !a.respondent_id);
  const currentEvidence = (session.evidence || []).filter((e) => e.answer_id === currentAnswer?.id);

  async function refreshSession() {
    const fresh = await api(`/sessions/${session.id}`);
    onSessionUpdate(fresh);
    return fresh;
  }

  // Salva a resposta assim que uma opção é escolhida (não só ao clicar
  // "Próxima") — sem isso, não existe momento em que a pergunta ATUAL já
  // tenha uma resposta persistida, e anexar evidência exige uma resposta
  // salva (RadarService.addEvidence). "Próxima" ainda salva de novo (mesmo
  // question/session, é upsert) para capturar um comentário digitado depois.
  async function saveCurrent(value: string | null, isNotKnown: boolean) {
    setSaving(true);
    try {
      await api(`/sessions/${session.id}/answers`, {
        method: 'POST',
        body: JSON.stringify({ questionId: q.id, value, isNotKnown, comment }),
      });
      await refreshSession();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível salvar a resposta.');
    } finally {
      setSaving(false);
    }
  }

  async function advance() {
    if (!selected && !notKnown) return;
    setSaving(true);
    try {
      await api(`/sessions/${session.id}/answers`, {
        method: 'POST',
        body: JSON.stringify({ questionId: q.id, value: selected, isNotKnown: notKnown, comment }),
      });
      await refreshSession();
      if (qIndex < questions.length - 1) setQIndex(qIndex + 1);
      else await onDone();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível salvar a resposta.');
    } finally {
      setSaving(false);
    }
  }

  async function uploadEvidence(file: File) {
    setUploadingEvidence(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('questionId', q.id);
      const fresh = await apiUpload(`/sessions/${session.id}/evidence`, form);
      onSessionUpdate(fresh);
      toast.success('Evidência anexada — confiança da resposta atualizada.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível anexar a evidência.');
    } finally {
      setUploadingEvidence(false);
    }
  }

  // Exclusão (ADR-025) — manager-only no servidor (excluir desfaz o boost de
  // confiança e recalcula o score); quem não for owner/admin recebe o 403 com
  // a mensagem do servidor no toast.
  async function removeEvidence(evidenceId: string) {
    try {
      const fresh = await api(`/sessions/${session.id}/evidence/${evidenceId}`, { method: 'DELETE' });
      onSessionUpdate(fresh);
      toast.success('Evidência excluída — confiança da resposta recalculada.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível excluir a evidência.');
    }
  }

  const [fillingAuto, setFillingAuto] = useState(false);
  const hasAutoFilled = (session.answers || []).some((a: any) => a.source === 'measured');

  async function autoFill() {
    setFillingAuto(true);
    try {
      const res = await api(`/sessions/${session.id}/autofill`, { method: 'POST' });
      if (res.filled?.length > 0) {
        toast.success(`${res.filled.length} pergunta(s) preenchida(s) com dados medidos.`);
        await refreshSession();
      } else {
        toast.success('Nenhum dado medido disponível para esta sessão.');
      }
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível preencher automaticamente.');
    } finally {
      setFillingAuto(false);
    }
  }

  const progress = Math.round((qIndex / questions.length) * 100);

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={onBack} className="text-sm text-white/50 hover:text-white/80 inline-flex items-center gap-1 mb-5">
        <ArrowLeft size={14} /> Voltar para a lista
      </button>

      {!hasAutoFilled && qIndex === 0 && (
        <button
          onClick={autoFill} disabled={fillingAuto}
          className="w-full mb-4 rounded-lg border border-teal-500/30 bg-teal-500/[0.06] px-4 py-3 text-sm text-teal-300 hover:bg-teal-500/10 transition flex items-center gap-2 justify-center disabled:opacity-50"
        >
          <Gauge size={15} />
          {fillingAuto ? 'Preenchendo...' : 'Preencher com dados medidos da sua operação'}
        </button>
      )}

      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: teal }} />
      </div>
      <div className="mt-2 text-xs text-white/40">Pergunta {qIndex + 1} de {questions.length} · {PILLAR_LABEL[q.pillar] || q.pillar}</div>

      <h2 className="mt-5 text-xl font-semibold text-balance">{q.title}</h2>
      {q.help_text && <p className="mt-1.5 text-sm text-white/50">{q.help_text}</p>}
      {(session as any).measuredHints?.[q.id] && (
        <div className="mt-2.5 rounded-lg border border-teal-500/25 bg-teal-500/[0.06] px-3 py-2 text-xs text-teal-300 flex items-start gap-1.5">
          <Gauge size={13} className="mt-0.5 shrink-0" />
          <span>{(session as any).measuredHints[q.id]} A resposta continua sendo sua — o dado medido é só referência.</span>
        </div>
      )}

      <div className="mt-6 space-y-2.5">
        {(q.options || []).map((opt) => (
          <button
            key={opt.value}
            onClick={() => { setSelected(opt.value); setNotKnown(false); saveCurrent(opt.value, false); }}
            className={`w-full text-left rounded-lg border px-4 py-3 text-sm transition ${
              selected === opt.value && !notKnown ? 'border-transparent text-[#0b0f12]' : 'border-white/15 bg-white/[0.03] text-white/80 hover:border-white/30'
            }`}
            style={selected === opt.value && !notKnown ? { background: teal } : undefined}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => { setNotKnown(true); setSelected(null); saveCurrent(null, true); }}
          className={`w-full text-left rounded-lg border px-4 py-3 text-sm transition flex items-center gap-2 ${
            notKnown ? 'border-transparent text-[#0b0f12]' : 'border-dashed border-white/15 text-white/50 hover:border-white/30'
          }`}
          style={notKnown ? { background: amber } : undefined}
        >
          <HelpCircle size={16} /> Não sei / não se aplica
        </button>
      </div>

      <label className="block mt-5">
        <span className="block text-xs font-medium text-white/50 mb-1.5">Quer explicar melhor? (opcional — melhora a confiança da resposta)</span>
        <textarea className={`${inputCls} min-h-[70px]`} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>

      <div className="mt-4">
        <span className="block text-xs font-medium text-white/50 mb-1.5">
          Evidência (opcional — print de tela ou PDF sobe a confiança para 0,90)
        </span>
        {!currentAnswer ? (
          <p className="text-xs text-white/30">Responda a pergunta primeiro para poder anexar evidência.</p>
        ) : (
          <>
            {currentEvidence.length > 0 && (
              <ul className="mb-2 space-y-1">
                {currentEvidence.map((ev) => (
                  <li key={ev.id} className="text-xs text-emerald-300 flex items-center gap-1.5">
                    <Paperclip size={12} /> {ev.file_name || 'evidência anexada'}
                    <button
                      onClick={() => removeEvidence(ev.id)}
                      title="Excluir evidência (só donos/administradores — desfaz o boost de confiança)"
                      className="text-white/25 hover:text-red-300 ml-1"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="inline-flex items-center gap-2 rounded-lg border border-dashed border-white/20 px-3 py-2 text-xs text-white/60 hover:border-white/40 cursor-pointer">
              {uploadingEvidence ? <Loader2 className="animate-spin" size={14} /> : <Paperclip size={14} />}
              {uploadingEvidence ? 'Enviando...' : 'Anexar arquivo (PNG, JPG, WEBP ou PDF)'}
              <input
                type="file" className="hidden" accept=".png,.jpg,.jpeg,.webp,.pdf" disabled={uploadingEvidence}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadEvidence(f); e.target.value = ''; }}
              />
            </label>
          </>
        )}
      </div>

      <div className="mt-7 flex items-center gap-3">
        {qIndex > 0 && (
          <button onClick={() => setQIndex(qIndex - 1)} className="rounded-lg border border-white/15 px-4 py-3 text-sm text-white/70 hover:border-white/30">
            <ArrowLeft size={16} />
          </button>
        )}
        <button
          onClick={advance}
          disabled={(!selected && !notKnown) || saving}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 font-semibold text-[#0b0f12] transition disabled:opacity-40 hover:opacity-90"
          style={{ background: teal }}
        >
          {saving ? <Loader2 className="animate-spin" size={18} /> : qIndex < questions.length - 1 ? <>Próxima <ArrowRight size={18} /></> : <>Ver resultado <Sparkles size={18} /></>}
        </button>
      </div>

      {isManager && <RespondentsSection sessionId={session.id} />}
    </div>
  );
}

function ResultView({ session: initialSession, onBack }: { session: Session; onBack: () => void }) {
  const { user } = useAuth();
  const isManager = user?.role === 'owner' || user?.role === 'admin';
  // Recalcular (ADR-025) devolve a sessão atualizada — estado local para a
  // tela refletir o score novo sem precisar voltar pra lista. Sincroniza
  // quando o pai troca de sessão (abrir outro diagnóstico).
  const [session, setSession] = useState<Session>(initialSession);
  useEffect(() => { setSession(initialSession); }, [initialSession]);
  const [recalculating, setRecalculating] = useState(false);
  const recalculate = async () => {
    setRecalculating(true);
    try {
      const fresh = await api(`/sessions/${session.id}/recalculate`, { method: 'POST' });
      setSession(fresh);
      toast.success('Score recalculado com as respostas e evidências atuais.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível recalcular.');
    } finally {
      setRecalculating(false);
    }
  };
  const score = session.overall_maturity_score;
  const level = session.maturity_level;
  const pillarScores = session.pillarScores || [];
  const sorted = [...pillarScores].filter((p) => p.score != null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const gaps = sorted.slice(0, 2);
  const topRecs = (session.recommendations || []).slice(0, 3);
  const hasHighPriority = (session.recommendations || []).some((r) => r.priority_band === 'alta');

  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [creatingTasks, setCreatingTasks] = useState(false);
  const [tasksResult, setTasksResult] = useState<{ created: number; skipped: number } | null>(null);
  const [sendingChannel, setSendingChannel] = useState<'whatsapp' | 'email' | null>(null);
  const [sharing, setSharing] = useState(false);
  const canNativeShare = typeof navigator !== 'undefined' && !!(navigator as any).share;

  const generateReport = async () => {
    setGeneratingReport(true);
    try {
      const result = await api(`/sessions/${session.id}/report`, { method: 'POST' });
      setReportUrl(result.url);
      toast.success(result.hasNarrative ? 'Relatório gerado com resumo por IA.' : 'Relatório gerado (sem resumo por IA — configure a IA para incluir essa seção).');
      return result.url as string;
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível gerar o relatório.');
      return null;
    } finally {
      setGeneratingReport(false);
    }
  };

  // Compartilhamento nativo do aparelho (celular): abre a folha de compartilhar
  // do próprio sistema operacional, para o usuário escolher em qual app já
  // instalado (WhatsApp, e-mail, Drive...) enviar ou salvar o PDF — não passa
  // pelo canal conectado da organização, é 100% local ao dispositivo de quem
  // está vendo a tela. Só aparece em navegadores que suportam a Web Share API
  // (a maioria dos navegadores mobile; desktop geralmente não tem).
  const shareNative = async () => {
    setSharing(true);
    try {
      const url = reportUrl || (await generateReport());
      if (!url) return;
      const absoluteUrl = url.startsWith('http') ? url : `${window.location.origin}${url}`;
      await (navigator as any).share({
        title: 'Relatório do Radar de Execução IA',
        text: `Diagnóstico de ${session.company_name || 'maturidade em IA'}`,
        url: absoluteUrl,
      });
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error('Não foi possível compartilhar.');
    } finally {
      setSharing(false);
    }
  };

  const sendReport = async (channel: 'whatsapp' | 'email') => {
    setSendingChannel(channel);
    try {
      await api(`/sessions/${session.id}/send`, { method: 'POST', body: JSON.stringify({ channel }) });
      toast.success(channel === 'whatsapp' ? 'Relatório enviado por WhatsApp.' : 'Relatório enviado por e-mail.');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível enviar o relatório.');
    } finally {
      setSendingChannel(null);
    }
  };

  const createTasks = async () => {
    setCreatingTasks(true);
    try {
      const result = await api(`/sessions/${session.id}/create-tasks`, { method: 'POST' });
      setTasksResult(result);
      toast.success(result.created > 0 ? `${result.created} tarefa(s) criada(s) em Tarefas.` : 'Nenhuma tarefa nova (já existiam ou não há recomendações de prioridade alta).');
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível criar as tarefas.');
    } finally {
      setCreatingTasks(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={onBack} className="text-sm text-white/50 hover:text-white/80 inline-flex items-center gap-1 mb-5">
        <ArrowLeft size={14} /> Voltar para a lista
      </button>

      <h2 className="text-2xl font-bold text-balance">
        {session.company_name ? `Resultado para ${session.company_name}` : 'Resultado do diagnóstico'}
      </h2>

      <Card className="mt-6 flex items-center gap-6">
        <div className="text-5xl font-bold tabular-nums" style={{ color: teal }}>{score != null ? Math.round(score) : '—'}</div>
        <div>
          <div className="text-lg font-semibold">{level ? LEVEL_LABEL[level] || level : 'Sem dados suficientes'}</div>
          <div className="text-sm text-white/50">Índice de maturidade (0-100)</div>
          {session.confidence_score != null && (
            <div className="text-xs text-white/40 mt-1">
              Confiança das respostas: {Math.round(session.confidence_score * 100)}%
              {session.confidence_score < 0.85 && ' — anexe evidências nas respostas para aumentar'}
            </div>
          )}
        </div>
      </Card>

      <h3 className="mt-8 text-sm font-semibold text-white/50 uppercase tracking-wide">Os 7 pilares</h3>
      <div className="mt-3 space-y-2.5">
        {pillarScores.map((p) => (
          <div key={p.pillar}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-white/70">{PILLAR_LABEL[p.pillar] || p.pillar}</span>
              <span className="text-white/40 tabular-nums">{p.score != null ? Math.round(p.score) : '—'}</span>
            </div>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${p.score ?? 0}%`, background: teal }} />
            </div>
          </div>
        ))}
      </div>

      {gaps.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wide">Onde focar primeiro</h3>
          <div className="mt-3 space-y-2">
            {gaps.map((g) => (
              <div key={g.pillar} className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3 text-sm">
                <TrendingUp size={14} className="inline mr-1.5" style={{ color: amber }} />
                <span className="text-white/80">{PILLAR_LABEL[g.pillar] || g.pillar} é o pilar com maior espaço de melhoria.</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {topRecs.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wide">Recomendações priorizadas</h3>
          <div className="mt-3 space-y-2">
            {topRecs.map((r, i) => (
              <div key={i} className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{r.use_case_name}</span>
                <span className={`text-xs px-2 py-1 rounded-full border ${
                  r.priority_band === 'alta' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                  : r.priority_band === 'media' ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                  : 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30'
                }`}>{r.priority_band}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {isManager && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wide">Ações</h3>
          <div className="mt-3 flex flex-wrap gap-3">
            {session.status === 'awaiting_review' && (
              <button
                onClick={recalculate} disabled={recalculating}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:border-white/30 disabled:opacity-40"
              >
                {recalculating ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />} Recalcular score
              </button>
            )}
            <button
              onClick={generateReport} disabled={generatingReport || score == null}
              className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:border-white/30 disabled:opacity-40"
            >
              {generatingReport ? <Loader2 className="animate-spin" size={16} /> : <FileText size={16} />} Gerar relatório (PDF)
            </button>
            {hasHighPriority && (
              <button
                onClick={createTasks} disabled={creatingTasks}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:border-white/30 disabled:opacity-40"
              >
                {creatingTasks ? <Loader2 className="animate-spin" size={16} /> : <ListChecks size={16} />} Criar tarefas das recomendações de prioridade alta
              </button>
            )}
            {canNativeShare && (
              <button
                onClick={shareNative} disabled={sharing || generatingReport || score == null}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:border-white/30 disabled:opacity-40"
              >
                {sharing ? <Loader2 className="animate-spin" size={16} /> : <Share2 size={16} />} Compartilhar
              </button>
            )}
            {session.contact_phone && (
              <button
                onClick={() => sendReport('whatsapp')} disabled={sendingChannel === 'whatsapp' || score == null}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:border-white/30 disabled:opacity-40"
              >
                {sendingChannel === 'whatsapp' ? <Loader2 className="animate-spin" size={16} /> : <MessageCircle size={16} />} Enviar por WhatsApp
              </button>
            )}
            {session.contact_email && (
              <button
                onClick={() => sendReport('email')} disabled={sendingChannel === 'email' || score == null}
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-white/80 hover:border-white/30 disabled:opacity-40"
              >
                {sendingChannel === 'email' ? <Loader2 className="animate-spin" size={16} /> : <Mail size={16} />} Enviar por e-mail
              </button>
            )}
          </div>
          {reportUrl && (
            <a href={reportUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm" style={{ color: teal }}>
              <FileText size={14} /> Abrir relatório gerado
            </a>
          )}
          {tasksResult && (
            <p className="mt-2 text-xs text-white/40">
              {tasksResult.created} criada(s){tasksResult.skipped > 0 ? `, ${tasksResult.skipped} já existente(s)` : ''}.
            </p>
          )}
          {!session.contact_phone && !session.contact_email && (
            <p className="mt-2 text-xs text-white/30">
              Sem telefone/e-mail de contato nesta sessão — envio direto pelo canal da organização não está disponível (o "Compartilhar" acima funciona igual).
            </p>
          )}
        </div>
      )}

      <RespondentsSection sessionId={session.id} />
    </div>
  );
}

type Respondent = { id: string; name: string; email: string | null; role_title: string | null; area: string | null; status: string };

const RESPONDENT_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  invited: { label: 'Convidado', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  active: { label: 'Respondendo', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  completed: { label: 'Concluído', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  revoked: { label: 'Revogado', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};

// Registro de quem mais ajudou a responder o diagnóstico (Fase 3, ADR-014) +
// convite por link próprio, sem login (Fase 3/ADR-018): o respondente recebe
// um link opaco (mesmo padrão de segurança do diagnóstico público) e
// responde as MESMAS 18 perguntas em nome dessa sessão — as respostas dele
// entram na mesma média de pilar de quem já respondeu (diagnóstico coletivo,
// não um segundo diagnóstico paralelo).
function RespondentsSection({ sessionId }: { sessionId: string }) {
  const [respondents, setRespondents] = useState<Respondent[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', roleTitle: '', area: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [newInviteUrl, setNewInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  // Respondente cujo mini-formulário de "enviar por WhatsApp" está aberto
  // (radar_respondents não guarda telefone — pede na hora do envio).
  const [resendPhoneFor, setResendPhoneFor] = useState<string | null>(null);
  const [resendPhone, setResendPhone] = useState('');

  const load = useCallback(() => {
    api(`/sessions/${sessionId}/respondents`).then((d) => setRespondents(Array.isArray(d) ? d : [])).catch(() => {});
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const result = await api(`/sessions/${sessionId}/respondents`, { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', roleTitle: '', area: '', email: '' });
      setAdding(false);
      const absoluteUrl = `${window.location.origin}${result.inviteUrl}`;
      setNewInviteUrl(absoluteUrl);
      setCopied(false);
      load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível adicionar o respondente.');
    } finally {
      setSaving(false);
    }
  };

  const copyInvite = () => {
    if (!newInviteUrl) return;
    navigator.clipboard.writeText(newInviteUrl).then(() => setCopied(true)).catch(() => toast.error('Não foi possível copiar. Selecione e copie manualmente.'));
  };

  const revoke = async (respondentId: string) => {
    try {
      await api(`/sessions/${sessionId}/respondents/${respondentId}/revoke`, { method: 'POST' });
      load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível revogar o convite.');
    }
  };

  // Reenvio do convite (ADR-025): o servidor ROTACIONA o token (link antigo
  // morre na hora) e devolve o novo — mostrado uma única vez, igual à criação.
  // Com canal email/whatsapp, o próprio servidor já envia o link novo.
  const resend = async (respondentId: string, channel: 'link' | 'email' | 'whatsapp', phone?: string) => {
    if (resending) return;
    setResending(respondentId);
    try {
      const result = await api(`/sessions/${sessionId}/respondents/${respondentId}/resend`, {
        method: 'POST', body: JSON.stringify({ channel, phone }),
      });
      setNewInviteUrl(`${window.location.origin}${result.inviteUrl}`);
      setCopied(false);
      if (channel === 'email') toast.success('Convite reenviado por e-mail com um link novo.');
      else if (channel === 'whatsapp') toast.success('Convite enviado por WhatsApp com um link novo.');
      else toast.success('Novo link gerado — o anterior deixou de funcionar.');
      setResendPhoneFor(null);
      load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível reenviar o convite.');
    } finally {
      setResending(null);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wide">Respondentes</h3>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-xs text-white/50 hover:text-white/80 inline-flex items-center gap-1">
            <Plus size={13} /> Convidar
          </button>
        )}
      </div>

      {newInviteUrl && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <p className="text-xs text-white/50 mb-1.5">Link de convite (guarde agora — não é mostrado de novo):</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-white/80 truncate">{newInviteUrl}</code>
            <button onClick={copyInvite} className="text-xs px-2 py-1 rounded border border-white/15 text-white/70 hover:border-white/30 shrink-0">
              {copied ? 'Copiado!' : 'Copiar'}
            </button>
          </div>
        </div>
      )}

      {respondents.length === 0 && !adding && (
        <p className="mt-2 text-sm text-white/40">Ninguém convidado ainda além de quem criou o diagnóstico.</p>
      )}

      {respondents.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {respondents.map((r) => {
            const st = RESPONDENT_STATUS_LABEL[r.status] || { label: r.status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
            const canResend = r.status !== 'revoked' && r.status !== 'completed';
            return (
              <div key={r.id} className="text-sm text-white/70">
                <div className="flex items-center justify-between gap-2">
                  <span>{r.name}{r.role_title ? ` · ${r.role_title}` : ''}{r.area ? ` · ${r.area}` : ''}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>
                    {canResend && (
                      <>
                        <button onClick={() => resend(r.id, 'link')} disabled={!!resending} className="text-xs text-white/30 hover:text-emerald-300 disabled:opacity-40">
                          {resending === r.id ? '...' : 'Novo link'}
                        </button>
                        {r.email && (
                          <button onClick={() => resend(r.id, 'email')} disabled={!!resending} className="text-xs text-white/30 hover:text-emerald-300 disabled:opacity-40">E-mail</button>
                        )}
                        <button onClick={() => { setResendPhoneFor(resendPhoneFor === r.id ? null : r.id); setResendPhone(''); }} disabled={!!resending} className="text-xs text-white/30 hover:text-emerald-300 disabled:opacity-40">WhatsApp</button>
                        <button onClick={() => revoke(r.id)} className="text-xs text-white/30 hover:text-red-300">Revogar</button>
                      </>
                    )}
                  </span>
                </div>
                {resendPhoneFor === r.id && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      className="flex-1 max-w-[220px] rounded border border-white/15 bg-white/[0.04] px-2 py-1 text-xs text-white/80"
                      placeholder="Telefone com DDD, ex.: 11 99999-9999"
                      value={resendPhone} onChange={(e) => setResendPhone(e.target.value)}
                    />
                    <button
                      onClick={() => resend(r.id, 'whatsapp', resendPhone)}
                      disabled={!resendPhone.trim() || !!resending}
                      className="text-xs px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 disabled:opacity-40"
                    >Enviar</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Nome *"><input className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></Field>
          <Field label="Cargo"><input className={inputCls} value={form.roleTitle} onChange={(e) => setForm((f) => ({ ...f, roleTitle: e.target.value }))} /></Field>
          <Field label="Área"><input className={inputCls} value={form.area} onChange={(e) => setForm((f) => ({ ...f, area: e.target.value }))} /></Field>
          <Field label="E-mail"><input className={inputCls} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></Field>
          <div className="sm:col-span-2 flex gap-2">
            <button onClick={submit} disabled={!form.name.trim() || saving} className="rounded-lg px-4 py-2 text-sm font-semibold text-[#0b0f12] disabled:opacity-40" style={{ background: teal }}>
              {saving ? <Loader2 className="animate-spin" size={16} /> : 'Salvar'}
            </button>
            <button onClick={() => setAdding(false)} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70">Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}
