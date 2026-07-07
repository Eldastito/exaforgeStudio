import { useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from '@/src/lib/api';
import { ShieldAlert, ShoppingCart, ListChecks, Loader2, ChevronDown, ChevronUp, X, Check, Send } from 'lucide-react';

// Trio de auditoria filosófica (Tier 2, ADR-050) — Sinek + Sinek + Domingos.
// Card unificado no dashboard mostrando: quantos Celery Tests pendentes,
// quantos alertas de manipulação abertos, e o último Checklist de
// Fundamentos rodado. Cada seção expande sob demanda pra não poluir a tela.

interface CeleryTest {
  id: string;
  subject: string;
  question: string;
  status: 'pending' | 'answered';
  decision: 'keeps' | 'drops' | 'needs_review' | null;
  createdAt: string;
}

interface ManipulationAlert {
  id: string;
  sampleText: string;
  tactics: string[];
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
}

interface FundamentalsCheck {
  id: string;
  status: 'passed' | 'passed_with_warnings' | 'blocked';
  score: number;
  recommendation: string;
  items: { key: string; label: string; status: 'ok' | 'attention' | 'critical' | 'unknown'; evidence: string }[];
  createdAt: string;
}

const TACTIC_LABEL: Record<string, string> = {
  discount: 'desconto', urgency: 'urgência', pressure: 'pressão', scarcity: 'escassez', fear: 'medo',
};

const ITEM_COLOR: Record<string, string> = {
  ok: 'text-emerald-300', attention: 'text-amber-300', critical: 'text-rose-300', unknown: 'text-zinc-500',
};

export function PhilosophyAudit({ className = '' }: { className?: string }) {
  const [celery, setCelery] = useState<{ tests: CeleryTest[]; metrics: any } | null>(null);
  const [manip, setManip] = useState<{ alerts: ManipulationAlert[]; metrics: any } | null>(null);
  const [funds, setFunds] = useState<{ latest: FundamentalsCheck | null; history: FundamentalsCheck[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<'celery' | 'manip' | 'funds' | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [c, m, f] = await Promise.all([
        apiFetch('/api/philosophy/celery?status=pending').then((r) => r.json()).catch(() => ({ tests: [], metrics: {} })),
        apiFetch('/api/philosophy/manipulation?status=open').then((r) => r.json()).catch(() => ({ alerts: [], metrics: {} })),
        apiFetch('/api/philosophy/fundamentals').then((r) => r.json()).catch(() => ({ latest: null, history: [] })),
      ]);
      setCelery(c); setManip(m); setFunds(f);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading || !celery || !manip || !funds) {
    return (
      <div className={`rounded-2xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3 ${className}`}>
        <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
        <span className="text-sm text-slate-400">Carregando auditoria filosófica…</span>
      </div>
    );
  }

  const celeryPending = celery.tests.filter((t) => t.status === 'pending').length;
  const manipOpen = manip.alerts.length;
  const latest = funds.latest;

  // Se tudo zerado E sem histórico, o card não aparece — dashboard limpo.
  if (celeryPending === 0 && manipOpen === 0 && !latest) return null;

  return (
    <div className={`rounded-2xl border border-slate-800 bg-slate-900/50 p-5 ${className}`}>
      <div className="flex items-center gap-3 mb-3">
        <div className="rounded-lg bg-slate-800/80 p-2">
          <ShieldAlert className="w-4 h-4 text-slate-300" />
        </div>
        <div className="flex-1">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">🧭 Auditoria filosófica</p>
          <p className="text-sm text-zinc-100">Manter marca coerente: Sinek (Por Quê), Domingos (fundamentos).</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SubCard
          title="Celery Test"
          subtitle="Combina com o carrinho?"
          badge={celeryPending > 0 ? `${celeryPending} pendente${celeryPending === 1 ? '' : 's'}` : 'em dia'}
          icon={<ShoppingCart className="w-4 h-4 text-purple-300" />}
          accent="border-purple-500/30 bg-purple-500/5"
          onClick={() => setOpen(open === 'celery' ? null : 'celery')}
          expanded={open === 'celery'}
        />
        <SubCard
          title="Radar de Manipulação"
          subtitle="Desconto/urgência/pressão?"
          badge={manipOpen > 0 ? `${manipOpen} alerta${manipOpen === 1 ? '' : 's'}` : 'sem alertas'}
          icon={<ShieldAlert className="w-4 h-4 text-rose-300" />}
          accent="border-rose-500/30 bg-rose-500/5"
          onClick={() => setOpen(open === 'manip' ? null : 'manip')}
          expanded={open === 'manip'}
        />
        <SubCard
          title="Fundamentos"
          subtitle={latest ? `Score ${latest.score}/100` : 'não rodado'}
          badge={latest ? statusLabel(latest.status) : 'rodar agora'}
          icon={<ListChecks className="w-4 h-4 text-emerald-300" />}
          accent="border-emerald-500/30 bg-emerald-500/5"
          onClick={() => setOpen(open === 'funds' ? null : 'funds')}
          expanded={open === 'funds'}
        />
      </div>

      {open === 'celery' && <CeleryPanel tests={celery.tests} onDone={load} />}
      {open === 'manip' && <ManipulationPanel alerts={manip.alerts} onDone={load} />}
      {open === 'funds' && <FundamentalsPanel latest={latest} onDone={load} />}
    </div>
  );
}

function statusLabel(s: string): string {
  if (s === 'passed') return 'aprovado';
  if (s === 'passed_with_warnings') return 'com atenções';
  if (s === 'blocked') return 'pause antes';
  return s;
}

function SubCard({ title, subtitle, badge, icon, accent, onClick, expanded }: {
  title: string; subtitle: string; badge: string; icon: ReactNode;
  accent: string; onClick: () => void; expanded: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-xl border ${accent} p-3 hover:bg-slate-800/40 transition-colors`}
    >
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-sm font-medium text-zinc-100">{title}</span>
        {expanded ? <ChevronUp className="w-3 h-3 ml-auto text-zinc-500" /> : <ChevronDown className="w-3 h-3 ml-auto text-zinc-500" />}
      </div>
      <p className="text-xs text-zinc-400">{subtitle}</p>
      <p className="text-[11px] text-zinc-300 mt-1.5">{badge}</p>
    </button>
  );
}

function CeleryPanel({ tests, onDone }: { tests: CeleryTest[]; onDone: () => void }) {
  const [subject, setSubject] = useState('');
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const create = async () => {
    if (!subject.trim()) return;
    setCreating(true);
    try {
      const res = await apiFetch('/api/philosophy/celery', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject }),
      });
      if (res.ok) { setSubject(''); onDone(); }
    } finally { setCreating(false); }
  };

  const answer = async (id: string, decision: 'keeps' | 'drops' | 'needs_review') => {
    setActing((s) => ({ ...s, [id]: true }));
    try {
      const res = await apiFetch(`/api/philosophy/celery/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, answer: drafts[id] || '' }),
      });
      if (res.ok) onDone();
    } finally { setActing((s) => { const { [id]: _, ...rest } = s; return rest; }); }
  };

  return (
    <div className="mt-4 rounded-xl border border-purple-500/20 bg-slate-950/50 p-3">
      <p className="text-xs text-zinc-300 mb-2">
        Antes de adotar uma prática/produto novo, pergunte: "combina com o carrinho da minha marca?"
      </p>
      <div className="flex gap-2 mb-3">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Ex.: começar a vender pacote com brinde? oferecer parcelamento em 12x?"
          className="flex-1 text-xs bg-slate-900 border border-slate-800 rounded-md px-2.5 py-1.5 text-zinc-100"
        />
        <button
          onClick={create} disabled={creating || !subject.trim()}
          className="text-xs bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-md px-3 py-1.5 inline-flex items-center gap-1"
        >
          {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : '+ Novo teste'}
        </button>
      </div>
      {tests.length === 0 && <p className="text-xs text-zinc-500">Nenhuma pergunta pendente.</p>}
      <ul className="space-y-2">
        {tests.filter((t) => t.status === 'pending').map((t) => (
          <li key={t.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
            <p className="text-xs font-medium text-zinc-100">{t.subject}</p>
            <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap font-sans mt-1 leading-relaxed">{t.question}</pre>
            <textarea
              value={drafts[t.id] || ''}
              onChange={(e) => setDrafts((s) => ({ ...s, [t.id]: e.target.value }))}
              placeholder="Sua resposta (opcional — decisão é obrigatória)"
              rows={2}
              className="w-full text-xs bg-slate-900 border border-slate-800 rounded-md px-2 py-1.5 mt-2 text-zinc-100"
            />
            <div className="flex gap-2 mt-2 flex-wrap">
              <button
                onClick={() => answer(t.id, 'keeps')} disabled={!!acting[t.id]}
                className="text-[11px] bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-md px-2.5 py-1 inline-flex items-center gap-1"
              >
                <Check className="w-3 h-3" /> Combina — mantém
              </button>
              <button
                onClick={() => answer(t.id, 'drops')} disabled={!!acting[t.id]}
                className="text-[11px] bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-md px-2.5 py-1 inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" /> Destoa — descarta
              </button>
              <button
                onClick={() => answer(t.id, 'needs_review')} disabled={!!acting[t.id]}
                className="text-[11px] text-zinc-300 border border-slate-700 hover:text-white rounded-md px-2.5 py-1"
              >
                Preciso pensar mais
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ManipulationPanel({ alerts, onDone }: { alerts: ManipulationAlert[]; onDone: () => void }) {
  const [acting, setActing] = useState<Record<string, boolean>>({});

  const act = async (id: string, status: 'dismissed' | 'reformulated') => {
    setActing((s) => ({ ...s, [id]: true }));
    try {
      const res = await apiFetch(`/api/philosophy/manipulation/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) onDone();
    } finally { setActing((s) => { const { [id]: _, ...rest } = s; return rest; }); }
  };

  return (
    <div className="mt-4 rounded-xl border border-rose-500/20 bg-slate-950/50 p-3">
      <p className="text-xs text-zinc-300 mb-2">
        Sinek: manipulação (desconto/urgência) vende hoje, corrói marca amanhã.
        Reformule ancorando no seu Por Quê.
      </p>
      {alerts.length === 0 && <p className="text-xs text-zinc-500">Nenhum alerta aberto.</p>}
      <ul className="space-y-2">
        {alerts.map((a) => (
          <li key={a.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {a.tactics.map((t) => (
                <span key={t} className="text-[10px] uppercase tracking-wide text-rose-300 border border-rose-500/30 bg-rose-500/10 rounded-full px-2 py-0.5">{TACTIC_LABEL[t] || t}</span>
              ))}
              <span className={`text-[10px] uppercase tracking-wide ${a.severity === 'high' ? 'text-rose-300' : a.severity === 'medium' ? 'text-amber-300' : 'text-zinc-400'}`}>{a.severity}</span>
            </div>
            <p className="text-xs text-zinc-100 line-clamp-2">{a.sampleText}</p>
            <p className="text-[11px] text-zinc-400 mt-1.5">{a.suggestion}</p>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => act(a.id, 'reformulated')} disabled={!!acting[a.id]}
                className="text-[11px] bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-md px-2.5 py-1 inline-flex items-center gap-1"
              >
                <Send className="w-3 h-3" /> Reformulei
              </button>
              <button
                onClick={() => act(a.id, 'dismissed')} disabled={!!acting[a.id]}
                className="text-[11px] text-zinc-300 border border-slate-700 hover:text-white rounded-md px-2.5 py-1"
              >
                Dispensar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FundamentalsPanel({ latest, onDone }: { latest: FundamentalsCheck | null; onDone: () => void }) {
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    try {
      const res = await apiFetch('/api/philosophy/fundamentals/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (res.ok) onDone();
    } finally { setRunning(false); }
  };

  return (
    <div className="mt-4 rounded-xl border border-emerald-500/20 bg-slate-950/50 p-3">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs text-zinc-300">
          Carlos Domingos: campanha em cima de fundamento quebrado só amplifica o problema.
        </p>
        <button
          onClick={run} disabled={running}
          className="text-xs bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-md px-3 py-1.5 inline-flex items-center gap-1 shrink-0"
        >
          {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <ListChecks className="w-3 h-3" />}
          Rodar checklist
        </button>
      </div>
      {latest ? (
        <>
          <p className="text-xs text-zinc-100 mb-2">
            <span className="font-semibold">Recomendação: </span>{latest.recommendation}
          </p>
          <ul className="space-y-1.5">
            {latest.items.map((it) => (
              <li key={it.key} className="text-xs">
                <span className={`inline-block w-2 h-2 rounded-full mr-2 ${it.status === 'ok' ? 'bg-emerald-400' : it.status === 'attention' ? 'bg-amber-400' : it.status === 'critical' ? 'bg-rose-400' : 'bg-zinc-600'}`} />
                <span className={ITEM_COLOR[it.status]}>{it.label}</span>
                <span className="text-zinc-500 ml-1.5">— {it.evidence}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-zinc-500">Nenhum checklist rodado ainda. Clique em "Rodar checklist" antes da próxima campanha.</p>
      )}
    </div>
  );
}
