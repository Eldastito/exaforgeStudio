import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Play, Square, Coffee, UserX, SkipForward, LogIn, Barcode, Scale, Clock, Users, DoorOpen, DoorClosed, AlertTriangle, Check, X } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

// ============================================================================
// Atendimento de Loja — Lista da Vez (Retail Floor, ADR-150 Fatia 7).
// Kanban da fila + cronômetro + encerramento com taxonomia + consulta de peça
// + conciliação declarado × PDV. Consome a API já testada (/api/retail-floor/*).
// Realtime por POLLING curto (8s): o caminho `/loja/*` é da vitrine pública e
// o snapshot é barato; upgrade pra socket.io se o piloto pedir. Só aparece
// quando o módulo `retail_floor` está habilitado (gate real é o backend).
// ============================================================================

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const parseUtc = (s: string) => new Date(s.replace(' ', 'T') + 'Z').getTime();
const POLL_MS = 8000;

const CATEGORY_LABEL: Record<string, string> = {
  product: 'Produto', price: 'Preço/condição', size_fit: 'Tamanho/modelagem',
  service_time: 'Atendimento/tempo', other: 'Outro',
};
const PRODUCT_REASON_LABEL: Record<string, string> = {
  no_assortment: 'Loja não trabalha', no_local_stock: 'Sem estoque local', no_network_stock: 'Sem estoque na rede',
  missing_size: 'Faltou tamanho', missing_color: 'Faltou cor', missing_category: 'Faltou categoria/grupo',
};
const QSTATUS: Record<string, { label: string; cls: string }> = {
  waiting: { label: 'Aguardando', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  serving: { label: 'Atendendo', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  break: { label: 'Pausa', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  unavailable: { label: 'Indisponível', cls: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/30' },
  skipped: { label: 'Pulado', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
  offline: { label: 'Fora', cls: 'text-zinc-500 bg-zinc-500/10 border-zinc-500/30' },
};
const RECON: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pendente PDV', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  confirmed: { label: 'Confirmada', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  unmatched: { label: 'Sem correspondência', cls: 'text-rose-300 bg-rose-500/10 border-rose-500/30' },
};

function fmtElapsed(totalSec: number) {
  const m = Math.floor(totalSec / 60), s = Math.max(0, Math.trunc(totalSec % 60));
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function api(path: string, body?: any) {
  const res = await apiFetch(`/api/retail-floor${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

export function RetailFloorView() {
  const [ctx, setCtx] = useState<any>(null);
  const [storeId, setStoreId] = useState<string>('');
  const [snap, setSnap] = useState<{ shift: any; queue: any; actives: any[]; fetchedAt: number } | null>(null);
  const [tab, setTab] = useState<'fila' | 'conciliacao' | 'indicadores'>('fila');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [finishing, setFinishing] = useState<any>(null);      // attendance sendo encerrado (modal)
  const [scanFor, setScanFor] = useState<any>(null);          // attendance com painel de consulta aberto
  const pollRef = useRef<any>(null);

  const isManager = (ctx?.manageableStores || []).some((s: any) => s.id === storeId) || ctx?.canConfigure;
  const mySellerId = ctx?.sellerProfile?.sellerId || null;

  const loadCtx = useCallback(async () => {
    try {
      const c = await api('/context');
      setCtx(c);
      const first = c.manageableStores?.[0]?.id || c.stores?.[0]?.id || '';
      setStoreId((prev) => prev || first);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }, []);

  const loadSnap = useCallback(async (sid: string) => {
    if (!sid) return;
    try {
      const [cur, act] = await Promise.all([
        api(`/shifts/current?storeId=${encodeURIComponent(sid)}`),
        api(`/attendances/active?storeId=${encodeURIComponent(sid)}`),
      ]);
      setSnap({ shift: cur.shift, queue: cur.queue, actives: act.attendances || [], fetchedAt: Date.now() });
    } catch (e: any) { /* silencioso no poll; a UI mantém o último snapshot */ }
  }, []);

  useEffect(() => { loadCtx(); }, [loadCtx]);
  useEffect(() => {
    if (!storeId) return;
    loadSnap(storeId);
    pollRef.current = setInterval(() => loadSnap(storeId), POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [storeId, loadSnap]);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  const act = async (fn: () => Promise<any>, okMsg?: string) => {
    setBusy(true);
    try { await fn(); if (okMsg) toast.success(okMsg); await loadSnap(storeId); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const activeBySeller = useMemo(() => {
    const m = new Map<string, any>();
    for (const a of snap?.actives || []) m.set(a.sellerId, a);
    return m;
  }, [snap]);

  const elapsedOf = (a: any) => {
    const base = Number(a.elapsedSeconds || 0);
    const drift = snap ? Math.floor((Date.now() - snap.fetchedAt) / 1000) : 0;
    void tick;
    return base + drift;
  };

  if (loading) return <div className="flex h-full items-center justify-center text-zinc-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Carregando…</div>;
  if (!ctx) return <div className="p-6 text-zinc-400">Módulo indisponível.</div>;

  const shift = snap?.shift;
  const queue: any[] = snap?.queue?.queue || [];
  const cols: Record<string, any[]> = { waiting: [], serving: [], break: [], unavailable: [], skipped: [] };
  for (const q of queue) if (cols[q.status]) cols[q.status].push(q);

  return (
    <div className="space-y-4 p-4">
      {ctx.inCalibration && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4" /> Período de calibração: os indicadores NÃO valem para cobrança/comissão (ADR-150 RN-011).
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select value={storeId} onChange={(e) => setStoreId(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
          {(ctx.stores || []).map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>)}
        </select>
        {shift
          ? <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300"><DoorOpen className="h-3 w-3" /> Turno aberto</span>
          : <span className="inline-flex items-center gap-1 rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 text-xs text-zinc-400"><DoorClosed className="h-3 w-3" /> Sem turno</span>}
        {isManager && !shift && (
          <button disabled={busy} onClick={() => act(() => api('/shifts', { storeId }), 'Turno aberto.')}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white hover:bg-emerald-500">Abrir turno</button>
        )}
        {isManager && shift && (
          <button disabled={busy} onClick={() => act(() => api(`/shifts/${shift.id}/close`, {}), 'Turno fechado.')}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Fechar turno</button>
        )}
        {shift && mySellerId && !queue.some((q) => q.sellerId === mySellerId && q.status !== 'offline') && (
          <button disabled={busy} onClick={() => act(() => api('/queue/join', { storeId }), 'Você entrou na vez.')}
            className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500"><LogIn className="h-4 w-4" /> Entrar na vez</button>
        )}
        {isManager && shift && (ctx.sellers || []).length > 0 && (
          <AddSeller sellers={ctx.sellers} inQueue={new Set(queue.map((q) => q.sellerId))} busy={busy}
            onAdd={(sid) => act(() => api('/queue/join', { storeId, sellerId: sid }), 'Vendedor adicionado.')} />
        )}
        <button disabled={busy} onClick={() => loadSnap(storeId)} className="ml-auto rounded-lg border border-zinc-700 p-2 text-zinc-400 hover:bg-zinc-800"><RefreshCw className="h-4 w-4" /></button>
      </div>

      <div className="flex gap-2 border-b border-zinc-800 text-sm">
        {(['fila', 'conciliacao', ...(isManager ? ['indicadores'] as const : [])] as const).map((t) => (
          <button key={t} onClick={() => setTab(t as any)}
            className={`px-3 py-2 ${tab === t ? 'border-b-2 border-sky-500 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'}`}>
            {t === 'fila' ? 'Lista da Vez' : t === 'conciliacao' ? 'Conciliação PDV' : 'Indicadores'}
          </button>
        ))}
      </div>

      {tab === 'fila' && !shift && <div className="p-6 text-sm text-zinc-500">Nenhum turno aberto nesta loja.</div>}

      {tab === 'fila' && shift && (
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
          {(['waiting', 'serving', 'break', 'unavailable', 'skipped'] as const).map((col) => (
            <div key={col} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-2">
              <div className="mb-2 flex items-center justify-between px-1 text-xs text-zinc-400">
                <span className="inline-flex items-center gap-1">{col === 'waiting' ? <Users className="h-3 w-3" /> : col === 'serving' ? <Clock className="h-3 w-3" /> : null}{QSTATUS[col].label}</span>
                <span>{cols[col].length}</span>
              </div>
              <div className="space-y-2">
                {cols[col].map((q) => {
                  const active = activeBySeller.get(q.sellerId);
                  const mine = q.sellerId === mySellerId;
                  const canAct = mine || isManager;
                  return (
                    <div key={q.sellerId} className={`rounded-lg border p-2 text-sm ${q.next ? 'border-sky-500/60 bg-sky-500/5' : 'border-zinc-800 bg-zinc-900'}`}>
                      <div className="flex items-center justify-between">
                        <div className="font-medium text-zinc-200">{q.sellerName || q.matricula}{mine ? ' (você)' : ''}</div>
                        {q.position != null && <span className={`rounded-full px-2 text-xs ${q.next ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-300'}`}>{q.next ? 'PRÓXIMO' : `#${q.position}`}</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-500">{q.served} atend. no turno{active ? ` · ${fmtElapsed(elapsedOf(active))}` : ''}</div>
                      {canAct && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {col === 'waiting' && (q.next || isManager) && (
                            <IconBtn busy={busy} title="Iniciar atendimento" onClick={() => act(() => api('/attendances/start', { storeId, sellerId: q.sellerId }), 'Atendimento iniciado.')}><Play className="h-3.5 w-3.5" /></IconBtn>
                          )}
                          {col === 'serving' && active && (<>
                            <IconBtn busy={busy} title="Consultar peça" onClick={() => setScanFor(active)}><Barcode className="h-3.5 w-3.5" /></IconBtn>
                            <IconBtn busy={busy} title="Encerrar" onClick={() => setFinishing(active)}><Square className="h-3.5 w-3.5" /></IconBtn>
                          </>)}
                          {col === 'waiting' && <IconBtn busy={busy} title="Pausa" onClick={() => act(() => api(`/queue/${q.sellerId}/status`, { storeId, status: 'break' }))}><Coffee className="h-3.5 w-3.5" /></IconBtn>}
                          {col === 'waiting' && isManager && !mine && <IconBtn busy={busy} title="Pular a vez" onClick={() => act(() => api(`/queue/${q.sellerId}/status`, { storeId, status: 'skipped' }))}><SkipForward className="h-3.5 w-3.5" /></IconBtn>}
                          {(col === 'break' || col === 'skipped' || col === 'unavailable') && <IconBtn busy={busy} title="Voltar pra fila" onClick={() => act(() => api('/queue/join', { storeId, sellerId: mine ? undefined : q.sellerId }))}><LogIn className="h-3.5 w-3.5" /></IconBtn>}
                          {col === 'waiting' && <IconBtn busy={busy} title="Indisponível" onClick={() => act(() => api(`/queue/${q.sellerId}/status`, { storeId, status: 'unavailable' }))}><UserX className="h-3.5 w-3.5" /></IconBtn>}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!cols[col].length && <div className="px-1 pb-1 text-xs text-zinc-600">—</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'conciliacao' && <ReconPanel storeId={storeId} isManager={isManager} />}
      {tab === 'indicadores' && isManager && <AnalyticsPanel storeId={storeId} />}

      {finishing && (
        <FinishModal attendance={finishing} taxonomy={ctx.taxonomy} busy={busy}
          onClose={() => setFinishing(null)}
          onSubmit={(payload) => act(async () => { await api(`/attendances/${finishing.id}/finish`, payload); setFinishing(null); }, 'Atendimento encerrado.')} />
      )}
      {scanFor && <ScanPanel attendance={scanFor} onClose={() => setScanFor(null)} />}
    </div>
  );
}

function IconBtn({ children, title, onClick, busy }: any) {
  return <button disabled={busy} title={title} onClick={onClick} className="rounded-md border border-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-800">{children}</button>;
}

function AddSeller({ sellers, inQueue, onAdd, busy }: any) {
  const [sel, setSel] = useState('');
  const options = sellers.filter((s: any) => !inQueue.has(s.id));
  if (!options.length) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <select value={sel} onChange={(e) => setSel(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-300">
        <option value="">+ vendedor…</option>
        {options.map((s: any) => <option key={s.id} value={s.id}>{s.name || s.matricula}</option>)}
      </select>
      {sel && <button disabled={busy} onClick={() => { onAdd(sel); setSel(''); }} className="rounded-lg bg-zinc-700 px-2 py-2 text-sm text-white hover:bg-zinc-600">OK</button>}
    </span>
  );
}

// ---- Encerramento com taxonomia (Fatia 4) ----------------------------------
function FinishModal({ attendance, taxonomy, onClose, onSubmit, busy }: any) {
  const [outcome, setOutcome] = useState<'converted' | 'not_converted' | 'walkout'>('converted');
  const [value, setValue] = useState('');
  const [pieces, setPieces] = useState('');
  const [category, setCategory] = useState('');
  const [prodReason, setProdReason] = useState('');
  const [size, setSize] = useState(''); const [color, setColor] = useState(''); const [catLabel, setCatLabel] = useState('');
  const [returnTo, setReturnTo] = useState<'waiting' | 'break'>('waiting');

  const submit = () => {
    const payload: any = { outcome, returnTo };
    if (outcome === 'converted') {
      if (value) payload.declaredValue = Number(value.replace(',', '.'));
      if (pieces) payload.declaredPieces = Number(pieces);
    }
    if (outcome === 'not_converted') {
      if (!category) return toast.error('Informe o motivo.');
      payload.reason = { category };
      if (category === 'product') {
        if (!prodReason) return toast.error('Informe o detalhe do produto.');
        payload.reason.productDetail = { reason: prodReason, size: size || undefined, color: color || undefined, categoryLabel: catLabel || undefined };
      }
    }
    onSubmit(payload);
  };

  return (
    <Modal title={`Encerrar — ${attendance.sellerName || ''}`} onClose={onClose}>
      <div className="flex gap-2">
        {(['converted', 'not_converted', 'walkout'] as const).map((o) => (
          <button key={o} onClick={() => setOutcome(o)}
            className={`rounded-lg border px-3 py-2 text-sm ${outcome === o ? 'border-sky-500 bg-sky-500/10 text-sky-300' : 'border-zinc-700 text-zinc-400'}`}>
            {o === 'converted' ? 'Convertido' : o === 'not_converted' ? 'Não convertido' : 'Entrou e saiu'}
          </button>
        ))}
      </div>
      {outcome === 'converted' && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Valor (R$)" className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
          <input value={pieces} onChange={(e) => setPieces(e.target.value)} placeholder="Peças" className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
          <p className="col-span-2 text-xs text-zinc-500">Fica “Pendente PDV” até a conciliação com as vendas do dia confirmar.</p>
        </div>
      )}
      {outcome === 'not_converted' && (
        <div className="mt-3 space-y-2">
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
            <option value="">Motivo…</option>
            {(taxonomy?.notConvertedCategories || []).map((c: string) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}
          </select>
          {category === 'product' && (<>
            <select value={prodReason} onChange={(e) => setProdReason(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
              <option value="">Detalhe do produto…</option>
              {(taxonomy?.productReasons || []).map((r: string) => <option key={r} value={r}>{PRODUCT_REASON_LABEL[r] || r}</option>)}
            </select>
            <div className="grid grid-cols-3 gap-2">
              <input value={size} onChange={(e) => setSize(e.target.value)} placeholder="Tamanho" className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
              <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="Cor" className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
              <input value={catLabel} onChange={(e) => setCatLabel(e.target.value)} placeholder="Categoria" className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
            </div>
          </>)}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm text-zinc-400">
        Depois:
        <button onClick={() => setReturnTo('waiting')} className={`rounded-lg border px-2 py-1 text-xs ${returnTo === 'waiting' ? 'border-sky-500 text-sky-300' : 'border-zinc-700'}`}>volto pra fila</button>
        <button onClick={() => setReturnTo('break')} className={`rounded-lg border px-2 py-1 text-xs ${returnTo === 'break' ? 'border-sky-500 text-sky-300' : 'border-zinc-700'}`}>pausa</button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300">Cancelar</button>
        <button disabled={busy} onClick={submit} className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500">Encerrar</button>
      </div>
    </Modal>
  );
}

// ---- Consulta de peça no atendimento (Fatia 5) ------------------------------
function ScanPanel({ attendance, onClose }: any) {
  const [ean, setEan] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [unmetReason, setUnmetReason] = useState('');
  const [unmetDetail, setUnmetDetail] = useState('');

  const doScan = async () => {
    if (!ean) return;
    setBusy(true);
    try { setResult(await api(`/attendances/${attendance.id}/scan`, { ean })); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const doUnmet = async () => {
    if (!result?.scanId || !unmetReason || !unmetDetail) return toast.error('Informe o que faltou.');
    setBusy(true);
    try {
      const field = unmetReason === 'missing_size' ? 'size' : unmetReason === 'missing_color' ? 'color' : 'categoryLabel';
      await api(`/attendances/${attendance.id}/unmet-demand`, { scanId: result.scanId, reason: unmetReason, [field]: unmetDetail });
      toast.success('Demanda registrada.');
      setUnmetReason(''); setUnmetDetail('');
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={`Consultar peça — ${attendance.sellerName || ''}`} onClose={onClose}>
      <div className="flex gap-2">
        <input value={ean} onChange={(e) => setEan(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doScan()} autoFocus
          placeholder="Bipe ou digite o código de barras" className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
        <button disabled={busy} onClick={doScan} className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Consultar'}</button>
      </div>
      {result && (
        <div className="mt-3 space-y-2 text-sm">
          {result.syncStale && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">Estoque desatualizado (última sync: {result.syncedAt || '—'}).</div>}
          {!result.found ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">Peça fora do catálogo — demanda “loja não trabalha” registrada.</div>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <div className="font-medium text-zinc-200">{result.product.name}{result.variant ? ` — ${result.variant.name}` : ''}</div>
              <div className="text-zinc-400">{brl(result.product.price)}</div>
              <div className="mt-1 text-zinc-300">Nesta loja: <b className={result.localStock > 0 ? 'text-emerald-300' : 'text-rose-300'}>{result.localStock}</b> · Rede: <b>{result.networkStock}</b></div>
              {result.otherStores?.length > 0 && (
                <div className="mt-1 text-xs text-zinc-400">Tem em: {result.otherStores.map((s: any) => `${s.storeName} (${s.quantity})`).join(', ')}</div>
              )}
              {result.unmetDemand && <div className="mt-1 text-xs text-rose-300">Sem estoque em toda a rede — demanda registrada.</div>}
              <div className="mt-2 flex items-center gap-2">
                <select value={unmetReason} onChange={(e) => setUnmetReason(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300">
                  <option value="">Cliente pediu e faltou…</option>
                  <option value="missing_size">Tamanho</option>
                  <option value="missing_color">Cor</option>
                  <option value="missing_category">Categoria</option>
                </select>
                {unmetReason && <input value={unmetDetail} onChange={(e) => setUnmetDetail(e.target.value)} placeholder="Qual?" className="w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200" />}
                {unmetReason && <button disabled={busy} onClick={doUnmet} className="rounded-lg bg-zinc-700 px-2 py-1.5 text-xs text-white">Registrar</button>}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---- Conciliação declarado × PDV (Fatia 6) ----------------------------------
function ReconPanel({ storeId, isManager }: { storeId: string; isManager: boolean }) {
  const [date, setDate] = useState(todayStr());
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!storeId) return;
    try { setData(await api(`/reconciliation?storeId=${encodeURIComponent(storeId)}&date=${date}`)); }
    catch (e: any) { toast.error(e.message); }
  }, [storeId, date]);
  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setBusy(true);
    try { setData(await api('/reconciliation/run', { storeId, date })); toast.success('Conciliação executada.'); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const override = async (attId: string, state: string) => {
    setBusy(true);
    try { await api(`/reconciliation/${attId}/state`, { state }); await load(); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const t = data?.totals;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
        {isManager && <button disabled={busy} onClick={run} className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500"><Scale className="h-4 w-4" /> Conciliar agora</button>}
      </div>
      {t && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Stat label="Declaradas" v={t.declaredCount} />
          <Stat label="Confirmadas" v={t.confirmed} cls="text-emerald-300" />
          <Stat label="Sem corresp." v={t.unmatched} cls="text-rose-300" />
          <Stat label="Declarado" v={brl(t.declaredValue)} />
          <Stat label={`PDV (gap ${brl(t.gap)})`} v={brl(t.erpValue)} />
        </div>
      )}
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs text-zinc-500">
            <tr><th className="p-2">Vendedor</th><th className="p-2">Início</th><th className="p-2">Valor decl.</th><th className="p-2">Estado</th>{isManager && <th className="p-2">Override</th>}</tr>
          </thead>
          <tbody>
            {(data?.attendances || []).map((a: any) => (
              <tr key={a.id} className="border-t border-zinc-800">
                <td className="p-2 text-zinc-200">{a.sellerName || a.matricula}</td>
                <td className="p-2 text-zinc-400">{String(a.startedAt).slice(11, 16)}</td>
                <td className="p-2 text-zinc-300">{a.declaredValue != null ? brl(a.declaredValue) : '—'}</td>
                <td className="p-2"><span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] ${RECON[a.state]?.cls || 'text-zinc-400 border-zinc-700'}`}>{RECON[a.state]?.label || a.state || '—'}</span></td>
                {isManager && (
                  <td className="p-2">
                    <span className="inline-flex gap-1">
                      <button disabled={busy} title="Confirmar" onClick={() => override(a.id, 'confirmed')} className="rounded-md border border-zinc-700 p-1 text-emerald-300 hover:bg-zinc-800"><Check className="h-3.5 w-3.5" /></button>
                      <button disabled={busy} title="Sem correspondência" onClick={() => override(a.id, 'unmatched')} className="rounded-md border border-zinc-700 p-1 text-rose-300 hover:bg-zinc-800"><X className="h-3.5 w-3.5" /></button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
            {!data?.attendances?.length && <tr><td colSpan={5} className="p-4 text-center text-zinc-600">Nenhuma conversão declarada no dia.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Indicadores da loja (Fatia 9) ------------------------------------------
const LOSS_LABEL: Record<string, string> = {
  price: 'Preço/condição', size_fit: 'Tamanho/modelagem', service_time: 'Atendimento/tempo', other: 'Outro',
  'product:no_assortment': 'Produto: fora do mix', 'product:no_local_stock': 'Produto: sem estoque local',
  'product:no_network_stock': 'Produto: sem estoque na rede', 'product:missing_size': 'Produto: faltou tamanho',
  'product:missing_color': 'Produto: faltou cor', 'product:missing_category': 'Produto: faltou categoria',
};

function AnalyticsPanel({ storeId }: { storeId: string }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    if (!storeId) return;
    const end = todayStr();
    const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    api(`/analytics/store?storeId=${encodeURIComponent(storeId)}&start=${start}&end=${end}`)
      .then(setData).catch((e: any) => toast.error(e.message));
  }, [storeId, days]);

  if (!data) return <div className="p-6 text-zinc-500"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Carregando…</div>;
  const t = data.totals;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {[1, 7, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${days === d ? 'border-sky-500 text-sky-300' : 'border-zinc-700 text-zinc-400'}`}>
            {d === 1 ? 'Hoje' : `${d} dias`}
          </button>
        ))}
        {data.inCalibration && <span className="ml-auto text-xs text-amber-300">Calibração até {data.calibrationUntil}: números NÃO valem pra cobrança.</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Stat label="Atendimentos" v={t.attendances} />
        <Stat label="Conv. confirmada" v={t.conversionConfirmedPct != null ? `${t.conversionConfirmedPct}%` : '—'} cls="text-emerald-300" />
        <Stat label="Conv. declarada" v={t.conversionDeclaredPct != null ? `${t.conversionDeclaredPct}%` : '—'} />
        <Stat label="Pend. PDV" v={t.pendingCount} cls="text-amber-300" />
        <Stat label="TMA" v={t.avgServiceMinutes != null ? `${t.avgServiceMinutes} min` : '—'} />
        <Stat label="Valor confirmado" v={brl(t.confirmedValue)} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 p-3">
          <div className="mb-2 text-sm font-medium text-zinc-300">Por vendedor <span className="text-xs text-zinc-500">(ordem alfabética — não é ranking)</span></div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500"><tr><th>Vendedor</th><th>Atend.</th><th>Decl.</th><th>Conf.</th><th>TMA</th></tr></thead>
            <tbody>
              {data.bySeller.map((s: any) => (
                <tr key={s.sellerId} className="border-t border-zinc-800 text-zinc-300">
                  <td className="py-1">{s.sellerName}</td><td>{s.attendances}</td><td>{s.declared}</td><td className="text-emerald-300">{s.confirmed}</td><td>{s.avgMinutes != null ? `${s.avgMinutes}m` : '—'}</td>
                </tr>
              ))}
              {!data.bySeller.length && <tr><td colSpan={5} className="py-2 text-zinc-600">Sem dados no período.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border border-zinc-800 p-3">
          <div className="mb-2 text-sm font-medium text-zinc-300">Por que não converteu (Pareto)</div>
          {data.lossPareto.map((l: any) => (
            <div key={l.reason} className="flex justify-between border-t border-zinc-800 py-1 text-sm text-zinc-300">
              <span>{LOSS_LABEL[l.reason] || l.reason}</span><span className="text-rose-300">{l.count}</span>
            </div>
          ))}
          {!data.lossPareto.length && <div className="py-2 text-sm text-zinc-600">Sem perdas registradas.</div>}
          <div className="mb-2 mt-4 text-sm font-medium text-zinc-300">Top rupturas (peça pedida e faltou)</div>
          {data.topUnmet.map((u: any, i: number) => (
            <div key={i} className="flex justify-between border-t border-zinc-800 py-1 text-sm text-zinc-300">
              <span>{u.item} <span className="text-xs text-zinc-500">({PRODUCT_REASON_LABEL[u.reason] || u.reason})</span></span><span className="text-amber-300">{u.count}</span>
            </div>
          ))}
          {!data.topUnmet.length && <div className="py-2 text-sm text-zinc-600">Sem rupturas evidenciadas.</div>}
        </div>
      </div>
      <div className="rounded-xl border border-zinc-800 p-3">
        <div className="mb-2 text-sm font-medium text-zinc-300">Atendimentos por hora de início</div>
        <div className="flex items-end gap-1" style={{ height: 80 }}>
          {data.byHour.map((h: any) => {
            const max = Math.max(...data.byHour.map((x: any) => x.count), 1);
            return (
              <div key={h.hour} className="flex flex-col items-center" title={`${h.hour}h: ${h.count}`}>
                <div className="w-6 rounded-t bg-sky-600/70" style={{ height: `${(h.count / max) * 60 + 4}px` }} />
                <span className="text-[10px] text-zinc-500">{h.hour}h</span>
              </div>
            );
          })}
          {!data.byHour.length && <span className="text-sm text-zinc-600">Sem dados.</span>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, v, cls }: any) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold ${cls || 'text-zinc-200'}`}>{v}</div>
    </div>
  );
}

function Modal({ title, children, onClose }: any) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-medium text-zinc-200">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
