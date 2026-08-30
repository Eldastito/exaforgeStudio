import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Store, Loader2, Check, X, RefreshCw, Calculator, CalendarDays, Plus, Scale, AlertTriangle, Users, Upload, Trash2, Sparkles, Globe, Download, Lightbulb, Boxes, TrendingUp, CreditCard, Pencil, ArrowLeftRight, Truck, PackageCheck, DollarSign, Tag, ChevronRight, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useAuth } from '@/src/contexts/AuthContext';
import { isoLocal, todayStr, sundayOf, addDays } from './retailDateUtils';
import { parseMoneyBR } from './retailMoney';
import { boletasEsperadas, boletaFinalEsperada, PRODUTOS_POR_BOLETA } from './retailBoletas';
import { reconcileBandeiras, sumBandeiras } from './retailClosingForm';

// ============================================================================
// Rede de Lojas — Operação (RetailOps, ADR-083/084). Telas do FECHAMENTO diário
// e da COMISSÃO da equipe, consumindo a API já testada (/api/retailops/*).
// Só aparece quando o módulo `retail` está habilitado na org.
// ============================================================================

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
// todayStr/sundayOf/addDays/isoLocal vêm de ./retailDateUtils (data LOCAL, não
// UTC — corrige o off-by-one da escala e do fechamento à noite no Brasil).

// PDR TOULON, Fatia 1D/4D — estados HONESTOS das telas analíticas. Nunca
// mascarar 403/timeout/500/rede como "sem dados": cada um tem mensagem e ação
// próprias. 'unavailable' = servidor inalcançável (rede caiu); 'aborted' = a
// requisição foi cancelada por outra mais nova (troca de filtro) e o resultado
// deve ser IGNORADO (PERF-006), nunca sobrescrever a tela.
type AnalyticsStatus = 'idle' | 'loading' | 'ok' | 'forbidden' | 'timeout' | 'error' | 'unavailable' | 'aborted';
async function fetchAnalytics(url: string, signal?: AbortSignal): Promise<{ status: Exclude<AnalyticsStatus, 'idle' | 'loading'>; data: any; correlationId?: string }> {
  try {
    const r = await apiFetch(url, signal ? { signal } : {});
    if (r.status === 403) return { status: 'forbidden', data: null };
    if (r.status === 408 || r.status === 504) return { status: 'timeout', data: null };
    if (!r.ok) { const d = await r.json().catch(() => ({})); return { status: (d?.error === 'analytics_timeout' ? 'timeout' : 'error'), data: null, correlationId: d?.correlationId }; }
    const data = await r.json().catch(() => null);
    return { status: 'ok', data };
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal?.aborted) return { status: 'aborted', data: null }; // cancelada
    return { status: 'unavailable', data: null }; // rede caiu: tentativa não confirmada
  }
}

/**
 * Hook das telas analíticas (PERF-006/007): cancela a requisição anterior ao
 * recarregar (nada de resposta obsoleta sobrescrevendo a atual) e, quando um
 * refresh falha, MANTÉM o último snapshot na tela em vez de apagá-lo
 * ("dados desatualizados"). `urlFactory` é lido no momento do fetch (fecha
 * sobre o estado mais recente); `deps` dispara o auto-reload.
 */
function useAnalytics(urlFactory: () => string, deps: any[]) {
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState<AnalyticsStatus>('idle');
  const [corr, setCorr] = useState<string | undefined>(undefined);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const factoryRef = useRef(urlFactory); factoryRef.current = urlFactory;
  const reload = useCallback(async () => {
    const url = factoryRef.current();
    if (!url) { ctrl.current?.abort(); setStatus('idle'); return; } // sem alvo → não busca
    ctrl.current?.abort();                        // PERF-006: cancela a anterior
    const ac = new AbortController(); ctrl.current = ac;
    setStatus('loading');
    const res = await fetchAnalytics(url, ac.signal);
    if (res.status === 'aborted' || ac.signal.aborted) return; // obsoleta → ignora
    if (res.status === 'ok') { setData(res.data); setLoadedAt(Date.now()); setCorr(undefined); setStatus('ok'); }
    else { setCorr(res.correlationId); setStatus(res.status); } // mantém `data` → snapshot
  }, []);
  useEffect(() => { reload(); return () => ctrl.current?.abort(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const isStale = data != null && status !== 'ok' && status !== 'loading' && status !== 'idle';
  return { data, status, corr, loading: status === 'loading', isStale, loadedAt, reload };
}

function AnalyticsBanner({ status, onRetry, correlationId }: { status: AnalyticsStatus; onRetry?: () => void; correlationId?: string }) {
  if (status === 'ok' || status === 'idle' || status === 'loading' || status === 'aborted') return null;
  const map: Record<string, { text: string; cls: string; retry: boolean }> = {
    forbidden: { text: 'Você não tem permissão para ver estes dados.', cls: 'border-amber-500/30 bg-amber-500/5 text-amber-200', retry: false },
    timeout: { text: 'A consulta demorou demais — não foi possível carregar. Tente de novo.', cls: 'border-amber-500/30 bg-amber-500/5 text-amber-200', retry: true },
    unavailable: { text: 'Sem conexão com o servidor. Verifique a internet e tente de novo.', cls: 'border-amber-500/30 bg-amber-500/5 text-amber-200', retry: true },
    error: { text: `Erro no servidor ao carregar${correlationId ? ` (ref: ${correlationId})` : ''}. Tente de novo em instantes.`, cls: 'border-red-500/30 bg-red-500/5 text-red-200', retry: true },
  };
  const m = map[status]; if (!m) return null;
  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] ${m.cls}`}>
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span className="flex-1">{m.text}</span>
      {m.retry && onRetry && <button onClick={onRetry} className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-0.5 text-[12px] hover:bg-white/5"><RefreshCw className="w-3.5 h-3.5" /> Tentar de novo</button>}
    </div>
  );
}

/**
 * Faixa "dados desatualizados" (PERF-007): a tela segue mostrando o ÚLTIMO
 * snapshot bom; esta faixa avisa que a atualização mais recente falhou e
 * oferece nova tentativa — nunca deixa o número velho passar por atual.
 */
function StaleNotice({ status, onRetry, loadedAt, correlationId }: { status: AnalyticsStatus; onRetry?: () => void; loadedAt?: number | null; correlationId?: string }) {
  const when = loadedAt ? new Date(loadedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
  const why = status === 'unavailable' ? 'sem conexão' : status === 'error' ? `erro no servidor${correlationId ? ` (ref: ${correlationId})` : ''}` : 'a consulta demorou demais';
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span className="flex-1">Mostrando a última leitura{when ? ` (${when})` : ''} — não foi possível atualizar agora ({why}).</span>
      {onRetry && <button onClick={onRetry} className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-0.5 hover:bg-white/5"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>}
    </div>
  );
}
const CLOSING_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pendente', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  received: { label: 'Informado', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  extracted: { label: 'Lido (IA)', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  needs_review: { label: 'Conferir', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'Aprovado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  rejected: { label: 'Rejeitado', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};
const RUN_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Prévia', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  approved: { label: 'Aprovada', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  rejected: { label: 'Rejeitada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};

function Badge({ map, s }: { map: Record<string, { label: string; cls: string }>; s: string }) {
  const it = map[s] || { label: s, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${it.cls}`}>{it.label}</span>;
}

// ---- Insights da loja: o que a IA observou e sugere ------------------------
const SEV: Record<string, { label: string; cls: string }> = {
  critical: { label: 'crítico', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  risk: { label: 'risco', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  attention: { label: 'atenção', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  info: { label: 'info', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
};
const ACTION_STATUS: Record<string, { label: string; cls: string }> = {
  awaiting_approval: { label: 'aguarda aprovação', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved: { label: 'aprovada', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  done: { label: 'concluída', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  cancelled: { label: 'cancelada', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  rejected: { label: 'rejeitada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};
// Header dos "Insights": grandes números do dia da REDE (ou loja filtrada)
// + top/bottom 3 lojas pra o dono saber onde tá a mão.
function InsightsHeader({ header, storeFilter }: { header: any; storeFilter: string }) {
  const d = header.daily || {};
  const rk = header.ranking || {};
  const varOk = Number(d.variance) >= 0;
  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">{storeFilter ? 'Vendido hoje' : 'Vendido hoje (rede)'}</p>
          <p className="text-lg font-semibold text-zinc-100">{brl(d.realized || 0)}</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">Cota do dia</p>
          <p className="text-lg font-semibold text-zinc-200">{brl(d.quotaTotal || 0)}</p>
        </div>
        <div className={`rounded-xl border p-3 ${varOk ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
          <p className={`text-[10px] uppercase tracking-wider ${varOk ? 'text-emerald-400/80' : 'text-red-400/80'}`}>Desvio</p>
          <p className={`text-lg font-semibold ${varOk ? 'text-emerald-300' : 'text-red-300'}`}>
            {d.variance > 0 ? '+' : ''}{brl(d.variance || 0)}
            {d.variancePercent != null && <span className="ml-1 text-xs opacity-80">({d.variancePercent > 0 ? '+' : ''}{Math.round((d.variancePercent || 0) * 10) / 10}%)</span>}
          </p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500">Lojas na cota</p>
          <p className="text-lg font-semibold text-zinc-100">{d.storesAbove || 0}<span className="ml-1 text-xs text-zinc-500">/{(d.storesAbove || 0) + (d.storesBelow || 0)} fech.</span></p>
          <p className="text-[10px] text-zinc-600">{d.pendingClosings || 0} sem fechar · {d.divergences || 0} divergente(s)</p>
        </div>
      </div>
      {!storeFilter && (rk.top3?.length > 0 || rk.bottom3?.length > 0) && (
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2">
            <p className="text-[10px] uppercase tracking-wider text-emerald-300/80 mb-1">🏆 Top 3 lojas do dia</p>
            {(rk.top3 || []).map((s: any, i: number) => (
              <div key={s.storeId} className="flex items-center gap-2 text-[12px]">
                <span className="w-4 text-right text-zinc-500">{i + 1}º</span>
                <span className="flex-1 truncate text-zinc-200">{s.storeName}</span>
                <span className="text-zinc-500 text-[10px]">{brl(s.realized)}</span>
                <span className={`w-16 text-right font-medium ${s.variancePercent >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{s.variancePercent >= 0 ? '+' : ''}{s.variancePercent}%</span>
              </div>
            ))}
            {(rk.top3 || []).length === 0 && <p className="text-[11px] text-zinc-600">Ainda não tem loja com cota + fechamento aprovado hoje.</p>}
          </div>
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-2">
            <p className="text-[10px] uppercase tracking-wider text-red-300/80 mb-1">📉 Bottom 3 do dia (foco)</p>
            {(rk.bottom3 || []).map((s: any, i: number) => (
              <div key={s.storeId} className="flex items-center gap-2 text-[12px]">
                <span className="w-4 text-right text-zinc-500">{i + 1}º</span>
                <span className="flex-1 truncate text-zinc-200">{s.storeName}</span>
                <span className="text-zinc-500 text-[10px]">{brl(s.realized)}</span>
                <span className={`w-16 text-right font-medium ${s.variancePercent >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{s.variancePercent >= 0 ? '+' : ''}{s.variancePercent}%</span>
              </div>
            ))}
            {(rk.bottom3 || []).length === 0 && <p className="text-[11px] text-zinc-600">Sem dados suficientes ainda.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// Empty-state do "O que atacar primeiro": explica o que a IA olha, por que
// pode estar vazio agora e que ela roda sozinha. Melhor que "Nenhuma
// prioridade" seco.
function EmptyPrioritiesState({ storeFilter, header }: { storeFilter: string; header: any }) {
  const d = header?.daily || {};
  const noClosings = (d.storesAbove || 0) + (d.storesBelow || 0) === 0;
  const reason = noClosings
    ? 'Nenhuma loja fechou o caixa ainda hoje — sem fechamento, a IA não tem base pra comparar com a cota.'
    : (storeFilter ? 'Nada acima do limite pra essa loja hoje. Bom sinal.' : 'Nada acima do limite hoje na rede toda. Bom sinal — significa que fechamento, divergência e estoque estão dentro do que o dono definiu como normal.');
  return (
    <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 p-4 text-sm">
      <p className="text-zinc-300 font-medium">Nenhuma prioridade agora {storeFilter ? '(nessa loja)' : ''}.</p>
      <p className="mt-1 text-[12px] text-zinc-500">{reason}</p>
      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2 text-[11px] text-zinc-400">
        <p className="text-zinc-300 mb-1">O que a IA olha nessa varredura:</p>
        <ul className="list-disc list-inside space-y-0.5 text-zinc-500">
          <li>Fechamento diário <strong>abaixo da cota</strong> por loja (Fase C).</li>
          <li><strong>Divergência</strong> entre o informado e o total do PDV/sistema (Fase E).</li>
          <li><strong>Estoque negativo</strong> por loja/produto (Fase F).</li>
          <li>Loja virtual: <strong>sem-venda</strong>, <strong>estoque baixo</strong> ou <strong>ruptura</strong> (ADR-143).</li>
          <li><strong>Transferência entre lojas</strong> disponível pra cobrir necessidade (RetailOps).</li>
          <li><strong>Padrões recorrentes</strong> aprendidos pela IA (ADR-142) — divergência de caixa que se repete, ruptura toda sexta, etc.</li>
        </ul>
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">A IA roda a análise sozinha em background; use "Analisar agora" quando quiser um retrato imediato.</p>
    </div>
  );
}

function InsightsTab() {
  const [data, setData] = useState<any | null>(null);
  const [header, setHeader] = useState<any | null>(null);
  const [stores, setStores] = useState<any[]>([]);
  const [storeFilter, setStoreFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [acted, setActed] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const loadActions = async () => {
    const d = await apiFetch('/api/retailops/insights/actions').then(r => r.json()).catch(() => ({}));
    setActions(Array.isArray(d?.actions) ? d.actions : []);
  };
  const loadHeader = async () => {
    const qs = storeFilter ? `?storeId=${storeFilter}` : '';
    const d = await apiFetch(`/api/retailops/insights/header${qs}`).then(r => r.json()).catch(() => null);
    setHeader(d);
  };
  const loadStores = async () => {
    const d = await apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({}));
    setStores((Array.isArray(d?.stores) ? d.stores : []).filter((s: any) => s.active));
  };
  const act = async (p: any) => {
    if (!p?.signalId) return;
    const res = await apiFetch('/api/retailops/insights/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signalId: p.signalId }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.ok) {
      const st = d.action?.status;
      setActed(prev => ({ ...prev, [p.signalId]: st }));
      if (d.transfer && d.transfer.id) toast.success('Transferência despachada — acompanhe na aba Transferências.');
      else if (d.transfer && d.transfer.error) toast.error(`Ação criada, mas a transferência falhou: ${d.transfer.error}`);
      else toast.success(st === 'approved' ? 'Ação criada e aprovada.' : 'Ação criada — aguardando aprovação.');
      loadActions();
    } else toast.error(d.error || 'Falha ao criar a ação.');
  };
  const actionOp = async (a: any, op: 'approve' | 'cancel' | 'complete') => {
    let body: any = undefined;
    if (op === 'complete') {
      const v = window.prompt('Resultado obtido (R$, opcional):', '');
      if (v === null) return;
      body = { resultAmount: v.trim() === '' ? null : Number(v) };
    }
    const res = await apiFetch(`/api/actions/${a.id}/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (res.ok) { toast.success(op === 'approve' ? 'Ação aprovada.' : op === 'cancel' ? 'Ação cancelada.' : 'Ação concluída (medida).'); loadActions(); }
    else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha na operação.'); }
  };

  const load = async () => {
    setLoading(true);
    try {
      const qs = storeFilter ? `?storeId=${storeFilter}` : '';
      setData(await apiFetch(`/api/retailops/insights${qs}`).then(r => r.json()).catch(() => null));
      await loadActions();
      await loadHeader();
    } finally { setLoading(false); }
  };
  useEffect(() => { loadStores(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [storeFilter]);
  const analyze = async () => {
    setAnalyzing(true);
    try {
      const res = await apiFetch('/api/retailops/signals/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (res.ok) { const d = await res.json().catch(() => ({})); toast.success(`Operações analisadas: ${d.published || 0} sinal(is).`); load(); }
      else toast.error('Falha ao analisar.');
    } finally { setAnalyzing(false); }
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
  const priorities: any[] = data?.priorities || [];
  const patterns: any[] = data?.patterns || [];
  const sev = data?.bySeverity || {};
  const fmtImpact = (im: any) => im ? (im.unit === 'BRL' ? brl(im.amount) : `${im.amount} ${im.unit === 'units' ? 'un' : (im.unit || '')}`.trim()) : null;

  return (
    <div>
      {/* Header: grandes números do dia da REDE (ou loja filtrada) — o que
          o dono precisa ver PRIMEIRO ao entrar na aba. */}
      {header?.daily && <InsightsHeader header={header} storeFilter={storeFilter} />}

      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Lightbulb className="w-4 h-4 text-amber-400" /> O que a IA observou{storeFilter ? ' nessa loja' : ' na rede'}</div>
        <div className="flex items-center gap-1.5">
          {(['critical', 'risk', 'attention', 'info'] as const).filter(k => (sev[k] || 0) > 0).map(k => (
            <span key={k} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${SEV[k].cls}`}>{sev[k]} {SEV[k].label}</span>
          ))}
        </div>
        {stores.length > 1 && (
          <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" title="Filtra prioridades por loja">
            <option value="">Rede toda ({stores.length} lojas)</option>
            {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` · ${s.code}` : ''}</option>)}
          </select>
        )}
        <button onClick={analyze} disabled={analyzing} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{analyzing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Analisar agora</button>
      </div>

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">O que atacar primeiro</h3>
      {priorities.length === 0 ? (
        <EmptyPrioritiesState storeFilter={storeFilter} header={header} />
      ) : (
        <div className="space-y-2">
          {priorities.map((p, i) => {
            const isOpen = expanded[p.signalId] || false;
            return (
              <div key={p.signalId || i} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-mono text-zinc-500">#{i + 1}</span>
                  <span className="inline-flex items-center rounded-full border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-[11px] text-zinc-400">{p.domain}</span>
                  {p.impact && <span className="text-[11px] text-emerald-300">impacto {fmtImpact(p.impact)}</span>}
                  <span className="text-[11px] text-zinc-500">· {p.dueHint}</span>
                  {p.basis && <span className={`text-[10px] rounded px-1.5 py-0.5 border ${p.basis === 'fact' ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/5' : 'border-amber-500/30 text-amber-300 bg-amber-500/5'}`} title={p.basis === 'fact' ? 'Base em fato observado (sem inferência)' : 'Estimativa — inferido a partir de padrão'}>{p.basis === 'fact' ? 'fato' : 'estimativa'}</span>}
                </div>
                <p className="mt-1 text-sm text-zinc-200">{p.interpretation || p.fact}</p>
                <div className="mt-1.5 flex items-center gap-2 text-[12px] flex-wrap">
                  <span className="text-zinc-500">Sugestão:</span>
                  <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-indigo-200">{p.recommendedAction}</span>
                  {p.signalId && (
                    <button onClick={() => setExpanded(p2 => ({ ...p2, [p.signalId]: !isOpen }))} className="text-[11px] text-zinc-500 hover:text-zinc-300 underline underline-offset-2" title="Ver como a IA chegou nesse número">
                      {isOpen ? 'esconder detalhe' : 'como cheguei aqui'}
                    </button>
                  )}
                  {p.signalId && (acted[p.signalId]
                    ? <span className="ml-auto inline-flex items-center gap-1 text-emerald-300"><Check className="w-3.5 h-3.5" /> {acted[p.signalId] === 'approved' ? 'ação criada' : 'ação criada (aguarda aprovação)'}</span>
                    : <button onClick={() => act(p)} className="ml-auto inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-white hover:bg-indigo-500">Agir</button>)}
                </div>
                {isOpen && (
                  <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-[11px] text-zinc-400">
                    <div className="grid gap-1 sm:grid-cols-2">
                      <div><span className="text-zinc-500">Tipo do sinal:</span> <span className="font-mono text-zinc-300">{p.signalType || '—'}</span></div>
                      <div><span className="text-zinc-500">Confiança:</span> <span className="text-zinc-300">{p.confidence != null ? `${Math.round(Number(p.confidence) * 100)}%` : '—'}</span></div>
                      <div className="sm:col-span-2"><span className="text-zinc-500">Fonte:</span> <span className="font-mono text-zinc-300">{p.source || '—'}</span></div>
                    </div>
                    {p.evidence && Object.keys(p.evidence).length > 0 ? (
                      <div className="mt-2">
                        <span className="text-zinc-500">O que a IA observou:</span>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-zinc-950 border border-zinc-800/70 p-1.5 font-mono text-[10px] text-zinc-300">{JSON.stringify(p.evidence, null, 2)}</pre>
                      </div>
                    ) : <p className="mt-2 text-zinc-600">Sem detalhamento adicional pra esse sinal.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-6 mb-2">Padrões aprendidos ({patterns.length})</h3>
      {patterns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-600">A IA ainda não validou padrões recorrentes. Eles aparecem quando algo se repete ao longo das semanas (rode o aprendizado na aba Padrões).</div>
      ) : (
        <div className="space-y-1.5">
          {patterns.map((p) => (
            <div key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-zinc-500"><span className="font-mono">{p.pattern_type}</span><span>· confiança {Math.round(Number(p.confidence) * 100)}% · visto {p.occurrences}x</span></div>
              {p.description && <p className="text-sm text-zinc-200">{p.description}</p>}
            </div>
          ))}
        </div>
      )}

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-6 mb-2">Ações em andamento ({actions.filter(a => a.status !== 'done' && a.status !== 'cancelled').length})</h3>
      {actions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-600">Nenhuma ação ainda. Clique em <strong>“Agir”</strong> numa prioridade acima para criar uma.</div>
      ) : (
        <div className="space-y-1.5">
          {actions.map((a) => {
            const st = ACTION_STATUS[a.status] || { label: a.status, cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' };
            return (
              <div key={a.id} className="flex items-center gap-2 flex-wrap rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                <span className="text-sm text-zinc-200">{a.title}</span>
                {a.expected_impact != null && <span className="text-[11px] text-zinc-500">· esperado {a.impact_unit === 'BRL' ? brl(a.expected_impact) : `${a.expected_impact} ${a.impact_unit === 'units' ? 'un' : (a.impact_unit || '')}`.trim()}</span>}
                {a.status === 'done' && a.result_amount != null && <span className="text-[11px] text-emerald-300">· realizado {a.impact_unit === 'BRL' ? brl(a.result_amount) : a.result_amount}</span>}
                <div className="ml-auto flex items-center gap-1.5">
                  {a.status === 'awaiting_approval' && <button onClick={() => actionOp(a, 'approve')} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Aprovar</button>}
                  {a.status === 'approved' && <button onClick={() => actionOp(a, 'complete')} className="rounded border border-indigo-500/30 px-2 py-0.5 text-[11px] text-indigo-300 hover:bg-indigo-500/10">Concluir</button>}
                  {(a.status === 'awaiting_approval' || a.status === 'approved') && <button onClick={() => actionOp(a, 'cancel')} className="rounded border border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800">Cancelar</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Tabela compacta do relatório de comissão (por vendedor/produto/loja).
function ReportBlock({ title, rows, cols, empty }: { title: string; rows: any[]; cols: Array<[string, string, boolean?]>; empty: string }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-1.5">{title}</h4>
      {(!rows || rows.length === 0) ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-3 text-center text-[12px] text-zinc-600">{empty}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              {cols.map(([k, label, money]) => <th key={k} className={`px-3 py-1.5 font-medium ${money ? 'text-right' : 'text-left'}`}>{label}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-zinc-800/60">
                  {cols.map(([k, , money]) => <td key={k} className={`px-3 py-1.5 ${money ? 'text-right text-zinc-200' : 'text-zinc-300'} ${k === 'commission' ? 'text-emerald-300' : ''}`}>{money ? brl(r[k]) : r[k]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Padrões (IA) — memória de padrões do varejo (ADR-142) ------------------
function PatternsTab() {
  const [patterns, setPatterns] = useState<any[]>([]);
  const [typeStats, setTypeStats] = useState<any[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [proposeFor, setProposeFor] = useState<any | null>(null);
  const [propTick, setPropTick] = useState(0);

  const effOf = (type: string) => typeStats.find((s) => s.pattern_type === type);

  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch('/api/retailops/patterns').then(r => r.json()).catch(() => ({}));
      setEnabled(!!d?.enabled);
      setPatterns(Array.isArray(d?.patterns) ? d.patterns : []);
      setTypeStats(Array.isArray(d?.typeStats) ? d.typeStats : []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const recordOutcome = async (p: any, outcome: 'worked' | 'no_effect' | 'backfired') => {
    const res = await apiFetch(`/api/retailops/patterns/${p.id}/outcome`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success('Desfecho registrado — o sistema aprendeu com o resultado.');
      if (Array.isArray(d.patterns)) setPatterns(d.patterns);
      if (Array.isArray(d.typeStats)) setTypeStats(d.typeStats);
    } else toast.error(d.error || 'Falha ao registrar o desfecho.');
  };

  const toggle = async () => {
    const res = await apiFetch('/api/retailops/patterns/flag', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setEnabled(!!d.enabled); toast.success(d.enabled ? 'Aprendizado de padrões ligado.' : 'Aprendizado de padrões desligado.'); }
    else toast.error(d.error || 'Falha ao alterar.');
  };
  const learn = async () => {
    setLearning(true);
    try {
      const res = await apiFetch('/api/retailops/patterns/learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`Aprendizado rodado: ${d.detected || 0} padrão(ões), ${d.validated || 0} validado(s).`); setPatterns(Array.isArray(d.patterns) ? d.patterns : []); }
      else toast.error(d.error || 'Falha ao rodar o aprendizado.');
    } finally { setLearning(false); }
  };
  const analyzeOps = async () => {
    const res = await apiFetch('/api/retailops/signals/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) toast.success(`Operações analisadas: ${d.published || 0} sinal(is) para o Diretor/Pareto${d.resolved ? `, ${d.resolved} resolvido(s)` : ''}.`);
    else toast.error(d.error || 'Falha ao analisar as operações.');
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <p className="text-sm text-zinc-400">Padrões recorrentes que a IA aprende da operação (divergência de caixa, estoque negativo…). A confiança é calculada por regra de recorrência; a IA só descreve.</p>
        <button onClick={toggle} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>
          <span className={`inline-block w-2 h-2 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-zinc-600'}`} /> Aprendizado {enabled ? 'ligado' : 'desligado'}
        </button>
        <button onClick={learn} disabled={learning || !enabled} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {learning ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Rodar aprendizado agora
        </button>
        <button onClick={analyzeOps} title="Analisa as operações (loja virtual, reservas, vendas) e publica sinais para o Pareto e o Diretor IA." className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-200 hover:bg-emerald-500/20">
          <Calculator className="w-4 h-4" /> Analisar operações
        </button>
      </div>

      {patterns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center">
          <p className="text-sm text-zinc-500">Nenhum padrão aprendido ainda.</p>
          <p className="mt-1 text-[12px] text-zinc-600">{enabled ? 'Rode o aprendizado quando houver histórico (fechamentos, divergências, estoque). Padrões validados aparecem para o Diretor IA e no Pareto.' : 'Ligue o aprendizado para a IA começar a observar os padrões da loja.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {patterns.map((p) => {
            const eff = effOf(p.pattern_type);
            return (
            <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-zinc-500">{p.pattern_type}</span>
                <Badge map={PATTERN_STATUS} s={p.status} />
                <span className="text-[11px] text-zinc-500">confiança {Math.round(Number(p.confidence) * 100)}% · visto {p.occurrences}x{p.last_seen_date ? ` · ${p.last_seen_date}` : ''}</span>
                {eff && eff.acted > 0 && <span className="text-[11px] text-indigo-300">eficácia das ações {Math.round(Number(eff.effectiveness) * 100)}% ({eff.acted}x)</span>}
              </div>
              {p.description && <p className="mt-1.5 text-sm text-zinc-200">{p.description}</p>}
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-zinc-500">Agiu sobre isso? Como foi:</span>
                <button onClick={() => recordOutcome(p, 'worked')} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Funcionou</button>
                <button onClick={() => recordOutcome(p, 'no_effect')} className="rounded border border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800">Sem efeito</button>
                <button onClick={() => recordOutcome(p, 'backfired')} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">Piorou</button>
                <button onClick={() => setProposeFor(p)} className="ml-auto inline-flex items-center gap-1 rounded border border-indigo-500/30 px-2 py-0.5 text-[11px] text-indigo-300 hover:bg-indigo-500/10"><Lightbulb className="w-3 h-3" /> Sugerir solução</button>
              </div>
              <PatternSolutions patternId={p.id} refreshKey={propTick} />
            </div>
            );
          })}
        </div>
      )}

      <SolutionsPanel refreshKey={propTick} />
      {proposeFor && <SolutionProposalModal pattern={proposeFor} onClose={() => setProposeFor(null)} onCreated={() => { setProposeFor(null); setPropTick(t => t + 1); }} />}
    </div>
  );
}

// Modal "Sugerir solução" (LEARN-001): o gerente propõe uma solução ligada a um
// padrão. Nasce rascunho; o ciclo governado segue no painel abaixo.
function SolutionProposalModal({ pattern, onClose, onCreated }: { pattern: any; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [proposal, setProposal] = useState('');
  const [conditions, setConditions] = useState('');
  const [expectedMetric, setExpectedMetric] = useState('');
  const [baseline, setBaseline] = useState('');
  const [risks, setRisks] = useState('');
  const [busy, setBusy] = useState(false);
  const field = "w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 outline-none focus:border-indigo-500";
  const save = async () => {
    if (!title.trim() || !proposal.trim()) { toast.error('Informe título e proposta.'); return; }
    setBusy(true);
    try {
      const body: any = { title, proposal, conditions: conditions || undefined, expectedMetric: expectedMetric || undefined, risks: risks || undefined, storeId: pattern.store_id || null };
      if (baseline.trim()) body.baseline = Number(baseline.replace(',', '.'));
      const r = await apiFetch(`/api/retailops/patterns/${pattern.id}/solution-proposals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha ao criar.');
      toast.success('Proposta criada (rascunho). Submeta para revisão no painel abaixo.');
      onCreated();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-[460px] p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2 mb-1"><Lightbulb className="w-5 h-5 text-indigo-400" /> Sugerir solução</h3>
        <p className="text-[11px] text-zinc-500 mb-3">Para o padrão: <span className="text-zinc-400">{pattern.description || pattern.pattern_type}</span>. A proposta passa por revisão e teste antes de virar conhecimento — não é aplicada automaticamente.</p>
        <label className="text-xs text-zinc-400 mb-1 block">Título *</label>
        <input value={title} onChange={e => setTitle(e.target.value)} className={`${field} mb-3`} placeholder="Ex.: Dupla conferência no fechamento" />
        <label className="text-xs text-zinc-400 mb-1 block">Proposta *</label>
        <textarea value={proposal} onChange={e => setProposal(e.target.value)} className={`${field} h-20 mb-3 resize-none`} placeholder="O que fazer, na prática." />
        <label className="text-xs text-zinc-400 mb-1 block">Em que condição funciona</label>
        <input value={conditions} onChange={e => setConditions(e.target.value)} className={`${field} mb-3`} placeholder="Ex.: fins de semana movimentados" />
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Indicador esperado</label>
            <input value={expectedMetric} onChange={e => setExpectedMetric(e.target.value)} className={field} placeholder="Ex.: divergência R$" />
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Valor inicial</label>
            <input value={baseline} onChange={e => setBaseline(e.target.value)} inputMode="decimal" className={field} placeholder="Ex.: 300" />
          </div>
        </div>
        <label className="text-xs text-zinc-400 mb-1 block">Riscos / limitações</label>
        <input value={risks} onChange={e => setRisks(e.target.value)} className={`${field} mb-4`} placeholder="Opcional" />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">Cancelar</button>
          <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}Criar proposta</button>
        </div>
      </div>
    </div>
  );
}

const SOLUTION_STATE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Rascunho', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  in_review: { label: 'Em revisão', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  approved_for_test: { label: 'Aprovada p/ teste', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  testing: { label: 'Em teste', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  validated: { label: 'Validada', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  promoted: { label: 'Na memória', cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/40' },
  rejected: { label: 'Rejeitada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  archived: { label: 'Arquivada', cls: 'text-zinc-500 bg-zinc-500/10 border-zinc-600/30' },
  revoked: { label: 'Revogada', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};

// Painel de gestão das propostas (LEARN-002/003/004/005). Ações de governança
// (aprovar/promover/etc.) só para owner/admin; submeter é de qualquer um.
function SolutionsPanel({ refreshKey }: { refreshKey?: number }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'owner' || user?.role === 'admin';
  const [items, setItems] = useState<any[]>([]);
  const load = () => apiFetch('/api/retailops/solution-proposals').then(r => r.json()).then(d => setItems(Array.isArray(d?.proposals) ? d.proposals : [])).catch(() => {});
  useEffect(() => { load(); }, [refreshKey]);
  const op = async (id: string, path: string, body?: any) => {
    try {
      const r = await apiFetch(`/api/retailops/solution-proposals/${id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) throw new Error((await r.json()).error || 'Falha');
      toast.success('Proposta atualizada.'); load();
    } catch (e: any) { toast.error(e.message); }
  };
  const recordOutcome = (id: string) => {
    const final = prompt('Valor final medido (número):'); if (final === null) return;
    const conf = prompt('Confiança do resultado (0 a 1):'); if (conf === null) return;
    op(id, 'record-outcome', { final: Number(String(final).replace(',', '.')), confidence: Number(String(conf).replace(',', '.')) });
  };
  const withReason = (id: string, path: string, q: string) => { const reason = prompt(q); if (reason === null) return; op(id, path, { reason }); };
  const active = items.filter(p => !['archived'].includes(p.state));
  if (active.length === 0) return null;
  return (
    <div className="mt-6">
      <h4 className="text-sm font-semibold text-zinc-200 mb-2 flex items-center gap-2"><Lightbulb className="w-4 h-4 text-indigo-400" /> Propostas de solução ({active.length})</h4>
      <div className="space-y-2">
        {active.map(p => (
          <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-zinc-100 font-medium">{p.title}</span>
              <Badge map={SOLUTION_STATE} s={p.state} />
              {!p.store_id && <span className="text-[10px] text-zinc-500 border border-zinc-700 rounded px-1.5">rede</span>}
              {p.outcome_final != null && <span className="text-[11px] text-emerald-300">resultado {p.outcome_final}{p.outcome_confidence != null ? ` · conf. ${Math.round(p.outcome_confidence * 100)}%` : ''}</span>}
            </div>
            {p.proposal_text && <p className="mt-1 text-[13px] text-zinc-300">{p.proposal_text}</p>}
            {p.rejection_reason && <p className="mt-1 text-[11px] text-red-300/80">Motivo: {p.rejection_reason}</p>}
            <div className="mt-2 flex items-center gap-1.5 flex-wrap">
              {p.state === 'draft' && <button onClick={() => op(p.id, 'submit')} className="rounded border border-indigo-500/30 px-2 py-0.5 text-[11px] text-indigo-300 hover:bg-indigo-500/10">Submeter p/ revisão</button>}
              {isAdmin && p.state === 'in_review' && <>
                <button onClick={() => op(p.id, 'approve-test')} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Aprovar p/ teste</button>
                <button onClick={() => withReason(p.id, 'reject', 'Motivo da rejeição:')} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">Rejeitar</button>
              </>}
              {isAdmin && p.state === 'approved_for_test' && <button onClick={() => op(p.id, 'start-test')} className="rounded border border-sky-500/30 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-500/10">Iniciar teste</button>}
              {isAdmin && p.state === 'testing' && <>
                <button onClick={() => recordOutcome(p.id)} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10">Registrar resultado</button>
                <button onClick={() => withReason(p.id, 'reject', 'Motivo da rejeição:')} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">Rejeitar</button>
              </>}
              {isAdmin && p.state === 'validated' && <button onClick={() => op(p.id, 'promote')} className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200 hover:bg-emerald-500/20">Promover à memória</button>}
              {isAdmin && p.state === 'promoted' && <button onClick={() => withReason(p.id, 'revoke', 'Motivo da revogação:')} className="rounded border border-red-500/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10">Revogar</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// LEARN-006: recupera as soluções JÁ VALIDADAS relevantes a este padrão. A IA
// declara ORIGEM HUMANA + onde funcionou + evidência e traz a cautela adequada;
// nunca afirma eficácia geral. Carrega sob demanda (expander).
function PatternSolutions({ patternId, refreshKey }: { patternId: string; refreshKey?: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[] | null>(null);
  const load = () => apiFetch(`/api/retailops/patterns/${patternId}/solutions`).then(r => r.json()).then(d => setItems(Array.isArray(d?.solutions) ? d.solutions : [])).catch(() => setItems([]));
  useEffect(() => { if (open) load(); }, [open, refreshKey]);
  return (
    <div className="mt-2 border-t border-zinc-800/60 pt-2">
      <button onClick={() => setOpen(o => !o)} className="text-[11px] text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1">
        <Lightbulb className="w-3 h-3 text-indigo-400" /> {open ? 'Ocultar' : 'Ver'} soluções validadas
      </button>
      {open && (
        items === null ? <p className="mt-1 text-[11px] text-zinc-500">Carregando…</p> :
        items.length === 0 ? <p className="mt-1 text-[11px] text-zinc-500">Nenhuma solução validada para este tipo de problema ainda.</p> :
        <div className="mt-1.5 space-y-1.5">
          {items.map((s, i) => (
            <div key={s.proposalId || i} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] text-zinc-100 font-medium">{s.title}</span>
                <span className="text-[10px] text-indigo-300 border border-indigo-500/30 rounded px-1.5">origem humana</span>
                <span className="text-[10px] text-zinc-400 border border-zinc-700 rounded px-1.5">{s.scope === 'rede' ? 'rede' : 'loja'}</span>
                {s.generalizable
                  ? <span className="text-[10px] text-emerald-300 border border-emerald-500/30 rounded px-1.5">generalizável</span>
                  : <span className="text-[10px] text-amber-300 border border-amber-500/30 rounded px-1.5">testar antes</span>}
              </div>
              {s.proposal && <p className="mt-1 text-[12px] text-zinc-300">{s.proposal}</p>}
              <p className="mt-1 text-[11px] text-zinc-500">Funcionou em <span className="text-zinc-300">{s.whereWorked}</span>{s.evidence?.confidence != null ? ` · confiança ${Math.round(Number(s.evidence.confidence) * 100)}%` : ''}{s.evidence?.final != null ? ` · resultado ${s.evidence.final}` : ''}</p>
              {s.caveat && <p className="mt-1 text-[11px] text-amber-300/80">{s.caveat}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type RetailTab = 'insights' | 'fechamento' | 'comissao' | 'metas' | 'escala' | 'resultado' | 'precificar' | 'maisvendidos' | 'cartao' | 'clientes' | 'divergencia' | 'estoque' | 'reposicao' | 'transferencias' | 'equipe' | 'vendedores' | 'padroes' | 'lojavirtual';
const TABS: { key: RetailTab; label: string; icon: any }[] = [
  { key: 'insights', label: 'Insights', icon: Lightbulb },
  { key: 'fechamento', label: 'Fechamento diário', icon: CalendarDays },
  { key: 'comissao', label: 'Comissão', icon: Calculator },
  { key: 'metas', label: 'Metas do vendedor', icon: Scale },
  { key: 'escala', label: 'Escala & cotas', icon: Users },
  { key: 'resultado', label: 'Resultado por loja', icon: DollarSign },
  { key: 'precificar', label: 'Precificar', icon: Tag },
  { key: 'maisvendidos', label: 'Mais vendidos', icon: TrendingUp },
  { key: 'cartao', label: 'Recebíveis (cartão)', icon: CreditCard },
  { key: 'clientes', label: 'Clientes (PDV)', icon: Users },
  { key: 'divergencia', label: 'Divergência', icon: Scale },
  { key: 'estoque', label: 'Estoque negativo', icon: AlertTriangle },
  { key: 'reposicao', label: 'Reposição (grade)', icon: Boxes },
  { key: 'transferencias', label: 'Transferências', icon: ArrowLeftRight },
  { key: 'vendedores', label: 'Vendedores da loja', icon: Users },
  { key: 'equipe', label: 'Equipe & cobrança', icon: Users },
  { key: 'padroes', label: 'Padrões (IA)', icon: Sparkles },
  { key: 'lojavirtual', label: 'Loja virtual → PDV', icon: Globe },
];

const PATTERN_STATUS: Record<string, { label: string; cls: string }> = {
  validated: { label: 'Validado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  candidate: { label: 'Candidato', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  dormant: { label: 'Adormecido', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  refuted: { label: 'Refutado', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
};

// QUOTA-001 (Fatia 3B): resumo ÚNICO da cota total da loja — cota, realizado,
// diferença R$, atingimento %, status; e (opcional) a soma das cotas individuais
// e a divergência vs a cota da loja (QUOTA-002, exibida, nunca ajustada sozinha).
function StoreQuotaSummary({ quota, realized, individualQuotaTotal, compact }: { quota: number; realized: number; individualQuotaTotal?: number | null; compact?: boolean }) {
  const q = Number(quota) || 0, r = Number(realized) || 0;
  const diff = Math.round((r - q) * 100) / 100;
  const pct = q > 0 ? Math.round((r / q) * 1000) / 10 : null;
  const status = q <= 0 ? 'sem_cota' : r >= q ? (r === q ? 'atingida' : 'superada') : 'abaixo';
  const cls = status === 'superada' || status === 'atingida' ? 'text-emerald-300' : status === 'abaixo' ? 'text-amber-300' : 'text-zinc-500';
  const label = status === 'sem_cota' ? 'sem cota' : status === 'abaixo' ? 'abaixo' : status === 'atingida' ? 'atingida' : 'superada';
  const indDiv = individualQuotaTotal != null && q > 0 ? Math.round((individualQuotaTotal - q) * 100) / 100 : null;
  if (compact) {
    return (
      <span className="text-[11px] text-zinc-500">
        loja {brl(r)} / cota {brl(q)}{pct != null && <> · <span className={cls}>{pct}%</span> ({diff >= 0 ? '+' : ''}{brl(diff)})</>}
      </span>
    );
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
        <span className="text-zinc-400">Cota da loja <strong className="text-zinc-200">{brl(q)}</strong></span>
        <span className="text-zinc-400">Realizado <strong className="text-zinc-200">{brl(r)}</strong></span>
        <span className={cls}>Diferença <strong>{diff >= 0 ? '+' : ''}{brl(diff)}</strong></span>
        {pct != null && <span className={cls}>Atingimento <strong>{pct}%</strong></span>}
        <span className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls} border-current/30`}>{label}</span>
      </div>
      {individualQuotaTotal != null && (
        <p className="mt-1 text-[10px] text-zinc-500">Soma das cotas individuais: <strong className="text-zinc-300">{brl(individualQuotaTotal)}</strong>{indDiv != null && Math.abs(indDiv) > 0.01 && <> · diverge da cota da loja em <span className="text-amber-300">{indDiv >= 0 ? '+' : ''}{brl(indDiv)}</span> (exibido, não ajustado)</>}</p>
      )}
    </div>
  );
}

// ---- Resultado / lucro por loja (custos fixos + margem) ---------------------
function StoreResultTab() {
  const [period, setPeriod] = useState(() => todayStr().slice(0, 7));
  const { data, status, corr, loading, isStale, loadedAt, reload: load } =
    useAnalytics(() => `/api/retailops/stores-result?period=${period}`, [period]);
  const showData = status === 'ok' || isStale; // último snapshot enquanto o refresh falha

  const perStore: any[] = Array.isArray(data?.perStore) ? data.perStore : [];
  const totals = data?.totals || { faturamento: 0, custosFixos: 0, custosVariaveis: 0, resultado: 0 };
  const semMargem = perStore.filter(s => !s.hasMargin).length;
  const warnings = perStore.filter(s => s.variableCostsWarning).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm text-zinc-300">Lucro estimado e ponto de equilíbrio de cada loja no mês.</p>
          <p className="text-[11px] text-zinc-500">Faturamento (dos fechamentos) − custo da mercadoria (via margem bruta) − custos variáveis (taxa cartão, imposto, embalagem) − custos fixos cadastrados na loja.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" value={period} onChange={e => setPeriod(e.target.value.slice(0, 7))} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-4 h-4" /> Atualizar</button>
        </div>
      </div>

      {loading && !isStale && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>}

      {isStale && <StaleNotice status={status} onRetry={load} loadedAt={loadedAt} correlationId={corr} />}
      {!showData && !loading && <AnalyticsBanner status={status} onRetry={load} correlationId={corr} />}

      {showData && perStore.length === 0 && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">Nenhuma loja ativa com dados no mês. Cadastre custos fixos e a margem bruta em <strong>Editar loja</strong> para ver o lucro por loja.</p>
      )}

      {showData && perStore.length > 0 && (
        <>
          {semMargem > 0 && (
            <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              {semMargem === 1 ? '1 loja está' : `${semMargem} lojas estão`} sem a <strong>margem bruta média</strong> informada — pra elas o lucro e o ponto de equilíbrio não são calculados (só faturamento e custos). Informe em “Editar loja”.
            </p>
          )}
          {warnings > 0 && (
            <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
              {warnings === 1 ? '1 loja tem' : `${warnings} lojas têm`} custo variável fixo por venda cadastrado, mas <strong>sem contagem de vendas no mês</strong> (sem PDV nem fechamentos aprovados). A parte por ticket foi ignorada para não inflar o custo — os % continuam valendo.
            </p>
          )}
          {(() => {
            const nReal = perStore.filter(s => s.cmvBreakdown?.source === 'real').length;
            const nBlended = perStore.filter(s => s.cmvBreakdown?.source === 'blended').length;
            if (nReal === 0 && nBlended === 0) return null;
            return (
              <p className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[12px] text-emerald-200">
                CMV REAL (custo das notas de compra) aplicado em <strong>{nReal + nBlended}</strong> {nReal + nBlended === 1 ? 'loja' : 'lojas'}
                {nBlended > 0 && ` — ${nBlended} ainda com cobertura parcial (o resto usa a margem estimada)`}. Cadastre as notas de entrada (XML/foto) das lojas que ainda usam só estimativa para o cálculo ficar mais fiel.
              </p>
            );
          })()}
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Loja</th>
                  <th className="px-3 py-2 font-medium text-right">Faturamento</th>
                  <th className="px-3 py-2 font-medium text-right" title="Faturamento × margem bruta">Margem bruta</th>
                  <th className="px-3 py-2 font-medium text-right" title="Taxa de cartão, imposto sobre venda, embalagem etc.">Custos variáveis</th>
                  <th className="px-3 py-2 font-medium text-right">Custos fixos</th>
                  <th className="px-3 py-2 font-medium text-right">Lucro estimado</th>
                  <th className="px-3 py-2 font-medium text-right">Ponto de equilíbrio</th>
                </tr>
              </thead>
              <tbody>
                {perStore.map((s: any) => (
                  <tr key={s.storeId} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-200">
                      {s.storeName}
                      {s.variableCostsWarning && <span className="ml-1 text-[10px] text-amber-300/80" title={s.variableCostsWarning}>⚠</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">{brl(s.faturamento)}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">
                      {s.margemBruta == null ? (
                        <span className="text-amber-300/80" title="Informe a margem bruta em Editar loja">falta</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 justify-end" title={s.cmvWarning || (s.cmvBreakdown?.source === 'real' ? 'CMV via custo das notas de compra (100%)' : s.cmvBreakdown?.source === 'blended' ? `CMV misto: ${Math.round((s.cmvBreakdown.coverage || 0) * 100)}% pelas notas + resto pela margem estimada` : 'CMV via margem estimada (informada em Editar loja)')}>
                          {brl(s.margemBruta)}
                          {s.cmvBreakdown?.source === 'real' && <span className="text-[9px] rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1.5">real</span>}
                          {s.cmvBreakdown?.source === 'blended' && <span className="text-[9px] rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 px-1.5">{Math.round((s.cmvBreakdown.coverage || 0) * 100)}%</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">
                      {s.custoVariavelTotal == null || s.custoVariavelTotal === 0 ? <span className="text-zinc-600">—</span> : brl(s.custoVariavelTotal)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">{s.hasCustos ? brl(s.custosFixos.total) : <span className="text-zinc-600">—</span>}</td>
                    <td className={`px-3 py-2 text-right font-medium ${s.resultado == null ? 'text-zinc-600' : s.resultado >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{s.resultado == null ? '—' : brl(s.resultado)}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">
                      {s.pontoEquilibrio == null ? <span className="text-zinc-600">—</span> : (
                        <span title={s.progressoEquilibrio != null ? `Faturou ${Math.round(s.progressoEquilibrio * 100)}% do necessário para empatar` : ''}>{brl(s.pontoEquilibrio)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-700 bg-zinc-900/40 font-medium text-zinc-200">
                  <td className="px-3 py-2">Rede (total)</td>
                  <td className="px-3 py-2 text-right">{brl(totals.faturamento)}</td>
                  <td className="px-3 py-2 text-right text-zinc-500">—</td>
                  <td className="px-3 py-2 text-right">{brl(totals.custosVariaveis || 0)}</td>
                  <td className="px-3 py-2 text-right">{brl(totals.custosFixos)}</td>
                  <td className={`px-3 py-2 text-right ${totals.resultado >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{brl(totals.resultado)}</td>
                  <td className="px-3 py-2 text-right text-zinc-500">—</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">{data?.disclaimer || 'Resultado gerencial e estimado — não substitui a contabilidade oficial.'} O total de lucro da rede soma só as lojas com margem informada.</p>
        </>
      )}
    </div>
  );
}

export function RetailOpsView() {
  const [tab, setTab] = useState<RetailTab>('insights');
  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950">
      <div className="mb-4">
        <p className="zf-kicker mb-1">Rede de Lojas</p>
        <h2 className="zf-page-title flex items-center gap-2"><Store className="w-6 h-6" style={{ color: 'var(--color-flow)' }} /> Operação da Rede</h2>
        <p className="text-zinc-400 text-sm mt-1">Fechamento diário, comissão, conferência com o sistema, estoque e cobrança da equipe.</p>
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${tab === key ? 'bg-indigo-600 text-white' : 'border border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}><Icon className="w-4 h-4" /> {label}</button>
        ))}
      </div>
      {tab === 'insights' && <InsightsTab />}
      {tab === 'fechamento' && <ClosingsTab />}
      {tab === 'comissao' && <CommissionTab />}
      {tab === 'metas' && <SellerScoreboardTab />}
      {tab === 'escala' && <ScheduleTab />}
      {tab === 'resultado' && <StoreResultTab />}
      {tab === 'maisvendidos' && <TopProductsTab />}
      {tab === 'cartao' && <CardReceivablesTab />}
      {tab === 'clientes' && <PdvCustomersTab />}
      {tab === 'divergencia' && <ReconciliationTab />}
      {tab === 'estoque' && <NegativeStockTab />}
      {tab === 'reposicao' && <ReplenishmentTab />}
      {tab === 'transferencias' && <TransfersTab />}
      {tab === 'vendedores' && <SellersDirectoryTab />}
      {tab === 'equipe' && <ResponsiblesTab />}
      {tab === 'padroes' && <PatternsTab />}
      {tab === 'lojavirtual' && <OnlineReserveTab />}
      {tab === 'precificar' && <PricingTab />}
    </div>
  );
}

// ---- Ajuda inline: resumo do fluxo de cadastro de nota (ADR-083 E7) --------
// Guia completo em docs/GUIA-CADASTRAR-NOTAS.md; aqui vai a versão curta pra
// destravar o usuário sem tirar ele da tela de Precificar. Sem link externo:
// muita conta não tem acesso ao repo GitHub.
function PricingHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100 flex items-center gap-2"><Tag className="w-4 h-4 text-sky-300" /> Como cadastrar as notas de compra</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>

        <p className="mt-3 text-xs text-zinc-400">
          Cadastrar a nota é o que faz o app <strong>saber quanto cada produto custou</strong>. Depois disso, esta tela sai de "sem custo" e passa a mostrar o preço sugerido de verdade, e a aba <em>Resultado por loja</em> passa a usar o CMV real em vez da margem estimada.
        </p>

        <div className="mt-4 space-y-3 text-xs">
          <div>
            <div className="text-zinc-200 font-medium">1) Vá em Catálogo → Nota Fiscal</div>
            <div className="text-zinc-500">Botão no topo da tela do Catálogo. Abre o modal com dois caminhos: XML e Foto.</div>
          </div>

          <div>
            <div className="text-zinc-200 font-medium">2) Escolha o caminho</div>
            <ul className="mt-1 space-y-1.5 text-zinc-500">
              <li>
                <span className="text-emerald-300 font-medium">XML da NF-e (preferido)</span> — peça pro fornecedor o arquivo <code className="text-zinc-400">.xml</code>. Manda até 20 de uma vez, o app dedupe pela chave da nota (não deixa importar 2× a mesma).
              </li>
              <li>
                <span className="text-amber-300 font-medium">Foto</span> — só quando o fornecedor não te deu o XML. 1 por vez, IA lê os itens. iPhone: configure a câmera pra JPG (HEIC não é aceito). PDF: tire print/foto da tela.
              </li>
            </ul>
          </div>

          <div>
            <div className="text-zinc-200 font-medium">3) Revise o rascunho</div>
            <div className="text-zinc-500">Nada mexe no estoque ainda. Cada linha vira uma escolha:</div>
            <ul className="mt-1 space-y-0.5 text-zinc-500">
              <li>• <strong className="text-zinc-300">Criar</strong> — produto novo no catálogo.</li>
              <li>• <strong className="text-zinc-300">Repor</strong> — casa com produto existente, aumenta o estoque.</li>
              <li>• <strong className="text-zinc-300">Pular</strong> — ignora (útil pra frete/embalagem que às vezes vem como "item").</li>
            </ul>
          </div>

          <div>
            <div className="text-zinc-200 font-medium">4) Confirme</div>
            <div className="text-zinc-500">Só agora o custo médio do produto é recalculado, o estoque sobe e esta aba passa a ter sugestão pra ele. Voltar aqui e clicar <em>Recalcular</em> mostra tudo atualizado.</div>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-400">
          <strong className="text-zinc-300">Bom saber:</strong> o custo médio é da organização inteira (não por loja). Se você tem duas lojas comprando o mesmo produto por preços diferentes, o app usa a média ponderada — o CMV real das duas lojas fica igual, mas ainda muito melhor que o chute anterior.
        </div>

        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-3 py-1.5">Entendi</button>
        </div>
      </div>
    </div>
  );
}

// Painel expandível — edição inline dos custos da loja (fixos, variáveis e
// margem bruta) direto na aba Precificar, sem abrir o cadastro da loja.
// Reusa as MESMAS categorias (`STORE_COST_CATEGORIES`, `STORE_VARIABLE_COST_CATEGORIES`)
// e endpoints do StoreFormModal — nada duplicado no cliente nem no servidor.
// POS-002 (Fatia 3): configura a tarifa detalhada crédito/débito da loja.
function PosFeesConfig({ storeId }: { storeId: string }) {
  const [open, setOpen] = useState(false);
  const [credit, setCredit] = useState({ percent: '', fixed: '' });
  const [debit, setDebit] = useState({ percent: '', fixed: '' });
  const [has, setHas] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = () => { if (!storeId) return; apiFetch(`/api/retailops/stores/${storeId}/pos-fees`).then(r => r.ok ? r.json() : null).then(d => { if (!d) return; setHas(!!d.hasDetailed); setCredit({ percent: d.credit?.percent ? String(d.credit.percent) : '', fixed: d.credit?.fixedPerTransaction ? String(d.credit.fixedPerTransaction) : '' }); setDebit({ percent: d.debit?.percent ? String(d.debit.percent) : '', fixed: d.debit?.fixedPerTransaction ? String(d.debit.fixedPerTransaction) : '' }); }).catch(() => {}); };
  useEffect(() => { if (open && storeId) load(); /* eslint-disable-next-line */ }, [open, storeId]);
  const num = (s: string) => Number(String(s || '').replace(',', '.')) || 0;
  const save = async () => {
    setSaving(true);
    try {
      const body: any = {};
      body.credit = (credit.percent || credit.fixed) ? { percent: num(credit.percent), fixedPerTransaction: num(credit.fixed) } : null;
      body.debit = (debit.percent || debit.fixed) ? { percent: num(debit.percent), fixedPerTransaction: num(debit.fixed) } : null;
      const r = await apiFetch(`/api/retailops/stores/${storeId}/pos-fees`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha');
      toast.success('Tarifas do POS salvas.'); load();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  };
  const row = (label: string, v: { percent: string; fixed: string }, set: (x: any) => void) => (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-1">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <div className="flex items-center rounded bg-zinc-950 border border-zinc-800 px-1.5 w-16"><input inputMode="decimal" value={v.percent} onChange={e => set({ ...v, percent: e.target.value })} placeholder="0" className="w-full bg-transparent px-0.5 py-1 text-xs text-right text-zinc-100 outline-none" /><span className="text-[10px] text-zinc-600">%</span></div>
      <div className="flex items-center rounded bg-zinc-950 border border-zinc-800 px-1.5 w-20"><span className="text-[10px] text-zinc-600">R$</span><input inputMode="decimal" value={v.fixed} onChange={e => set({ ...v, fixed: e.target.value })} placeholder="0,00" className="w-full bg-transparent px-0.5 py-1 text-xs text-right text-zinc-100 outline-none" /></div>
    </div>
  );
  return (
    <div className="mt-2 border-t border-zinc-800/60 pt-2">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-400 hover:text-zinc-200">
        <CreditCard className="w-3 h-3" /> Tarifas do POS (crédito/débito) {has && <span className="rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-1 text-[9px] normal-case">detalhado</span>}
        {open ? <ChevronDown className="w-3 h-3 ml-auto" /> : <ChevronRight className="w-3 h-3 ml-auto" />}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {row('Crédito', credit, setCredit)}
          {row('Débito', debit, setDebit)}
          <p className="text-[9px] text-zinc-600">Quando preenchidas, substituem a “Taxa de cartão” agregada no custo esperado do fechamento — nunca somam as duas. Deixe em branco para voltar à agregada.</p>
          <button onClick={save} disabled={saving} className="rounded border border-indigo-500/30 px-2 py-0.5 text-[11px] text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50">{saving ? 'Salvando…' : 'Salvar tarifas'}</button>
        </div>
      )}
    </div>
  );
}

function StoreCostsInlinePanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState<string>('');
  const [margin, setMargin] = useState<string>('');
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [varCosts, setVarCosts] = useState<Record<string, { percent: string; fixed: string }>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState<number>(0);
  useEffect(() => {
    if (!open) return;
    apiFetch('/api/retailops/stores').then(r => r.json()).then(d => {
      const arr = Array.isArray(d?.stores) ? d.stores : (Array.isArray(d) ? d : []);
      const active = arr.filter((s: any) => s.active);
      setStores(active);
      if (!storeId && active[0]) setStoreId(active[0].id);
    }).catch(() => {});
    // eslint-disable-next-line
  }, [open]);
  useEffect(() => {
    if (!open || !storeId) return;
    setLoading(true);
    // SAVE-001: leitura COMPOSTA (margem + fixos + variáveis + versão) num só GET.
    apiFetch(`/api/retailops/stores/${storeId}/financial-settings`).then(r => r.ok ? r.json() : null).then((fs) => {
      if (!fs) return;
      const byF = fs.fixedCosts?.byCategory || {};
      const nextF: Record<string, string> = {};
      for (const c of STORE_COST_CATEGORIES) nextF[c.key] = byF[c.key] > 0 ? String(byF[c.key]) : '';
      setCosts(nextF);
      const byV = fs.variableCosts?.byCategory || {};
      const nextV: Record<string, { percent: string; fixed: string }> = {};
      for (const c of STORE_VARIABLE_COST_CATEGORIES) {
        const e = byV[c.key] || { percent: 0, fixedPerSale: 0 };
        nextV[c.key] = { percent: e.percent > 0 ? String(e.percent) : '', fixed: e.fixedPerSale > 0 ? String(e.fixedPerSale) : '' };
      }
      setVarCosts(nextV);
      setMargin(fs.grossMarginPercent != null ? String(fs.grossMarginPercent) : '');
      setVersion(Number(fs.version || 0));
    }).catch(() => {}).finally(() => setLoading(false));
    // eslint-disable-next-line
  }, [open, storeId]);
  const costsTotal = useMemo(
    () => STORE_COST_CATEGORIES.reduce((a, c) => a + (Number(String(costs[c.key] || '').replace(',', '.')) || 0), 0),
    [costs]
  );
  const varTotals = useMemo(() => {
    let pct = 0, fix = 0;
    for (const c of STORE_VARIABLE_COST_CATEGORIES) {
      const e = varCosts[c.key] || { percent: '', fixed: '' };
      pct += Number(String(e.percent || '').replace(',', '.')) || 0;
      fix += Number(String(e.fixed || '').replace(',', '.')) || 0;
    }
    return { pct, fix };
  }, [varCosts]);
  const save = async () => {
    if (!storeId) return;
    setSaving(true);
    try {
      // SAVE-001/002/003: PUT ATÔMICO (margem + fixos + variáveis) com versão.
      const costsPayload: Record<string, number> = {};
      for (const c of STORE_COST_CATEGORIES) costsPayload[c.key] = Number(String(costs[c.key] || '').replace(',', '.')) || 0;
      const varPayload: Record<string, { percent: number; fixedPerSale: number }> = {};
      for (const c of STORE_VARIABLE_COST_CATEGORIES) {
        const e = varCosts[c.key] || { percent: '', fixed: '' };
        varPayload[c.key] = { percent: Number(String(e.percent || '').replace(',', '.')) || 0, fixedPerSale: Number(String(e.fixed || '').replace(',', '.')) || 0 };
      }
      const res = await apiFetch(`/api/retailops/stores/${storeId}/financial-settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grossMarginPercent: margin.trim() === '' ? null : Number(margin.replace(',', '.')), fixedCosts: costsPayload, variableCosts: varPayload, expectedVersion: version }),
      });
      const d = await res.json().catch(() => ({}));
      // SAVE-002/004: sucesso só com resposta OK; conflito 409 e erros acionáveis.
      if (res.status === 409) { setVersion(Number(d.currentVersion ?? version)); toast.error('Outra pessoa alterou esta loja. Recarregue e revise antes de salvar.'); return; }
      if (res.status === 403) { toast.error('Você não tem permissão para alterar os custos desta loja.'); return; }
      if (!res.ok) { toast.error(d.error === 'Margem bruta inválida (0 a 100).' ? d.error : 'Não foi possível salvar — nada foi alterado. Tente de novo.'); return; }
      setVersion(Number(d.version ?? version + 1)); // releitura da versão salva
      toast.success('Custos da loja atualizados.');
    } catch { toast.error('Sem resposta do servidor — nada foi salvo. Tente de novo.'); }
    finally { setSaving(false); }
  };
  if (!open) {
    return (
      <div className="mb-3">
        <button onClick={onToggle} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          <ChevronRight className="w-3.5 h-3.5" /> Custos da loja (fixos + variáveis + margem)
        </button>
      </div>
    );
  }
  return (
    <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <button onClick={onToggle} className="text-zinc-500 hover:text-zinc-300"><ChevronDown className="w-4 h-4" /></button>
        <span className="text-sm font-medium text-zinc-200">Custos da loja</span>
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="ml-auto bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100">
          {stores.length === 0 && <option value="">Sem lojas cadastradas</option>}
          {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` · ${s.code}` : ''}</option>)}
        </select>
        <button onClick={save} disabled={saving || !storeId} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Salvar
        </button>
      </div>
      <p className="mb-3 text-[11px] text-zinc-500">Editar aqui é o mesmo que editar em "Fechamento diário → editar loja" — a apuração de Resultado por Loja, ponto de equilíbrio e a sugestão de preço passam a valer com os novos números.</p>
      {loading ? (
        <div className="py-4 text-center text-xs text-zinc-500"><Loader2 className="inline w-4 h-4 animate-spin" /> Carregando…</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {/* Fixos */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Fixos (mês)</span>
              <span className="text-[10px] text-zinc-500">total {brl(costsTotal)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {STORE_COST_CATEGORIES.map(c => (
                <label key={c.key} className="text-[10px] text-zinc-500">{c.label}
                  <div className="mt-0.5 flex items-center rounded bg-zinc-950 border border-zinc-800 px-2">
                    <span className="text-[10px] text-zinc-600">R$</span>
                    <input inputMode="decimal" value={costs[c.key] || ''} onChange={e => setCosts(p => ({ ...p, [c.key]: e.target.value }))}
                      placeholder="0,00" className="w-full bg-transparent px-1.5 py-1 text-xs text-zinc-100 outline-none" />
                  </div>
                </label>
              ))}
            </div>
          </div>
          {/* Variáveis */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Variáveis (por venda)</span>
              <span className="text-[10px] text-zinc-500">soma {varTotals.pct.toFixed(2)}% + R$ {varTotals.fix.toFixed(2)}</span>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {STORE_VARIABLE_COST_CATEGORIES.map(c => (
                <div key={c.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-1">
                  <span className="text-[10px] text-zinc-500" title={c.hint}>{c.label}</span>
                  <div className="flex items-center rounded bg-zinc-950 border border-zinc-800 px-1.5 w-16">
                    <input inputMode="decimal" value={varCosts[c.key]?.percent || ''} onChange={e => setVarCosts(p => ({ ...p, [c.key]: { ...(p[c.key] || { fixed: '' }), percent: e.target.value } }))}
                      placeholder="0" className="w-full bg-transparent px-0.5 py-1 text-xs text-right text-zinc-100 outline-none" />
                    <span className="text-[10px] text-zinc-600">%</span>
                  </div>
                  <div className="flex items-center rounded bg-zinc-950 border border-zinc-800 px-1.5 w-20">
                    <span className="text-[10px] text-zinc-600">R$</span>
                    <input inputMode="decimal" value={varCosts[c.key]?.fixed || ''} onChange={e => setVarCosts(p => ({ ...p, [c.key]: { ...(p[c.key] || { percent: '' }), fixed: e.target.value } }))}
                      placeholder="0,00" className="w-full bg-transparent px-0.5 py-1 text-xs text-right text-zinc-100 outline-none" />
                  </div>
                </div>
              ))}
            </div>
            {/* POS-002 (Fatia 3): tarifas detalhadas crédito/débito (substituem a
                taxa agregada acima no custo esperado — nunca somam) */}
            <PosFeesConfig storeId={storeId} />
          </div>
          {/* Margem + resumo */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Margem bruta</div>
            <label className="text-[10px] text-zinc-500">Margem bruta média (%)
              <input inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value)}
                placeholder="Ex.: 55" className="mt-0.5 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-100" />
            </label>
            <p className="mt-2 text-[10px] text-zinc-600">Sobra de cada R$ 100 depois de pagar a mercadoria — não inclui os fixos/variáveis acima. Sem margem, o app não calcula o lucro por loja.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Precificar (ADR-083 E7): revisar/simular markup e aplicar em lote -----
function PricingTab() {
  const [markup, setMarkup] = useState<string>('');
  const [filter, setFilter] = useState<'all' | 'risk' | 'no_cost'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showCosts, setShowCosts] = useState(false);
  const [applyResult, setApplyResult] = useState<any>(null); // PERF-008: resultado detalhado do último lote
  // markup é aplicado pelo botão (não auto-reload) — urlFactory lê o valor atual.
  const { data, status, corr, loading, isStale, loadedAt, reload: load } =
    useAnalytics(() => `/api/retailops/pricing/products${markup ? `?markup=${encodeURIComponent(markup)}` : ''}`, []);
  const showData = status === 'ok' || isStale;

  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const filtered = items.filter((it) => {
    if (filter === 'risk') return it.riskLevel === 'loss' || it.riskLevel === 'thin';
    if (filter === 'no_cost') return !it.hasCost;
    return true;
  });
  const withCost = filtered.filter((it) => it.hasCost);
  const allChecked = withCost.length > 0 && withCost.every((it) => selected.has(it.productId));

  const toggleAll = () => {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(withCost.map((it) => it.productId)));
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  // PERF-008: a aplicação em lote só declara SUCESSO pelos itens confirmados
  // (`applied`) e mantém os que FALHARAM (`failed`, transitórios) selecionados
  // para nova tentativa. Rejeições determinísticas (`skipped`: sem mudança,
  // inválido, não encontrado) saem da seleção — repetir não muda o resultado.
  const doApply = async (chosen: any[]) => {
    if (chosen.length === 0) { toast.error('Nenhum produto selecionado com sugestão diferente do preço atual.'); return; }
    setSaving(true);
    try {
      const body = JSON.stringify({ items: chosen.map((it) => ({ productId: it.productId, newPrice: it.suggestedPrice })) });
      const res = await apiFetch('/api/retailops/pricing/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(out?.error || 'Falha ao aplicar preços.'); return; }
      setApplyResult(out);
      // Só o que FALHOU segue selecionado (para retry); confirmados e rejeições
      // determinísticas saem da seleção.
      const failedIds = new Set((out.failed || []).map((f: any) => f.productId));
      setSelected(new Set(chosen.map((it) => it.productId).filter((id) => failedIds.has(id))));
      if (out.appliedCount > 0) toast.success(`${out.appliedCount} preço(s) aplicado(s).`);
      if (out.failedCount > 0) toast.error(`${out.failedCount} não aplicado(s) por falha temporária — dá pra tentar de novo.`);
      else if (out.appliedCount === 0) toast.error('Nada aplicado (itens sem mudança ou inválidos).');
      load();
    } finally { setSaving(false); }
  };
  const applySuggested = async () => {
    const chosen = withCost.filter((it) => selected.has(it.productId) && Math.abs(it.suggestedPrice - it.currentPrice) >= 0.01);
    if (chosen.length === 0) { toast.error('Nenhum produto selecionado com sugestão diferente do preço atual.'); return; }
    if (!window.confirm(`Aplicar o preço sugerido em ${chosen.length} ${chosen.length === 1 ? 'produto' : 'produtos'}? Isso muda o preço no catálogo — os pedidos abertos não são refeitos.`)) return;
    await doApply(chosen);
  };
  const retryFailed = async () => {
    const failedIds = new Set((applyResult?.failed || []).map((f: any) => f.productId));
    const chosen = withCost.filter((it) => failedIds.has(it.productId) && Math.abs(it.suggestedPrice - it.currentPrice) >= 0.01);
    if (chosen.length === 0) { toast.error('Nada para tentar de novo.'); return; }
    await doApply(chosen);
  };

  const nLoss = items.filter((it) => it.riskLevel === 'loss').length;
  const nThin = items.filter((it) => it.riskLevel === 'thin').length;
  const nNoCost = items.filter((it) => !it.hasCost).length;

  return (
    <div>
      <div className="mb-4">
        <p className="text-sm text-zinc-300">Revê o preço dos produtos usando o <strong>custo real</strong> das notas de compra (avg_cost). Ajuste o markup pra simular; aplique só nos que fizerem sentido.</p>
        <p className="text-[11px] text-zinc-500">
          Produtos sem custo cadastrado só ganham sugestão quando você registrar a nota de entrada (XML/foto no <em>Catálogo → Nota Fiscal</em>).{' '}
          <button onClick={() => setShowHelp(true)} className="text-sky-400 hover:text-sky-300 underline underline-offset-2">Como cadastrar as notas?</button>
        </p>
      </div>

      {showHelp && <PricingHelpModal onClose={() => setShowHelp(false)} />}

      {/* Painel expandível de custos da loja — evita sair da tela pra
          ajustar aluguel/energia/margem/taxa de cartão etc. Sem duplicar
          categorias: reusa STORE_COST_CATEGORIES e STORE_VARIABLE_COST_CATEGORIES. */}
      <StoreCostsInlinePanel open={showCosts} onToggle={() => setShowCosts(v => !v)} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            Markup para simular
            <div className="flex items-center rounded-lg bg-zinc-950 border border-zinc-800 px-2 w-24">
              <input inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
                placeholder={String(data?.defaultMarkup ?? 40)}
                className="w-full bg-transparent px-1 py-1 text-sm text-zinc-100 outline-none" />
              <span className="text-[11px] text-zinc-600">%</span>
            </div>
          </label>
          <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Recalcular
          </button>
        </div>
        <div className="inline-flex rounded-lg border border-zinc-800 overflow-hidden">
          {[
            { k: 'all', label: `Todos (${items.length})` },
            { k: 'risk', label: `Risco (${nLoss + nThin})` },
            { k: 'no_cost', label: `Sem custo (${nNoCost})` },
          ].map((o) => (
            <button key={o.k} onClick={() => setFilter(o.k as any)}
              className={`px-2.5 py-1 text-xs ${filter === o.k ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {(nLoss > 0 || nThin > 0) && (
        <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          {nLoss > 0 && <><strong>{nLoss}</strong> {nLoss === 1 ? 'produto está sendo vendido' : 'produtos estão sendo vendidos'} <strong>abaixo do custo</strong>. </>}
          {nThin > 0 && <><strong>{nThin}</strong> com margem magra (&lt; 10%) — qualquer imposto/taxa da maquininha vira prejuízo.</>}
        </p>
      )}

      {loading && !isStale && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>}

      {isStale && <StaleNotice status={status} onRetry={load} loadedAt={loadedAt} correlationId={corr} />}
      {!showData && !loading && <AnalyticsBanner status={status} onRetry={load} correlationId={corr} />}

      {showData && filtered.length === 0 && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">Nenhum produto no filtro atual.</p>
      )}

      {showData && filtered.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400">
                <tr className="text-left">
                  <th className="px-2 py-2 w-8">
                    <input type="checkbox" checked={allChecked} onChange={toggleAll} title="Marcar/desmarcar todos com custo" />
                  </th>
                  <th className="px-3 py-2 font-medium">Produto</th>
                  <th className="px-3 py-2 font-medium text-right">Custo médio</th>
                  <th className="px-3 py-2 font-medium text-right">Preço atual</th>
                  <th className="px-3 py-2 font-medium text-right">Margem</th>
                  <th className="px-3 py-2 font-medium text-right">Sugerido</th>
                  <th className="px-3 py-2 font-medium text-right" title="Faturamento do produto no mês">Venda no mês</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((it) => {
                  const diff = it.suggestedPrice - it.currentPrice;
                  const diffColor = diff > 0.005 ? 'text-emerald-300' : diff < -0.005 ? 'text-red-300' : 'text-zinc-500';
                  return (
                    <tr key={it.productId} className="border-t border-zinc-800/70">
                      <td className="px-2 py-2">
                        <input type="checkbox" disabled={!it.hasCost} checked={selected.has(it.productId)} onChange={() => toggleOne(it.productId)} />
                      </td>
                      <td className="px-3 py-2 text-zinc-200">
                        <div className="flex items-center gap-1.5">
                          <span>{it.name}</span>
                          {it.riskLevel === 'loss' && <span className="text-[9px] rounded-full bg-red-500/15 text-red-300 border border-red-500/30 px-1.5" title="Preço abaixo do custo">perda</span>}
                          {it.riskLevel === 'thin' && <span className="text-[9px] rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5" title="Margem menor que 10%">magra</span>}
                          {!it.hasCost && <span className="text-[9px] rounded-full bg-zinc-800 text-zinc-500 border border-zinc-700 px-1.5" title="Cadastre a nota de compra para o app saber o custo">sem custo</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-300">{it.hasCost ? brl(it.avgCost) : <span className="text-zinc-600">—</span>}</td>
                      <td className="px-3 py-2 text-right text-zinc-300">{brl(it.currentPrice)}</td>
                      <td className="px-3 py-2 text-right">
                        {it.marginPercent == null ? <span className="text-zinc-600">—</span> : (
                          <span className={it.riskLevel === 'loss' ? 'text-red-300' : it.riskLevel === 'thin' ? 'text-amber-300' : 'text-emerald-300'}>
                            {it.marginPercent.toFixed(1).replace('.', ',')}%
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {it.hasCost ? (
                          <span className="inline-flex items-center gap-1.5 justify-end">
                            <span className="text-zinc-100 font-medium">{brl(it.suggestedPrice)}</span>
                            <span className={`text-[10px] ${diffColor}`}>
                              {diff > 0 ? '+' : ''}{brl(diff)}
                            </span>
                          </span>
                        ) : <span className="text-zinc-600">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-400">{it.revenueMonth > 0 ? brl(it.revenueMonth) : <span className="text-zinc-600">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {applyResult && (() => {
            const reasons: Record<string, string> = { unchanged: 'sem mudança', not_found: 'não encontrado', invalid_price: 'preço inválido', missing_id: 'sem identificação' };
            const byReason = (applyResult.skipped || []).reduce((m: Record<string, number>, s: any) => { m[s.reason] = (m[s.reason] || 0) + 1; return m; }, {});
            const skipText = Object.entries(byReason).map(([r, n]) => `${n} ${reasons[r] || r}`).join(' · ');
            const hasFailed = (applyResult.failedCount || 0) > 0;
            return (
              <div className={`mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[12px] ${hasFailed ? 'border-red-500/30 bg-red-500/5 text-red-200' : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200'}`}>
                {hasFailed ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
                <span className="flex-1">
                  <strong>{applyResult.appliedCount}</strong> aplicado(s){applyResult.skippedCount ? ` · ${skipText} (não repetir)` : ''}{hasFailed ? ` · ${applyResult.failedCount} falharam por erro temporário` : ''}.
                </span>
                {hasFailed && <button onClick={retryFailed} disabled={saving} className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-0.5 hover:bg-white/5 disabled:opacity-50"><RefreshCw className="w-3.5 h-3.5" /> Tentar de novo ({applyResult.failedCount})</button>}
                <button onClick={() => setApplyResult(null)} className="text-current/70 hover:text-current"><X className="w-3.5 h-3.5" /></button>
              </div>
            );
          })()}

          <div className="mt-3 flex items-center justify-between">
            <p className="text-[11px] text-zinc-500">
              Sugestão via <code>suggestSalePrice(custo × (1 + markup%))</code> com arredondamento psicológico (termina em ,99).
              Custo médio: quando você registra uma nota, ele é <strong>recalculado</strong> junto com o estoque.
            </p>
            <button onClick={applySuggested} disabled={saving || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Aplicar sugerido nos selecionados ({selected.size})
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Loja virtual → PDV: baixas pendentes (ADR-143 Fase 0) -------------------
function OnlineReserveTab() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [onlineStoreId, setOnlineStoreId] = useState<string>('');
  const [defaultSeller, setDefaultSeller] = useState<string>('');
  const [users, setUsers] = useState<any[]>([]);
  const [stores, setStores] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [reserves, setReserves] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [fStore, setFStore] = useState('');
  const [fProduct, setFProduct] = useState('');
  const [fQty, setFQty] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [d, st, pr] = await Promise.all([
        apiFetch('/api/retailops/online-reserve').then(r => r.json()).catch(() => ({})),
        apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({})),
        apiFetch('/api/products').then(r => r.json()).catch(() => ([])),
      ]);
      setEnabled(!!d?.enabled);
      setOnlineStoreId(d?.onlineStoreId || '');
      setDefaultSeller(d?.defaultSellerUserId || '');
      setUsers(Array.isArray(d?.users) ? d.users : []);
      setReserves(Array.isArray(d?.reserves) ? d.reserves : []);
      setPending(Array.isArray(d?.pending) ? d.pending : []);
      const sts = Array.isArray(st?.stores) ? st.stores : (Array.isArray(st) ? st : []);
      setStores(sts);
      setProducts(Array.isArray(pr) ? pr.filter((p: any) => p.type === 'product') : []);
      setFStore(prev => prev || d?.onlineStoreId || (sts[0]?.id ?? ''));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const saveReserve = async () => {
    if (!fStore || !fProduct || fQty === '') { toast.error('Escolha loja, produto e quantidade.'); return; }
    const res = await apiFetch('/api/retailops/online-reserve/item', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: fStore, productId: fProduct, qty: Number(fQty) }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast.success('Reserva salva.'); setFProduct(''); setFQty(''); load(); }
    else toast.error(d.error || 'Falha ao salvar a reserva.');
  };
  const removeReserve = async (r: any) => {
    const res = await apiFetch('/api/retailops/online-reserve/item', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: r.store_id, productId: r.product_service_id, variantId: r.variant_id || null }) });
    if (res.ok) { toast.success('Reserva removida.'); load(); }
    else toast.error('Falha ao remover.');
  };

  const saveFlag = async (patch: { enabled?: boolean; onlineStoreId?: string }) => {
    const body = { enabled: patch.enabled ?? enabled, onlineStoreId: patch.onlineStoreId ?? onlineStoreId };
    const res = await apiFetch('/api/retailops/online-reserve/flag', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setEnabled(!!d.enabled); setOnlineStoreId(d.onlineStoreId || ''); toast.success('Configuração salva.'); }
    else toast.error(d.error || 'Falha ao alterar.');
  };
  const toggle = () => saveFlag({ enabled: !enabled });
  const saveDefaultSeller = async (userId: string) => {
    setDefaultSeller(userId);
    const res = await apiFetch('/api/retailops/online-reserve/default-seller', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: userId || null }) });
    if (res.ok) toast.success('Vendedor padrão salvo.'); else toast.error('Falha ao salvar.');
  };
  const confirm = async (row: any) => {
    const res = await apiFetch('/api/retailops/online-reserve/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast.success('Baixa confirmada — lançada no PDV.'); setPending(Array.isArray(d.pending) ? d.pending : pending.filter(p => p.id !== row.id)); load(); }
    else toast.error(d.error || 'Falha ao confirmar.');
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <p className="text-sm text-zinc-400 max-w-2xl">A loja virtual vende de uma reserva por loja (sem vender o que não tem). Cada venda online gera uma <b>baixa a lançar no PDV</b> — confirme aqui depois de lançar, para o estoque não descontar duas vezes.</p>
        <button onClick={toggle} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${enabled ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>
          <span className={`inline-block w-2 h-2 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-zinc-600'}`} /> {enabled ? 'ligada' : 'desligada'}
        </button>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
        <label className="text-xs text-zinc-400">Filial da loja virtual (de qual loja o estoque online sai):</label>
        <select value={onlineStoreId} onChange={e => saveFlag({ onlineStoreId: e.target.value })} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          <option value="">— não aplicar reserva no checkout —</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>)}
        </select>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm flex-wrap">
        <label className="text-xs text-zinc-400" title="Quando o cliente compra pelo link mas a conversa não tem atendente dono, a comissão vai para este vendedor. Em branco = venda 100% IA fica sem comissão.">Vendedor padrão da loja online (vendas 100% IA):</label>
        <select value={defaultSeller} onChange={e => saveDefaultSeller(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          <option value="">— sem comissão (a IA vendeu) —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
        </select>
      </div>

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-2">Baixas pendentes no PDV ({pending.length})</h3>
      {pending.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">Nenhuma baixa pendente. Vendas online aparecem aqui para você lançar no PDV.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Loja</th>
              <th className="px-3 py-2 text-left font-medium">Produto</th>
              <th className="px-3 py-2 text-right font-medium">Qtd</th>
              <th className="px-3 py-2 text-left font-medium">Pedido</th>
              <th className="px-3 py-2 text-right font-medium">Ação</th>
            </tr></thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id} className="border-t border-zinc-800/60">
                  <td className="px-3 py-2 text-zinc-300">{p.store_name || p.store_id}</td>
                  <td className="px-3 py-2 text-zinc-200">{p.product_name || p.product_service_id}</td>
                  <td className="px-3 py-2 text-right text-zinc-200">{p.qty}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-zinc-500">{String(p.order_id).slice(0, 8)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => confirm(p)} className="inline-flex items-center gap-1 rounded border border-emerald-500/30 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-500/10"><Check className="w-3 h-3" /> Lancei no PDV</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mt-6 mb-2">Reserva e-commerce por loja ({reserves.length})</h3>
      <p className="text-[12px] text-zinc-500 mb-2">Defina quanto de cada produto a loja virtual pode vender por loja. É deste número (menos as vendas ainda não lançadas no PDV) que sai o estoque online.</p>

      <div className="mb-3 flex items-end gap-2 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <label className="text-[11px] text-zinc-400 flex flex-col gap-1">Loja
          <select value={fStore} onChange={e => setFStore(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 min-w-[140px]">
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400 flex flex-col gap-1">Produto
          <select value={fProduct} onChange={e => setFProduct(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 min-w-[200px]">
            <option value="">— escolher —</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-zinc-400 flex flex-col gap-1">Reservar
          <input type="number" min={0} value={fQty} onChange={e => setFQty(e.target.value)} placeholder="0" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 w-24" />
        </label>
        <button onClick={saveReserve} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><Plus className="w-4 h-4" /> Salvar reserva</button>
      </div>

      {reserves.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-[12px] text-zinc-600">Nenhuma reserva definida ainda. Use o formulário acima para liberar produtos na loja virtual.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Loja</th>
              <th className="px-3 py-2 text-left font-medium">Produto</th>
              <th className="px-3 py-2 text-right font-medium">Reservado</th>
              <th className="px-3 py-2 text-right font-medium">Disponível online</th>
              <th className="px-3 py-2 text-right font-medium"></th>
            </tr></thead>
            <tbody>
              {reserves.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800/60">
                  <td className="px-3 py-2 text-zinc-300">{r.store_name || String(r.store_id).slice(0, 8)}</td>
                  <td className="px-3 py-2 text-zinc-200">{r.product_name || String(r.product_service_id).slice(0, 8)}</td>
                  <td className="px-3 py-2 text-right text-zinc-200">{r.qty_reserved}</td>
                  <td className={`px-3 py-2 text-right ${Number(r.available) <= 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{r.available}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => removeReserve(r)} title="Remover reserva" className="inline-flex items-center rounded border border-red-500/30 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/10"><Trash2 className="w-3 h-3" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Fechamento diário ------------------------------------------------------
// Fase C3 — Boletas em tempo real: o talão manuscrito continua, mas a cada
// venda alguém clica no botão e o servidor grava o nº sequencial + a HORA
// real. À noite, o fechamento confere o range com os cliques, e o PDV
// (lançado à noite) casa valor/vendedor com cada boleta pelo número.
function BoletaPanel({ stores }: { stores: any[] }) {
  const [storeId, setStoreId] = useState('');
  // BOL-001/TIME-003: o DIA vem do servidor (data comercial no fuso da org), nunca
  // do "hoje" UTC do navegador — por isso não guardamos mais `todayStr()` aqui.
  const [report, setReport] = useState<any | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [initial, setInitial] = useState('');
  const [clicking, setClicking] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => { if (stores.length && !storeId) setStoreId(stores.find((s: any) => s.active)?.id || stores[0].id); /* eslint-disable-next-line */ }, [stores]);
  const load = async () => {
    if (!storeId) return;
    const d = await apiFetch(`/api/retailops/boletas/day?storeId=${storeId}`).then(r => r.json()).catch(() => null);
    if (d && !d.error) { setReport(d); setLastLoadedAt(d.serverTimestamp || new Date().toISOString()); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [storeId]);

  const openDay = async () => {
    const res = await apiFetch('/api/retailops/boletas/day/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, initialNumber: initial }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast.success(`Dia aberto — 1ª boleta Nº ${d.initial_number}.`); setInitial(''); load(); }
    else toast.error(d.error || 'Falha ao abrir o dia.');
  };
  const click = async () => {
    setClicking(true);
    // BOL-002: chave gerada no dispositivo — retry/resposta perdida devolvem o
    // MESMO evento (não duplica boleta). BOL-003: só confirma com a resposta.
    const idempotencyKey = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
    try {
      const res = await apiFetch('/api/retailops/boletas/click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, idempotencyKey }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`${d.deduped ? 'Já registrada' : 'Venda registrada'} — boleta Nº ${d.boleta_number} · ${new Date(d.clicked_at + 'Z').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`); load(); }
      else toast.error(d.error || 'Falha ao registrar — tente de novo (nada foi contado).');
    } catch { toast.error('Sem resposta do servidor — tente de novo (nada foi contado).'); }
    finally { setClicking(false); }
  };
  const [history, setHistory] = useState<any[] | null>(null);
  const loadHistory = () => { if (!storeId) return; apiFetch(`/api/retailops/boletas/history?storeId=${storeId}&limit=7`).then(r => r.json()).then(d => setHistory(Array.isArray(d?.history) ? d.history : [])).catch(() => setHistory([])); };
  useEffect(() => { if (open && storeId) loadHistory(); /* eslint-disable-next-line */ }, [open, storeId]);
  const undo = async () => {
    const last = report?.clicks?.[report.clicks.length - 1];
    if (!last) return;
    if (!window.confirm(`Desfazer o registro da boleta Nº ${last.number}?`)) return;
    const res = await apiFetch(`/api/retailops/boletas/click/${last.id}/cancel`, { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast.success('Registro desfeito — o número volta pra sequência.'); load(); }
    else toast.error(d.error || 'Falha ao desfazer.');
  };
  const hora = (ts: string) => { try { return new Date(String(ts) + 'Z').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); } catch { return ts; } };

  if (!stores.length) return null;
  return (
    <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><CalendarDays className="w-4 h-4 text-amber-400" /> Boletas de hoje (hora real da venda)</div>
        {report?.businessDate && <span className="text-[11px] text-amber-300/80">dia {new Date(report.businessDate + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>}
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100">
          {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {lastLoadedAt && <button onClick={load} title="Recarregar" className="text-[10px] text-zinc-500 hover:text-zinc-300">↻ {new Date(lastLoadedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</button>}
        {report?.initialNumber && (
          <span className="text-[11px] text-zinc-400">1ª boleta <strong className="text-zinc-200">{report.initialNumber}</strong> · registradas <strong className="text-zinc-200">{report.count}</strong>{report.lastNumber ? <> · última <strong className="text-zinc-200">{report.lastNumber}</strong></> : null}</span>
        )}
        <button onClick={() => setOpen(o => !o)} className="ml-auto text-[11px] text-indigo-300 hover:text-indigo-200">{open ? '▾ esconder' : '▸ detalhes'}</button>
      </div>

      {!report?.initialNumber ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-400">Abra o dia informando o nº da 1ª boleta do talão:</span>
          <input inputMode="numeric" value={initial} onChange={e => setInitial(e.target.value.replace(/[^0-9]/g, ''))} placeholder="017752" className="w-28 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
          <button onClick={openDay} disabled={!initial} className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">Abrir o dia</button>
          <span className="text-[10px] text-zinc-500">A cada venda, clique no botão — a hora do clique vira a hora da venda.</span>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button onClick={click} disabled={clicking} className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-base font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {clicking ? <Loader2 className="w-5 h-5 animate-spin" /> : <Plus className="w-5 h-5" />} Registrar venda — Nº {report.nextNumber}
          </button>
          {report.count > 0 && <button onClick={undo} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">Desfazer último</button>}
          {report.pdvMatch?.matched > 0 && <span className="text-[11px] text-emerald-300">{report.pdvMatch.matched} boleta(s) já casada(s) com o PDV · {brl(report.pdvMatch.valorTotal)}</span>}
        </div>
      )}

      {open && report?.clicks?.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr><th className="px-3 py-1.5 text-left font-medium">Nº</th><th className="px-3 py-1.5 text-left font-medium">Hora</th><th className="px-3 py-1.5 text-left font-medium">Vendedor</th><th className="px-3 py-1.5 text-right font-medium">PDV (valor)</th><th className="px-3 py-1.5 text-right font-medium">Peças</th></tr>
            </thead>
            <tbody>
              {report.clicks.map((c: any) => (
                <tr key={c.id} className="border-t border-zinc-800/60">
                  <td className="px-3 py-1.5 text-zinc-200">{c.number}</td>
                  <td className="px-3 py-1.5 text-zinc-300">{hora(c.clickedAt)}</td>
                  <td className="px-3 py-1.5 text-zinc-400">{c.pdv?.sellerName || c.sellerName || '—'}</td>
                  <td className="px-3 py-1.5 text-right">{c.pdv ? <span className="text-emerald-300">{brl(c.pdv.valor)}</span> : <span className="text-zinc-600" title="Casa automaticamente quando o PDV do dia for lançado/sincronizado">aguardando PDV</span>}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">{c.pdv ? c.pdv.pecas : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* BOL-005: últimos 7 dias (leitura) — confirma que a contagem não some */}
      {open && history && history.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Últimos dias</div>
          <div className="flex flex-wrap gap-1.5">
            {history.map((h: any) => (
              <span key={h.day} title={`${h.firstNumber || '—'} → ${h.lastNumber || '—'}${h.cancelledCount ? ` · ${h.cancelledCount} cancelada(s)` : ''}`}
                className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[11px] text-zinc-300">
                {new Date(h.day + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} · <strong className="text-zinc-100">{h.count}</strong>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClosingsTab() {
  const [date, setDate] = useState(todayStr());
  const [stores, setStores] = useState<any[]>([]);
  const [closings, setClosings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [informing, setInforming] = useState<any | null>(null);
  const [storeModal, setStoreModal] = useState<null | { store: any | null }>(null);
  const [bridge, setBridge] = useState<boolean | null>(null);

  const toggleBridge = async () => {
    const next = !bridge;
    const res = await apiFetch('/api/retailops/revenue-bridge', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setBridge(!!d.enabled); toast.success(d.enabled ? 'Faturamento das lojas agora conta no Diretor/Caixa.' : 'Ponte de faturamento desligada.'); }
    else toast.error(d.error || 'Falha ao alterar a ponte de faturamento.');
  };

  const toggleActive = async (s: any) => {
    const res = await apiFetch(`/api/retailops/stores/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !s.active }) });
    if (res.ok) { toast.success(s.active ? 'Loja desativada.' : 'Loja reativada.'); load(); }
    else toast.error('Falha ao atualizar a loja.');
  };

  const load = async () => {
    setLoading(true);
    try {
      const [st, cl, br] = await Promise.all([
        apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({})),
        apiFetch(`/api/retailops/closings?date=${date}`).then(r => r.json()).catch(() => ({})),
        apiFetch('/api/retailops/revenue-bridge').then(r => r.json()).catch(() => ({})),
      ]);
      setStores(Array.isArray(st?.stores) ? st.stores : (Array.isArray(st) ? st : []));
      setClosings(Array.isArray(cl?.closings) ? cl.closings : (Array.isArray(cl) ? cl : []));
      setBridge(!!br?.enabled);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const byStore = useMemo(() => { const m: Record<string, any> = {}; for (const c of closings) m[c.store_id] = c; return m; }, [closings]);

  const openInform = async (store: any) => {
    // Garante o fechamento do dia (getOrCreate) e abre o formulário.
    const res = await apiFetch('/api/retailops/closings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: store.id, closingDate: date }) });
    const c = await res.json().catch(() => ({}));
    if (res.ok) setInforming({ ...c, store_name: store.name });
    else toast.error(c.error || 'Não foi possível abrir o fechamento.');
  };
  const setStatus = async (c: any, action: 'approve' | 'reject') => {
    const res = await apiFetch(`/api/retailops/closings/${c.id}/${action}`, { method: 'POST' });
    if (res.ok) { toast.success(action === 'approve' ? 'Fechamento aprovado.' : 'Fechamento rejeitado.'); load(); }
    else toast.error('Falha ao atualizar o fechamento.');
  };
  // CLOSE-003: apaga um fechamento errado (status/informado) E a cota do dia
  // dessa loja — a coluna Cota da tela vem do snapshot do fechamento.
  const removeClosing = async (c: any, storeName: string) => {
    if (!window.confirm(`Excluir o fechamento de "${storeName}" no dia ${date.split('-').reverse().join('/')}?\n\nApaga o status/informado E a cota do dia desta loja. Use pra limpar um lançamento errado.`)) return;
    const res = await apiFetch(`/api/retailops/closings/${c.id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Fechamento excluído.'); load(); }
    else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao excluir o fechamento.'); }
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <label className="text-xs text-zinc-400">Data
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        </label>
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        <button
          onClick={async () => {
            const res = await apiFetch('/api/retailops/quotas/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, apply: true }) });
            const d = await res.json().catch(() => ({}));
            if (res.ok) { toast.success(d.suggestions?.length ? `Cotas sugeridas pelo PDV aplicadas a ${d.suggestions.length} loja(s).` : 'Sem histórico do PDV suficiente para sugerir cotas ainda.'); load(); }
            else toast.error(d.error || 'Falha ao sugerir cotas.');
          }}
          title="Calcula a cota de cada loja pela média do MESMO dia da semana nas últimas 8 semanas (vendas reais do PDV via Alterdata) e aplica na data selecionada."
          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/20"
        >
          Sugerir cotas (PDV)
        </button>
        {bridge !== null && (
          <button
            onClick={toggleBridge}
            title={bridge
              ? 'Ligado: os fechamentos aprovados/conciliados contam como faturamento no Diretor IA / Caixa / DRE. Clique para desligar.'
              : 'Desligado: o faturamento das lojas fica só na Operação da Rede. Clique para o Diretor IA / Caixa enxergarem a receita.'}
            className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs ${bridge ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}
          >
            <span className={`inline-block w-2 h-2 rounded-full ${bridge ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            Faturamento no Diretor {bridge ? 'ligado' : 'desligado'}
          </button>
        )}
        <button onClick={() => setStoreModal({ store: null })} className={`inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 ${bridge === null ? 'ml-auto' : ''}`}><Plus className="w-4 h-4" /> Nova loja</button>
      </div>

      <WhoIsOffCard className="mb-3" />
      <BoletaPanel stores={stores.filter((s: any) => s.active)} />

      {stores.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center">
          <p className="text-sm text-zinc-500">Nenhuma loja cadastrada na rede ainda.</p>
          <p className="mt-1 text-[12px] text-zinc-600">Cadastre as lojas (filiais) para registrar o fechamento diário, apurar comissão e conferir divergências.</p>
          <button onClick={() => setStoreModal({ store: null })} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><Plus className="w-4 h-4" /> Cadastrar primeira loja</button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Loja</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Cota</th>
                <th className="px-3 py-2 text-right font-medium">Informado</th>
                <th className="px-3 py-2 text-right font-medium">Desvio</th>
                <th className="px-3 py-2 text-right font-medium">Ações</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => {
                const c = byStore[s.id];
                const variance = Number(c?.variance_amount || 0);
                // Desvio como % da cota — R$ negativo grande pesa demais na loja; o % conta a mesma
                // história sem escancarar o rombo (ex.: "-8%" no lugar de "-R$ 2.000,00").
                const quotaAmt = Number(c?.quota_amount || 0);
                const variancePct = quotaAmt > 0 ? (variance / quotaAmt) * 100 : null;
                return (
                  <tr key={s.id} className={`border-t border-zinc-800/70 ${!s.active ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2 text-zinc-200">
                      <div className="flex items-center gap-2">
                        <span>{s.name}{s.code ? <span className="text-zinc-500"> · {s.code}</span> : null}</span>
                        {!s.active && <span className="text-[10px] rounded-full border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-zinc-400">inativa</span>}
                        <button onClick={() => setStoreModal({ store: s })} title="Editar loja" className="text-[11px] text-zinc-500 hover:text-zinc-300">editar</button>
                        <button onClick={() => toggleActive(s)} title={s.active ? 'Desativar loja' : 'Reativar loja'} className="text-[11px] text-zinc-500 hover:text-zinc-300">{s.active ? 'desativar' : 'reativar'}</button>
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Excluir a loja "${s.name}"?\n\nSe existir OUTRA loja com o mesmo código (${s.code || 'sem código'}), todo o histórico (estoque, fechamentos, cotas) será UNIFICADO nela antes de excluir — nada se perde. Sem outra loja de mesmo código, só é possível excluir loja sem histórico.`)) return;
                            const res = await apiFetch(`/api/retailops/stores/${s.id}`, { method: 'DELETE' });
                            const d = await res.json().catch(() => ({}));
                            if (res.ok) { toast.success(d.mergedIntoName ? `Loja excluída — histórico unificado em "${d.mergedIntoName}".` : 'Loja excluída.'); load(); }
                            else toast.error(d.error || 'Falha ao excluir a loja.');
                          }}
                          title="Excluir loja duplicada (unifica o histórico na outra loja de mesmo código)"
                          className="text-[11px] text-rose-400/80 hover:text-rose-300"
                        >excluir</button>
                      </div>
                    </td>
                    <td className="px-3 py-2">{c ? <Badge map={CLOSING_STATUS} s={c.status} /> : <span className="text-xs text-zinc-500">—</span>}</td>
                    <td className="px-3 py-2 text-right text-zinc-400">{c ? brl(c.quota_amount) : '—'}</td>
                    <td className="px-3 py-2 text-right text-zinc-200">{c?.informed_total != null ? brl(c.informed_total) : '—'}</td>
                    <td className={`px-3 py-2 text-right ${variance < 0 ? 'text-red-300' : variance > 0 ? 'text-emerald-300' : 'text-zinc-500'}`}>
                      {c?.informed_total != null && variancePct != null
                        ? `${variancePct > 0 ? '+' : ''}${variancePct.toFixed(1)}%`
                        : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => openInform(s)} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800">{c && c.informed_total != null ? 'Editar' : 'Informar'}</button>
                        {c && ['received', 'extracted', 'needs_review'].includes(c.status) && (
                          <>
                            <button onClick={() => setStatus(c, 'approve')} title="Aprovar" className="rounded bg-emerald-600/90 px-1.5 py-0.5 text-white hover:bg-emerald-500"><Check className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setStatus(c, 'reject')} title="Rejeitar" className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300 hover:bg-red-500/10"><X className="w-3.5 h-3.5" /></button>
                          </>
                        )}
                        {c && <button onClick={() => removeClosing(c, s.name)} title="Excluir este fechamento e a cota do dia (limpar lançamento errado)" className="rounded border border-zinc-800 px-1.5 py-0.5 text-zinc-500 hover:text-red-300 hover:border-red-500/40"><Trash2 className="w-3.5 h-3.5" /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {informing && <InformModal closing={informing} onClose={() => setInforming(null)} onSaved={() => { setInforming(null); load(); }} />}
      {storeModal && <StoreFormModal store={storeModal.store} onClose={() => setStoreModal(null)} onSaved={() => { setStoreModal(null); load(); }} />}
    </div>
  );
}

// Categorias de custo fixo por loja (espelha o servidor: RetailStoreCostService).
const STORE_COST_CATEGORIES: { key: string; label: string; hint?: string }[] = [
  { key: 'aluguel', label: 'Aluguel' },
  { key: 'energia', label: 'Energia (luz)' },
  { key: 'condominio', label: 'Condomínio' },
  { key: 'agua', label: 'Água' },
  { key: 'internet', label: 'Internet/telefone' },
  { key: 'folha', label: 'Folha (salários)' },
  { key: 'outros', label: 'Outros' },
];

// Categorias de custo VARIÁVEL por loja (ADR-083 E5). Cada categoria pode ter
// as duas naturezas ao mesmo tempo: `percent` (% do faturamento) e/ou
// `fixedPerSale` (R$ por venda/ticket). Ex.: taxa de cartão pode ter os dois.
const STORE_VARIABLE_COST_CATEGORIES: { key: string; label: string; hint: string }[] = [
  { key: 'card_fee', label: 'Taxa de cartão', hint: 'O que a maquininha desconta em cima do valor da venda.' },
  { key: 'pix_fee', label: 'Taxa de Pix', hint: 'Tarifa cobrada por cada Pix recebido (se a sua conta cobra).' },
  { key: 'tax_sale', label: 'Imposto sobre venda', hint: 'Simples Nacional ou outro imposto proporcional ao faturamento.' },
  { key: 'packaging', label: 'Embalagem', hint: 'Sacola/caixa que sai a cada venda.' },
  { key: 'freight', label: 'Frete', hint: 'Delivery ou entrega proporcional à venda.' },
  { key: 'other', label: 'Outros variáveis', hint: 'Qualquer outro custo que sobe/desce junto com a venda.' },
];

// ---- Cadastro/edição de loja (reutilizável nas abas) ------------------------
function StoreFormModal({ store, onClose, onSaved }: { store: any | null; onClose: () => void; onSaved: () => void }) {
  const editing = !!store;
  const [name, setName] = useState(store?.name || '');
  const [code, setCode] = useState(store?.code || '');
  const [wa, setWa] = useState(store?.whatsapp_identifier || '');
  const [address, setAddress] = useState(store?.address || '');
  const [city, setCity] = useState(store?.city || '');
  const [lat, setLat] = useState(store?.latitude != null ? String(store.latitude) : '');
  const [lng, setLng] = useState(store?.longitude != null ? String(store.longitude) : '');
  const [sellerSource, setSellerSource] = useState(store?.seller_source === 'manual' ? 'manual' : 'pdv');
  const [margin, setMargin] = useState(store?.gross_margin_percent != null ? String(store.gross_margin_percent) : '');
  const [costs, setCosts] = useState<Record<string, string>>({});
  // Custos VARIÁVEIS: uma entrada por categoria, com duas naturezas (percent e fixedPerSale).
  const [varCosts, setVarCosts] = useState<Record<string, { percent: string; fixed: string }>>({});
  const [saving, setSaving] = useState(false);

  // Custos fixos já cadastrados (só ao editar): preenche o formulário.
  useEffect(() => {
    if (!editing) return;
    apiFetch(`/api/retailops/stores/${store.id}/costs`).then(r => r.json()).then(d => {
      const by = d?.costs?.byCategory || {};
      const next: Record<string, string> = {};
      for (const c of STORE_COST_CATEGORIES) next[c.key] = by[c.key] > 0 ? String(by[c.key]) : '';
      setCosts(next);
    }).catch(() => {});
    // Custos variáveis (ADR-083 E5): mesma dinâmica, dois inputs por categoria.
    apiFetch(`/api/retailops/stores/${store.id}/variable-costs`).then(r => r.json()).then(d => {
      const by = d?.costs?.byCategory || {};
      const next: Record<string, { percent: string; fixed: string }> = {};
      for (const c of STORE_VARIABLE_COST_CATEGORIES) {
        const e = by[c.key] || { percent: 0, fixedPerSale: 0 };
        next[c.key] = {
          percent: e.percent > 0 ? String(e.percent) : '',
          fixed: e.fixedPerSale > 0 ? String(e.fixedPerSale) : '',
        };
      }
      setVarCosts(next);
    }).catch(() => {});
  }, [editing, store?.id]);

  const costsTotal = useMemo(
    () => STORE_COST_CATEGORIES.reduce((a, c) => a + (Number(String(costs[c.key] || '').replace(',', '.')) || 0), 0),
    [costs]
  );
  const varTotals = useMemo(() => {
    let pct = 0, fix = 0;
    for (const c of STORE_VARIABLE_COST_CATEGORIES) {
      const e = varCosts[c.key] || { percent: '', fixed: '' };
      pct += Number(String(e.percent || '').replace(',', '.')) || 0;
      fix += Number(String(e.fixed || '').replace(',', '.')) || 0;
    }
    return { pct, fix };
  }, [varCosts]);

  const save = async () => {
    if (!name.trim()) { toast.error('Dê um nome à loja.'); return; }
    setSaving(true);
    try {
      const body = JSON.stringify({
        name: name.trim(), code: code.trim() || null, whatsappIdentifier: wa.replace(/\D/g, '') || null,
        address: address.trim() || null, city: city.trim() || null,
        latitude: lat.trim() === '' ? null : Number(lat.replace(',', '.')),
        longitude: lng.trim() === '' ? null : Number(lng.replace(',', '.')),
        sellerSource: sellerSource === 'manual' ? 'manual' : null,
        grossMarginPercent: margin.trim() === '' ? null : Number(margin.replace(',', '.')),
      });
      const res = editing
        ? await apiFetch(`/api/retailops/stores/${store.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })
        : await apiFetch('/api/retailops/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!res.ok) { const e = await res.json().catch(() => ({})); toast.error(e.error || 'Falha ao salvar a loja.'); return; }
      const saved = await res.json().catch(() => ({}));
      const storeId = editing ? store.id : saved?.id;
      // SAVE-001/006: custos fixos + variáveis num PUT ATÔMICO (fim do save
      // fragmentado com .catch(()=>{})). A margem já foi na loja acima.
      if (storeId) {
        const costsPayload: Record<string, number> = {};
        for (const c of STORE_COST_CATEGORIES) costsPayload[c.key] = Number(String(costs[c.key] || '').replace(',', '.')) || 0;
        const varPayload: Record<string, { percent: number; fixedPerSale: number }> = {};
        for (const c of STORE_VARIABLE_COST_CATEGORIES) {
          const e = varCosts[c.key] || { percent: '', fixed: '' };
          varPayload[c.key] = { percent: Number(String(e.percent || '').replace(',', '.')) || 0, fixedPerSale: Number(String(e.fixed || '').replace(',', '.')) || 0 };
        }
        const cRes = await apiFetch(`/api/retailops/stores/${storeId}/financial-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixedCosts: costsPayload, variableCosts: varPayload }) });
        if (!cRes.ok) { toast.error('A loja foi salva, mas os custos não — reabra e tente salvar os custos de novo.'); onSaved(); return; }
      }
      toast.success(editing ? 'Loja atualizada.' : 'Loja cadastrada.');
      onSaved();
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      {/* Layout sticky-header + scroll-body + sticky-footer: com muitos campos
          (custos fixos + variáveis + margem), a versão anterior fazia o
          botão Salvar rolar junto — usuário não sabia onde estava nem que
          podia rolar. Agora header e rodapé ficam fixos e só o miolo scrolla. */}
      <div className="w-full max-w-md max-h-[92vh] flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h3 className="font-semibold text-zinc-100">{editing ? 'Editar loja' : 'Nova loja (filial)'}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          <label className="block text-xs text-zinc-400">Nome da loja
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Loja Centro" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="block text-xs text-zinc-400">Código (opcional)
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="Ex.: 1005 (código da filial no ERP)" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            <span className="mt-1 block text-[11px] text-zinc-500">Com a integração Alterdata/ERP ligada, use aqui o <strong>mesmo código da filial do ERP</strong> (ex.: 1005, 1006) — é por ele que o estoque e o preço são casados na sincronização.</span>
          </label>
          <label className="block text-xs text-zinc-400">WhatsApp da loja (opcional)
            <input value={wa} onChange={e => setWa(e.target.value)} placeholder="Ex.: 5511987654321" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            <span className="mt-1 block text-[11px] text-zinc-500">Recebe a cobrança de pendências (fechamento, malote) e permite dar baixa respondendo.</span>
          </label>
          <label className="block text-xs text-zinc-400">Endereço (opcional)
            <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Rua, nº, bairro" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-zinc-400 col-span-1">Cidade
              <input value={city} onChange={e => setCity(e.target.value)} placeholder="Cidade" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="block text-xs text-zinc-400">Latitude
              <input value={lat} onChange={e => setLat(e.target.value)} placeholder="-22.90" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="block text-xs text-zinc-400">Longitude
              <input value={lng} onChange={e => setLng(e.target.value)} placeholder="-43.17" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
          </div>
          <span className="block text-[11px] text-zinc-500 -mt-1">As coordenadas (lat/long) permitem sugerir a transferência entre as lojas <strong>mais próximas</strong>. Pegue no Google Maps: clique com o botão direito no ponto → o primeiro item copia “lat, long”.</span>
          <label className="block text-xs text-zinc-400">Comissão por vendedor vem de
            <select value={sellerSource} onChange={e => setSellerSource(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
              <option value="pdv">PDV/ERP (padrão)</option>
              <option value="manual">Lançamento manual da equipe (feito no fechamento de caixa)</option>
            </select>
            <span className="mt-1 block text-[11px] text-zinc-500">Se o código de vendedor que vem do PDV/ERP dessa loja NÃO identifica cada pessoa de verdade (ex.: um código só, compartilhado pra loja inteira), escolha "Lançamento manual" — o PDV dessa loja deixa de contar na comissão por vendedor, e passa a valer o que o gestor lançar em "Vendas por vendedor" no fechamento diário.</span>
          </label>

          {/* Custos fixos + margem → lucro e ponto de equilíbrio por loja */}
          <div className="mt-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <p className="text-xs font-medium text-zinc-300">Custos fixos mensais desta loja</p>
            <p className="mt-0.5 text-[11px] text-zinc-500">Quanto esta loja gasta por mês. Junto com a margem, vira o <strong>lucro</strong> e o <strong>ponto de equilíbrio</strong> na aba “Resultado por loja”.</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {STORE_COST_CATEGORIES.map(c => (
                <label key={c.key} className="text-[11px] text-zinc-400">{c.label}
                  <div className="mt-0.5 flex items-center rounded-lg bg-zinc-950 border border-zinc-800 px-2">
                    <span className="text-[11px] text-zinc-600">R$</span>
                    <input inputMode="decimal" value={costs[c.key] || ''} onChange={e => setCosts(p => ({ ...p, [c.key]: e.target.value }))}
                      placeholder="0,00" className="w-full bg-transparent px-1.5 py-1.5 text-sm text-zinc-100 outline-none" />
                  </div>
                </label>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className="text-zinc-500">Total de custo fixo/mês</span>
              <span className="font-medium text-zinc-300">{brl(costsTotal)}</span>
            </div>
            <label className="mt-3 block text-xs text-zinc-400">Margem bruta média da loja (%)
              <input inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value)} placeholder="Ex.: 55" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
              <span className="mt-1 block text-[11px] text-zinc-500">Quanto sobra de cada R$ 100 vendidos DEPOIS de pagar o custo da mercadoria (sem contar os custos fixos acima). É uma estimativa — sem ela, o app mostra faturamento e custos mas <strong>não calcula o lucro</strong> (não dá pra descontar a mercadoria).</span>
            </label>
          </div>

          {/* Custos VARIÁVEIS (ADR-083 E5): o que sai proporcional à venda. Fica separado dos fixos porque a natureza é outra: % do faturamento ou R$ por ticket. */}
          <div className="mt-1 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <p className="text-xs font-medium text-zinc-300">Custos variáveis desta loja</p>
            <p className="mt-0.5 text-[11px] text-zinc-500">O que sobe/desce junto com a venda: taxa da maquininha, imposto sobre o faturamento, embalagem que sai por ticket. Entra no cálculo do <strong>lucro real</strong> da loja depois da margem bruta.</p>
            <div className="mt-2 space-y-2">
              {STORE_VARIABLE_COST_CATEGORIES.map(c => (
                <div key={c.key}>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-zinc-400">{c.label}</span>
                    <span className="text-[10px] text-zinc-600 hidden sm:inline">{c.hint}</span>
                  </div>
                  <div className="mt-0.5 grid grid-cols-2 gap-2">
                    <label className="block text-[10px] text-zinc-500">% do faturamento
                      <div className="mt-0.5 flex items-center rounded-lg bg-zinc-950 border border-zinc-800 px-2">
                        <input inputMode="decimal"
                          value={varCosts[c.key]?.percent || ''}
                          onChange={e => setVarCosts(p => ({ ...p, [c.key]: { percent: e.target.value, fixed: p[c.key]?.fixed || '' } }))}
                          placeholder="0"
                          className="w-full bg-transparent px-1 py-1.5 text-sm text-zinc-100 outline-none" />
                        <span className="text-[11px] text-zinc-600">%</span>
                      </div>
                    </label>
                    <label className="block text-[10px] text-zinc-500">R$ por venda
                      <div className="mt-0.5 flex items-center rounded-lg bg-zinc-950 border border-zinc-800 px-2">
                        <span className="text-[11px] text-zinc-600">R$</span>
                        <input inputMode="decimal"
                          value={varCosts[c.key]?.fixed || ''}
                          onChange={e => setVarCosts(p => ({ ...p, [c.key]: { percent: p[c.key]?.percent || '', fixed: e.target.value } }))}
                          placeholder="0,00"
                          className="w-full bg-transparent px-1.5 py-1.5 text-sm text-zinc-100 outline-none" />
                      </div>
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className="text-zinc-500">Somatório</span>
              <span className="font-medium text-zinc-300">{varTotals.pct.toFixed(2).replace('.', ',')}% + {brl(varTotals.fix)}/venda</span>
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">A parte por venda só entra no cálculo se a loja tem PDV ou fechamentos aprovados no mês — senão a gente ignora (não dá pra chutar quantas vendas ocorreram).</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800 bg-zinc-900">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar loja</button>
        </div>
      </div>
    </div>
  );
}

// Botão reutilizável "Nova loja" (para as abas que dependem de lojas cadastradas).
function NewStoreButton({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"><Plus className="w-3.5 h-3.5" /> Nova loja</button>
      {open && <StoreFormModal store={null} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onCreated(); }} />}
    </>
  );
}

// Linha compacta pra adicionar uma nova bandeira dentro do painel de cartões.
// Enter = adicionar. Fica embaixo do grid de cada método (crédito/débito).
function AddBrandRow({ onAdd }: { onAdd: (name: string) => void | Promise<void> }) {
  const [name, setName] = useState('');
  const submit = async () => { const v = name.trim(); if (!v) return; await onAdd(v); setName(''); };
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        placeholder="+ nova bandeira"
        className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-[12px] text-zinc-100 placeholder:text-zinc-600"
      />
      <button type="button" onClick={submit} disabled={!name.trim()} className="rounded border border-indigo-500/40 bg-indigo-500/10 px-2 py-1 text-[11px] font-medium text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-40">Adicionar</button>
    </div>
  );
}

// Fase C2 — a FOLHA da loja em forma digital: dinheiro/PIX, crédito e débito
// POR BANDEIRA (configuráveis por loja), despesas, ranking por vendedor
// (valor/AT/peças — pré-preenchido pela escala do dia), cadastros, boletas,
// malote e conferência com o resumo do POS. Foto da folha pré-preenche (IA).
type RankRow = { sellerName: string; valor: string; at: string; pecas: string; produtos: string };
type DespesaRow = { descricao: string; valor: string };
// POS-003/004 (Fatia 3): custo esperado das tarifas do POS a partir do resumo.
// Usa a regra detalhada (crédito/débito) quando existe, senão a taxa agregada.
function PosExpectedCost({ storeId, creditValue, creditQty, debitValue, debitQty }: { storeId: string; creditValue: number; creditQty: number; debitValue: number; debitQty: number }) {
  const [exp, setExp] = useState<any>(null);
  useEffect(() => {
    if (!storeId || (creditValue <= 0 && debitValue <= 0)) { setExp(null); return; }
    const t = setTimeout(() => {
      const qs = `creditValue=${creditValue}&creditQty=${creditQty}&debitValue=${debitValue}&debitQty=${debitQty}`;
      apiFetch(`/api/retailops/stores/${storeId}/pos-fees/expected?${qs}`).then(r => r.ok ? r.json() : null).then(setExp).catch(() => setExp(null));
    }, 400);
    return () => clearTimeout(t);
  }, [storeId, creditValue, creditQty, debitValue, debitQty]);
  if (!exp || exp.basis === 'none') return null;
  return (
    <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-[11px] text-zinc-300">
      <span className="text-zinc-500">Custo esperado das tarifas:</span> <strong className="text-amber-300">{brl(exp.total)}</strong>
      {exp.basis === 'detailed'
        ? <span className="text-zinc-500"> · crédito {brl(exp.credit?.cost || 0)} ({exp.credit?.percent || 0}% + {brl(exp.credit?.fixed || 0)}/transação) · débito {brl(exp.debit?.cost || 0)} ({exp.debit?.percent || 0}% + {brl(exp.debit?.fixed || 0)}/transação)</span>
        : <span className="text-zinc-500"> · taxa de cartão agregada ({exp.legacy?.percent || 0}% + {brl(exp.legacy?.fixedPerSale || 0)}/venda) — configure crédito/débito nas tarifas da loja para separar</span>}
      {exp.note && <span className="block mt-0.5 text-amber-300/70">{exp.note}</span>}
    </div>
  );
}

function InformModal({ closing, onClose, onSaved }: { closing: any; onClose: () => void; onSaved: () => void }) {
  const date = closing.closing_date;
  const storeId = closing.store_id;
  const existing = useMemo(() => { try { return JSON.parse(closing.details_json || 'null') || {}; } catch { return {}; } }, [closing.details_json]);

  const [brands, setBrands] = useState<{ credito: string[]; debito: string[] } | null>(null);
  const [dinheiro, setDinheiro] = useState(existing.dinheiro ? String(existing.dinheiro) : '');
  const [pix, setPix] = useState(existing.pix ? String(existing.pix) : '');
  const [voucher, setVoucher] = useState(existing.voucher ? String(existing.voucher) : '');
  const [troca, setTroca] = useState(existing.troca ? String(existing.troca) : '');
  const [outros, setOutros] = useState(existing.outros ? String(existing.outros) : '');
  const [credito, setCredito] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(existing.credito || {}).map(([k, v]) => [k, String(v)])));
  const [debito, setDebito] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(existing.debito || {}).map(([k, v]) => [k, String(v)])));
  const [despesas, setDespesas] = useState<DespesaRow[]>(() => (existing.despesas || []).map((d: any) => ({ descricao: d.descricao, valor: String(d.valor) })));
  const [ranking, setRanking] = useState<RankRow[]>(() => (existing.ranking || []).map((r: any) => ({ sellerName: r.sellerName, valor: r.valor ? String(r.valor) : '', at: r.atendimentos ? String(r.atendimentos) : '', pecas: r.pecas ? String(r.pecas) : '', produtos: r.produtos ? String(r.produtos) : '' })));
  const [cadastros, setCadastros] = useState(existing.cadastros ? String(existing.cadastros) : '');
  const [boletaInicial, setBoletaInicial] = useState(existing.boletaInicial || '');
  const [boletaFinal, setBoletaFinal] = useState(existing.boletaFinal || '');
  const [malote, setMalote] = useState(existing.malote || '');
  const [premioDia, setPremioDia] = useState(existing.premioDia || '');
  const [obs, setObs] = useState(existing.obs || '');
  const [posCred, setPosCred] = useState(existing.pos?.creditoValor ? String(existing.pos.creditoValor) : '');
  const [posCredQtd, setPosCredQtd] = useState(existing.pos?.creditoQtd ? String(existing.pos.creditoQtd) : '');
  const [posDeb, setPosDeb] = useState(existing.pos?.debitoValor ? String(existing.pos.debitoValor) : '');
  const [posDebQtd, setPosDebQtd] = useState(existing.pos?.debitoQtd ? String(existing.pos.debitoQtd) : '');
  const [escalados, setEscalados] = useState<string[]>([]);
  const [boletaClicks, setBoletaClicks] = useState<number | null>(null);
  const [lineAudit, setLineAudit] = useState<{ hasPdv: boolean; maxLinhas: number; totalBoletas: number; overLimit: Array<{ boleta: string; produtos: number }> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  // Cota do dia editável: a coluna "Cota" vem do snapshot do fechamento, que
  // pode ter sido um palpite do PDV. O lojista digita a cota real (ou a IA lê
  // da folha) e a gente grava por cima. `quotaAmt` é o valor exibido/vivo.
  const [quotaAmt, setQuotaAmt] = useState<number>(Number(closing.quota_amount || 0));
  const [editCota, setEditCota] = useState(false);
  const [cotaInput, setCotaInput] = useState('');
  const [savingCota, setSavingCota] = useState(false);

  useEffect(() => {
    apiFetch(`/api/retailops/stores/${storeId}/card-brands`).then(r => r.json()).then(d => {
      if (d?.credito) setBrands(d);
    }).catch(() => setBrands({ credito: ['Amex', 'Master', 'Visa', 'Elo'], debito: ['Redshop', 'Eletron', 'Elo'] }));
    // Escala do dia: pré-preenche o ranking com quem trabalhou (status work).
    apiFetch(`/api/retailops/schedule?storeId=${storeId}&start=${date}&end=${date}`).then(r => r.json()).then(d => {
      const names = (d?.entries || []).filter((e: any) => e.status === 'work').map((e: any) => e.seller_name || e.seller_key.replace(/^(mat|nom|user):/, ''));
      setEscalados(names);
      setRanking(prev => prev.length ? prev : (names.length ? names.map((n: string) => ({ sellerName: n, valor: '', at: '', pecas: '' })) : [{ sellerName: '', valor: '', at: '', pecas: '' }]));
    }).catch(() => setRanking(prev => prev.length ? prev : [{ sellerName: '', valor: '', at: '', pecas: '' }]));
    // Boletas em tempo real (Fase C3): pré-preenche inicial/final com o dia
    // aberto + cliques, e traz a contagem pra conferência ao vivo.
    apiFetch(`/api/retailops/boletas/day?storeId=${storeId}&day=${date}`).then(r => r.json()).then(d => {
      if (d?.initialNumber) {
        setBoletaClicks(Number(d.count || 0));
        setBoletaInicial((prev: string) => prev || d.initialNumber);
        if (d.lastNumber) setBoletaFinal((prev: string) => prev || d.lastNumber);
      }
    }).catch(() => {});
    // BOL-006: auditoria "5 produtos por boleta" pelos itens do PDV (produtos
    // distintos por boleta). Só aparece quando o PDV do dia já sincronizou.
    apiFetch(`/api/retailops/boletas/line-audit?storeId=${storeId}&day=${date}`).then(r => r.json()).then(d => {
      setLineAudit(d && typeof d === 'object' && 'hasPdv' in d ? d : null);
    }).catch(() => setLineAudit(null));
    // eslint-disable-next-line
  }, [storeId, date]);

  // Add/remove/rename em nível de bandeira — a folha da loja muda com a mesa
  // comprando/derrubando maquininhas, então recepção/gerência precisa mexer
  // sem abrir prompt do navegador nem editar CSV colado.
  const saveBrands = async (next: { credito: string[]; debito: string[] }) => {
    const res = await apiFetch(`/api/retailops/stores/${storeId}/card-brands`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { setBrands(d); return true; }
    toast.error(d.error || 'Falha ao salvar as bandeiras.');
    return false;
  };
  const addBrand = async (kind: 'credito' | 'debito', name: string) => {
    if (!brands) return;
    const clean = name.trim();
    if (!clean) return;
    if (brands[kind].some(b => b.toLowerCase() === clean.toLowerCase())) { toast.error('Essa bandeira já está na lista.'); return; }
    const next = { ...brands, [kind]: [...brands[kind], clean] };
    if (await saveBrands(next)) toast.success(`Bandeira "${clean}" adicionada.`);
  };
  const removeBrand = async (kind: 'credito' | 'debito', name: string) => {
    if (!brands) return;
    const setter = kind === 'credito' ? setCredito : setDebito;
    const map = kind === 'credito' ? credito : debito;
    if (n(String(map[name] ?? '')) > 0 && !window.confirm(`A bandeira "${name}" já tem valor lançado hoje. Remover mesmo assim?`)) return;
    const next = { ...brands, [kind]: brands[kind].filter(b => b !== name) };
    if (await saveBrands(next)) {
      // Limpa o valor lançado pra bandeira removida — evita "fantasma" no total.
      setter(p => { const { [name]: _drop, ...rest } = p; return rest; });
      toast.success(`Bandeira "${name}" removida.`);
    }
  };
  const renameBrand = async (kind: 'credito' | 'debito', oldName: string) => {
    if (!brands) return;
    const v = window.prompt(`Renomear "${oldName}" para:`, oldName);
    if (v == null) return;
    const clean = v.trim();
    if (!clean || clean === oldName) return;
    if (brands[kind].some(b => b.toLowerCase() === clean.toLowerCase())) { toast.error('Já existe uma bandeira com esse nome.'); return; }
    const next = { ...brands, [kind]: brands[kind].map(b => b === oldName ? clean : b) };
    if (await saveBrands(next)) {
      // Move o valor lançado (se houver) pra chave nova, senão o input volta a zero.
      const setter = kind === 'credito' ? setCredito : setDebito;
      setter(p => { const { [oldName]: v0, ...rest } = p; return v0 != null ? { ...rest, [clean]: v0 } : rest; });
      toast.success(`Bandeira renomeada para "${clean}".`);
    }
  };

  const n = parseMoneyBR; // parser BR à prova de milhar (corrige o "Informado")
  // Subtotais SOMENTE sobre as bandeiras cadastradas (visíveis) — nunca sobre
  // chaves soltas do estado. Evita o "fantasma" (ex.: uma bandeira do POS que a
  // IA injetou e não aparece como campo, mas inflava o débito). Ver retailClosingForm.
  const totalCredito = useMemo(() => sumBandeiras(credito, brands?.credito || [], n), [credito, brands]);
  const totalDebito = useMemo(() => sumBandeiras(debito, brands?.debito || [], n), [debito, brands]);
  const totalVendas = useMemo(() => n(dinheiro) + n(pix) + totalCredito + totalDebito + n(voucher) + n(troca) + n(outros), [dinheiro, pix, totalCredito, totalDebito, voucher, troca, outros]);
  const totalDespesas = useMemo(() => despesas.reduce((a, d) => a + n(d.valor), 0), [despesas]);
  const rankingTotal = useMemo(() => ranking.reduce((a, r) => a + n(r.valor), 0), [ranking]);
  const rankingGap = ranking.some(r => n(r.valor) > 0) ? Math.round((totalVendas - rankingTotal) * 100) / 100 : null;
  const posGapCred = n(posCred) > 0 ? Math.round((totalCredito - n(posCred)) * 100) / 100 : null;
  const posGapDeb = n(posDeb) > 0 ? Math.round((totalDebito - n(posDeb)) * 100) / 100 : null;
  const quota = quotaAmt;
  const cotaPorVendedor = quota > 0 && escalados.length > 0 ? quota / escalados.length : null;

  // Grava a cota real da loja no dia (por cima do palpite do PDV). Atualiza o
  // snapshot no servidor e o valor exibido aqui na hora.
  const saveCota = async () => {
    const amount = n(cotaInput);
    if (!(amount >= 0)) { toast.error('Digite um valor de cota válido.'); return; }
    setSavingCota(true);
    try {
      const res = await apiFetch(`/api/retailops/closings/${closing.id}/quota`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount }) });
      if (res.ok) { setQuotaAmt(amount); setEditCota(false); toast.success('Cota do dia atualizada.'); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || 'Falha ao salvar a cota.'); }
    } finally { setSavingCota(false); }
  };

  // Foto da folha → IA pré-preenche o formulário inteiro (Fase C2).
  const onScan = async (file: File) => {
    setScanning(true); setScanNote(null);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('storeId', storeId); fd.append('date', date);
      const res = await apiFetch('/api/retailops/closings/scan', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao ler a folha.'); return; }
      const x = d.extraction || {};
      if (x.dinheiro != null) setDinheiro(String(x.dinheiro));
      if (x.pix != null) setPix(String(x.pix));
      if (x.voucher != null) setVoucher(String(x.voucher));
      if (x.troca != null) setTroca(String(x.troca));
      // Bandeiras: só entram as CADASTRADAS da loja — o resto (POS, rótulo de
      // total "Débito"/"Crédito") é ignorado pra não virar fantasma no subtotal.
      if (x.creditoBandeiras) {
        const { values, ignored } = reconcileBandeiras(x.creditoBandeiras, brands?.credito || []);
        setCredito(values);
        if (ignored.length) toast.info(`Crédito: ignorei bandeira(s) não cadastrada(s): ${ignored.join(', ')}. Confira o subtotal.`);
      }
      else if (x.credito != null && brands?.credito?.length) setCredito({ [brands.credito[0]]: String(x.credito) });
      if (x.debitoBandeiras) {
        const { values, ignored } = reconcileBandeiras(x.debitoBandeiras, brands?.debito || []);
        setDebito(values);
        if (ignored.length) toast.info(`Débito: ignorei bandeira(s) não cadastrada(s): ${ignored.join(', ')}. Confira o subtotal.`);
      }
      else if (x.debito != null && brands?.debito?.length) setDebito({ [brands.debito[0]]: String(x.debito) });
      if (Array.isArray(x.despesas) && x.despesas.length) setDespesas(x.despesas.map((dd: any) => ({ descricao: String(dd.descricao || ''), valor: dd.valor ? String(dd.valor) : '' })));
      // CLOSE-003: a foto ENRIQUECE o ranking — NÃO apaga linhas já digitadas pelo
      // gerente. Mantém as linhas com dado e acrescenta só os vendedores da foto
      // que ainda não estão na lista (match por nome).
      if (Array.isArray(x.ranking) && x.ranking.length) {
        const photoRows: RankRow[] = x.ranking.map((r: any) => ({ sellerName: String(r.nome || ''), valor: r.valor ? String(r.valor) : '', at: r.atendimentos ? String(r.atendimentos) : '', pecas: r.pecas ? String(r.pecas) : '', produtos: r.produtos ? String(r.produtos) : '' }));
        setRanking(prev => {
          const typed = prev.filter(r => r.sellerName.trim() || r.valor || r.at || r.pecas);
          if (!typed.length) return photoRows;
          const have = new Set(typed.map(r => r.sellerName.trim().toLowerCase()).filter(Boolean));
          return [...typed, ...photoRows.filter(pr => !have.has(pr.sellerName.trim().toLowerCase()))];
        });
      }
      // Cota da folha (ex.: "cota = 3.800"): abre o editor pré-preenchido pra
      // o lojista CONFIRMAR — não grava sozinho (evita "inventar" cota).
      if (x.cota != null && Number(x.cota) > 0) { setCotaInput(String(x.cota)); setEditCota(true); }
      if (x.cadastros != null) setCadastros(String(x.cadastros));
      if (x.boletaInicial) setBoletaInicial(String(x.boletaInicial));
      if (x.boletaFinal) setBoletaFinal(String(x.boletaFinal));
      if (x.malote) setMalote(String(x.malote));
      if (x.pos) { setPosCred(x.pos.creditoValor ? String(x.pos.creditoValor) : ''); setPosCredQtd(x.pos.creditoQtd ? String(x.pos.creditoQtd) : ''); setPosDeb(x.pos.debitoValor ? String(x.pos.debitoValor) : ''); setPosDebQtd(x.pos.debitoQtd ? String(x.pos.debitoQtd) : ''); }
      setScanNote(x.needsReview
        ? `Leitura com baixa confiança (${x.confidence}%). CONFIRA cada campo antes de salvar.`
        : `IA leu a folha (confiança ${x.confidence}%). Confira e salve.`);
    } catch { toast.error('Falha ao enviar a imagem.'); }
    finally { setScanning(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const details = {
        dinheiro: n(dinheiro), pix: n(pix), voucher: n(voucher), troca: n(troca), outros: n(outros),
        // Só as bandeiras cadastradas vão pro servidor — nada de chave fantasma.
        credito: Object.fromEntries((brands?.credito || []).map(b => [b, n(String(credito[b] ?? ''))])),
        debito: Object.fromEntries((brands?.debito || []).map(b => [b, n(String(debito[b] ?? ''))])),
        despesas: despesas.map(d => ({ descricao: d.descricao, valor: n(d.valor) })),
        ranking: ranking.map(r => ({ sellerName: r.sellerName.trim(), valor: n(r.valor), atendimentos: n(r.at), pecas: n(r.pecas), produtos: parseInt(String(r.produtos).replace(/[^0-9]/g, ''), 10) || 0 })).filter(r => r.sellerName),
        cadastros: n(cadastros), boletaInicial, boletaFinal, malote, premioDia, obs,
        pos: n(posCred) > 0 || n(posDeb) > 0 ? { creditoValor: n(posCred), creditoQtd: n(posCredQtd), debitoValor: n(posDeb), debitoQtd: n(posDebQtd) } : null,
      };
      const res = await apiFetch(`/api/retailops/closings/${closing.id}/detailed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ details }) });
      if (res.ok) { toast.success('Fechamento do dia registrado — aguardando aprovação.'); onSaved(); }
      else { const e = await res.json().catch(() => ({})); toast.error(e.error || 'Falha ao salvar.'); }
    } finally { setSaving(false); }
  };

  const inp = 'w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100';
  const money = (v: string, set: (s: string) => void, ph = '0,00') => (
    <input inputMode="decimal" value={v} onChange={e => set(e.target.value)} placeholder={ph} className={inp} />
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 p-5 max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Fechamento do dia — {closing.store_name} · {date?.slice(8)}/{date?.slice(5, 7)}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {editCota ? (
            <span className="inline-flex items-center gap-1.5">
              Cota do dia:
              <input autoFocus inputMode="decimal" value={cotaInput} onChange={e => setCotaInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveCota(); if (e.key === 'Escape') setEditCota(false); }}
                placeholder="0,00" className="w-28 bg-zinc-950 border border-zinc-700 rounded px-2 py-0.5 text-zinc-100" />
              <button onClick={saveCota} disabled={savingCota} className="inline-flex items-center gap-1 rounded bg-emerald-600/80 px-2 py-0.5 text-white hover:bg-emerald-600 disabled:opacity-50">
                {savingCota ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Salvar
              </button>
              <button onClick={() => setEditCota(false)} className="text-zinc-500 hover:text-zinc-300">cancelar</button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              Cota do dia: <strong className="text-zinc-300">{brl(quota)}</strong>
              {cotaPorVendedor != null && <> ÷ {escalados.length} escalado(s) = <strong className="text-zinc-300">{brl(cotaPorVendedor)}</strong> por vendedor</>}
              <button onClick={() => { setCotaInput(quota > 0 ? String(quota) : ''); setEditCota(true); }} title="Corrigir a cota do dia" className="text-zinc-500 hover:text-zinc-200"><Pencil className="w-3 h-3" /></button>
            </span>
          )}
        </div>

        <div className="mt-3">
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/20 cursor-pointer">
            {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Enviar foto da folha (IA pré-preenche)
            <input type="file" accept="image/*" className="hidden" disabled={scanning} onChange={e => { const f = e.target.files?.[0]; if (f) onScan(f); e.currentTarget.value = ''; }} />
          </label>
          {scanNote && <p className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-300/90"><Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {scanNote}</p>}
        </div>

        {/* Dinheiro / PIX + cartões por bandeira */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Dinheiro & PIX</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-400">R$ (dinheiro){money(dinheiro, setDinheiro)}</label>
              <label className="text-xs text-zinc-400">PIX{money(pix, setPix)}</label>
              <label className="text-xs text-zinc-400">Voucher{money(voucher, setVoucher)}</label>
              <label className="text-xs text-zinc-400">Troca{money(troca, setTroca)}</label>
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Crédito · {brl(totalCredito)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(brands?.credito || []).map(b => (
                <div key={b} className="text-xs text-zinc-400">
                  <div className="flex items-center justify-between gap-1">
                    <button onClick={() => renameBrand('credito', b)} title="Renomear bandeira" className="truncate text-left hover:text-zinc-200">{b}</button>
                    <button onClick={() => removeBrand('credito', b)} title="Remover bandeira" className="text-zinc-600 hover:text-red-300"><X className="w-3 h-3" /></button>
                  </div>
                  <input inputMode="decimal" value={credito[b] || ''} onChange={e => setCredito(p => ({ ...p, [b]: e.target.value }))} placeholder="0,00" className={inp} />
                </div>
              ))}
            </div>
            <AddBrandRow onAdd={(name) => addBrand('credito', name)} />
            <div className="flex items-center justify-between mt-3 mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Débito · {brl(totalDebito)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(brands?.debito || []).map(b => (
                <div key={b} className="text-xs text-zinc-400">
                  <div className="flex items-center justify-between gap-1">
                    <button onClick={() => renameBrand('debito', b)} title="Renomear bandeira" className="truncate text-left hover:text-zinc-200">{b}</button>
                    <button onClick={() => removeBrand('debito', b)} title="Remover bandeira" className="text-zinc-600 hover:text-red-300"><X className="w-3 h-3" /></button>
                  </div>
                  <input inputMode="decimal" value={debito[b] || ''} onChange={e => setDebito(p => ({ ...p, [b]: e.target.value }))} placeholder="0,00" className={inp} />
                </div>
              ))}
            </div>
            <AddBrandRow onAdd={(name) => addBrand('debito', name)} />
          </div>
        </div>

        {/* Conferência com o POS */}
        <div className="mt-3 rounded-lg border border-zinc-800 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Resumo do POS (comprovante da maquininha — opcional)</div>
          <div className="grid grid-cols-4 gap-2">
            <label className="text-xs text-zinc-400">Crédito (R$){money(posCred, setPosCred)}</label>
            <label className="text-xs text-zinc-400">Qtd
              <input inputMode="numeric" value={posCredQtd} onChange={e => setPosCredQtd(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className={inp} />
            </label>
            <label className="text-xs text-zinc-400">Débito (R$){money(posDeb, setPosDeb)}</label>
            <label className="text-xs text-zinc-400">Qtd
              <input inputMode="numeric" value={posDebQtd} onChange={e => setPosDebQtd(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className={inp} />
            </label>
          </div>
          {(posGapCred != null || posGapDeb != null) && (
            <p className={`mt-2 text-[11px] ${Math.abs(posGapCred || 0) > 0.01 || Math.abs(posGapDeb || 0) > 0.01 ? 'text-amber-300' : 'text-emerald-300'}`}>
              {Math.abs(posGapCred || 0) <= 0.01 && Math.abs(posGapDeb || 0) <= 0.01
                ? 'Cartões batem com o POS.'
                : `Diferença vs POS — crédito ${brl(posGapCred || 0)} · débito ${brl(posGapDeb || 0)}. Confira antes de salvar.`}
            </p>
          )}
          {/* POS-003/004: custo esperado das tarifas (regra detalhada > legada) */}
          <PosExpectedCost storeId={storeId} creditValue={n(posCred)} creditQty={n(posCredQtd)} debitValue={n(posDeb)} debitQty={n(posDebQtd)} />
        </div>

        {/* Ranking por vendedor (alimenta a comissão na aprovação) */}
        <div className="mt-3 rounded-lg border border-zinc-800 p-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Ranking por vendedor · {brl(rankingTotal)}</span>
            <button onClick={() => setRanking(p => [...p, { sellerName: '', valor: '', at: '', pecas: '', produtos: '' }])} className="text-[11px] text-indigo-300 hover:text-indigo-200">+ vendedor</button>
          </div>
          <p className="mb-2 text-[10px] text-zinc-600">Na aprovação, essas linhas viram as vendas por vendedor da comissão/corrida (AT = atendimentos, o denominador do P.A). Prod = produtos DIFERENTES (códigos/nomes distintos) — usado pra contar as boletas ({PRODUTOS_POR_BOLETA} por boleta).{escalados.length ? ' Pré-preenchido pela escala do dia.' : ''}</p>
          {/* CLOSE-001: cabeçalho só no desktop; no mobile cada vendedor vira cartão */}
          <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-1.5 px-1 text-[10px] uppercase tracking-wider text-zinc-500">
            <span>Vendedor</span><span className="w-24 text-right">Valor</span><span className="w-12 text-right">AT</span><span className="w-12 text-right">Peças</span><span className="w-12 text-right">Prod</span><span className="w-5"></span>
          </div>
          {ranking.map((r, i) => (
            <div key={i} className="mt-1.5 sm:mt-1 rounded-lg border border-zinc-800 p-2 sm:border-0 sm:p-0 sm:rounded-none sm:grid sm:grid-cols-[1fr_auto_auto_auto_auto_auto] sm:gap-1.5 sm:items-center">
              <div className="flex items-center gap-1.5">
                <input value={r.sellerName} onChange={e => setRanking(p => p.map((x, j) => j === i ? { ...x, sellerName: e.target.value } : x))} placeholder="Nome do vendedor" className={`${inp} flex-1`} />
                <button onClick={() => setRanking(p => p.filter((_, j) => j !== i))} className="shrink-0 text-zinc-600 hover:text-red-300 sm:hidden"><Trash2 className="w-4 h-4" /></button>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1.5 sm:mt-0 sm:contents">
                <label className="sm:contents"><span className="mb-0.5 block text-[9px] uppercase text-zinc-500 sm:hidden">Valor</span>
                  <input inputMode="decimal" value={r.valor} onChange={e => setRanking(p => p.map((x, j) => j === i ? { ...x, valor: e.target.value } : x))} placeholder="0,00" className={`${inp} w-full text-right sm:w-24`} /></label>
                <label className="sm:contents"><span className="mb-0.5 block text-[9px] uppercase text-zinc-500 sm:hidden">AT</span>
                  <input inputMode="numeric" value={r.at} onChange={e => setRanking(p => p.map((x, j) => j === i ? { ...x, at: e.target.value.replace(/[^0-9]/g, '') } : x))} placeholder="0" className={`${inp} w-full text-right sm:w-12`} /></label>
                <label className="sm:contents"><span className="mb-0.5 block text-[9px] uppercase text-zinc-500 sm:hidden">Peças</span>
                  <input inputMode="numeric" value={r.pecas} onChange={e => setRanking(p => p.map((x, j) => j === i ? { ...x, pecas: e.target.value.replace(/[^0-9]/g, '') } : x))} placeholder="0" className={`${inp} w-full text-right sm:w-12`} /></label>
                <label className="sm:contents"><span className="mb-0.5 block text-[9px] uppercase text-zinc-500 sm:hidden">Prod</span>
                  <input inputMode="numeric" value={r.produtos} onChange={e => setRanking(p => p.map((x, j) => j === i ? { ...x, produtos: e.target.value.replace(/[^0-9]/g, '') } : x))} placeholder="0" className={`${inp} w-full text-right sm:w-12`} /></label>
              </div>
              <button onClick={() => setRanking(p => p.filter((_, j) => j !== i))} className="hidden sm:block text-zinc-600 hover:text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          {rankingGap != null && Math.abs(rankingGap) > 0.01 && (
            <p className="mt-2 text-[11px] text-amber-300">A soma do ranking difere do total do dia em {brl(rankingGap)} — a linha LOJA da folha deveria bater. Confira.</p>
          )}
        </div>

        {/* Despesas + rodapé da folha */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-zinc-800 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Despesas do dia · {brl(totalDespesas)}</span>
              <button onClick={() => setDespesas(p => [...p, { descricao: '', valor: '' }])} className="text-[11px] text-indigo-300 hover:text-indigo-200">+ despesa</button>
            </div>
            {despesas.length === 0 && <p className="text-[11px] text-zinc-600">Sem despesas lançadas.</p>}
            {despesas.map((d, i) => (
              <div key={i} className="mt-1 grid grid-cols-[1fr_auto_auto] gap-1.5 items-center">
                <input value={d.descricao} onChange={e => setDespesas(p => p.map((x, j) => j === i ? { ...x, descricao: e.target.value } : x))} placeholder="Descrição" className={inp} />
                <input inputMode="decimal" value={d.valor} onChange={e => setDespesas(p => p.map((x, j) => j === i ? { ...x, valor: e.target.value } : x))} placeholder="0,00" className={`${inp} w-24 text-right`} />
                <button onClick={() => setDespesas(p => p.filter((_, j) => j !== i))} className="text-zinc-600 hover:text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            {/* DESP-002: total em DESTAQUE no rodapé da caixa — pra o gestor
                bater o olho e achar o total das despesas na hora (pedido do lojista). */}
            <div className="mt-2 flex items-center justify-between rounded-md bg-orange-500/10 border border-orange-500/30 px-2.5 py-1.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-orange-200">Total despesas</span>
              <span className="text-lg font-bold text-orange-300">{brl(totalDespesas)}</span>
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 mb-2">Boletas, cadastros & malote</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-zinc-400">Boleta inicial
                <input value={boletaInicial} onChange={e => setBoletaInicial(e.target.value)} placeholder="017752" className={inp} />
              </label>
              <label className="text-xs text-zinc-400">Boleta final
                <input value={boletaFinal} onChange={e => setBoletaFinal(e.target.value)} placeholder="017757" className={inp} />
              </label>
              {/* BOL-007: estimativa AO VIVO pelos PRODUTOS lançados no ranking —
                  nova boleta a cada 5, a partir da inicial (não espera o PDV). */}
              {(() => {
                const totalBol = boletasEsperadas(ranking.map(r => r.produtos));
                if (totalBol <= 0) return null;
                const finalEsp = boletaFinalEsperada(boletaInicial, totalBol);
                const infFinal = String(boletaFinal).replace(/\D/g, '');
                const bate = finalEsp && infFinal && parseInt(infFinal, 10) === parseInt(String(finalEsp).replace(/\D/g, ''), 10);
                return <p className={`col-span-2 text-[11px] ${!boletaFinal ? 'text-cyan-300' : bate ? 'text-emerald-300' : 'text-amber-300'}`}>
                  Pelos produtos lançados: <strong>{totalBol}</strong> boleta(s) ({PRODUTOS_POR_BOLETA} produtos por boleta){boletaInicial && finalEsp ? <> — de <strong>{boletaInicial}</strong> a <strong>{finalEsp}</strong></> : ''}{boletaFinal && finalEsp ? (bate ? ' · bate com a boleta final informada.' : ' · difere da final informada — confira.') : ''}
                </p>;
              })()}
              {boletaClicks != null && boletaInicial && boletaFinal && (() => {
                const range = parseInt(String(boletaFinal).replace(/\D/g, ''), 10) - parseInt(String(boletaInicial).replace(/\D/g, ''), 10) + 1;
                const ok = range === boletaClicks;
                return <p className={`col-span-2 text-[11px] ${ok ? 'text-emerald-300' : 'text-amber-300'}`}>{ok ? `Range de ${range} boleta(s) bate com os ${boletaClicks} clique(s) do dia.` : `Range de ${isNaN(range) ? '?' : range} boleta(s) × ${boletaClicks} clique(s) registrados — confira antes de salvar.`}</p>;
              })()}
              {/* BOL-006: conferência da regra "5 produtos por boleta" pelos
                  itens reais do PDV (produtos DISTINTOS por boleta — 5 blusas
                  iguais = 1 linha). Só aparece quando o PDV do dia já entrou. */}
              {lineAudit?.hasPdv && (
                lineAudit.overLimit.length === 0
                  ? <p className="col-span-2 text-[11px] text-emerald-300">{lineAudit.totalBoletas} boleta(s) do PDV — todas com até {lineAudit.maxLinhas} produtos. Regra OK.</p>
                  : <p className="col-span-2 text-[11px] text-amber-300">Passou de {lineAudit.maxLinhas} produtos por boleta: {lineAudit.overLimit.map(b => `Nº ${b.boleta} (${b.produtos})`).join(', ')} — cada boleta só cabe {lineAudit.maxLinhas} linhas. Confira o lançamento.</p>
              )}
              <label className="text-xs text-zinc-400">Cadastros
                <input inputMode="numeric" value={cadastros} onChange={e => setCadastros(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className={inp} />
              </label>
              <label className="text-xs text-zinc-400">Malote
                <input value={malote} onChange={e => setMalote(e.target.value)} placeholder="—" className={inp} />
              </label>
              <label className="col-span-2 text-xs text-zinc-400">Prêmio do dia
                <input value={premioDia} onChange={e => setPremioDia(e.target.value)} placeholder="—" className={inp} />
              </label>
              <label className="col-span-2 text-xs text-zinc-400">OBS
                <input value={obs} onChange={e => setObs(e.target.value)} placeholder="—" className={inp} />
              </label>
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-950/60 px-3 py-2">
          <span className="text-sm text-zinc-400">Total do dia</span>
          <span className={`text-sm font-semibold ${quota > 0 && totalVendas >= quota ? 'text-emerald-300' : 'text-zinc-100'}`}>{brl(totalVendas)}</span>
        </div>
        {/* DESP-001: total de despesas como linha própria, ao lado dos outros
            totais, pra o gestor comparar de bate-pronto (pedido do lojista). */}
        <div className="mt-2 flex items-center justify-between rounded-lg bg-zinc-950/60 px-3 py-2">
          <span className="text-sm text-zinc-400">Total de despesas do dia</span>
          <span className="text-sm font-semibold text-orange-300">{brl(totalDespesas)}</span>
        </div>
        {/* QUOTA-001: resumo único da cota da loja (mesmo componente da corrida) */}
        {quota > 0 && <div className="mt-2"><StoreQuotaSummary quota={quota} realized={totalVendas} /></div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving || totalVendas <= 0} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar fechamento
          </button>
        </div>
      </div>
    </div>
  );
}


// ---- Lançamento de vendas por vendedor (manual / foto+IA — Cenário B) -------
// A loja anota as vendas de cada vendedor no papel; o gestor digita aqui OU
// envia a foto da folha p/ a IA ler e pré-preencher, conferindo antes de salvar.
type SellerRow = { sellerName: string; valor: string; pecas: string; atendimentos: string };
function SellerSalesModal({ defaultDate, onClose, onSaved }: { defaultDate: string; onClose: () => void; onSaved: () => void }) {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [date, setDate] = useState(defaultDate || todayStr());
  const [rows, setRows] = useState<SellerRow[]>([{ sellerName: '', valor: '', pecas: '', atendimentos: '' }]);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanSource, setScanSource] = useState<'manual' | 'photo'>('manual');
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => { apiFetch('/api/retailops/stores').then(r => r.json()).then(d => setStores(Array.isArray(d?.stores) ? d.stores : [])).catch(() => {}); }, []);

  const total = useMemo(() => rows.reduce((a, r) => a + (Number(r.valor) || 0), 0), [rows]);
  const totalPecas = useMemo(() => rows.reduce((a, r) => a + (Number(r.pecas) || 0), 0), [rows]);
  const setRow = (i: number, patch: Partial<SellerRow>) => setRows(p => p.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addRow = () => setRows(p => [...p, { sellerName: '', valor: '', pecas: '', atendimentos: '' }]);
  const removeRow = (i: number) => setRows(p => p.length > 1 ? p.filter((_, idx) => idx !== i) : p);

  const onScan = async (file: File) => {
    setScanning(true); setScanNote(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await apiFetch('/api/retailops/seller-sales/scan', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao ler a folha.'); return; }
      const entries = Array.isArray(d.entries) ? d.entries : [];
      if (!entries.length) { toast.error('A IA não encontrou vendedores legíveis. Tente uma foto mais nítida ou digite manualmente.'); return; }
      setRows(entries.map((e: any) => ({ sellerName: String(e.sellerName || ''), valor: e.valor ? String(e.valor) : '', pecas: e.pecas ? String(e.pecas) : '', atendimentos: e.atendimentos ? String(e.atendimentos) : '' })));
      setScanSource('photo'); setImageUrl(d.imageUrl || null);
      setScanNote(d.needsReview
        ? `Leitura com baixa confiança (${d.confidence}%). CONFIRA cada linha antes de salvar.`
        : `IA leu ${entries.length} vendedor(es) (confiança ${d.confidence}%). Confira e salve.`);
    } catch { toast.error('Falha ao enviar a imagem.'); }
    finally { setScanning(false); }
  };

  const save = async () => {
    const entries = rows
      .map(r => ({ sellerName: r.sellerName.trim(), valor: Number(r.valor) || 0, pecas: Number(r.pecas) || 0, atendimentos: Number(r.atendimentos) || 0 }))
      .filter(e => e.sellerName && (e.valor > 0 || e.pecas > 0));
    if (!entries.length) { toast.error('Informe ao menos um vendedor com nome e valor (ou peças).'); return; }
    setSaving(true);
    try {
      const res = await apiFetch('/api/retailops/seller-sales', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: storeId || null, saleDate: date, entries, source: scanSource, imageUrl }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`${d.created?.length || entries.length} lançamento(s) salvo(s).`); onSaved(); }
      else toast.error(d.error || 'Falha ao salvar.');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Vendas por vendedor</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">Digite as vendas de cada vendedor ou envie a foto da folha para a IA ler. Confira antes de salvar.</p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-xs text-zinc-400">Data da folha
            <input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="text-xs text-zinc-400">Loja (opcional)
            <select value={storeId} onChange={e => setStoreId(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
              <option value="">— todas / não informar —</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-3">
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-200 hover:bg-sky-500/20 cursor-pointer">
            {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Enviar foto da folha (IA)
            <input type="file" accept="image/*" className="hidden" disabled={scanning} onChange={e => { const f = e.target.files?.[0]; if (f) onScan(f); e.currentTarget.value = ''; }} />
          </label>
          {scanNote && <p className="mt-2 flex items-start gap-1.5 text-[12px] text-amber-300/90"><Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {scanNote}</p>}
        </div>

        <div className="mt-3 space-y-2">
          {/* CLOSE-001: tabela no desktop, cartão por vendedor no mobile */}
          <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 px-1 text-[11px] uppercase tracking-wider text-zinc-500">
            <span>Vendedor</span><span className="w-24 text-right">Valor (R$)</span><span className="w-14 text-right">Peças</span><span className="w-14 text-right" title="Atendimentos — o AT da folha, denominador do P.A">AT</span><span className="w-6"></span>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="rounded-lg border border-zinc-800 p-2 sm:border-0 sm:p-0 sm:rounded-none sm:grid sm:grid-cols-[1fr_auto_auto_auto_auto] sm:gap-2 sm:items-center">
              <div className="flex items-center gap-1.5">
                <input value={r.sellerName} onChange={e => setRow(i, { sellerName: e.target.value })} placeholder="Nome do vendedor" className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
                <button onClick={() => removeRow(i)} title="Remover linha" className="shrink-0 text-zinc-600 hover:text-red-300 sm:hidden"><Trash2 className="w-4 h-4" /></button>
              </div>
              <div className="mt-1.5 grid grid-cols-3 gap-1.5 sm:mt-0 sm:contents">
                <label className="sm:contents"><span className="mb-0.5 block text-[9px] uppercase text-zinc-500 sm:hidden">Valor</span>
                  <input inputMode="decimal" value={r.valor} onChange={e => setRow(i, { valor: e.target.value.replace(',', '.') })} placeholder="0,00" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-right text-zinc-100 sm:w-24" /></label>
                <label className="sm:contents"><span className="mb-0.5 block text-[9px] uppercase text-zinc-500 sm:hidden">Peças</span>
                  <input inputMode="numeric" value={r.pecas} onChange={e => setRow(i, { pecas: e.target.value.replace(/[^0-9]/g, '') })} placeholder="0" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-right text-zinc-100 sm:w-14" /></label>
                <label className="sm:contents"><span className="mb-0.5 block text-[9px] uppercase text-zinc-500 sm:hidden">AT</span>
                  <input inputMode="numeric" value={r.atendimentos} onChange={e => setRow(i, { atendimentos: e.target.value.replace(/[^0-9]/g, '') })} placeholder="0" title="Atendimentos (AT da folha)" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-right text-zinc-100 sm:w-14" /></label>
              </div>
              <button onClick={() => removeRow(i)} title="Remover linha" className="hidden sm:block text-zinc-600 hover:text-red-300"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <button onClick={addRow} className="inline-flex items-center gap-1.5 text-xs text-indigo-300 hover:text-indigo-200"><Plus className="w-3.5 h-3.5" /> Adicionar vendedor</button>
        </div>

        <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-950/60 px-3 py-2 text-sm">
          <span className="text-zinc-400">Total</span>
          <span className="font-semibold text-zinc-100">{brl(total)} · {totalPecas} peça(s)</span>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving || (total <= 0 && totalPecas <= 0)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar
          </button>
        </div>
      </div>
    </div>
  );
}


// ---- Edição de um lançamento de venda por vendedor já feito ------------------
function EditSellerSaleModal({ sale, onClose, onSaved }: { sale: any; onClose: () => void; onSaved: () => void }) {
  const [stores, setStores] = useState<any[]>([]);
  const [sellerName, setSellerName] = useState(String(sale.seller_name || ''));
  const [date, setDate] = useState(String(sale.sale_date || todayStr()).slice(0, 10));
  const [storeId, setStoreId] = useState(String(sale.store_id || ''));
  const [valor, setValor] = useState(sale.valor != null ? String(sale.valor) : '');
  const [pecas, setPecas] = useState(sale.pecas != null ? String(sale.pecas) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => { apiFetch('/api/retailops/stores').then(r => r.json()).then(d => setStores(Array.isArray(d?.stores) ? d.stores : [])).catch(() => {}); }, []);

  const save = async () => {
    const name = sellerName.trim();
    const v = Number(valor) || 0, p = Number(pecas) || 0;
    if (!name) { toast.error('Informe o nome do vendedor.'); return; }
    if (v <= 0 && p <= 0) { toast.error('Informe um valor ou a quantidade de peças.'); return; }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/retailops/seller-sales/${sale.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sellerName: name, saleDate: date, storeId: storeId || null, valor: v, pecas: p }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Lançamento atualizado.'); onSaved(); }
      else toast.error(d.error || 'Falha ao salvar.');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Editar lançamento</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <p className="mt-0.5 text-xs text-zinc-500">Origem: {sale.source === 'photo' ? 'foto (IA)' : 'manual'}. As alterações somam na comissão por vendedor.</p>
        <div className="mt-3 space-y-3">
          <label className="block text-xs text-zinc-400">Vendedor
            <input value={sellerName} onChange={e => setSellerName(e.target.value)} placeholder="Nome do vendedor" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-400">Data da folha
              <input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400">Loja (opcional)
              <select value={storeId} onChange={e => setStoreId(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
                <option value="">— não informar —</option>
                {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-400">Valor (R$)
              <input inputMode="decimal" value={valor} onChange={e => setValor(e.target.value.replace(',', '.'))} placeholder="0,00" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
            <label className="text-xs text-zinc-400">Peças
              <input inputMode="numeric" value={pecas} onChange={e => setPecas(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
            </label>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar</button>
        </div>
      </div>
    </div>
  );
}


// ---- Reposição / grade furada (estoque por loja do ERP) ---------------------
// Loja que TRABALHA o produto mas está zerada num tamanho que outra loja tem
// sobrando → sugestão de transferência entre filiais.
function ReplenishmentTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeFilter, setStoreFilter] = useState('');
  const [xfer, setXfer] = useState<any | null>(null);
  const load = () => {
    setLoading(true);
    apiFetch('/api/retailops/replenishment')
      .then(r => r.json())
      .then(d => setRows(Array.isArray(d?.suggestions) ? d.suggestions : []))
      .catch(() => toast.error('Falha ao carregar as sugestões de reposição.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  const stores = useMemo(() => Array.from(new Set(rows.map(r => r.needy_store))).sort(), [rows]);
  const shown = storeFilter ? rows.filter(r => r.needy_store === storeFilter) : rows;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
          <option value="">Todas as lojas</option>
          {stores.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        <span className="text-xs text-zinc-500">{shown.length} sugestão(ões) — loja com o produto na grade, porém zerada num tamanho que outra filial tem sobrando (≥2). <strong>Transferível</strong> já preserva o mínimo da loja que doa.</span>
      </div>
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhuma grade furada encontrada — os tamanhos disponíveis estão bem distribuídos entre as lojas. 🎉</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Produto</th>
                <th className="px-3 py-2 text-left font-medium">Variação</th>
                <th className="px-3 py-2 text-left font-medium">Un.</th>
                <th className="px-3 py-2 text-left font-medium">Falta em</th>
                <th className="px-3 py-2 text-left font-medium">Sobra em</th>
                <th className="px-3 py-2 text-right font-medium" title="Saldo da loja que tem sobra">Disponível</th>
                <th className="px-3 py-2 text-right font-medium" title="Quanto pode sair sem furar o mínimo da loja que doa">Transferível</th>
                <th className="px-3 py-2 text-right font-medium">Distância</th>
                <th className="px-3 py-2 text-right font-medium">Ação</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">
                    <div>{r.product_name}</div>
                    {(r.product_external_ref || r.variant_ean) && (
                      <div className="text-[11px] text-zinc-500">
                        {r.product_external_ref ? <>ref {r.product_external_ref}</> : null}
                        {r.product_external_ref && r.variant_ean ? ' · ' : null}
                        {r.variant_ean ? <>EAN {r.variant_ean}</> : null}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-300">{[r.size, r.color].filter(Boolean).join(' / ') || r.variant_name}</td>
                  <td className="px-3 py-2 text-zinc-400">{r.product_uom || '—'}</td>
                  <td className="px-3 py-2 text-rose-300">
                    <div>{r.needy_store}</div>
                    <div className="text-[11px] text-zinc-500">
                      saldo {r.needy_current_qty ?? 0}
                      {r.shortage_qty != null ? <> · falta <span className="text-orange-300">{r.shortage_qty}</span></> : <> · <span title="Defina o estoque-alvo desta peça">meta não configurada</span></>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-emerald-300">{r.donor_store}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{r.donor_qty}</td>
                  <td className="px-3 py-2 text-right font-semibold text-emerald-300">{r.transferable_qty != null ? r.transferable_qty : r.donor_qty}</td>
                  <td className="px-3 py-2 text-right text-zinc-400">{r.distance_km != null ? `${r.distance_km} km` : '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => setXfer(r)} disabled={!r.donor_store_id || !r.needy_store_id}
                      className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-600/20 text-indigo-200 px-2.5 py-1 text-xs hover:bg-indigo-600/30 disabled:opacity-40">
                      <ArrowLeftRight className="w-3.5 h-3.5" /> Transferir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {xfer && <TransferModal row={xfer} onClose={() => setXfer(null)} onDone={() => { setXfer(null); load(); }} />}
    </div>
  );
}

// Modal de despacho: confirma a quantidade a transferir da loja que tem sobra
// para a que está com a grade furada. Cria a transferência já EM TRÂNSITO (baixa
// na origem); a entrada no destino acontece na aba Transferências, na recepção.
function TransferModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  // Teto = transferível (preserva o mínimo da doadora, RN nº 4). Sem política de
  // doadora, cai no saldo disponível.
  const cap = row.transferable_qty != null ? Number(row.transferable_qty) : Number(row.donor_qty);
  const max = Math.max(1, cap || 1);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const variant = [row.size, row.color].filter(Boolean).join(' / ') || row.variant_name;
  const submit = async () => {
    const q = Math.min(max, Math.max(1, Math.trunc(Number(qty) || 0)));
    setBusy(true);
    try {
      const res = await apiFetch('/api/retailops/transfers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originStoreId: row.donor_store_id, destStoreId: row.needy_store_id, items: [{ productId: row.product_service_id, variantId: row.variant_id, quantity: q }] }),
      });
      const d = await res.json();
      if (res.ok) { toast.success('Transferência despachada — baixa lançada na origem.'); onDone(); }
      else toast.error(d?.error || 'Não foi possível criar a transferência.');
    } catch { toast.error('Falha ao criar a transferência.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-4" onClick={e => e.stopPropagation()}>
        <div className="text-sm text-zinc-100 font-medium">{row.product_name}</div>
        <div className="text-xs text-zinc-400 mt-0.5">{variant}</div>
        <div className="mt-3 text-sm text-zinc-300 flex items-center gap-2">
          <span className="text-emerald-300">{row.donor_store}</span>
          <ArrowLeftRight className="w-4 h-4 text-zinc-500" />
          <span className="text-rose-300">{row.needy_store}</span>
          {row.distance_km != null && <span className="text-[11px] text-zinc-500">· {row.distance_km} km</span>}
        </div>
        {row.best_time && <div className="mt-2 text-[11px] text-amber-300/90">🕐 Melhor horário para separar: {row.best_time}</div>}
        <label className="text-xs text-zinc-500 mt-3 block">Quantidade a transferir (máx. {max})</label>
        <input autoFocus type="number" min={1} max={max} value={qty}
          onChange={e => setQty(Math.min(max, Math.max(1, Math.trunc(Number(e.target.value) || 1))))}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-lg text-zinc-100 mt-1" />
        <div className="grid grid-cols-2 gap-2 mt-4">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 text-zinc-300 text-sm py-2 hover:bg-zinc-900">Cancelar</button>
          <button onClick={submit} disabled={busy} className="rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm py-2 disabled:opacity-40">Despachar</button>
        </div>
      </div>
    </div>
  );
}

// Aba Transferências: lista as transferências (em trânsito no topo) e permite
// RECEBER (dá entrada no destino) ou CANCELAR (estorna a origem) as em trânsito.
function TransfersTab() {
  const PAGE = 100;
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Foca no que precisa de AÇÃO por padrão (em trânsito); recebidas/canceladas
  // acumulam com o tempo — o filtro (que o backend já suporta) evita a lista sem fim.
  const [status, setStatus] = useState('in_transit');
  const load = (offset = 0, append = false) => {
    append ? setLoadingMore(true) : setLoading(true);
    apiFetch(`/api/retailops/transfers${status ? `?status=${status}&` : '?'}limit=${PAGE}&offset=${offset}`).then(r => r.json())
      .then(d => {
        setTotal(Number(d?.total) || 0);
        setList(prev => append ? [...prev, ...(Array.isArray(d?.transfers) ? d.transfers : [])] : (Array.isArray(d?.transfers) ? d.transfers : []));
      })
      .catch(() => toast.error('Falha ao carregar as transferências.'))
      .finally(() => { setLoading(false); setLoadingMore(false); });
  };
  useEffect(() => { load(0, false); /* eslint-disable-next-line */ }, [status]);
  const act = async (id: string, action: 'receive' | 'cancel') => {
    if (action === 'cancel' && !window.confirm('Cancelar a transferência e estornar a baixa na origem?')) return;
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/retailops/transfers/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json();
      if (res.ok) { toast.success(action === 'receive' ? 'Recebido — entrada lançada no destino.' : 'Transferência cancelada.'); load(0, false); }
      else toast.error(d?.error || 'Não foi possível concluir a ação.');
    } catch { toast.error('Falha na ação.'); }
    finally { setBusyId(null); }
  };
  const badge = (s: string) => s === 'in_transit'
    ? <span className="inline-flex items-center gap-1 text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5 text-[11px]"><Truck className="w-3 h-3" /> Em trânsito</span>
    : s === 'received'
    ? <span className="inline-flex items-center gap-1 text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2 py-0.5 text-[11px]"><PackageCheck className="w-3 h-3" /> Recebida</span>
    : <span className="inline-flex items-center gap-1 text-zinc-400 bg-zinc-500/10 border border-zinc-500/30 rounded-full px-2 py-0.5 text-[11px]"><X className="w-3 h-3" /> Cancelada</span>;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <select value={status} onChange={e => setStatus(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
          <option value="in_transit">Em trânsito</option>
          <option value="received">Recebidas</option>
          <option value="cancelled">Canceladas</option>
          <option value="">Todas</option>
        </select>
        <button onClick={() => load(0, false)} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
        {total > 0 && <span className="text-xs text-zinc-500">{list.length < total ? `${list.length} de ${total}` : total}</span>}
        <span className="text-xs text-zinc-500">Peças em trânsito entre lojas: baixa lançada na origem; a entrada no destino sai na recepção.</span>
      </div>
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">{status === 'in_transit' ? 'Nenhuma transferência em trânsito. Crie uma na aba ' : 'Nenhuma transferência neste filtro. Crie uma na aba '}<span className="text-zinc-300">Reposição (grade)</span>.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Origem → Destino</th>
                <th className="px-3 py-2 text-right font-medium">Itens</th>
                <th className="px-3 py-2 text-right font-medium">Peças</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Ação</th>
              </tr>
            </thead>
            <tbody>
              {list.map(t => (
                <tr key={t.id} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200"><span className="text-emerald-300">{t.origin_store}</span> <span className="text-zinc-500">→</span> <span className="text-rose-300">{t.dest_store}</span></td>
                  <td className="px-3 py-2 text-right text-zinc-300">{t.item_count}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{t.total_sent}</td>
                  <td className="px-3 py-2">{badge(t.status)}</td>
                  <td className="px-3 py-2 text-right">
                    {t.status === 'in_transit' ? (
                      <div className="inline-flex gap-1.5">
                        <button onClick={() => act(t.id, 'receive')} disabled={busyId === t.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-600/20 text-emerald-200 px-2.5 py-1 text-xs hover:bg-emerald-600/30 disabled:opacity-40"><PackageCheck className="w-3.5 h-3.5" /> Receber</button>
                        <button onClick={() => act(t.id, 'cancel')} disabled={busyId === t.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 text-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40"><X className="w-3.5 h-3.5" /> Cancelar</button>
                      </div>
                    ) : <span className="text-zinc-600 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.length > 0 && list.length < total && (
        <div className="mt-3 text-center">
          <button onClick={() => load(list.length, true)} disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
            {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Carregar mais ({total - list.length} restantes)
          </button>
        </div>
      )}
    </div>
  );
}




// ---- Clientes do PDV (Fase 3, opt-in) ---------------------------------------
function PdvCustomersTab() {
  const PAGE = 100;
  const [q, setQ] = useState('');
  const [bMonth, setBMonth] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [stores, setStores] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = (offset: number, append: boolean) => {
    append ? setLoadingMore(true) : setLoading(true);
    apiFetch(`/api/retailops/pdv-customers?q=${encodeURIComponent(q)}&birthdayMonth=${bMonth}&store=${encodeURIComponent(storeFilter)}&limit=${PAGE}&offset=${offset}`)
      .then(r => r.json())
      .then(d => {
        if (d && !d.error) {
          setTotal(Number(d.total) || 0);
          setCustomers(prev => append ? [...prev, ...(d.customers || [])] : (d.customers || []));
          if (Array.isArray(d.stores)) setStores(d.stores);
        }
      })
      .catch(() => toast.error('Falha ao carregar clientes.'))
      .finally(() => { setLoading(false); setLoadingMore(false); });
  };
  useEffect(() => { const t = setTimeout(() => load(0, false), 300); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [q, bMonth, storeFilter]);
  const data = { total, customers };
  const MESES = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  return (
    <div>
      <p className="text-[12px] text-zinc-500 mb-3">Base de clientes do PDV (nome, CPF, celular, e-mail, aniversário) — separada dos contatos do WhatsApp, para campanhas e relacionamento. Requer o opt-in "Importar clientes do PDV" em Integrações → Alterdata. A <strong>Loja</strong> é a filial de cadastro/origem do cliente.</p>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nome, CPF ou celular…" className="w-full max-w-sm bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-100" />
        {stores.length > 0 && (
          <select value={storeFilter} onChange={e => setStoreFilter(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-sm text-zinc-100" title="Filtrar por loja/filial">
            <option value="">Todas as lojas</option>
            {stores.map((s: any) => <option key={s.id} value={s.code}>{s.name}</option>)}
          </select>
        )}
        <select value={bMonth} onChange={e => setBMonth(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 text-sm text-zinc-100" title="Aniversariantes do mês">
          {MESES.map((m, i) => <option key={i} value={i === 0 ? '' : String(i).padStart(2, '0')}>{i === 0 ? 'Aniversário: todos os meses' : `Aniversário: ${m}`}</option>)}
        </select>
        {total > 0 && <span className="text-xs text-zinc-500">{customers.length < total ? `${customers.length} de ${total}` : total} cliente(s)</span>}
      </div>
      {loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : customers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum cliente do PDV {q || bMonth || storeFilter ? 'para este filtro' : 'importado ainda'}. Ligue "Importar clientes do PDV" em Integrações → Alterdata e sincronize.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Nome</th>
              <th className="px-3 py-2 text-left font-medium">Loja</th>
              <th className="px-3 py-2 text-left font-medium">Celular</th>
              <th className="px-3 py-2 text-left font-medium">E-mail</th>
              <th className="px-3 py-2 text-left font-medium">Aniversário</th>
              <th className="px-3 py-2 text-left font-medium">Última compra</th>
            </tr></thead>
            <tbody>
              {data.customers.map((c: any) => (
                <tr key={c.codigo_n} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{c.nome || '—'}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.store_name || (c.filial ? <span className="text-zinc-500" title="Filial não mapeada a uma loja cadastrada">Filial {c.filial}</span> : '—')}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.celular || '—'}</td>
                  <td className="px-3 py-2 text-zinc-400">{c.email || '—'}</td>
                  <td className="px-3 py-2 text-zinc-300">{c.nascimento ? c.nascimento.slice(5).split('-').reverse().join('/') : '—'}</td>
                  <td className="px-3 py-2 text-zinc-400">{c.ultima_compra ? c.ultima_compra.split('-').reverse().join('/') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {customers.length > 0 && customers.length < total && (
        <div className="mt-3 text-center">
          <button onClick={() => load(customers.length, true)} disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
            {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Carregar mais ({total - customers.length} restantes)
          </button>
        </div>
      )}
    </div>
  );
}

// Painel "Conferência Sicredi" (Fase R1) — cruza PDV × adquirente por (NSU,
// parcela). Mostra 4 buckets em cores: match / diverge / só PDV / só Sicredi.
// Empty-state explica que precisa carregar dados da Sicredi (API stub +
// import manual pra teste enquanto credenciais não chegam).
function SicrediReconciliationPanel({ recon, start, end, onReload }: { recon: any; start: string; end: string; onReload: () => void }) {
  const [importing, setImporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  if (!recon) return (
    <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
      Sem dados de conferência ainda. Ligue o sync Sicredi ou faça upload do extrato manualmente pra começar.
    </div>
  );
  const c = recon.counts || {};
  const t = recon.totals || {};
  const total = c.matched + c.diverged + c.onlyPdv + c.onlyAcquirer;
  const doImport = async () => {
    let rows: any[] = [];
    try { rows = JSON.parse(importText); } catch { toast.error('JSON inválido — cole um array [{numeroTransacao, dataVencimento, valorBruto, ...}, ...]'); return; }
    if (!Array.isArray(rows) || rows.length === 0) { toast.error('Cole ao menos 1 linha no array.'); return; }
    setImporting(true);
    try {
      const res = await apiFetch('/api/retailops/card-acquirer/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'sicredi', rows }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(`Importadas: ${d.inserted || 0} novas, ${d.updated || 0} atualizadas${d.skipped ? `, ${d.skipped} puladas` : ''}.`);
        setImportText(''); setShowImport(false); onReload();
      } else toast.error(d.error || 'Falha ao importar.');
    } finally { setImporting(false); }
  };
  return (
    <div>
      {/* Aviso do stub da API */}
      <div className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-[12px] text-amber-200/90">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <strong>Sicredi API — em espera.</strong> Enquanto a Sicredi não libera credenciais/manual do produto Adquirência,
            o "Sync Sicredi" acima devolve <code>sicredi_api_not_configured</code>. Você pode testar toda a cadeia carregando manualmente
            o extrato que baixou do internet banking:{' '}
            <button onClick={() => setShowImport(v => !v)} className="text-amber-300 hover:text-amber-100 underline underline-offset-2">
              {showImport ? 'esconder' : 'importar extrato'}
            </button>.
          </div>
        </div>
      </div>
      {showImport && (
        <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <p className="text-[11px] text-zinc-500 mb-1">Cole o JSON no formato: <code>{`[{ "numeroTransacao": "1234567", "parcela": "1/3", "dataVencimento": "2026-08-15", "valorBruto": 300, "valorLiquido": 288, "bandeira": "Visa" }]`}</code></p>
          <textarea value={importText} onChange={e => setImportText(e.target.value)} rows={5} placeholder='[{"numeroTransacao":"...","dataVencimento":"YYYY-MM-DD","valorBruto":0}]' className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-[11px] text-zinc-100 font-mono" />
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => { setShowImport(false); setImportText(''); }} className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800">Cancelar</button>
            <button onClick={doImport} disabled={importing} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Importar
            </button>
          </div>
        </div>
      )}

      {/* Tiles do resumo */}
      <div className="mb-3 grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <p className="text-[10px] uppercase tracking-wider text-emerald-400/80">Bate certinho</p>
          <p className="text-lg font-semibold text-emerald-300">{c.matched || 0} parc.</p>
          <p className="text-[10px] text-zinc-600">Tolerância ≤ R$ 0,05</p>
        </div>
        <div className={`rounded-xl border p-3 ${(c.diverged || 0) > 0 ? 'border-amber-500/30 bg-amber-500/5' : 'border-zinc-800 bg-zinc-900/50'}`}>
          <p className="text-[10px] uppercase tracking-wider text-amber-400/80">Valor diverge</p>
          <p className="text-lg font-semibold text-amber-300">{c.diverged || 0} parc.</p>
          <p className="text-[10px] text-zinc-500">gap total {brl(t.divergedGap || 0)}</p>
        </div>
        <div className={`rounded-xl border p-3 ${(c.onlyPdv || 0) > 0 ? 'border-red-500/30 bg-red-500/5' : 'border-zinc-800 bg-zinc-900/50'}`}>
          <p className="text-[10px] uppercase tracking-wider text-red-400/80">Só no PDV</p>
          <p className="text-lg font-semibold text-red-300">{c.onlyPdv || 0} parc.</p>
          <p className="text-[10px] text-zinc-600">Sicredi ainda não confirmou / adquirente não vai depositar</p>
        </div>
        <div className={`rounded-xl border p-3 ${(c.onlyAcquirer || 0) > 0 ? 'border-red-500/30 bg-red-500/5' : 'border-zinc-800 bg-zinc-900/50'}`}>
          <p className="text-[10px] uppercase tracking-wider text-red-400/80">Só na Sicredi</p>
          <p className="text-lg font-semibold text-red-300">{c.onlyAcquirer || 0} parc.</p>
          <p className="text-[10px] text-zinc-600">Venda que Sicredi vai depositar sem contrapartida no PDV</p>
        </div>
      </div>
      <p className="mb-3 text-[11px] text-zinc-500">Período {start.split('-').reverse().join('/')} → {end.split('-').reverse().join('/')} · PDV bruto {brl(t.pdv || 0)} · Sicredi bruto {brl(t.acquirer || 0)} · {total} parcelas confrontadas.</p>

      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
          Nenhuma parcela pra confrontar. Faça a carga do extrato da Sicredi pra começar (botão "importar extrato" no topo).
        </div>
      ) : (
        <div className="space-y-4">
          {(recon.diverged || []).length > 0 && <SicrediBucketTable title="Valor diverge" tone="amber" rows={recon.diverged} showGap />}
          {(recon.onlyPdv || []).length > 0 && <SicrediBucketTable title="Só no PDV (Sicredi não confirmou)" tone="red" rows={(recon.onlyPdv as any[]).map((r: any) => ({ numero: r.numero, parcela: r.parcela, vencimento: r.vencimento, pdvValor: r.valor, bandeiraPdv: r.codigo_cartao }))} />}
          {(recon.onlyAcquirer || []).length > 0 && <SicrediBucketTable title="Só na Sicredi (sem contrapartida no PDV)" tone="red" rows={(recon.onlyAcquirer as any[]).map((r: any) => ({ numero: r.numero_transacao, parcela: r.parcela, vencimento: r.data_vencimento, acquirerValor: r.valor_bruto, bandeiraAcq: r.bandeira }))} />}
          {(recon.matched || []).length > 0 && (
            <details className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2">
              <summary className="cursor-pointer text-[12px] text-emerald-300 hover:text-emerald-200">Ver os {recon.matched.length} que bateram certinho</summary>
              <div className="mt-2"><SicrediBucketTable title="Bate certinho" tone="emerald" rows={recon.matched} /></div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function SicrediBucketTable({ title, tone, rows, showGap = false }: { title: string; tone: 'emerald' | 'amber' | 'red'; rows: any[]; showGap?: boolean }) {
  const borderCls = tone === 'emerald' ? 'border-emerald-500/20' : tone === 'amber' ? 'border-amber-500/20' : 'border-red-500/20';
  const titleCls = tone === 'emerald' ? 'text-emerald-200' : tone === 'amber' ? 'text-amber-200' : 'text-red-200';
  return (
    <div className={`rounded-xl border ${borderCls} bg-zinc-950/40 p-2`}>
      <div className={`mb-2 text-[11px] font-semibold ${titleCls}`}>{title} · {rows.length} parc.</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Vencimento</th>
              <th className="px-2 py-1 text-left font-medium">NSU</th>
              <th className="px-2 py-1 text-left font-medium">Parcela</th>
              <th className="px-2 py-1 text-left font-medium">Bandeira</th>
              <th className="px-2 py-1 text-right font-medium">PDV</th>
              <th className="px-2 py-1 text-right font-medium">Sicredi</th>
              {showGap && <th className="px-2 py-1 text-right font-medium">Gap</th>}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r: any, i: number) => (
              <tr key={`${r.numero}-${r.parcela}-${i}`} className="border-t border-zinc-800/60">
                <td className="px-2 py-1 text-zinc-200">{String(r.vencimento || '').split('-').reverse().join('/')}</td>
                <td className="px-2 py-1 text-zinc-500 font-mono text-[10px]">{r.numero || '—'}</td>
                <td className="px-2 py-1 text-zinc-300">{r.parcela || '—'}</td>
                <td className="px-2 py-1 text-zinc-300">{r.bandeiraAcq || r.bandeiraPdv || '—'}</td>
                <td className="px-2 py-1 text-right text-zinc-300">{r.pdvValor != null ? brl(r.pdvValor) : '—'}</td>
                <td className="px-2 py-1 text-right text-zinc-300">{r.acquirerValor != null ? brl(r.acquirerValor) : '—'}</td>
                {showGap && <td className={`px-2 py-1 text-right font-medium ${Math.abs(Number(r.gap) || 0) > 0.05 ? 'text-amber-300' : 'text-zinc-500'}`}>{r.gap != null ? `${r.gap > 0 ? '+' : ''}${brl(r.gap)}` : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && <p className="mt-1 text-[10px] text-zinc-600">Mostrando 200 de {rows.length}. Reduza o período pra ver o restante.</p>}
    </div>
  );
}

// ---- Recebíveis de cartão (parcelasCartao do PDV) ---------------------------
type CardMode = 'aggregated' | 'detailed' | 'sicredi';
function CardReceivablesTab() {
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(todayStr().slice(0, 8) + '28');
  const [data, setData] = useState<any | null>(null);
  const [recon, setRecon] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<CardMode>('aggregated');
  const detailed = mode === 'detailed';
  const load = () => {
    setLoading(true);
    if (mode === 'sicredi') {
      apiFetch(`/api/retailops/card-acquirer/reconciliation?start=${start}&end=${end}&source=sicredi`)
        .then(r => r.json())
        .then(d => setRecon(d && !d.error ? d : null))
        .catch(() => toast.error('Falha ao carregar a conferência Sicredi.'))
        .finally(() => setLoading(false));
      return;
    }
    apiFetch(`/api/retailops/pdv-card-receivables?start=${start}&end=${end}${detailed ? '&detailed=1' : ''}`)
      .then(r => r.json())
      .then(d => setData(d && !d.error ? d : null))
      .catch(() => toast.error('Falha ao carregar os recebíveis.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [mode]);
  const trySicrediSync = async () => {
    const res = await apiFetch('/api/retailops/card-acquirer/sync-sicredi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, end }) });
    const d = await res.json().catch(() => ({}));
    if (res.ok) { toast.success('Sync Sicredi rodou.'); load(); }
    else toast.error(d.message || d.error || 'Sicredi ainda não configurada. Use "Importar extrato" enquanto isso.');
  };
  const t = data?.totals;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">Vencimento de</span>
        <input type="date" value={start} onChange={e => setStart(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <span className="text-xs text-zinc-500">até</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><RefreshCw className="w-4 h-4" /> Gerar</button>
        <div className="ml-auto inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
          <button onClick={() => setMode('aggregated')} className={`px-2.5 py-1 rounded ${mode === 'aggregated' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>Agregado</button>
          <button onClick={() => setMode('detailed')} className={`px-2.5 py-1 rounded ${mode === 'detailed' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`} title="Linha-a-linha (bandeira + parcela + valor + vencimento)">Detalhado</button>
          <button onClick={() => setMode('sicredi')} className={`px-2.5 py-1 rounded ${mode === 'sicredi' ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`} title="Conferência com o adquirente (Sicredi): confronta o que o PDV registrou com o que a Sicredi vai depositar">Conferência Sicredi</button>
        </div>
        {mode === 'sicredi' && (
          <button onClick={trySicrediSync} title="Sync com a API Sicredi (ainda em stub — precisa das credenciais)" className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20">
            <RefreshCw className="w-3.5 h-3.5" /> Sync Sicredi
          </button>
        )}
      </div>
      {mode !== 'sicredi' && t && (
        <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"><p className="text-[11px] uppercase tracking-wider text-zinc-500">Parcelas</p><p className="text-lg font-semibold text-zinc-100">{t.parcelas}</p></div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"><p className="text-[11px] uppercase tracking-wider text-zinc-500">Bruto</p><p className="text-lg font-semibold text-zinc-100">{brl(t.bruto)}</p></div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3"><p className="text-[11px] uppercase tracking-wider text-zinc-500">Taxa retida</p><p className="text-lg font-semibold text-rose-300">{brl(t.taxa)}</p></div>
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3"><p className="text-[11px] uppercase tracking-wider text-emerald-400/80">Líquido a receber</p><p className="text-lg font-semibold text-emerald-300">{brl(t.liquido)}</p></div>
        </div>
      )}
      {/* Breakdown por bandeira do período (só nos modos PDV) */}
      {mode !== 'sicredi' && data && data.byBrand && data.byBrand.length > 0 && (
        <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Por bandeira</span>
            {data.unknownBrands?.length > 0 && (
              <span className="text-[10px] text-amber-300" title={`Códigos do ERP que ainda não têm mapping: ${data.unknownBrands.join(', ')}`}>
                {data.unknownBrands.length} código(s) não mapeado(s)
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {data.byBrand.map((b: any, i: number) => (
              <div key={`${b.raw}-${i}`} className={`rounded-lg border p-2 ${b.matched ? 'border-zinc-800 bg-zinc-900/40' : 'border-amber-500/30 bg-amber-500/5'}`}>
                <div className={`text-xs font-medium ${b.matched ? 'text-zinc-200' : 'text-amber-300'}`} title={!b.matched ? `Código cru do Alterdata: ${b.raw}` : ''}>{b.brand || 'Sem bandeira'}</div>
                <div className="text-[10px] text-zinc-500">{b.parcelas} parc. · bruto {brl(b.bruto)}</div>
                <div className="text-[11px] text-emerald-300">{brl(b.liquido)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {mode === 'sicredi' ? (
        loading ? (
          <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Cruzando PDV × Sicredi…</div>
        ) : (
          <SicrediReconciliationPanel recon={recon} start={start} end={end} onReload={load} />
        )
      ) : loading ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : !data || (!detailed && data.byDay.length === 0) || (detailed && (data.items || []).length === 0) ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum recebível de cartão no período. As parcelas entram pela sincronização das vendas do PDV.</div>
      ) : detailed ? (
        <div>
          {data.itemsTruncated && <p className="mb-2 text-[11px] text-amber-300">Mostrando as 1.000 primeiras parcelas — reduza o período pra ver o restante.</p>}
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Vencimento</th>
                <th className="px-3 py-2 text-left font-medium">Filial</th>
                <th className="px-3 py-2 text-left font-medium">Bandeira</th>
                <th className="px-3 py-2 text-left font-medium">Parcela</th>
                <th className="px-3 py-2 text-left font-medium">Nº transação</th>
                <th className="px-3 py-2 text-right font-medium">Bruto</th>
                <th className="px-3 py-2 text-right font-medium">Taxa</th>
                <th className="px-3 py-2 text-right font-medium">Líquido</th>
              </tr></thead>
              <tbody>
                {(data.items || []).map((r: any, i: number) => (
                  <tr key={`${r.numero || i}-${r.seq}`} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-200">{r.vencimento?.split('-').reverse().join('/')}</td>
                    <td className="px-3 py-2 text-zinc-400 text-[11px] font-mono">{r.filial}</td>
                    <td className={`px-3 py-2 ${r.brandMatched ? 'text-zinc-200' : 'text-amber-300'}`} title={r.brandMatched ? '' : `Código cru do Alterdata: ${r.brandRaw}`}>{r.brand}</td>
                    <td className="px-3 py-2 text-zinc-300">{r.parcela || '—'}</td>
                    <td className="px-3 py-2 text-zinc-500 text-[11px] font-mono">{r.numero || '—'}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{brl(r.valor)}</td>
                    <td className="px-3 py-2 text-right text-rose-300/80 text-[11px]">{r.taxa > 0 ? `${r.taxa}%` : '—'}</td>
                    <td className="px-3 py-2 text-right text-emerald-300">{brl(r.liquido)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Vencimento</th>
              <th className="px-3 py-2 text-right font-medium">Parcelas</th>
              <th className="px-3 py-2 text-right font-medium">Bruto</th>
              <th className="px-3 py-2 text-right font-medium">Líquido</th>
            </tr></thead>
            <tbody>
              {data.byDay.map((r: any) => (
                <tr key={r.vencimento} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{r.vencimento?.split('-').reverse().join('/')}</td>
                  <td className="px-3 py-2 text-right text-zinc-300">{r.parcelas}</td>
                  <td className="px-3 py-2 text-right text-zinc-300">{brl(r.bruto)}</td>
                  <td className="px-3 py-2 text-right text-emerald-300">{brl(r.liquido)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Mais vendidos por produto (itens das vendas do PDV) --------------------
function TopProductsTab() {
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(todayStr());
  // start/end aplicam pelo botão "Gerar" (não auto-reload) — urlFactory lê os atuais.
  const { data, status, corr, loading, isStale, loadedAt, reload: load } =
    useAnalytics(() => `/api/retailops/pdv-top-products?start=${start}&end=${end}`, []);
  const rows: any[] = Array.isArray(data?.products) ? data.products : [];
  const showData = status === 'ok' || isStale;
  const [q, setQ] = useState('');
  const maxPecas = rows.reduce((m, r) => Math.max(m, Number(r.pecas || 0)), 0) || 1;
  const shown = rows.map((r, i) => ({ ...r, _rank: i + 1 }))
    .filter(r => {
      if (!q.trim()) return true;
      const s = q.trim().toLowerCase();
      return [r.nome, r.produto, r.sku, r.ean].some(v => String(v || '').toLowerCase().includes(s));
    });
  const unmatched = rows.filter(r => !r.catalogHit).length;
  const [detail, setDetail] = useState<any | null>(null);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500">De</span>
        <input type="date" value={start} onChange={e => setStart(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <span className="text-xs text-zinc-500">até</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <button onClick={load} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"><RefreshCw className="w-4 h-4" /> Gerar</button>
        {rows.length > 0 && <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filtrar por nome, SKU, EAN ou código ERP…" className="flex-1 min-w-[180px] bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />}
      </div>
      {rows.length >= 100 && <p className="mb-2 text-[11px] text-amber-300/80">Mostrando os 100 produtos mais vendidos do período. Use o filtro para encontrar um item específico.</p>}
      {rows.length > 0 && <p className="mb-2 text-[11px] text-zinc-500">Clique numa linha para ver as vendas do período com a <strong className="text-zinc-400">data de cada uma</strong>.</p>}
      {unmatched > 0 && <p className="mb-2 text-[11px] text-amber-300/80">{unmatched} item(ns) sem match no catálogo — aparecem em âmbar com só o código do ERP; cadastre a variante em Estoque pra o nome/SKU/barras baterem.</p>}
      {isStale && <StaleNotice status={status} onRetry={load} loadedAt={loadedAt} correlationId={corr} />}
      {loading && !isStale ? (
        <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
      ) : !showData ? (
        <AnalyticsBanner status={status} onRetry={load} correlationId={corr} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum item de venda do PDV no período ainda. As vendas entram pela sincronização (Integrações → Alterdata) — o histórico completa aos poucos.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">#</th>
              <th className="px-3 py-2 text-left font-medium">Produto</th>
              <th className="px-3 py-2 text-left font-medium" title="SKU do cadastro da variante; na falta, o código do ERP da variante (Alterdata) — preenchido automaticamente, sem digitar nada">SKU</th>
              <th className="px-3 py-2 text-left font-medium" title="EAN/GTIN — o código de barras impresso na etiqueta">Barras</th>
              <th className="px-3 py-2 text-left font-medium" title="Código de 13 dígitos que sai no cupom do PDV (Alterdata)">ERP</th>
              <th className="px-3 py-2 text-right font-medium">Peças</th>
              <th className="px-3 py-2 text-right font-medium">Faturamento</th>
              <th className="px-3 py-2 text-left font-medium w-40">Volume</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.produto} onClick={() => setDetail(r)} className={`border-t border-zinc-800/70 cursor-pointer hover:bg-zinc-800/40 ${!r.catalogHit ? 'bg-amber-500/5' : ''}`} title="Clique para ver as vendas do período com a data de cada uma">
                  <td className="px-3 py-2 text-zinc-500">{r._rank}</td>
                  <td className={`px-3 py-2 ${r.catalogHit ? 'text-zinc-200' : 'text-amber-300'}`}>
                    {r.nome || <span className="font-mono">{r.produto}</span>}
                    {r.variante && r.nome && r.variante !== r.nome && <span className="ml-1 text-[10px] text-zinc-500">· {r.variante}</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 text-[11px] font-mono">{r.sku || '—'}</td>
                  <td className="px-3 py-2 text-zinc-400 text-[11px] font-mono">{r.ean || '—'}</td>
                  <td className="px-3 py-2 text-zinc-500 text-[11px] font-mono">{r.produto}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{r.pecas}</td>
                  <td className="px-3 py-2 text-right text-emerald-300">{brl(r.valor)}</td>
                  <td className="px-3 py-2"><div className="h-2 rounded-full bg-indigo-500/70" style={{ width: `${Math.max(4, Math.round(Number(r.pecas) / maxPecas * 100))}%` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail && <TopProductLinesModal row={detail} start={start} end={end} onClose={() => setDetail(null)} />}
    </div>
  );
}

// Drill-down "vendas do dia": as linhas INDIVIDUAIS de UM produto, cada uma com a
// DATA (as linhas da tabela acima são somas do período). Abre ao clicar no produto.
function TopProductLinesModal({ row, start, end, onClose }: { row: any; start: string; end: string; onClose: () => void }) {
  const [lines, setLines] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    apiFetch(`/api/retailops/pdv-sale-lines?produto=${encodeURIComponent(row.produto)}&start=${start}&end=${end}`)
      .then(r => r.json()).then(d => { if (!alive) return; setLines(Array.isArray(d?.lines) ? d.lines : []); setTotal(Number(d?.total) || 0); })
      .catch(() => { if (alive) toast.error('Falha ao carregar as vendas do produto.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [row.produto, start, end]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <div className="mb-1 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-zinc-100">{row.nome || <span className="font-mono">{row.produto}</span>}</h3>
            <p className="text-[11px] text-zinc-500">Vendas de {start} a {end} · código ERP <span className="font-mono">{row.produto}</span></p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
        </div>
        {loading ? (
          <div className="py-10 text-center text-zinc-500 text-sm"><Loader2 className="w-5 h-5 animate-spin inline" /> Carregando…</div>
        ) : lines.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhuma linha de venda individual para este produto no período.</div>
        ) : (
          <div className="max-h-[60vh] overflow-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-zinc-900/95 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Data</th>
                <th className="px-3 py-2 text-left font-medium">Loja</th>
                <th className="px-3 py-2 text-left font-medium">Boleta</th>
                <th className="px-3 py-2 text-left font-medium">Vendedor</th>
                <th className="px-3 py-2 text-right font-medium">Peças</th>
                <th className="px-3 py-2 text-right font-medium">Valor</th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.boleta}-${l.date}-${i}`} className="border-t border-zinc-800/70">
                    <td className="px-3 py-1.5 text-zinc-200 font-mono text-[12px]">{l.date}</td>
                    <td className="px-3 py-1.5 text-zinc-300">{l.loja}</td>
                    <td className="px-3 py-1.5 text-zinc-500 font-mono text-[11px]">{l.boleta}</td>
                    <td className="px-3 py-1.5 text-zinc-300">{l.vendedorNome || <span className="text-zinc-600">—</span>}</td>
                    <td className="px-3 py-1.5 text-right text-zinc-100">{l.pecas}</td>
                    <td className="px-3 py-1.5 text-right text-emerald-300">{brl(l.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && total > lines.length && <p className="mt-2 text-[11px] text-amber-300/80">Mostrando as {lines.length} vendas mais recentes de {total}. Estreite o período para ver as demais.</p>}
      </div>
    </div>
  );
}

// ---- Comissão ---------------------------------------------------------------
// ---- Corrida de comissão (Fase G2 — modelo da planilha CARIOCA) -------------
// Faixas NÃO cumulativas sobre a cota individual, P.A, corrida semanal por
// ranking da loja, desvio de cota da rede e o bloco do gerente. Tudo derivado
// na hora (nada persiste até "Gerar prévia", que cria o run draft da Fase G).
const pct = (n: any) => (n == null ? '—' : `${Number(n).toFixed(Math.abs(Number(n)) % 1 ? 1 : 0)}%`);
const QUOTA_SRC: Record<string, string> = { explicit: 'cadastrada', schedule: 'da escala', none: 'sem cota' };
// Labels das dimensões do Ranking da Rede (Fase G3) — casam com as chaves do
// service (`monthlySales`, `monthlyPa`, `monthlyPieces`, `bestWeekSales`,
// `bestFortnightSales`). Manter em sincronia se novas dimensões surgirem.
const CHAMP_LABELS: Record<string, string> = {
  monthlySales: 'Vendas do mês',
  monthlyPa: 'P.A',
  monthlyPieces: 'Peças',
  bestWeekSales: 'Melhor semana',
  bestFortnightSales: 'Melhor quinzena',
};
const CHAMP_ICON: Record<string, string> = { monthlySales: '💰', monthlyPa: '🎯', monthlyPieces: '📦', bestWeekSales: '⚡', bestFortnightSales: '🔥' };

function TierEditor({ label, tiers, onChange, minLabel }: { label: string; tiers: any[]; onChange: (t: any[]) => void; minLabel?: string }) {
  const set = (i: number, k: 'min' | 'percent', v: string) => {
    const next = tiers.map((t, j) => (j === i ? { ...t, [k]: v === '' ? '' : Number(v) } : t));
    onChange(next);
  };
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-zinc-300">{label}</span>
        <button onClick={() => onChange([...tiers, { min: 1, percent: 1 }])} className="text-[11px] text-indigo-300 hover:text-indigo-200">+ faixa</button>
      </div>
      {tiers.map((t, i) => (
        <div key={i} className="mb-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
          <span>{minLabel || 'atingiu'}</span>
          <input type="number" step="0.05" value={t.min} onChange={e => set(i, 'min', e.target.value)} className="w-16 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-zinc-100" />
          <span>× a cota →</span>
          <input type="number" step="0.1" value={t.percent} onChange={e => set(i, 'percent', e.target.value)} className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-zinc-100" />
          <span>%</span>
          <button onClick={() => onChange(tiers.filter((_, j) => j !== i))} className="ml-auto text-zinc-600 hover:text-red-300"><X className="w-3 h-3" /></button>
        </div>
      ))}
      <p className="text-[10px] text-zinc-600">Não cumulativo: vale a MAIOR faixa alcançada (1 = 100% da cota).</p>
    </div>
  );
}

function RacePlanModal({ stores, onClose }: { stores: any[]; onClose: () => void }) {
  const [storeId, setStoreId] = useState('');
  const [plan, setPlan] = useState<any | null>(null);
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);
  const load = async (sid: string) => {
    const d = await apiFetch(`/api/retailops/commission/plan${sid ? `?storeId=${sid}` : ''}`).then(r => r.json()).catch(() => null);
    if (d?.plan) {
      // Plano antigo salvo antes da Fase G3 não tem `networkChampions` — normaliza
      // aqui pra evitar leituras em objeto undefined nos inputs.
      const p = JSON.parse(JSON.stringify(d.plan));
      p.seller = p.seller || {};
      p.seller.networkChampions = p.seller.networkChampions || {};
      const nc = p.seller.networkChampions;
      for (const k of ['monthlySales', 'monthlyPa', 'monthlyPieces', 'bestWeekSales', 'bestFortnightSales']) {
        if (!Array.isArray(nc[k])) nc[k] = [0, 0, 0];
        while (nc[k].length < 3) nc[k].push(0);
      }
      if (nc.minAttendancesForPa == null) nc.minAttendancesForPa = 20;
      setPlan(p); setSource(d.source);
    }
  };
  useEffect(() => { load(storeId); /* eslint-disable-next-line */ }, [storeId]);
  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/retailops/commission/plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId: storeId || null, config: plan }) });
      if (res.ok) { toast.success(storeId ? 'Plano da loja salvo.' : 'Plano da rede salvo.'); onClose(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao salvar o plano.'); }
    } finally { setSaving(false); }
  };
  const num = (path: string[], v: string) => {
    setPlan((p: any) => {
      const next = JSON.parse(JSON.stringify(p));
      let o = next; for (const k of path.slice(0, -1)) o = o[k];
      o[path[path.length - 1]] = v === '' ? 0 : Number(v);
      return next;
    });
  };
  const get = (path: string[]) => path.reduce((o, k) => o?.[k], plan);
  const NumField = ({ label, path, step = 1 }: { label: string; path: string[]; step?: number }) => (
    <label className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">{label}
      <input type="number" step={step} value={get(path) ?? 0} onChange={e => num(path, e.target.value)} className="w-20 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-zinc-100" />
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-4" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Configurar a corrida</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
        </div>
        <div className="mb-3 flex items-center gap-2">
          <select value={storeId} onChange={e => setStoreId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
            <option value="">Rede toda (padrão)</option>
            {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span className="text-[11px] text-zinc-500">plano em uso: {source === 'store' ? 'próprio da loja' : source === 'network' ? 'da rede' : 'padrão (planilha CARIOCA)'}</span>
        </div>
        {!plan ? <div className="text-sm text-zinc-500">Carregando…</div> : (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-indigo-300">Vendedor</div>
              <TierEditor label="Faixas MENSAIS sobre a venda do vendedor" tiers={plan.seller.monthlyTiers} onChange={t => setPlan({ ...plan, seller: { ...plan.seller, monthlyTiers: t } })} />
              <NumField label="P.A mínimo (mensal)" path={['seller', 'monthlyPa', 'min']} step={0.1} />
              <NumField label="Bônus P.A mensal (R$)" path={['seller', 'monthlyPa', 'amount']} />
              <TierEditor label="Faixas do 1º da SEMANA (com cota)" tiers={plan.seller.weeklyFirstTiers} onChange={t => setPlan({ ...plan, seller: { ...plan.seller, weeklyFirstTiers: t } })} />
              <NumField label="Bônus P.A semanal (R$)" path={['seller', 'weeklyFirstPa', 'amount']} />
              <NumField label="% do 2º da semana (com cota)" path={['seller', 'weeklySecondPercent']} step={0.1} />
              <NumField label="Desvio da rede — 1º (R$)" path={['seller', 'networkDeviationPrizes', '0']} />
              <NumField label="Desvio da rede — 2º (R$)" path={['seller', 'networkDeviationPrizes', '1']} />
              <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2">
                <div className="text-[11px] font-semibold text-amber-200 mb-1">🏆 Campeões da Rede (podium 1º/2º/3º)</div>
                <p className="text-[10px] text-zinc-500 mb-2">Prêmio extra para quem lidera cada ranking da REDE (todas as lojas). Só entra quem bateu a própria cota do mês. Deixe 0 pra desativar uma posição.</p>
                {[
                  { key: 'monthlySales', label: 'Vendas do mês' },
                  { key: 'monthlyPa', label: 'P.A do mês' },
                  { key: 'monthlyPieces', label: 'Peças do mês' },
                  { key: 'bestWeekSales', label: 'Melhor semana' },
                  { key: 'bestFortnightSales', label: 'Melhor quinzena' },
                ].map(dim => (
                  <div key={dim.key} className="mb-1 grid grid-cols-[1fr_auto_auto_auto] gap-1 items-center">
                    <span className="text-[11px] text-zinc-400">{dim.label}</span>
                    <NumField label="1º" path={['seller', 'networkChampions', dim.key, '0']} />
                    <NumField label="2º" path={['seller', 'networkChampions', dim.key, '1']} />
                    <NumField label="3º" path={['seller', 'networkChampions', dim.key, '2']} />
                  </div>
                ))}
                <NumField label="P.A — mínimo de atendimentos para elegibilidade" path={['seller', 'networkChampions', 'minAttendancesForPa']} />
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-300">Gerente</div>
              <TierEditor label="Faixas MENSAIS sobre a venda da LOJA" tiers={plan.manager.storeMonthlyTiers} onChange={t => setPlan({ ...plan, manager: { ...plan.manager, storeMonthlyTiers: t } })} />
              <p className="text-[10px] text-zinc-600 -mt-1">Uma faixa com “atingiu 0” paga com ou sem cota batida (o 1% do padrão).</p>
              <TierEditor label="Faixas MENSAIS sobre a venda PRÓPRIA do gerente" tiers={plan.manager.ownMonthlyTiers} onChange={t => setPlan({ ...plan, manager: { ...plan.manager, ownMonthlyTiers: t } })} />
              <NumField label="Bônus P.A mensal da loja (R$)" path={['manager', 'monthlyPa', 'amount']} />
              <TierEditor label="Faixas SEMANAIS sobre a LOJA (com cota)" tiers={plan.manager.weeklyStoreTiers} onChange={t => setPlan({ ...plan, manager: { ...plan.manager, weeklyStoreTiers: t } })} />
              <TierEditor label="Faixas SEMANAIS sobre a venda própria" tiers={plan.manager.weeklyOwnTiers} onChange={t => setPlan({ ...plan, manager: { ...plan.manager, weeklyOwnTiers: t } })} />
              <NumField label="Bônus P.A semanal da loja (R$)" path={['manager', 'weeklyPa', 'amount']} />
              <NumField label="Desvio entre lojas — 1º (R$)" path={['manager', 'networkDeviationPrizes', '0']} />
              <NumField label="Desvio entre lojas — 2º (R$)" path={['manager', 'networkDeviationPrizes', '1']} />
            </div>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving || !plan} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? 'Salvando…' : (storeId ? 'Salvar plano da loja' : 'Salvar plano da rede')}</button>
        </div>
      </div>
    </div>
  );
}

function RaceSection({ stores }: { stores: any[] }) {
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [storeId, setStoreId] = useState('');
  const [race, setRace] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [planModal, setPlanModal] = useState(false);
  const [openWeeks, setOpenWeeks] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ month });
      if (storeId) params.set('storeId', storeId);
      const d = await apiFetch(`/api/retailops/commission/race?${params}`).then(r => r.json()).catch(() => null);
      if (d && !d.error) setRace(d); else toast.error(d?.error || 'Falha ao apurar a corrida.');
    } finally { setLoading(false); }
  };
  const createRun = async () => {
    if (!window.confirm(`Gerar a PRÉVIA da corrida de ${month}? A aprovação continua manual (nada é pago automaticamente).`)) return;
    setRunning(true);
    try {
      const res = await apiFetch('/api/retailops/commission/race/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) toast.success(`Prévia da corrida criada (${brl(d.total_commission)}) — aprove na lista de apurações abaixo.`);
      else toast.error(d.error || 'Falha ao gerar a prévia.');
    } finally { setRunning(false); }
  };

  return (
    <div className="mb-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><TrendingUp className="w-4 h-4 text-indigo-400" /> Corrida do mês (cota + P.A + semanal + desvio)</div>
        <input type="month" value={month} onChange={e => setMonth(e.target.value.slice(0, 7))} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" />
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100">
          <option value="">Todas as lojas</option>
          {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Apurar</button>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setPlanModal(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><Pencil className="w-3.5 h-3.5" /> Configurar corrida</button>
          {race && <button onClick={createRun} disabled={running} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"><Plus className="w-3.5 h-3.5" /> Gerar prévia p/ aprovação</button>}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">O padrão da sua planilha: bateu a cota 1% · +10% 1,5% · +20% 2% · +30% 3% (vale a maior) · P.A ≥ 2,50 com cota · 1º/2º da semana · desvio de cota da rede · bloco do gerente. Cota individual vem do cadastro semanal ou da escala (cota da loja ÷ escalados). Ajuste tudo em “Configurar corrida”.</p>

      {race && race.stores.map((sr: any) => (
        <div key={sr.storeId} className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">{sr.storeName}</span>
            <StoreQuotaSummary quota={sr.store.quota} realized={sr.store.sales} compact />
            <span className="ml-auto text-[11px] text-zinc-400">vendedores <strong className="text-emerald-300">{brl(sr.totals.sellers)}</strong>{sr.manager ? <> · gerente <strong className="text-emerald-300">{brl(sr.totals.manager)}</strong></> : null}</span>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-zinc-500">
                <tr className="text-left">
                  <th className="px-2 py-1 font-medium">Vendedor</th>
                  <th className="px-2 py-1 font-medium text-right">Cota</th>
                  <th className="px-2 py-1 font-medium text-right">Venda</th>
                  <th className="px-2 py-1 font-medium text-right">Ating.</th>
                  <th className="px-2 py-1 font-medium text-right">Faixa</th>
                  <th className="px-2 py-1 font-medium text-right">Mensal</th>
                  <th className="px-2 py-1 font-medium text-right" title="Peças ÷ atendimentos">P.A</th>
                  <th className="px-2 py-1 font-medium text-right">Semanal</th>
                  <th className="px-2 py-1 font-medium text-right" title="Prêmio de desvio de cota da rede">Desvio</th>
                  <th className="px-2 py-1 font-medium text-right" title="Prêmio de campeão da rede (podium multi-dimensional)">Ranking</th>
                  <th className="px-2 py-1 font-medium text-right">Total</th>
                  <th className="px-2 py-1 font-medium text-right" title="Dias escalados / folgas na escala do mês">Escala</th>
                </tr>
              </thead>
              <tbody>
                {sr.monthly.map((s: any) => (
                  <tr key={s.sellerKey} className="border-t border-zinc-800/60">
                    <td className="px-2 py-1 text-zinc-200">{s.sellerName}</td>
                    <td className="px-2 py-1 text-right text-zinc-300">
                      {s.quotaSource === 'none' ? <span className="text-amber-300" title="Sem cota cadastrada nem escala — prêmios condicionados à cota não saem">sem cota</span> : <span title={QUOTA_SRC[s.quotaSource]}>{brl(s.quota)}</span>}
                    </td>
                    <td className="px-2 py-1 text-right text-zinc-200">{brl(s.sales)}</td>
                    <td className={`px-2 py-1 text-right ${s.quotaHit ? 'text-emerald-300' : 'text-zinc-400'}`}>{s.attainment == null ? '—' : `${s.attainment}%`}</td>
                    <td className="px-2 py-1 text-right text-zinc-300">{pct(s.tierPercent)}</td>
                    <td className="px-2 py-1 text-right text-zinc-200">{brl(s.tierAmount)}</td>
                    <td className="px-2 py-1 text-right text-zinc-300">{s.at > 0 ? <>{s.pa.toFixed(2)}{s.paBonus > 0 && <span className="text-emerald-300"> +{brl(s.paBonus)}</span>}</> : '—'}</td>
                    <td className="px-2 py-1 text-right text-zinc-200">{brl(s.weeklyTotal)}</td>
                    <td className="px-2 py-1 text-right">{s.deviationPrize > 0 ? <span className="text-emerald-300">{brl(s.deviationPrize)}</span> : '—'}</td>
                    <td className="px-2 py-1 text-right">{(s.championPrize || 0) > 0 ? <span className="text-amber-300" title={(s.championWins || []).map((w: any) => `${w.rank}º ${CHAMP_LABELS[w.dimension] || w.dimension}: ${brl(w.prize)}`).join(' · ')}>{brl(s.championPrize)}</span> : '—'}</td>
                    <td className="px-2 py-1 text-right font-semibold text-emerald-300">{brl(s.total)}</td>
                    <td className="px-2 py-1 text-right text-zinc-500">{s.scheduledDays > 0 || s.offDays > 0 ? `${s.scheduledDays}d / ${s.offDays}f` : '—'}</td>
                  </tr>
                ))}
                {sr.monthly.length === 0 && <tr><td colSpan={12} className="px-2 py-3 text-center text-zinc-500">Sem vendas, escala nem cotas no mês pra esta loja.</td></tr>}
              </tbody>
            </table>
          </div>

          {sr.manager && (
            <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-zinc-300">
              <span className="font-medium text-emerald-200">Gerente — {sr.manager.name}:</span>{' '}
              loja {pct(sr.manager.storeTierPercent)} = {brl(sr.manager.storeTierAmount)}{!sr.manager.storeQuotaHit && sr.manager.storeTierPercent > 0 ? ' (sem cota — só a faixa base)' : ''}
              {' · '}venda própria {pct(sr.manager.ownTierPercent)} = {brl(sr.manager.ownTierAmount)}
              {' · '}P.A da loja {sr.manager.storePa ? sr.manager.storePa.toFixed(2) : '—'}{sr.manager.paBonus > 0 ? ` +${brl(sr.manager.paBonus)}` : ''}
              {' · '}semanal {brl(sr.manager.weeklyTotal)}
              {sr.manager.deviationPrize > 0 ? <> · desvio entre lojas <span className="text-emerald-300">{brl(sr.manager.deviationPrize)}</span></> : null}
              {' · '}<span className="font-semibold text-emerald-300">total {brl(sr.manager.total)}</span>
            </div>
          )}

          <button onClick={() => setOpenWeeks(p => ({ ...p, [sr.storeId]: !p[sr.storeId] }))} className="mt-2 text-[11px] text-indigo-300 hover:text-indigo-200">
            {openWeeks[sr.storeId] ? '▾ Esconder as semanas' : '▸ Ver a corrida semana a semana'}
          </button>
          {openWeeks[sr.storeId] && sr.weeks.map((w: any) => (
            <div key={w.start} className="mt-2 rounded border border-zinc-800/70 p-2">
              <div className="text-[11px] text-zinc-400">{w.start.slice(8)}/{w.start.slice(5, 7)} → {w.end.slice(8)}/{w.end.slice(5, 7)} · loja {brl(w.storeSales)} / cota {brl(w.storeQuota)}</div>
              <div className="mt-1 grid gap-1">
                {w.sellers.filter((s: any) => s.sales > 0 || s.quota > 0).map((s: any) => (
                  <div key={s.sellerKey} className="flex items-center gap-2 text-[11px]">
                    <span className={`w-6 text-right ${s.rank <= 2 ? 'text-amber-300' : 'text-zinc-600'}`}>{s.rank}º</span>
                    <span className="text-zinc-300 min-w-24">{s.sellerName}</span>
                    <span className="text-zinc-400">{brl(s.sales)}</span>
                    <span className="text-zinc-600">/ {s.quotaSource === 'none' ? 'sem cota' : brl(s.quota)}</span>
                    {s.pa > 0 && <span className="text-zinc-600">P.A {s.pa.toFixed(2)}</span>}
                    {s.prize.total > 0 && <span className="ml-auto text-emerald-300">{pct(s.prize.percent)} → {brl(s.prize.total)}</span>}
                    {s.prize.total === 0 && s.rank <= 2 && s.prize.reasons.length > 0 && <span className="ml-auto text-amber-300/80">{s.prize.reasons.includes('sem_cota') ? 'sem cota cadastrada' : 'cota não batida'}</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}

      {race && !storeId && (race.networkDeviation.sellers.length > 0 || race.networkDeviation.stores.length > 0) && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-zinc-300">
          <span className="font-medium text-amber-200">Desvio de cota da rede:</span>{' '}
          {race.networkDeviation.sellers.map((s: any, i: number) => (
            <span key={s.sellerKey}>{i > 0 && ' · '}{i + 1}º {s.sellerName} ({s.storeName}) +{s.attainment - 100 > 0 ? Math.round((s.attainment - 100) * 10) / 10 : 0}%{s.prize > 0 ? ` → ${brl(s.prize)}` : ''}</span>
          ))}
          {race.networkDeviation.stores.length > 0 && <span className="text-zinc-500"> | Lojas: {race.networkDeviation.stores.map((s: any, i: number) => `${i + 1}º ${s.storeName} (+${s.deviation}%)${s.prize > 0 ? ` → ${brl(s.prize)}` : ''}`).join(' · ')}</span>}
        </div>
      )}

      {race && !storeId && race.networkChampions && Object.keys(CHAMP_LABELS).some(k => (race.networkChampions[k] || []).some((p: any) => p.prize > 0)) && (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-amber-500/0 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-200">
            🏆 Campeões da Rede
            <span className="text-[10px] font-normal text-zinc-500">só vendedor com cota do mês batida; P.A exige ≥ {race.networkChampions.minAttendancesForPa || 0} atendimentos</span>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {Object.keys(CHAMP_LABELS).map((dim) => {
              const podium = (race.networkChampions[dim] || []) as any[];
              if (!podium.some((p) => p.prize > 0)) return null;
              const fmt = (v: number) => dim === 'monthlyPa' ? v.toFixed(2) : dim === 'monthlyPieces' ? String(v) : brl(v);
              return (
                <div key={dim} className="rounded-lg border border-amber-500/20 bg-zinc-950/40 p-2">
                  <div className="text-[11px] font-medium text-amber-200">{CHAMP_ICON[dim]} {CHAMP_LABELS[dim]}</div>
                  {podium.filter(p => p.prize > 0).map((p) => (
                    <div key={p.rank} className="mt-1 flex items-center gap-2 text-[11px]">
                      <span className={`w-5 text-right ${p.rank === 1 ? 'text-amber-300 font-semibold' : p.rank === 2 ? 'text-zinc-300' : 'text-zinc-500'}`}>{p.rank}º</span>
                      <span className="min-w-0 flex-1 truncate text-zinc-200" title={`${p.sellerName} — ${p.storeName}`}>{p.sellerName}</span>
                      <span className="text-zinc-500 text-[10px]">{fmt(p.metric)}</span>
                      <span className="text-emerald-300 font-medium">{brl(p.prize)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {race && <div className="mt-2 text-right text-sm text-zinc-300">Total da corrida: <span className="font-semibold text-emerald-300">{brl(race.totals.grand)}</span> <span className="text-zinc-500">(vendedores {brl(race.totals.sellers)} · gerentes {brl(race.totals.managers)})</span></div>}
      {planModal && <RacePlanModal stores={stores} onClose={() => setPlanModal(false)} />}
    </div>
  );
}

// Painel "Corte das semanas do mês" (Fase G2c) — override rede-wide do
// weeksOfMonth. Sem override, cai no padrão CARIOCA (semana no domingo,
// fusão < 4 dias). O grid mostra as semanas efetivas com edição inline.
function MonthWeeksPanel() {
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [defaultWeeks, setDefaultWeeks] = useState<any[]>([]);
  const [override, setOverride] = useState<any[] | null>(null);
  const [source, setSource] = useState<string>('default');
  const [draft, setDraft] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const load = () => {
    apiFetch(`/api/retailops/month-weeks?month=${month}`).then(r => r.json()).then(d => {
      setDefaultWeeks(Array.isArray(d?.defaultWeeks) ? d.defaultWeeks : []);
      setOverride(Array.isArray(d?.override) ? d.override : null);
      setSource(d?.source || 'default');
      setDraft(Array.isArray(d?.effective) ? d.effective : []);
    }).catch(() => {});
  };
  useEffect(() => { if (open) load(); /* eslint-disable-next-line */ }, [open, month]);
  const save = async () => {
    setSaving(true);
    try {
      // Se o draft está idêntico ao default, envia vazio = limpa o override.
      const same = draft.length === defaultWeeks.length && draft.every((w, i) => w.start === defaultWeeks[i]?.start && w.end === defaultWeeks[i]?.end);
      const payload = same ? [] : draft;
      const res = await apiFetch('/api/retailops/month-weeks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month, weeks: payload }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(payload.length > 0 ? `Corte gravado — ${payload.length} semana(s).` : 'Override removido — voltou ao padrão CARIOCA.'); load(); }
      else toast.error(d.error || 'Falha ao salvar o corte das semanas.');
    } finally { setSaving(false); }
  };
  const resetToDefault = () => setDraft(defaultWeeks.map(w => ({ ...w })));
  const setField = (i: number, k: 'start' | 'end', v: string) => setDraft(p => p.map((w, j) => j === i ? { ...w, [k]: v } : w));
  const addWeek = () => setDraft(p => [...p, { start: '', end: '' }]);
  const removeWeek = (i: number) => setDraft(p => p.filter((_, j) => j !== i));
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
        <ChevronRight className="w-3.5 h-3.5" /> Corte das semanas do mês (padrão CARIOCA ou personalizado)
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300"><ChevronDown className="w-4 h-4" /></button>
        <span className="text-sm font-medium text-zinc-200">Corte das semanas do mês</span>
        <input type="month" value={month} onChange={e => setMonth(e.target.value.slice(0, 7))} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" />
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${source === 'override' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
          {source === 'override' ? 'personalizado' : 'padrão CARIOCA'}
        </span>
        <button onClick={resetToDefault} className="ml-auto rounded-lg border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800">Voltar ao padrão</button>
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Salvar corte
        </button>
      </div>
      <p className="mb-2 text-[10px] text-zinc-500">
        Padrão CARIOCA: semana fecha no domingo, começo de mês curto (&lt; 4 dias) cola na semana seguinte. Se sua rede corta diferente ("sem1 01→10, sem2 11→18…"), edite aqui. As semanas precisam cobrir 01 até o último dia do mês, sem lacunas nem sobreposição. Vale pra rede toda (corridas, cotas semanais e ranking usam esses cortes).
      </p>
      <div className="space-y-1">
        {draft.map((w, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <span className="w-16 text-zinc-500">Sem. {i + 1}</span>
            <input type="date" value={w.start || ''} onChange={e => setField(i, 'start', e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-100" />
            <span className="text-zinc-600">→</span>
            <input type="date" value={w.end || ''} onChange={e => setField(i, 'end', e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-100" />
            <button onClick={() => removeWeek(i)} className="ml-1 text-zinc-600 hover:text-red-300"><X className="w-3.5 h-3.5" /></button>
          </div>
        ))}
        <button onClick={addWeek} className="mt-1 text-[11px] text-indigo-300 hover:text-indigo-200">+ semana</button>
      </div>
    </div>
  );
}

// Painel "Templates de folga" (Fase G2b) — cadastra os dias fixos de folga
// por vendedor + botão "Aplicar no mês" que preenche a grade sem sobrescrever
// datas já lançadas (RN-G2b-001).
const DOW_SHORT = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
function OffPatternPanel({ storeId, sellers, keyOf, onApplied }: { storeId: string; sellers: any[]; keyOf: (s: any) => string; onApplied: () => void }) {
  // matrix[sellerKey][dow] = boolean
  const [matrix, setMatrix] = useState<Record<string, boolean[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [open, setOpen] = useState(false);
  const [applyMonth, setApplyMonth] = useState(() => todayStr().slice(0, 7));
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiFetch(`/api/retailops/schedule/off-pattern?storeId=${storeId}`).then(r => r.json()).then(d => {
      const m: Record<string, boolean[]> = {};
      for (const s of sellers) m[keyOf(s)] = Array(7).fill(false);
      for (const p of (d?.patterns || [])) {
        if (!m[p.sellerKey]) m[p.sellerKey] = Array(7).fill(false);
        for (const dw of p.daysOfWeek || []) m[p.sellerKey][dw] = true;
      }
      setMatrix(m);
    }).finally(() => setLoading(false));
    // eslint-disable-next-line
  }, [open, storeId, sellers.length]);
  const toggle = (sk: string, dow: number) => setMatrix(p => {
    const cur = p[sk] || Array(7).fill(false);
    const nxt = [...cur]; nxt[dow] = !nxt[dow];
    return { ...p, [sk]: nxt };
  });
  const save = async () => {
    setSaving(true);
    try {
      const patterns = sellers.map(s => {
        const sk = keyOf(s);
        const row = matrix[sk] || [];
        const dows = row.map((v, i) => v ? i : -1).filter(i => i >= 0);
        return { sellerKey: sk, sellerName: s.name || null, daysOfWeek: dows };
      }).filter(p => p.daysOfWeek.length > 0);
      const res = await apiFetch('/api/retailops/schedule/off-pattern', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, patterns }) });
      if (res.ok) toast.success('Template de folga salvo.');
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao salvar.'); }
    } finally { setSaving(false); }
  };
  const apply = async () => {
    if (!/^\d{4}-\d{2}$/.test(applyMonth)) return;
    // Aplica no mês inteiro (dia 01 até o último). O service pula datas já lançadas.
    const [y, mo] = applyMonth.split('-').map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const start = `${applyMonth}-01`;
    const end = `${applyMonth}-${String(last).padStart(2, '0')}`;
    if (!window.confirm(`Aplicar o template no mês ${applyMonth}? Dias já lançados na grade não são sobrescritos.`)) return;
    setApplying(true);
    try {
      const res = await apiFetch('/api/retailops/schedule/apply-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, start, end }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`${d.inserted || 0} folga(s) inserida(s) · ${d.skipped || 0} já existiam.`); onApplied(); }
      else toast.error(d.error || 'Falha ao aplicar o template.');
    } finally { setApplying(false); }
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
        <ChevronRight className="w-3.5 h-3.5" /> Templates de folga (Rafaela sempre segunda, Estefânio sempre terça…)
      </button>
    );
  }
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-zinc-300"><ChevronDown className="w-4 h-4" /></button>
        <span className="text-sm font-medium text-zinc-200">Templates de folga</span>
        <span className="text-[11px] text-zinc-500">marca os dias fixos de folga por vendedor</span>
        <input type="month" value={applyMonth} onChange={e => setApplyMonth(e.target.value)} className="ml-auto bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" />
        <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Salvar template</button>
        <button onClick={apply} disabled={applying} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CalendarDays className="w-3.5 h-3.5" />} Aplicar no mês</button>
      </div>
      <p className="mb-2 text-[10px] text-zinc-600">"Aplicar no mês" preenche a grade com as folgas do template — NUNCA sobrescreve datas já lançadas. Salvar o template não mexe na grade (só grava o padrão pra usar).</p>
      {loading ? (
        <div className="py-4 text-center text-xs text-zinc-500"><Loader2 className="inline w-4 h-4 animate-spin" /> Carregando…</div>
      ) : sellers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
          Sem vendedores cadastrados nessa loja ainda — o template precisa saber quem folga.<br />
          Cadastre a equipe em <strong>Comissão › Vendas por vendedor (PDV)</strong> ou no módulo <strong>Atendimento de Loja</strong>, depois volte aqui.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800/70">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/60 text-zinc-500">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Vendedor</th>
                {DOW_SHORT.map((d, i) => <th key={i} className="px-2 py-1.5 text-center font-medium">{d}</th>)}
              </tr>
            </thead>
            <tbody>
              {sellers.map((s: any) => {
                const sk = keyOf(s);
                const row = matrix[sk] || Array(7).fill(false);
                return (
                  <tr key={sk} className="border-t border-zinc-800/70">
                    <td className="px-3 py-1 text-zinc-200">{s.name || `Matrícula ${s.matricula}`}</td>
                    {row.map((v, i) => (
                      <td key={i} className="px-2 py-1 text-center">
                        <input type="checkbox" checked={!!v} onChange={() => toggle(sk, i)} className="accent-red-500" />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Card "escala do dia" (Fase G2b) — reusável em ScheduleTab e ClosingsTab.
// Agrupa POR LOJA: quem TRABALHA (verde) e quem FOLGA (vermelho) hoje, mais
// uma linha compacta de quem folga amanhã. Com muitas lojas, a lista chapada
// virava um paredão de nomes — por isso cada loja é um bloco com seu nome no
// topo. Dados vêm de /schedule/day-roster (hoje) e /schedule/who-off (amanhã).
function WhoIsOffCard({ storeId, className = '' }: { storeId?: string | null; className?: string }) {
  const [stores, setStores] = useState<any[]>([]);
  const [tomorrow, setTomorrow] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const todayIso = todayStr();
  const tomorrowIso = new Date(Date.parse(todayIso + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  useEffect(() => {
    setLoading(true);
    const qs = (d: string) => `date=${d}${storeId ? `&storeId=${storeId}` : ''}`;
    Promise.all([
      apiFetch(`/api/retailops/schedule/day-roster?${qs(todayIso)}`).then(r => r.json()).catch(() => ({})),
      apiFetch(`/api/retailops/schedule/who-off?${qs(tomorrowIso)}`).then(r => r.json()).catch(() => ({})),
    ]).then(([t, m]) => {
      setStores(Array.isArray(t?.stores) ? t.stores : []);
      setTomorrow(Array.isArray(m?.sellers) ? m.sellers : []);
    }).finally(() => setLoading(false));
    // eslint-disable-next-line
  }, [storeId, todayIso]);
  if (loading) return null;

  // Uma pessoa (verde=trabalha, vermelho=folga). `tmpl` marca quem veio do
  // template e ainda não foi lançado na grade.
  const person = (s: any, tone: 'work' | 'off', i: number) => (
    <span key={`${s.sellerKey}-${i}`} className="inline-flex items-center gap-1">
      {i > 0 && <span className="text-zinc-700">·</span>}
      <span className={tone === 'work' ? 'text-emerald-300' : 'text-red-300'}>{s.sellerName || s.sellerKey}</span>
      {s.source === 'template' && <span className="text-[9px] text-zinc-600" title="Vem do template — ainda não foi lançado na grade">tmpl</span>}
    </span>
  );
  const line = (label: string, dot: string, color: string, list: any[], tone: 'work' | 'off') => (
    <div className="flex items-baseline gap-1.5 flex-wrap">
      <span className={`text-[11px] ${color}`}>{dot} {label}</span>
      {list.length === 0
        ? <span className="text-zinc-600 text-[11px]">ninguém</span>
        : list.map((s, i) => person(s, tone, i))}
    </div>
  );

  return (
    <div className={`rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-3 py-2 text-[12px] ${className}`}>
      <div className="font-medium text-zinc-300 mb-1.5">📅 Escala de hoje</div>
      {stores.length === 0 ? (
        <div className="text-zinc-500 text-[11px]">Nenhuma escala lançada para hoje.</div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {stores.map((st) => (
            <div key={st.storeId} className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-2">
              <div className="text-[11px] font-semibold text-zinc-200 mb-1 truncate" title={st.storeName || ''}>
                🏬 {st.storeName || 'Loja'}
              </div>
              {line('Trabalhando', '🟢', 'text-emerald-400', st.working || [], 'work')}
              {line('Folga', '🔴', 'text-red-400', st.off || [], 'off')}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 pt-1.5 border-t border-zinc-800 flex items-baseline gap-1.5 flex-wrap">
        <span className="text-[11px] text-zinc-500">🌙 Folga amanhã</span>
        {tomorrow.length === 0
          ? <span className="text-zinc-600 text-[11px]">ninguém</span>
          : tomorrow.map((s: any, i: number) => (
            <span key={`${s.storeId}-${s.sellerKey}-${i}`} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-zinc-700">·</span>}
              <span className="text-zinc-300 text-[11px]">{s.sellerName || s.sellerKey}</span>
              {!storeId && s.storeName && <span className="text-[10px] text-zinc-600">({s.storeName})</span>}
            </span>
          ))}
      </div>
    </div>
  );
}

// ---- Escala semanal + cotas por vendedor (Fase G2) --------------------------
function ScheduleTab() {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [allSellers, setAllSellers] = useState<any[]>([]);   // todos mapeados (fallback + adicionar)
  const [roster, setRoster] = useState<any[]>([]);           // lotados na loja (Fatia 2A)
  const [orgUsesAssignments, setOrgUsesAssignments] = useState(false);
  const [extra, setExtra] = useState<Record<string, string[]>>({}); // por loja: matrículas add "de outra loja"
  // Semana exibida na grade (domingo → sábado).
  const [weekStart, setWeekStart] = useState(() => sundayOf(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const DOW = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  // grade[date][sellerKey] = 'work' | 'off' | undefined
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  // Cotas semanais do mês (semanas da CORRIDA — podem colar o começo quebrado).
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [raceWeeks, setRaceWeeks] = useState<any[]>([]);
  const [quotaGrid, setQuotaGrid] = useState<Record<string, Record<string, string>>>({}); // [weekStart][sellerKey] = valor
  const [savingQuotas, setSavingQuotas] = useState(false);

  useEffect(() => {
    (async () => {
      const [st, se] = await Promise.all([
        apiFetch('/api/retailops/stores').then(r => r.json()).catch(() => ({})),
        apiFetch('/api/retailops/sellers').then(r => r.json()).catch(() => ({})),
      ]);
      const ss = Array.isArray(st?.stores) ? st.stores : [];
      setStores(ss);
      if (ss.length && !storeId) setStoreId(ss[0].id);
      setAllSellers(Array.isArray(se?.sellers) ? se.sellers.filter((x: any) => x.active !== 0) : []);
    })();
    // eslint-disable-next-line
  }, []);

  // SELL-006: roster da loja (lotação da Fatia 2A). A escala mostra os LOTADOS
  // (+ os add "de outra loja"); só cai em "todos mapeados" quando a org ainda
  // não usa lotação (0-regressão).
  useEffect(() => {
    if (!storeId) return;
    apiFetch(`/api/retailops/seller-coverage?storeId=${storeId}`).then(r => r.ok ? r.json() : null).then(d => {
      setRoster(Array.isArray(d?.lotados) ? d.lotados : []);
      setOrgUsesAssignments(!!d?.orgUsesAssignments);
    }).catch(() => { setRoster([]); setOrgUsesAssignments(false); });
  }, [storeId]);

  const keyOf = (s: any) => `mat:${s.matricula}`;

  // Lista efetiva de vendedores da escala desta loja.
  const sellers = useMemo(() => {
    const byMat = new Map(allSellers.map((s: any) => [String(s.matricula), s]));
    const extraMats = extra[storeId] || [];
    const base: any[] = roster.length > 0
      ? roster.map((r: any) => ({ matricula: r.matricula, name: r.name, is_primary: r.is_primary }))
      : (orgUsesAssignments ? [] : allSellers); // sem lotação na org → legado
    const seen = new Set(base.map((s: any) => String(s.matricula)));
    const extras = extraMats.filter(m => !seen.has(m)).map(m => { const src: any = byMat.get(m) || { matricula: m, name: null }; return { ...src, _temp: true }; });
    return [...base, ...extras];
  }, [roster, allSellers, orgUsesAssignments, extra, storeId]);
  const addFromOther = (matricula: string) => { if (!matricula) return; setExtra(p => ({ ...p, [storeId]: [...(p[storeId] || []), matricula] })); };

  const loadWeek = async () => {
    if (!storeId) return;
    setLoading(true);
    try {
      const end = addDays(weekStart, 6);
      const d = await apiFetch(`/api/retailops/schedule?storeId=${storeId}&start=${weekStart}&end=${end}`).then(r => r.json()).catch(() => null);
      const g: Record<string, Record<string, string>> = {};
      for (const e of d?.entries || []) { g[e.work_date] = g[e.work_date] || {}; g[e.work_date][e.seller_key] = e.status; }
      setGrid(g);
    } finally { setLoading(false); }
  };
  useEffect(() => { loadWeek(); /* eslint-disable-next-line */ }, [storeId, weekStart]);

  const loadQuotas = async () => {
    if (!storeId) return;
    const d = await apiFetch(`/api/retailops/seller-quotas?storeId=${storeId}&month=${month}`).then(r => r.json()).catch(() => null);
    setRaceWeeks(Array.isArray(d?.weeks) ? d.weeks : []);
    const g: Record<string, Record<string, string>> = {};
    for (const q of d?.quotas || []) { g[q.week_start] = g[q.week_start] || {}; g[q.week_start][q.seller_key] = String(q.quota_amount); }
    setQuotaGrid(g);
  };
  useEffect(() => { loadQuotas(); /* eslint-disable-next-line */ }, [storeId, month]);

  // Clique na célula: (vazio) → trabalha → folga → (vazio).
  const cycle = (date: string, sk: string) => {
    setGrid(p => {
      const cur = p[date]?.[sk];
      const next = { ...p, [date]: { ...(p[date] || {}) } };
      if (!cur) next[date][sk] = 'work';
      else if (cur === 'work') next[date][sk] = 'off';
      else delete next[date][sk];
      return next;
    });
  };

  const saveWeek = async () => {
    setSaving(true);
    try {
      const entries: any[] = [];
      for (const date of days) for (const [sk, status] of Object.entries(grid[date] || {})) {
        const s = sellers.find(x => keyOf(x) === sk);
        entries.push({ date, sellerKey: sk, sellerName: s?.name || sk.replace(/^(mat|nom|user):/, ''), status });
      }
      const res = await apiFetch('/api/retailops/schedule', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, start: weekStart, end: addDays(weekStart, 6), entries }) });
      if (res.ok) toast.success('Escala da semana salva.');
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao salvar a escala.'); }
    } finally { setSaving(false); }
  };
  const copyPrevious = async () => {
    const res = await apiFetch('/api/retailops/schedule/copy-week', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, fromStart: addDays(weekStart, -7), toStart: weekStart }) });
    if (res.ok) { toast.success('Escala copiada da semana anterior.'); loadWeek(); }
    else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao copiar.'); }
  };
  // Importa a escala por FOTO: a IA lê a grade e pré-preenche a semana atual —
  // o gestor CONFERE (clicando nas células) e depois clica "Salvar escala".
  const importPhoto = async (file: File) => {
    if (!file || !storeId) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file); fd.append('storeId', storeId); fd.append('weekStart', weekStart);
      const res = await apiFetch('/api/retailops/schedule/scan', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao ler a escala.'); return; }
      setGrid(prev => {
        const next: Record<string, Record<string, string>> = { ...prev };
        for (const [date, row] of Object.entries(d.grid || {})) next[date] = { ...(next[date] || {}), ...(row as Record<string, string>) };
        return next;
      });
      const unm = Array.isArray(d.unmatched) ? d.unmatched : [];
      toast.success(`Escala lida${d.confidence ? ` (${d.confidence}% de confiança)` : ''}. Confira as células e clique em Salvar escala.${unm.length ? ` Não achei no cadastro: ${unm.join(', ')} — adicione manualmente.` : ''}`);
    } catch { toast.error('Falha ao ler a escala.'); }
    finally { setImporting(false); }
  };

  const saveQuotas = async () => {
    setSavingQuotas(true);
    try {
      for (const w of raceWeeks) {
        const row = quotaGrid[w.start] || {};
        const quotas = Object.entries(row)
          .filter(([, v]) => String(v).trim() !== '')
          .map(([sk, v]) => ({ sellerKey: sk, sellerName: sellers.find(x => keyOf(x) === sk)?.name, amount: Number(v) || 0 }));
        if (!quotas.length) continue;
        const res = await apiFetch('/api/retailops/seller-quotas', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, weekStart: w.start, quotas }) });
        if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao salvar as cotas.'); return; }
      }
      toast.success('Cotas semanais salvas.');
    } finally { setSavingQuotas(false); }
  };

  // Quantos escalados 'work' por dia — o denominador do "cota ÷ escalados".
  const workCount = (date: string) => Object.values(grid[date] || {}).filter(s => s === 'work').length;

  if (!stores.length) return <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">Cadastre as lojas na aba <strong>Comissão</strong> (botão “Nova loja”) pra montar a escala.</p>;

  return (
    <div>
      {storeId && <WhoIsOffCard storeId={storeId} className="mb-3" />}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><CalendarDays className="w-4 h-4 text-indigo-400" /> Escala semanal</div>
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">← semana</button>
        <span className="text-xs text-zinc-400">{days[0].slice(8)}/{days[0].slice(5, 7)} → {days[6].slice(8)}/{days[6].slice(5, 7)}</span>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">semana →</button>
        <div className="ml-auto flex items-center gap-2">
          {/* SELL-006: escalar temporariamente alguém de outra loja */}
          <select value="" onChange={e => { addFromOther(e.target.value); e.currentTarget.value = ''; }} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-300" title="Escalar um vendedor de outra loja nesta semana">
            <option value="">+ de outra loja…</option>
            {allSellers.filter((s: any) => !sellers.some((x: any) => String(x.matricula) === String(s.matricula))).map((s: any) => <option key={s.matricula} value={s.matricula}>{s.name || `Matrícula ${s.matricula}`}</option>)}
          </select>
          <input ref={importRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) importPhoto(f); e.currentTarget.value = ''; }} />
          <button onClick={() => importRef.current?.click()} disabled={importing || !storeId} title="Envie a foto da escala que a loja mandou — a IA lê e pré-preenche a semana" className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/30 px-2.5 py-1.5 text-xs text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50">{importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Importar de foto</button>
          <button onClick={copyPrevious} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">Copiar semana anterior</button>
          <button onClick={saveWeek} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar escala</button>
        </div>
      </div>
      <p className="mb-3 text-[11px] text-zinc-500">Clique na célula pra alternar: <span className="text-emerald-300">trabalha</span> → <span className="text-red-300">folga</span> → vazio. A cota individual derivada usa a cota diária da loja ÷ nº de escalados do dia (o “COTA ÷ 4” da folha de fechamento) quando não há cota semanal cadastrada abaixo.</p>

      {sellers.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          {orgUsesAssignments
            ? <>Nenhum vendedor <strong>lotado nesta loja</strong>. Defina a lotação em <strong>Vendedores da loja</strong>, ou use <strong>“+ de outra loja”</strong> acima para escalar alguém temporariamente.</>
            : <>Nenhum vendedor cadastrado. Associe as matrículas em <strong>Vendedores da loja</strong> (dar nome às matrículas) ou cadastre a equipe no módulo Atendimento de Loja.</>}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Vendedor</th>
                {days.map((d, i) => <th key={d} className="px-2 py-2 text-center font-medium">{DOW[i]}<br /><span className="text-[10px] text-zinc-600">{d.slice(8)}/{d.slice(5, 7)}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {sellers.map((s: any) => {
                const sk = keyOf(s);
                return (
                  <tr key={sk} className="border-t border-zinc-800/70">
                    <td className="px-3 py-1.5 text-zinc-200">
                      {s.name || <span className="text-amber-300/90">Matrícula {s.matricula}</span>}
                      {s.is_primary ? <Store className="inline w-3 h-3 ml-1 text-emerald-400" /> : null}
                      {s._temp ? <span className="ml-1.5 rounded bg-zinc-800 px-1 py-0.5 text-[9px] text-zinc-400">de outra loja</span> : null}
                    </td>
                    {days.map(d => {
                      const st = grid[d]?.[sk];
                      return (
                        <td key={d} className="px-1 py-1 text-center">
                          <button onClick={() => cycle(d, sk)} className={`w-full rounded px-1 py-1 text-[11px] border ${st === 'work' ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : st === 'off' ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-zinc-800 text-zinc-600 hover:bg-zinc-800/60'}`}>
                            {st === 'work' ? 'trabalha' : st === 'off' ? 'folga' : '—'}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-zinc-700 bg-zinc-900/40 text-zinc-400">
                <td className="px-3 py-1.5">Escalados no dia</td>
                {days.map(d => <td key={d} className="px-2 py-1.5 text-center">{workCount(d) || '—'}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {loading && <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando escala…</div>}

      {/* Template de folga (Fase G2b) — cadastra por vendedor os dias fixos
          de folga; botão "Aplicar no mês" preenche a grade sem sobrescrever
          o que já foi lançado. Sempre visível pra loja escolhida — quando
          faltam vendedores, mostra CTA pra cadastrar em vez de sumir. */}
      {storeId && (
        <div className="mt-4">
          <OffPatternPanel storeId={storeId} sellers={sellers} keyOf={keyOf} onApplied={loadWeek} />
        </div>
      )}

      {/* Corte das semanas do mês (Fase G2c) — override rede-wide do padrão
          CARIOCA (fechamento no domingo + fusão de início curto). */}
      <div className="mt-3">
        <MonthWeeksPanel />
      </div>

      {/* Cotas semanais individuais (as semanas da CORRIDA do mês) */}
      <div className="mt-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Calculator className="w-4 h-4 text-emerald-400" /> Cotas semanais por vendedor</div>
          <input type="month" value={month} onChange={e => setMonth(e.target.value.slice(0, 7))} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" />
          <button onClick={saveQuotas} disabled={savingQuotas} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{savingQuotas ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar cotas</button>
        </div>
        <p className="mb-2 text-[11px] text-zinc-500">A cota que cada vendedor precisa bater em cada semana da corrida (a mensal é a soma). Em branco = usa a derivada da escala.</p>
        {sellers.length > 0 && raceWeeks.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900/60 text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Vendedor</th>
                  {raceWeeks.map((w: any) => <th key={w.start} className="px-2 py-2 text-center font-medium">{w.start.slice(8)}/{w.start.slice(5, 7)} → {w.end.slice(8)}/{w.end.slice(5, 7)}</th>)}
                </tr>
              </thead>
              <tbody>
                {sellers.map((s: any) => {
                  const sk = keyOf(s);
                  return (
                    <tr key={sk} className="border-t border-zinc-800/70">
                      <td className="px-3 py-1.5 text-zinc-200">{s.name || `Matrícula ${s.matricula}`}</td>
                      {raceWeeks.map((w: any) => (
                        <td key={w.start} className="px-2 py-1 text-center">
                          <input type="number" step="50" placeholder="—" value={quotaGrid[w.start]?.[sk] ?? ''} onChange={e => setQuotaGrid(p => ({ ...p, [w.start]: { ...(p[w.start] || {}), [sk]: e.target.value } }))} className="w-24 bg-zinc-950 border border-zinc-800 rounded px-1.5 py-1 text-xs text-zinc-100 text-right" />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CommissionTab() {
  const [runs, setRuns] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [ruleForm, setRuleForm] = useState<null | { name: string; scope: string; calculationType: string; percent: string; amount: string; bonus: string; quota: string; storeId: string }>(null);
  const [savingRule, setSavingRule] = useState(false);
  const [stores, setStores] = useState<any[]>([]);
  const firstOfMonth = todayStr().slice(0, 8) + '01';
  const [start, setStart] = useState(firstOfMonth);
  const [end, setEnd] = useState(todayStr());
  const [report, setReport] = useState<any | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const [pdvSellers, setPdvSellers] = useState<any[]>([]);
  const [pdvPct, setPdvPct] = useState<number | null>(null);
  const [sellerSales, setSellerSales] = useState<any[]>([]);
  const [sellerSalesModal, setSellerSalesModal] = useState(false);
  const [editSale, setEditSale] = useState<any | null>(null);
  const [folhaQ, setFolhaQ] = useState('');
  const [nameSeller, setNameSeller] = useState<any | null>(null); // modal "dar nome" (sem window.prompt)

  // Extrato por LOJA e por VENDEDOR ("rodar o comando" do dono da rede):
  // escolhe a loja (ou todas), o vendedor (ou todos) e o período — inclusive
  // parcial dentro do mês, pra saber quanto já acumulou antes do fechamento.
  const [exStoreId, setExStoreId] = useState('');
  const [exSellerKey, setExSellerKey] = useState('');
  const [exStart, setExStart] = useState(firstOfMonth);
  const [exEnd, setExEnd] = useState(todayStr());
  const [extract, setExtract] = useState<any | null>(null);
  const [loadingExtract, setLoadingExtract] = useState(false);
  const applyExShortcut = (kind: 'today' | 'week' | 'fortnight' | 'month') => {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const iso = (dt: Date) => isoLocal(dt);
    if (kind === 'today') { setExStart(iso(now)); setExEnd(iso(now)); }
    else if (kind === 'week') { const monday = new Date(now); monday.setDate(d - ((now.getDay() + 6) % 7)); setExStart(iso(monday)); setExEnd(iso(now)); }
    else if (kind === 'fortnight') { setExStart(iso(new Date(y, m, d <= 15 ? 1 : 16))); setExEnd(iso(now)); }
    else { setExStart(iso(new Date(y, m, 1))); setExEnd(iso(now)); }
  };
  const generateExtract = async (opts?: { keepSeller?: boolean }) => {
    setLoadingExtract(true);
    try {
      const params = new URLSearchParams({ start: exStart, end: exEnd });
      if (exStoreId) params.set('storeId', exStoreId);
      if (opts?.keepSeller && exSellerKey) params.set('sellerKey', exSellerKey);
      else setExSellerKey('');
      const d = await apiFetch(`/api/retailops/commission/store-report?${params}`).then(r => r.json()).catch(() => null);
      if (d && !d.error) setExtract(d); else toast.error(d?.error || 'Falha ao gerar o extrato.');
    } finally { setLoadingExtract(false); }
  };
  // Dá NOME à matrícula do ERP (mapeamento retail_sellers) — com regra "por
  // vendedor" ativa, a apuração oficial passa a usar esse nome. Abre o formulário
  // (SellerNameModal) em vez de window.prompt.
  const nomearVendedor = (v: any) => setNameSeller(v);
  const loadReport = async () => {
    setLoadingReport(true);
    try {
      const d = await apiFetch(`/api/retailops/commission/report?start=${start}&end=${end}`).then(r => r.json()).catch(() => null);
      if (d && !d.error) setReport(d); else toast.error(d?.error || 'Falha ao gerar o relatório.');
      // Vendas por VENDEDOR direto do PDV (Fase 4 — VendaMalote sincronizado).
      const pv = await apiFetch(`/api/retailops/pdv-sellers?start=${start}&end=${end}`).then(r => r.json()).catch(() => null);
      setPdvSellers(Array.isArray(pv?.sellers) ? pv.sellers : []);
      setPdvPct(pv?.commissionPercent ?? null);
      await loadSellerSales();
    } finally { setLoadingReport(false); }
  };
  const loadSellerSales = async () => {
    const d = await apiFetch(`/api/retailops/seller-sales?start=${start}&end=${end}`).then(r => r.json()).catch(() => null);
    setSellerSales(Array.isArray(d?.entries) ? d.entries : []);
  };
  const deleteSellerSale = async (row: any) => {
    if (!window.confirm(`Remover o lançamento de ${row.seller_name} (${brl(row.valor)})?`)) return;
    const res = await apiFetch(`/api/retailops/seller-sales/${row.id}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Lançamento removido.'); loadReport(); } else toast.error('Falha ao remover.');
  };
  const downloadReportCsv = () => {
    if (!report) return;
    const erp = report.hasErpSellerSales;
    const head = ['Dimensão', 'Nome', 'Vendas', 'Vendas (qtd)', 'Comissão'];
    if (erp) head.push('Comissão ERP');
    const rows: string[] = [head.join(';')];
    for (const s of report.bySeller || []) rows.push(['Vendedor', s.sellerName, s.sales, s.orders, s.commission, ...(erp ? [s.erpCommission ?? ''] : [])].join(';'));
    for (const p of report.byProduct || []) rows.push(['Produto', p.productName, p.sales, p.orders, p.commission, ...(erp ? [''] : [])].join(';'));
    for (const st of report.byStore || []) rows.push(['Loja', st.storeName, st.sales, '', st.commission, ...(erp ? [''] : [])].join(';'));
    rows.push(['Total', '', '', '', report.totals?.totalCommission ?? 0, ...(erp ? [report.totals?.sellerErpCommission ?? ''] : [])].join(';'));
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `comissao_${start}_a_${end}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [r, ru, st] = await Promise.all([
        apiFetch('/api/retailops/commission/runs').then(x => x.json()).catch(() => ({})),
        apiFetch('/api/retailops/commission/rules').then(x => x.json()).catch(() => ({})),
        apiFetch('/api/retailops/stores').then(x => x.json()).catch(() => ({})),
      ]);
      setRuns(Array.isArray(r?.runs) ? r.runs : (Array.isArray(r) ? r : []));
      setRules(Array.isArray(ru?.rules) ? ru.rules : (Array.isArray(ru) ? ru : []));
      setStores(Array.isArray(st?.stores) ? st.stores : (Array.isArray(st) ? st : []));
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const createRun = async () => {
    setCreating(true);
    try {
      const res = await apiFetch('/api/retailops/commission/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ periodStart: start, periodEnd: end }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Apuração criada (prévia).'); setDetail(d); load(); }
      else toast.error(d.error || 'Falha ao apurar.');
    } finally { setCreating(false); }
  };
  const open = async (run: any) => {
    const d = await apiFetch(`/api/retailops/commission/runs/${run.id}`).then(r => r.json()).catch(() => null);
    if (d) setDetail(d);
  };
  const setStatus = async (run: any, action: 'approve' | 'reject') => {
    const res = await apiFetch(`/api/retailops/commission/runs/${run.id}/${action}`, { method: 'POST' });
    if (res.ok) { toast.success(action === 'approve' ? 'Comissão aprovada.' : 'Apuração rejeitada.'); setDetail(null); load(); }
    else toast.error('Falha ao atualizar.');
  };

  const saveRule = async () => {
    if (!ruleForm) return;
    const name = ruleForm.name.trim();
    if (!name) { toast.error('Dê um nome à regra.'); return; }
    let config: any = {};
    if (ruleForm.calculationType === 'percent_sales') config = { percent: Number(ruleForm.percent) || 0 };
    else if (ruleForm.calculationType === 'fixed') config = { amount: Number(ruleForm.amount) || 0 };
    else if (ruleForm.calculationType === 'quota_bonus') config = { bonus: Number(ruleForm.bonus) || 0, quota: Number(ruleForm.quota) || 0 };
    setSavingRule(true);
    try {
      const res = await apiFetch('/api/retailops/commission/rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scope: ruleForm.scope, period: 'monthly', calculationType: ruleForm.calculationType, config, storeId: ruleForm.scope === 'store' ? (ruleForm.storeId || null) : null }),
      });
      if (res.ok) { toast.success('Regra de comissão criada.'); setRuleForm(null); load(); }
      else { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Falha ao criar regra.'); }
    } finally { setSavingRule(false); }
  };
  const toggleRule = async (r: any) => {
    const res = await apiFetch(`/api/retailops/commission/rules/${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !r.active }) });
    if (res.ok) load(); else toast.error('Falha ao atualizar regra.');
  };
  const ruleSummary = (r: any) => {
    let c: any = {}; try { c = JSON.parse(r.config_json || '{}'); } catch { /* noop */ }
    if (r.calculation_type === 'percent_sales') return `${Number(c.percent || 0)}% das vendas`;
    if (r.calculation_type === 'fixed') return `${brl(c.amount)} fixo`;
    if (r.calculation_type === 'quota_bonus') return `${brl(c.bonus)} ao bater a meta`;
    if (r.calculation_type === 'tiered') return `faixas progressivas`;
    return r.calculation_type;
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  return (
    <div>
      {/* Corrida do mês (Fase G2 — modelo da planilha do cliente) */}
      <RaceSection stores={stores} />

      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Calculator className="w-4 h-4 text-indigo-400" /> Regras de comissão</div>
          <div className="flex items-center gap-2">
            <NewStoreButton onCreated={load} />
            <button onClick={() => setRuleForm({ name: '', scope: 'store', calculationType: 'percent_sales', percent: '5', amount: '', bonus: '', quota: '', storeId: '' })} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20">
              <Plus className="w-3.5 h-3.5" /> Nova regra
            </button>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">É aqui que você define <strong>quanto vai pagar de comissão</strong> — o percentual sobre as vendas, um valor fixo, ou um bônus ao bater a meta. Sem regra ativa, a apuração vem zerada.</p>
        {rules.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-500">Nenhuma regra ainda. Clique em <strong>“Nova regra”</strong> para definir o percentual.</div>
        ) : (
          <div className="mt-3 space-y-1.5">
            {rules.map(r => (
              <div key={r.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-zinc-100">{r.name} <span className="text-zinc-500">· {r.scope === 'global' ? 'rede toda' : r.scope === 'seller' ? 'por vendedor' : r.scope === 'product' ? 'por produto' : r.store_id ? `loja: ${stores.find((s: any) => s.id === r.store_id)?.name || 'loja removida'}` : 'todas as lojas'}</span></div>
                  <div className="text-[11px] text-indigo-300">{ruleSummary(r)}</div>
                </div>
                <button onClick={() => toggleRule(r)} className={`ml-3 shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${r.active ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'}`}>{r.active ? 'Ativa' : 'Inativa'}</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Relatório de comissão do período (por vendedor / produto / loja) */}
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Calculator className="w-4 h-4 text-emerald-400" /> Relatório de comissão</div>
          <label className="text-[11px] text-zinc-400 ml-2">De <input type="date" value={start} onChange={e => setStart(e.target.value)} className="ml-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" /></label>
          <label className="text-[11px] text-zinc-400">até <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="ml-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1 text-xs text-zinc-100" /></label>
          <button onClick={loadReport} disabled={loadingReport} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">{loadingReport ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Gerar</button>
          <button onClick={() => setSellerSalesModal(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1.5 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20"><Plus className="w-3.5 h-3.5" /> Lançar vendas por vendedor</button>
          {report && <button onClick={downloadReportCsv} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><Download className="w-3.5 h-3.5" /> CSV</button>}
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">Não tem o vendedor por venda no ERP? Anote as vendas de cada vendedor no papel e clique em <strong>“Lançar vendas por vendedor”</strong> — digite ou envie a foto da folha para a IA ler. Esses valores somam na comissão por vendedor.</p>

        {report && (
          <div className="mt-3 space-y-4">
            <div className="text-sm text-zinc-300">Comissão total do período: <span className="font-semibold text-emerald-300">{brl(report.totals?.totalCommission)}</span>
              <span className="text-zinc-500"> · vendedores {brl(report.totals?.sellerCommission)} · produtos {brl(report.totals?.productCommission)} · lojas {brl(report.totals?.storeCommission)}{report.storeIsReference ? ' (referência)' : ''}</span>
            </div>

            {report.pendingIdentityCount > 0 && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200">
                <AlertTriangle className="inline w-3.5 h-3.5 mr-1" />
                {report.pendingIdentityCount === 1 ? '1 vendedor aparece' : `${report.pendingIdentityCount} vendedores aparecem`} como <strong>“Matrícula X”</strong> (sem nome) — a comissão deles é <strong>pendência</strong>, não resultado final. Dê o nome em <strong>Vendedores da loja</strong> antes de aprovar a apuração.
              </p>
            )}
            <ReportBlock title="Por vendedor" empty={report.sellerCommissionSource ? 'Nenhuma venda com vendedor no período. As vendas do PDV entram pela sincronização da Alterdata (CAI_USUARIO); ou lance a folha em “Lançar vendas por vendedor”.' : 'Sem regra de comissão ativa. Crie uma regra por vendedor ou por loja em “Nova regra”.'} rows={report.bySeller} cols={[['sellerName', 'Vendedor'], ['source', 'Fonte'], ['sales', 'Vendas', true], ['pecas', 'Peças'], ['orders', 'Nº vendas'], ['commission', 'Comissão', true], ...(report.hasErpSellerSales ? [['erpCommission', 'Comissão ERP', true]] : [])] as [string, string, boolean?][]} />
            {report.sellerCommissionSource === 'store_fallback' && report.sellerCommissionPercent != null && <p className="text-[11px] text-zinc-500 -mt-2">Comissão por vendedor calculada por <strong className="text-zinc-300">{report.sellerCommissionPercent}%</strong> (regra da loja) sobre o que <strong className="text-zinc-300">cada vendedor</strong> vendeu (PDV/CAI_USUARIO + ZappFlow + lançamentos). Como sai da mesma regra da loja, a linha “Por loja” abaixo vira só <strong className="text-zinc-300">referência</strong> e não soma no total. Para pagar as duas juntas, crie uma regra com escopo “Cada vendedor”.</p>}
            {report.hasErpSellerSales && <p className="text-[11px] text-zinc-500 -mt-2">“Comissão” é a nossa apuração (pelas regras); “Comissão ERP” é a que o próprio ERP calculou — compare para conferir divergências.</p>}
            <ReportBlock title="Por produto" empty={!report.hasRules?.product ? 'Sem regra por produto ativa.' : 'Nenhuma venda por produto no período.'} rows={report.byProduct} cols={[['productName', 'Produto'], ['sales', 'Vendas', true], ['orders', 'Nº vendas'], ['commission', 'Comissão', true]]} />
            <ReportBlock title={report.storeIsReference ? 'Por loja (fechamentos) — referência, não soma no total' : 'Por loja (fechamentos)'} empty={!report.hasRules?.store ? 'Sem regra por loja ativa.' : 'Sem fechamentos no período.'} rows={report.byStore} cols={[['storeName', 'Loja'], ['sales', 'Vendas', true], ['commission', 'Comissão', true]]} />

            {/* Lançamentos por vendedor do período (manual/foto — Cenário B).
                Já entram somados na tabela "Por vendedor" acima; esta lista
                permite conferir e remover cada folha lançada. */}
            {sellerSales.length > 0 && (
              <div className="mt-4">
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Folhas de vendas lançadas (manual/foto)</p>
                  {sellerSales.length > 8 && (
                    <input value={folhaQ} onChange={e => setFolhaQ(e.target.value)} placeholder="Filtrar vendedor/loja…" className="min-w-[180px] bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-100" />
                  )}
                </div>
                <div className="overflow-x-auto rounded-xl border border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                      <th className="px-3 py-2 text-left font-medium">Data</th>
                      <th className="px-3 py-2 text-left font-medium">Vendedor</th>
                      <th className="px-3 py-2 text-left font-medium">Loja</th>
                      <th className="px-3 py-2 text-right font-medium">Valor</th>
                      <th className="px-3 py-2 text-right font-medium">Peças</th>
                      <th className="px-3 py-2 text-center font-medium">Origem</th>
                      <th className="px-3 py-2 text-right font-medium"></th>
                    </tr></thead>
                    <tbody>
                      {sellerSales.filter((v: any) => { const s = folhaQ.trim().toLowerCase(); return !s || [v.seller_name, v.store_name].filter(Boolean).some((x: string) => String(x).toLowerCase().includes(s)); }).map((v: any) => (
                        <tr key={v.id} className="border-t border-zinc-800/70">
                          <td className="px-3 py-2 text-zinc-300">{v.sale_date}</td>
                          <td className="px-3 py-2 text-zinc-100">{v.seller_name}</td>
                          <td className="px-3 py-2 text-zinc-300">{v.store_name || '—'}</td>
                          <td className="px-3 py-2 text-right text-zinc-100">{brl(v.valor)}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{Number(v.pecas || 0)}</td>
                          <td className="px-3 py-2 text-center"><span className={`rounded-full border px-2 py-0.5 text-[11px] ${v.source === 'photo' ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-zinc-700 bg-zinc-800/40 text-zinc-400'}`}>{v.source === 'photo' ? 'foto' : 'manual'}</span></td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button onClick={() => setEditSale(v)} title="Editar" className="text-zinc-500 hover:text-indigo-300"><Pencil className="w-4 h-4" /></button>
                              <button onClick={() => deleteSellerSale(v)} title="Remover" className="text-zinc-500 hover:text-red-300"><Trash2 className="w-4 h-4" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Vendas por VENDEDOR direto do PDV (Fase 4 — VendaMalote). A
                matrícula é a do ERP; para pagar comissão por pessoa, associe a
                matrícula ao vendedor e crie uma regra por vendedor. A seção
                aparece SEMPRE que há relatório — vazia, explica o porquê (sem
                isso o usuário acha que "não gerou"). */}
            {pdvSellers.length === 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Vendas por vendedor — PDV (CAI_USUARIO)</p>
                <div className="rounded-xl border border-dashed border-zinc-800 p-4 text-[13px] text-zinc-500">
                  Nenhuma venda do PDV importada para este período ainda. As vendas entram pela sincronização: vá em <span className="text-zinc-300">Integrações → Alterdata → Sincronizar agora</span> (a primeira carga traz o histórico; a mensagem mostra "N venda(s) PDV") e clique em <span className="text-zinc-300">Gerar</span> de novo.
                </div>
              </div>
            )}
            {pdvSellers.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Vendas por vendedor — PDV (CAI_USUARIO)</p>
                <p className="text-[12px] text-zinc-500 mb-2">Vendedor pelo <strong className="text-zinc-300">CAI_USUARIO</strong> do PDV (código do vendedor), não pela matrícula do operador de caixa. Clique no código para dar nome ao vendedor (mapa <em>retail_sellers</em>); sem nome, sai como <em>Matrícula {'{'}código{'}'}</em>. Vendas antigas só passam a exibir o vendedor após um novo sync da Alterdata (bases sem o código caem no operador).{pdvPct != null && <> Comissão <strong className="text-zinc-300">estimada</strong> pela regra percentual ativa ({pdvPct}%).</>}</p>
                <div className="overflow-x-auto rounded-xl border border-zinc-800">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                      <th className="px-3 py-2 text-left font-medium">Vendedor</th>
                      <th className="px-3 py-2 text-left font-medium">Loja</th>
                      <th className="px-3 py-2 text-right font-medium">Vendas</th>
                      <th className="px-3 py-2 text-right font-medium">Nº vendas</th>
                      <th className="px-3 py-2 text-right font-medium">Peças</th>
                      {pdvPct != null && <th className="px-3 py-2 text-right font-medium">Comissão (est.)</th>}
                    </tr></thead>
                    <tbody>
                      {pdvSellers.map((v: any, i: number) => (
                        <tr key={i} className="border-t border-zinc-800/70">
                          <td className="px-3 py-2 text-zinc-100">
                            <button onClick={() => nomearVendedor(v)} title="Dar nome a este vendedor" className="text-left hover:text-indigo-300">
                              {v.seller_name || <span className="font-mono text-zinc-300">Matrícula {v.vendedor}</span>}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-zinc-300">{v.store_name}</td>
                          <td className="px-3 py-2 text-right text-zinc-100">{brl(v.sales)}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{v.orders}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">{Number(v.pecas || 0)}</td>
                          {pdvPct != null && <td className="px-3 py-2 text-right text-emerald-300">{v.commission != null ? brl(v.commission) : '—'}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Extrato por LOJA e por VENDEDOR — "rodar o comando" do dono da rede:
          escolhe a loja (ou todas) e o vendedor (ou todos), num período
          qualquer (inclusive parcial dentro do mês), e gera quanto cada um
          vendeu e tem a receber de comissão até aquela data. */}
      <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Store className="w-4 h-4 text-indigo-400" /> Extrato por loja e por vendedor</div>
        <p className="mt-1 text-[11px] text-zinc-500">Escolha a loja (ou todas), o vendedor (ou todos) e o período — inclusive parcial, tipo "1º ao dia 15" — pra ver quanto cada vendedor vendeu (valor e peças) e quanto já tem a receber de comissão até essa data.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-zinc-400">Loja
            <select value={exStoreId} onChange={e => { setExStoreId(e.target.value); setExSellerKey(''); }} className="mt-1 block bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100 min-w-[160px]">
              <option value="">Todas as lojas</option>
              {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-zinc-400">Vendedor
            <select value={exSellerKey} onChange={e => setExSellerKey(e.target.value)} className="mt-1 block bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100 min-w-[160px]" disabled={!extract?.sellers?.length}>
              <option value="">Todos os vendedores</option>
              {(extract?.sellers || []).map((s: any) => <option key={`${s.storeId}:${s.sellerKey}`} value={s.sellerKey}>{s.sellerName}{!exStoreId ? ` (${s.storeName})` : ''}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-1">
            {([['today', 'Hoje'], ['week', 'Esta semana'], ['fortnight', 'Esta quinzena'], ['month', 'Este mês']] as const).map(([k, label]) => (
              <button key={k} onClick={() => applyExShortcut(k)} className="rounded-lg border border-zinc-700 px-2 py-1.5 text-[11px] text-zinc-300 hover:bg-zinc-800">{label}</button>
            ))}
          </div>
          <label className="text-xs text-zinc-400">De<input type="date" value={exStart} onChange={e => setExStart(e.target.value)} className="ml-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" /></label>
          <label className="text-xs text-zinc-400">até<input type="date" value={exEnd} onChange={e => setExEnd(e.target.value)} className="ml-1 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" /></label>
          <button onClick={() => generateExtract({ keepSeller: true })} disabled={loadingExtract} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
            {loadingExtract ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Gerar extrato
          </button>
        </div>

        {extract && (
          <div className="mt-3 space-y-3">
            <div className="text-sm text-zinc-300">Total do filtro: <span className="font-semibold text-emerald-300">{brl(extract.totals?.commission)}</span>
              <span className="text-zinc-500"> · vendas {brl(extract.totals?.sales)} · {Number(extract.totals?.pecas || 0)} peças · {extract.totals?.sellerCount || 0} vendedor(es)</span>
            </div>

            {!exStoreId && extract.byStore?.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                    <th className="px-3 py-1.5 text-left font-medium">Loja</th>
                    <th className="px-3 py-1.5 text-right font-medium">Vendas</th>
                    <th className="px-3 py-1.5 text-right font-medium">Peças</th>
                    <th className="px-3 py-1.5 text-right font-medium">Comissão</th>
                  </tr></thead>
                  <tbody>
                    {extract.byStore.map((s: any) => {
                      // Loja com bastante venda mas SÓ 1 "vendedor" identificado: o
                      // campo que a Alterdata manda como vendedor (CAI_USUARIO) pode
                      // não estar individualizando de verdade nessa loja (login/
                      // terminal compartilhado) — vale confirmar com o suporte do PDV.
                      const suspicious = s.sellerCount === 1 && s.orders > 5;
                      return (
                        <tr key={s.storeId || s.storeName} className="border-t border-zinc-800/60">
                          <td className="px-3 py-1.5 text-zinc-200">
                            {s.storeName}
                            {suspicious && (
                              <span title="Só 1 vendedor apareceu nessa loja no período. Se a loja tem mais gente na equipe, o código de vendedor que a Alterdata manda (CAI_USUARIO) pode não estar individualizando de verdade — confira com o suporte do PDV." className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300 align-middle">
                                <AlertTriangle className="w-3 h-3" /> só 1 vendedor
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right text-zinc-200">{brl(s.sales)}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-300">{s.pecas}</td>
                          <td className="px-3 py-1.5 text-right text-emerald-300">{brl(s.commission)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {extract.sellers?.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[12px] text-zinc-500">Nenhuma venda por vendedor nesse filtro/período.</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                    <th className="px-3 py-1.5 text-left font-medium">Vendedor</th>
                    <th className="px-3 py-1.5 text-left font-medium">Loja</th>
                    <th className="px-3 py-1.5 text-right font-medium">Vendas</th>
                    <th className="px-3 py-1.5 text-right font-medium">Peças</th>
                    <th className="px-3 py-1.5 text-right font-medium">Nº vendas</th>
                    <th className="px-3 py-1.5 text-right font-medium">%</th>
                    <th className="px-3 py-1.5 text-right font-medium">Comissão</th>
                  </tr></thead>
                  <tbody>
                    {(extract.sellers || []).map((s: any, i: number) => (
                      <tr key={i} className="border-t border-zinc-800/60">
                        <td className="px-3 py-1.5 text-zinc-100">{s.sellerName}</td>
                        <td className="px-3 py-1.5 text-zinc-300">{s.storeName}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-200">{brl(s.sales)}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-300">{s.pecas}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-300">{s.orders}</td>
                        <td className="px-3 py-1.5 text-right text-zinc-400">{s.commissionPercent != null ? `${s.commissionPercent}%` : '—'}</td>
                        <td className="px-3 py-1.5 text-right text-emerald-300">{brl(s.commission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {sellerSalesModal && <SellerSalesModal defaultDate={end} onClose={() => setSellerSalesModal(false)} onSaved={() => { setSellerSalesModal(false); loadReport(); }} />}
      {editSale && <EditSellerSaleModal sale={editSale} onClose={() => setEditSale(null)} onSaved={() => { setEditSale(null); loadReport(); }} />}

      {ruleForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setRuleForm(null)}>
          <div className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-zinc-100">Nova regra de comissão</h3>
              <button onClick={() => setRuleForm(null)} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block text-xs text-zinc-400">Nome
                <input value={ruleForm.name} onChange={e => setRuleForm({ ...ruleForm, name: e.target.value })} placeholder="Ex.: Comissão dos vendedores" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
              </label>
              <label className="block text-xs text-zinc-400">Aplica-se a
                <select value={ruleForm.scope} onChange={e => setRuleForm({ ...ruleForm, scope: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
                  <option value="store">Cada loja (fechamentos)</option>
                  <option value="global">A rede toda (fechamentos)</option>
                  <option value="seller">Cada vendedor (vendas do ZappFlow)</option>
                  <option value="product">Cada produto (vendas do ZappFlow)</option>
                </select>
                {(ruleForm.scope === 'seller' || ruleForm.scope === 'product') && <span className="mt-1 block text-[11px] text-zinc-500">Apura sobre as vendas feitas pelo ZappFlow (WhatsApp/loja virtual). Vendas do balcão físico entram por loja.</span>}
              </label>
              {ruleForm.scope === 'store' && (
                <label className="block text-xs text-zinc-400">Loja específica (opcional)
                  <select value={ruleForm.storeId} onChange={e => setRuleForm({ ...ruleForm, storeId: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
                    <option value="">Todas as lojas (rede)</option>
                    {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <span className="mt-1 block text-[11px] text-zinc-500">Deixe em branco pra um percentual único pra rede toda; escolha uma loja pra dar a ela um percentual PRÓPRIO (ex.: Loja X paga 7%, as demais continuam com a regra de rede).</span>
                </label>
              )}
              <label className="block text-xs text-zinc-400">Como calcular
                <select value={ruleForm.calculationType} onChange={e => setRuleForm({ ...ruleForm, calculationType: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
                  <option value="percent_sales">Percentual sobre as vendas</option>
                  <option value="quota_bonus">Bônus ao bater a meta</option>
                  <option value="fixed">Valor fixo</option>
                </select>
              </label>
              {ruleForm.calculationType === 'percent_sales' && (
                <label className="block text-xs text-zinc-400">Percentual (%)
                  <input type="number" step="0.1" min="0" value={ruleForm.percent} onChange={e => setRuleForm({ ...ruleForm, percent: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                  <span className="mt-1 block text-[11px] text-zinc-500">Ex.: 5 → paga 5% de tudo que a loja vendeu no período.</span>
                </label>
              )}
              {ruleForm.calculationType === 'quota_bonus' && (
                <>
                  <label className="block text-xs text-zinc-400">Bônus (R$)
                    <input type="number" step="0.01" min="0" value={ruleForm.bonus} onChange={e => setRuleForm({ ...ruleForm, bonus: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                    <span className="mt-1 block text-[11px] text-zinc-500">Pago só quando as vendas do período atingem a meta (cota).</span>
                  </label>
                  {(ruleForm.scope === 'seller' || ruleForm.scope === 'product') && (
                    <label className="block text-xs text-zinc-400">Meta (R$) do vendedor/produto
                      <input type="number" step="0.01" min="0" value={ruleForm.quota} onChange={e => setRuleForm({ ...ruleForm, quota: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                      <span className="mt-1 block text-[11px] text-zinc-500">Por loja a meta vem das cotas diárias; por vendedor/produto, defina aqui.</span>
                    </label>
                  )}
                </>
              )}
              {ruleForm.calculationType === 'fixed' && (
                <label className="block text-xs text-zinc-400">Valor fixo (R$)
                  <input type="number" step="0.01" min="0" value={ruleForm.amount} onChange={e => setRuleForm({ ...ruleForm, amount: e.target.value })} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
                </label>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setRuleForm(null)} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
              <button onClick={saveRule} disabled={savingRule} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{savingRule ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Salvar regra</button>
            </div>
          </div>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
        <label className="text-xs text-zinc-400">Início<input type="date" value={start} onChange={e => setStart(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" /></label>
        <label className="text-xs text-zinc-400">Fim<input type="date" value={end} onChange={e => setEnd(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" /></label>
        <button onClick={createRun} disabled={creating} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Nova apuração
        </button>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhuma apuração ainda. Escolha o período e clique em “Nova apuração”.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400"><tr>
              <th className="px-3 py-2 text-left font-medium">Período</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Vendas</th>
              <th className="px-3 py-2 text-right font-medium">Comissão</th>
              <th className="px-3 py-2 text-right font-medium">Ações</th>
            </tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{r.period_start} → {r.period_end}</td>
                  <td className="px-3 py-2"><Badge map={RUN_STATUS} s={r.status} /></td>
                  <td className="px-3 py-2 text-right text-zinc-400">{brl(r.total_sales)}</td>
                  <td className="px-3 py-2 text-right text-zinc-100">{brl(r.total_commission)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => open(r)} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800">Ver</button>
                      {r.status === 'draft' && (
                        <>
                          <button onClick={() => setStatus(r, 'approve')} title="Aprovar" className="rounded bg-emerald-600/90 px-1.5 py-0.5 text-white hover:bg-emerald-500"><Check className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setStatus(r, 'reject')} title="Rejeitar" className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300 hover:bg-red-500/10"><X className="w-3.5 h-3.5" /></button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && <RunDetailModal run={detail} onClose={() => setDetail(null)} onSaved={(r) => { setDetail(r); load(); }} onStatus={(action) => setStatus(detail, action)} />}
      {nameSeller && <SellerNameModal codigo={nameSeller.vendedor} initialName={nameSeller.seller_name} onClose={() => setNameSeller(null)} onSaved={() => { setNameSeller(null); loadReport(); }} />}
    </div>
  );
}

// ---- Modal "Ver apuração" — ajuste manual + excluir loja (draft) ------------
// O gerente/dono pode SOBRESCREVER a comissão de uma linha (input decimal,
// grava on-blur) e REMOVER uma loja/vendedor da apuração inteira. Só em
// status draft — approved/rejected ficam congelados. O total do run
// recalcula na hora a cada operação (SUM(items), derivado).
function RunDetailModal({ run: initial, onClose, onSaved, onStatus }: { run: any; onClose: () => void; onSaved: (r: any) => void; onStatus: (a: 'approve' | 'reject') => void }) {
  const [run, setRun] = useState<any>(initial);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingItem, setSavingItem] = useState<string | null>(null);
  const editable = run.status === 'draft';

  const displayValue = (it: any) => drafts[it.id] ?? String(it.commission_amount ?? 0);
  const liveTotal = useMemo(() => {
    return (run.items || []).reduce((a: number, it: any) => {
      const raw = drafts[it.id];
      const v = raw != null ? Number(String(raw).replace(',', '.')) : Number(it.commission_amount || 0);
      return a + (Number.isFinite(v) ? v : 0);
    }, 0);
  }, [drafts, run.items]);
  const dirty = Object.keys(drafts).length > 0;

  const commit = async (it: any) => {
    const raw = drafts[it.id];
    if (raw == null) return;
    const v = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0) { toast.error('Comissão inválida.'); return; }
    if (Math.abs(v - Number(it.commission_amount || 0)) < 0.005) {
      setDrafts(p => { const { [it.id]: _, ...rest } = p; return rest; });
      return;
    }
    setSavingItem(it.id);
    try {
      const res = await apiFetch(`/api/retailops/commission/runs/${run.id}/items/${it.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commissionAmount: v }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setRun(d); setDrafts(p => { const { [it.id]: _, ...rest } = p; return rest; }); onSaved(d); }
      else toast.error(d.error || 'Falha ao ajustar a comissão.');
    } finally { setSavingItem(null); }
  };
  const remove = async (it: any) => {
    if (!window.confirm(`Excluir ${it.seller_name} da apuração? A comissão de ${brl(it.commission_amount)} sai do total.`)) return;
    setSavingItem(it.id);
    try {
      const res = await apiFetch(`/api/retailops/commission/runs/${run.id}/items/${it.id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setRun(d); toast.success('Loja/vendedor removido da apuração.'); onSaved(d); }
      else toast.error(d.error || 'Falha ao excluir.');
    } finally { setSavingItem(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-zinc-100">Apuração {run.period_start} → {run.period_end}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="w-5 h-5" /></button>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Badge map={RUN_STATUS} s={run.status} />
          <span className="text-xs text-zinc-500">Total: <strong className={dirty ? 'text-amber-300' : 'text-zinc-200'}>{brl(liveTotal)}</strong>{dirty && <span className="ml-1 text-amber-300">(prévia — salve saindo do campo)</span>}</span>
        </div>
        {editable && <p className="mt-2 text-[11px] text-zinc-500">Toque no campo <em>Comissão</em> pra sobrescrever o valor calculado, ou no <span className="text-red-300">×</span> pra tirar a loja/vendedor da apuração. O total recalcula na hora.</p>}
        <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Loja / Escopo</th>
                <th className="px-3 py-2 text-right font-medium">Base</th>
                <th className="px-3 py-2 text-right font-medium">Comissão</th>
                {editable && <th className="w-8 px-1 py-2"></th>}
              </tr>
            </thead>
            <tbody>
              {(run.items || []).map((it: any) => (
                <tr key={it.id} className="border-t border-zinc-800/70">
                  <td className="px-3 py-2 text-zinc-200">{it.seller_name}</td>
                  <td className="px-3 py-2 text-right text-zinc-400">{brl(it.base_amount)}</td>
                  <td className="px-3 py-2 text-right">
                    {editable ? (
                      <input
                        inputMode="decimal"
                        value={displayValue(it)}
                        disabled={savingItem === it.id}
                        onChange={e => setDrafts(p => ({ ...p, [it.id]: e.target.value }))}
                        onBlur={() => commit(it)}
                        onKeyDown={e => { if (e.key === 'Enter') { (e.currentTarget as HTMLInputElement).blur(); } }}
                        className={`w-24 rounded border px-2 py-0.5 text-right text-sm ${drafts[it.id] != null ? 'border-amber-500/40 bg-amber-500/5 text-amber-200' : 'border-zinc-700 bg-zinc-950 text-zinc-100'}`}
                      />
                    ) : (
                      <span className="text-zinc-100">{brl(it.commission_amount)}</span>
                    )}
                  </td>
                  {editable && (
                    <td className="px-1 py-2 text-right">
                      <button onClick={() => remove(it)} disabled={savingItem === it.id} title="Excluir loja/vendedor da apuração" className="text-zinc-500 hover:text-red-300 disabled:opacity-40">
                        {savingItem === it.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {(!run.items || run.items.length === 0) && <tr><td colSpan={editable ? 4 : 3} className="px-3 py-4 text-center text-xs text-zinc-500">Sem itens (cadastre regras de comissão).</td></tr>}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => onStatus('reject')} className="rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10">Rejeitar</button>
            <button onClick={() => onStatus('approve')} disabled={dirty} title={dirty ? 'Salve o valor no campo antes de aprovar (saia do campo)' : ''} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Aprovar comissão</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Conferência de divergência (fechamento × sistema) ----------------------
const DIV_STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: 'Confere', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  divergent: { label: 'Divergente', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  pending_informed: { label: 'Sem fechamento', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
};
function ReconciliationTab() {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyDiv, setOnlyDiv] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await apiFetch(`/api/retailops/reconciliation?month=${month}${onlyDiv ? '&onlyDivergent=1' : ''}`).then(r => r.json()).catch(() => null);
      setData(d);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [month, onlyDiv]);

  const onImport = async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch('/api/retailops/reconciliation/import', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`Conferidos ${d.matched ?? 0} fechamento(s)${d.divergences ? ` — ${d.divergences} divergente(s)` : ''}.`); load(); }
      else toast.error(d.error || 'Falha ao importar o CSV.');
    } finally { setImporting(false); }
  };

  const s = data?.summary;
  return (
    <div>
      <div className="mb-3 rounded-lg border border-sky-500/25 bg-sky-500/5 p-3 text-[12px] text-sky-200/90">
        Compara o <strong>fechamento informado</strong> com o total do <strong>sistema/PDV</strong> (export do Alterdata). Enquanto a integração viva não é ligada, importe aqui o CSV de <em>“Fechamento de Caixa — Diário”</em>.
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-xs text-zinc-400">Mês
          <input type="month" value={month} onChange={e => setMonth(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-400"><input type="checkbox" checked={onlyDiv} onChange={e => setOnlyDiv(e.target.checked)} /> Só divergentes</label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Importar CSV do sistema
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onImport(f); e.currentTarget.value = ''; }} />
        </label>
        <div className="ml-auto"><NewStoreButton onCreated={load} /></div>
      </div>

      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Conferidos" value={String(s.reconciledCount)} />
          <Stat label="Divergentes" value={String(s.divergentCount)} tone={s.divergentCount > 0 ? 'red' : 'ok'} />
          <Stat label="Divergência total" value={brl(s.totalDivergenceBRL)} tone={s.totalDivergenceBRL > 0 ? 'red' : 'ok'} />
          <Stat label="Total do sistema" value={brl(s.systemTotalBRL)} />
        </div>
      )}

      {data && Number(data.totalRows) > (data.rows?.length || 0) && (
        <p className="mb-2 text-[11px] text-amber-300/80">Mostrando as primeiras {data.rows.length} de {data.totalRows} linhas do mês. Use “Só divergentes” ou troque de mês para ver as demais.</p>
      )}
      {loading ? <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
        : !data?.rows?.length ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum fechamento conferido neste mês. Importe o CSV do sistema para comparar.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Data</th>
                <th className="px-3 py-2 text-left font-medium">Loja</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Informado</th>
                <th className="px-3 py-2 text-right font-medium">Sistema</th>
                <th className="px-3 py-2 text-right font-medium">Diferença</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r: any, i: number) => (
                  <tr key={`${r.storeId}-${r.date}-${i}`} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-300">{r.date}</td>
                    <td className="px-3 py-2 text-zinc-200">{r.storeName}</td>
                    <td className="px-3 py-2"><Badge map={DIV_STATUS} s={r.status} /></td>
                    <td className="px-3 py-2 text-right text-zinc-300">{r.informed != null ? brl(r.informed) : '—'}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">{brl(r.system)}</td>
                    <td className={`px-3 py-2 text-right ${Number(r.divergence) ? 'text-red-300' : 'text-zinc-500'}`}>{r.divergence != null ? brl(r.divergence) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ---- Estoque negativo -------------------------------------------------------
function NegativeStockTab() {
  const PAGE = 100;
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [q, setQ] = useState('');
  const [policyRow, setPolicyRow] = useState<any | null>(null);
  const load = (offset: number, append: boolean) => {
    append ? setLoadingMore(true) : setLoading(true);
    apiFetch(`/api/retailops/stock/negative?storeId=${storeId}&q=${encodeURIComponent(q)}&limit=${PAGE}&offset=${offset}`)
      .then(r => r.json())
      .then(d => {
        setTotal(Number(d?.total) || 0);
        setItems(prev => append ? [...prev, ...(Array.isArray(d?.items) ? d.items : [])] : (Array.isArray(d?.items) ? d.items : []));
      })
      .catch(() => toast.error('Falha ao carregar o estoque negativo.'))
      .finally(() => { setLoading(false); setLoadingMore(false); });
  };
  useEffect(() => { apiFetch('/api/retailops/stores').then(r => r.json()).then(d => setStores(Array.isArray(d?.stores) ? d.stores : [])).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(() => load(0, false), 300); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [storeId, q]);
  const filtered = !!(storeId || q.trim());

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12px] text-zinc-400">Itens com saldo <strong className="text-red-300">negativo</strong> por loja — normalmente venda lançada sem entrada correspondente. Corrija a entrada no estoque. <span className="text-zinc-500">Busque por nome, referência ou código de barras.</span></p>
        <button onClick={() => load(0, false)} className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-3.5 h-3.5" /> Atualizar</button>
      </div>
      {(total > 0 || filtered) && (
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <select value={storeId} onChange={e => setStoreId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
            <option value="">Todas as lojas</option>
            {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Filtrar produto…" className="flex-1 min-w-[160px] bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          {total > 0 && <span className="text-xs text-zinc-500">{items.length < total ? `${items.length} de ${total}` : total} item(ns)</span>}
        </div>
      )}
      {loading ? <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
        : items.length === 0 ? (
          filtered ? (
            <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Nenhum item negativo para este filtro.</div>
          ) : (
            <div className="rounded-xl border border-dashed border-emerald-800/40 bg-emerald-500/5 p-8 text-center text-sm text-emerald-300/80"><Check className="mx-auto mb-2 h-5 w-5" /> Nenhum item com estoque negativo. 🎉</div>
          )
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Loja</th>
                <th className="px-3 py-2 text-left font-medium">Produto</th>
                <th className="px-3 py-2 text-left font-medium">Cor / Tam.</th>
                <th className="px-3 py-2 text-left font-medium">Un.</th>
                <th className="px-3 py-2 text-right font-medium">Saldo</th>
                <th className="px-3 py-2 text-right font-medium" title="Quantidade só para sair do negativo (até zero)">Até zero</th>
                <th className="px-3 py-2 text-right font-medium" title="Quantidade para chegar na meta de estoque (exige meta configurada)">Falta p/ meta</th>
                <th className="px-3 py-2 text-left font-medium">Atualização</th>
              </tr></thead>
              <tbody>
                {items.map((it: any) => (
                  <tr key={it.id} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-200 whitespace-nowrap">{it.store_name}{it.store_code ? <span className="text-zinc-500 text-[11px]"> · {it.store_code}</span> : null}</td>
                    <td className="px-3 py-2 text-zinc-300">
                      <div>{it.product_name || it.product_service_id}</div>
                      {(it.product_external_ref || it.variant_ean) && (
                        <div className="text-[11px] text-zinc-500">
                          {it.product_external_ref ? <>ref {it.product_external_ref}</> : null}
                          {it.product_external_ref && it.variant_ean ? ' · ' : null}
                          {it.variant_ean ? <>EAN {it.variant_ean}</> : null}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-300 whitespace-nowrap">{[it.variant_color, it.variant_size].filter(Boolean).join(' / ') || '—'}</td>
                    <td className="px-3 py-2 text-zinc-400">{it.product_uom || '—'}</td>
                    <td className="px-3 py-2 text-right font-semibold text-red-300">{Number(it.quantity_available)}</td>
                    <td className="px-3 py-2 text-right text-amber-300">{it.qty_to_zero != null ? it.qty_to_zero : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {it.shortage_qty != null
                        ? <button onClick={() => setPolicyRow(it)} className="font-semibold text-orange-300 hover:underline" title="Editar a meta de estoque desta peça">{it.shortage_qty}</button>
                        : <button onClick={() => setPolicyRow(it)} className="text-[11px] rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800" title="Defina o estoque-alvo desta peça para calcular a falta">Definir meta</button>}
                    </td>
                    <td className="px-3 py-2 text-zinc-500 text-[12px] whitespace-nowrap">{it.source_synced_at ? String(it.source_synced_at).slice(0, 10).split('-').reverse().join('/') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {items.length > 0 && items.length < total && (
        <div className="mt-3 text-center">
          <button onClick={() => load(items.length, true)} disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
            {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Carregar mais ({total - items.length} restantes)
          </button>
        </div>
      )}
      {policyRow && <StockPolicyModal row={policyRow} onClose={() => setPolicyRow(null)} onDone={() => { setPolicyRow(null); load(0, false); }} />}
    </div>
  );
}

// Modal "Definir meta de estoque" (INV-004): mínimo/alvo por loja+produto+variante
// da peça negativa. É o que ACENDE a coluna "Falta p/ meta". Config = owner/admin
// (o servidor barra o resto; aqui a UI trata o 403 com aviso claro).
function StockPolicyModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: () => void }) {
  const [minQty, setMinQty] = useState<string>(row.min_qty != null ? String(row.min_qty) : '0');
  const [targetQty, setTargetQty] = useState<string>(row.target_qty != null ? String(row.target_qty) : '');
  const [busy, setBusy] = useState(false);
  const variant = [row.variant_color, row.variant_size].filter(Boolean).join(' / ');
  const submit = async () => {
    const min = Number(minQty), target = Number(targetQty);
    if (!Number.isFinite(target) || targetQty.trim() === '') { toast.error('Informe o estoque-alvo.'); return; }
    if (min < 0 || target < 0) { toast.error('Mínimo e alvo não podem ser negativos.'); return; }
    if (target < min) { toast.error('O alvo deve ser maior ou igual ao mínimo.'); return; }
    setBusy(true);
    try {
      const res = await apiFetch('/api/retailops/stock-policies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId: row.store_id, productId: row.product_service_id, variantId: row.variant_id || null, minQty: min, targetQty: target }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Meta de estoque salva.'); onDone(); }
      else if (res.status === 403) toast.error('Só owner/admin pode configurar metas de estoque.');
      else toast.error(d?.error || 'Não foi possível salvar a meta.');
    } catch { toast.error('Falha ao salvar a meta.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950 p-4" onClick={e => e.stopPropagation()}>
        <div className="text-sm text-zinc-100 font-medium">Meta de estoque</div>
        <div className="text-xs text-zinc-400 mt-1">{row.product_name || row.product_service_id}{variant ? <span className="text-zinc-500"> · {variant}</span> : null}</div>
        <div className="text-[11px] text-zinc-500 mt-0.5">{row.store_name}{row.store_code ? ` · ${row.store_code}` : ''}</div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-xs text-zinc-400">Mínimo
            <input type="number" min={0} value={minQty} onChange={e => setMinQty(e.target.value)} className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
          <label className="text-xs text-zinc-400">Alvo
            <input type="number" min={0} value={targetQty} onChange={e => setTargetQty(e.target.value)} placeholder="ex.: 3" className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
          </label>
        </div>
        <p className="text-[11px] text-zinc-500 mt-2">A <strong>falta</strong> é calculada como alvo − saldo. O mínimo é preservado quando esta loja doa em transferências.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={submit} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-600/20 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-50">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Salvar meta
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Vendedores da loja (PDR TOULON, Fatia 2B / SELL-004..008) --------------
// Cobertura por loja: lotados + matrículas sem nome (pendência acionável) +
// suspeitos de código compartilhado. Dar nome inline cria a identidade; atribuir
// lojas define a lotação. Substitui o antigo prompt de nomear vendedor.
// Metas do vendedor (pedido do lojista): realizado × cota de cada vendedor da
// loja em DIA / SEMANA / QUINZENA / MÊS. Cota semanal é a base (Escala & cotas):
// dia = semana ÷ dias escalados; quinzena = 2 semanas; mês = soma das semanas.
function SellerScoreboardTab() {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [date, setDate] = useState(todayStr());
  useEffect(() => { apiFetch('/api/retailops/stores').then(r => r.json()).then(d => { const arr = (Array.isArray(d?.stores) ? d.stores : []).filter((s: any) => s.active); setStores(arr); if (!storeId && arr[0]) setStoreId(arr[0].id); }).catch(() => {}); /* eslint-disable-next-line */ }, []);
  const { data, status, corr, isStale, loadedAt, reload: load } =
    useAnalytics(() => storeId ? `/api/retailops/seller-scoreboard?storeId=${storeId}&date=${date}` : '', [storeId, date]);
  const showData = status === 'ok' || isStale;
  const fmtDM = (d: string) => d ? `${d.slice(8)}/${d.slice(5, 7)}` : '';

  // Célula de um período: realizado, cota e % de atingimento (cor por faixa).
  const Cell = ({ p }: { p: any }) => {
    const a = p?.attainment;
    const cls = a == null ? 'text-zinc-500' : a >= 100 ? 'text-emerald-300' : a >= 60 ? 'text-amber-300' : 'text-red-300';
    // Folga/férias no dia (pela escala): sem cota naquele dia — RN-G2-003.
    const folga = p?.off && !(p?.sales > 0);
    return (
      <div className="text-right">
        <div className="text-[13px] font-medium text-zinc-100">{brl(p?.sales || 0)}</div>
        <div className="text-[10px] text-zinc-500">de {p?.quota ? brl(p.quota) : (folga ? 'folga' : '—')}</div>
        <div className={`text-[11px] font-semibold ${folga ? 'text-sky-300/80' : cls}`}>{folga ? 'folga' : a == null ? 'sem cota' : `${a.toFixed(0)}%`}</div>
      </div>
    );
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <span className="text-sm text-zinc-300">Metas do vendedor</span>
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
          {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-4 h-4" /> Atualizar</button>
      </div>
      <p className="mb-3 text-[11px] text-zinc-500">Quanto cada vendedor fez <strong>vs a cota dele</strong>. A cota vem da aba <strong>Escala &amp; cotas</strong> (semanal): o <strong>dia</strong> usa a cota da semana ÷ dias escalados; a <strong>quinzena</strong> são 2 semanas; o <strong>mês</strong> é a soma das semanas. Verde ≥ 100%, amarelo ≥ 60%, vermelho abaixo.</p>

      {isStale && <StaleNotice status={status} onRetry={load} loadedAt={loadedAt} correlationId={corr} />}
      {!showData && status !== 'idle' && status !== 'loading' && <AnalyticsBanner status={status} onRetry={load} correlationId={corr} />}
      {status === 'loading' && !isStale && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>}

      {showData && data && (
        data.sellers.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">Nenhum vendedor com venda ou cota nesta loja. Cadastre a cota em <strong>Escala &amp; cotas</strong> ou lance o ranking no <strong>Fechamento diário</strong>.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400">
                <tr className="text-[11px] uppercase tracking-wide">
                  <th className="px-3 py-2 text-left font-medium">Vendedor</th>
                  <th className="px-3 py-2 text-right font-medium">Dia<br /><span className="text-[10px] normal-case text-zinc-600">{fmtDM(data.periods?.day?.start)}</span></th>
                  <th className="px-3 py-2 text-right font-medium">Semana<br /><span className="text-[10px] normal-case text-zinc-600">{fmtDM(data.periods?.week?.start)}–{fmtDM(data.periods?.week?.end)}</span></th>
                  <th className="px-3 py-2 text-right font-medium">Quinzena<br /><span className="text-[10px] normal-case text-zinc-600">{fmtDM(data.periods?.fortnight?.start)}–{fmtDM(data.periods?.fortnight?.end)}</span></th>
                  <th className="px-3 py-2 text-right font-medium">Mês<br /><span className="text-[10px] normal-case text-zinc-600">{data.month}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.sellers.map((s: any) => (
                  <tr key={s.sellerKey} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-[13px] text-zinc-200">{s.sellerName || `Matrícula ${s.matricula}`}{s.quotaSource === 'none' && <span className="ml-1 text-[10px] text-amber-300/80">sem cota cadastrada</span>}</td>
                    <td className="px-3 py-2"><Cell p={s.day} /></td>
                    <td className="px-3 py-2"><Cell p={s.week} /></td>
                    <td className="px-3 py-2"><Cell p={s.fortnight} /></td>
                    <td className="px-3 py-2"><Cell p={s.month} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function SellersDirectoryTab() {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [assignFor, setAssignFor] = useState<any>(null);
  const [deleteFor, setDeleteFor] = useState<any>(null);
  // Modal de cadastro/nome: { codigo, initialName, allowCodeEdit }. Sem window.prompt.
  const [nameModal, setNameModal] = useState<{ codigo: string; initialName?: string; allowCodeEdit?: boolean } | null>(null);

  useEffect(() => { apiFetch('/api/retailops/stores').then(r => r.json()).then(d => { const arr = (Array.isArray(d?.stores) ? d.stores : []).filter((s: any) => s.active); setStores(arr); if (!storeId && arr[0]) setStoreId(arr[0].id); }).catch(() => {}); /* eslint-disable-next-line */ }, []);
  const { data: cov, status, corr, isStale, loadedAt, reload: load } =
    useAnalytics(() => storeId ? `/api/retailops/seller-coverage?storeId=${storeId}` : '', [storeId]);
  const showData = status === 'ok' || isStale;
  const storeName = stores.find((s: any) => s.id === storeId)?.name || '';

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        <span className="text-sm text-zinc-300">Vendedores da loja</span>
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
          {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"><RefreshCw className="w-4 h-4" /> Atualizar</button>
        <button onClick={() => setNameModal({ codigo: '', allowCodeEdit: true })} disabled={!storeId} className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"><Plus className="w-4 h-4" /> Cadastrar vendedor</button>
      </div>
      <p className="mb-3 text-[11px] text-zinc-500">Cadastre cada vendedor pela <strong>matrícula (código do PDV)</strong> + nome — dá pra registrar antes mesmo de aparecer nas vendas. Matrícula sem nome é <strong>pendência</strong> (a comissão não sai certa). Código único com muito volume pode ser <strong>caixa compartilhado</strong> (não é uma pessoa): use lançamento manual/foto nessa loja.</p>

      {isStale && <StaleNotice status={status} onRetry={load} loadedAt={loadedAt} correlationId={corr} />}
      {!showData && status !== 'idle' && status !== 'loading' && <AnalyticsBanner status={status} onRetry={load} correlationId={corr} />}
      {status === 'loading' && !isStale && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>}

      {showData && cov && (
        <div className="space-y-4">
          {/* Lotados */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Lotados nesta loja ({cov.counts.lotados})</div>
            {cov.lotados.length === 0 ? <p className="text-[13px] text-zinc-500">Nenhum vendedor lotado. Confirme os nomes abaixo e depois atribua as lojas.</p> : (
              <div className="flex flex-wrap gap-1.5">
                {cov.lotados.map((s: any) => (
                  <div key={s.seller_id} className="inline-flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/40 pl-2.5 pr-1 py-1 text-[13px] text-zinc-200">
                    {s.is_primary ? <Store className="w-3 h-3 text-emerald-400 mr-1" /> : null}
                    <span>{s.name || `Matrícula ${s.matricula}`}</span>
                    <button onClick={() => setAssignFor(s)} title="Editar vendedor / transferir de loja" className="ml-1 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-indigo-300"><Pencil className="w-3 h-3" /></button>
                    <button onClick={() => setDeleteFor(s)} title="Excluir vendedor" className="rounded p-1 text-zinc-500 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="w-3 h-3" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Pendências de nome */}
          {cov.pendingName.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-amber-300/80 mb-1.5">Matrículas sem nome — pendência ({cov.counts.pendingName})</div>
              <div className="space-y-1.5">
                {cov.pendingName.map((p: any) => (
                  <div key={p.codigo} className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
                    <span className="font-mono text-[13px] text-zinc-200">Matrícula {p.codigo}</span>
                    <span className="text-[11px] text-zinc-500">{p.sales} venda(s){p.lastSale ? ` · última ${p.lastSale}` : ''}</span>
                    <button onClick={() => setNameModal({ codigo: p.codigo })} className="ml-auto rounded-md border border-indigo-500/30 px-2 py-0.5 text-[12px] text-indigo-300 hover:bg-indigo-500/10">Dar nome</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Suspeitos de código compartilhado */}
          {cov.sharedCodeSuspects.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-red-300/80 mb-1.5">Suspeita de código compartilhado ({cov.counts.sharedCodeSuspects})</div>
              <div className="space-y-1.5">
                {cov.sharedCodeSuspects.map((p: any) => (
                  <div key={p.codigo} className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-[12px] text-red-200/90">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span className="font-mono">Código {p.codigo}</span>
                    <span className="text-[11px]">{p.sales} vendas num único código — provável caixa/login compartilhado. Não atribua a uma pessoa; use lançamento manual/foto ou o Atendimento de Loja.</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {assignFor && <SellerStoresModal seller={assignFor} stores={stores} onClose={() => setAssignFor(null)} onSaved={() => { setAssignFor(null); load(); }} />}
      {deleteFor && <SellerDeleteModal seller={deleteFor} onClose={() => setDeleteFor(null)} onDeleted={() => { setDeleteFor(null); load(); }} />}
      {nameModal && <SellerNameModal codigo={nameModal.codigo} initialName={nameModal.initialName} allowCodeEdit={nameModal.allowCodeEdit} storeId={storeId} storeName={storeName} stores={stores} onClose={() => setNameModal(null)} onSaved={() => { setNameModal(null); load(); }} />}
    </div>
  );
}

// Formulário de cadastro/nome de vendedor (substitui o window.prompt). Dá nome a
// uma matrícula do PDV e, opcionalmente, LOTA o vendedor na loja atual (SELL-002).
// Em modo "cadastrar" (allowCodeEdit) a matrícula é digitável — dá pra registrar
// um vendedor antes mesmo de ele aparecer nas vendas.
function SellerNameModal({ codigo, initialName, allowCodeEdit, storeId, storeName, stores, onClose, onSaved }: { codigo: string; initialName?: string; allowCodeEdit?: boolean; storeId?: string; storeName?: string; stores?: any[]; onClose: () => void; onSaved: () => void }) {
  const [mat, setMat] = useState(codigo || '');
  const [matTouched, setMatTouched] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [name, setName] = useState(initialName || '');
  // No cadastro, a loja é escolhida aqui (define onde o vendedor é lotado). No
  // modo "dar nome" segue a loja atual da aba.
  const [store, setStore] = useState(storeId || '');
  const [lotar, setLotar] = useState(!!storeId);
  const [saving, setSaving] = useState(false);
  const storeList = stores || [];
  const lotStore = allowCodeEdit ? store : storeId;
  const lotStoreName = allowCodeEdit ? (storeList.find((s: any) => s.id === store)?.name || 'loja escolhida') : (storeName || 'loja atual');

  // Auto-preenche a matrícula no padrão da rede — só no cadastro e enquanto o
  // gestor não digitar à mão. Re-sugere ao trocar de loja (o padrão é por filial).
  useEffect(() => {
    if (!allowCodeEdit || matTouched || !store) return;
    let alive = true;
    setSuggesting(true);
    apiFetch(`/api/retailops/sellers/next-matricula?storeId=${encodeURIComponent(store)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (alive && !matTouched && d?.matricula) setMat(String(d.matricula)); })
      .catch(() => {})
      .finally(() => { if (alive) setSuggesting(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowCodeEdit, store, matTouched]);

  const save = async () => {
    const matricula = mat.trim();
    if (!matricula) { toast.error('Informe a matrícula (código do vendedor no PDV).'); return; }
    if (!name.trim()) { toast.error('Informe o nome do vendedor.'); return; }
    setSaving(true);
    try {
      const r = await apiFetch(`/api/retailops/sellers/${encodeURIComponent(matricula)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Falha ao salvar o vendedor.');
      // Lotação na loja escolhida (opcional) — usa o id devolvido pelo upsert.
      if (lotar && lotStore && d?.id) {
        const rs = await apiFetch(`/api/retailops/sellers/${d.id}/stores`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeIds: [lotStore], primaryStoreId: lotStore }) });
        if (!rs.ok) toast.error('Vendedor salvo, mas a lotação na loja falhou.');
      }
      toast.success('Vendedor salvo.'); onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-zinc-100 mb-1">{allowCodeEdit ? 'Cadastrar vendedor' : `Dar nome à matrícula ${codigo}`}</h3>
        <p className="text-[11px] text-zinc-500 mb-3">A matrícula é o <strong>código do vendedor no PDV</strong> (CAI_USUARIO da Alterdata). O nome sai na comissão e nos relatórios.</p>
        {allowCodeEdit && storeList.length > 0 && (
          <label className="block text-[12px] text-zinc-400 mb-2">Loja do vendedor
            <select value={store} onChange={e => setStore(e.target.value)} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100">
              {storeList.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="block text-[12px] text-zinc-400 mb-2">Matrícula
          <input value={mat} onChange={e => { setMat(e.target.value); setMatTouched(true); }} disabled={!allowCodeEdit} placeholder="Ex.: 1024" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100 disabled:opacity-60 font-mono" />
          {allowCodeEdit && <span className="mt-1 block text-[10px] text-zinc-500">{suggesting ? 'Sugerindo no padrão da rede…' : 'Sugerida automaticamente no padrão da rede — pode editar.'}</span>}
        </label>
        <label className="block text-[12px] text-zinc-400 mb-3">Nome do vendedor
          <input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="Ex.: Maria Souza" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" onKeyDown={e => { if (e.key === 'Enter') save(); }} />
        </label>
        {lotStore && (
          <label className="mb-3 flex items-center gap-2 text-[12px] text-zinc-300">
            <input type="checkbox" checked={lotar} onChange={e => setLotar(e.target.checked)} /> Lotar em <strong>{lotStoreName}</strong>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </div>
    </div>
  );
}

// Confirmação de exclusão (soft delete: desativa a identidade + encerra lotações;
// o histórico de comissão/venda continua pela matrícula).
function SellerDeleteModal({ seller, onClose, onDeleted }: { seller: any; onClose: () => void; onDeleted: () => void }) {
  const [saving, setSaving] = useState(false);
  const label = seller.name || `Matrícula ${seller.matricula}`;
  const del = async () => {
    setSaving(true);
    try {
      const r = await apiFetch(`/api/retailops/sellers/${seller.seller_id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha ao excluir.');
      toast.success('Vendedor excluído.'); onDeleted();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-zinc-100 mb-1">Excluir vendedor</h3>
        <p className="text-[13px] text-zinc-300 mb-2">Remover <strong>{label}</strong> da lista e encerrar as lotações dele nas lojas?</p>
        <p className="text-[11px] text-zinc-500 mb-4">O histórico de comissão e vendas continua preservado pela matrícula. Se a matrícula voltar a vender no PDV, ela reaparece como pendência de nome.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={del} disabled={saving} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">{saving ? 'Excluindo…' : 'Excluir'}</button>
        </div>
      </div>
    </div>
  );
}

// Modal de lotação: em quais lojas o vendedor atua + qual é a principal.
function SellerStoresModal({ seller, stores, onClose, onSaved }: { seller: any; stores: any[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(seller.name || '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [primary, setPrimary] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    apiFetch(`/api/retailops/sellers/${seller.seller_id}/stores`).then(r => r.json()).then(d => {
      const arr = Array.isArray(d?.stores) ? d.stores : [];
      setSelected(new Set(arr.map((s: any) => s.store_id)));
      setPrimary(arr.find((s: any) => s.is_primary)?.store_id || null);
    }).catch(() => {});
  }, [seller.seller_id]);
  const toggle = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const save = async () => {
    if (!name.trim()) { toast.error('Informe o nome do vendedor.'); return; }
    setSaving(true);
    try {
      // Nome (opcional editar) — grava pela matrícula antes de reconciliar as lojas.
      if (name.trim() !== (seller.name || '') && seller.matricula) {
        const rn = await apiFetch(`/api/retailops/sellers/${encodeURIComponent(seller.matricula)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
        if (!rn.ok) throw new Error((await rn.json().catch(() => ({}))).error || 'Falha ao salvar o nome.');
      }
      const r = await apiFetch(`/api/retailops/sellers/${seller.seller_id}/stores`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeIds: [...selected], primaryStoreId: primary && selected.has(primary) ? primary : null }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha');
      toast.success('Vendedor atualizado.'); onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-zinc-100 mb-1">Editar vendedor <span className="font-mono text-[13px] text-zinc-400">· {seller.matricula}</span></h3>
        <p className="text-[11px] text-zinc-500 mb-3">Ajuste o nome e as lojas onde ele atua. A principal é onde ele fica lotado; para <strong>transferir de loja</strong>, marque a nova e torne-a principal (desmarque a antiga).</p>
        <label className="block text-[12px] text-zinc-400 mb-3">Nome do vendedor
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Maria Souza" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-sm text-zinc-100" />
        </label>
        <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Lojas</div>
        <div className="space-y-1.5 max-h-[50vh] overflow-auto">
          {stores.map((s: any) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-1.5">
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
              <span className="text-[13px] text-zinc-200 flex-1">{s.name}</span>
              {selected.has(s.id) && (
                <button onClick={() => setPrimary(s.id)} className={`text-[11px] rounded px-1.5 py-0.5 border ${primary === s.id ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-zinc-700 text-zinc-400'}`}>{primary === s.id ? 'Principal' : 'Tornar principal'}</button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">Cancelar</button>
          <button onClick={save} disabled={saving} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{saving ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </div>
    </div>
  );
}

// ---- Equipe & cobrança (responsáveis por loja) ------------------------------
const RESP_TYPES = ['fechamento', 'malote', 'escala'];
function ResponsiblesTab() {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState<string>('');
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [wa, setWa] = useState('');
  const [types, setTypes] = useState<string[]>([]);

  useEffect(() => {
    apiFetch('/api/retailops/stores').then(r => r.json()).then(d => {
      const st = Array.isArray(d?.stores) ? d.stores : [];
      setStores(st);
      if (st[0]) setStoreId(st[0].id);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const loadList = async (id: string) => {
    if (!id) { setList([]); return; }
    const d = await apiFetch(`/api/retailops/stores/${id}/responsibles`).then(r => r.json()).catch(() => ({}));
    setList(Array.isArray(d?.responsibles) ? d.responsibles : []);
  };
  useEffect(() => { loadList(storeId); /* eslint-disable-next-line */ }, [storeId]);

  const add = async () => {
    if (!wa.trim()) { toast.error('Informe o WhatsApp do responsável.'); return; }
    setAdding(true);
    try {
      const res = await apiFetch(`/api/retailops/stores/${storeId}/responsibles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, whatsappIdentifier: wa, taskTypes: types.length ? types : undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { toast.success('Responsável adicionado.'); setName(''); setWa(''); setTypes([]); loadList(storeId); }
      else toast.error(d.error || 'Falha ao adicionar.');
    } finally { setAdding(false); }
  };
  const remove = async (rid: string) => {
    const res = await apiFetch(`/api/retailops/responsibles/${rid}`, { method: 'DELETE' });
    if (res.ok) { toast.success('Responsável removido.'); loadList(storeId); }
    else toast.error('Falha ao remover.');
  };
  const toggleType = (t: string) => setTypes(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);

  if (loading) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;
  if (stores.length === 0) return <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">Cadastre as lojas da rede para definir os responsáveis pela cobrança.</div>;

  return (
    <div>
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-400">
        Quem recebe a <strong>cobrança pelo WhatsApp</strong> de cada pendência (fechamento/malote/escala) e pode dar baixa respondendo. Sem responsável, a cobrança vai para o número da própria loja.
      </div>
      <label className="text-xs text-zinc-400">Loja
        <select value={storeId} onChange={e => setStoreId(e.target.value)} className="ml-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100">
          {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>

      <div className="mt-4 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 sm:grid-cols-[1fr_1fr_auto]">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome (opcional)" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <input value={wa} onChange={e => setWa(e.target.value)} placeholder="WhatsApp (ex.: 5531988887777)" inputMode="tel" className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100" />
        <button onClick={add} disabled={adding} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">{adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Adicionar</button>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
          <span className="text-[11px] text-zinc-500">Cobra:</span>
          {RESP_TYPES.map(t => (
            <button key={t} onClick={() => toggleType(t)} className={`rounded-full border px-2.5 py-0.5 text-[11px] capitalize ${types.includes(t) ? 'border-indigo-500 bg-indigo-500/15 text-indigo-200' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}>{t}</button>
          ))}
          <span className="text-[11px] text-zinc-600">{types.length === 0 ? '(vazio = todos)' : ''}</span>
        </div>
      </div>

      <div className="mt-4">
        {list.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">Nenhum responsável nesta loja ainda — a cobrança vai para o número da loja.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/60 text-zinc-400"><tr>
                <th className="px-3 py-2 text-left font-medium">Nome</th>
                <th className="px-3 py-2 text-left font-medium">WhatsApp</th>
                <th className="px-3 py-2 text-left font-medium">Cobra</th>
                <th className="px-3 py-2 text-right font-medium">Ações</th>
              </tr></thead>
              <tbody>
                {list.map((r: any) => (
                  <tr key={r.id} className="border-t border-zinc-800/70">
                    <td className="px-3 py-2 text-zinc-200">{r.name || <span className="text-zinc-500">—</span>}</td>
                    <td className="px-3 py-2 text-zinc-300">{r.whatsapp_identifier}</td>
                    <td className="px-3 py-2 text-zinc-400 capitalize">{r.task_types === 'all' ? 'todos' : r.task_types}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => remove(r.id)} title="Remover" className="rounded border border-red-500/40 px-1.5 py-0.5 text-red-300 hover:bg-red-500/10"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'ok' }) {
  const color = tone === 'red' ? 'text-red-300' : tone === 'ok' ? 'text-emerald-300' : 'text-zinc-100';
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}
