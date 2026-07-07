import { useEffect, useState } from 'react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { Sparkles, Lightbulb, Frown, Send, Trash2, RefreshCw, ChevronDown, ChevronRight, Loader2, Heart, Copy } from 'lucide-react';

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

interface RecoveryEvent {
  id: string;
  contactId: string | null;
  triggerType: string;
  triggerContext: any;
  playbookText: string;
  status: string;
  createdAt: string;
}
const TRIGGER_LABEL: Record<string, { emoji: string; label: string }> = {
  order_cancelled: { emoji: '↩️', label: 'Pedido cancelado' },
  pix_expired: { emoji: '⏰', label: 'PIX venceu' },
  complaint_detected: { emoji: '⚠️', label: 'Reclamação' },
  delay_detected: { emoji: '⏱️', label: 'Demora mencionada' },
  delivery_delayed: { emoji: '📦', label: 'Entrega atrasou' },
};
const RECOVERY_STATUS: Record<string, { label: string; color: string }> = {
  triggered: { label: 'Precisa recuperação', color: 'bg-red-500/20 text-red-300 border-red-500/40' },
  playbook_sent: { label: 'Playbook enviado', color: 'bg-amber-500/20 text-amber-300 border-amber-500/40' },
  resolved_positive: { label: 'Recuperado ✨', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' },
  resolved_neutral: { label: 'Encerrado neutro', color: 'bg-slate-500/20 text-slate-300 border-slate-500/40' },
  escalated_human: { label: 'Escalado', color: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
  dismissed: { label: 'Descartado', color: 'bg-zinc-700/40 text-zinc-500 border-zinc-600/40' },
};

export function EscutaView() {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [frusts, setFrusts] = useState<Frustration[]>([]);
  const [recoveries, setRecoveries] = useState<RecoveryEvent[]>([]);
  const [recoveryMetrics, setRecoveryMetrics] = useState<any>(null);
  const [digest, setDigest] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedRecovery, setExpandedRecovery] = useState<string | null>(null);
  const [frustText, setFrustText] = useState('');
  const [saving, setSaving] = useState(false);
  const [filterOpps, setFilterOpps] = useState<'active' | 'all'>('active');
  const [filterRecovery, setFilterRecovery] = useState<'active' | 'all'>('active');

  const load = async () => {
    try {
      const [o, f, r] = await Promise.all([
        apiFetch('/api/opportunities').then((x) => x.json()),
        apiFetch('/api/frustrations').then((x) => x.json()),
        apiFetch(`/api/recovery?status=${filterRecovery}`).then((x) => x.json()),
      ]);
      setOpps(Array.isArray(o?.opportunities) ? o.opportunities : []);
      setFrusts(Array.isArray(f?.frustrations) ? f.frustrations : []);
      setDigest(f?.digest || null);
      setRecoveries(Array.isArray(r?.events) ? r.events : []);
      setRecoveryMetrics(r?.metrics || null);
    } catch { /* silent */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterRecovery]);

  const setRecoveryStatus = async (id: string, status: string) => {
    try {
      const res = await apiFetch(`/api/recovery/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      if (!res.ok) { toast.error('Falha ao atualizar.'); return; }
      setRecoveries((prev) => prev.map((r) => r.id === id ? { ...r, status } : r));
      load();
    } catch { /* silent */ }
  };

  const copyPlaybook = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('Playbook copiado. Ajuste antes de enviar.'); } catch { /* silent */ }
  };

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

        {/* Radar de Recuperação (Disney) */}
        <section className="space-y-3 border-t border-zinc-800 pt-6">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2"><Heart className="w-5 h-5 text-pink-400" /> Radar de Recuperação</h2>
              <p className="text-xs text-zinc-500 mt-1 italic">"A recuperação é o momento memorável — não a falha." — Disney Institute</p>
            </div>
            <div className="flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
              <button onClick={() => setFilterRecovery('active')} className={`text-xs px-2.5 py-1 rounded ${filterRecovery === 'active' ? 'bg-indigo-600 text-white' : 'text-zinc-400'}`}>Pendentes</button>
              <button onClick={() => setFilterRecovery('all')} className={`text-xs px-2.5 py-1 rounded ${filterRecovery === 'all' ? 'bg-indigo-600 text-white' : 'text-zinc-400'}`}>Todos</button>
            </div>
          </div>

          {recoveryMetrics && recoveryMetrics.total > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
                <div className="text-xs text-zinc-500">Eventos (30d)</div>
                <div className="text-lg font-semibold text-zinc-100">{recoveryMetrics.total}</div>
              </div>
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
                <div className="text-xs text-zinc-500">Recuperados</div>
                <div className="text-lg font-semibold text-emerald-300">{recoveryMetrics.recovered}</div>
              </div>
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
                <div className="text-xs text-zinc-500">Taxa de recuperação</div>
                <div className="text-lg font-semibold text-zinc-100">{recoveryMetrics.recoveryRate != null ? `${Math.round(recoveryMetrics.recoveryRate * 100)}%` : '—'}</div>
              </div>
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
                <div className="text-xs text-zinc-500">Tempo médio (h)</div>
                <div className="text-lg font-semibold text-zinc-100">{recoveryMetrics.avgResolutionHours != null ? recoveryMetrics.avgResolutionHours : '—'}</div>
              </div>
            </div>
          )}

          {recoveries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center">
              <p className="text-sm text-zinc-400">Nenhum evento de recuperação pendente. 🎉</p>
              <p className="text-xs text-zinc-500 mt-1">Quando um pedido cancelar, um PIX vencer ou uma reclamação for detectada, um playbook aparece aqui — pronto para você reagir.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {recoveries.map((r) => {
                const trig = TRIGGER_LABEL[r.triggerType] || { emoji: '❓', label: r.triggerType };
                const st = RECOVERY_STATUS[r.status] || RECOVERY_STATUS.triggered;
                const isExp = expandedRecovery === r.id;
                const ago = (() => {
                  try {
                    const t = new Date(r.createdAt.replace(' ', 'T') + (r.createdAt.includes('Z') ? '' : 'Z')).getTime();
                    const s = Math.round((Date.now() - t) / 1000);
                    if (s < 60) return `${s}s atrás`; if (s < 3600) return `${Math.floor(s / 60)}min atrás`;
                    if (s < 86400) return `${Math.floor(s / 3600)}h atrás`; return `${Math.floor(s / 86400)}d atrás`;
                  } catch { return r.createdAt; }
                })();
                return (
                  <div key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                    <button onClick={() => setExpandedRecovery(isExp ? null : r.id)} className="w-full p-4 text-left hover:bg-zinc-900/60 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className="text-2xl">{trig.emoji}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className="text-xs px-2 py-0.5 rounded-full border border-pink-500/30 bg-pink-500/10 text-pink-300">{trig.label}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full border ${st.color}`}>{st.label}</span>
                            <span className="text-xs text-zinc-500">{ago}</span>
                          </div>
                          <h3 className="font-medium text-zinc-100">{r.triggerContext?.contactName || 'Cliente'}{r.triggerContext?.snippet ? ` — "${String(r.triggerContext.snippet).slice(0, 80)}${r.triggerContext.snippet.length > 80 ? '…' : ''}"` : ''}</h3>
                        </div>
                        {isExp ? <ChevronDown className="w-4 h-4 text-zinc-500 mt-1" /> : <ChevronRight className="w-4 h-4 text-zinc-500 mt-1" />}
                      </div>
                    </button>
                    {isExp && (
                      <div className="border-t border-zinc-800 p-4 space-y-3 bg-zinc-950/40">
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs text-pink-400 font-semibold uppercase tracking-wide">💌 Playbook Disney sugerido</p>
                            <button onClick={() => copyPlaybook(r.playbookText)} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100"><Copy className="w-3 h-3" /> Copiar</button>
                          </div>
                          <pre className="text-sm bg-zinc-950 border border-zinc-800 rounded p-3 text-zinc-200 whitespace-pre-wrap font-sans max-h-96 overflow-auto">{r.playbookText}</pre>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap pt-1">
                          {r.status !== 'playbook_sent' && r.status !== 'resolved_positive' && r.status !== 'resolved_neutral' && (
                            <button onClick={() => setRecoveryStatus(r.id, 'playbook_sent')} className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-600 text-amber-300 hover:border-amber-400">💌 Enviei o playbook</button>
                          )}
                          {r.status !== 'resolved_positive' && (
                            <button onClick={() => setRecoveryStatus(r.id, 'resolved_positive')} className="text-xs px-2.5 py-1.5 rounded-lg border border-emerald-600 text-emerald-300 hover:border-emerald-400">✨ Cliente recuperado</button>
                          )}
                          {r.status !== 'resolved_neutral' && (
                            <button onClick={() => setRecoveryStatus(r.id, 'resolved_neutral')} className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:border-slate-400">Encerrar neutro</button>
                          )}
                          {r.status !== 'escalated_human' && (
                            <button onClick={() => setRecoveryStatus(r.id, 'escalated_human')} className="text-xs px-2.5 py-1.5 rounded-lg border border-purple-600 text-purple-300 hover:border-purple-400">⚡ Escalar</button>
                          )}
                          {r.status !== 'dismissed' && (
                            <button onClick={() => setRecoveryStatus(r.id, 'dismissed')} className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-700 text-zinc-500 hover:border-zinc-500">✗ Descartar</button>
                          )}
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
