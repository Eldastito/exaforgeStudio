import React, { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { Button } from '@/src/components/ui/button';
import { PackageCheck, Check, X as XIcon, AlertTriangle, Truck, Trophy, Globe, Inbox, Store, Search, MapPin } from 'lucide-react';

type ReqItem = {
  id: string;
  product_service_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  current_stock: number;
  threshold: number;
  suggested_qty: number;
  avg_daily_consumption: number | null;
  days_of_cover: number | null;
  unit_price: number | null;
};

type QuoteItem = { id: string; product_service_id: string; product_name: string; unit_price: number; available_qty: number | null; line_total: number };
type Quote = {
  id: string; requisition_id: string; supplier_contact_id: string | null;
  network_org_id?: string | null; from_network?: number;
  supplier_name: string;
  status: 'sent' | 'answered' | 'accepted' | 'rejected';
  delivery_days: number | null; total_amount: number | null; notes: string | null;
  sent_at: string; answered_at: string | null; accepted_at: string | null;
  items: QuoteItem[];
};

type NetworkSupplier = {
  orgId: string; name: string; categories: string;
  city: string; state: string;
  deliveryRadiusKm: number; minOrderAmount: number;
  distanceKm: number | null;
};

type NetworkProfile = {
  orgId: string; name: string; enabled: boolean; categories: string;
  city: string; state: string; lat: number | null; lng: number | null;
  radiusKm: number; minOrderAmount: number; phone: string;
};

type IncomingQuote = {
  id: string; buyer_name: string; buyer_city: string | null;
  status: 'sent' | 'answered' | 'accepted' | 'rejected';
  sent_at: string; delivery_days: number | null; total_amount: number | null;
  items: { id: string; product_name: string; unit_price: number | null; available_qty: number | null }[];
};

type Supplier = { id: string; name: string; identifier: string; supplier_categories: string | null };
type Settings = { enabled: boolean; targetDays: number };

const brl = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

export function ProcurementView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [requisition, setRequisition] = useState<any>(null);
  const [items, setItems] = useState<ReqItem[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSettings = () => apiFetch('/api/procurement/settings').then(r => r.json()).then(setSettings).catch(() => {});
  const loadSuppliers = () => apiFetch('/api/procurement/suppliers').then(r => r.json()).then(d => setSuppliers(Array.isArray(d) ? d : [])).catch(() => {});
  const loadRequisition = async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/procurement/requisition');
      const data = await r.json();
      setRequisition(data.requisition || null);
      setItems(Array.isArray(data.items) ? data.items : []);
      // Se já está aprovada (ou virou pedido), carrega as cotações associadas.
      if (data.requisition?.id) {
        const q = await apiFetch(`/api/procurement/requisition/${data.requisition.id}/quotes`).then(x => x.json()).catch(() => []);
        setQuotes(Array.isArray(q) ? q : []);
      } else setQuotes([]);
    } finally { setLoading(false); }
  };

  useEffect(() => { loadSettings(); loadSuppliers(); loadRequisition(); const t = setInterval(loadRequisition, 30_000); return () => clearInterval(t); }, []);

  const saveSettings = async (patch: Partial<Settings>) => {
    const next = { enabled: settings?.enabled || false, targetDays: settings?.targetDays || 14, ...patch };
    setSettings(next);
    await apiFetch('/api/procurement/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
    loadRequisition();
  };

  const approve = async () => {
    if (!requisition?.id) return;
    const r = await apiFetch(`/api/procurement/requisition/${requisition.id}/approve`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    const total = (d?.quotesSent || 0) + (d?.network || 0);
    if (total) alert(`Aprovado! Cotação enviada para ${d.quotesSent || 0} fornecedor(es) local(is)${d?.network ? ` e ${d.network} da rede ZappFlow` : ''}.`);
    loadRequisition();
  };
  const dismiss = async () => {
    if (!requisition?.id) return;
    await apiFetch(`/api/procurement/requisition/${requisition.id}/dismiss`, { method: 'POST' });
    loadRequisition();
  };
  const acceptQuote = async (quoteId: string) => {
    await apiFetch(`/api/procurement/quote/${quoteId}/accept`, { method: 'POST' });
    loadRequisition();
  };

  const totalEstimado = items.reduce((acc, it) => acc + ((it.unit_price || 0) * (it.suggested_qty || 0)), 0);
  const draft = requisition?.status === 'draft';
  const bestQuote = quotes.filter(q => q.status === 'answered' && q.total_amount != null).sort((a, b) => (a.total_amount || 0) - (b.total_amount || 0))[0];

  // ===== REDE ZAPPFLOW (Fase 3) =====
  type Tab = 'reposicao' | 'rede' | 'recebidos' | 'perfil';
  const [tab, setTab] = useState<Tab>('reposicao');
  const [profile, setProfile] = useState<NetworkProfile | null>(null);
  const [incoming, setIncoming] = useState<IncomingQuote[]>([]);
  const [search, setSearch] = useState<{ q: string; maxKm: string; category: string }>({ q: '', maxKm: '', category: '' });
  const [searchResults, setSearchResults] = useState<NetworkSupplier[]>([]);

  const loadProfile = () => apiFetch('/api/procurement/network/profile').then(r => r.json()).then(setProfile).catch(() => {});
  const loadIncoming = () => apiFetch('/api/procurement/network/incoming').then(r => r.json()).then(d => setIncoming(Array.isArray(d) ? d : [])).catch(() => {});

  useEffect(() => {
    if (tab === 'recebidos') loadIncoming();
    if (tab === 'perfil') loadProfile();
  }, [tab]);

  const saveProfile = async (patch: Partial<NetworkProfile>) => {
    const r = await apiFetch('/api/procurement/network/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const d = await r.json().catch(() => ({}));
    if (d?.profile) setProfile(d.profile);
  };

  const runSearch = async () => {
    const qs = new URLSearchParams();
    if (search.q) qs.set('q', search.q);
    if (search.maxKm) qs.set('maxKm', search.maxKm);
    if (search.category) qs.set('category', search.category);
    const r = await apiFetch(`/api/procurement/network/suppliers?${qs.toString()}`).then(x => x.json()).catch(() => []);
    setSearchResults(Array.isArray(r) ? r : []);
  };
  useEffect(() => { if (tab === 'rede') runSearch(); }, [tab]);

  const answerIncoming = async (quoteId: string, payload: any) => {
    await apiFetch(`/api/procurement/network/quote/${quoteId}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    loadIncoming();
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto">
      <p className="text-[11px] font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--color-zf-amber)' }}>ZappFlow Supply</p>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <PackageCheck className="h-6 w-6" style={{ color: 'var(--color-zf-amber)' }} /> Compras / Reposição
        </h2>
      </div>
      <p className="text-sm text-zinc-400 mb-4">
        Antes de faltar, o ZappFlow sinaliza: a IA observa o estoque, cota com fornecedores locais e da <b>rede ZappFlow</b>, e você escolhe o vencedor com um clique.
      </p>

      {/* Abas: Reposição (Fase 1+2) · Buscar na rede (emergência) · Pedidos recebidos · Perfil de fornecedor */}
      <div className="mb-6 flex gap-1 border-b border-zinc-800 overflow-x-auto">
        {[
          { k: 'reposicao', label: 'Reposição', Icon: PackageCheck },
          { k: 'rede', label: 'Buscar na rede', Icon: Search },
          { k: 'recebidos', label: `Pedidos recebidos${incoming.length ? ` (${incoming.length})` : ''}`, Icon: Inbox },
          { k: 'perfil', label: 'Ser fornecedor', Icon: Store },
        ].map(t => (
          <button key={t.k} onClick={() => setTab(t.k as Tab)}
            className={`px-4 py-2 text-sm flex items-center gap-2 border-b-2 -mb-px shrink-0 whitespace-nowrap transition-colors ${tab === t.k ? 'border-indigo-500 text-indigo-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}>
            <t.Icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'reposicao' && (<>

      {/* Configuração */}
      {settings && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100">⚙️ Reposição inteligente</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Cobre os próximos{' '}
                <input type="number" min="1" value={settings.targetDays}
                  onChange={e => setSettings({ ...settings, targetDays: parseInt(e.target.value, 10) || 14 })}
                  onBlur={e => saveSettings({ targetDays: parseInt(e.target.value, 10) || 14 })}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1 text-center text-zinc-200" /> dias com base no consumo médio (saídas dos últimos 30 dias).
              </p>
            </div>
            <button onClick={() => saveSettings({ enabled: !settings.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Fornecedores cadastrados (atalho informativo). */}
      {suppliers.length === 0 && (
        <div className="mb-6 rounded-xl border border-amber-700/30 bg-amber-500/5 p-3 text-xs">
          <p className="text-amber-300 font-medium">Cadastre fornecedores para receber cotações automáticas.</p>
          <p className="text-zinc-400 mt-1">Vá em <i>Contatos</i>, marque os contatos que são fornecedores como <b>“Fornecedor”</b> e (opcional) adicione as <b>categorias</b> que ele atende.</p>
        </div>
      )}
      {suppliers.length > 0 && (
        <div className="mb-6">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500 mb-2">Fornecedores cadastrados ({suppliers.length})</p>
          <div className="flex flex-wrap gap-2">
            {suppliers.map(s => (
              <span key={s.id} className="text-xs bg-zinc-900 border border-zinc-800 rounded-full px-3 py-1 text-zinc-300">
                <Truck className="inline w-3 h-3 mr-1 text-indigo-400" />{s.name}
                {s.supplier_categories ? <span className="text-zinc-500"> · {s.supplier_categories}</span> : null}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Requisição em andamento (rascunho ou aprovada com cotações). */}
      {loading ? (
        <p className="text-sm text-zinc-500">Carregando...</p>
      ) : items.length === 0 && quotes.length === 0 ? (
        <div className="rounded-xl border border-emerald-700/30 bg-emerald-500/5 p-6 text-center">
          <p className="text-emerald-300 font-medium">✅ Tudo em ordem por aqui</p>
          <p className="text-xs text-zinc-500 mt-1">Nenhum produto abaixo do mínimo crítico no momento.</p>
          <p className="text-xs text-zinc-500 mt-3">Defina o mínimo crítico em <i>Catálogo</i> para a IA monitorar o item.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex items-center justify-between p-4 border-b border-zinc-800">
            <div>
              <p className="text-sm font-medium text-zinc-100 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                {items.length > 0
                  ? `${items.length} item(ns) abaixo do mínimo crítico`
                  : `Requisição aprovada — aguardando cotações`}
              </p>
              {items.length > 0 && (
                <p className="text-xs text-zinc-500 mt-1">Estimativa total: <b className="text-zinc-200">{brl(totalEstimado)}</b> (preço de venda — não custo).</p>
              )}
            </div>
            {draft && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-8 bg-zinc-900 border-zinc-700 hover:bg-zinc-800" onClick={dismiss}>
                  <XIcon className="w-3 h-3 mr-2" /> Descartar
                </Button>
                <Button size="sm" className="h-8 bg-emerald-600 hover:bg-emerald-700" onClick={approve}>
                  <Check className="w-3 h-3 mr-2" /> Aprovar e cotar
                </Button>
              </div>
            )}
          </div>

          {items.length > 0 && (
            <div className="divide-y divide-zinc-800">
              {items.map(it => (
                <div key={it.id} className="p-4 grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
                  <div className="col-span-5">
                    <p className="text-sm text-zinc-100">
                      {it.product_name}{it.variant_name ? <span className="text-zinc-400"> ({it.variant_name})</span> : null}
                    </p>
                    <p className="text-xs text-zinc-500">
                      consumo médio: {it.avg_daily_consumption ? `${it.avg_daily_consumption}/dia` : 'sem histórico'}
                    </p>
                  </div>
                  <div className="col-span-2 text-xs"><p className="text-zinc-400">Em estoque</p><p className="font-mono text-rose-300 font-semibold">{it.current_stock}</p></div>
                  <div className="col-span-2 text-xs"><p className="text-zinc-400">Mínimo</p><p className="font-mono text-zinc-300">{it.threshold}</p></div>
                  <div className="col-span-1 text-xs"><p className="text-zinc-400">Cobertura</p><p className="font-mono text-amber-300">{it.days_of_cover != null ? `${it.days_of_cover} d` : '—'}</p></div>
                  <div className="col-span-2 text-right"><p className="text-xs text-zinc-400">Sugerido</p><p className="text-lg font-bold text-emerald-300">{it.suggested_qty}</p></div>
                </div>
              ))}
            </div>
          )}

          {/* Comparativo de cotações (Fase 2). */}
          {quotes.length > 0 && (
            <div className="border-t border-zinc-800">
              <div className="p-4">
                <p className="text-sm font-medium text-zinc-100 mb-2">Cotações dos fornecedores</p>
                <p className="text-xs text-zinc-500 mb-3">A IA está parseando as respostas dos fornecedores no WhatsApp em tempo real. O melhor preço entre os que responderam fica destacado.</p>
              </div>
              <div className="divide-y divide-zinc-800">
                {quotes.map(q => {
                  const isBest = bestQuote && q.id === bestQuote.id;
                  const isAccepted = q.status === 'accepted';
                  const isRejected = q.status === 'rejected';
                  const waiting = q.status === 'sent';
                  return (
                    <div key={q.id} className={`p-4 ${isAccepted ? 'bg-emerald-500/5' : isBest ? 'bg-indigo-500/5' : ''} ${isRejected ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-zinc-100 flex items-center gap-2">
                            <Truck className="w-4 h-4 text-indigo-400" /> {q.supplier_name}
                            {isAccepted && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">Vencedor</span>}
                            {!isAccepted && isBest && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-indigo-500/20 text-indigo-300 flex items-center gap-1"><Trophy className="w-2.5 h-2.5" /> Melhor preço</span>}
                            {q.from_network ? <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 flex items-center gap-1"><Globe className="w-2.5 h-2.5" /> Rede ZappFlow</span> : null}
                            {waiting && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-zinc-700 text-zinc-300">Aguardando resposta</span>}
                            {isRejected && <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-zinc-800 text-zinc-500">Não escolhido</span>}
                          </p>
                          <p className="text-xs text-zinc-500 mt-0.5">
                            {q.total_amount != null ? <>Total: <b className="text-zinc-200">{brl(q.total_amount)}</b></> : 'sem total ainda'}
                            {q.delivery_days != null && <> · entrega em <b className="text-zinc-200">{q.delivery_days} dia(s)</b></>}
                          </p>
                        </div>
                        {!isAccepted && !isRejected && q.status === 'answered' && (
                          <Button size="sm" className="h-8 bg-emerald-600 hover:bg-emerald-700" onClick={() => acceptQuote(q.id)}>
                            <Check className="w-3 h-3 mr-2" /> Confirmar com {q.supplier_name.split(' ')[0]}
                          </Button>
                        )}
                      </div>
                      {q.items.length > 0 && (
                        <div className="mt-3 grid grid-cols-12 text-xs text-zinc-400">
                          {q.items.map(it => (
                            <React.Fragment key={it.id}>
                              <div className="col-span-6 py-1 text-zinc-300">{it.product_name}</div>
                              <div className="col-span-2 py-1 text-right">{brl(it.unit_price)}</div>
                              <div className="col-span-2 py-1 text-right">{it.available_qty != null ? `${it.available_qty} disp.` : '—'}</div>
                              <div className="col-span-2 py-1 text-right text-zinc-200">{brl(it.line_total)}</div>
                            </React.Fragment>
                          ))}
                        </div>
                      )}
                      {q.notes && <p className="text-xs text-zinc-500 mt-2">📝 {q.notes}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="p-3 text-[11px] text-zinc-500 border-t border-zinc-800">
            Sugestão = maior valor entre <i>repor até o mínimo</i> e <i>cobrir os próximos {settings?.targetDays ?? 14} dias</i> de consumo médio.
            Ao aprovar, a IA dispara a cotação automaticamente nos fornecedores via WhatsApp E nos fornecedores da rede ZappFlow.
          </div>
        </div>
      )}
      </>)}

      {/* ===== ABA: BUSCAR NA REDE (emergência) ===== */}
      {tab === 'rede' && (
        <div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 mb-4">
            <p className="text-sm font-medium text-zinc-100 mb-1 flex items-center gap-2">
              <Globe className="w-4 h-4 text-indigo-400" /> Encontre fornecedores na rede ZappFlow
            </p>
            <p className="text-xs text-zinc-500 mb-3">Útil para emergências ("acabou o gás", "preciso de toalha agora"). Só aparece quem se ofereceu como fornecedor na rede.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input placeholder="Buscar nome/categoria/cidade…" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                value={search.q} onChange={e => setSearch({ ...search, q: e.target.value })} onKeyDown={e => e.key === 'Enter' && runSearch()} />
              <input placeholder="Categoria (ex.: hortifruti)" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                value={search.category} onChange={e => setSearch({ ...search, category: e.target.value })} onKeyDown={e => e.key === 'Enter' && runSearch()} />
              <input placeholder="Distância máxima (km)" type="number" className="bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                value={search.maxKm} onChange={e => setSearch({ ...search, maxKm: e.target.value })} onKeyDown={e => e.key === 'Enter' && runSearch()} />
            </div>
            <div className="mt-3 flex justify-end">
              <Button size="sm" onClick={runSearch}><Search className="w-3 h-3 mr-2" /> Buscar</Button>
            </div>
          </div>

          {searchResults.length === 0 ? (
            <p className="text-sm text-zinc-500">Nenhum fornecedor encontrado nesta busca. Quando mais orgs ligarem "Ser fornecedor", aparece mais gente aqui.</p>
          ) : (
            <div className="space-y-2">
              {searchResults.map(s => (
                <div key={s.orgId} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm text-zinc-100 flex items-center gap-2"><Truck className="w-4 h-4 text-indigo-400" /> {s.name}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {s.categories || 'sem categoria'}
                      {s.city && <> · <MapPin className="inline w-3 h-3" /> {s.city}{s.state ? `/${s.state}` : ''}</>}
                      {s.distanceKm != null && <> · <b className="text-zinc-200">{s.distanceKm} km</b></>}
                      {s.minOrderAmount > 0 && <> · pedido mín. {brl(s.minOrderAmount)}</>}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== ABA: PEDIDOS RECEBIDOS (inbox como fornecedor) ===== */}
      {tab === 'recebidos' && (
        <div>
          {incoming.length === 0 ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
              <p className="text-zinc-300 font-medium">Sem pedidos por enquanto</p>
              <p className="text-xs text-zinc-500 mt-1">Quando alguém da rede ZappFlow precisar de algo que você oferece, a cotação aparece aqui.</p>
              <p className="text-xs text-zinc-500 mt-3">Não está aparecendo no marketplace? Vá em <b>Ser fornecedor</b> e ative.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {incoming.map((q: IncomingQuote) => <IncomingQuoteCard key={q.id} quote={q} onAnswer={answerIncoming} />)}
            </div>
          )}
        </div>
      )}

      {/* ===== ABA: PERFIL DE FORNECEDOR ===== */}
      {tab === 'perfil' && profile && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-medium text-zinc-100">🌐 Aparecer como fornecedor na rede ZappFlow</p>
              <p className="text-xs text-zinc-500 mt-0.5">Quando ativado, outras orgs te encontram pelos filtros de categoria e distância. Preço/estoque ficam visíveis só ao receber uma cotação.</p>
            </div>
            <button onClick={() => saveProfile({ enabled: !profile.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${profile.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${profile.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-zinc-400">Cidade
              <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                defaultValue={profile.city}
                onBlur={e => e.target.value !== profile.city && saveProfile({ city: e.target.value })} />
            </label>
            <label className="text-xs text-zinc-400">UF
              <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" maxLength={2}
                defaultValue={profile.state}
                onBlur={e => e.target.value !== profile.state && saveProfile({ state: e.target.value.toUpperCase() })} />
            </label>
            <label className="text-xs text-zinc-400">Categorias atendidas (CSV)
              <input className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" placeholder="hortifruti, bebidas, limpeza"
                defaultValue={profile.categories}
                onBlur={e => e.target.value !== profile.categories && saveProfile({ categories: e.target.value })} />
            </label>
            <label className="text-xs text-zinc-400">Raio de entrega (km)
              <input type="number" min={1} className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                defaultValue={profile.radiusKm}
                onBlur={e => Number(e.target.value) !== profile.radiusKm && saveProfile({ radiusKm: Number(e.target.value) })} />
            </label>
            <label className="text-xs text-zinc-400">Pedido mínimo (R$)
              <input type="number" min={0} step="0.01" className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100"
                defaultValue={profile.minOrderAmount}
                onBlur={e => Number(e.target.value) !== profile.minOrderAmount && saveProfile({ minOrderAmount: Number(e.target.value) })} />
            </label>
          </div>

          {profile.lat != null && profile.lng != null && (
            <p className="mt-3 text-[11px] text-zinc-500">📍 Geocodado: {profile.lat.toFixed(3)}, {profile.lng.toFixed(3)} (usado para o cálculo de distância).</p>
          )}
          {profile.enabled && (!profile.city || !profile.categories) && (
            <p className="mt-3 text-xs text-amber-400">⚠️ Preencha cidade e categorias para aparecer nas buscas.</p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

/** Card para o fornecedor preencher preço/disponibilidade e enviar a resposta. */
const IncomingQuoteCard: React.FC<{ quote: IncomingQuote; onAnswer: (id: string, payload: any) => void }> = ({ quote, onAnswer }) => {
  type ItemState = { id: string; product_name: string; unitPrice: string; availableQty: string };
  const [items, setItems] = useState<ItemState[]>(quote.items.map(it => ({
    id: it.id, product_name: it.product_name,
    unitPrice: it.unit_price != null ? String(it.unit_price) : '',
    availableQty: it.available_qty != null ? String(it.available_qty) : '',
  })));
  const [deliveryDays, setDeliveryDays] = useState<string>(quote.delivery_days != null ? String(quote.delivery_days) : '');
  const [notes, setNotes] = useState<string>('');

  const submit = () => {
    onAnswer(quote.id, {
      deliveryDays: deliveryDays ? Number(deliveryDays) : null,
      notes: notes || null,
      items: items.map(i => ({
        id: i.id,
        unitPrice: i.unitPrice ? Number(i.unitPrice) : null,
        availableQty: i.availableQty ? Number(i.availableQty) : null,
      })),
    });
  };

  const answered = quote.status === 'answered' || quote.status === 'accepted';
  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 ${quote.status === 'accepted' ? 'border-emerald-700/50' : ''}`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm text-zinc-100">
            {quote.buyer_name}{quote.buyer_city ? ` · ${quote.buyer_city}` : ''}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">recebido {new Date(quote.sent_at).toLocaleString('pt-BR')}</p>
        </div>
        {quote.status === 'accepted' && <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">PEDIDO FECHADO</span>}
        {answered && quote.status !== 'accepted' && <span className="text-xs font-bold px-2 py-0.5 rounded bg-zinc-700 text-zinc-300">RESPOSTA ENVIADA</span>}
      </div>

      <div className="divide-y divide-zinc-800">
        {items.map((it, idx) => (
          <div key={it.id} className="py-2 grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
            <div className="col-span-6 text-sm text-zinc-200">{it.product_name}</div>
            <input type="number" min={0} step="0.01" placeholder="Preço unit. (R$)"
              className="col-span-3 bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100"
              value={it.unitPrice} disabled={answered}
              onChange={e => setItems(items.map((x, i) => i === idx ? { ...x, unitPrice: e.target.value } : x))} />
            <input type="number" min={0} placeholder="Estoque"
              className="col-span-3 bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100"
              value={it.availableQty} disabled={answered}
              onChange={e => setItems(items.map((x, i) => i === idx ? { ...x, availableQty: e.target.value } : x))} />
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-12 gap-2 items-center">
        <input type="number" min={0} placeholder="Prazo de entrega (dias)"
          className="col-span-4 bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100"
          value={deliveryDays} disabled={answered}
          onChange={e => setDeliveryDays(e.target.value)} />
        <input placeholder="Observação (opcional)"
          className="col-span-5 bg-zinc-950 border border-zinc-800 rounded p-1.5 text-xs text-zinc-100"
          value={notes} disabled={answered}
          onChange={e => setNotes(e.target.value)} />
        <div className="col-span-3 text-right">
          {!answered && (
            <Button size="sm" className="h-8 bg-emerald-600 hover:bg-emerald-700" onClick={submit}>
              <Check className="w-3 h-3 mr-2" /> Enviar resposta
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
