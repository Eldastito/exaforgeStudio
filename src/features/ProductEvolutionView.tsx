import React, { useEffect, useMemo, useState } from 'react';
import {
  Layers, Search, Plus, RefreshCcw, AlertTriangle, CheckCircle2,
  ChevronRight, ChevronDown, ExternalLink, Loader2, Clock, GitBranch,
  Gauge, X,
} from 'lucide-react';
import { apiFetch } from '@/src/lib/api';

/**
 * ProductEvolutionView (ADR-193 F2) — tela master admin do Product Evolution
 * Ledger. Consome `/api/admin/product-evolution/*` (F1). É a superfície visual
 * da matriz que a F0 entregou como markdown estático.
 *
 * Duas abas nesta fatia: MATRIZ (todos os items, filtráveis) e GAPS (subset
 * pré-canned do backend: items em PRD_READY..TESTED sem evidência verificada,
 * ordenados por prioridade).
 *
 * Sem UI de gráfico/score nesta fatia — score entra na F3. Sem histórico —
 * tabela `reviews` entra na F1.5. Aqui é CRUD visual sobre o que já existe.
 *
 * Master admin only (gate é do backend em /api/admin/*). Se o usuário não
 * for master, o backend responde 401/403 e essa tela mostra o erro em vez
 * de dados.
 */

type Status =
  | 'IDEA' | 'ANALYZED' | 'PRD_READY' | 'APPROVED' | 'IMPLEMENTING'
  | 'CODED' | 'TESTED' | 'PILOT' | 'PRODUCTION' | 'VALIDATED'
  | 'DEFERRED' | 'REJECTED' | 'SUPERSEDED';

const STATUSES: Status[] = [
  'IDEA', 'ANALYZED', 'PRD_READY', 'APPROVED', 'IMPLEMENTING',
  'CODED', 'TESTED', 'PILOT', 'PRODUCTION', 'VALIDATED',
  'DEFERRED', 'REJECTED', 'SUPERSEDED',
];

// Grafo espelhando o STATUS_GRAPH do backend (RN-PEL-3). Se o backend for
// atualizado, esse dicionário precisa ser atualizado junto — mas o backend é
// a fonte da verdade: uma transição inválida aqui só esconde o botão, uma
// transição inválida no backend é que barra o efeito.
const TRANSITIONS: Record<Status, Status[]> = {
  IDEA:         ['ANALYZED', 'DEFERRED', 'REJECTED'],
  ANALYZED:     ['PRD_READY', 'IDEA', 'DEFERRED', 'REJECTED'],
  PRD_READY:    ['APPROVED', 'ANALYZED', 'DEFERRED', 'REJECTED'],
  APPROVED:     ['IMPLEMENTING', 'DEFERRED', 'REJECTED'],
  IMPLEMENTING: ['CODED', 'APPROVED', 'DEFERRED', 'REJECTED', 'SUPERSEDED'],
  CODED:        ['TESTED', 'IMPLEMENTING', 'SUPERSEDED'],
  TESTED:       ['PILOT', 'PRODUCTION', 'CODED', 'SUPERSEDED'],
  PILOT:        ['PRODUCTION', 'TESTED', 'SUPERSEDED'],
  PRODUCTION:   ['VALIDATED', 'PILOT', 'SUPERSEDED'],
  VALIDATED:    ['SUPERSEDED'],
  DEFERRED:     ['IDEA', 'ANALYZED', 'PRD_READY', 'APPROVED'],
  REJECTED:     [],
  SUPERSEDED:   [],
};

const EVIDENCE_TYPES = [
  'code', 'migration', 'route', 'ui', 'test', 'test_run',
  'pr', 'commit', 'rollout', 'production_check', 'runbook',
  'metric', 'customer_validation',
] as const;

const SOURCE_TYPES = [
  'chat', 'prd', 'adr', 'file', 'github_pr', 'github_commit',
  'issue', 'meeting', 'manual', 'external_repository',
] as const;

// Cor por estado (dark theme, consistente com ProductionReadinessView).
const STATUS_STYLE: Record<Status, string> = {
  IDEA:         'bg-slate-500/15 text-slate-300 border-slate-700/50',
  ANALYZED:     'bg-slate-500/15 text-slate-300 border-slate-700/50',
  PRD_READY:    'bg-sky-500/15 text-sky-300 border-sky-800/50',
  APPROVED:     'bg-sky-500/15 text-sky-300 border-sky-800/50',
  IMPLEMENTING: 'bg-blue-500/15 text-blue-300 border-blue-800/50',
  CODED:        'bg-indigo-500/15 text-indigo-300 border-indigo-800/50',
  TESTED:       'bg-violet-500/15 text-violet-300 border-violet-800/50',
  PILOT:        'bg-amber-500/15 text-amber-300 border-amber-800/50',
  PRODUCTION:   'bg-emerald-500/15 text-emerald-300 border-emerald-800/50',
  VALIDATED:    'bg-emerald-500/25 text-emerald-200 border-emerald-700',
  DEFERRED:     'bg-neutral-500/15 text-neutral-300 border-neutral-700/50',
  REJECTED:     'bg-red-500/15 text-red-300 border-red-800/50',
  SUPERSEDED:   'bg-neutral-500/15 text-neutral-400 border-neutral-700/50 line-through',
};

interface Item {
  id: string;
  evolution_key: string;
  title: string;
  domain: string | null;
  summary: string | null;
  status: Status;
  priority: string | null;
  risk_level: string | null;
  owner_user_id: string | null;
  source_of_truth: string | null;
  target_release: string | null;
  blocked_reason: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  validated_at: string | null;
  archived_at: string | null;
}

interface Evidence {
  id: string;
  item_id: string;
  evidence_type: string;
  reference: string;
  description: string | null;
  verified: number;
  verified_by: string | null;
  verified_at: string | null;
  metadata_json: string | null;
  created_at: string;
}

interface Source {
  id: string;
  item_id: string;
  source_type: string;
  title: string;
  source_date: string | null;
  source_reference: string | null;
  external_url: string | null;
  file_ref: string | null;
  notes: string | null;
  created_at: string;
}

interface Review {
  id: string;
  item_id: string;
  previous_status: Status;
  new_status: Status;
  reason: string;
  evidence_snapshot: Array<{ id: string; evidence_type: string; reference: string; verified: number }>;
  reviewer_user_id: string | null;
  created_at: string;
}

interface DependencyOut { id: string; depends_on_key: string; depends_on_title: string; dependency_type: string; notes: string | null; created_at: string; }
interface DependencyIn  { id: string; item_key: string; item_title: string; dependency_type: string; notes: string | null; created_at: string; }
interface DepsGraph { outgoing: DependencyOut[]; incoming: DependencyIn[]; }

interface Score {
  evolution_key: string;
  status: Status;
  total: number;
  raw_total: number;
  cap_applied: number | null;
  cap_reason: string | null;
  dimensions: Array<{ dimension: string; weight: number; raw_hits: number; earned: number; saturated: boolean }>;
  notes: string[];
  computed_at: string;
}

const DEP_TYPES = ['requires', 'enhances', 'blocks', 'related'] as const;
type DepType = typeof DEP_TYPES[number];

const DEP_TYPE_STYLE: Record<DepType, string> = {
  requires: 'bg-amber-500/15 text-amber-300 border-amber-800/50',
  enhances: 'bg-sky-500/15 text-sky-300 border-sky-800/50',
  blocks:   'bg-red-500/15 text-red-300 border-red-800/50',
  related:  'bg-slate-500/15 text-slate-300 border-slate-700/50',
};

type Tab = 'matrix' | 'gaps';
type DetailTab = 'detail' | 'timeline' | 'dependencies';

function scoreColor(total: number): string {
  if (total >= 80) return 'text-emerald-400';
  if (total >= 50) return 'text-sky-400';
  if (total >= 30) return 'text-amber-400';
  return 'text-slate-500';
}

// ═══════════════ Component ═══════════════

export function ProductEvolutionView() {
  const [tab, setTab] = useState<Tab>('matrix');
  const [items, setItems] = useState<Item[]>([]);
  const [scores, setScores] = useState<Map<string, Score>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState<Status | ''>('');
  const [filterDomain, setFilterDomain] = useState<string>('');
  const [filterQ, setFilterQ] = useState<string>('');

  const [expanded, setExpanded] = useState<string | null>(null); // evolution_key
  const [creating, setCreating] = useState(false);

  const loadItems = async () => {
    setLoading(true);
    setError(null);
    try {
      const path = tab === 'gaps'
        ? '/api/admin/product-evolution/gaps'
        : buildListPath(filterStatus, filterDomain, filterQ);
      const res = await apiFetch(path);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setItems(data.items || []);

      // Batch fetch de scores em paralelo (não bloqueia o render principal).
      // Falha silenciosa: coluna score fica vazia se o endpoint quebrar.
      apiFetch('/api/admin/product-evolution/scores')
        .then(r => r.ok ? r.json() : { scores: [] })
        .then(sd => {
          const m = new Map<string, Score>();
          for (const s of (sd.scores || [])) m.set(s.evolution_key, s);
          setScores(m);
        })
        .catch(() => { /* noop */ });
    } catch (e: any) {
      setError(e.message || 'Falha ao carregar');
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadItems(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [tab, filterStatus, filterDomain]);

  // Debounce da busca por texto
  useEffect(() => {
    if (tab === 'gaps') return;
    const t = setTimeout(loadItems, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQ]);

  const domains = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.domain) s.add(it.domain);
    return [...s].sort();
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) c[it.status] = (c[it.status] || 0) + 1;
    return c;
  }, [items]);

  return (
    <div className="p-6 max-w-7xl mx-auto text-slate-200">
      <header className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Layers className="w-6 h-6 text-sky-400" />
            <h1 className="text-2xl font-semibold text-slate-100">Product Evolution Ledger</h1>
          </div>
          <p className="text-sm text-slate-400 max-w-3xl">
            Fonte única para "essa iniciativa virou código? em qual PR? foi testada?
            está em produção?". <strong>PRD não é implementado; commit não é pronto; tela não é
            operacional</strong> — cada estado exige evidência verificada.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={loadItems}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md text-slate-300"
          >
            <RefreshCcw className="w-3.5 h-3.5" /> Atualizar
          </button>
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-sky-600 hover:bg-sky-500 border border-sky-500 rounded-md text-white"
          >
            <Plus className="w-3.5 h-3.5" /> Novo item
          </button>
        </div>
      </header>

      {/* Abas */}
      <div className="flex border-b border-slate-800 mb-4">
        <TabButton active={tab === 'matrix'} onClick={() => setTab('matrix')} label="Matriz" count={tab === 'matrix' ? items.length : undefined} />
        <TabButton active={tab === 'gaps'} onClick={() => setTab('gaps')} label="Gaps" count={tab === 'gaps' ? items.length : undefined} icon={<AlertTriangle className="w-3.5 h-3.5" />} />
      </div>

      {/* Filtros (só na Matriz) */}
      {tab === 'matrix' && (
        <div className="flex gap-2 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2 top-2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              placeholder="Buscar em título/sumário…"
              value={filterQ}
              onChange={(e) => setFilterQ(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-slate-900 border border-slate-800 rounded-md text-slate-200 placeholder-slate-500 focus:outline-none focus:border-slate-600"
            />
          </div>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as Status | '')}
            className="px-2 py-1.5 text-sm bg-slate-900 border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-slate-600"
          >
            <option value="">Todos os estados</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}{counts[s] ? ` (${counts[s]})` : ''}</option>)}
          </select>
          {domains.length > 0 && (
            <select
              value={filterDomain}
              onChange={(e) => setFilterDomain(e.target.value)}
              className="px-2 py-1.5 text-sm bg-slate-900 border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-slate-600"
            >
              <option value="">Todos os domínios</option>
              {domains.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
        </div>
      )}

      {/* Tabela */}
      <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/50">
        {loading ? (
          <div className="p-10 flex items-center justify-center text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Carregando…
          </div>
        ) : error ? (
          <div className="p-6 text-center text-red-400">
            <AlertTriangle className="w-5 h-5 mx-auto mb-1" /> {error}
          </div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-slate-500 text-sm">
            {tab === 'gaps'
              ? 'Nenhum gap ativo. Todos os items em PRD_READY..TESTED têm evidência verificada.'
              : 'Nenhum item cadastrado. Clique em "Novo item" ou importe da matriz F0.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-500 text-xs uppercase tracking-wide">
                <th className="text-left py-2 px-3 w-8"></th>
                <th className="text-left py-2 px-3">Chave / Título</th>
                <th className="text-left py-2 px-3">Domínio</th>
                <th className="text-left py-2 px-3">Estado</th>
                <th className="text-left py-2 px-3">Prio</th>
                <th className="text-right py-2 px-3">Score</th>
                <th className="text-left py-2 px-3">Atualizado</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <ItemRow
                  key={item.id}
                  item={item}
                  score={scores.get(item.evolution_key) || null}
                  expanded={expanded === item.evolution_key}
                  onToggle={() => setExpanded(expanded === item.evolution_key ? null : item.evolution_key)}
                  onChange={loadItems}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <CreateItemModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); loadItems(); }}
        />
      )}
    </div>
  );
}

function buildListPath(status: Status | '', domain: string, q: string): string {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (domain) params.set('domain', domain);
  if (q.trim()) params.set('q', q.trim());
  const qs = params.toString();
  return `/api/admin/product-evolution/items${qs ? '?' + qs : ''}`;
}

// ═══════════════ Tab button ═══════════════

function TabButton({ active, onClick, label, count, icon }: {
  active: boolean; onClick: () => void; label: string; count?: number; icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px transition-colors ${
        active
          ? 'border-sky-500 text-sky-300 font-medium'
          : 'border-transparent text-slate-500 hover:text-slate-300'
      }`}
    >
      {icon}
      {label}
      {count !== undefined && (
        <span className={`text-xs px-1.5 py-0.5 rounded ${active ? 'bg-sky-950 text-sky-300' : 'bg-slate-800 text-slate-500'}`}>{count}</span>
      )}
    </button>
  );
}

// ═══════════════ Item row ═══════════════

interface ItemRowProps {
  item: Item;
  score: Score | null;
  expanded: boolean;
  onToggle: () => void;
  onChange: () => void;
}

const ItemRow: React.FC<ItemRowProps> = ({ item, score, expanded, onToggle, onChange }) => {
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [deps, setDeps] = useState<DepsGraph>({ outgoing: [], incoming: [] });
  const [detailScore, setDetailScore] = useState<Score | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setDetailLoading(true);
    Promise.all([
      apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/evidence`).then(r => r.json()).catch(() => ({ evidence: [] })),
      apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/sources`).then(r => r.json()).catch(() => ({ sources: [] })),
      apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/reviews`).then(r => r.json()).catch(() => ({ reviews: [] })),
      apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/dependencies`).then(r => r.json()).catch(() => ({ outgoing: [], incoming: [] })),
      apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/score`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([e, s, rv, dp, sc]) => {
      setEvidence(e.evidence || []);
      setSources(s.sources || []);
      setReviews(rv.reviews || []);
      setDeps({ outgoing: dp.outgoing || [], incoming: dp.incoming || [] });
      setDetailScore(sc);
      setDetailLoading(false);
    });
  }, [expanded, item.evolution_key]);

  return (
    <>
      <tr
        className="border-b border-slate-800/50 hover:bg-slate-900/40 cursor-pointer"
        onClick={onToggle}
      >
        <td className="py-2.5 px-3 text-slate-500">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </td>
        <td className="py-2.5 px-3">
          <div className="font-mono text-xs text-sky-300">{item.evolution_key}</div>
          <div className="text-slate-200">{item.title}</div>
          {item.blocked_reason && (
            <div className="text-xs text-amber-400 mt-0.5 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> {item.blocked_reason}
            </div>
          )}
        </td>
        <td className="py-2.5 px-3 text-slate-400 text-xs">{item.domain || '—'}</td>
        <td className="py-2.5 px-3">
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium border ${STATUS_STYLE[item.status]}`}>
            {item.status}
          </span>
          {item.superseded_by && (
            <div className="text-xs text-slate-500 mt-0.5">→ <span className="font-mono">{item.superseded_by}</span></div>
          )}
        </td>
        <td className="py-2.5 px-3 text-slate-400 text-xs">{item.priority || '—'}</td>
        <td className="py-2.5 px-3 text-right">
          {score ? (
            <div className="inline-flex items-center gap-1" title={score.cap_reason || `raw ${score.raw_total}`}>
              <span className={`font-mono text-sm font-semibold ${scoreColor(score.total)}`}>{score.total}</span>
              {score.cap_applied !== null && (
                <span className="text-[10px] text-slate-500" title={score.cap_reason || ''}>cap</span>
              )}
            </div>
          ) : <span className="text-slate-600 text-xs">—</span>}
        </td>
        <td className="py-2.5 px-3 text-slate-500 text-xs">{relTime(item.updated_at)}</td>
      </tr>
      {expanded && (
        <tr className="border-b border-slate-800">
          <td colSpan={7} className="p-4 bg-slate-900/40">
            {detailLoading ? (
              <div className="text-slate-500 text-xs flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> carregando detalhe…</div>
            ) : (
              <ItemDetail
                item={item}
                evidence={evidence}
                sources={sources}
                reviews={reviews}
                deps={deps}
                score={detailScore}
                onChange={onChange}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
};

// ═══════════════ Item detail (expanded row) ═══════════════

function ItemDetail({ item, evidence, sources, reviews, deps, score, onChange }: {
  item: Item; evidence: Evidence[]; sources: Source[];
  reviews: Review[]; deps: DepsGraph; score: Score | null;
  onChange: () => void;
}) {
  const [dtab, setDtab] = useState<DetailTab>('detail');
  const allowedTransitions = TRANSITIONS[item.status] || [];

  return (
    <div>
      {/* Header do detalhe: score badge + abas */}
      <div className="flex items-center justify-between mb-3 border-b border-slate-800 pb-2">
        <div className="flex gap-1">
          <DetailTabBtn active={dtab === 'detail'} onClick={() => setDtab('detail')} icon={<Layers className="w-3.5 h-3.5" />} label="Detalhe" />
          <DetailTabBtn active={dtab === 'timeline'} onClick={() => setDtab('timeline')} icon={<Clock className="w-3.5 h-3.5" />} label="Histórico" count={reviews.length} />
          <DetailTabBtn active={dtab === 'dependencies'} onClick={() => setDtab('dependencies')} icon={<GitBranch className="w-3.5 h-3.5" />} label="Dependências" count={deps.outgoing.length + deps.incoming.length} />
        </div>
        {score && <ScoreBadge score={score} />}
      </div>

      {dtab === 'detail' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            {item.summary && (
              <div>
                <div className="text-xs uppercase text-slate-500 mb-1">Sumário</div>
                <div className="text-sm text-slate-300">{item.summary}</div>
              </div>
            )}
            {item.source_of_truth && (
              <div>
                <div className="text-xs uppercase text-slate-500 mb-1">Fonte da verdade</div>
                <div className="text-sm text-slate-300 font-mono">{item.source_of_truth}</div>
              </div>
            )}
            <div className="border-t border-slate-800 pt-3">
              <div className="text-xs uppercase text-slate-500 mb-2">Transicionar estado</div>
              {allowedTransitions.length === 0 ? (
                <div className="text-xs text-slate-500 italic">Estado terminal — nenhuma transição permitida.</div>
              ) : (
                <StatusTransitionForm item={item} allowed={allowedTransitions} onChange={onChange} />
              )}
            </div>
          </div>
          <div className="space-y-4">
            <EvidenceSection item={item} evidence={evidence} onChange={onChange} />
            <SourceSection item={item} sources={sources} onChange={onChange} />
          </div>
        </div>
      )}

      {dtab === 'timeline' && <TimelineSection reviews={reviews} />}
      {dtab === 'dependencies' && <DependenciesSection item={item} deps={deps} onChange={onChange} />}
    </div>
  );
}

function DetailTabBtn({ active, onClick, icon, label, count }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded ${
        active ? 'bg-slate-800 text-slate-200 font-medium' : 'text-slate-500 hover:text-slate-300'
      }`}
    >
      {icon}{label}
      {count !== undefined && count > 0 && (
        <span className="text-[10px] px-1 rounded bg-slate-700/60">{count}</span>
      )}
    </button>
  );
}

function ScoreBadge({ score }: { score: Score }) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setShowBreakdown(!showBreakdown)}
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900/60 border border-slate-800 hover:border-slate-700"
      >
        <Gauge className="w-3.5 h-3.5 text-slate-500" />
        <span className={`font-mono text-sm font-semibold ${scoreColor(score.total)}`}>{score.total}</span>
        <span className="text-[10px] text-slate-500">/100</span>
        {score.cap_applied !== null && (
          <span className="text-[10px] px-1 rounded bg-amber-500/15 text-amber-300 border border-amber-800/50">cap {score.cap_applied}</span>
        )}
      </button>
      {showBreakdown && (
        <div className="absolute right-0 top-full mt-1 z-10 w-80 bg-slate-950 border border-slate-800 rounded-lg p-3 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase text-slate-500">Score breakdown</div>
            <button onClick={() => setShowBreakdown(false)} className="text-slate-500 hover:text-slate-300"><X className="w-3.5 h-3.5" /></button>
          </div>
          <div className="space-y-1 mb-2">
            {score.dimensions.map(d => (
              <div key={d.dimension} className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{d.dimension}</span>
                <span className="font-mono">
                  <span className={d.saturated ? 'text-emerald-400' : 'text-slate-300'}>{d.earned}</span>
                  <span className="text-slate-600">/{d.weight}</span>
                </span>
              </div>
            ))}
          </div>
          {score.notes.length > 0 && (
            <div className="border-t border-slate-800 pt-2 space-y-0.5">
              {score.notes.map((n, i) => (
                <div key={i} className="text-[11px] text-slate-500">• {n}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════ Timeline (histórico de reviews) ═══════════════

function TimelineSection({ reviews }: { reviews: Review[] }) {
  if (reviews.length === 0) {
    return <div className="text-sm text-slate-500 italic py-6 text-center">Sem histórico de transições ainda.</div>;
  }
  return (
    <div className="space-y-2">
      {reviews.map(r => (
        <div key={r.id} className="border-l-2 border-slate-800 pl-3 py-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_STYLE[r.previous_status] || STATUS_STYLE.IDEA}`}>{r.previous_status}</span>
            <ChevronRight className="w-3 h-3 text-slate-600" />
            <span className={`px-1.5 py-0.5 rounded text-[10px] border ${STATUS_STYLE[r.new_status] || STATUS_STYLE.IDEA}`}>{r.new_status}</span>
            <span className="text-slate-500 text-[11px]">{relTime(r.created_at)}</span>
          </div>
          <div className="text-sm text-slate-300 mt-1">{r.reason}</div>
          {r.evidence_snapshot.length > 0 && (
            <div className="text-[11px] text-slate-500 mt-1">
              {r.evidence_snapshot.filter(e => e.verified === 1).length} evidência(s) verificada(s) no snapshot
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════ Dependencies (grafo bidirecional) ═══════════════

function DependenciesSection({ item, deps, onChange }: {
  item: Item; deps: DepsGraph; onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [targetKey, setTargetKey] = useState('');
  const [depType, setDepType] = useState<DepType>('requires');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!targetKey.trim()) { setErr('depends_on_key é obrigatório'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          depends_on_key: targetKey.trim(),
          dependency_type: depType,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      setTargetKey(''); setNotes(''); setAdding(false);
      onChange();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('Remover dependência?')) return;
    try {
      const res = await apiFetch(`/api/admin/product-evolution/dependencies/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error('falhou');
      onChange();
    } catch (e: any) { alert(e.message); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Outgoing (this depends on X) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase text-slate-500">Este item depende de ({deps.outgoing.length})</div>
          <button onClick={() => setAdding(!adding)} className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1">
            <Plus className="w-3 h-3" /> {adding ? 'Cancelar' : 'Adicionar'}
          </button>
        </div>
        {adding && (
          <div className="mb-3 p-2 bg-slate-950 border border-slate-800 rounded space-y-1.5">
            <input
              placeholder="evolution_key do item alvo"
              value={targetKey}
              onChange={e => setTargetKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded font-mono"
            />
            <select value={depType} onChange={e => setDepType(e.target.value as DepType)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded">
              {DEP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input placeholder="notas (opcional)" value={notes} onChange={e => setNotes(e.target.value)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded" />
            {err && <div className="text-xs text-red-400">{err}</div>}
            <button disabled={busy} onClick={add} className="w-full px-2 py-1 text-xs bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded">
              {busy ? 'Enviando…' : 'Adicionar dependência'}
            </button>
          </div>
        )}
        {deps.outgoing.length === 0 ? (
          <div className="text-xs text-slate-500 italic">Não depende de nada.</div>
        ) : (
          <ul className="space-y-1.5">
            {deps.outgoing.map(d => (
              <li key={d.id} className="flex items-start gap-2 text-xs bg-slate-950/60 border border-slate-800 rounded px-2 py-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] border shrink-0 ${DEP_TYPE_STYLE[d.dependency_type as DepType]}`}>{d.dependency_type}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sky-300 text-[11px]">{d.depends_on_key}</div>
                  <div className="text-slate-400 text-[11px]">{d.depends_on_title}</div>
                  {d.notes && <div className="text-slate-500 text-[10px] mt-0.5">{d.notes}</div>}
                </div>
                <button onClick={() => remove(d.id)} className="text-slate-500 hover:text-red-400" title="Remover">
                  <X className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Incoming (X depends on this) */}
      <div>
        <div className="text-xs uppercase text-slate-500 mb-2">Dependem deste item ({deps.incoming.length})</div>
        {deps.incoming.length === 0 ? (
          <div className="text-xs text-slate-500 italic">Ninguém depende deste item.</div>
        ) : (
          <ul className="space-y-1.5">
            {deps.incoming.map(d => (
              <li key={d.id} className="flex items-start gap-2 text-xs bg-slate-950/60 border border-slate-800 rounded px-2 py-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] border shrink-0 ${DEP_TYPE_STYLE[d.dependency_type as DepType]}`}>{d.dependency_type}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sky-300 text-[11px]">{d.item_key}</div>
                  <div className="text-slate-400 text-[11px]">{d.item_title}</div>
                  {d.notes && <div className="text-slate-500 text-[10px] mt-0.5">{d.notes}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ═══════════════ Status transition ═══════════════

function StatusTransitionForm({ item, allowed, onChange }: {
  item: Item; allowed: Status[]; onChange: () => void;
}) {
  const [target, setTarget] = useState<Status>(allowed[0]);
  const [reason, setReason] = useState('');
  const [supersededBy, setSupersededBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!reason.trim()) { setErr('reason é obrigatório'); return; }
    if (target === 'SUPERSEDED' && !supersededBy.trim()) { setErr('superseded_by é obrigatório'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_status: target,
          reason: reason.trim(),
          superseded_by: target === 'SUPERSEDED' ? supersededBy.trim() : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setReason(''); setSupersededBy('');
      onChange();
    } catch (e: any) {
      setErr(e.message || 'Falha');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value as Status)}
          className="flex-1 px-2 py-1 text-sm bg-slate-900 border border-slate-800 rounded"
        >
          {allowed.map(s => <option key={s} value={s}>{item.status} → {s}</option>)}
        </select>
      </div>
      <input
        type="text"
        placeholder="reason (obrigatório)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-full px-2 py-1 text-sm bg-slate-900 border border-slate-800 rounded"
      />
      {target === 'SUPERSEDED' && (
        <input
          type="text"
          placeholder="superseded_by (evolution_key do sucessor)"
          value={supersededBy}
          onChange={(e) => setSupersededBy(e.target.value.toUpperCase())}
          className="w-full px-2 py-1 text-sm bg-slate-900 border border-slate-800 rounded font-mono"
        />
      )}
      {err && <div className="text-xs text-red-400">{err}</div>}
      <button
        onClick={submit}
        disabled={busy}
        className="w-full px-3 py-1.5 text-sm bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded"
      >
        {busy ? 'Enviando…' : 'Aplicar transição'}
      </button>
    </div>
  );
}

// ═══════════════ Evidence section ═══════════════

function EvidenceSection({ item, evidence, onChange }: {
  item: Item; evidence: Evidence[]; onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<string>('code');
  const [ref, setRef] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!ref.trim()) { setErr('reference é obrigatório'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/evidence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidence_type: type, reference: ref.trim(), description: desc.trim() || null }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      setRef(''); setDesc(''); setAdding(false);
      onChange();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  const verify = async (id: string) => {
    const who = prompt('verified_by (seu identificador):');
    if (!who) return;
    try {
      const res = await apiFetch(`/api/admin/product-evolution/evidence/${id}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified_by: who.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'falhou');
      onChange();
    } catch (e: any) { alert(e.message); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase text-slate-500">Evidências ({evidence.length})</div>
        <button
          onClick={() => setAdding(!adding)}
          className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> {adding ? 'Cancelar' : 'Anexar'}
        </button>
      </div>
      {adding && (
        <div className="mb-3 p-2 bg-slate-950 border border-slate-800 rounded space-y-1.5">
          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded">
            {EVIDENCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input placeholder="reference (path, SHA, PR#)" value={ref} onChange={(e) => setRef(e.target.value)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded" />
          <input placeholder="descrição (opcional)" value={desc} onChange={(e) => setDesc(e.target.value)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded" />
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button disabled={busy} onClick={add} className="w-full px-2 py-1 text-xs bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded">
            {busy ? 'Enviando…' : 'Anexar evidência'}
          </button>
        </div>
      )}
      {evidence.length === 0 ? (
        <div className="text-xs text-slate-500 italic">Sem evidência ainda. Item não pode transicionar para VALIDATED.</div>
      ) : (
        <ul className="space-y-1.5">
          {evidence.map(e => (
            <li key={e.id} className="flex items-start gap-2 text-xs bg-slate-950/60 border border-slate-800 rounded px-2 py-1.5">
              {e.verified ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
              ) : (
                <button onClick={() => verify(e.id)} className="text-slate-500 hover:text-slate-300 shrink-0" title="Marcar como verificada">
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5" />
                </button>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-slate-400"><span className="text-slate-500">[{e.evidence_type}]</span> <span className="font-mono text-slate-300 break-all">{e.reference}</span></div>
                {e.description && <div className="text-slate-500 text-[11px]">{e.description}</div>}
                {e.verified === 1 && e.verified_by && (
                  <div className="text-emerald-500/70 text-[10px]">verificado por {e.verified_by} · {relTime(e.verified_at || '')}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ═══════════════ Source section ═══════════════

function SourceSection({ item, sources, onChange }: {
  item: Item; sources: Source[]; onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<string>('adr');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!title.trim()) { setErr('title é obrigatório'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/admin/product-evolution/items/${item.evolution_key}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_type: type, title: title.trim(), external_url: url.trim() || null }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      setTitle(''); setUrl(''); setAdding(false);
      onChange();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs uppercase text-slate-500">Fontes ({sources.length})</div>
        <button
          onClick={() => setAdding(!adding)}
          className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> {adding ? 'Cancelar' : 'Anexar'}
        </button>
      </div>
      {adding && (
        <div className="mb-3 p-2 bg-slate-950 border border-slate-800 rounded space-y-1.5">
          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded">
            {SOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input placeholder="título" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded" />
          <input placeholder="URL externa (opcional)" value={url} onChange={(e) => setUrl(e.target.value)} className="w-full px-2 py-1 text-xs bg-slate-900 border border-slate-800 rounded" />
          {err && <div className="text-xs text-red-400">{err}</div>}
          <button disabled={busy} onClick={add} className="w-full px-2 py-1 text-xs bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded">
            {busy ? 'Enviando…' : 'Anexar fonte'}
          </button>
        </div>
      )}
      {sources.length === 0 ? (
        <div className="text-xs text-slate-500 italic">Sem fontes.</div>
      ) : (
        <ul className="space-y-1.5">
          {sources.map(s => (
            <li key={s.id} className="text-xs bg-slate-950/60 border border-slate-800 rounded px-2 py-1.5">
              <div className="text-slate-400"><span className="text-slate-500">[{s.source_type}]</span> <span className="text-slate-300">{s.title}</span></div>
              {s.external_url && (
                <a href={s.external_url} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:text-sky-300 text-[11px] flex items-center gap-1 mt-0.5">
                  <ExternalLink className="w-3 h-3" /> {s.external_url}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ═══════════════ Create item modal ═══════════════

function CreateItemModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState('');
  const [sourceOfTruth, setSourceOfTruth] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await apiFetch(`/api/admin/product-evolution/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evolution_key: key.trim(),
          title: title.trim(),
          domain: domain.trim() || null,
          summary: summary.trim() || null,
          priority: priority || null,
          source_of_truth: sourceOfTruth.trim() || null,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `HTTP ${res.status}`);
      }
      onSaved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-800 rounded-lg w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-1">Novo item</h3>
        <p className="text-xs text-slate-500 mb-4">
          Nasce em <span className="font-mono text-slate-400">IDEA</span>. Transições via aba do item.
        </p>
        <div className="space-y-2.5">
          <div>
            <label className="text-xs text-slate-400">evolution_key <span className="text-red-400">*</span></label>
            <input
              value={key}
              onChange={e => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
              placeholder="UPPER_SNAKE, 3–64 chars"
              className="w-full px-2 py-1.5 text-sm bg-slate-950 border border-slate-800 rounded font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">título <span className="text-red-400">*</span></label>
            <input value={title} onChange={e => setTitle(e.target.value)} className="w-full px-2 py-1.5 text-sm bg-slate-950 border border-slate-800 rounded" />
          </div>
          <div>
            <label className="text-xs text-slate-400">domínio</label>
            <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="ex.: vision, verticals, platform" className="w-full px-2 py-1.5 text-sm bg-slate-950 border border-slate-800 rounded" />
          </div>
          <div>
            <label className="text-xs text-slate-400">sumário</label>
            <textarea value={summary} onChange={e => setSummary(e.target.value)} rows={3} className="w-full px-2 py-1.5 text-sm bg-slate-950 border border-slate-800 rounded" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-400">prioridade</label>
              <select value={priority} onChange={e => setPriority(e.target.value)} className="w-full px-2 py-1.5 text-sm bg-slate-950 border border-slate-800 rounded">
                <option value="">—</option>
                <option value="P0">P0</option>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400">source_of_truth</label>
              <input value={sourceOfTruth} onChange={e => setSourceOfTruth(e.target.value)} placeholder="ex.: ADR-193" className="w-full px-2 py-1.5 text-sm bg-slate-950 border border-slate-800 rounded" />
            </div>
          </div>
        </div>
        {err && <div className="mt-3 text-sm text-red-400">{err}</div>}
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 px-3 py-2 text-sm bg-slate-800 hover:bg-slate-700 rounded">Cancelar</button>
          <button onClick={submit} disabled={busy || !key || !title} className="flex-1 px-3 py-2 text-sm bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded">
            {busy ? 'Criando…' : 'Criar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════ Helpers ═══════════════

function relTime(iso: string): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) {
    const hours = Math.floor(ms / 3600000);
    if (hours <= 0) return 'agora';
    return `há ${hours}h`;
  }
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days}d`;
  const months = Math.floor(days / 30);
  return `há ${months}mo`;
}

export default ProductEvolutionView;
