import { useCallback, useEffect, useState } from 'react';
import { HeartPulse, Loader2, ArrowRight, TrendingUp, Wallet, AlertTriangle, Check, Target, X, Sparkles, GraduationCap, ClipboardList, Circle, MessageCircle, Send, ChevronDown } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';
import { useStore } from '@/src/store/useStore';
import type { ViewMode } from '@/src/store/useStore';

// Central de Saúde e Decisão (ADR-126 Fatia 1) — a tela-síntese: status geral +
// as 3 prioridades do dia com impacto em R$ e uma ação. Global (todas as verticais).

const brl = (n: any) => `R$ ${Number(n || 0).toFixed(2).replace('.', ',')}`;

const STATUS_UI: Record<string, { label: string; cls: string; bar: string }> = {
  saudavel: { label: 'Saudável', cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/5', bar: 'bg-emerald-500' },
  atencao: { label: 'Atenção', cls: 'text-sky-300 border-sky-500/40 bg-sky-500/5', bar: 'bg-sky-500' },
  risco: { label: 'Risco', cls: 'text-amber-300 border-amber-500/40 bg-amber-500/5', bar: 'bg-amber-500' },
  critico: { label: 'Crítico', cls: 'text-red-300 border-red-500/40 bg-red-500/5', bar: 'bg-red-500' },
};

export function HealthCenterView() {
  const [d, setD] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const setViewMode = useStore((s) => s.setViewMode);

  const [idx, setIdx] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'tutor' | 'gestor'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('healthMode') === 'gestor' ? 'gestor' : 'tutor'));
  const setModePersist = (m: 'tutor' | 'gestor') => { setMode(m); try { localStorage.setItem('healthMode', m); } catch { /* noop */ } };
  const load = useCallback(() => {
    setLoading(true);
    apiFetch('/api/health-center').then((r) => r.json()).then((x: any) => setD(x)).catch(() => {}).finally(() => setLoading(false));
    apiFetch('/api/health-center/survival-index').then((r) => r.json()).then((x: any) => { if (typeof x?.score === 'number') setIdx(x); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const aplicar = async (p: any) => {
    setBusy(true);
    try {
      const r = await apiFetch('/api/health-center/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: p.source, title: p.title, impact: p.impact, rationale: p.interpretacao }) });
      if (r.ok) { toast.success('No plano. Quando executar, registre o resultado.'); load(); } else toast.error('Não consegui aplicar.');
    } catch { toast.error('Falha ao aplicar.'); } finally { setBusy(false); }
  };
  const concluir = async (a: any) => {
    const v = window.prompt(`Quanto essa ação trouxe de fato? (esperado ${brl(a.expected_impact)})`, String(a.expected_impact));
    if (v == null) return;
    setBusy(true);
    try { const r = await apiFetch(`/api/cash/actions/${a.id}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resultAmount: Number(v.replace(',', '.')) || 0 }) }); if (r.ok) { toast.success('Resultado registrado.'); load(); } }
    finally { setBusy(false); }
  };
  const dispensar = async (a: any) => { setBusy(true); try { const r = await apiFetch(`/api/cash/actions/${a.id}/dismiss`, { method: 'POST' }); if (r.ok) { toast.success('Dispensada.'); load(); } } finally { setBusy(false); } };

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Analisando seu negócio…</div>;
  const st = STATUS_UI[d?.status] || STATUS_UI.saudavel;

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/30 p-2.5"><HeartPulse className="w-6 h-6 text-indigo-300" /></div>
            <div>
              <h2 className="text-lg font-semibold text-zinc-100">Central de Saúde</h2>
              <p className="text-sm text-zinc-400">O que mudou, por que importa e o que fazer primeiro — no máximo 3 prioridades por dia.</p>
            </div>
          </div>
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 text-[11px] shrink-0">
            <button onClick={() => setModePersist('tutor')} className={`inline-flex items-center gap-1 rounded px-2 py-1 ${mode === 'tutor' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}><GraduationCap className="w-3.5 h-3.5" /> Tutor</button>
            <button onClick={() => setModePersist('gestor')} className={`inline-flex items-center gap-1 rounded px-2 py-1 ${mode === 'gestor' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>Gestor</button>
          </div>
        </div>

        {/* Status geral + síntese */}
        <div className={`rounded-xl border p-4 ${st.cls}`}>
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${st.bar}`} />
            <span className="text-sm font-semibold uppercase tracking-wide">{st.label}</span>
          </div>
          <p className="mt-1.5 text-[15px] text-zinc-100">{d?.synthesis}</p>
          {d?.triggers?.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {d.triggers.map((t: any, i: number) => (
                <li key={i} className="text-[12px] text-zinc-300/80 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />{t.label}</li>
              ))}
            </ul>
          )}
        </div>

        <TutorWhatsAppCard />

        {/* Índice de Sobrevivência (ADR-127) */}
        {idx && (() => {
          const f = STATUS_UI[idx.faixa] || STATUS_UI.atencao;
          const trend = idx.trend === 'subindo' ? '↑ subindo' : idx.trend === 'caindo' ? '↓ caindo' : idx.trend === 'estavel' ? '→ estável' : '';
          return (
            <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center gap-4">
                <div className="shrink-0 text-center">
                  <div className={`text-3xl font-bold ${f.cls.split(' ')[0]}`}>{Math.round(idx.score)}</div>
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500">de 100</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-zinc-100">Índice de Sobrevivência</span>
                    <span className={`text-[11px] rounded-full border px-2 py-0.5 ${f.cls}`}>{idx.faixaLabel}</span>
                    {trend && <span className="text-[11px] text-zinc-400">{trend}</span>}
                    <span className="text-[11px] text-zinc-500">· confiança {idx.confidence}</span>
                  </div>
                  <div className="mt-2 h-2 w-full rounded-full bg-zinc-800 overflow-hidden"><div className={`h-full ${f.bar}`} style={{ width: `${Math.round(idx.score)}%` }} /></div>
                  {idx.weakest?.length > 0 && <div className="mt-1.5 text-[11px] text-zinc-500">Puxando para baixo: {idx.weakest.join(' · ')}.</div>}
                  {idx.history?.length > 1 && (
                    <div className="mt-2 flex items-end gap-1 h-8" title="Histórico do índice">
                      {idx.history.map((h: any) => {
                        const hf = STATUS_UI[h.faixa] || STATUS_UI.atencao;
                        return <div key={h.period} className="flex-1 flex flex-col items-center justify-end h-full" title={`${h.period}: ${Math.round(h.score)}`}><div className={`w-full rounded-t ${hf.bar}`} style={{ height: `${Math.max(6, Math.round(h.score))}%` }} /><span className="text-[8px] text-zinc-600 mt-0.5">{h.period.slice(5)}</span></div>;
                      })}
                    </div>
                  )}
                  <p className="mt-1 text-[10px] text-zinc-600">Indicador orientativo — aponta fatores de risco, não prevê fechamento.</p>
                </div>
              </div>
              {mode === 'tutor' && (
                <div className="mt-3 grid sm:grid-cols-2 gap-1.5 border-t border-zinc-800 pt-3">
                  {idx.components.map((c: any) => (
                    <div key={c.key} className="flex items-center gap-2 text-[11px]">
                      <span className="w-28 shrink-0 text-zinc-400 truncate">{c.label}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden"><div className={`h-full ${c.hasData ? 'bg-indigo-500/70' : 'bg-zinc-600'}`} style={{ width: `${Math.round(c.score)}%` }} /></div>
                      <span className={`w-7 text-right ${c.hasData ? 'text-zinc-300' : 'text-zinc-600'}`}>{Math.round(c.score)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Narrativa do Diretor (modo Tutor) */}
        {mode === 'tutor' && d?.narrative && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-3">
            <Sparkles className="w-4 h-4 text-indigo-300 mt-0.5 shrink-0" />
            <p className="text-[13px] text-zinc-200">{d.narrative}</p>
          </div>
        )}

        {/* KPIs rápidos */}
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-[13px]">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500 flex items-center gap-1"><Wallet className="w-3 h-3" /> Caixa</div><div className="text-zinc-100 font-semibold mt-0.5">{brl(d?.kpis?.caixaAtual)}</div></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500">A receber</div><div className="text-amber-200 font-semibold mt-0.5">{brl(d?.kpis?.aReceber)}</div>{d?.kpis?.aReceberVencido > 0 && <div className="text-[10px] text-red-300 mt-0.5">{brl(d.kpis.aReceberVencido)} vencido</div>}</div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500">A pagar</div><div className="text-red-200 font-semibold mt-0.5">{brl(d?.kpis?.aPagar)}</div></div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-zinc-500">Dias de caixa</div><div className="text-zinc-100 font-semibold mt-0.5">{d?.kpis?.survivalDays != null ? `~${d.kpis.survivalDays}` : '—'}</div></div>
        </div>

        {/* Conversão de orçamentos (ADR-132 Fatia 2) */}
        {d?.conversao?.ratePct != null && (
          <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-[13px] flex items-center justify-between gap-2">
            <span className="text-zinc-400">Conversão de orçamentos <span className="text-[11px] text-zinc-600">({d.conversao.decided} decididos)</span></span>
            <span className="font-semibold">
              <span className={d.conversao.signal === 'caindo' ? 'text-red-300' : d.conversao.signal === 'subindo' ? 'text-emerald-300' : 'text-zinc-100'}>{d.conversao.ratePct}%</span>
              {d.conversao.prevRatePct != null && d.conversao.signal === 'caindo' && <span className="text-[11px] text-zinc-500"> (caiu de {d.conversao.prevRatePct}%)</span>}
              {d.conversao.prevRatePct != null && d.conversao.signal === 'subindo' && <span className="text-[11px] text-zinc-500"> (subiu de {d.conversao.prevRatePct}%)</span>}
            </span>
          </div>
        )}

        {/* Concentração no maior cliente (ADR-132 Fatia 3) */}
        {d?.concentracao?.topPct >= 40 && (
          <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 text-[13px] flex items-center justify-between gap-2">
            <span className="text-zinc-400">Concentração no maior cliente{d.concentracao.topName ? ` (${d.concentracao.topName})` : ''}</span>
            <span className="font-semibold text-amber-300">{d.concentracao.topPct}% da receita</span>
          </div>
        )}

        {/* Estoque parado sem giro (ADR-132 Fatia 4) */}
        {d?.estoque?.slowMoverCapital > 0 && (
          <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-[13px] flex items-center justify-between gap-2">
            <span className="text-zinc-400">Estoque parado sem giro{d.estoque.slowMoverCount > 0 ? ` (${d.estoque.slowMoverCount} item${d.estoque.slowMoverCount > 1 ? 's' : ''})` : ''}</span>
            <span className="font-semibold text-amber-300">{brl(d.estoque.slowMoverCapital)}{d.estoque.totalCapital > d.estoque.slowMoverCapital ? <span className="text-[11px] text-zinc-500"> de {brl(d.estoque.totalCapital)}</span> : null}</span>
          </div>
        )}

        {/* Prioridades do dia */}
        <div className="mt-5">
          <h3 className="text-sm font-medium text-zinc-200 mb-2 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-indigo-300" /> Prioridades de hoje</h3>
          {(!d?.priorities || d.priorities.length === 0) ? (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-[13px] text-emerald-200">Nenhuma prioridade urgente hoje. Continue cuidando do caixa e das vendas. 👊</div>
          ) : (
            <ol className="space-y-2">
              {d.priorities.map((p: any, i: number) => (
                <li key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="w-5 h-5 shrink-0 rounded-full bg-indigo-500/20 text-indigo-300 text-[11px] font-semibold flex items-center justify-center">{i + 1}</span>
                        <span className="text-[14px] font-medium text-zinc-100">{p.title}</span>
                      </div>
                      <div className="mt-1 text-[12px] text-zinc-400">{p.fato}</div>
                      <div className="mt-0.5 text-[12px] text-zinc-500">{p.interpretacao} <span className="text-amber-300/80">{p.risco}</span></div>
                      {mode === 'tutor' && p.howTo && <div className="mt-1 text-[12px] text-indigo-200/90 flex items-start gap-1"><GraduationCap className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70" />{p.howTo}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[15px] font-semibold text-indigo-200">{brl(p.impact)}</div>
                      <div className={`text-[10px] uppercase tracking-wide ${p.basis === 'fato' ? 'text-emerald-400/70' : 'text-zinc-500'}`}>{p.basis}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button onClick={() => setViewMode(p.action.view as ViewMode)} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] px-3 py-1.5">
                      {p.action.label} <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                    {p.inPlan ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300 border border-emerald-500/40 rounded-lg px-2 py-1"><Check className="w-3.5 h-3.5" /> no plano</span>
                    ) : (
                      <button disabled={busy} onClick={() => aplicar(p)} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 text-[12px] px-3 py-1.5 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Colocar no plano</button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        {/* Qualidade dos dados — quanto mais completo, mais confiável (ADR-126 Fatia 3) */}
        {d?.dataQuality && d.dataQuality.level !== 'alta' && (
          <div className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-medium text-amber-100 flex items-center gap-2"><ClipboardList className="w-4 h-4" /> Complete seus dados ({d.dataQuality.pct}%)</h3>
              <span className="text-[11px] text-amber-200/80">confiança do diagnóstico: {d.dataQuality.level}</span>
            </div>
            <p className="text-[11px] text-zinc-400 mb-2">Enquanto faltam dados, trate os números como estimativa. Cada item marcado deixa o diagnóstico mais preciso.</p>
            <div className="grid sm:grid-cols-2 gap-1.5">
              {d.dataQuality.items.map((it: any) => (
                <div key={it.key} className={`flex items-center gap-1.5 text-[12px] ${it.ok ? 'text-emerald-300' : 'text-zinc-400'}`}>
                  {it.ok ? <Check className="w-3.5 h-3.5 shrink-0" /> : <Circle className="w-3.5 h-3.5 shrink-0 opacity-50" />}
                  {it.label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Histórico de recomendações — Impact Ledger unificado (ADR-125/126) */}
        {d?.ledger?.items?.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
              <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2"><Target className="w-4 h-4 text-emerald-300" /> O que você já colocou no plano</h3>
              <div className="text-[11px] text-zinc-400">esperado <span className="text-zinc-200">{brl(d.ledger.expected)}</span> · realizado <span className="text-emerald-300">{brl(d.ledger.realized)}</span></div>
            </div>
            <div className="space-y-1.5">
              {d.ledger.items.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-zinc-100">{a.title}</div>
                    <div className="text-[11px] text-zinc-500">esperado {brl(a.expected_impact)}{a.status === 'done' ? ` · realizado ${brl(a.result_amount)}` : ''}</div>
                  </div>
                  {a.status === 'done' ? (
                    <span className="shrink-0 text-[11px] rounded-full border border-emerald-500/40 text-emerald-300 px-2 py-0.5">concluída</span>
                  ) : (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button disabled={busy} onClick={() => concluir(a)} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800 inline-flex items-center gap-1"><Check className="w-3 h-3" /> Registrar resultado</button>
                      <button disabled={busy} onClick={() => dispensar(a)} title="Dispensar" className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800"><X className="w-3 h-3" /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <HireSimulatorCard />
      </div>
    </div>
  );
}

// Simulador de Decisões (ADR-133) — "posso contratar?" / "posso comprar estoque?".
function HireSimulatorCard() {
  const [mode, setMode] = useState<'hire' | 'stock' | 'withdraw' | 'payback'>('hire');
  const [value, setValue] = useState('');
  const [res, setRes] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const setModeReset = (m: 'hire' | 'stock' | 'withdraw' | 'payback') => { setMode(m); setRes(null); setValue(''); };
  const CFG = {
    hire: { url: '/api/health-center/simulate/hire', key: 'monthlyCost', label: 'Posso contratar?', hint: 'Custo mensal da contratação → quanto de venda a mais isso exige, com a sua margem atual.', ph: 'custo mensal (ex.: 3.500)' },
    stock: { url: '/api/health-center/simulate/buy-stock', key: 'amount', label: 'Posso comprar estoque?', hint: 'Valor da compra → quantos dias de cobertura e quanto tende a ficar parado.', ph: 'valor da compra (ex.: 30.000)' },
    withdraw: { url: '/api/health-center/simulate/withdraw', key: 'amount', label: 'Posso retirar mais?', hint: 'Valor da retirada → efeito no caixa e se cabe no pró-labore sustentável.', ph: 'valor da retirada (ex.: 2.000)' },
    payback: { url: '/api/health-center/simulate/payback', key: 'amount', label: 'Pagar um investimento?', hint: 'Valor do investimento → quanto vender pra pagar (em 12 meses) e o payback no seu ritmo atual.', ph: 'valor da máquina (ex.: 12.000)' },
  } as const;
  const simulate = async () => {
    const num = Number(String(value).replace(/\./g, '').replace(',', '.')) || 0;
    if (!(num > 0)) { toast.error('Informe um valor.'); return; }
    setBusy(true);
    try {
      const cfg = CFG[mode];
      const r = await apiFetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [cfg.key]: num }) });
      setRes(await r.json());
    } catch { toast.error('Não consegui simular.'); } finally { setBusy(false); }
  };
  return (
    <div className="mt-4 rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-4">
      <h3 className="text-sm font-medium text-indigo-100 flex items-center gap-2"><Target className="w-4 h-4" /> Simulador de decisões</h3>
      <div className="mt-2 flex flex-wrap items-center rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 text-[11px] w-fit gap-0.5">
        {(['hire', 'stock', 'withdraw', 'payback'] as const).map((m) => (
          <button key={m} onClick={() => setModeReset(m)} className={`rounded px-2.5 py-1 ${mode === m ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}>{CFG[m].label}</button>
        ))}
      </div>
      <p className="text-[12px] text-zinc-400 mt-2">{CFG[mode].hint}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg bg-zinc-900 border border-zinc-700 px-2.5 py-1.5">
          <span className="text-zinc-500 text-sm">R$</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && simulate()} placeholder={CFG[mode].ph} inputMode="decimal" className="w-44 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 outline-none" />
        </div>
        <button onClick={simulate} disabled={busy} className="text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-3 py-1.5 font-medium">Simular</button>
      </div>
      {res && (res.ok ? (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
          <div className="text-[13px] text-zinc-100">{res.veredito}</div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400">
            {mode === 'hire' && (
              <>
                <span>Margem atual: <b className="text-zinc-200">{res.marginPct}%</b></span>
                <span>Venda a mais/mês: <b className="text-amber-200">{brl(res.extraRevenueNeeded)}</b></span>
                {res.pctOfCurrent != null && <span>= <b className="text-zinc-200">{res.pctOfCurrent}%</b> a mais que hoje</span>}
                {res.extraTicketsPerDay != null && <span>~<b className="text-zinc-200">{res.extraTicketsPerDay}</b> venda(s)/dia</span>}
              </>
            )}
            {mode === 'stock' && (
              <>
                {res.coverageKnown && <span>Cobertura: <b className="text-zinc-200">{res.currentCoverageDays}→{res.newCoverageDays}</b> dias</span>}
                <span>Pode ficar parado: <b className="text-amber-200">{brl(res.estIdle)}</b> {res.slowPct != null && <span className="text-zinc-500">(~{res.slowPct}%)</span>}</span>
              </>
            )}
            {mode === 'withdraw' && (
              <>
                <span>Caixa: <b className="text-zinc-200">{brl(res.caixaAtual)}→{brl(res.caixaAfter)}</b></span>
                {res.pctResultAfter != null && <span>= <b className="text-zinc-200">{res.pctResultAfter}%</b> do resultado</span>}
                <span className={res.nivel === 'excesso' ? 'text-red-300' : res.nivel === 'atencao' ? 'text-amber-300' : 'text-emerald-300'}>{res.nivel === 'ok' ? 'sustentável' : res.nivel === 'atencao' ? 'acima do ideal' : 'excesso'}</span>
              </>
            )}
            {mode === 'payback' && (
              <>
                <span>Vender ao todo: <b className="text-amber-200">{brl(res.totalRevenueNeeded)}</b></span>
                <span>~<b className="text-zinc-200">{brl(res.monthlyRevenueNeeded)}</b>/mês ({res.months}m)</span>
                {res.paybackMonths != null && <span>Payback: <b className="text-zinc-200">~{res.paybackMonths} {res.paybackMonths === 1 ? 'mês' : 'meses'}</b></span>}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 text-[12px] text-amber-300">{res.message}</div>
      ))}
    </div>
  );
}

// Tutor de Gestão no WhatsApp (ADR-131) — opt-in do resumo diário da manhã.
function TutorWhatsAppCard() {
  const [cfg, setCfg] = useState<any | null>(null);
  const [phone, setPhone] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch('/api/health-center/tutor').then((r) => r.json()).then((x: any) => { setCfg(x); setPhone(x?.phone || ''); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (enabled: boolean, ph: string) => {
    setBusy(true);
    try {
      const r = await apiFetch('/api/health-center/tutor', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, phone: ph }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Falha');
      setCfg((c: any) => ({ ...c, enabled: d.enabled, phone: d.phone }));
      toast.success(enabled ? 'Tutor no WhatsApp ativado. ☀️' : 'Tutor desativado.');
    } catch (e: any) { toast.error(e.message || 'Não consegui salvar.'); } finally { setBusy(false); }
  };
  const sendTest = async () => {
    setBusy(true);
    try {
      const r = await apiFetch('/api/health-center/tutor/test', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'Falha');
      toast.success('Resumo enviado no WhatsApp. 📲');
    } catch (e: any) { toast.error(e.message || 'Não consegui enviar.'); } finally { setBusy(false); }
  };

  if (!cfg) return null;
  const noNumber = !phone.trim() && !cfg.ownerPhoneFallback;

  return (
    <div className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <MessageCircle className="w-4 h-4 text-emerald-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-100">Receber este resumo no WhatsApp toda manhã</div>
            <div className="text-[12px] text-zinc-400">O tutor te manda as prioridades do dia — sem você precisar abrir o app.</div>
          </div>
        </div>
        <button
          onClick={() => save(!cfg.enabled, phone)}
          disabled={busy}
          className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${cfg.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}
          aria-label="Ativar tutor no WhatsApp"
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${cfg.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      {cfg.enabled && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => save(true, phone)}
              placeholder={cfg.ownerPhoneFallback ? `Padrão: ${cfg.ownerPhoneFallback}` : 'WhatsApp do dono (DDD + número)'}
              className="flex-1 min-w-[180px] rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
              inputMode="tel"
            />
            <button onClick={sendTest} disabled={busy || !cfg.hasChannel || noNumber} className="text-xs rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 px-2.5 py-1.5 inline-flex items-center gap-1.5"><Send className="w-3.5 h-3.5" /> Enviar teste</button>
          </div>
          {!cfg.hasChannel && <div className="text-[11px] text-amber-300/90">Conecte um canal de WhatsApp para o envio funcionar.</div>}
          <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"><ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} /> {open ? 'Ocultar' : 'Ver'} prévia das mensagens</button>
          {open && (
            <div className="space-y-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">☀️ Manhã (todo dia)</div>
                <pre className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-[12px] text-zinc-300 font-sans">{cfg.preview}</pre>
              </div>
              {cfg.previewMidday && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">☕ Meio-dia (quando há ponto de equilíbrio)</div>
                  <pre className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-[12px] text-zinc-300 font-sans">{cfg.previewMidday}</pre>
                </div>
              )}
              {cfg.previewEvening && (
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">📊 Fim do dia (todo dia)</div>
                  <pre className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-[12px] text-zinc-300 font-sans">{cfg.previewEvening}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
