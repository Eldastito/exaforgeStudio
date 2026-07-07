import { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { Sparkles, Lightbulb, Frown, Send, Trash2, RefreshCw, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

// Escuta Ativa = Radar de Oportunidades Disfarçadas (mercado te fala via
// reclamações/cancelamentos/faltas/gaps) + Journal de Frustrações (você fala
// pra si). Juntos, formam a camada de escuta que Carlos Domingos ensina:
// problema é sinal, não fim.

interface Opportunity {
  id: string;
  category: 'stock_out' | 'product_gap' | 'service_complaint' | 'cancellation_reason' | 'delay_pattern';
  title: string;
  description: string;
  suggestedAction: string;
  evidenceCount: number;
  sampleEvidences: any[];
  status: 'new' | 'acknowledged' | 'in_progress' | 'implemented' | 'dismissed';
  lastSeenAt: string | null;
}

interface Frustration {
  id: string;
  text: string;
  category: string;
  createdAt: string;
}

const CATEGORY_LABEL: Record<string, { emoji: string; label: string; color: string }> = {
  stock_out: { emoji: '📦', label: 'Reposição frequente', color: 'text-orange-300 border-orange-500/30 bg-orange-500/10' },
  product_gap: { emoji: '🔍', label: 'Produto pedido que não temos', color: 'text-purple-300 border-purple-500/30 bg-purple-500/10' },
  service_complaint: { emoji: '⚠️', label: 'Reclamação recorrente', color: 'text-red-300 border-red-500/30 bg-red-500/10' },
  cancellation_reason: { emoji: '↩️', label: 'Cancelamentos', color: 'text-rose-300 border-rose-500/30 bg-rose-500/10' },
  delay_pattern: { emoji: '⏱️', label: 'Padrão de demora', color: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
};
const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  new: { label: 'Novo', color: 'bg-blue-500/20 text-blue-300 border-blue-500/40' },
  acknowledged: { label: 'Vi', color: 'bg-slate-500/20 text-slate-300 border-slate-500/40' },
  in_progress: { label: 'Em andamento', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  implemented: { label: 'Implementado', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  dismissed: { label: 'Descartado', color: 'bg-zinc-700/40 text-zinc-500 border-zinc-600/40' },
};
const FRUST_CATEGORY_LABEL: Record<string, string> = {
  operacional: '⚙️ Operacional', ferramenta: '🛠️ Ferramenta', pessoas: '👥 Pessoas',
  processo: '📋 Processo', financeiro: '💰 Financeiro', cliente: '🙋 Cliente', outro: '❓ Outro',
};

export function EscutaView() {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [frusts, setFrusts] = useState<Frustration[]>([]);
  const [digest, setDigest] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [frustText, setFrustText] = useState('');
  const [saving, setSaving] = useState(false);
  const [filterOpps, setFilterOpps] = useState<'active' | 'all'>('active');

  const load = async () => {
    try {
      const [o, f] = await Promise.all([
        apiFetch('/api/opportunities').then((r) => r.json()),
        apiFetch('/api/frustrations').then((r) => r.json()),
      ]);
      setOpps(Array.isArray(o?.opportunities) ? o.opportunities : []);
      setFrusts(Array.isArray(f?.frustrations) ? f.frustrations : []);
      setDigest(f?.digest || null);
    } catch { /* silent */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await apiFetch('/api/opportunities/scan', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao scan.'); return; }
      toast.success(`Radar rodou. ${Array.isArray(d.opportunities) ? d.opportunities.length : 0} oportunidades ativas.`);
      load();
    } catch { toast.error('Falha ao scan.'); }
    finally { setScanning(false); }
  };

  const setStatus = async (id: string, status: string) => {
    try {
      await apiFetch(`/api/opportunities/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      setOpps((prev) => prev.map((o) => o.id === id ? { ...o, status: status as any } : o));
    } catch { /* silent */ }
  };

  const addFrustration = async () => {
    const text = frustText.trim();
    if (!text) return;
    setSaving(true);
    try {
      const res = await apiFetch('/api/frustrations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Falha ao registrar.'); return; }
      setFrusts((p) => [d, ...p]);
      setFrustText('');
      toast.success('Registrado. Bora ver se vira padrão.');
      load(); // refresh digest
    } catch { toast.error('Falha ao registrar.'); }
    finally { setSaving(false); }
  };

  const deleteFrustration = async (id: string) => {
    try {
      await apiFetch(`/api/frustrations/${id}`, { method: 'DELETE' });
      setFrusts((p) => p.filter((f) => f.id !== id));
    } catch { /* silent */ }
  };

  const visibleOpps = filterOpps === 'active'
    ? opps.filter((o) => o.status === 'new' || o.status === 'acknowledged' || o.status === 'in_progress')
    : opps;

  if (loading) {
    return <div className="flex-1 flex items-center justify-center bg-zinc-950 text-zinc-400"><Loader2 className="w-6 h-6 animate-spin" /></div>;
  }

  return (
    <div className="flex-1 overflow-auto bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="border-b border-zinc-800 pb-4">
          <h1 className="text-2xl font-bold flex items-center gap-2">🎧 Escuta Ativa</h1>
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
            Problema é sinal, não fim. Toda reclamação, cancelamento, falta ou irritação é o mercado (e você) gritando o que precisa mudar. Aqui a gente <b>captura, agrupa e transforma</b> essas pistas em oportunidade.
          </p>
          <p className="text-xs text-zinc-500 italic mt-2">
            "Enxergar oportunidades disfarçadas é o que separa negócios que sobem dos que travam." — Carlos Domingos
          </p>
        </div>

        {/* Radar de Oportunidades */}
        <section className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-lg font-semibold flex items-center gap-2"><Lightbulb className="w-5 h-5 text-amber-400" /> Radar de Oportunidades Disfarçadas</h2>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
                <button onClick={() => setFilterOpps('active')} className={`text-xs px-2.5 py-1 rounded ${filterOpps === 'active' ? 'bg-indigo-600 text-white' : 'text-zinc-400'}`}>Ativas</button>
                <button onClick={() => setFilterOpps('all')} className={`text-xs px-2.5 py-1 rounded ${filterOpps === 'all' ? 'bg-indigo-600 text-white' : 'text-zinc-400'}`}>Todas</button>
              </div>
              <button onClick={runScan} disabled={scanning}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50">
                {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Rodar radar agora
              </button>
            </div>
          </div>

          {visibleOpps.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center">
              <p className="text-sm text-zinc-400">Nenhuma oportunidade ativa. Clique em <b>Rodar radar agora</b> para varrer os últimos 30 dias.</p>
              <p className="text-xs text-zinc-500 mt-1">O radar também roda sozinho toda semana.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleOpps.map((o) => {
                const cat = CATEGORY_LABEL[o.category] || { emoji: '💡', label: o.category, color: 'text-zinc-300 border-zinc-700 bg-zinc-800/50' };
                const st = STATUS_LABEL[o.status] || STATUS_LABEL.new;
                const isExp = expanded === o.id;
                return (
                  <div key={o.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                    <button onClick={() => setExpanded(isExp ? null : o.id)} className="w-full p-4 text-left hover:bg-zinc-900/60 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className="text-2xl">{cat.emoji}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${cat.color}`}>{cat.label}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${st.color}`}>{st.label}</span>
                            <span className="text-xs text-zinc-500">{o.evidenceCount} evidência(s)</span>
                          </div>
                          <h3 className="font-semibold text-zinc-100">{o.title}</h3>
                          <p className="text-sm text-zinc-400 mt-1">{o.description}</p>
                        </div>
                        {isExp ? <ChevronDown className="w-4 h-4 text-zinc-500 mt-1" /> : <ChevronRight className="w-4 h-4 text-zinc-500 mt-1" />}
                      </div>
                    </button>
                    {isExp && (
                      <div className="border-t border-zinc-800 p-4 space-y-3 bg-zinc-950/40">
                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                          <p className="text-xs text-emerald-400 font-semibold uppercase tracking-wide mb-1">💡 Ação sugerida</p>
                          <p className="text-sm text-zinc-200">{o.suggestedAction}</p>
                        </div>
                        {o.sampleEvidences.length > 0 && (
                          <div>
                            <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Evidências ({o.sampleEvidences.length})</p>
                            <div className="space-y-1.5">
                              {o.sampleEvidences.map((ev: any, i: number) => (
                                <div key={i} className="text-xs text-zinc-300 bg-zinc-900/60 border border-zinc-800 rounded p-2">
                                  <pre className="whitespace-pre-wrap break-words font-sans">{JSON.stringify(ev, null, 2)}</pre>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-2 flex-wrap pt-1">
                          {o.status !== 'acknowledged' && <button onClick={() => setStatus(o.id, 'acknowledged')} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-400">👁 Já vi</button>}
                          {o.status !== 'in_progress' && <button onClick={() => setStatus(o.id, 'in_progress')} className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-600 text-amber-300 hover:border-amber-400">🔨 Tô em cima</button>}
                          {o.status !== 'implemented' && <button onClick={() => setStatus(o.id, 'implemented')} className="text-xs px-2.5 py-1.5 rounded-lg border border-emerald-600 text-emerald-300 hover:border-emerald-400">✅ Implementei</button>}
                          {o.status !== 'dismissed' && <button onClick={() => setStatus(o.id, 'dismissed')} className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-500 hover:border-zinc-500">✗ Descartar</button>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Journal de Frustrações */}
        <section className="space-y-3 border-t border-zinc-800 pt-6">
          <h2 className="text-lg font-semibold flex items-center gap-2"><Frown className="w-5 h-5 text-rose-400" /> Journal de Frustrações do Dono</h2>
          <p className="text-sm text-zinc-400 -mt-1">
            Muitos negócios (Nike, Post-it, Airbnb) nasceram da <b>irritação</b> do fundador. O problema é que a gente esquece antes de aproveitar. Registre aqui em 10 segundos.
          </p>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-2">
            <textarea rows={2} placeholder="Algo te irritou hoje no negócio? (10 segundos, sem filtro)"
              value={frustText} onChange={(e) => setFrustText(e.target.value.slice(0, 2000))}
              className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 outline-none focus:border-zinc-600 resize-none" />
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-500">{frustText.length}/2000 · categorização automática</p>
              <button onClick={addFrustration} disabled={saving || !frustText.trim()}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50">
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} Registrar
              </button>
            </div>
          </div>

          {digest && digest.total >= 3 && digest.topCategory && (
            <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3">
              <p className="text-xs text-purple-400 font-semibold uppercase tracking-wide mb-1"><Sparkles className="w-3 h-3 inline mr-1" /> Padrão dos últimos 30 dias</p>
              <p className="text-sm text-zinc-200">
                Você registrou <b>{digest.topCount}</b> frustração(ões) em <b>{FRUST_CATEGORY_LABEL[digest.topCategory] || digest.topCategory}</b>. Esse é o tema que mais gasta sua energia — é onde procurar melhoria, automação, delegação ou mudança.
              </p>
            </div>
          )}

          {frusts.length === 0 ? (
            <p className="text-xs text-zinc-500 italic p-3">Nenhum registro ainda. Comece pela última coisa que te tirou do sério.</p>
          ) : (
            <div className="space-y-1.5">
              {frusts.slice(0, 30).map((f) => (
                <div key={f.id} className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs px-2 py-0.5 rounded-full border border-zinc-700 text-zinc-400">{FRUST_CATEGORY_LABEL[f.category] || f.category}</span>
                      <span className="text-xs text-zinc-500">{new Date(f.createdAt.replace(' ', 'T') + (f.createdAt.includes('Z') ? '' : 'Z')).toLocaleString('pt-BR')}</span>
                    </div>
                    <p className="text-sm text-zinc-200 whitespace-pre-wrap">{f.text}</p>
                  </div>
                  <button onClick={() => deleteFrustration(f.id)} className="text-zinc-600 hover:text-red-400 shrink-0"><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
