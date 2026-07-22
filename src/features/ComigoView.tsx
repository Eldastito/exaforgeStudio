import { useEffect, useState, useCallback } from 'react';
import { HandCoins, Calculator, Store, NotebookText, Sparkles, Trash2, Banknote, QrCode, BookUser, MessageCircle, Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

// ============================================================================
// ZappFlow Comigo — módulo `copiloto` do plano Autônomo (ADR-111/112/113).
// PR #3: Balcão PDV por toque + fiado (limite, aviso+override) + lista negra.
// Precificação (motor no PR #2) e Caderneta (PR #4) seguem como placeholders.
// ============================================================================

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;

type Product = { id: string; name: string; price: number; type: string; active: number };
type OrderItem = { id: string; name: string; qty: number; unit_price: number };
type SugItem = { product_id: string; name: string; count: number };
type Overview = { recipes: number; openOrders: number; fiadoReceivable: number; blacklisted: number };

const TABS = [
  { key: 'balcao', label: 'Balcão', icon: Store },
  { key: 'saude', label: 'Saúde', icon: Activity },
  { key: 'precificacao', label: 'Precificação', icon: Calculator },
  { key: 'caderneta', label: 'Caderneta', icon: NotebookText },
] as const;

export function ComigoView() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('balcao');
  const [ov, setOv] = useState<Overview | null>(null);

  const loadOverview = useCallback(() => {
    apiFetch('/api/comigo/overview').then((r) => r.json()).then((r: any) => {
      if (r && typeof r.recipes === 'number') setOv(r);
    }).catch(() => {});
  }, []);
  useEffect(() => { loadOverview(); }, [loadOverview]);

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
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

      <div className="flex gap-2 border-b border-zinc-800">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === t.key ? 'border-emerald-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
              }`}>
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {tab === 'balcao' && <Balcao onChange={loadOverview} />}
        {tab === 'saude' && <Saude />}
        {tab === 'precificacao' && (
          <Placeholder icon={Calculator} title="Precificação"
            desc="O motor já calcula custo, preço sugerido e recalibra pelo real (API pronta no PR #2). O formulário da ficha entra no próximo incremento." />
        )}
        {tab === 'caderneta' && <Caderneta onChange={loadOverview} />}
      </div>
    </div>
  );
}

function Placeholder({ icon: Icon, title, desc }: { icon: any; title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center">
      <Sparkles className="w-6 h-6 text-emerald-300 mx-auto mb-2" />
      <div className="text-sm font-medium text-zinc-200">{title} — em construção</div>
      <p className="text-xs text-zinc-400 max-w-md mx-auto mt-1.5">{desc}</p>
      <div className="text-[11px] text-zinc-600 mt-2 inline-flex"><Icon className="w-3.5 h-3.5" /></div>
    </div>
  );
}

// ── Balcão PDV por toque ─────────────────────────────────────────────────────
function Balcao({ onChange }: { onChange: () => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fiado, setFiado] = useState<{ name: string; phone: string } | null>(null);
  const [suggest, setSuggest] = useState<{ alsoBought: SugItem[]; top: SugItem[] }>({ alsoBought: [], top: [] });
  const [pix, setPix] = useState<{ txid: string; qrPayload: string } | null>(null);

  const loadSuggest = useCallback((pid?: string) => {
    apiFetch(`/api/comigo/suggest${pid ? `?productId=${pid}` : ''}`).then((r) => r.json())
      .then((r: any) => setSuggest({ alsoBought: r?.alsoBought || [], top: r?.top || [] })).catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch('/api/products').then((r) => r.json()).then((rows: any) => {
      const list = Array.isArray(rows) ? rows : (rows?.products || []);
      setProducts(list.filter((p: Product) => p.active !== 0 && p.price != null));
    }).catch(() => {});
    loadSuggest();
  }, [loadSuggest]);

  const refresh = useCallback((id: string) => {
    apiFetch(`/api/comigo/orders/${id}`).then((r) => r.json()).then((r: any) => {
      setItems(r?.items || []);
      setTotal(Number(r?.order?.total) || 0);
    }).catch(() => {});
  }, []);

  const addProduct = async (p: Product) => {
    if (busy) return;
    setBusy(true);
    try {
      let id = orderId;
      if (!id) {
        const r = await apiFetch('/api/comigo/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then((x) => x.json());
        id = r.id; setOrderId(id);
      }
      await apiFetch(`/api/comigo/orders/${id}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: p.id, name: p.name, unitPrice: p.price, qty: 1 }) });
      refresh(id!);
      loadSuggest(p.id); // "quem levou isso também levou"
    } catch { toast.error('Não consegui adicionar o item.'); }
    finally { setBusy(false); }
  };

  // Adiciona a partir de uma sugestão (resolve preço/nome no catálogo carregado).
  const addByProductId = (pid: string) => {
    const p = products.find((x) => x.id === pid);
    if (p) addProduct(p);
  };

  const reset = () => { setOrderId(null); setItems([]); setTotal(0); setFiado(null); setPix(null); loadSuggest(); onChange(); };

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
      const body: any = { paidVia, override };
      if (paidVia === 'fiado' && fiado) body.customer = fiado;
      const res = await apiFetch(`/api/comigo/orders/${orderId}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json();
      if (out.ok) {
        toast.success(out.receivable ? 'Anotado no fiado.' : 'Recebido!');
        reset();
      } else if (out.needsOverride) {
        if (window.confirm(`${out.message}\n\nLiberar mesmo assim?`)) await pay(paidVia, true);
      } else if (out.error === 'blacklisted') {
        toast.error('Cliente na lista negra — fiado suspenso. Só à vista.');
      } else if (out.error === 'fiado_requires_customer') {
        toast.error('O fiado precisa do nome e telefone do cliente.');
      } else {
        toast.error('Não consegui fechar o pedido.');
      }
    } catch { toast.error('Falha ao cobrar.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* Grade por toque */}
      <div>
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
        <div className="text-xs text-zinc-500 mb-2">Toque para adicionar</div>
        {products.length === 0 ? (
          <div className="text-sm text-zinc-500 rounded-xl border border-zinc-800 p-4">Cadastre produtos no Catálogo para vender aqui.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {products.map((p) => (
              <button key={p.id} disabled={busy} onClick={() => addProduct(p)}
                className="text-left rounded-xl border border-zinc-800 bg-zinc-900/50 hover:border-emerald-500/40 p-3 disabled:opacity-50">
                <div className="text-sm text-zinc-100 line-clamp-2">{p.name}</div>
                <div className="text-emerald-300 text-sm mt-1">{brl(p.price)}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Pedido da vez */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 flex flex-col">
        <div className="text-xs text-zinc-500 mb-2">Pedido da vez</div>
        {items.length === 0 ? (
          <div className="text-sm text-zinc-500 flex-1">Nenhum item ainda.</div>
        ) : (
          <div className="flex-1 space-y-1">
            {items.map((it) => (
              <div key={it.id} className="flex justify-between text-sm text-zinc-200">
                <span>{it.qty}× {it.name}</span>
                <span>{brl(it.qty * it.unit_price)}</span>
              </div>
            ))}
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
        {/* Pix dinâmico (ADR-118): QR com confirmação automática */}
        {orderId && (
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
    </div>
  );
}

// ── Caderneta: quem me deve, receber, lista negra, cobrança cortês ───────────
type FiadoCustomer = {
  contact_id: string; name: string; phone: string; balance: number; credit_limit: number;
  blacklisted: number; block_all_sales: number; blacklistSuggested: boolean; daysOverdue: number; reminders: number;
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
    act(`/api/comigo/fiado/${c.contact_id}/credit`, { limit: Number(v.replace(',', '.')) || 0 }, 'PUT');
  };
  const toggleBlacklist = (c: FiadoCustomer) => {
    if (!c.blacklisted && !window.confirm(`Colocar ${c.name} na lista negra? Para de dar fiado (mas segue vendendo à vista).`)) return;
    act(`/api/comigo/fiado/${c.contact_id}/blacklist`, { on: !c.blacklisted, reason: 'definido pelo dono' });
  };
  const toggleBlockAll = (c: FiadoCustomer) => act(`/api/comigo/fiado/${c.contact_id}/block-all`, { on: !c.block_all_sales });

  return (
    <div className="space-y-4">
      {/* Caixa × a receber (ADR-112 D3) */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-emerald-400/80">Caixa hoje</div>
          <div className="text-lg font-semibold text-emerald-200 mt-1">{summary ? brl(summary.caixaHoje) : '—'}</div>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-amber-400/80">A receber (fiado)</div>
          <div className="text-lg font-semibold text-amber-200 mt-1">{summary ? brl(summary.aReceber) : '—'}</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">Ticket médio</div>
          <div className="text-lg font-semibold text-zinc-100 mt-1">{summary ? brl(summary.ticketMedio) : '—'}</div>
        </div>
      </div>

      {customers.length === 0 ? (
        <div className="text-sm text-zinc-500 rounded-xl border border-zinc-800 p-4">Ninguém no fiado ainda.</div>
      ) : (
        <div className="space-y-2">
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
                <button disabled={busy} onClick={() => setLimite(c)} className="text-xs rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1">Limite</button>
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
