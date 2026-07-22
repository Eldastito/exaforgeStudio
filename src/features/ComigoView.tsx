import { useEffect, useState, useCallback } from 'react';
import { HandCoins, Calculator, Store, NotebookText, Sparkles, Trash2, Banknote, QrCode, BookUser, MessageCircle, Activity, TrendingUp, TrendingDown, Minus, Megaphone } from 'lucide-react';
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
  { key: 'mesa', label: 'Mesa/QR', icon: QrCode },
  { key: 'saude', label: 'Saúde', icon: Activity },
  { key: 'precificacao', label: 'Precificação', icon: Calculator },
  { key: 'caderneta', label: 'Caderneta', icon: NotebookText },
  { key: 'divulgar', label: 'Divulgar', icon: Megaphone },
] as const;

export function ComigoView() {
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
      <div className="p-4 md:p-6 max-w-lg mx-auto">
        <ArchetypeOnboarding onDone={() => { loadArch(); loadOverview(); }} />
      </div>
    );
  }

  // A aba Mesa/QR só aparece quando o arquétipo usa (ADR-120 D2).
  const mesaHidden = arch ? arch.mesaEnabled === false : false;
  const visibleTabs = TABS.filter((t) => t.key !== 'mesa' || !mesaHidden);
  const activeTab = tab === 'mesa' && mesaHidden ? 'balcao' : tab;

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
        {activeTab === 'balcao' && <Balcao onChange={loadOverview} />}
        {activeTab === 'mesa' && <Mesa onChange={loadOverview} />}
        {activeTab === 'saude' && <Saude />}
        {activeTab === 'precificacao' && (
          <Placeholder icon={Calculator} title="Precificação"
            desc="O motor já calcula custo, preço sugerido e recalibra pelo real (API pronta no PR #2). O formulário da ficha entra no próximo incremento." />
        )}
        {activeTab === 'caderneta' && <Caderneta onChange={loadOverview} />}
        {activeTab === 'divulgar' && <Divulgar />}
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

      <Graduacao />
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
