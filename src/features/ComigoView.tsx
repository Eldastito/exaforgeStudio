import { useEffect, useState, useCallback } from 'react';
import { HandCoins, Calculator, Store, NotebookText, Sparkles, Trash2, Banknote, QrCode, BookUser } from 'lucide-react';
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
type Overview = { recipes: number; openOrders: number; fiadoReceivable: number; blacklisted: number };

const TABS = [
  { key: 'balcao', label: 'Balcão', icon: Store },
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
        {tab === 'precificacao' && (
          <Placeholder icon={Calculator} title="Precificação"
            desc="O motor já calcula custo, preço sugerido e recalibra pelo real (API pronta no PR #2). O formulário da ficha entra no próximo incremento." />
        )}
        {tab === 'caderneta' && (
          <Placeholder icon={BookUser} title="Caderneta"
            desc="Quem te deve, limite de cada um, lista negra e cobrança amigável. Chega no PR #4 — o saldo já é rastreado pelo Balcão." />
        )}
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

  useEffect(() => {
    apiFetch('/api/products').then((r) => r.json()).then((rows: any) => {
      const list = Array.isArray(rows) ? rows : (rows?.products || []);
      setProducts(list.filter((p: Product) => p.active !== 0 && p.price != null));
    }).catch(() => {});
  }, []);

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
    } catch { toast.error('Não consegui adicionar o item.'); }
    finally { setBusy(false); }
  };

  const reset = () => { setOrderId(null); setItems([]); setTotal(0); setFiado(null); onChange(); };

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
        {orderId && (
          <button onClick={reset} className="text-xs text-zinc-500 hover:text-zinc-300 mt-2 inline-flex items-center gap-1 self-center">
            <Trash2 className="w-3 h-3" /> cancelar pedido
          </button>
        )}
      </div>
    </div>
  );
}

export default ComigoView;
