import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Avatar } from '@/src/components/ui/Avatar';
import { cn } from '@/src/lib/utils';
import {
  Loader2, RefreshCw, Play, Square, Coffee, UserX, LogIn, Barcode,
  Scale, Clock, Users, DoorOpen, DoorClosed, AlertTriangle, Check, X,
  ChevronDown, Timer, UserPlus, ArrowLeft, ScanLine, ShoppingBag,
} from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
const todayStr = () => new Date().toISOString().slice(0, 10);
const POLL_MS = 8000;

const CATEGORY_LABEL: Record<string, string> = {
  product: 'Produto', price: 'Preço/condição', size_fit: 'Tamanho/modelagem',
  service_time: 'Atendimento/tempo', other: 'Outro',
};
const PRODUCT_REASON_LABEL: Record<string, string> = {
  no_assortment: 'Loja não trabalha', no_local_stock: 'Sem estoque local', no_network_stock: 'Sem estoque na rede',
  missing_size: 'Faltou tamanho', missing_color: 'Faltou cor', missing_category: 'Faltou categoria/grupo',
};
const STATUS_LABEL: Record<string, string> = {
  break: 'Pausa', unavailable: 'Indisponível', skipped: 'Pulado',
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

// ============================================================================
// Main View
// ============================================================================

export function RetailFloorView() {
  const [ctx, setCtx] = useState<any>(null);
  const [storeId, setStoreId] = useState<string>('');
  const [snap, setSnap] = useState<{ shift: any; queue: any; actives: any[]; fetchedAt: number } | null>(null);
  const [tab, setTab] = useState<'fila' | 'conciliacao' | 'indicadores' | 'rede'>('fila');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [finishing, setFinishing] = useState<any>(null);
  const [scanFor, setScanFor] = useState<any>(null);
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
    } catch { /* silencioso no poll */ }
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

  if (loading) return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="mr-2 h-6 w-6 animate-spin text-[var(--color-flow)]" />
      <span className="text-[var(--color-text-muted)]">Carregando…</span>
    </div>
  );
  if (!ctx) return <div className="p-6 text-[var(--color-text-muted)]">Módulo indisponível.</div>;

  const shift = snap?.shift;
  const queue: any[] = snap?.queue?.queue || [];
  const waiting = queue.filter((q) => q.status === 'waiting');
  const serving = queue.filter((q) => q.status === 'serving');
  const out = queue.filter((q) => q.status === 'break' || q.status === 'unavailable' || q.status === 'skipped');
  const totalServedToday = queue.reduce((s, q) => s + (q.served || 0), 0);
  const storeName = (ctx.stores || []).find((s: any) => s.id === storeId)?.name || '';

  const tabs = [
    { key: 'fila' as const, label: 'Lista da Vez' },
    { key: 'conciliacao' as const, label: 'Conciliação PDV' },
    ...(isManager ? [{ key: 'indicadores' as const, label: 'Indicadores' }] : []),
    ...(ctx.canConfigure ? [{ key: 'rede' as const, label: 'Rede' }] : []),
  ];

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination || !isManager) return;
    const { source, destination, draggableId } = result;
    if (source.droppableId === destination.droppableId) return;
    const sellerId = draggableId;

    if (source.droppableId === 'waiting' && destination.droppableId === 'serving') {
      act(() => api('/attendances/start', { storeId, sellerId }), 'Atendimento iniciado.');
    } else if (source.droppableId === 'waiting' && destination.droppableId === 'out') {
      act(() => api(`/queue/${sellerId}/status`, { storeId, status: 'break' }));
    } else if (source.droppableId === 'out' && destination.droppableId === 'waiting') {
      act(() => api('/queue/join', { storeId, sellerId }));
    } else if (source.droppableId === 'serving') {
      toast.error('Encerre o atendimento antes de mover.');
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {ctx.inCalibration && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Calibração ativa — indicadores NÃO valem para cobrança.
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-6">
        <select value={storeId} onChange={(e) => setStoreId(e.target.value)}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-strong)] focus:border-[var(--color-flow)] focus:outline-none focus:ring-1 focus:ring-[var(--color-flow)]/30">
          {(ctx.stores || []).map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ''}</option>)}
        </select>

        {shift ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-400">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> Turno aberto
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/10 px-3 py-1.5 text-xs font-semibold text-zinc-500">
            <DoorClosed className="h-3 w-3" /> Sem turno
          </span>
        )}

        {isManager && !shift && (
          <button disabled={busy} onClick={() => act(() => api('/shifts', { storeId }), 'Turno aberto.')}
            className="rounded-xl bg-[var(--color-flow)] px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-all hover:brightness-110 active:scale-95">
            <DoorOpen className="mr-1.5 inline h-4 w-4" />Abrir turno
          </button>
        )}
        {isManager && shift && (
          <button disabled={busy} onClick={() => act(() => api(`/shifts/${shift.id}/close`, {}), 'Turno fechado.')}
            className="rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-2)]">
            Fechar turno
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          {shift && isManager && (ctx.sellers || []).length > 0 && (
            <AddSeller sellers={ctx.sellers} inQueue={new Set(queue.map((q) => q.sellerId))} busy={busy}
              onAdd={(sid: string) => act(() => api('/queue/join', { storeId, sellerId: sid }), 'Vendedor adicionado.')} />
          )}
          {shift && mySellerId && !queue.some((q) => q.sellerId === mySellerId && q.status !== 'offline') && (
            <button disabled={busy} onClick={() => act(() => api('/queue/join', { storeId }), 'Você entrou na fila.')}
              className="rounded-xl bg-[var(--color-flow)] px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-all hover:brightness-110 active:scale-95">
              <LogIn className="mr-1.5 inline h-4 w-4" />Entrar na vez
            </button>
          )}
          <button disabled={busy} onClick={() => loadSnap(storeId)}
            className="rounded-xl border border-[var(--color-border)] p-2.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-2)]">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {shift && (
        <div className="grid grid-cols-2 gap-2 px-4 pb-3 md:grid-cols-4 md:px-6">
          <StatTile icon={<Users className="h-4 w-4" />} label="Na fila" value={String(waiting.length)} accent="teal" />
          <StatTile icon={<Timer className="h-4 w-4" />} label="Atendendo" value={String(serving.length)} accent="blue" />
          <StatTile icon={<ShoppingBag className="h-4 w-4" />} label="Atend. hoje" value={String(totalServedToday)} />
          <StatTile icon={<Clock className="h-4 w-4" />} label="Equipe" value={`${queue.length} vendedores`} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] px-4 md:px-6">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn(
              'whitespace-nowrap px-4 py-2.5 text-sm font-semibold transition-colors',
              tab === t.key
                ? 'border-b-2 border-[var(--color-flow)] text-[var(--color-flow)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-strong)]'
            )}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        {tab === 'fila' && !shift && <EmptyShift isManager={isManager} busy={busy} onOpen={() => act(() => api('/shifts', { storeId }), 'Turno aberto.')} />}

        {tab === 'fila' && shift && (
          <DragDropContext onDragEnd={handleDragEnd}>
            <div className="grid gap-4 md:grid-cols-3">
              <QueueSection id="serving" title="Em Atendimento" count={serving.length} accent="blue" icon={<Timer className="h-4 w-4" />}
                emptyText="Nenhum vendedor atendendo">
                {serving.map((q, i) => {
                  const att = activeBySeller.get(q.sellerId);
                  return (
                    <SellerCard key={q.sellerId} q={q} index={i} att={att} elapsed={att ? elapsedOf(att) : 0}
                      isMine={q.sellerId === mySellerId} isManager={isManager} busy={busy} variant="serving"
                      onScan={() => att && setScanFor(att)} onFinish={() => att && setFinishing(att)} />
                  );
                })}
              </QueueSection>

              <QueueSection id="waiting" title="Esperando a Vez" count={waiting.length} accent="teal" icon={<Users className="h-4 w-4" />}
                emptyText="Nenhum vendedor na fila">
                {waiting.map((q, i) => (
                  <SellerCard key={q.sellerId} q={q} index={i} isMine={q.sellerId === mySellerId} isManager={isManager} busy={busy} variant="waiting"
                    onStart={() => act(() => api('/attendances/start', { storeId, sellerId: q.sellerId }), 'Atendimento iniciado.')}
                    onBreak={() => act(() => api(`/queue/${q.sellerId}/status`, { storeId, status: 'break' }))}
                    onUnavailable={() => act(() => api(`/queue/${q.sellerId}/status`, { storeId, status: 'unavailable' }))} />
                ))}
              </QueueSection>

              <QueueSection id="out" title="Fora da Fila" count={out.length} accent="muted" icon={<Coffee className="h-4 w-4" />}
                emptyText="—" collapsible>
                {out.map((q, i) => (
                  <SellerCard key={q.sellerId} q={q} index={i} isMine={q.sellerId === mySellerId} isManager={isManager} busy={busy} variant="out"
                    onRejoin={() => act(() => api('/queue/join', { storeId, sellerId: q.sellerId === mySellerId ? undefined : q.sellerId }))} />
                ))}
              </QueueSection>
            </div>
          </DragDropContext>
        )}

        {tab === 'conciliacao' && <ReconPanel storeId={storeId} isManager={isManager} />}
        {tab === 'indicadores' && isManager && <AnalyticsPanel storeId={storeId} />}
        {tab === 'rede' && ctx.canConfigure && <NetworkPanel />}
      </div>

      {finishing && (
        <FinishModal attendance={finishing} taxonomy={ctx.taxonomy} busy={busy}
          onClose={() => setFinishing(null)}
          onSubmit={(payload: any) => act(async () => { await api(`/attendances/${finishing.id}/finish`, payload); setFinishing(null); }, 'Atendimento encerrado.')} />
      )}
      {scanFor && <ScanPanel attendance={scanFor} onClose={() => setScanFor(null)} />}
    </div>
  );
}

// ============================================================================
// Queue Section (Droppable column)
// ============================================================================

function QueueSection({ id, title, count, accent, icon, emptyText, collapsible, children }: {
  id: string; title: string; count: number; accent: 'blue' | 'teal' | 'muted';
  icon: React.ReactNode; emptyText: string; collapsible?: boolean; children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const accentMap = {
    blue: 'border-t-[var(--color-intelligence)]',
    teal: 'border-t-[var(--color-flow)]',
    muted: 'border-t-zinc-600',
  };
  const dotMap = {
    blue: 'bg-[var(--color-intelligence)]',
    teal: 'bg-[var(--color-flow)]',
    muted: 'bg-zinc-500',
  };

  return (
    <div className={cn('flex flex-col rounded-2xl border border-[var(--color-border)] border-t-2 bg-[var(--color-surface-1)]/50', accentMap[accent])}>
      <button type="button" onClick={collapsible ? () => setCollapsed(!collapsed) : undefined}
        className={cn('flex items-center gap-2 px-4 py-3', collapsible && 'cursor-pointer hover:bg-[var(--color-surface-2)]/50 rounded-t-2xl')}>
        <span className={cn('h-2.5 w-2.5 rounded-full', dotMap[accent])} />
        <span className="text-sm font-semibold text-[var(--color-text-strong)]" style={{ fontFamily: 'var(--font-display)' }}>{title}</span>
        <span className="rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-xs font-semibold text-[var(--color-text-muted)]">{count}</span>
        {collapsible && <ChevronDown className={cn('ml-auto h-4 w-4 text-zinc-500 transition-transform', collapsed && '-rotate-90')} />}
      </button>

      {!collapsed && (
        <Droppable droppableId={id}>
          {(provided, snapshot) => (
            <div ref={provided.innerRef} {...provided.droppableProps}
              className={cn(
                'flex-1 space-y-2 px-3 pb-3 transition-colors min-h-[48px]',
                snapshot.isDraggingOver && 'bg-[var(--color-surface-2)]/40 rounded-b-2xl'
              )}>
              {children}
              {provided.placeholder}
              {count === 0 && <p className="py-4 text-center text-sm text-zinc-600">{emptyText}</p>}
            </div>
          )}
        </Droppable>
      )}
    </div>
  );
}

// ============================================================================
// Seller Card (Draggable)
// ============================================================================

function SellerCard({ q, index, att, elapsed, isMine, isManager, busy, variant, onStart, onFinish, onScan, onBreak, onUnavailable, onRejoin }: {
  key?: React.Key; q: any; index: number; att?: any; elapsed?: number; isMine: any; isManager: any; busy: any;
  variant: 'waiting' | 'serving' | 'out';
  onStart?: () => void; onFinish?: () => void; onScan?: () => void;
  onBreak?: () => void; onUnavailable?: () => void; onRejoin?: () => void;
}) {
  const canAct = isMine || isManager;
  const isNext = q.next && variant === 'waiting';

  return (
    <Draggable draggableId={q.sellerId} index={index} isDragDisabled={!canAct}>
      {(provided, snapshot) => (
        <div ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}
          className={cn(
            'group flex items-center gap-3 rounded-xl border p-3 transition-all',
            variant === 'serving' && 'border-[var(--color-intelligence)]/30 bg-[var(--color-intelligence)]/5',
            variant === 'waiting' && !isNext && 'border-[var(--color-border)] bg-[var(--color-surface-1)] hover:border-[var(--color-flow)]/30',
            variant === 'waiting' && isNext && 'border-[var(--color-flow)]/50 bg-[var(--color-flow)]/5 shadow-[0_0_12px_var(--color-flow)/10]',
            variant === 'out' && 'border-[var(--color-border)] bg-[var(--color-surface-1)] opacity-70',
            snapshot.isDragging && 'rotate-1 scale-105 shadow-xl ring-2 ring-[var(--color-flow)] !opacity-100',
            isMine && 'ring-1 ring-[var(--color-flow)]/20',
          )}>

          {/* Avatar */}
          <div className="relative shrink-0">
            <Avatar name={q.sellerName || q.matricula} size={44} className="border-2 border-[var(--color-border)]" />
            {variant === 'serving' && (
              <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--color-surface-1)] bg-[var(--color-intelligence)]" />
            )}
            {isNext && (
              <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--color-surface-1)] bg-[var(--color-flow)]" />
            )}
          </div>

          {/* Info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-[var(--color-text-strong)]">
                {q.sellerName || q.matricula}
              </span>
              {isMine && <span className="shrink-0 rounded bg-[var(--color-flow)]/15 px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-flow)]">VOCÊ</span>}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              {variant === 'serving' && elapsed != null && (
                <span className="inline-flex items-center gap-1 font-mono text-sm font-bold text-[var(--color-intelligence)]">
                  <Clock className="h-3 w-3" />{fmtElapsed(elapsed)}
                </span>
              )}
              {variant === 'waiting' && isNext && (
                <span className="inline-flex items-center gap-1 font-semibold text-[var(--color-flow)]">Próximo</span>
              )}
              {variant === 'waiting' && !isNext && q.position != null && (
                <span>#{q.position} na fila</span>
              )}
              {variant === 'out' && (
                <span className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                  q.status === 'break' && 'bg-amber-500/15 text-amber-400',
                  q.status === 'unavailable' && 'bg-zinc-500/15 text-zinc-400',
                  q.status === 'skipped' && 'bg-rose-500/15 text-rose-400',
                )}>{STATUS_LABEL[q.status] || q.status}</span>
              )}
              <span className="text-zinc-600">{q.served} atend.</span>
            </div>
          </div>

          {/* Actions */}
          {canAct && (
            <div className="flex shrink-0 items-center gap-1.5">
              {variant === 'waiting' && (isNext || isManager) && onStart && (
                <ActionBtn busy={busy} title="Iniciar atendimento" accent="teal" onClick={onStart}>
                  <Play className="h-4 w-4" />
                </ActionBtn>
              )}
              {variant === 'serving' && onScan && (
                <ActionBtn busy={busy} title="Consultar peça" onClick={onScan}>
                  <ScanLine className="h-4 w-4" />
                </ActionBtn>
              )}
              {variant === 'serving' && onFinish && (
                <ActionBtn busy={busy} title="Encerrar atendimento" accent="emerald" onClick={onFinish}>
                  <Check className="h-4 w-4" />
                </ActionBtn>
              )}
              {variant === 'waiting' && onBreak && (
                <ActionBtn busy={busy} title="Pausa" onClick={onBreak} className="hidden group-hover:flex md:flex">
                  <Coffee className="h-3.5 w-3.5" />
                </ActionBtn>
              )}
              {variant === 'waiting' && isManager && !isMine && onUnavailable && (
                <ActionBtn busy={busy} title="Indisponível" onClick={onUnavailable} className="hidden group-hover:flex md:flex">
                  <UserX className="h-3.5 w-3.5" />
                </ActionBtn>
              )}
              {variant === 'out' && onRejoin && (
                <ActionBtn busy={busy} title="Voltar pra fila" accent="teal" onClick={onRejoin}>
                  <ArrowLeft className="h-4 w-4" />
                </ActionBtn>
              )}
            </div>
          )}
        </div>
      )}
    </Draggable>
  );
}

function ActionBtn({ children, title, onClick, busy, accent, className }: {
  children: React.ReactNode; title: string; onClick: () => void; busy: boolean;
  accent?: 'teal' | 'emerald'; className?: string;
}) {
  return (
    <button disabled={busy} title={title} onClick={onClick}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-xl border transition-all active:scale-90',
        accent === 'teal' && 'border-[var(--color-flow)]/40 bg-[var(--color-flow)]/10 text-[var(--color-flow)] hover:bg-[var(--color-flow)]/20',
        accent === 'emerald' && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20',
        !accent && 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]',
        className,
      )}>
      {children}
    </button>
  );
}

// ============================================================================
// Empty shift state
// ============================================================================

function EmptyShift({ isManager, busy, onOpen }: { isManager: boolean; busy: boolean; onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)]">
        <DoorClosed className="h-10 w-10 text-zinc-600" />
      </div>
      <h3 className="mt-5 text-lg font-semibold text-[var(--color-text-strong)]" style={{ fontFamily: 'var(--font-display)' }}>
        Nenhum turno aberto
      </h3>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">Abra o turno para iniciar a lista da vez.</p>
      {isManager && (
        <button disabled={busy} onClick={onOpen}
          className="mt-5 rounded-xl bg-[var(--color-flow)] px-5 py-3 text-sm font-semibold text-zinc-950 transition-all hover:brightness-110 active:scale-95">
          <DoorOpen className="mr-2 inline h-4 w-4" />Abrir turno
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Add Seller dropdown (manager)
// ============================================================================

function AddSeller({ sellers, inQueue, onAdd, busy }: any) {
  const [sel, setSel] = useState('');
  const options = sellers.filter((s: any) => !inQueue.has(s.id));
  if (!options.length) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <select value={sel} onChange={(e) => setSel(e.target.value)}
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2.5 text-sm text-[var(--color-text-muted)] focus:border-[var(--color-flow)] focus:outline-none">
        <option value="">
          <UserPlus className="h-4 w-4" /> Adicionar…
        </option>
        {options.map((s: any) => <option key={s.id} value={s.id}>{s.name || s.matricula}</option>)}
      </select>
      {sel && (
        <button disabled={busy} onClick={() => { onAdd(sel); setSel(''); }}
          className="rounded-xl bg-[var(--color-flow)] px-3 py-2.5 text-sm font-semibold text-zinc-950 transition-all hover:brightness-110">
          OK
        </button>
      )}
    </span>
  );
}

// ============================================================================
// Finish attendance modal
// ============================================================================

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

  const outcomes = [
    { key: 'converted' as const, label: 'Venda realizada', icon: <Check className="h-5 w-5" />, cls: 'border-emerald-500 bg-emerald-500/10 text-emerald-400' },
    { key: 'not_converted' as const, label: 'Não convertido', icon: <X className="h-5 w-5" />, cls: 'border-rose-500 bg-rose-500/10 text-rose-400' },
    { key: 'walkout' as const, label: 'Entrou e saiu', icon: <DoorOpen className="h-5 w-5" />, cls: 'border-amber-500 bg-amber-500/10 text-amber-400' },
  ];

  return (
    <Modal title={`Encerrar atendimento`} subtitle={attendance.sellerName} onClose={onClose}>
      {/* Outcome buttons */}
      <div className="grid grid-cols-3 gap-2">
        {outcomes.map((o) => (
          <button key={o.key} onClick={() => setOutcome(o.key)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-xl border-2 p-3 text-xs font-semibold transition-all',
              outcome === o.key ? o.cls : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]'
            )}>
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>

      {outcome === 'converted' && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Input value={value} onChange={setValue} placeholder="Valor (R$)" />
          <Input value={pieces} onChange={setPieces} placeholder="Peças" />
          <p className="col-span-2 text-xs text-[var(--color-text-muted)]">Fica "Pendente PDV" até a conciliação com o caixa confirmar.</p>
        </div>
      )}

      {outcome === 'not_converted' && (
        <div className="mt-4 space-y-3">
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm text-[var(--color-text-strong)] focus:border-[var(--color-flow)] focus:outline-none">
            <option value="">Por que não converteu?</option>
            {(taxonomy?.notConvertedCategories || []).map((c: string) => <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>)}
          </select>
          {category === 'product' && (<>
            <select value={prodReason} onChange={(e) => setProdReason(e.target.value)}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm text-[var(--color-text-strong)] focus:border-[var(--color-flow)] focus:outline-none">
              <option value="">O que faltou?</option>
              {(taxonomy?.productReasons || []).map((r: string) => <option key={r} value={r}>{PRODUCT_REASON_LABEL[r] || r}</option>)}
            </select>
            <div className="grid grid-cols-3 gap-2">
              <Input value={size} onChange={setSize} placeholder="Tamanho" />
              <Input value={color} onChange={setColor} placeholder="Cor" />
              <Input value={catLabel} onChange={setCatLabel} placeholder="Grupo" />
            </div>
          </>)}
        </div>
      )}

      {/* Return to queue */}
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
        <span className="text-xs text-[var(--color-text-muted)]">Depois:</span>
        <button onClick={() => setReturnTo('waiting')}
          className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
            returnTo === 'waiting' ? 'bg-[var(--color-flow)]/15 text-[var(--color-flow)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]')}>
          Voltar pra fila
        </button>
        <button onClick={() => setReturnTo('break')}
          className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
            returnTo === 'break' ? 'bg-amber-500/15 text-amber-400' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]')}>
          Pausa
        </button>
      </div>

      <div className="mt-5 flex gap-3">
        <button onClick={onClose} className="flex-1 rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm font-semibold text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-2)]">
          Cancelar
        </button>
        <button disabled={busy} onClick={submit}
          className="flex-1 rounded-xl bg-[var(--color-flow)] px-4 py-3 text-sm font-semibold text-zinc-950 transition-all hover:brightness-110 active:scale-95">
          Encerrar
        </button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Barcode scan panel
// ============================================================================

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
      toast.success('Demanda registrada.'); setUnmetReason(''); setUnmetDetail('');
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Consultar peça" subtitle={attendance.sellerName} onClose={onClose}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={ean} onChange={(e) => setEan(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doScan()} autoFocus
            placeholder="Bipe ou digite o código de barras"
            className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] py-3 pl-10 pr-4 text-sm text-[var(--color-text-strong)] focus:border-[var(--color-flow)] focus:outline-none focus:ring-1 focus:ring-[var(--color-flow)]/30" />
        </div>
        <button disabled={busy} onClick={doScan}
          className="rounded-xl bg-[var(--color-flow)] px-4 py-3 text-sm font-semibold text-zinc-950 transition-all hover:brightness-110 active:scale-95">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Barcode className="h-4 w-4" />}
        </button>
      </div>

      {result && (
        <div className="mt-4 space-y-3">
          {result.syncStale && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Estoque desatualizado (sync: {result.syncedAt || '—'})
            </div>
          )}
          {!result.found ? (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-center text-sm text-rose-300">
              Peça fora do catálogo — demanda registrada automaticamente.
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
              <div className="text-sm font-semibold text-[var(--color-text-strong)]">{result.product.name}{result.variant ? ` — ${result.variant.name}` : ''}</div>
              <div className="mt-1 text-sm text-[var(--color-text-muted)]">{brl(result.product.price)}</div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-[var(--color-surface-2)] p-3 text-center">
                  <div className={cn('text-xl font-bold', result.localStock > 0 ? 'text-emerald-400' : 'text-rose-400')}>{result.localStock}</div>
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">Nesta loja</div>
                </div>
                <div className="rounded-lg bg-[var(--color-surface-2)] p-3 text-center">
                  <div className="text-xl font-bold text-[var(--color-text-strong)]">{result.networkStock}</div>
                  <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">Na rede</div>
                </div>
              </div>
              {result.otherStores?.length > 0 && (
                <div className="mt-3 space-y-1">
                  <div className="text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">Disponível em</div>
                  {result.otherStores.map((s: any, i: number) => (
                    <div key={i} className="flex justify-between text-xs text-[var(--color-text-muted)]">
                      <span>{s.storeName}</span><span className="font-semibold text-emerald-400">{s.quantity}</span>
                    </div>
                  ))}
                </div>
              )}
              {result.unmetDemand && <div className="mt-3 text-xs text-rose-300">Sem estoque em toda a rede — demanda registrada.</div>}
              <div className="mt-3 flex items-center gap-2">
                <select value={unmetReason} onChange={(e) => setUnmetReason(e.target.value)}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs text-[var(--color-text-muted)] focus:outline-none">
                  <option value="">Cliente pediu e faltou…</option>
                  <option value="missing_size">Tamanho</option>
                  <option value="missing_color">Cor</option>
                  <option value="missing_category">Categoria</option>
                </select>
                {unmetReason && <Input value={unmetDetail} onChange={setUnmetDetail} placeholder="Qual?" className="w-20 !text-xs !py-2" />}
                {unmetReason && <button disabled={busy} onClick={doUnmet} className="rounded-xl bg-zinc-700 px-3 py-2 text-xs font-semibold text-white">Registrar</button>}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ============================================================================
// Reconciliation Panel
// ============================================================================

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-2.5 text-sm text-[var(--color-text-strong)] focus:border-[var(--color-flow)] focus:outline-none" />
        {isManager && (
          <button disabled={busy} onClick={run}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-flow)] px-4 py-2.5 text-sm font-semibold text-zinc-950 transition-all hover:brightness-110">
            <Scale className="h-4 w-4" /> Conciliar agora
          </button>
        )}
      </div>
      {t && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Stat label="Declaradas" v={t.declaredCount} />
          <Stat label="Confirmadas" v={t.confirmed} cls="text-emerald-400" />
          <Stat label="Sem corresp." v={t.unmatched} cls="text-rose-400" />
          <Stat label="Declarado" v={brl(t.declaredValue)} />
          <Stat label={`PDV (gap ${brl(t.gap)})`} v={brl(t.erpValue)} />
        </div>
      )}
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-2)] text-left text-xs text-[var(--color-text-muted)]">
            <tr><th className="p-3">Vendedor</th><th className="p-3">Início</th><th className="p-3">Valor</th><th className="p-3">Estado</th>{isManager && <th className="p-3"></th>}</tr>
          </thead>
          <tbody>
            {(data?.attendances || []).map((a: any) => (
              <tr key={a.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-1)]/50">
                <td className="p-3 text-[var(--color-text-strong)]">{a.sellerName || a.matricula}</td>
                <td className="p-3 text-[var(--color-text-muted)]">{String(a.startedAt).slice(11, 16)}</td>
                <td className="p-3">{a.declaredValue != null ? brl(a.declaredValue) : '—'}</td>
                <td className="p-3"><span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold', RECON[a.state]?.cls || 'text-zinc-400 border-zinc-700')}>{RECON[a.state]?.label || a.state || '—'}</span></td>
                {isManager && (
                  <td className="p-3">
                    <span className="inline-flex gap-1">
                      <button disabled={busy} title="Confirmar" onClick={() => override(a.id, 'confirmed')} className="rounded-lg border border-[var(--color-border)] p-1.5 text-emerald-400 hover:bg-emerald-500/10"><Check className="h-3.5 w-3.5" /></button>
                      <button disabled={busy} title="Sem correspondência" onClick={() => override(a.id, 'unmatched')} className="rounded-lg border border-[var(--color-border)] p-1.5 text-rose-400 hover:bg-rose-500/10"><X className="h-3.5 w-3.5" /></button>
                    </span>
                  </td>
                )}
              </tr>
            ))}
            {!data?.attendances?.length && <tr><td colSpan={5} className="p-6 text-center text-[var(--color-text-muted)]">Nenhuma conversão declarada no dia.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// Analytics Panel
// ============================================================================

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

  if (!data) return <div className="p-6 text-[var(--color-text-muted)]"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Carregando…</div>;
  const t = data.totals;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {[1, 7, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={cn('rounded-xl border px-4 py-2 text-sm font-semibold transition-colors',
              days === d ? 'border-[var(--color-flow)] text-[var(--color-flow)] bg-[var(--color-flow)]/10' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]')}>
            {d === 1 ? 'Hoje' : `${d} dias`}
          </button>
        ))}
        {data.inCalibration && <span className="ml-auto text-xs text-amber-300">Calibração: números NÃO valem pra cobrança.</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Stat label="Atendimentos" v={t.attendances} />
        <Stat label="Conv. confirmada" v={t.conversionConfirmedPct != null ? `${t.conversionConfirmedPct}%` : '—'} cls="text-emerald-400" />
        <Stat label="Conv. declarada" v={t.conversionDeclaredPct != null ? `${t.conversionDeclaredPct}%` : '—'} />
        <Stat label="Pend. PDV" v={t.pendingCount} cls="text-amber-300" />
        <Stat label="TMA" v={t.avgServiceMinutes != null ? `${t.avgServiceMinutes} min` : '—'} />
        <Stat label="Valor confirmado" v={brl(t.confirmedValue)} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)]/50 p-4">
          <div className="mb-3 text-sm font-semibold text-[var(--color-text-strong)]">Por vendedor <span className="text-xs font-normal text-[var(--color-text-muted)]">(alfabético)</span></div>
          <div className="space-y-2">
            {data.bySeller.map((s: any) => (
              <div key={s.sellerId} className="flex items-center gap-3 rounded-xl bg-[var(--color-surface-2)]/50 px-3 py-2">
                <Avatar name={s.sellerName} size={32} />
                <span className="flex-1 text-sm text-[var(--color-text-strong)]">{s.sellerName}</span>
                <span className="text-xs text-[var(--color-text-muted)]">{s.attendances} atend.</span>
                <span className="text-xs text-emerald-400">{s.confirmed} conf.</span>
                <span className="text-xs text-[var(--color-text-muted)]">{s.avgMinutes != null ? `${s.avgMinutes}m` : '—'}</span>
              </div>
            ))}
            {!data.bySeller.length && <p className="py-2 text-sm text-zinc-600">Sem dados no período.</p>}
          </div>
        </div>
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)]/50 p-4">
          <div className="mb-3 text-sm font-semibold text-[var(--color-text-strong)]">Por que não converteu</div>
          {data.lossPareto.map((l: any) => (
            <div key={l.reason} className="flex justify-between border-t border-[var(--color-border)] py-2 text-sm">
              <span className="text-[var(--color-text-muted)]">{LOSS_LABEL[l.reason] || l.reason}</span>
              <span className="font-semibold text-rose-400">{l.count}</span>
            </div>
          ))}
          {!data.lossPareto.length && <p className="py-2 text-sm text-zinc-600">Sem perdas registradas.</p>}
          <div className="mb-3 mt-5 text-sm font-semibold text-[var(--color-text-strong)]">Rupturas (peça pedida e faltou)</div>
          {data.topUnmet.map((u: any, i: number) => (
            <div key={i} className="flex justify-between border-t border-[var(--color-border)] py-2 text-sm">
              <span className="text-[var(--color-text-muted)]">{u.item} <span className="text-[10px]">({PRODUCT_REASON_LABEL[u.reason] || u.reason})</span></span>
              <span className="font-semibold text-amber-400">{u.count}</span>
            </div>
          ))}
          {!data.topUnmet.length && <p className="py-2 text-sm text-zinc-600">Sem rupturas.</p>}
        </div>
      </div>
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)]/50 p-4">
        <div className="mb-3 text-sm font-semibold text-[var(--color-text-strong)]">Atendimentos por hora</div>
        <div className="flex items-end gap-1" style={{ height: 80 }}>
          {data.byHour.map((h: any) => {
            const max = Math.max(...data.byHour.map((x: any) => x.count), 1);
            return (
              <div key={h.hour} className="flex flex-col items-center" title={`${h.hour}h: ${h.count}`}>
                <div className="w-6 rounded-t bg-[var(--color-flow)]/60" style={{ height: `${(h.count / max) * 60 + 4}px` }} />
                <span className="text-[10px] text-[var(--color-text-muted)]">{h.hour}h</span>
              </div>
            );
          })}
          {!data.byHour.length && <span className="text-sm text-zinc-600">Sem dados.</span>}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Network Panel
// ============================================================================

function NetworkPanel() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    const end = todayStr();
    const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    api(`/analytics/network?start=${start}&end=${end}`).then(setData).catch((e: any) => toast.error(e.message));
  }, [days]);

  if (!data) return <div className="p-6 text-[var(--color-text-muted)]"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Carregando…</div>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {[7, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)}
            className={cn('rounded-xl border px-4 py-2 text-sm font-semibold transition-colors',
              days === d ? 'border-[var(--color-flow)] text-[var(--color-flow)] bg-[var(--color-flow)]/10' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]')}>
            {d} dias
          </button>
        ))}
        {data.inCalibration && <span className="ml-auto text-xs text-amber-300">Calibração: números NÃO valem pra cobrança.</span>}
      </div>
      <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-2)] text-left text-xs text-[var(--color-text-muted)]">
            <tr><th className="p-3">Loja</th><th className="p-3">Atend.</th><th className="p-3">Conv. conf.</th><th className="p-3">Conv. decl.</th><th className="p-3">Pend.</th><th className="p-3">Sem corresp.</th><th className="p-3">TMA</th><th className="p-3">Confirmado</th><th className="p-3">Rupturas</th></tr>
          </thead>
          <tbody>
            {data.stores.map((s: any) => (
              <tr key={s.storeId} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-1)]/50">
                <td className="p-3 font-semibold text-[var(--color-text-strong)]">{s.storeName}{s.code ? ` (${s.code})` : ''}</td>
                <td className="p-3">{s.attendances}</td>
                <td className="p-3 text-emerald-400">{s.conversionConfirmedPct != null ? `${s.conversionConfirmedPct}%` : '—'}</td>
                <td className="p-3">{s.conversionDeclaredPct != null ? `${s.conversionDeclaredPct}%` : '—'}</td>
                <td className="p-3 text-amber-300">{s.pendingCount}</td>
                <td className="p-3 text-rose-400">{s.unmatchedCount}</td>
                <td className="p-3">{s.avgServiceMinutes != null ? `${s.avgServiceMinutes}m` : '—'}</td>
                <td className="p-3">{brl(s.confirmedValue)}</td>
                <td className="p-3 text-amber-400">{s.unmetCount}</td>
              </tr>
            ))}
            {!data.stores.length && <tr><td colSpan={9} className="p-6 text-center text-[var(--color-text-muted)]">Sem lojas ativas.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">Ordem alfabética — a comparação é sua; o sistema não ranqueia lojas.</p>
    </div>
  );
}

// ============================================================================
// Shared components
// ============================================================================

function StatTile({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent?: 'teal' | 'blue' }) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3',
      accent === 'teal' && 'border-[var(--color-flow)]/20',
      accent === 'blue' && 'border-[var(--color-intelligence)]/20',
    )}>
      <span className={cn(
        'flex h-8 w-8 items-center justify-center rounded-lg',
        accent === 'teal' && 'bg-[var(--color-flow)]/15 text-[var(--color-flow)]',
        accent === 'blue' && 'bg-[var(--color-intelligence)]/15 text-[var(--color-intelligence)]',
        !accent && 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)]',
      )}>{icon}</span>
      <div>
        <div className="text-lg font-bold text-[var(--color-text-strong)]" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        <div className="text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">{label}</div>
      </div>
    </div>
  );
}

function Stat({ label, v, cls }: any) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <div className="text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">{label}</div>
      <div className={cn('text-lg font-bold', cls || 'text-[var(--color-text-strong)]')} style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</div>
    </div>
  );
}

function Modal({ title, subtitle, children, onClose }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 md:items-center md:p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-background)] p-5 md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-[var(--color-text-strong)]" style={{ fontFamily: 'var(--font-display)' }}>{title}</h3>
            {subtitle && <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-zinc-500 hover:bg-[var(--color-surface-2)]"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Input({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className={cn('rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3 text-sm text-[var(--color-text-strong)] focus:border-[var(--color-flow)] focus:outline-none focus:ring-1 focus:ring-[var(--color-flow)]/30', className)} />
  );
}
