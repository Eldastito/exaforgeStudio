import { useEffect, useMemo, useState } from 'react';
import type { ReactNode, ChangeEvent } from 'react';
import {
  Radar, ArrowRight, ArrowLeft, ShieldCheck, Clock, CheckCircle2, Loader2,
  HelpCircle, Sparkles, TrendingUp, Lock,
} from 'lucide-react';

const teal = 'var(--color-zf-teal)';
const amber = 'var(--color-zf-amber)';

type Step = 'intro' | 'onboarding' | 'questions' | 'result';

type Question = {
  id: string;
  pillar: string;
  title: string;
  help_text: string | null;
  answer_type: string;
  display_order: number;
  options: { value: string; label: string; score: number }[] | null;
};

type Template = { id: string; questions: Question[] };

type PublicSession = {
  id: string;
  status: string;
  company_name: string | null;
  template: Template;
  answers: { question_id: string; answer_json: string; is_not_known: number }[];
};

type ResultPayload = {
  session: {
    companyName: string | null;
    overallMaturityScore: number | null;
    maturityLevel: string | null;
    confidenceScore: number | null;
  };
  pillarScores: { pillar: string; score: number | null; evidence_count: number }[];
  topRecommendations: { priority_band: string; use_case_name: string; quick_win_steps_json: string | null }[];
  lead?: { created: boolean; reason?: string };
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
  inerte: 'Inerte',
  experimental: 'Experimental',
  organizando: 'Organizando',
  integrada: 'Integrada',
  inteligente: 'Inteligente',
};

// Lê o token da URL (/radar-ia/s/:token[/resultado]) sem depender de um router.
function readUrl(): { token: string | null; wantsResult: boolean } {
  const parts = window.location.pathname.split('/').filter(Boolean); // ["radar-ia","s",":token","resultado"?]
  if (parts[0] === 'radar-ia' && parts[1] === 's' && parts[2]) {
    return { token: decodeURIComponent(parts[2]), wantsResult: parts[3] === 'resultado' };
  }
  return { token: null, wantsResult: false };
}

function pushUrl(token: string, result = false) {
  const path = `/radar-ia/s/${encodeURIComponent(token)}${result ? '/resultado' : ''}`;
  window.history.pushState({}, '', path);
}

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/public/radar${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
  return json;
}

export function RadarPublicWizard() {
  const initial = useMemo(readUrl, []);
  const [step, setStep] = useState<Step>(initial.token ? 'questions' : 'intro');
  const [token, setToken] = useState<string | null>(initial.token);
  const [session, setSession] = useState<PublicSession | null>(null);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [loading, setLoading] = useState(!!initial.token);
  const [error, setError] = useState<string | null>(null);
  const [qIndex, setQIndex] = useState(0);

  // Retomada de sessão a partir da URL.
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const s = await api(`/sessions/${encodeURIComponent(token)}`);
        setSession(s);
        if (s.status === 'completed' || initial.wantsResult) {
          const r = await api(`/sessions/${encodeURIComponent(token)}/result`);
          setResult(r);
          setStep('result');
        } else {
          const answered = new Set(s.answers.map((a: any) => a.question_id));
          const firstUnanswered = s.template.questions.findIndex((q: Question) => !answered.has(q.id));
          setQIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
          setStep('questions');
        }
      } catch (e: any) {
        setError('Este link expirou ou não é válido. Comece um novo diagnóstico abaixo.');
        setToken(null);
        setStep('intro');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <Centered>
        <Loader2 className="animate-spin" size={28} style={{ color: teal }} />
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0f12] text-white">
      <Header />
      <main className="max-w-2xl mx-auto px-5 pb-24">
        {step === 'intro' && <IntroStep error={error} onStart={() => setStep('onboarding')} />}
        {step === 'onboarding' && (
          <OnboardingStep
            onBack={() => setStep('intro')}
            onCreated={(s, tk) => {
              setSession(s);
              setToken(tk);
              setQIndex(0);
              pushUrl(tk);
              setStep('questions');
            }}
          />
        )}
        {step === 'questions' && session && token && (
          <QuestionsStep
            session={session}
            token={token}
            qIndex={qIndex}
            setQIndex={setQIndex}
            onDone={async () => {
              const r = await api(`/sessions/${encodeURIComponent(token)}/complete`, { method: 'POST' });
              setResult(r);
              pushUrl(token, true);
              setStep('result');
            }}
          />
        )}
        {step === 'result' && result && <ResultStep result={result} />}
      </main>
      <Footer />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[#0b0f12] flex items-center justify-center">{children}</div>;
}

function Header() {
  return (
    <header className="max-w-2xl mx-auto px-5 pt-8 pb-6 flex items-center gap-2">
      <Radar size={22} style={{ color: teal }} />
      <span className="font-bold tracking-tight text-lg">
        Zapp<span style={{ color: teal }}>Flow</span> <span className="font-normal text-white/60">Radar</span>
      </span>
    </header>
  );
}

function Footer() {
  return (
    <footer className="max-w-2xl mx-auto px-5 py-10 text-xs text-white/40 border-t border-white/10 mt-10">
      Este diagnóstico é uma análise orientativa baseada nas respostas informadas. Scores e estimativas não constituem
      garantia de resultado, parecer jurídico ou auditoria de segurança.
    </footer>
  );
}

function IntroStep({ error, onStart }: { error: string | null; onStart: () => void }) {
  return (
    <div className="pt-6">
      {error && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      )}
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-balance">
        Descubra onde sua empresa está perdendo tempo, vendas e controle.
      </h1>
      <p className="mt-4 text-white/70 text-lg leading-relaxed">
        Em poucos minutos, você entende onde a operação está deixando dinheiro na mesa e recebe as prioridades de
        maior retorno — sem cadastro de cartão, sem compromisso.
      </p>
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <InfoCard icon={<Clock size={18} />} title="12 minutos" desc="18 perguntas objetivas, direto ao ponto." />
        <InfoCard icon={<ShieldCheck size={18} />} title="Sem custo" desc="Resultado na hora, sem falar com ninguém." />
        <InfoCard icon={<Lock size={18} />} title="Seus dados" desc="Usados só para gerar seu diagnóstico." />
      </div>
      <button
        onClick={onStart}
        className="mt-9 inline-flex items-center gap-2 rounded-lg px-6 py-3.5 font-semibold text-[#0b0f12] transition hover:opacity-90"
        style={{ background: teal }}
      >
        Descobrir meus gaps <ArrowRight size={18} />
      </button>
    </div>
  );
}

function InfoCard({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 font-semibold" style={{ color: amber }}>{icon} {title}</div>
      <div className="mt-1 text-sm text-white/60">{desc}</div>
    </div>
  );
}

const SEGMENTS = [
  'Comércio varejista', 'Serviços profissionais', 'Clínicas/saúde', 'Hotelaria/pousadas', 'Educação',
  'Logística/transporte', 'Imobiliário', 'Alimentação', 'Oficinas/manutenção', 'Indústria leve', 'E-commerce', 'Outros',
];
const SIZES = ['1-9', '10-49', '50-99', '100-249', '250+'];

function OnboardingStep({ onBack, onCreated }: { onBack: () => void; onCreated: (s: PublicSession, token: string) => void }) {
  const [form, setForm] = useState({
    contactName: '', companyName: '', contactRole: '', contactEmail: '', contactPhone: '',
    segment: '', companySize: '', city: '', state: '', primaryGoal: '',
    consentDiagnostico: false, consentContato: false,
    website: '', // honeypot — nunca exibido, só bots preenchem
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (k: string) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const canSubmit = form.contactName.trim() && form.companyName.trim() && /\S+@\S+\.\S+/.test(form.contactEmail) && form.consentDiagnostico;

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { session, token } = await api('/sessions', { method: 'POST', body: JSON.stringify(form) });
      if (form.consentDiagnostico) await api(`/sessions/${token}/consent`, { method: 'POST', body: JSON.stringify({ consentType: 'diagnostico', granted: true }) });
      if (form.consentContato) await api(`/sessions/${token}/consent`, { method: 'POST', body: JSON.stringify({ consentType: 'contato_comercial', granted: true }) });
      onCreated(session, token);
    } catch (e: any) {
      setError(e.message || 'Não foi possível iniciar o diagnóstico. Tente novamente.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="pt-6">
      <button onClick={onBack} className="text-sm text-white/50 hover:text-white/80 inline-flex items-center gap-1 mb-5">
        <ArrowLeft size={14} /> Voltar
      </button>
      <h2 className="text-2xl font-bold">Antes de começar, uma apresentação rápida</h2>
      <p className="mt-1 text-white/60 text-sm">Usamos isso só para personalizar seu diagnóstico e enviar o resultado.</p>

      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Seu nome *"><input className={inputCls} value={form.contactName} onChange={set('contactName')} /></Field>
        <Field label="Cargo"><input className={inputCls} value={form.contactRole} onChange={set('contactRole')} /></Field>
        <Field label="Empresa *"><input className={inputCls} value={form.companyName} onChange={set('companyName')} /></Field>
        <Field label="E-mail *"><input type="email" className={inputCls} value={form.contactEmail} onChange={set('contactEmail')} /></Field>
        <Field label="WhatsApp (opcional)"><input className={inputCls} value={form.contactPhone} onChange={set('contactPhone')} placeholder="5511999998888" /></Field>
        <Field label="Cidade/UF">
          <div className="flex gap-2">
            <input className={inputCls} value={form.city} onChange={set('city')} placeholder="Cidade" />
            <input className={`${inputCls} w-20`} value={form.state} onChange={set('state')} placeholder="UF" maxLength={2} />
          </div>
        </Field>
        <Field label="Segmento">
          <select className={inputCls} value={form.segment} onChange={set('segment')}>
            <option value="">Selecione</option>
            {SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Porte (nº de pessoas)">
          <select className={inputCls} value={form.companySize} onChange={set('companySize')}>
            <option value="">Selecione</option>
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Objetivo principal nos próximos 90 dias">
            <input className={inputCls} value={form.primaryGoal} onChange={set('primaryGoal')} placeholder="Ex.: aumentar vendas, organizar a operação..." />
          </Field>
        </div>
      </div>

      {/* Honeypot — invisível para humanos, só bots preenchem. */}
      <input
        type="text" tabIndex={-1} autoComplete="off" value={form.website}
        onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
        style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
        aria-hidden="true"
      />

      <div className="mt-6 space-y-3 text-sm">
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={form.consentDiagnostico} onChange={(e) => setForm((f) => ({ ...f, consentDiagnostico: e.target.checked }))} />
          <span className="text-white/70">Concordo com a análise das minhas respostas para gerar o diagnóstico. *</span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={form.consentContato} onChange={(e) => setForm((f) => ({ ...f, consentContato: e.target.checked }))} />
          <span className="text-white/70">Aceito ser contatado pela equipe ZappFlow sobre este diagnóstico (opcional).</span>
        </label>
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      <button
        onClick={submit}
        disabled={!canSubmit || submitting}
        className="mt-6 inline-flex items-center gap-2 rounded-lg px-6 py-3.5 font-semibold text-[#0b0f12] transition disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
        style={{ background: teal }}
      >
        {submitting ? <Loader2 className="animate-spin" size={18} /> : <>Começar diagnóstico <ArrowRight size={18} /></>}
      </button>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-white/40';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-white/50 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function QuestionsStep({
  session, token, qIndex, setQIndex, onDone,
}: {
  session: PublicSession; token: string; qIndex: number; setQIndex: (n: number) => void; onDone: () => void;
}) {
  const questions = session.template.questions;
  const q = questions[qIndex];
  const answeredMap = useMemo(() => {
    const m = new Map<string, { value: string | null; isNotKnown: boolean }>();
    for (const a of session.answers) {
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

  useEffect(() => {
    setSelected(answeredMap.get(q.id)?.value ?? null);
    setNotKnown(!!answeredMap.get(q.id)?.isNotKnown);
    setComment('');
  }, [q.id, answeredMap]);

  async function advance() {
    if (!selected && !notKnown) return;
    setSaving(true);
    try {
      await api(`/sessions/${encodeURIComponent(token)}/answers`, {
        method: 'POST',
        body: JSON.stringify({ questionId: q.id, value: selected, isNotKnown: notKnown, comment }),
      });
      if (qIndex < questions.length - 1) setQIndex(qIndex + 1);
      else await onDone();
    } catch {
      // Falha ao salvar: mantém na mesma pergunta para o visitante tentar de novo.
    } finally {
      setSaving(false);
    }
  }

  const progress = Math.round((qIndex / questions.length) * 100);

  return (
    <div className="pt-6">
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: teal }} />
      </div>
      <div className="mt-2 text-xs text-white/40">Pergunta {qIndex + 1} de {questions.length} · {PILLAR_LABEL[q.pillar] || q.pillar}</div>

      <h2 className="mt-5 text-xl sm:text-2xl font-semibold text-balance">{q.title}</h2>
      {q.help_text && <p className="mt-1.5 text-sm text-white/50">{q.help_text}</p>}

      <div className="mt-6 space-y-2.5">
        {(q.options || []).map((opt) => (
          <button
            key={opt.value}
            onClick={() => { setSelected(opt.value); setNotKnown(false); }}
            className={`w-full text-left rounded-lg border px-4 py-3 text-sm transition ${
              selected === opt.value && !notKnown ? 'border-transparent text-[#0b0f12]' : 'border-white/15 bg-white/[0.03] text-white/80 hover:border-white/30'
            }`}
            style={selected === opt.value && !notKnown ? { background: teal } : undefined}
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => { setNotKnown(true); setSelected(null); }}
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

      <div className="mt-7 flex items-center gap-3">
        {qIndex > 0 && (
          <button onClick={() => setQIndex(qIndex - 1)} className="rounded-lg border border-white/15 px-4 py-3 text-sm text-white/70 hover:border-white/30">
            <ArrowLeft size={16} />
          </button>
        )}
        <button
          onClick={advance}
          disabled={(!selected && !notKnown) || saving}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3.5 font-semibold text-[#0b0f12] transition disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90"
          style={{ background: teal }}
        >
          {saving ? <Loader2 className="animate-spin" size={18} /> : qIndex < questions.length - 1 ? <>Próxima <ArrowRight size={18} /></> : <>Ver meu resultado <Sparkles size={18} /></>}
        </button>
      </div>
    </div>
  );
}

function ResultStep({ result }: { result: ResultPayload }) {
  const score = result.session.overallMaturityScore;
  const level = result.session.maturityLevel;
  const sorted = [...result.pillarScores].filter((p) => p.score != null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const gaps = sorted.slice(0, 2);

  return (
    <div className="pt-6">
      <div className="flex items-center gap-2 text-sm" style={{ color: amber }}>
        <CheckCircle2 size={16} /> Diagnóstico concluído
      </div>
      <h2 className="mt-2 text-2xl sm:text-3xl font-bold text-balance">
        {result.session.companyName ? `Resultado para ${result.session.companyName}` : 'Seu resultado'}
      </h2>

      <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-6 flex items-center gap-6">
        <div className="text-5xl font-bold tabular-nums" style={{ color: teal }}>{score != null ? Math.round(score) : '—'}</div>
        <div>
          <div className="text-lg font-semibold">{level ? LEVEL_LABEL[level] || level : 'Sem dados suficientes'}</div>
          <div className="text-sm text-white/50">Índice de maturidade (0-100)</div>
        </div>
      </div>

      <h3 className="mt-8 text-sm font-semibold text-white/50 uppercase tracking-wide">Os 7 pilares</h3>
      <div className="mt-3 space-y-2.5">
        {result.pillarScores.map((p) => (
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

      {result.topRecommendations.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-white/50 uppercase tracking-wide">Quick win recomendado</h3>
          <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-4">
            <div className="font-semibold">{result.topRecommendations[0].use_case_name}</div>
          </div>
        </div>
      )}

      <div className="mt-10 rounded-xl border p-6" style={{ borderColor: 'rgba(20,184,166,0.3)', background: 'rgba(20,184,166,0.06)' }}>
        <div className="font-semibold text-lg">Quer o diagnóstico completo, com plano de 90 dias?</div>
        <p className="mt-1.5 text-sm text-white/60">
          Fale com nosso time para aprofundar essa análise com dados reais da sua operação.
        </p>
        <a
          href="https://wa.me/?text=Quero%20o%20diagn%C3%B3stico%20executivo%20do%20ZappFlow"
          target="_blank" rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-2 rounded-lg px-5 py-3 font-semibold text-[#0b0f12] hover:opacity-90"
          style={{ background: teal }}
        >
          Falar com o time <ArrowRight size={16} />
        </a>
      </div>
    </div>
  );
}
