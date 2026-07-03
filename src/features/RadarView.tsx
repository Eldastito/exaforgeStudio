import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, ChangeEvent } from 'react';
import {
  Radar, Plus, ArrowLeft, ArrowRight, Loader2, HelpCircle, Sparkles, TrendingUp,
  Gauge, RefreshCw, ChevronRight, Paperclip,
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

function Card({ children, className = '' }: { children?: ReactNode; className?: string }) {
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

  const progress = Math.round((qIndex / questions.length) * 100);

  return (
    <div className="max-w-2xl mx-auto">
      <button onClick={onBack} className="text-sm text-white/50 hover:text-white/80 inline-flex items-center gap-1 mb-5">
        <ArrowLeft size={14} /> Voltar para a lista
      </button>

      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: teal }} />
      </div>
      <div className="mt-2 text-xs text-white/40">Pergunta {qIndex + 1} de {questions.length} · {PILLAR_LABEL[q.pillar] || q.pillar}</div>

      <h2 className="mt-5 text-xl font-semibold text-balance">{q.title}</h2>
      {q.help_text && <p className="mt-1.5 text-sm text-white/50">{q.help_text}</p>}

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
    </div>
  );
}

function ResultView({ session, onBack }: { session: Session; onBack: () => void }) {
  const score = session.overall_maturity_score;
  const level = session.maturity_level;
  const pillarScores = session.pillarScores || [];
  const sorted = [...pillarScores].filter((p) => p.score != null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const gaps = sorted.slice(0, 2);
  const topRecs = (session.recommendations || []).slice(0, 3);

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

      <RespondentsSection sessionId={session.id} />
    </div>
  );
}

type Respondent = { id: string; name: string; email: string | null; role_title: string | null; area: string | null };

// Registro de quem mais ajudou a responder o diagnóstico (Fase 3, ADR-014).
// Só cadastro/histórico por enquanto — convite por link próprio (respondente
// sem login) é uma peça maior, deliberadamente fora desta rodada.
function RespondentsSection({ sessionId }: { sessionId: string }) {
  const [respondents, setRespondents] = useState<Respondent[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', roleTitle: '', area: '', email: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api(`/sessions/${sessionId}/respondents`).then((d) => setRespondents(Array.isArray(d) ? d : [])).catch(() => {});
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      await api(`/sessions/${sessionId}/respondents`, { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', roleTitle: '', area: '', email: '' });
      setAdding(false);
      load();
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível adicionar o respondente.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wide">Respondentes</h3>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-xs text-white/50 hover:text-white/80 inline-flex items-center gap-1">
            <Plus size={13} /> Adicionar
          </button>
        )}
      </div>

      {respondents.length === 0 && !adding && (
        <p className="mt-2 text-sm text-white/40">Ninguém registrado ainda além de quem criou o diagnóstico.</p>
      )}

      {respondents.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {respondents.map((r) => (
            <div key={r.id} className="text-sm text-white/70">
              {r.name}{r.role_title ? ` · ${r.role_title}` : ''}{r.area ? ` · ${r.area}` : ''}
            </div>
          ))}
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
