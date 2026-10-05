/**
 * AutonomyContractPanel (ADR-204 F3.1d, PRD Fase 3 §34) — "O que a IA pode fazer sozinha", dentro da aba
 * Empresa → Autonomia da IA (a `GovernancePanel` que já existe; nenhuma tela nova).
 *
 * Só RENDERIZA `GET /api/actions/autonomy/overview` e chama as rotas já testadas de pausa e travas (RN-F2-4: sem regra de
 * negócio no frontend). O nível mostrado é DERIVADO da política no servidor — esta tela NÃO oferece um jeito de ELEVAR a
 * autonomia (RN-F3-3): só o dono pode PAUSAR (kill switch) e APERTAR com travas; subir de nível segue pelos fluxos
 * governados existentes. Quem não é dono vê tudo em leitura.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, PauseCircle, PlayCircle, Lock, Loader2 } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

interface Gates { minConfidence?: number; maxExecuteAmount?: number; maxDataAgeMinutes?: number }
interface PolicyRow {
  domain: string; actionType: string; label: string; level: 0 | 1 | 2 | 3; levelLabel: string;
  humanOnly: boolean; paused: boolean; pausedScope: 'org' | 'type' | null; reason: string; gates: Gates;
}
interface Overview {
  canGovern: boolean;
  pause: { paused: boolean; active: Array<{ id: string; scope: 'org' | 'type'; domain: string | null; actionType: string | null; reason: string; pausedAt: string }> };
  humanOnly: Array<{ key: string; label: string; types: string[] }>;
  policies: PolicyRow[];
}

const rowKey = (p: { domain: string; actionType: string }) => `${p.domain}/${p.actionType}`;

function badge(p: PolicyRow): { icon: string; text: string; cls: string } {
  if (p.humanOnly) return { icon: '🔴', text: 'Nunca executa sem a aprovação de uma pessoa', cls: 'text-rose-300' };
  if (p.level === 3) return { icon: '✅', text: 'Pode executar dentro do limite que você autorizou', cls: 'text-emerald-300' };
  if (p.level === 2) return { icon: '🟡', text: 'Prepara e pede a sua aprovação', cls: 'text-amber-300' };
  if (p.level === 1) return { icon: '⚪', text: 'Só recomenda', cls: 'text-zinc-300' };
  return { icon: '⚪', text: 'Só observa e relata', cls: 'text-zinc-400' };
}

const gatesText = (g: Gates): string => {
  const parts: string[] = [];
  if (g.minConfidence != null) parts.push(`confiança mínima ${Math.round(g.minConfidence * 100)}%`);
  if (g.maxExecuteAmount != null) parts.push(`valor máximo R$ ${g.maxExecuteAmount.toLocaleString('pt-BR')}`);
  if (g.maxDataAgeMinutes != null) parts.push(`dado com no máximo ${g.maxDataAgeMinutes} min`);
  return parts.join(' · ');
};

export function AutonomyContractPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState(false);
  const [pausing, setPausing] = useState<string | null>(null);   // 'org' | rowKey — em qual pausa o motivo está sendo digitado
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState<string | null>(null);   // rowKey — em qual tipo as travas estão sendo editadas
  const [form, setForm] = useState({ conf: '', amount: '', age: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetch('/api/actions/autonomy/overview').then(r => r.ok ? r.json() : Promise.reject()).then(d => { setData(d); setError(false); }).catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const call = async (method: string, url: string, body: any, okMsg: string) => {
    setBusy(true);
    try {
      const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Não consegui concluir.');
      toast.success(okMsg);
      setPausing(null); setReason(''); setEditing(null);
      load();
    } catch (e: any) { toast.error(e?.message || 'Não consegui concluir.'); }
    finally { setBusy(false); }
  };

  const pause = (scope: 'org' | PolicyRow) => call('POST', '/api/actions/autonomy/pause',
    scope === 'org' ? { reason } : { reason, domain: scope.domain, actionType: scope.actionType },
    scope === 'org' ? 'Autonomia pausada: nada será executado até você retomar.' : 'Esse tipo de ação foi pausado.');
  const resume = (scope: 'org' | PolicyRow) => call('POST', '/api/actions/autonomy/resume',
    scope === 'org' ? {} : { domain: scope.domain, actionType: scope.actionType },
    scope === 'org' ? 'Autonomia retomada.' : 'Esse tipo de ação foi retomado.');

  const openGates = (p: PolicyRow) => {
    setEditing(rowKey(p)); setPausing(null);
    setForm({
      conf: p.gates.minConfidence != null ? String(Math.round(p.gates.minConfidence * 100)) : '',
      amount: p.gates.maxExecuteAmount != null ? String(p.gates.maxExecuteAmount) : '',
      age: p.gates.maxDataAgeMinutes != null ? String(p.gates.maxDataAgeMinutes) : '',
    });
  };
  const saveGates = (p: PolicyRow) => {
    const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
    const conf = num(form.conf);
    call('PUT', '/api/actions/autonomy/gates', {
      domain: p.domain, actionType: p.actionType,
      minConfidence: conf == null ? null : conf / 100, maxExecuteAmount: num(form.amount), maxDataAgeMinutes: num(form.age),
    }, 'Travas de segurança salvas.');
  };

  if (error) return <div className="mt-5 text-sm text-zinc-500" data-testid="autonomy-error">Não consegui carregar a autonomia da IA agora.</div>;
  if (!data) return <div className="mt-5 flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>;

  const orgPause = data.pause.active.find(a => a.scope === 'org') || null;
  const owner = data.canGovern;

  return (
    <section className="mt-5 space-y-4" aria-label="Autonomia da IA" data-testid="autonomy-panel">
      <div>
        <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-teal-300" /> O que a IA pode fazer sozinha</h3>
        <p className="text-zinc-400 text-sm mt-1">Cada tipo de ação tem um limite claro. A IA pode analisar, preparar e recomendar — mas não compromete a empresa sem você.</p>
      </div>

      {/* Pausa da empresa inteira (kill switch) */}
      <div className={`rounded-xl border p-4 ${orgPause ? 'border-rose-500/40 bg-rose-500/5' : 'border-zinc-800 bg-zinc-900/40'}`} data-testid="autonomy-pause-card">
        {orgPause ? (
          <>
            <p className="text-sm font-medium text-rose-200 flex items-center gap-2"><PauseCircle className="w-4 h-4" /> Autonomia pausada — nenhuma ação sai enquanto estiver assim</p>
            <p className="text-xs text-zinc-400 mt-1">Motivo: {orgPause.reason}</p>
            <p className="text-xs text-zinc-500 mt-1">A IA continua analisando e preparando; só a execução está parada.</p>
            {owner && <button disabled={busy} onClick={() => resume('org')} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"><PlayCircle className="w-3.5 h-3.5" /> Retomar a autonomia</button>}
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-emerald-300 flex items-center gap-2"><PlayCircle className="w-4 h-4" /> Autonomia ativa, dentro dos limites abaixo</p>
            {owner && pausing !== 'org' && <button onClick={() => { setPausing('org'); setReason(''); setEditing(null); }} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"><PauseCircle className="w-3.5 h-3.5" /> Pausar tudo</button>}
            {owner && pausing === 'org' && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Por que está pausando? (fica registrado)" aria-label="Motivo da pausa" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100" />
                <button disabled={busy || reason.trim().length < 3} onClick={() => pause('org')} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50">Confirmar pausa</button>
                <button onClick={() => setPausing(null)} className="text-xs text-zinc-400 hover:underline">Cancelar</button>
              </div>
            )}
          </>
        )}
        {!owner && <p className="mt-2 text-[11px] text-zinc-500">Só o dono da empresa pode pausar ou ajustar. Você vê tudo em leitura.</p>}
      </div>

      {/* O que SEMPRE exige uma pessoa */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4" data-testid="autonomy-floor">
        <h4 className="text-sm font-medium text-zinc-100 flex items-center gap-2"><Lock className="w-4 h-4 text-rose-300" /> Sempre exigem uma pessoa</h4>
        <p className="text-[12px] text-zinc-400 mt-1">Isto vale acima de qualquer configuração. A IA só analisa, simula e prepara — quem aprova é você.</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {data.humanOnly.map(c => <li key={c.key} className="rounded-full border border-rose-500/30 bg-rose-500/5 px-2.5 py-1 text-[12px] text-rose-200">{c.label}</li>)}
        </ul>
      </div>

      {/* Por tipo de ação */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4" data-testid="autonomy-policies">
        <h4 className="text-sm font-medium text-zinc-100">Por tipo de ação</h4>
        {data.policies.length === 0 && <p className="mt-2 text-[13px] text-zinc-500">Nenhum tipo de ação tem política própria ainda — a IA só recomenda e pede a sua aprovação.</p>}
        <div className="mt-2 space-y-2">
          {data.policies.map(p => {
            const b = badge(p), k = rowKey(p), typePause = data.pause.active.find(a => a.scope === 'type' && a.domain === p.domain && a.actionType === p.actionType);
            const gt = gatesText(p.gates);
            return (
              <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3" data-testid="autonomy-row">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-zinc-100">{p.label}</p>
                    <p className={`text-[12px] mt-0.5 ${b.cls}`}>{b.icon} {b.text}</p>
                    {(typePause || (p.paused && !orgPause)) && <p className="text-[11px] text-rose-300 mt-0.5">⏸ Pausado{typePause ? `: ${typePause.reason}` : ''}</p>}
                    {gt ? <p className="text-[11px] text-zinc-400 mt-0.5">Travas de segurança: {gt}</p> : <p className="text-[11px] text-zinc-600 mt-0.5">Sem travas extras.</p>}
                  </div>
                  {owner && (
                    <div className="flex shrink-0 gap-2">
                      <button onClick={() => (editing === k ? setEditing(null) : openGates(p))} className="text-[11px] text-teal-300 hover:underline">{editing === k ? 'Fechar' : 'Travas'}</button>
                      {typePause
                        ? <button disabled={busy} onClick={() => resume(p)} className="text-[11px] text-emerald-300 hover:underline">Retomar</button>
                        : <button onClick={() => { setPausing(k); setReason(''); setEditing(null); }} className="text-[11px] text-rose-300 hover:underline">Pausar</button>}
                    </div>
                  )}
                </div>

                {owner && pausing === k && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Por que está pausando? (fica registrado)" aria-label="Motivo da pausa" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100" />
                    <button disabled={busy || reason.trim().length < 3} onClick={() => pause(p)} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50">Confirmar</button>
                    <button onClick={() => setPausing(null)} className="text-xs text-zinc-400 hover:underline">Cancelar</button>
                  </div>
                )}

                {owner && editing === k && (
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="autonomy-gates-form">
                    <label className="text-[11px] text-zinc-400">Confiança mínima (%)
                      <input inputMode="numeric" value={form.conf} onChange={e => setForm({ ...form, conf: e.target.value })} placeholder="sem trava" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
                    </label>
                    <label className="text-[11px] text-zinc-400">Valor máximo para executar (R$)
                      <input inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="sem trava" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
                    </label>
                    <label className="text-[11px] text-zinc-400">Idade máxima do dado (minutos)
                      <input inputMode="numeric" value={form.age} onChange={e => setForm({ ...form, age: e.target.value })} placeholder="sem trava" className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
                    </label>
                    <p className="text-[11px] text-zinc-500 sm:col-span-3">A IA não executa se estiver abaixo, acima ou além disso — e diz por quê. Valor ou data desconhecidos também bloqueiam. Deixe em branco para não travar.</p>
                    <div className="sm:col-span-3"><button disabled={busy} onClick={() => saveGates(p)} className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-500 disabled:opacity-50">Salvar travas</button></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default AutonomyContractPanel;
