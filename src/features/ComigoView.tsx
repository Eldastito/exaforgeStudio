import { useEffect, useState, useCallback, useMemo } from 'react';
import { HandCoins, Calculator, Store, NotebookText, Sparkles, Trash2, Banknote, QrCode, BookUser, MessageCircle, Activity, TrendingUp, TrendingDown, Minus, Megaphone, Plus, ChevronLeft, AlertTriangle, CheckCircle, Gauge, CalendarDays, X, Clock, User, FileDown, WifiOff, RefreshCw } from 'lucide-react';
import { apiFetch, currentOrgId } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { LegalTip } from '@/src/features/LegalAdvisorView';
import { enqueueOpenOrder, enqueueAddItem, enqueuePay, pendingComigoCount, isNetworkError } from '@/src/lib/comigo/offlineQueue';
import { loadProductsWithCache } from '@/src/lib/comigo/productsCache';

// Hook simples de conectividade — reage a online/offline do navegador. Usado
// pelo Balcão pra decidir se enfileira no outbox ou vai direto pra rede, e
// pra esconder o Pix dinâmico (que precisa de PSP).
function useOnline() {
  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}

// ============================================================================
// ZappFlow Comigo — módulo `copiloto` do plano Autônomo (ADR-111/112/113).
// PR #3: Balcão PDV por toque + fiado (limite, aviso+override) + lista negra.
// Precificação (motor no PR #2) e Caderneta (PR #4) seguem como placeholders.
// ============================================================================

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;
// Peso legível: 1.35 → "1,35 kg"; 1 → "1 kg"; 0.5 → "0,5 kg".
const kgLabel = (n: any) => `${Number(n || 0).toFixed(3).replace(/\.?0+$/, '').replace('.', ',')} kg`;

type Product = { id: string; name: string; price: number; type: string; active: number; sale_mode?: string; sale_options_json?: string | null };
type OrderItem = { id: string; name: string; qty: number; unit_price: number; product_id?: string };
type SugItem = { product_id: string; name: string; count: number };
type Overview = { recipes: number; openOrders: number; fiadoReceivable: number; blacklisted: number };

const TABS = [
  { key: 'agenda', label: 'Agenda', icon: CalendarDays },
  { key: 'balcao', label: 'Balcão', icon: Store },
  { key: 'mesa', label: 'Mesa/QR', icon: QrCode },
  { key: 'saude', label: 'Saúde', icon: Activity },
  { key: 'precificacao', label: 'Precificação', icon: Calculator },
  { key: 'caderneta', label: 'Caderneta', icon: NotebookText },
  { key: 'divulgar', label: 'Divulgar', icon: Megaphone },
] as const;

export function ComigoView() {
  // Default = 'balcao'; ajustado pra 'agenda' abaixo quando o arquétipo é hora-marcada.
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('balcao');
  const [ov, setOv] = useState<Overview | null>(null);
  const [arch, setArch] = useState<any | null>(null);
  const [prog, setProg] = useState<any | null>(null);

  const loadOverview = useCallback(() => {
    apiFetch('/api/comigo/overview').then((r) => r.json()).then((r: any) => {
      if (r && typeof r.recipes === 'number') setOv(r);
    }).catch(() => {});
    apiFetch('/api/comigo/progress').then((r) => r.json()).then((r: any) => { if (r?.stage) setProg(r); }).catch(() => {});
  }, []);
  const loadArch = useCallback(() => {
    apiFetch('/api/comigo/archetype').then((r) => r.json()).then((r: any) => setArch(r?.config || null)).catch(() => setArch({ configured: true, mesaEnabled: true }));
  }, []);
  useEffect(() => { loadOverview(); loadArch(); }, [loadOverview, loadArch]);

  // Sem arquétipo definido: o tutor abre com as 3 perguntas (ADR-120).
  if (arch && arch.configured === false) {
    return (
      <div className="flex-1 min-w-0 overflow-y-auto p-3 md:p-6">
        <div className="max-w-lg mx-auto">
          <ArchetypeOnboarding onDone={() => { loadArch(); loadOverview(); }} />
        </div>
      </div>
    );
  }

  // A aba Mesa/QR só aparece quando o arquétipo usa (ADR-120 D2).
  const mesaHidden = arch ? arch.mesaEnabled === false : false;
  // A aba Agenda só aparece quando o arquétipo é hora-marcada (unhas, cabelo, ou
  // arquétipo qualquer que respondeu "agenda" na 2ª pergunta do onboarding).
  const agendaVisible = arch?.mode === 'agenda';
  const visibleTabs = TABS.filter((t) => {
    if (t.key === 'mesa' && mesaHidden) return false;
    if (t.key === 'agenda' && !agendaVisible) return false;
    return true;
  });
  // Fallback quando a aba selecionada some do menu.
  const activeTab = (
    (tab === 'mesa' && mesaHidden) ||
    (tab === 'agenda' && !agendaVisible)
  ) ? (agendaVisible ? 'agenda' : 'balcao') : tab;

  // Primeira carga em modo agenda: entra direto na Agenda em vez do Balcão.
  useEffect(() => {
    if (agendaVisible && tab === 'balcao') setTab('agenda');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agendaVisible]);

  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-3 md:p-6">
      <div className="max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
          <HandCoins className="w-5 h-5 text-emerald-300" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Comigo</h2>
          <p className="text-xs text-zinc-400">Seu sócio no celular: vende, precifica e mostra quanto sobra de verdade.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 my-5">
        {[
          { label: 'Fichas de preço', value: ov ? String(ov.recipes) : '—' },
          { label: 'Pedidos em aberto', value: ov ? String(ov.openOrders) : '—' },
          { label: 'A receber (fiado)', value: ov ? brl(ov.fiadoReceivable) : '—' },
          { label: 'Lista negra', value: ov ? String(ov.blacklisted) : '—' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">{c.label}</div>
            <div className="text-xl font-semibold text-zinc-100 mt-1">{c.value}</div>
          </div>
        ))}
      </div>

      {arch?.configured && (
        <div className="text-xs text-zinc-500 mb-3 flex items-center gap-1.5">
          <span>{arch.emoji} {arch.archetypeLabel}</span>
          <button onClick={() => setArch({ configured: false, mesaEnabled: arch.mesaEnabled })} className="text-sky-400 hover:text-sky-300">alterar</button>
        </div>
      )}

      {/* Próximo passo (ADR-121): guia pedagógico, não bloqueia */}
      {prog && (prog.done ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 mb-3 text-sm text-emerald-200">{prog.doneMessage}</div>
      ) : prog.next ? (
        <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 mb-3">
          <div className="text-xs text-sky-300 font-medium">💡 Próximo passo: {prog.next.label}</div>
          <p className="text-xs text-zinc-300 mt-0.5">{prog.next.hint}</p>
          <div className="flex gap-1 mt-2">
            {Array.from({ length: prog.totalStages }).map((_, i) => (
              <span key={i} className={`h-1 flex-1 rounded-full ${i <= prog.stageIndex ? 'bg-emerald-500' : 'bg-zinc-800'}`} />
            ))}
          </div>
        </div>
      ) : null)}

      <div className="flex gap-2 border-b border-zinc-800 flex-wrap">
        {visibleTabs.map((t) => {
          const Icon = t.icon;
          const locked = prog && t.key in prog.unlocked && prog.unlocked[t.key] === false;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} title={locked ? 'Desbloqueia conforme você avança' : undefined}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                activeTab === t.key ? 'border-emerald-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
              } ${locked ? 'opacity-50' : ''}`}>
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {activeTab === 'agenda' && <Agenda />}
        {activeTab === 'balcao' && <Balcao onChange={loadOverview} />}
        {activeTab === 'mesa' && <Mesa onChange={loadOverview} />}
        {activeTab === 'saude' && <Saude />}
        {activeTab === 'precificacao' && <Precificacao />}
        {activeTab === 'caderneta' && <Caderneta onChange={loadOverview} />}
        {activeTab === 'divulgar' && <Divulgar />}
      </div>
      </div>
    </div>
  );
}

// ── Agenda: hora marcada (arquétipo agenda — unhas, cabelo, etc) ────────────
type AgendaItem = {
  id: string; contact_id: string; contact_name: string; contact_phone: string | null;
  product_service_id: string | null; product_name: string | null;
  title: string; description: string | null;
  scheduled_start: string; scheduled_end: string | null; duration_minutes: number;
  status: string; cancellation_reason: string | null; created_at: string;
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const timeOf = (iso: string) => {
  const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const isoOfLocal = (date: string, time: string) => {
  // date = YYYY-MM-DD, time = HH:MM → ISO no horário local
  const d = new Date(`${date}T${time}:00`);
  return d.toISOString();
};

function Agenda() {
  const [date, setDate] = useState<string>(todayISO());
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [services, setServices] = useState<Product[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflictPreview, setConflictPreview] = useState<{ ids: string[]; message: string } | null>(null);
  // Form
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState('30');
  const [serviceId, setServiceId] = useState<string>('');
  const [note, setNote] = useState('');

  const load = useCallback((d: string) => {
    apiFetch(`/api/comigo/agenda?date=${encodeURIComponent(d)}`).then(r => r.json()).then((r: any) => {
      setItems(r?.items || []);
    }).catch(() => {});
  }, []);

  useEffect(() => { load(date); }, [load, date]);
  useEffect(() => {
    // Puxa serviços (products_services do tipo service) pra preencher o combo.
    apiFetch('/api/products?type=service').then(r => r.json()).then((r: any) => {
      const rows = Array.isArray(r) ? r : (r?.products || r?.items || []);
      setServices((rows as any[]).filter(p => p.active !== 0));
    }).catch(() => {});
  }, []);

  const resetForm = () => { setName(''); setPhone(''); setTime('09:00'); setDuration('30'); setServiceId(''); setNote(''); setConflictPreview(null); };

  const onServiceChange = (id: string) => {
    setServiceId(id);
    // Se o produto tem uma ficha de preço com labor_minutes, dá um empurrão na duração.
    // Como o /api/products não devolve labor_minutes, mantemos o default 30 e o usuário ajusta.
  };

  const submit = async (force = false) => {
    if (busy) return;
    if (!name.trim() && !phone.trim()) { toast.error('Informe nome ou telefone do cliente.'); return; }
    setBusy(true);
    try {
      const startISO = isoOfLocal(date, time);
      const body: any = {
        contact_name: name.trim() || undefined,
        contact_phone: phone.trim() || undefined,
        product_service_id: serviceId || undefined,
        scheduled_start: startISO,
        duration_minutes: Number(duration) || undefined,
        description: note.trim() || undefined,
        force: force || undefined,
      };
      const res = await apiFetch('/api/comigo/agenda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const r = await res.json();
      if (res.status === 409 && r?.error === 'CONFLICT') {
        setConflictPreview({ ids: (r.conflicts || []).map((c: any) => c.id), message: r.message || 'Conflito de horário.' });
        return;
      }
      if (!res.ok || !r?.id) { toast.error('Erro ao agendar.'); return; }
      toast.success('Agendado!');
      resetForm(); setCreating(false); load(date);
    } catch { toast.error('Erro ao agendar.'); }
    finally { setBusy(false); }
  };

  const cancel = async (a: AgendaItem) => {
    const reason = window.prompt(`Cancelar agendamento de ${a.contact_name}?\nMotivo (opcional):`);
    if (reason == null) return;
    await apiFetch(`/api/comigo/agenda/${a.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }).catch(() => {});
    load(date); toast.success('Cancelado.');
  };
  const complete = async (a: AgendaItem) => {
    await apiFetch(`/api/comigo/agenda/${a.id}/complete`, { method: 'POST' }).catch(() => {});
    load(date); toast.success('Atendimento concluído.');
  };
  const noShow = async (a: AgendaItem) => {
    if (!window.confirm(`Marcar ${a.contact_name} como faltou?`)) return;
    await apiFetch(`/api/comigo/agenda/${a.id}/no-show`, { method: 'POST' }).catch(() => {});
    load(date); toast.success('Marcado como faltou.');
  };

  const waLink = (a: AgendaItem) => {
    if (!a.contact_phone) return null;
    const digits = a.contact_phone.replace(/\D/g, '');
    if (!digits) return null;
    const time = timeOf(a.scheduled_start);
    const text = encodeURIComponent(`Oi ${a.contact_name}! Confirmando seu horário às ${time} — ${a.title}.`);
    return `https://wa.me/${digits}?text=${text}`;
  };

  const statusPill = (s: string) => {
    const map: Record<string, string> = {
      pending: 'bg-zinc-500/15 text-zinc-300',
      confirmed: 'bg-sky-500/15 text-sky-300',
      in_progress: 'bg-emerald-500/15 text-emerald-300',
      completed: 'bg-emerald-600/25 text-emerald-200',
      cancelled: 'bg-red-500/15 text-red-300',
      no_show: 'bg-amber-500/15 text-amber-300',
    };
    const label: Record<string, string> = { pending: 'Aguardando', confirmed: 'Agendado', in_progress: 'Em atendimento', completed: 'Concluído', cancelled: 'Cancelado', no_show: 'Faltou' };
    return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${map[s] || 'bg-zinc-500/15 text-zinc-300'}`}>{label[s] || s}</span>;
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">Sua agenda de hora marcada. Cliente confirma, você atende, o horário fica seu.</p>

      {/* Seletor de dia + novo */}
      <div className="flex items-center gap-2 flex-wrap">
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200" />
        <button onClick={() => setDate(todayISO())} className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1.5">Hoje</button>
        <div className="flex-1" />
        {!creating && (
          <button onClick={() => { resetForm(); setCreating(true); }} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1.5">
            <Plus className="w-3 h-3 inline mr-1" />Novo agendamento
          </button>
        )}
      </div>

      {/* Formulário de criação */}
      {creating && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-zinc-200">Novo agendamento — {date}</div>
            <button onClick={() => { setCreating(false); resetForm(); }} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome do cliente" className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200" autoFocus />
            <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Telefone (WhatsApp)" className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-500">Horário</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500">Duração (min)</label>
              <input type="number" min={5} max={480} value={duration} onChange={e => setDuration(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200" />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-zinc-500">Serviço (opcional)</label>
            <select value={serviceId} onChange={e => onServiceChange(e.target.value)} className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200">
              <option value="">— Selecione —</option>
              {services.map(s => <option key={s.id} value={s.id}>{s.name} · {brl(s.price)}</option>)}
            </select>
          </div>

          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Observação (opcional)" rows={2}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200" />

          {conflictPreview && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
              <div className="flex items-center gap-1.5 text-amber-300 font-medium"><AlertTriangle className="w-3.5 h-3.5" /> {conflictPreview.message}</div>
              <p className="text-zinc-400 mt-1">Já tem cliente marcado nesse horário. Marcar mesmo assim?</p>
              <div className="flex gap-2 mt-2">
                <button disabled={busy} onClick={() => submit(true)} className="rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs px-3 py-1.5 disabled:opacity-40">Marcar mesmo assim</button>
                <button onClick={() => setConflictPreview(null)} className="rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs px-3 py-1.5">Voltar</button>
              </div>
            </div>
          )}

          {!conflictPreview && (
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => submit(false)} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1.5 disabled:opacity-40">Marcar</button>
              <button onClick={() => { setCreating(false); resetForm(); }} className="rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs px-3 py-1.5">Cancelar</button>
            </div>
          )}
        </div>
      )}

      {/* Lista do dia */}
      {items.length === 0 && !creating && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center">
          <CalendarDays className="w-6 h-6 text-emerald-300 mx-auto mb-2" />
          <div className="text-sm font-medium text-zinc-200">Nenhum agendamento nesse dia</div>
          <p className="text-xs text-zinc-400 max-w-md mx-auto mt-1.5">Clique em "Novo agendamento" pra reservar o horário do seu cliente.</p>
        </div>
      )}

      <div className="space-y-2">
        {items.map(a => {
          const wa = waLink(a);
          const canAct = !['cancelled', 'completed', 'no_show'].includes(a.status);
          return (
            <div key={a.id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-emerald-300" />
                    {timeOf(a.scheduled_start)}
                  </div>
                  <span className="text-xs text-zinc-500">· {a.duration_minutes} min</span>
                  {statusPill(a.status)}
                </div>
                <div className="flex gap-1">
                  {wa && canAct && (
                    <a href={wa} target="_blank" rel="noreferrer" title="Confirmar no WhatsApp"
                      className="text-xs rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 px-2 py-1">
                      <MessageCircle className="w-3.5 h-3.5 inline" />
                    </a>
                  )}
                  {canAct && (
                    <>
                      <button onClick={() => complete(a)} title="Concluir" className="text-xs rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 px-2 py-1">
                        <CheckCircle className="w-3.5 h-3.5 inline" />
                      </button>
                      <button onClick={() => noShow(a)} title="Faltou" className="text-xs rounded-lg border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 px-2 py-1">Faltou</button>
                      <button onClick={() => cancel(a)} title="Cancelar" className="text-xs rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 px-2 py-1">
                        <X className="w-3.5 h-3.5 inline" />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-1.5 text-sm text-zinc-200 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-zinc-500" />
                {a.contact_name}
                {a.contact_phone && <span className="text-xs text-zinc-500">· {a.contact_phone}</span>}
              </div>
              <div className="text-xs text-zinc-400">{a.title}{a.product_name && a.product_name !== a.title ? ` · ${a.product_name}` : ''}</div>
              {a.description && <div className="text-xs text-zinc-500 mt-1">"{a.description}"</div>}
              {a.status === 'cancelled' && a.cancellation_reason && <div className="text-xs text-red-400 mt-1">Motivo: {a.cancellation_reason}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Divulgar: boosts de divulgação zero-token (ADR-123) ──────────────────────
function Divulgar() {
  const [boosts, setBoosts] = useState<{ post?: { caption: string }; catalogo?: { link: string; text: string } } | null>(null);

  useEffect(() => {
    apiFetch('/api/comigo/boosts').then((r) => r.json()).then((r: any) => setBoosts(r)).catch(() => {});
  }, []);

  const use = (key: string, text: string) => {
    navigator.clipboard?.writeText(text);
    apiFetch(`/api/comigo/boosts/${key}/use`, { method: 'POST' }).catch(() => {});
    toast.success('Copiado! Cole no WhatsApp ou no seu status 📲');
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">Impulsos prontos pra atrair cliente. Cada link e post que você manda é propaganda do seu corre. 📣</p>

      {/* Post do dia */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="text-sm font-medium text-zinc-100 flex items-center gap-1.5"><Megaphone className="w-4 h-4 text-emerald-300" /> Post do dia</div>
        <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-sans bg-zinc-900 rounded-lg p-2 mt-2">{boosts?.post?.caption || '…'}</pre>
        <button disabled={!boosts?.post} onClick={() => use('post', boosts!.post!.caption)} className="mt-2 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 disabled:opacity-40">Copiar legenda</button>
      </div>

      {/* Compartilhar cardápio */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="text-sm font-medium text-zinc-100 flex items-center gap-1.5"><QrCode className="w-4 h-4 text-sky-300" /> Compartilhar cardápio</div>
        <p className="text-xs text-zinc-400 mt-1">O cliente escolhe, pede e paga pelo próprio link — sem você digitar nada.</p>
        {boosts?.catalogo && <code className="block text-xs text-sky-300 bg-zinc-900 rounded px-2 py-1 mt-2 break-all">{boosts.catalogo.link}</code>}
        <div className="flex gap-2 mt-2">
          <button disabled={!boosts?.catalogo} onClick={() => use('catalogo', boosts!.catalogo!.text)} className="text-xs rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 disabled:opacity-40">Copiar convite</button>
          {boosts?.catalogo && <a href={boosts.catalogo.link} target="_blank" rel="noreferrer" className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-3 py-1.5">Abrir</a>}
        </div>
      </div>
    </div>
  );
}

// ── Precificação: fichas técnicas, custos, preço sugerido (ADR-111 D3) ──────
type RecipeRow = { id: string; name: string; kind: string; yield_qty: number | null; labor_minutes: number | null; updated_at: string };
type CostRow = { id?: string; label: string; kind: string; amount: number; is_estimate: number | boolean };
type Breakdown = { insumos: number; indiretos: number; tempo: number; yield: number; unitCost: number; hasEstimate: boolean };
type Suggestion = { price: number; margin: number; markup: number };
type MissingHint = { key: string; label: string };
type RecipeDetail = { recipe: RecipeRow; costs: CostRow[]; breakdown: Breakdown; suggestion: Suggestion; missing: MissingHint[]; kind: string };

const KIND_LABELS: Record<string, string> = { revenda: 'Revenda', fabricacao: 'Fabricacao', servico: 'Servico' };

function Precificacao() {
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [selected, setSelected] = useState<RecipeDetail | null>(null);
  const [margin, setMargin] = useState(30);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hourValue, setHourValue] = useState(0);
  // Formulario nova ficha
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<string>('revenda');
  const [newYield, setNewYield] = useState('');
  const [newMinutes, setNewMinutes] = useState('');
  // Novo custo inline
  const [costLabel, setCostLabel] = useState('');
  const [costKind, setCostKind] = useState<string>('insumo');
  const [costAmount, setCostAmount] = useState('');
  const [costEstimate, setCostEstimate] = useState(true);
  // Calibracao
  const [calYield, setCalYield] = useState('');
  const [calWaste, setCalWaste] = useState('');

  const loadList = useCallback(() => {
    apiFetch('/api/comigo/recipes').then(r => r.json()).then((r: any) => setRecipes(r?.recipes || [])).catch(() => {});
    apiFetch('/api/comigo/settings').then(r => r.json()).then((r: any) => setHourValue(Number(r?.hourValue) || 0)).catch(() => {});
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  const loadDetail = useCallback((id: string, m?: number) => {
    const mg = ((m ?? margin) / 100).toFixed(2);
    apiFetch(`/api/comigo/recipes/${id}?margin=${mg}`).then(r => r.json()).then((r: any) => {
      if (r?.recipe) setSelected(r as RecipeDetail);
    }).catch(() => {});
  }, [margin]);

  const createRecipe = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const body: any = { name: newName.trim(), kind: newKind };
      if (newKind === 'fabricacao' && newYield) body.yield_qty = Number(newYield.replace(',', '.')) || null;
      if (newKind === 'servico' && newMinutes) body.labor_minutes = Number(newMinutes.replace(',', '.')) || null;
      const r = await apiFetch('/api/comigo/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
      if (r?.id) { loadList(); loadDetail(r.id); setCreating(false); setNewName(''); setNewYield(''); setNewMinutes(''); toast.success('Ficha criada!'); }
    } catch { toast.error('Erro ao criar ficha.'); }
    finally { setBusy(false); }
  };

  const deleteRecipe = async (id: string) => {
    if (!window.confirm('Apagar esta ficha de preco? Nao tem volta.')) return;
    setBusy(true);
    try {
      await apiFetch(`/api/comigo/recipes/${id}`, { method: 'DELETE' });
      setSelected(null); loadList(); toast.success('Ficha apagada.');
    } catch { toast.error('Erro ao apagar.'); }
    finally { setBusy(false); }
  };

  const addCost = async () => {
    if (!selected || !costLabel.trim() || busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/comigo/recipes/${selected.recipe.id}/costs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: costLabel.trim(), kind: costKind, amount: Number(costAmount.replace(',', '.')) || 0, is_estimate: costEstimate }),
      });
      setCostLabel(''); setCostAmount('');
      loadDetail(selected.recipe.id);
    } catch { toast.error('Erro ao adicionar custo.'); }
    finally { setBusy(false); }
  };

  const removeCost = async (costId: string) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/comigo/recipes/${selected.recipe.id}/costs/${costId}`, { method: 'DELETE' });
      loadDetail(selected.recipe.id);
    } catch { toast.error('Erro ao remover custo.'); }
    finally { setBusy(false); }
  };

  const calibrate = async () => {
    if (!selected || busy) return;
    const y = Number(calYield.replace(',', '.'));
    if (!y || y <= 0) { toast.error('Informe o rendimento real.'); return; }
    setBusy(true);
    try {
      await apiFetch(`/api/comigo/recipes/${selected.recipe.id}/calibrate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actualYield: y, wasteQty: Number(calWaste.replace(',', '.')) || 0 }),
      });
      setCalYield(''); setCalWaste('');
      loadDetail(selected.recipe.id);
      loadList();
      toast.success('Rendimento recalibrado!');
    } catch { toast.error('Erro na calibracao.'); }
    finally { setBusy(false); }
  };

  const updateHourValue = async () => {
    const v = window.prompt('Quanto vale sua hora de trabalho (R$)?', String(hourValue));
    if (v == null) return;
    const n = Number(v.replace(',', '.')) || 0;
    await apiFetch('/api/comigo/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hourValue: n }) }).catch(() => {});
    setHourValue(n);
    if (selected) loadDetail(selected.recipe.id);
  };

  const updateRecipeField = async (field: string, value: any) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/comigo/recipes/${selected.recipe.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      loadDetail(selected.recipe.id);
    } catch { toast.error('Erro ao atualizar.'); }
    finally { setBusy(false); }
  };

  // ── Vista de detalhe ────────────────────────────────────────────────────────
  if (selected) {
    const { recipe, costs, breakdown, suggestion, missing, kind } = selected;
    return (
      <div className="space-y-4">
        <button onClick={() => { setSelected(null); loadList(); }} className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
          <ChevronLeft className="w-3.5 h-3.5" /> Voltar
        </button>

        {/* Header da ficha */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-zinc-100">{recipe.name}</h3>
              <span className="text-xs text-zinc-500">{KIND_LABELS[kind] || kind}</span>
              {kind === 'fabricacao' && (
                <span className="text-xs text-zinc-500 ml-2">
                  Rendimento: {recipe.yield_qty || 1} un
                  <button onClick={() => { const v = window.prompt('Rendimento por lote:', String(recipe.yield_qty || 1)); if (v) updateRecipeField('yield_qty', Number(v.replace(',', '.')) || 1); }} className="ml-1 text-sky-400 hover:text-sky-300">(editar)</button>
                </span>
              )}
              {kind === 'servico' && (
                <span className="text-xs text-zinc-500 ml-2">
                  Tempo: {recipe.labor_minutes || 0} min
                  <button onClick={() => { const v = window.prompt('Tempo do atendimento (min):', String(recipe.labor_minutes || 0)); if (v) updateRecipeField('labor_minutes', Number(v.replace(',', '.')) || 0); }} className="ml-1 text-sky-400 hover:text-sky-300">(editar)</button>
                  {' · '}Hora: {brl(hourValue)}
                  <button onClick={updateHourValue} className="ml-1 text-sky-400 hover:text-sky-300">(editar)</button>
                </span>
              )}
            </div>
            <button onClick={() => deleteRecipe(recipe.id)} className="text-xs text-red-400 hover:text-red-300"><Trash2 className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Custos */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="text-sm font-medium text-zinc-200 mb-3">Custos da ficha</div>
          {costs.length === 0 && <p className="text-xs text-zinc-500">Nenhum custo ainda. Adicione abaixo.</p>}
          <div className="space-y-1.5">
            {costs.map((c, i) => (
              <div key={c.id || i} className="flex items-center justify-between text-xs bg-zinc-900 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c.kind === 'insumo' ? 'bg-emerald-500/15 text-emerald-300' : c.kind === 'indireto' ? 'bg-sky-500/15 text-sky-300' : 'bg-purple-500/15 text-purple-300'}`}>
                    {c.kind}
                  </span>
                  <span className="text-zinc-200">{c.label}</span>
                  {(c.is_estimate === true || c.is_estimate === 1) && <span className="text-[10px] text-amber-400">(chute)</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-300">{brl(c.amount)}</span>
                  <button onClick={() => c.id && removeCost(c.id)} className="text-zinc-600 hover:text-red-400"><Trash2 className="w-3 h-3" /></button>
                </div>
              </div>
            ))}
          </div>

          {/* Adicionar custo */}
          <div className="mt-3 flex flex-wrap gap-2 items-end">
            <input value={costLabel} onChange={e => setCostLabel(e.target.value)} placeholder="Ex.: Farinha" className="flex-1 min-w-[120px] rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200" />
            <select value={costKind} onChange={e => setCostKind(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200">
              <option value="insumo">Insumo</option>
              <option value="indireto">Indireto</option>
              <option value="tempo">Tempo</option>
            </select>
            <input value={costAmount} onChange={e => setCostAmount(e.target.value)} placeholder="R$" className="w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200" />
            <label className="flex items-center gap-1 text-[10px] text-zinc-400">
              <input type="checkbox" checked={costEstimate} onChange={e => setCostEstimate(e.target.checked)} className="rounded" />
              Chute
            </label>
            <button disabled={busy || !costLabel.trim()} onClick={addCost} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1.5 disabled:opacity-40">
              <Plus className="w-3 h-3 inline mr-1" />Adicionar
            </button>
          </div>
        </div>

        {/* Resultado: custo unitario + preco sugerido */}
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
          <div className="text-sm font-medium text-emerald-200 flex items-center gap-1.5"><Gauge className="w-4 h-4" /> Resultado</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Custo unitario</div>
              <div className="text-lg font-semibold text-zinc-100">{brl(breakdown.unitCost)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Preco sugerido</div>
              <div className="text-lg font-semibold text-emerald-300">{brl(suggestion.price)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Margem</div>
              <div className="text-lg font-semibold text-zinc-100">{Math.round(suggestion.margin * 100)}%</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Markup</div>
              <div className="text-lg font-semibold text-zinc-100">{Math.round(suggestion.markup * 100)}%</div>
            </div>
          </div>

          {/* Slider de margem */}
          <div className="mt-3">
            <label className="text-[10px] text-zinc-400">Margem-alvo: {margin}%</label>
            <input type="range" min={5} max={90} value={margin}
              onChange={e => { const m = Number(e.target.value); setMargin(m); loadDetail(selected.recipe.id, m); }}
              className="w-full h-1.5 rounded-full appearance-none bg-zinc-700 accent-emerald-500 mt-1" />
          </div>

          {breakdown.hasEstimate && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5" /> Ainda tem custos como chute. Conforme souber o valor real, edite.
            </div>
          )}
          {!breakdown.hasEstimate && costs.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400">
              <CheckCircle className="w-3.5 h-3.5" /> Todos os custos sao reais — preco confiavel.
            </div>
          )}

          {/* Detalhamento */}
          <div className="mt-3 text-[11px] text-zinc-500 flex flex-wrap gap-x-4">
            <span>Insumos: {brl(breakdown.insumos)}</span>
            <span>Indiretos: {brl(breakdown.indiretos)}</span>
            {breakdown.tempo > 0 && <span>Tempo: {brl(breakdown.tempo)}</span>}
            {kind === 'fabricacao' && <span>Rendimento: {breakdown.yield} un</span>}
          </div>
        </div>

        {/* Custos esquecidos */}
        {missing.length > 0 && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="text-xs font-medium text-amber-200 mb-1.5">Custos que muita gente esquece:</div>
            <div className="flex flex-wrap gap-1.5">
              {missing.map(m => (
                <button key={m.key} onClick={() => { setCostLabel(m.label); setCostKind('indireto'); setCostEstimate(true); }}
                  className="text-[11px] rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-200 px-2.5 py-0.5 hover:bg-amber-500/20">
                  + {m.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Calibracao (so fabricacao) */}
        {kind === 'fabricacao' && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="text-sm font-medium text-zinc-200 mb-2">Calibrar pelo real</div>
            <p className="text-xs text-zinc-400 mb-3">Fez um lote? Informe quanto rendeu e quanto perdeu — o motor recalcula automaticamente.</p>
            <div className="flex flex-wrap gap-2 items-end">
              <div>
                <label className="text-[10px] text-zinc-500">Rendimento real</label>
                <input value={calYield} onChange={e => setCalYield(e.target.value)} placeholder="Ex.: 25" className="block w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500">Perda/merma</label>
                <input value={calWaste} onChange={e => setCalWaste(e.target.value)} placeholder="0" className="block w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200" />
              </div>
              <button disabled={busy} onClick={calibrate} className="rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs px-3 py-1.5 disabled:opacity-40">Recalibrar</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Vista de lista ──────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-400">Monte a ficha de cada produto/servico: custos, rendimento e margem. O motor calcula o preco sugerido e avisa o que voce esqueceu.</p>

      {/* Botao criar */}
      {!creating ? (
        <button onClick={() => setCreating(true)} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1.5">
          <Plus className="w-3 h-3 inline mr-1" />Nova ficha de preco
        </button>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-3">
          <div className="text-sm font-medium text-zinc-200">Nova ficha</div>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nome do produto/servico" className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" autoFocus />
          <div className="flex gap-2">
            {(['revenda', 'fabricacao', 'servico'] as const).map(k => (
              <button key={k} onClick={() => setNewKind(k)}
                className={`text-xs rounded-lg px-3 py-1.5 border ${newKind === k ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}>
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
          {newKind === 'fabricacao' && (
            <input value={newYield} onChange={e => setNewYield(e.target.value)} placeholder="Rendimento por lote (ex.: 30)" className="w-40 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
          )}
          {newKind === 'servico' && (
            <input value={newMinutes} onChange={e => setNewMinutes(e.target.value)} placeholder="Tempo do atendimento (min)" className="w-48 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200" />
          )}
          <div className="flex gap-2">
            <button disabled={busy || !newName.trim()} onClick={createRecipe} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1.5 disabled:opacity-40">Criar</button>
            <button onClick={() => setCreating(false)} className="rounded-lg border border-zinc-700 text-zinc-400 text-xs px-3 py-1.5 hover:text-zinc-200">Cancelar</button>
          </div>
        </div>
      )}

      {/* Valor da hora (servicos) */}
      <div className="text-xs text-zinc-500 flex items-center gap-1">
        Valor da sua hora: <span className="text-zinc-300">{brl(hourValue)}</span>
        <button onClick={updateHourValue} className="text-sky-400 hover:text-sky-300 ml-1">(editar)</button>
      </div>

      {/* Lista de fichas */}
      {recipes.length === 0 && !creating && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center">
          <Calculator className="w-6 h-6 text-emerald-300 mx-auto mb-2" />
          <div className="text-sm font-medium text-zinc-200">Nenhuma ficha de preco</div>
          <p className="text-xs text-zinc-400 max-w-md mx-auto mt-1.5">Crie sua primeira ficha pra descobrir quanto custa de verdade e quanto cobrar.</p>
        </div>
      )}
      <div className="space-y-2">
        {recipes.map(r => (
          <button key={r.id} onClick={() => loadDetail(r.id)} className="w-full text-left rounded-xl border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800/60 p-3 flex items-center justify-between transition-colors">
            <div>
              <div className="text-sm font-medium text-zinc-100">{r.name}</div>
              <div className="text-xs text-zinc-500">{KIND_LABELS[r.kind] || r.kind}{r.kind === 'fabricacao' && r.yield_qty ? ` · ${r.yield_qty} un/lote` : ''}{r.kind === 'servico' && r.labor_minutes ? ` · ${r.labor_minutes} min` : ''}</div>
            </div>
            <ChevronLeft className="w-4 h-4 text-zinc-600 rotate-180" />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Onboarding por arquétipo: 3 perguntas em linguagem de gente (ADR-120) ────
type ArchQuestion = { key: string; label: string; options: { value: string; label: string }[] };

function ArchetypeOnboarding({ onDone }: { onDone: () => void }) {
  const [questions, setQuestions] = useState<ArchQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch('/api/comigo/archetype').then((r) => r.json()).then((r: any) => setQuestions(r?.questions || [])).catch(() => {});
  }, []);

  const done = questions.length > 0 && questions.every((q) => answers[q.key]);
  const submit = async () => {
    if (!done || busy) return;
    setBusy(true);
    try {
      await apiFetch('/api/comigo/archetype', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answers) });
      toast.success('Pronto! O Comigo já está do seu jeito.');
      onDone();
    } catch { toast.error('Não consegui salvar. Tente de novo.'); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
          <HandCoins className="w-5 h-5 text-emerald-300" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Oi! Vamos deixar o Comigo do seu jeito 👋</h2>
          <p className="text-xs text-zinc-400">Três perguntas rápidas e eu me ajusto ao seu corre.</p>
        </div>
      </div>

      <div className="space-y-4 mt-4">
        {questions.map((q) => (
          <div key={q.key}>
            <div className="text-sm text-zinc-200 mb-1.5">{q.label}</div>
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => (
                <button key={o.value} onClick={() => setAnswers((a) => ({ ...a, [q.key]: o.value }))}
                  className={`text-sm rounded-lg border px-3 py-1.5 ${answers[q.key] === o.value ? 'border-emerald-500 bg-emerald-500/10 text-zinc-100' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <button disabled={!done || busy} onClick={submit}
        className="mt-6 w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 disabled:opacity-40">
        Começar
      </button>
    </div>
  );
}

// ── Balcão PDV por toque ─────────────────────────────────────────────────────
function Balcao({ onChange }: { onChange: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [productsFromCache, setProductsFromCache] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fiado, setFiado] = useState<{ name: string; phone: string } | null>(null);
  const [suggest, setSuggest] = useState<{ alsoBought: SugItem[]; top: SugItem[] }>({ alsoBought: [], top: [] });
  const [pix, setPix] = useState<{ txid: string; qrPayload: string } | null>(null);
  // Produto por peso aguardando o vendedor informar os kg (peixaria/açougue).
  const [weighing, setWeighing] = useState<Product | null>(null);
  // Esconde produtos zerados da grade (server-side): não dá pra vender o que
  // não tem. Serviços e itens sem controle de estoque seguem aparecendo.
  const [hideEmpty, setHideEmpty] = useState(false);
  // Offline (Gap D): tanto rede quanto contador de comandos pendentes no outbox.
  const online = useOnline();
  const [pendingSync, setPendingSync] = useState(0);
  // Marca do pedido atual como "criado offline" — mostra chip no cartão.
  const [orderPendingSync, setOrderPendingSync] = useState(false);

  // Poll leve do outbox pra atualizar o chip "sincronizando N pedidos" —
  // navigator online/offline não pega quando o flusher está no meio do trabalho.
  useEffect(() => {
    const tick = () => { pendingComigoCount().then(setPendingSync).catch(() => {}); };
    tick();
    const iv = window.setInterval(tick, 3000);
    return () => window.clearInterval(iv);
  }, []);

  const loadSuggest = useCallback((pid?: string) => {
    apiFetch(`/api/comigo/suggest${pid ? `?productId=${pid}` : ''}`).then((r) => r.json())
      .then((r: any) => setSuggest({ alsoBought: r?.alsoBought || [], top: r?.top || [] })).catch(() => {});
  }, []);

  const loadProducts = useCallback(() => {
    // Cache-aware (Gap D): tenta rede, cai no snapshot IDB quando offline.
    // A grade nunca fica vazia se o catálogo já foi visto ao menos 1 vez.
    const orgId = currentOrgId() || 'unknown';
    const path = `/api/products${hideEmpty ? '?inStock=1' : ''}`;
    loadProductsWithCache(orgId, (p) => apiFetch(p), path).then(({ products, fromCache }) => {
      setProducts((products as any[]).filter((p: any) => p.active !== 0 && p.price != null) as Product[]);
      setProductsFromCache(fromCache);
    }).catch(() => {});
  }, [hideEmpty]);

  useEffect(() => { loadProducts(); loadSuggest(); }, [loadProducts, loadSuggest]);

  const refresh = useCallback((id: string) => {
    apiFetch(`/api/comigo/orders/${id}`).then((r) => r.json()).then((r: any) => {
      setItems(r?.items || []);
      setTotal(Number(r?.order?.total) || 0);
    }).catch(() => {});
  }, []);

  // Aplica um item local (usado quando estamos offline: o server não vai
  // responder o `refresh`, então mantemos o total no cliente).
  const applyItemLocal = (p: Product, qty: number, unitPrice: number, localId: string) => {
    setItems((prev) => [...prev, { id: localId, name: p.name, qty, unit_price: unitPrice, product_id: p.id }]);
    setTotal((prev) => Math.round((prev + qty * unitPrice) * 100) / 100);
  };

  // Grava uma linha no pedido. Se estamos offline (ou a chamada falhar por
  // rede), enfileira no outbox — o commandId estável garante que replays não
  // dupliquem no server. Peso: `qty` fracionário; total = qty × unit_price.
  const addLine = async (p: Product, qty: number, unitPrice: number) => {
    if (busy) return;
    setBusy(true);
    try {
      // Se não temos orderId, GERAMOS UM aqui — offline não pode esperar o server.
      let id = orderId;
      let isNewOrder = false;
      if (!id) { id = crypto.randomUUID(); setOrderId(id); isNewOrder = true; }
      const itemCmdId = crypto.randomUUID();
      const localItemId = crypto.randomUUID();

      // Fast-path: se online, tenta rede direto.
      if (online) {
        try {
          if (isNewOrder) {
            await apiFetch('/api/comigo/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
          }
          await apiFetch(`/api/comigo/orders/${id}/items`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: p.id, name: p.name, unitPrice, qty, commandId: itemCmdId }),
          });
          refresh(id);
          loadSuggest(p.id);
          setOrderPendingSync(false);
          return;
        } catch (e) {
          if (!isNetworkError(e)) { toast.error('Não consegui adicionar o item.'); return; }
          // Rede caiu no meio — cai pro caminho offline abaixo.
        }
      }

      // Caminho offline: aplica local + enfileira no outbox.
      if (isNewOrder) {
        const openCmdId = crypto.randomUUID();
        await enqueueOpenOrder(openCmdId, { orderId: id });
      }
      await enqueueAddItem(itemCmdId, { orderId: id, productId: p.id, name: p.name, qty, unitPrice });
      applyItemLocal(p, qty, unitPrice, localItemId);
      setOrderPendingSync(true);
      loadSuggest(p.id);
      pendingComigoCount().then(setPendingSync).catch(() => {});
    } finally { setBusy(false); }
  };

  const addProduct = (p: Product) => {
    if (busy) return;
    // Por peso: abre o teclado de kg em vez de somar 1 unidade.
    if (p.sale_mode === 'weight') { setWeighing(p); return; }
    addLine(p, 1, p.price);
  };

  // Adiciona a partir de uma sugestão (resolve preço/nome no catálogo carregado).
  const addByProductId = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    if (p) addProduct(p);
  };

  const reset = () => { setOrderId(null); setItems([]); setTotal(0); setFiado(null); setPix(null); setOrderPendingSync(false); loadSuggest(); onChange(); };

  // Pix dinâmico (ADR-118): gera a cobrança; a confirmação vem do PSP por webhook.
  const startPix = async () => {
    if (!orderId || busy) return;
    setBusy(true);
    try {
      const out = await apiFetch(`/api/comigo/orders/${orderId}/pix-dynamic`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
      if (out.ok) setPix({ txid: out.txid, qrPayload: out.qrPayload });
      else toast.error('Adicione itens antes de gerar o Pix.');
    } catch { toast.error('Não consegui gerar o Pix.'); }
    finally { setBusy(false); }
  };

  // Enquanto há cobrança Pix pendente, faz polling da confirmação automática.
  useEffect(() => {
    if (!pix || !orderId) return;
    const iv = setInterval(async () => {
      try {
        const st = await apiFetch(`/api/comigo/orders/${orderId}/pix-status`).then((r) => r.json());
        if (st?.orderStatus === 'paid') { toast.success('Pix recebido!'); reset(); }
      } catch { /* segue tentando */ }
    }, 4000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pix, orderId]);

  const pay = async (paidVia: 'cash' | 'pix_manual' | 'fiado', override = false) => {
    if (!orderId || busy) return;
    setBusy(true);
    try {
      const body: any = { paidVia, override, commandId: crypto.randomUUID() };
      if (paidVia === 'fiado' && fiado) body.customer = fiado;

      // Fast-path online: tenta rede direto.
      if (online) {
        try {
          const res = await apiFetch(`/api/comigo/orders/${orderId}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const out = await res.json();
          if (out.ok) { toast.success(out.receivable ? 'Anotado no fiado.' : 'Recebido!'); reset(); return; }
          if (out.needsOverride) {
            if (window.confirm(`${out.message}\n\nLiberar mesmo assim?`)) await pay(paidVia, true);
            return;
          }
          if (out.error === 'blacklisted') { toast.error('Cliente na lista negra — fiado suspenso. Só à vista.'); return; }
          if (out.error === 'fiado_requires_customer') { toast.error('O fiado precisa do nome e telefone do cliente.'); return; }
          toast.error('Não consegui fechar o pedido.');
          return;
        } catch (e) {
          if (!isNetworkError(e)) { toast.error('Falha ao cobrar.'); return; }
          // Rede caiu — cai pro caminho offline.
        }
      }

      // Caminho offline: enfileira o pagamento no outbox. Fecha o pedido local
      // e libera o Balcão pra próxima venda; a decisão real (dedupe + limite
      // do fiado) sai quando o outbox sincronizar. Aviso o usuário sem susto.
      await enqueuePay(body.commandId, {
        orderId, paidVia,
        customer: paidVia === 'fiado' ? (fiado || undefined) : undefined,
        override,
      });
      toast.success(
        paidVia === 'fiado'
          ? 'Anotado no fiado (vai sincronizar quando a internet voltar).'
          : 'Recebido (vai sincronizar quando a internet voltar).'
      );
      pendingComigoCount().then(setPendingSync).catch(() => {});
      reset();
    } finally { setBusy(false); }
  };

  return (
    <>
    {/* Mobile: pedido no topo (botões de pagamento sempre à mão do polegar), grade abaixo com scroll. */}
    {/* Desktop: layout 2 colunas — grade à esquerda, pedido à direita, como antes. */}
    <div className="grid md:grid-cols-2 gap-3 md:gap-4">
      {/* Grade por toque */}
      <div className="order-2 md:order-1 min-w-0">
        {/* Sugestão zero-token (ADR-117): combina com o último item, ou mais pedidos */}
        {(() => {
          const chips = (items.length > 0 ? suggest.alsoBought : suggest.top)
            .filter((s) => products.some((p) => p.id === s.product_id)).slice(0, 4);
          if (chips.length === 0) return null;
          return (
            <div className="mb-3">
              <div className="text-[11px] text-zinc-500 mb-1">{items.length > 0 ? 'Quem levou isso também levou' : 'Mais pedidos'}</div>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((s) => (
                  <button key={s.product_id} disabled={busy} onClick={() => addByProductId(s.product_id)}
                    className="text-xs rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 px-2.5 py-1 hover:bg-emerald-500/20 disabled:opacity-40">
                    + {s.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="text-xs text-zinc-500">Toque para adicionar</div>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer shrink-0" title="Esconde produtos com estoque zerado. Serviços e itens sem controle de estoque continuam aparecendo.">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Ocultar sem estoque
          </label>
        </div>
        {products.length === 0 ? (
          <div className="text-sm text-zinc-500 rounded-xl border border-zinc-800 p-4">Cadastre produtos no Catálogo para vender aqui.</div>
        ) : (
          // Barra de rolagem interna no mobile: catálogos grandes não empurram o pedido pra fora do fold.
          <div className="max-h-[60vh] overflow-y-auto md:max-h-none md:overflow-visible pr-1 -mr-1">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {products.map((p) => (
                <button key={p.id} disabled={busy} onClick={() => addProduct(p)}
                  className="text-left rounded-xl border border-zinc-800 bg-zinc-900/50 hover:border-emerald-500/40 p-3 disabled:opacity-50">
                  <div className="text-sm text-zinc-100 line-clamp-2">{p.name}</div>
                  <div className="text-emerald-300 text-sm mt-1">{brl(p.price)}{p.sale_mode === 'weight' ? '/kg' : ''}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Pedido da vez — no mobile fica ANTES da grade pra os botões de pagamento não escaparem do polegar. */}
      <div className="order-1 md:order-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 flex flex-col min-w-0">
        {/* Sinais de offline / pendências de sync (Gap D) */}
        {(!online || pendingSync > 0 || productsFromCache) && (
          <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
            {!online && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-200 px-2 py-0.5">
                <WifiOff className="w-3 h-3" /> Sem internet — venda continua, sincroniza quando voltar
              </span>
            )}
            {online && pendingSync > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 text-sky-200 px-2 py-0.5">
                <RefreshCw className="w-3 h-3 animate-spin" /> Sincronizando {pendingSync} {pendingSync === 1 ? 'pedido' : 'pedidos'}
              </span>
            )}
            {productsFromCache && (
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 text-zinc-300 px-2 py-0.5" title="Catálogo do último acesso online">
                catálogo em cache
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1.5 mb-2">
          <div className="text-xs text-zinc-500">Pedido da vez</div>
          {orderPendingSync && (
            <span className="text-[10px] rounded-full bg-amber-500/15 text-amber-200 px-1.5 py-0.5">pendente de sincronizar</span>
          )}
        </div>
        {items.length === 0 ? (
          <div className="text-sm text-zinc-500 flex-1">Nenhum item ainda.</div>
        ) : (
          // Lista de itens com altura máxima no mobile: rola dentro do card, não empurra os botões de pagamento pra baixo.
          <div className="flex-1 space-y-1 max-h-40 md:max-h-none overflow-y-auto pr-1 -mr-1">
            {items.map((it) => {
              const wp = products.find((x) => x.id === it.product_id);
              const isWeight = wp?.sale_mode === 'weight';
              return (
                <div key={it.id} className="flex justify-between text-sm text-zinc-200">
                  <span>{isWeight ? `${kgLabel(it.qty)} de ${it.name}` : `${it.qty}× ${it.name}`}</span>
                  <span>{brl(it.qty * it.unit_price)}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex justify-between items-center border-t border-zinc-800 mt-3 pt-3">
          <span className="text-zinc-400 text-sm">Total</span>
          <span className="text-xl font-semibold text-zinc-100">{brl(total)}</span>
        </div>

        {/* Fiado: nome + telefone */}
        {fiado !== null && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input value={fiado.name} onChange={(e) => setFiado({ ...fiado, name: e.target.value })} placeholder="Nome"
              className="rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm text-zinc-100" />
            <input value={fiado.phone} onChange={(e) => setFiado({ ...fiado, phone: e.target.value })} placeholder="Telefone"
              className="rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm text-zinc-100" />
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 mt-3">
          <button disabled={!orderId || busy} onClick={() => pay('cash')}
            className="flex items-center justify-center gap-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm py-2 disabled:opacity-40">
            <Banknote className="w-4 h-4" /> Dinheiro
          </button>
          <button disabled={!orderId || busy} onClick={() => pay('pix_manual')}
            className="flex items-center justify-center gap-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm py-2 disabled:opacity-40">
            <QrCode className="w-4 h-4" /> Pix
          </button>
          <button disabled={!orderId || busy}
            onClick={() => { if (fiado === null) setFiado({ name: '', phone: '' }); else pay('fiado'); }}
            className="flex items-center justify-center gap-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm py-2 disabled:opacity-40">
            <BookUser className="w-4 h-4" /> {fiado === null ? 'Fiado' : 'Confirmar'}
          </button>
        </div>
        {/* Pix dinâmico (ADR-118): QR com confirmação automática — requer PSP,
            portanto só faz sentido ONLINE. Fica escondido quando offline. */}
        {orderId && online && (
          pix ? (
            <div className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
              <div className="text-xs text-sky-300 flex items-center gap-1"><QrCode className="w-3.5 h-3.5" /> Pix dinâmico — aguardando pagamento…</div>
              <div className="mt-2 text-[11px] text-zinc-400 break-all bg-zinc-900 rounded p-2 font-mono">{pix.qrPayload}</div>
              <button onClick={() => { navigator.clipboard?.writeText(pix.qrPayload); toast.success('Código Pix copiado.'); }}
                className="text-xs text-sky-300 hover:text-sky-200 mt-1">copiar código</button>
            </div>
          ) : (
            <button disabled={busy} onClick={startPix}
              className="text-xs text-sky-300 hover:text-sky-200 mt-2 inline-flex items-center gap-1 self-center">
              <QrCode className="w-3 h-3" /> Pix QR (confirmação automática)
            </button>
          )
        )}
        {orderId && (
          <button onClick={reset} className="text-xs text-zinc-500 hover:text-zinc-300 mt-2 inline-flex items-center gap-1 self-center">
            <Trash2 className="w-3 h-3" /> cancelar pedido
          </button>
        )}
      </div>
    </div>
    {weighing && (
      <WeightModal product={weighing} busy={busy}
        onCancel={() => setWeighing(null)}
        onConfirm={(kg) => { const p = weighing; setWeighing(null); addLine(p, kg, p.price); }} />
    )}
    </>
  );
}

// Teclado de PESO (kg) para venda por peso (peixaria/açougue/hortifruti):
// atalhos das porções cadastradas + digitação livre. Confirma qty=kg,
// unitPrice=preço por kg — o total sai de qty×preço no backend.
function WeightModal({ product, busy, onCancel, onConfirm }: { product: Product; busy: boolean; onCancel: () => void; onConfirm: (kg: number) => void }) {
  const [kg, setKg] = useState('');
  let steps: number[] = [];
  try { const o = JSON.parse(product.sale_options_json || 'null'); if (Array.isArray(o?.steps)) steps = o.steps.map((g: number) => g / 1000).filter((n: number) => n > 0); } catch { /* usa defaults */ }
  if (!steps.length) steps = [0.5, 1, 2];
  const kgNum = parseFloat(String(kg).replace(',', '.')) || 0;
  const total = kgNum * Number(product.price || 0);
  const confirm = () => { if (kgNum > 0) onConfirm(Math.round(kgNum * 1000) / 1000); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="w-full max-w-xs rounded-2xl border border-zinc-800 bg-zinc-950 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm text-zinc-100 font-medium">{product.name}</div>
        <div className="text-emerald-300 text-sm">{brl(product.price)}/kg</div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {steps.map((s) => (
            <button key={s} type="button" onClick={() => setKg(String(s).replace('.', ','))}
              className="text-xs rounded-full border border-zinc-700 bg-zinc-900 text-zinc-200 px-3 py-1.5 hover:border-emerald-500/50">
              {kgLabel(s)}
            </button>
          ))}
        </div>
        <label className="text-xs text-zinc-500 mt-3 block">Peso (kg)</label>
        <input autoFocus type="text" inputMode="decimal" value={kg}
          onChange={(e) => setKg(e.target.value.replace(/[^\d.,]/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
          placeholder="ex.: 1,350"
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-lg text-zinc-100 mt-1" />
        <div className="flex justify-between items-center mt-3">
          <span className="text-zinc-500 text-sm">Total</span>
          <span className="text-lg font-semibold text-emerald-300">{brl(total)}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-zinc-700 text-zinc-300 text-sm py-2 hover:bg-zinc-900">Cancelar</button>
          <button type="button" disabled={kgNum <= 0 || busy} onClick={confirm}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm py-2 disabled:opacity-40">Adicionar</button>
        </div>
      </div>
    </div>
  );
}

// ── Mesa/QR: link do cardápio + fila de preparo (pedidos pagos) ──────────────
type PrepOrder = { id: string; session_alias?: string; consumo: string; total: number; items: { name: string; qty: number }[] };

function Mesa({ onChange }: { onChange: () => void }) {
  const [link, setLink] = useState<{ token: string; url: string } | null>(null);
  const [queue, setQueue] = useState<PrepOrder[]>([]);
  const [busy, setBusy] = useState(false);

  const loadQueue = useCallback(() => {
    apiFetch('/api/comigo/mesa/queue').then((r) => r.json()).then((r: any) => setQueue(r?.orders || [])).catch(() => {});
  }, []);
  useEffect(() => {
    apiFetch('/api/comigo/mesa/link').then((r) => r.json()).then((r: any) => setLink(r)).catch(() => {});
    loadQueue();
    const iv = setInterval(loadQueue, 6000); // novos pedidos pagos chegam sozinhos
    return () => clearInterval(iv);
  }, [loadQueue]);

  const regenerate = async () => {
    if (!window.confirm('Gerar um novo QR? O cardápio com o QR antigo para de funcionar.')) return;
    setBusy(true);
    try { const r = await apiFetch('/api/comigo/mesa/regenerate', { method: 'POST' }).then((x) => x.json()); setLink(r); }
    finally { setBusy(false); }
  };
  const fulfill = async (id: string) => {
    await apiFetch(`/api/comigo/orders/${id}/fulfill`, { method: 'POST' });
    loadQueue(); onChange();
  };

  return (
    <div className="space-y-4">
      {/* Link do cardápio-QR */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Cardápio da mesa (QR)</div>
        <p className="text-xs text-zinc-400 mb-2">Compartilhe este link ou gere um QR dele. O cliente pede e paga sozinho pelo Pix — o pedido só cai aqui quando pago.</p>
        {link ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs text-sky-300 bg-zinc-900 rounded px-2 py-1 break-all">{link.url}</code>
            <button onClick={() => { navigator.clipboard?.writeText(link.url); toast.success('Link copiado.'); }} className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1">Copiar</button>
            <a href={link.url} target="_blank" rel="noreferrer" className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1">Abrir</a>
            <button disabled={busy} onClick={regenerate} className="text-xs rounded-lg border border-zinc-700 text-zinc-400 hover:bg-zinc-800 px-2.5 py-1">Novo QR</button>
          </div>
        ) : <div className="text-sm text-zinc-500">carregando…</div>}
      </div>

      {/* Fila de preparo */}
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Para preparar ({queue.length})</div>
        {queue.length === 0 ? (
          <div className="text-sm text-zinc-500 rounded-xl border border-zinc-800 p-4">Nenhum pedido pago aguardando. Os pedidos da mesa aparecem aqui quando o cliente paga.</div>
        ) : (
          <div className="space-y-2">
            {queue.map((o) => (
              <div key={o.id} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm text-zinc-100">{o.session_alias || 'Cliente'} · <span className="text-zinc-400">{o.consumo === 'viagem' ? 'viagem' : 'aqui'}</span></div>
                    <div className="text-xs text-zinc-400 mt-1">{o.items.map((it) => `${it.qty}× ${it.name}`).join(' · ')}</div>
                  </div>
                  <div className="text-emerald-300 text-sm font-medium">{brl(o.total)}</div>
                </div>
                <button onClick={() => fulfill(o.id)} className="mt-2 text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5">Pronto / entregue</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Saúde: termômetro (subindo/estável/caindo) + ponto de equilíbrio ─────────
type Health = {
  period: string; signal: 'subindo' | 'estavel' | 'caindo';
  profit: number; profitDeltaPct: number; vendasDeltaPct: number; insight: string;
  breakEven: { hasFixedCosts: boolean; breakEvenRevenue: number; breakEvenUnits: number; achievedRevenue: number; achievedUnits: number; progress: number };
};
const PERIODS = [{ k: 'dia', l: 'Dia' }, { k: 'semana', l: 'Semana' }, { k: 'mes', l: 'Mês' }] as const;
const SIGNAL: Record<string, { icon: any; cls: string; label: string }> = {
  subindo: { icon: TrendingUp, cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10', label: 'Subindo' },
  estavel: { icon: Minus, cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10', label: 'Estável' },
  caindo: { icon: TrendingDown, cls: 'text-red-300 border-red-500/40 bg-red-500/10', label: 'Caindo' },
};

function Saude() {
  const [period, setPeriod] = useState<'dia' | 'semana' | 'mes'>('dia');
  const [h, setH] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((p: string) => {
    apiFetch(`/api/comigo/health?period=${p}`).then((r) => r.json()).then((r: any) => setH(r)).catch(() => {});
  }, []);
  useEffect(() => { load(period); }, [period, load]);

  const setFixed = async () => {
    const v = window.prompt('Seus custos fixos por mês (aluguel, luz, etc.) — pra saber quanto precisa vender pra empatar:', '0');
    if (v == null) return;
    setBusy(true);
    try { await apiFetch('/api/comigo/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixedCostsMonthly: Number(v.replace(',', '.')) || 0 }) }); load(period); }
    finally { setBusy(false); }
  };

  const sig = SIGNAL[h?.signal || 'estavel'];
  const SigIcon = sig.icon;
  const be = h?.breakEven;

  return (
    <div className="space-y-4">
      {/* Toggle de período */}
      <div className="inline-flex rounded-lg border border-zinc-800 overflow-hidden">
        {PERIODS.map((p) => (
          <button key={p.k} onClick={() => setPeriod(p.k)}
            className={`px-3 py-1.5 text-sm ${period === p.k ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}>{p.l}</button>
        ))}
      </div>

      {/* Sinal + frase */}
      <div className={`rounded-xl border p-4 flex items-start gap-3 ${sig.cls}`}>
        <SigIcon className="w-8 h-8 shrink-0" />
        <div>
          <div className="text-lg font-semibold">{sig.label}</div>
          <p className="text-sm opacity-90 mt-0.5">{h?.insight || 'Registre vendas no Balcão para o termômetro ganhar vida.'}</p>
        </div>
      </div>

      {/* Ponto de equilíbrio / meta ao vivo */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Meta do dia — ponto de equilíbrio</div>
        {be?.hasFixedCosts ? (
          <>
            <div className="text-sm text-zinc-200">
              Você já fez <span className="text-emerald-300 font-medium">{brl(be.achievedRevenue)}</span> de {brl(be.breakEvenRevenue)} pra empatar hoje
              {be.breakEvenUnits > 0 && <> — <span className="font-medium">{be.achievedUnits} de {be.breakEvenUnits}</span> unidades.</>}
            </div>
            <div className="h-2 rounded-full bg-zinc-800 mt-2 overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${Math.round((be.progress || 0) * 100)}%` }} />
            </div>
          </>
        ) : (
          <button disabled={busy} onClick={setFixed} className="text-sm text-sky-300 hover:text-sky-200 underline underline-offset-2">
            Informe seus custos fixos do mês pra ver quanto precisa vender pra empatar →
          </button>
        )}
      </div>

      {h && (
        <div className="text-xs text-zinc-500">
          Lucro no {period === 'mes' ? 'mês' : period}: <span className="text-zinc-300">{brl(h.profit)}</span>
          {' · '}vs mesmo período anterior: <span className={h.profitDeltaPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>{h.profitDeltaPct >= 0 ? '+' : ''}{h.profitDeltaPct}%</span>
        </div>
      )}

      <MonthlyReport />
      <Graduacao />
    </div>
  );
}

// ── Relatório mensal em PDF (Gap C do levantamento — ADR-088 D8 embrionário) ─
function MonthlyReport() {
  // Últimos 6 meses fechados (do anterior ao atual, indo pra trás).
  const options = useMemo(() => {
    const now = new Date();
    const arr: { value: string; label: string }[] = [];
    for (let i = 1; i <= 6; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const label = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      arr.push({ value: `${y}-${m}`, label: label[0].toUpperCase() + label.slice(1) });
    }
    return arr;
  }, []);
  const [month, setMonth] = useState<string>(options[0].value);
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    apiFetch(`/api/comigo/reports/monthly.json?month=${month}`).then(r => r.json()).then((r: any) => {
      if (r && !r.error) setPreview(r);
    }).catch(() => {});
  }, [month]);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/comigo/reports/monthly.pdf?month=${month}`);
      if (!res.ok) { toast.error('Erro ao gerar o relatório.'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `comigo-relatorio-mensal-${month}.pdf`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Relatório baixado!');
    } catch { toast.error('Erro ao baixar.'); }
    finally { setBusy(false); }
  };

  const hasData = preview && (preview.sales?.orders > 0 || preview.fiado?.balanceEndOfMonth > 0 || preview.agenda?.total > 0);

  return (
    <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-200 mb-2">
        <FileDown className="w-4 h-4" /> Relatório do mês (PDF)
      </div>
      <p className="text-xs text-zinc-400 mb-3">Consolida vendas, fiado e agenda num PDF pra guardar, mostrar pro contador ou pro banco.</p>

      <div className="flex flex-wrap items-center gap-2">
        <select value={month} onChange={e => setMonth(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200">
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button disabled={busy} onClick={download}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-3 py-1.5 disabled:opacity-40">
          {busy ? 'Gerando…' : 'Baixar PDF'}
        </button>
      </div>

      {preview && (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div className="rounded-lg bg-zinc-900/60 p-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Vendas</div>
            <div className="text-zinc-100 font-medium">{brl(preview.sales?.revenue)}</div>
          </div>
          <div className="rounded-lg bg-zinc-900/60 p-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Sobrou</div>
            <div className="text-emerald-300 font-medium">{brl(preview.sales?.profit)}</div>
          </div>
          <div className="rounded-lg bg-zinc-900/60 p-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Pedidos</div>
            <div className="text-zinc-100 font-medium">{preview.sales?.orders || 0}</div>
          </div>
          <div className="rounded-lg bg-zinc-900/60 p-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">Fiado (fim do mês)</div>
            <div className="text-zinc-100 font-medium">{brl(preview.fiado?.balanceEndOfMonth)}</div>
          </div>
        </div>
      )}
      {preview && !hasData && (
        <p className="text-xs text-zinc-500 mt-2">Sem movimento nesse mês — o PDF sai vazio, mas dá pra baixar assim mesmo.</p>
      )}
    </div>
  );
}

// ── Graduação: guia de formalização MEI + nota fiscal (ADR-122) ──────────────
function Graduacao() {
  const [g, setG] = useState<any | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch('/api/comigo/graduation').then((r) => r.json()).then((r: any) => { if (r?.readiness) setG(r); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const declare = async () => {
    if (!window.confirm('Confirmar que você já é MEI? Vou parar de sugerir a formalização e liberar o guia de nota fiscal.')) return;
    setBusy(true);
    try { const r = await apiFetch('/api/comigo/graduation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'mei' }) }).then((x) => x.json()); setG(r); toast.success('Boa! 🎓 Parabéns pela formalização.'); }
    finally { setBusy(false); }
  };

  // Enquanto informal e ainda cedo, não incomoda (foco em crescer).
  if (!g || (!g.formalized && g.readiness === 'cedo')) return null;

  return (
    <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-4">
      <div className="text-sm font-semibold text-indigo-200 flex items-center gap-1.5">🎓 {g.formalized ? 'Sua formalização' : 'Hora de graduar?'}</div>
      <p className="text-xs text-zinc-300 mt-1">{g.recommendation}</p>

      {/* Faturamento projetado × teto MEI */}
      <div className="mt-3">
        <div className="flex justify-between text-[11px] text-zinc-400">
          <span>Projeção anual: {brl(g.projectedAnnual)}</span>
          <span>teto MEI {brl(g.meiLimit)}</span>
        </div>
        <div className="h-2 rounded-full bg-zinc-800 mt-1 overflow-hidden">
          <div className={`h-full ${g.readiness === 'acima_mei' ? 'bg-red-500' : g.readiness === 'perto_do_teto' ? 'bg-amber-500' : 'bg-indigo-500'}`} style={{ width: `${Math.min(100, g.pctOfMei)}%` }} />
        </div>
      </div>

      <p className="text-xs text-zinc-400 mt-3">{g.notaFiscal.text}</p>

      {!g.formalized && g.steps.length > 0 && (
        <div className="mt-3">
          <button onClick={() => setShowSteps((s) => !s)} className="text-xs text-indigo-300 hover:text-indigo-200">{showSteps ? 'Ocultar passos' : 'Ver como virar MEI (grátis)'}</button>
          {showSteps && (
            <ol className="list-decimal list-inside text-xs text-zinc-300 mt-2 space-y-1">
              {g.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}
            </ol>
          )}
          <button disabled={busy} onClick={declare} className="mt-3 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5">Já sou MEI</button>
        </div>
      )}
    </div>
  );
}

// ── Caderneta: quem me deve, receber, lista negra, cobrança cortês ───────────
type FiadoCustomer = {
  contact_id: string; name: string; phone: string; balance: number; credit_limit: number;
  blacklisted: number; block_all_sales: number; store_fiado_enabled: number; blacklistSuggested: boolean; daysOverdue: number; reminders: number;
};
type Summary = { caixaHoje: number; aReceber: number; ticketMedio: number; pedidosHoje: number };

function Caderneta({ onChange }: { onChange: () => void }) {
  const [customers, setCustomers] = useState<FiadoCustomer[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch('/api/comigo/fiado').then((r) => r.json()).then((r: any) => setCustomers(r?.customers || [])).catch(() => {});
    apiFetch('/api/comigo/summary').then((r) => r.json()).then((r: any) => setSummary(r)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (url: string, body?: any, method = 'POST') => {
    setBusy(true);
    try {
      const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const out = await r.json().catch(() => ({}));
      load(); onChange();
      return out;
    } catch { toast.error('Não consegui concluir.'); return null; }
    finally { setBusy(false); }
  };

  const receber = (c: FiadoCustomer) => {
    const v = window.prompt(`Receber de ${c.name} (saldo ${brl(c.balance)}). Quanto?`, String(c.balance));
    if (v == null) return;
    const amount = Number(v.replace(',', '.'));
    if (!(amount > 0)) return;
    act(`/api/comigo/fiado/${c.contact_id}/settle`, { amount }).then((o) => o && toast.success('Recebimento anotado.'));
  };
  const lembrar = (c: FiadoCustomer) => act(`/api/comigo/fiado/${c.contact_id}/remind`).then((o) => {
    if (o?.waLink) window.open(o.waLink, '_blank');
    else if (o?.text) { navigator.clipboard?.writeText(o.text); toast.success('Mensagem copiada (sem telefone p/ link).'); }
  });
  const setLimite = (c: FiadoCustomer) => {
    const v = window.prompt(`Limite de fiado de ${c.name}:`, String(c.credit_limit || 0));
    if (v == null) return;
    // Governança de IA (ADR-130): definir o limite de crédito afeta a pessoa —
    // decisão humana com motivo registrado (base = histórico, não perfil).
    const reason = window.prompt(`Motivo do limite de ${c.name}? (fica registrado — ex.: bom histórico de pagamento, atraso recorrente)`, c.credit_limit ? '' : 'primeiro limite');
    if (reason == null) return;
    if (!reason.trim()) { toast.error('Informe um motivo — é uma decisão registrada.'); return; }
    act(`/api/comigo/fiado/${c.contact_id}/credit`, { limit: Number(v.replace(',', '.')) || 0, reason: reason.trim() }, 'PUT');
  };
  const toggleBlacklist = (c: FiadoCustomer) => {
    if (!c.blacklisted) {
      // Governança de IA (ADR-130): bloquear uma pessoa é decisão humana com motivo.
      const reason = window.prompt(`Motivo para colocar ${c.name} na lista negra? (fica registrado — para de dar fiado, mas segue vendendo à vista)`, c.blacklistSuggested ? `${c.daysOverdue} dias em atraso` : '');
      if (reason == null) return;
      if (!reason.trim()) { toast.error('Informe um motivo — é uma decisão registrada.'); return; }
      act(`/api/comigo/fiado/${c.contact_id}/blacklist`, { on: true, reason: reason.trim(), suggested: c.blacklistSuggested });
    } else {
      act(`/api/comigo/fiado/${c.contact_id}/blacklist`, { on: false, reason: 'retirado da lista' });
    }
  };
  const toggleBlockAll = (c: FiadoCustomer) => {
    if (!c.block_all_sales) {
      // Governança de IA (ADR-130): suspender TODAS as vendas (inclui à vista) é
      // a medida mais severa — decisão humana com motivo registrado.
      const reason = window.prompt(`Motivo para suspender TODAS as vendas de ${c.name}? (inclui à vista — fica registrado)`);
      if (reason == null) return;
      if (!reason.trim()) { toast.error('Informe um motivo — é uma decisão registrada.'); return; }
      act(`/api/comigo/fiado/${c.contact_id}/block-all`, { on: true, reason: reason.trim() });
    } else {
      act(`/api/comigo/fiado/${c.contact_id}/block-all`, { on: false, reason: 'venda liberada' });
    }
  };
  const toggleStoreFiado = (c: FiadoCustomer) => act(`/api/comigo/fiado/${c.contact_id}/store-fiado`, { on: !c.store_fiado_enabled });
  const writeOff = (c: FiadoCustomer) => {
    if (!window.confirm(`Dar baixa em ${brl(c.balance)} de ${c.name} como calote? Isso zera a dívida e lança a perda no relatório. Não dá pra desfazer.`)) return;
    act(`/api/comigo/fiado/${c.contact_id}/writeoff`).then((o) => o?.ok && toast.success('Baixado como calote e lançado nas perdas.'));
  };

  return (
    <div className="space-y-4">
      {/* Caixa × a receber (ADR-112 D3) — cards compactos no mobile (menos padding e fonte menor) pra caber melhor no celular. */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2 md:p-3 min-w-0">
          <div className="text-[10px] md:text-[11px] uppercase tracking-wide text-emerald-400/80">Caixa hoje</div>
          <div className="text-base md:text-lg font-semibold text-emerald-200 mt-1 truncate">{summary ? brl(summary.caixaHoje) : '—'}</div>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-2 md:p-3 min-w-0">
          <div className="text-[10px] md:text-[11px] uppercase tracking-wide text-amber-400/80">A receber</div>
          <div className="text-base md:text-lg font-semibold text-amber-200 mt-1 truncate">{summary ? brl(summary.aReceber) : '—'}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-2 md:p-3 min-w-0">
          <div className="text-[10px] md:text-[11px] uppercase tracking-wide text-zinc-500">Ticket médio</div>
          <div className="text-base md:text-lg font-semibold text-zinc-100 mt-1 truncate">{summary ? brl(summary.ticketMedio) : '—'}</div>
        </div>
      </div>

      {/* Gancho jurídico proativo (ADR-115 Fatia 2): cobrar sem constranger (art. 42). */}
      {customers.some((c) => c.balance > 0) && <LegalTip situation="cobranca_fiado" />}

      {customers.length === 0 ? (
        <div className="text-sm text-zinc-500 rounded-xl border border-zinc-800 p-4">Ninguém no fiado ainda.</div>
      ) : (
        // Fiado com muita gente: rola dentro do próprio bloco no mobile, ao invés de virar uma tela sem fim.
        <div className="space-y-2 max-h-[60vh] overflow-y-auto md:max-h-none md:overflow-visible pr-1 -mr-1">
          {customers.map((c) => (
            <div key={c.contact_id} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm text-zinc-100 flex items-center gap-2 flex-wrap">
                    {c.name || 'Cliente'}
                    {!!c.blacklisted && <span className="text-[10px] rounded-full bg-red-500/15 text-red-300 border border-red-500/30 px-1.5 py-0.5">lista negra</span>}
                    {!!c.block_all_sales && <span className="text-[10px] rounded-full bg-red-500/15 text-red-300 border border-red-500/30 px-1.5 py-0.5">venda suspensa</span>}
                    {c.blacklistSuggested && <span className="text-[10px] rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30 px-1.5 py-0.5">sugerido p/ lista negra ({c.daysOverdue}d)</span>}
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5">Deve <span className="text-amber-300 font-medium">{brl(c.balance)}</span> · limite {brl(c.credit_limit)}{c.reminders > 0 ? ` · ${c.reminders} lembrete(s)` : ''}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <button disabled={busy || c.balance <= 0} onClick={() => receber(c)} className="text-xs rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 disabled:opacity-40">Receber</button>
                <button disabled={busy || c.balance <= 0} onClick={() => lembrar(c)} className="text-xs rounded-lg bg-sky-600 hover:bg-sky-500 text-white px-2.5 py-1 disabled:opacity-40 inline-flex items-center gap-1"><MessageCircle className="w-3 h-3" /> Lembrete gentil</button>
                <button disabled={busy || c.balance <= 0} onClick={() => writeOff(c)} title="Perda irrecuperável: zera a dívida e lança nas perdas (calote)" className="text-xs rounded-lg border border-red-500/40 text-red-300 hover:bg-red-500/10 px-2.5 py-1 disabled:opacity-40">Baixar (calote)</button>
                <button disabled={busy} onClick={() => setLimite(c)} className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1">Limite</button>
                <button disabled={busy || !!c.blacklisted} onClick={() => toggleStoreFiado(c)} title="Deixar este cliente comprar fiado pelo cardápio/QR, dentro do limite"
                  className={`text-xs rounded-lg px-2.5 py-1 border ${c.store_fiado_enabled ? 'border-amber-500/40 text-amber-300 hover:bg-amber-500/10' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'} disabled:opacity-40`}>
                  {c.store_fiado_enabled ? 'Fiado na loja ✓' : 'Liberar fiado na loja'}
                </button>
                <button disabled={busy} onClick={() => toggleBlacklist(c)} className={`text-xs rounded-lg px-2.5 py-1 border ${c.blacklisted ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'border-red-500/40 text-red-300 hover:bg-red-500/10'}`}>{c.blacklisted ? 'Tirar da lista' : 'Lista negra'}</button>
                {!!c.blacklisted && (
                  <button disabled={busy} onClick={() => toggleBlockAll(c)} className={`text-xs rounded-lg px-2.5 py-1 border ${c.block_all_sales ? 'border-zinc-700 text-zinc-300 hover:bg-zinc-800' : 'border-red-500/40 text-red-300 hover:bg-red-500/10'}`}>{c.block_all_sales ? 'Liberar à vista' : 'Suspender à vista'}</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ComigoView;
