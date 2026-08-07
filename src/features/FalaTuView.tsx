import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FC, type PointerEvent as ReactPointerEvent } from 'react';
import { Mic, Square, Send, ImageIcon, Loader2, Check, X, ListTodo, CalendarDays, Brain, Sun, Inbox, Receipt } from 'lucide-react';
import { toast } from '@/src/lib/toast';
import { apiFetch } from '@/src/lib/api';
import { enqueueCapture, isNetworkError, pendingFalatuCount } from '@/src/lib/falatu/offlineQueue';

// FalaTu (ADR-151, Fatia 1) — captura multimodal "Fala → Faz → Confere".
// Visível só pro Master Admin (Sidebar gateia por isMasterAdmin, cosmético);
// a segurança real é o requireMasterAdmin no mount de /api/falatu (server.ts),
// mesmo padrão do AdminMasterView/RadarConsultantView.

async function api(path: string, opts: RequestInit = {}) {
  const res = await apiFetch(`/api/falatu${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Erro (${res.status})`);
  return json;
}

const INTENT_LABEL: Record<string, string> = {
  TASK: 'Tarefa', EVENT: 'Compromisso', LIST: 'Lista', NOTE: 'Nota', UNKNOWN: 'Não identificado',
};

type InboxItem = {
  id: string; status: string; intent: string; summary: string | null; transcription: string | null;
  content: string | null; entities_json: string | null; suggested_action: string | null;
  confidence: number | null; media_type: string | null; created_at: string; memory_json?: string | null;
};

type Mention = {
  mention: string; type: string; status: 'new' | 'known' | 'ambiguous';
  candidates: { id: string; name: string; context: string | null }[];
  resolvedEntityId: string | null; resolvedNew: boolean;
};

function parseMentions(item: InboxItem): Mention[] {
  try { return JSON.parse(item.memory_json || 'null')?.mentions || []; } catch { return []; }
}

function parseEntities(item: InboxItem) {
  try { return JSON.parse(item.entities_json || '{}'); } catch { return {}; }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Cartão de confirmação: o humano revisa (e pode editar) ANTES de materializar.
const ConfirmCard: FC<{ item: InboxItem; onResolved: () => void }> = ({ item, onResolved }) => {
  const ents = parseEntities(item);
  const mentions = parseMentions(item);
  const ambiguous = mentions.filter((m) => m.status === 'ambiguous');
  const known = mentions.filter((m) => m.status === 'known' && m.resolvedEntityId);
  const [intent, setIntent] = useState(item.intent || 'UNKNOWN');
  const [title, setTitle] = useState(item.summary || '');
  const [eventDate, setEventDate] = useState<string>(ents.eventDate || '');
  const [eventTime, setEventTime] = useState<string>(ents.eventTime || '');
  const [listItems, setListItems] = useState<string>((ents.listItems || []).join('\n'));
  const [mentionRes, setMentionRes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const resolve = async (action: 'confirm' | 'discard') => {
    setBusy(true);
    try {
      if (action === 'discard') {
        await api(`/inbox/${item.id}/discard`, { method: 'POST' });
        toast.success('Item descartado.');
      } else {
        const chosen = Object.fromEntries(Object.entries(mentionRes).filter(([, v]) => v));
        await api(`/inbox/${item.id}/confirm`, {
          method: 'POST',
          body: JSON.stringify({
            intent, title,
            eventDate: intent === 'EVENT' ? (eventDate || null) : undefined,
            eventTime: intent === 'EVENT' ? (eventTime || null) : undefined,
            listItems: intent === 'LIST' ? listItems.split('\n').map((s) => s.trim()).filter(Boolean) : undefined,
            mentionResolutions: Object.keys(chosen).length ? chosen : undefined,
          }),
        });
        toast.success('Confirmado!');
      }
      onResolved();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const lowConfidence = (item.confidence ?? 0) < 0.7;

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-violet-300">
          {INTENT_LABEL[item.intent] || item.intent} sugerida pela IA
          {item.media_type && <span className="ml-2 text-zinc-500">({item.media_type === 'audio' ? 'áudio' : 'imagem'})</span>}
        </span>
        {lowConfidence && (
          <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5">
            Confiança baixa — revise com atenção
          </span>
        )}
      </div>
      {item.transcription && <p className="text-sm text-zinc-400 italic">"{item.transcription}"</p>}
      {item.suggested_action && <p className="text-sm text-zinc-300">{item.suggested_action}</p>}

      <div className="grid gap-2 sm:grid-cols-2">
        <select value={intent} onChange={(e) => setIntent(e.target.value)}
          className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-zinc-200">
          {Object.entries(INTENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título"
          className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-zinc-200" />
      </div>
      {intent === 'EVENT' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {/* RN-151: a IA não inventa data — sem data na fala, o campo chega vazio e É O HUMANO que preenche. */}
          <input type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)}
            className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-zinc-200" />
          <input type="time" value={eventTime} onChange={(e) => setEventTime(e.target.value)}
            className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-zinc-200" />
        </div>
      )}
      {intent === 'LIST' && (
        <textarea value={listItems} onChange={(e) => setListItems(e.target.value)} rows={4}
          placeholder="Um item por linha"
          className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-zinc-200" />
      )}

      {/* Fatia 5 — memória: auto-vínculo transparente + desambiguação ativa.
          Ambígua sem escolha NÃO vincula nem cria (o servidor nunca chuta). */}
      {known.map((m) => {
        const linked = m.candidates.find((c) => c.id === m.resolvedEntityId);
        return linked && linked.name !== m.mention ? (
          <p key={`${m.type}:${m.mention}`} className="text-xs text-zinc-400 flex items-center gap-1.5">
            <Brain className="h-3.5 w-3.5 text-violet-300" /> {m.mention} → <span className="text-zinc-200">{linked.name}</span> (da sua memória)
          </p>
        ) : null;
      })}
      {ambiguous.map((m) => (
        <div key={`${m.type}:${m.mention}`} className="flex items-center gap-2">
          <span className="text-xs text-violet-300 flex items-center gap-1.5 shrink-0">
            <Brain className="h-3.5 w-3.5" /> Qual <strong>{m.mention}</strong>?
          </span>
          <select value={mentionRes[m.mention] || ''} onChange={(e) => setMentionRes((p) => ({ ...p, [m.mention]: e.target.value }))}
            className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-zinc-200">
            <option value="">Não vincular agora</option>
            {m.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.context ? ` — ${c.context}` : ''}</option>)}
            <option value="new">Outro / novo</option>
          </select>
        </div>
      ))}

      <div className="flex gap-2">
        <button disabled={busy} onClick={() => resolve('confirm')}
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar
        </button>
        <button disabled={busy} onClick={() => resolve('discard')}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 hover:bg-slate-800 px-4 py-2 text-sm text-zinc-300 disabled:opacity-50">
          <X className="h-4 w-4" /> Descartar
        </button>
      </div>
    </div>
  );
}

// Reconciliação da conferência de compras (Fatia 4): a IA leu a nota e o
// matching é só SUGESTÃO — o humano escolhe o que marcar como comprado e quais
// extras (fora da lista) puxar. Nada acontece sem o "Confirmar" (RN-151).
const PurchaseCheckCard: FC<{ check: any; onResolved: () => void }> = ({ check, onResolved }) => {
  const matching = (() => { try { return JSON.parse(check.matching_json || '{}'); } catch { return {}; } })();
  const matched: any[] = matching.matched || [];
  const missing: any[] = matching.missing || [];
  const extras: any[] = matching.extras || [];
  const [selected, setSelected] = useState<Set<string>>(new Set(matched.map((m) => m.listItemId)));
  const [selExtras, setSelExtras] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const flip = <T,>(set: Set<T>, v: T, apply: (s: Set<T>) => void) => {
    const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); apply(n);
  };
  const act = async (path: string, body?: any) => {
    setBusy(true);
    try { await api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); onResolved(); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const cost = (m: any) => (m.unitCost != null ? ` · R$ ${Number(m.unitCost).toFixed(2)}` : '');

  return (
    <div className="mx-3 mb-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 space-y-2">
      <p className="text-xs text-violet-300 font-semibold flex items-center gap-1.5">
        <Receipt className="h-3.5 w-3.5" /> Conferência da nota{check.supplier_name ? ` — ${check.supplier_name}` : ''}
        {Number(check.confidence) < 60 && <span className="text-amber-300">(leitura com baixa confiança — revise)</span>}
      </p>
      {matched.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Na nota (marcar como comprado)</p>
          {matched.map((m) => (
            <button key={m.listItemId} onClick={() => flip(selected, m.listItemId, setSelected)} className="w-full flex items-center gap-2 py-0.5 text-left">
              <span className={`h-4 w-4 shrink-0 rounded border flex items-center justify-center ${selected.has(m.listItemId) ? 'bg-emerald-600 border-emerald-600' : 'border-slate-600'}`}>
                {selected.has(m.listItemId) && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className="text-sm text-zinc-300">{m.listItemName} <span className="text-zinc-500">→ {m.invoiceName}{m.quantity != null ? ` (${m.quantity}${m.unit ? ` ${m.unit}` : ''})` : ''}{cost(m)}</span></span>
            </button>
          ))}
        </div>
      )}
      {missing.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Não veio na nota</p>
          {missing.map((m) => <p key={m.listItemId} className="text-sm text-amber-300/80 py-0.5">• {m.name}</p>)}
        </div>
      )}
      {extras.length > 0 && (
        <div>
          <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">Na nota, fora da lista (opcional: puxar pra lista)</p>
          {extras.map((x) => (
            <button key={x.invoiceIndex} onClick={() => flip(selExtras, x.invoiceIndex, setSelExtras)} className="w-full flex items-center gap-2 py-0.5 text-left">
              <span className={`h-4 w-4 shrink-0 rounded border flex items-center justify-center ${selExtras.has(x.invoiceIndex) ? 'bg-violet-600 border-violet-600' : 'border-slate-600'}`}>
                {selExtras.has(x.invoiceIndex) && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className="text-sm text-zinc-400">{x.name}{x.quantity != null ? ` (${x.quantity}${x.unit ? ` ${x.unit}` : ''})` : ''}{cost(x)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button disabled={busy} onClick={() => act(`/purchase-checks/${check.id}/confirm`, { listItemIds: [...selected], addExtras: [...selExtras] })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-3 py-1.5 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirmar conferência
        </button>
        <button disabled={busy} onClick={() => act(`/purchase-checks/${check.id}/discard`)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 text-zinc-300 hover:text-white text-sm px-3 py-1.5 disabled:opacity-50">
          <X className="h-4 w-4" /> Descartar
        </button>
      </div>
    </div>
  );
};

export function FalaTuView() {
  const [tab, setTab] = useState<'inbox' | 'tasks' | 'events' | 'lists' | 'memory' | 'briefing'>('inbox');
  const [text, setText] = useState('');
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<InboxItem[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [lists, setLists] = useState<any[]>([]);
  const [listItemsById, setListItemsById] = useState<Record<string, any[]>>({});
  const [checkByListId, setCheckByListId] = useState<Record<string, any>>({});
  const [checkingListId, setCheckingListId] = useState<string | null>(null);
  const [entities, setEntities] = useState<any[]>([]);
  const [briefing, setBriefing] = useState<any | null>(null);
  const [signals, setSignals] = useState<any[]>([]);
  const [waEnabled, setWaEnabled] = useState<boolean>(false);
  const [waBusy, setWaBusy] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const checkFileRef = useRef<HTMLInputElement | null>(null);
  const checkListIdRef = useRef<string | null>(null);
  // F8.2 — press-and-hold + deep link + fila offline.
  const [recMode, setRecMode] = useState<'hold' | 'auto'>('hold');
  const [recSecs, setRecSecs] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const discardRef = useRef(false);      // onstop descarta em vez de enviar (toque acidental)
  const heldRef = useRef(false);         // ponteiro ainda pressionado? (getUserMedia é assíncrono)
  const recStartRef = useRef(0);
  const recTimerRef = useRef<number | null>(null);

  const loadPending = useCallback(() => {
    api('/inbox?status=pending').then((d) => setPending(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);
  const loadTab = useCallback(() => {
    if (tab === 'tasks') api('/tasks').then(setTasks).catch(() => {});
    if (tab === 'events') api('/events').then(setEvents).catch(() => {});
    if (tab === 'lists') api('/lists').then(setLists).catch(() => {});
    if (tab === 'memory') api('/entities').then(setEntities).catch(() => {});
    if (tab === 'briefing') {
      api('/briefing').then(setBriefing).catch(() => {});
      api('/signals').then((d) => setSignals(Array.isArray(d) ? d : [])).catch(() => {});
      api('/briefing/whatsapp').then((d) => setWaEnabled(!!d?.enabled)).catch(() => {});
    }
  }, [tab]);

  useEffect(() => { loadPending(); }, [loadPending]);
  useEffect(() => { loadTab(); }, [loadTab]);

  const refreshQueued = useCallback(() => { pendingFalatuCount().then(setQueuedCount).catch(() => {}); }, []);

  // F8.2 — quando o flusher entrega uma captura enfileirada, o sender dispara
  // este evento (desacopla de QUEM roda o flusher: App da suíte ou FalatuApp).
  useEffect(() => {
    refreshQueued();
    const onSynced = () => { refreshQueued(); loadPending(); };
    window.addEventListener('falatu:outbox-sent', onSynced);
    return () => window.removeEventListener('falatu:outbox-sent', onSynced);
  }, [refreshQueued, loadPending]);

  const capture = async (payload: any) => {
    setProcessing(true);
    try {
      await api('/capture', { method: 'POST', body: JSON.stringify(payload) });
      setText('');
      loadPending();
    } catch (e: any) {
      // F8.2 — sem rede a captura NÃO se perde: vai pro outbox (ADR-082) e o
      // flusher reenvia com commandId (o backend deduplica — nunca duplica).
      if (isNetworkError(e)) {
        try {
          await enqueueCapture(crypto.randomUUID(), payload);
          setText('');
          refreshQueued();
          toast.info('Sem conexão — captura guardada. Envio automático quando a internet voltar.');
        } catch { toast.error('Sem conexão e não deu pra guardar a captura. Tente de novo.'); }
      } else {
        toast.error(e.message);
      }
    } finally {
      setProcessing(false);
    }
  };

  const sendText = () => { if (text.trim()) capture({ text }); };

  const startRecording = async (mode: 'hold' | 'auto') => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimerRef.current) { window.clearInterval(recTimerRef.current); recTimerRef.current = null; }
        setRecSecs(0);
        if (discardRef.current) return;
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size > 1_300_000) { toast.error('Áudio muito longo (máx ~1MB). Grave um memo mais curto.'); return; }
        const data = await blobToBase64(blob);
        capture({ audio: { mimeType: mime, data } });
      };
      rec.start();
      mediaRecorderRef.current = rec;
      recStartRef.current = Date.now();
      recTimerRef.current = window.setInterval(() => setRecSecs(Math.floor((Date.now() - recStartRef.current) / 1000)), 250);
      setRecMode(mode);
      setRecording(true);
      // getUserMedia é assíncrono: se o dedo já soltou enquanto o navegador
      // pedia permissão, não deixa a gravação rodando "sozinha".
      if (mode === 'hold' && !heldRef.current) stopRecording(true);
    } catch {
      toast.error('Não foi possível acessar o microfone.');
    }
  };

  const stopRecording = (discard = false) => {
    if (!mediaRecorderRef.current) return;
    discardRef.current = discard;
    mediaRecorderRef.current.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  };

  // Press-and-hold (estilo WhatsApp): segura → grava; solta → envia. Toque
  // mais curto que 500ms é quase sempre acidental — descarta e ensina o gesto
  // (melhor que mandar áudio vazio pra IA, que custa).
  const holdStart = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (processing || recording) return;
    heldRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    void startRecording('hold');
  };
  const holdEnd = () => {
    heldRef.current = false;
    if (!recording || recMode !== 'hold') return;
    const heldMs = Date.now() - recStartRef.current;
    if (heldMs < 500) { stopRecording(true); toast.info('Segure o botão enquanto fala; solte pra enviar.'); }
    else stopRecording(false);
  };

  // F8.2 — deep link ?rec=1: adesivo NFC/atalho abre o app JÁ gravando (modo
  // 'auto': toque pra parar e enviar). O parâmetro sai do histórico pra
  // refresh não disparar gravação de novo sozinho.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('rec') !== '1') return;
    params.delete('rec');
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    void startRecording('auto');
    // roda uma vez no mount — startRecording estável o suficiente pra isto
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 1_300_000) { toast.error('Imagem muito grande (máx ~1MB). Comprima antes.'); return; }
    const data = await blobToBase64(file);
    capture({ image: { mimeType: file.type || 'image/jpeg', data } });
  };

  const toggleTask = async (t: any) => {
    try {
      await api(`/tasks/${t.id}/toggle`, { method: 'POST', body: JSON.stringify({ completed: !t.completed }) });
      api('/tasks').then(setTasks).catch(() => {});
    } catch (e: any) { toast.error(e.message); }
  };

  const openList = async (l: any) => {
    if (listItemsById[l.id]) { setListItemsById((p) => { const n = { ...p }; delete n[l.id]; return n; }); return; }
    try {
      const items = await api(`/lists/${l.id}/items`);
      setListItemsById((p) => ({ ...p, [l.id]: items }));
      // Restaura conferência pendente (a foto pode ter sido enviada em outra sessão).
      const check = await api(`/lists/${l.id}/purchase-check`).catch(() => null);
      setCheckByListId((p) => ({ ...p, [l.id]: check || null }));
    } catch (e: any) { toast.error(e.message); }
  };

  const startPurchaseCheck = (listId: string) => {
    checkListIdRef.current = listId;
    checkFileRef.current?.click();
  };

  const onCheckImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const listId = checkListIdRef.current;
    if (!file || !listId) return;
    if (file.size > 1_300_000) { toast.error('Imagem muito grande (máx ~1MB). Comprima antes.'); return; }
    setCheckingListId(listId);
    try {
      const data = await blobToBase64(file);
      const check = await api(`/lists/${listId}/purchase-check`, {
        method: 'POST',
        body: JSON.stringify({ image: { mimeType: file.type || 'image/jpeg', data } }),
      });
      setCheckByListId((p) => ({ ...p, [listId]: check }));
    } catch (e: any) { toast.error(e.message); }
    finally { setCheckingListId(null); }
  };

  const onCheckResolved = async (listId: string) => {
    setCheckByListId((p) => ({ ...p, [listId]: null }));
    try {
      const items = await api(`/lists/${listId}/items`);
      setListItemsById((p) => ({ ...p, [listId]: items }));
      api('/lists').then(setLists).catch(() => {});
    } catch { /* noop */ }
  };

  const toggleListItem = async (listId: string, item: any) => {
    try {
      await api(`/list-items/${item.id}/toggle`, { method: 'POST', body: JSON.stringify({ realized: !item.realized }) });
      const items = await api(`/lists/${listId}/items`);
      setListItemsById((p) => ({ ...p, [listId]: items }));
    } catch (e: any) { toast.error(e.message); }
  };

  const toggleWa = async () => {
    setWaBusy(true);
    try {
      const r = await api('/briefing/whatsapp', { method: 'POST', body: JSON.stringify({ enabled: !waEnabled }) });
      setWaEnabled(!!r?.enabled);
      toast.success(r?.enabled ? 'Resumo diário por WhatsApp ligado.' : 'Resumo diário por WhatsApp desligado.');
    } catch (e: any) { toast.error(e.message); }
    finally { setWaBusy(false); }
  };

  const sendWaNow = async () => {
    setWaBusy(true);
    try {
      const r = await api('/briefing/whatsapp/send-now', { method: 'POST' });
      if (r?.sent) toast.success('Resumo enviado pro seu WhatsApp.');
      else toast.error(r?.reason === 'no_phone' ? 'Cadastre seu WhatsApp em Configurações → Usuários.' : r?.reason === 'no_briefing' ? 'Nada pra resumir hoje.' : 'Não foi possível enviar agora.');
    } catch (e: any) { toast.error(e.message); }
    finally { setWaBusy(false); }
  };

  const TABS = [
    { id: 'inbox', label: 'Inbox', icon: <Inbox className="h-4 w-4" /> },
    { id: 'tasks', label: 'Tarefas', icon: <ListTodo className="h-4 w-4" /> },
    { id: 'events', label: 'Agenda', icon: <CalendarDays className="h-4 w-4" /> },
    { id: 'lists', label: 'Listas', icon: <Check className="h-4 w-4" /> },
    { id: 'memory', label: 'Memória', icon: <Brain className="h-4 w-4" /> },
    { id: 'briefing', label: 'Briefing', icon: <Sun className="h-4 w-4" /> },
  ] as const;

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
      {/* Input da foto da nota (Fatia 4) fica fora das abas: o clique vem de
          qualquer lista aberta via checkListIdRef. */}
      <input ref={checkFileRef} type="file" accept="image/*" className="hidden" onChange={onCheckImage} />
      <div className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-1">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${tab === t.id ? 'bg-violet-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'inbox' && (
        <>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <p className="text-sm text-zinc-400">Fala, digita ou fotografa — a IA organiza e <strong className="text-zinc-200">você confirma</strong> antes de qualquer coisa ser criada.</p>
            <div className="flex gap-2">
              <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendText()}
                placeholder='Ex.: "reunião com o contador sexta às 10h"'
                className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-zinc-200" />
              <button onClick={sendText} disabled={processing || !text.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex gap-2">
              {/* F8.2 — um só nó no DOM pros dois estados: trocar de elemento no
                  meio do gesto derrubaria o pointer capture do press-and-hold. */}
              <button
                onPointerDown={holdStart}
                onPointerUp={holdEnd}
                onPointerCancel={holdEnd}
                onClick={recording && recMode === 'auto' ? () => stopRecording(false) : undefined}
                onContextMenu={(e) => e.preventDefault()}
                disabled={processing && !recording}
                className={recording
                  ? 'inline-flex items-center gap-2 rounded-lg bg-red-600 hover:bg-red-500 px-3 py-2 text-sm font-semibold text-white animate-pulse touch-none select-none'
                  : 'inline-flex items-center gap-2 rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2 text-sm text-zinc-300 disabled:opacity-50 touch-none select-none'}>
                {recording
                  ? (<><Square className="h-4 w-4" /> {recSecs}s — {recMode === 'hold' ? 'solte pra enviar' : 'toque pra enviar'}</>)
                  : (<><Mic className="h-4 w-4" /> Segurar pra falar</>)}
              </button>
              <button onClick={() => fileInputRef.current?.click()} disabled={processing}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 hover:bg-slate-800 px-3 py-2 text-sm text-zinc-300 disabled:opacity-50">
                <ImageIcon className="h-4 w-4" /> Foto / Nota
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onImage} />
            </div>
            {queuedCount > 0 && (
              <p className="text-xs text-amber-300">
                {queuedCount} captura{queuedCount > 1 ? 's' : ''} aguardando conexão — envio automático quando a internet voltar.
              </p>
            )}
          </div>

          {pending.length === 0 && !processing && (
            <p className="text-sm text-zinc-500 text-center py-6">Caixa de entrada limpa. Fala aí. 🎙️</p>
          )}
          <div className="space-y-3">
            {pending.map((item) => <ConfirmCard key={item.id} item={item} onResolved={loadPending} />)}
          </div>
        </>
      )}

      {tab === 'tasks' && (
        <div className="space-y-2">
          {tasks.length === 0 && <p className="text-sm text-zinc-500 text-center py-6">Nenhuma tarefa ainda.</p>}
          {tasks.map((t) => (
            <button key={t.id} onClick={() => toggleTask(t)}
              className="w-full flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-left hover:bg-slate-800/60">
              <span className={`h-5 w-5 shrink-0 rounded-full border flex items-center justify-center ${t.completed ? 'bg-emerald-600 border-emerald-600' : 'border-slate-600'}`}>
                {!!t.completed && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className={`text-sm ${t.completed ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>{t.title}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'events' && (
        <div className="space-y-2">
          {events.length === 0 && <p className="text-sm text-zinc-500 text-center py-6">Nenhum compromisso ainda.</p>}
          {events.map((e) => (
            <div key={e.id} className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
              <p className="text-sm text-zinc-200">{e.title}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {e.event_date ? `${e.event_date.split('-').reverse().join('/')}${e.event_time ? ` às ${e.event_time}` : ''}` : 'Sem data definida'}
              </p>
            </div>
          ))}
        </div>
      )}

      {tab === 'lists' && (
        <div className="space-y-2">
          {lists.length === 0 && <p className="text-sm text-zinc-500 text-center py-6">Nenhuma lista ainda.</p>}
          {lists.map((l) => (
            <div key={l.id} className="rounded-xl border border-slate-800 bg-slate-900/60">
              <button onClick={() => openList(l)} className="w-full flex items-center justify-between px-4 py-3 text-left">
                <span className="text-sm text-zinc-200">{l.title}</span>
                <span className="text-xs text-zinc-500">{l.realized_count}/{l.item_count}</span>
              </button>
              {listItemsById[l.id] && (
                <>
                  <div className="border-t border-slate-800 px-4 py-2 space-y-1">
                    {listItemsById[l.id].map((i) => (
                      <button key={i.id} onClick={() => toggleListItem(l.id, i)} className="w-full flex items-center gap-2 py-1 text-left">
                        <span className={`h-4 w-4 shrink-0 rounded border flex items-center justify-center ${i.realized ? 'bg-emerald-600 border-emerald-600' : 'border-slate-600'}`}>
                          {!!i.realized && <Check className="h-3 w-3 text-white" />}
                        </span>
                        <span className={`text-sm ${i.realized ? 'text-zinc-500 line-through' : 'text-zinc-300'}`}>{i.name}{i.quantity ? ` (${i.quantity})` : ''}</span>
                      </button>
                    ))}
                    {!checkByListId[l.id] && (
                      <button onClick={() => startPurchaseCheck(l.id)} disabled={checkingListId === l.id}
                        className="inline-flex items-center gap-1.5 text-xs text-violet-300 hover:text-violet-200 py-1.5 disabled:opacity-50">
                        {checkingListId === l.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Receipt className="h-3.5 w-3.5" />}
                        {checkingListId === l.id ? 'Lendo a nota…' : 'Conferir compra (foto da nota)'}
                      </button>
                    )}
                  </div>
                  {checkByListId[l.id] && (
                    <PurchaseCheckCard check={checkByListId[l.id]} onResolved={() => onCheckResolved(l.id)} />
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'memory' && (
        <div className="space-y-2">
          {entities.length === 0 && <p className="text-sm text-zinc-500 text-center py-6">Nenhuma entidade memorizada ainda.</p>}
          {entities.map((e) => (
            <div key={e.id} className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 flex items-center gap-3">
              <span className="text-xs font-semibold uppercase text-violet-300 bg-violet-500/10 border border-violet-500/30 rounded-full px-2 py-0.5">
                {e.entity_type === 'PERSON' ? 'Pessoa' : e.entity_type === 'PROJECT' ? 'Projeto' : e.entity_type}
              </span>
              <div>
                <p className="text-sm text-zinc-200">{e.name}</p>
                {e.context && <p className="text-xs text-zinc-500">{e.context}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'briefing' && briefing && (
        <div className="space-y-4">
          {/* Fatia 5 — o sweep diário publicou o briefing como sinal (ADR-136):
              o mesmo resumo aparece no painel de sinais da operação. */}
          {signals.length > 0 && (
            <p className="text-xs text-violet-300 bg-violet-500/10 border border-violet-500/30 rounded-xl px-4 py-2.5">
              📣 Briefing de hoje publicado no painel de sinais da operação
              {signals[0]?.severity === 'attention' ? ' — há pendências pedindo sua ação.' : '.'}
            </p>
          )}
          {/* Fatia 6 — entrega por WhatsApp: opt-in de canal + envio manual. */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-zinc-200">Resumo diário no WhatsApp</p>
              <p className="text-xs text-zinc-500">Recebe o briefing da manhã no seu WhatsApp cadastrado.</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {waEnabled && (
                <button onClick={sendWaNow} disabled={waBusy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 hover:bg-slate-800 px-2.5 py-1.5 text-xs text-zinc-300 disabled:opacity-50">
                  {waBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Enviar agora
                </button>
              )}
              <button onClick={toggleWa} disabled={waBusy} role="switch" aria-checked={waEnabled}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${waEnabled ? 'bg-emerald-600' : 'bg-slate-700'} disabled:opacity-50`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${waEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
          {briefing.pendingInbox?.c > 0 && (
            <p className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
              {briefing.pendingInbox.c} item(ns) aguardando sua confirmação no Inbox.
            </p>
          )}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Compromissos de hoje (e sem data)</h3>
            {briefing.todayEvents?.length === 0 && <p className="text-sm text-zinc-500">Nada por hoje.</p>}
            {briefing.todayEvents?.map((e: any) => (
              <p key={e.id} className="text-sm text-zinc-200 py-1">{e.event_time ? `${e.event_time} — ` : ''}{e.title}{!e.event_date && <span className="text-zinc-500"> (sem data)</span>}</p>
            ))}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Tarefas abertas</h3>
            {briefing.tasks?.length === 0 && <p className="text-sm text-zinc-500">Tudo em dia. ✨</p>}
            {briefing.tasks?.map((t: any) => <p key={t.id} className="text-sm text-zinc-200 py-1">• {t.title}</p>)}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Listas ativas</h3>
            {briefing.lists?.map((l: any) => <p key={l.id} className="text-sm text-zinc-200 py-1">{l.title} — {l.realized_count}/{l.item_count}</p>)}
          </div>
        </div>
      )}
    </div>
  );
}
