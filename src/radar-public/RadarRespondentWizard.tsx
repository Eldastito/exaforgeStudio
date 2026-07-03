import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Radar, ArrowLeft, ArrowRight, Loader2, HelpCircle, CheckCircle2, AlertTriangle } from 'lucide-react';

// Convite de respondente por link próprio (ADR-018) — sessão de um tenant já
// existente, respondida sem login do ZappFlow. Mesma linguagem visual do
// diagnóstico público (RadarPublicWizard.tsx), mas sem onboarding (o
// respondente já foi identificado pelo token) e sem resultado (o score
// completo da organização mora no painel autenticado — este visitante só
// contribui, não gerencia o diagnóstico).

const teal = 'var(--color-zf-teal)';
const amber = 'var(--color-zf-amber)';

const PILLAR_LABEL: Record<string, string> = {
  estrategia: 'Estratégia e liderança',
  receita: 'Receita e atendimento',
  processos: 'Processos operacionais',
  dados: 'Dados e integração',
  pessoas: 'Pessoas e capacitação',
  governanca: 'Governança e segurança',
  metricas: 'Métricas e ROI',
};

type Question = {
  id: string; pillar: string; title: string; help_text: string | null; display_order: number;
  options: { value: string; label: string; score: number }[] | null;
};
type Ctx = {
  respondent: { id: string; name: string; roleTitle: string | null; status: string };
  session: { id: string; companyName: string | null; status: string };
  template: { questions: Question[] };
  answers: { question_id: string; answer_json: string; is_not_known: number }[];
};

function readToken(): string | null {
  const parts = window.location.pathname.split('/').filter(Boolean); // ["radar-ia","respond",":token"]
  if (parts[0] === 'radar-ia' && parts[1] === 'respond' && parts[2]) return decodeURIComponent(parts[2]);
  return null;
}

async function api(token: string, path: string, opts: RequestInit = {}) {
  const res = await fetch(`/api/public/radar/respond/${encodeURIComponent(token)}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
  return json;
}

export function RadarRespondentWizard() {
  const token = useMemo(readToken, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setError('Link inválido.'); setLoading(false); return; }
    (async () => {
      try {
        const data = await api(token, '');
        setCtx(data);
        if (data.respondent.status === 'completed') { setDone(true); return; }
        const answered = new Set(data.answers.map((a: any) => a.question_id));
        const firstUnanswered = data.template.questions.findIndex((q: Question) => !answered.has(q.id));
        setQIndex(firstUnanswered >= 0 ? firstUnanswered : 0);
      } catch (e: any) {
        setError(e.message || 'Este convite expirou, foi revogado ou é inválido.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  if (loading) {
    return <Centered><Loader2 className="animate-spin" size={28} style={{ color: teal }} /></Centered>;
  }

  return (
    <div className="min-h-screen bg-[#0b0f12] text-white">
      <Header />
      <main className="max-w-2xl mx-auto px-5 pb-24">
        {error && <ErrorState message={error} />}
        {!error && done && ctx && <DoneState companyName={ctx.session.companyName} respondentName={ctx.respondent.name} />}
        {!error && !done && ctx && token && (
          <QuestionsStep
            ctx={ctx} token={token} qIndex={qIndex} setQIndex={setQIndex}
            onSessionUpdate={setCtx}
            onDone={async () => {
              await api(token, '/complete', { method: 'POST' });
              setDone(true);
            }}
          />
        )}
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
      Suas respostas ajudam a compor o diagnóstico de maturidade em IA desta empresa — não constituem, sozinhas, um resultado individual.
    </footer>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="pt-10 text-center">
      <AlertTriangle size={32} className="mx-auto mb-3" style={{ color: amber }} />
      <h1 className="text-xl font-bold">Não foi possível abrir este convite</h1>
      <p className="mt-2 text-white/60 text-sm">{message}</p>
    </div>
  );
}

function DoneState({ companyName, respondentName }: { companyName: string | null; respondentName: string }) {
  return (
    <div className="pt-10 text-center">
      <CheckCircle2 size={32} className="mx-auto mb-3" style={{ color: teal }} />
      <h1 className="text-xl font-bold">Obrigado, {respondentName.split(' ')[0]}!</h1>
      <p className="mt-2 text-white/60 text-sm">
        Suas respostas foram registradas{companyName ? ` no diagnóstico de ${companyName}` : ''}. O resultado completo fica disponível para quem administra o diagnóstico.
      </p>
    </div>
  );
}

const inputCls = 'w-full rounded-lg border border-white/15 bg-white/[0.04] px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none focus:border-white/40';

function QuestionsStep({
  ctx, token, qIndex, setQIndex, onDone, onSessionUpdate,
}: {
  ctx: Ctx; token: string; qIndex: number; setQIndex: (n: number) => void; onDone: () => Promise<void>; onSessionUpdate: (c: Ctx) => void;
}) {
  const questions = ctx.template.questions;
  const q = questions[qIndex];
  const answeredMap = useMemo(() => {
    const m = new Map<string, { value: string | null; isNotKnown: boolean }>();
    for (const a of ctx.answers) {
      let value: string | null = null;
      try { value = JSON.parse(a.answer_json); } catch { /* noop */ }
      m.set(a.question_id, { value, isNotKnown: !!a.is_not_known });
    }
    return m;
  }, [ctx.answers]);

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
      await api(token, '/answers', { method: 'POST', body: JSON.stringify({ questionId: q.id, value: selected, isNotKnown: notKnown, comment }) });
      const fresh = await api(token, '');
      onSessionUpdate(fresh);
      if (qIndex < questions.length - 1) setQIndex(qIndex + 1);
      else await onDone();
    } catch (e: any) {
      // mantém na mesma pergunta pra tentar de novo (ex.: sessão fechou nesse meio-tempo)
      window.alert(e.message || 'Não foi possível salvar. Tente novamente.');
    } finally {
      setSaving(false);
    }
  }

  const progress = Math.round((qIndex / questions.length) * 100);

  return (
    <div className="pt-6">
      {ctx.session.companyName && (
        <p className="text-sm text-white/50 mb-4">Diagnóstico de <span className="text-white/80 font-medium">{ctx.session.companyName}</span></p>
      )}
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
        <span className="block text-xs font-medium text-white/50 mb-1.5">Quer explicar melhor? (opcional)</span>
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
          {saving ? <Loader2 className="animate-spin" size={18} /> : qIndex < questions.length - 1 ? <>Próxima <ArrowRight size={18} /></> : <>Concluir</>}
        </button>
      </div>
    </div>
  );
}
