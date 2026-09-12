import React, { useEffect, useState } from 'react';
import {
  GraduationCap, Loader2, TrendingUp, TrendingDown, Minus, AlertTriangle,
  Users, Lightbulb, MessageCircle, ShieldCheck, Info,
} from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';
import { useAuth } from '@/src/contexts/AuthContext';

/**
 * SalesCoachView (ADR-202 F6b) — superfície INTERNA do Sales Coach. TREINA O VENDEDOR,
 * nunca fala com cliente (RN-SC-1). PURA LEITURA: só renderiza o bundle que o backend
 * (SalesCoachService F1–F5) produz — não inventa número nem esconde o que falta.
 *
 * RBAC espelha o servidor (RN-SC-9): gestor (owner/admin/master) escolhe qualquer
 * vendedor do time via GET /sellers → GET /seller/:id; o próprio vendedor vê só a si
 * via GET /me. O gate real é server-side; aqui só decidimos QUE painel montar.
 *
 * Sem dado → honesto (null≠0, RN-SC-3): "sem base ainda", séries vazias, nulos como "—".
 */

type Severity = 'high' | 'medium' | 'low';

interface Bundle {
  seller: { id: string; matricula: string; name: string | null; active: boolean };
  snapshot: {
    source: 'erp' | 'manual' | 'orders' | null;
    monthly: { ym: string; valor: number; pecas: number | null }[];
    totals: { valor: number; pecas: number | null; months: number; avgTicket: number | null };
    trend: { firstMonthly: number | null; lastMonthly: number | null; deltaPct: number | null; direction: 'up' | 'down' | 'flat' | null };
    window: { from: string; asOf: string; months: number };
    hasData: boolean;
  };
  gaps: { hasData: boolean; gaps: { key: string; severity: Severity; label: string; detail: string }[]; teamBaseline: { avgMonthlyValor: number | null; avgTicket: number | null; sellers: number } | null };
  feedback: { hasData: boolean; headline: string; points: { key: string; severity: Severity; text: string }[] };
  solutions: { gapTypes: string[]; targeted: any[]; general: any[] };
  roleplay: { hasData: boolean; disclaimer: string; scenarios: { gapKey: string; severity: Severity; title: string; situation: string; customerLine: string; suggestedResponse: string; practice: string }[] };
}

const SOURCE_LABEL: Record<string, string> = { erp: 'ERP (autoritativo)', manual: 'Registro manual/foto', orders: 'PDV (por ordem)' };
const brl = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const SEV_CHIP: Record<Severity, string> = {
  high: 'bg-red-500/15 text-red-300 border-red-800/50',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-800/50',
  low: 'bg-slate-500/15 text-slate-300 border-slate-700/50',
};
const SEV_LABEL: Record<Severity, string> = { high: 'Alta', medium: 'Média', low: 'Baixa' };

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}>
      <div className="flex items-center gap-2 mb-3 text-slate-200 font-semibold">{icon}<span>{title}</span></div>
      {children}
    </div>
  );
}

function CoachBundle({ b }: { b: Bundle }) {
  const dir = b.snapshot.trend.direction;
  const TrendIcon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  const trendColor = dir === 'up' ? 'text-emerald-300' : dir === 'down' ? 'text-red-300' : 'text-slate-300';
  return (
    <div className="space-y-4">
      {/* Desempenho (F1) */}
      <Card title="Desempenho" icon={<TrendingUp className="w-4 h-4" />}>
        {!b.snapshot.hasData ? (
          <p className="text-sm text-slate-400">Sem vendas registradas na janela — sem base para avaliar ainda.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <div><p className="text-xs text-slate-500">Total na janela</p><p className="text-lg font-bold text-slate-100">{brl(b.snapshot.totals.valor)}</p></div>
              <div><p className="text-xs text-slate-500">Ticket médio</p><p className="text-lg font-bold text-slate-100">{brl(b.snapshot.totals.avgTicket)}</p></div>
              <div><p className="text-xs text-slate-500">Meses c/ venda</p><p className="text-lg font-bold text-slate-100">{b.snapshot.totals.months}</p></div>
              <div><p className="text-xs text-slate-500">Tendência</p><p className={`text-lg font-bold flex items-center gap-1 ${trendColor}`}><TrendIcon className="w-4 h-4" />{b.snapshot.trend.deltaPct == null ? '—' : `${b.snapshot.trend.deltaPct}%`}</p></div>
            </div>
            <div className="flex items-end gap-1 h-24">
              {b.snapshot.monthly.map((m) => {
                const max = Math.max(...b.snapshot.monthly.map((x) => x.valor), 1);
                return (
                  <div key={m.ym} className="flex-1 flex flex-col items-center gap-1" title={`${m.ym}: ${brl(m.valor)}`}>
                    <div className="w-full rounded-t" style={{ height: `${Math.max(4, (m.valor / max) * 80)}px`, backgroundColor: 'var(--color-zf-teal)' }} />
                    <span className="text-[10px] text-slate-500">{m.ym.slice(5)}</span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-slate-500 mt-2 flex items-center gap-1"><Info className="w-3 h-3" />Fonte: {b.snapshot.source ? SOURCE_LABEL[b.snapshot.source] : '—'}. Janela: {b.snapshot.window.months} meses.</p>
          </>
        )}
      </Card>

      {/* Gaps (F2) */}
      <Card title="Pontos a trabalhar" icon={<AlertTriangle className="w-4 h-4" />}>
        {!b.gaps.gaps.length ? (
          <p className="text-sm text-slate-400">Nenhum gap detectado na janela.</p>
        ) : (
          <ul className="space-y-2">
            {b.gaps.gaps.map((g) => (
              <li key={g.key} className="flex items-start gap-2">
                <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${SEV_CHIP[g.severity]}`}>{SEV_LABEL[g.severity]}</span>
                <div><p className="text-sm font-medium text-slate-200">{g.label}</p><p className="text-xs text-slate-400">{g.detail}</p></div>
              </li>
            ))}
          </ul>
        )}
        {b.gaps.teamBaseline && b.gaps.teamBaseline.sellers >= 2 && (
          <p className="text-xs text-slate-500 mt-3">Baseline do time ({b.gaps.teamBaseline.sellers} vendedores): média mensal {brl(b.gaps.teamBaseline.avgMonthlyValor)} · ticket {brl(b.gaps.teamBaseline.avgTicket)}.</p>
        )}
      </Card>

      {/* Feedback (F3) */}
      <Card title="Feedback de treino" icon={<MessageCircle className="w-4 h-4" />}>
        <p className="text-sm font-medium text-slate-200 mb-2">{b.feedback.headline}</p>
        <ul className="space-y-1.5">
          {b.feedback.points.map((p, i) => (
            <li key={i} className="text-sm text-slate-300 flex items-start gap-2"><span className="text-[var(--color-zf-teal)] mt-1">•</span>{p.text}</li>
          ))}
        </ul>
      </Card>

      {/* Soluções de gerente validadas (F4) */}
      <Card title="Soluções validadas aplicáveis" icon={<Lightbulb className="w-4 h-4" />}>
        {!b.solutions.targeted.length && !b.solutions.general.length ? (
          <p className="text-sm text-slate-400">Ainda não há soluções de gerente validadas para este contexto.</p>
        ) : (
          <div className="space-y-3">
            {[...b.solutions.targeted, ...b.solutions.general].map((s, i) => (
              <div key={s.proposalId || i} className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
                <p className="text-sm font-semibold text-slate-200">{s.title}</p>
                {s.proposal && <p className="text-xs text-slate-400 mt-1">{s.proposal}</p>}
                <p className="text-[11px] text-slate-500 mt-2">Origem humana (gerente) · {s.scope === 'rede' ? 'validada na rede' : `funcionou em ${s.whereWorked}`}.</p>
                {s.caveat && <p className="text-[11px] text-amber-300/80 mt-1 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />{s.caveat}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Roleplay (F5) */}
      <Card title="Simulações de treino" icon={<GraduationCap className="w-4 h-4" />}>
        <p className="text-[11px] text-slate-500 mb-3 flex items-center gap-1"><ShieldCheck className="w-3 h-3" />{b.roleplay.disclaimer}</p>
        {!b.roleplay.scenarios.length ? (
          <p className="text-sm text-slate-400">Sem cenários — nenhum gap que motive uma simulação.</p>
        ) : (
          <div className="space-y-3">
            {b.roleplay.scenarios.map((sc, i) => (
              <div key={i} className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
                <p className="text-sm font-semibold text-slate-200">{sc.title}</p>
                <p className="text-xs text-slate-500 mt-1">{sc.situation}</p>
                <p className="text-sm text-slate-300 mt-2"><span className="text-slate-500">Cliente (treino):</span> {sc.customerLine}</p>
                <p className="text-sm text-slate-300 mt-1"><span className="text-slate-500">Resposta sugerida:</span> {sc.suggestedResponse}</p>
                <p className="text-[11px] text-[var(--color-zf-teal)] mt-2">Foco: {sc.practice}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function SalesCoachView() {
  const { isMasterAdmin } = useStore();
  const { user } = useAuth();
  const isManager = isMasterAdmin || user?.role === 'owner' || user?.role === 'admin';

  const [sellers, setSellers] = useState<{ id: string; matricula: string; name: string | null }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Gestor: lista o time. Vendedor: carrega o próprio bundle direto (/me).
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    if (isManager) {
      apiFetch('/api/sales-coach/sellers')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Falha ao listar vendedores.'))))
        .then((d) => { if (alive) { setSellers(d.sellers || []); setLoading(false); } })
        .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    } else {
      apiFetch('/api/sales-coach/me')
        .then((r) => (r.ok ? r.json() : r.status === 404 ? Promise.reject(new Error('Seu usuário não está vinculado a um vendedor.')) : Promise.reject(new Error('Falha ao carregar.'))))
        .then((d) => { if (alive) { setBundle(d); setLoading(false); } })
        .catch((e) => { if (alive) { setError(e.message); setLoading(false); } });
    }
    return () => { alive = false; };
  }, [isManager]);

  // Gestor selecionou um vendedor → carrega o bundle dele.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setBundle(null); setError(null);
    apiFetch(`/api/sales-coach/seller/${encodeURIComponent(selected)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Não foi possível carregar este vendedor.'))))
      .then((d) => { if (alive) setBundle(d); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [selected]);

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <GraduationCap className="w-6 h-6 text-[var(--color-zf-teal)]" />
        <div>
          <h1 className="text-xl font-bold text-slate-100">Coach de Vendas</h1>
          <p className="text-sm text-slate-500">Treino interno do vendedor — nada aqui é enviado ao cliente.</p>
        </div>
      </div>

      {isManager && (
        <Card title="Time de vendas" icon={<Users className="w-4 h-4" />}>
          {loading ? (
            <p className="text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Carregando…</p>
          ) : sellers.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum vendedor ativo cadastrado.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sellers.map((s) => (
                <button key={s.id} onClick={() => setSelected(s.id)}
                  className={`px-3 py-1.5 rounded-lg border text-sm transition ${selected === s.id ? 'border-[var(--color-zf-teal)] text-[var(--color-zf-teal)]' : 'border-[var(--color-border)] text-slate-300 hover:text-slate-100'}`}>
                  {s.name || s.matricula}
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {error && (
        <div className="rounded-xl border border-red-800/50 bg-red-950/30 p-4 text-sm text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />{error}
        </div>
      )}

      {isManager && !selected && !error && !loading && (
        <p className="text-sm text-slate-500">Selecione um vendedor acima para ver o coach.</p>
      )}

      {!isManager && loading && (
        <p className="text-sm text-slate-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Carregando…</p>
      )}

      {bundle && <CoachBundle b={bundle} />}
    </div>
  );
}

export default SalesCoachView;
