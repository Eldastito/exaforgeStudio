/**
 * CompanyView (ADR-203 F2.6) — "Empresa": a configuração da empresa em linguagem de dono. Dois blocos:
 *  1) Conexões em MODO NORMAL — só RENDERIZA `GET /api/ux/integration-status` (RN-F2-4): conectada? última sync?
 *     o que chega (produtos/vendas/estoque)? "1 filial requer atenção". O MODO AVANÇADO é a tela técnica que já existe
 *     (Integrações / Canais e I.A.), preservada e a um clique.
 *  2) Ajustes da empresa — atalhos para as abas de Configurações que já existem (nada é duplicado).
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, XCircle, Clock, ArrowRight, Briefcase, Users, Scale, CreditCard, LayoutGrid } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { useStore } from '@/src/store/useStore';
import { trackAction } from '@/src/lib/uxTelemetry';

type IntState = 'ok' | 'attention' | 'down' | 'not_configured';
interface Flow { key: string; label: string; state: 'ok' | 'attention' | 'pending'; lastAt: string | null }
interface Card {
  key: string; name: string; state: IntState; stateLabel: string; lastSyncHhmm: string | null; stale: boolean;
  flows: Flow[]; attentionText: string | null; issues: Array<{ text: string; action: string }>; advancedViewMode: string;
}
interface Channel { id: string; name: string; kind: string; state: IntState; stateLabel: string }
interface Pilot {
  restricted: boolean; windowDays: number; state: 'disabled' | 'no_data' | 'low_sample' | 'ok'; telemetryEnabled: boolean; simplifiedNavEnabled: boolean;
  sample: { views: number; users: number; sessions: number; minViews: number; minUsers: number };
  topScreens: Array<{ screen: string; label: string; views: number }>;
  entry: { primary: number; explorar: number; explorarSharePct: number | null };
  hoje: { opens: number; actionClicks: number; actionRatePct: number | null };
  falatuQuestions: { total: number; withStore: number; followUps: number }; searchMisses: number; notes: string[];
}
interface Status { restricted: boolean; summary: string | null; integrations: Card[]; channels: Channel[] }

const TONE: Record<IntState, { cls: string; icon: React.ReactNode }> = {
  ok: { cls: 'text-emerald-300', icon: <CheckCircle2 className="h-4 w-4" /> },
  attention: { cls: 'text-amber-300', icon: <AlertTriangle className="h-4 w-4" /> },
  down: { cls: 'text-rose-300', icon: <XCircle className="h-4 w-4" /> },
  not_configured: { cls: 'text-slate-400', icon: <CircleSlash className="h-4 w-4" /> },
};
const FLOW_CLS: Record<Flow['state'], string> = { ok: 'text-emerald-300', attention: 'text-amber-300', pending: 'text-slate-500' };
const FLOW_SUFFIX: Record<Flow['state'], string> = { ok: '', attention: ' — atenção', pending: ' — ainda não chegou' };

const SHORTCUTS: Array<{ tab: string; label: string; hint: string; icon: React.ReactNode }> = [
  { tab: 'empresa', label: 'Dados da empresa', hint: 'Nome, CNPJ, contato.', icon: <Briefcase className="h-4 w-4" /> },
  { tab: 'usuarios', label: 'Equipe e permissões', hint: 'Quem acessa o quê.', icon: <Users className="h-4 w-4" /> },
  { tab: 'governanca', label: 'Autonomia da IA', hint: 'O que a IA pode fazer sozinha.', icon: <Scale className="h-4 w-4" /> },
  { tab: 'cobranca', label: 'Plano e cobrança', hint: 'Seu plano e faturas.', icon: <CreditCard className="h-4 w-4" /> },
  { tab: 'modulos', label: 'Módulos e menu', hint: 'Ligar recursos e o menu simplificado.', icon: <LayoutGrid className="h-4 w-4" /> },
];

export function CompanyView() {
  const setViewMode = useStore(s => s.setViewMode);
  const setSettingsTab = useStore(s => s.setSettingsTab);
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [pilot, setPilot] = useState<Pilot | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/ux/integration-status').then(r => r.ok ? r.json() : Promise.reject()).then(d => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    apiFetch('/api/ux/pilot-report').then(r => r.ok ? r.json() : null).then(d => { if (alive) setPilot(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const openSettings = (tab: string) => { trackAction('empresa_atalho', tab); setSettingsTab(tab); setViewMode('settings' as any); };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6" data-testid="company-view">
      <section aria-label="Conexões" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-100">Conexões</h2>
          {data?.summary && <span className="text-sm text-slate-400">{data.summary}</span>}
        </div>
        {error && <p className="text-sm text-slate-400">Não consegui carregar as conexões agora.</p>}
        {!data && !error && <p className="text-sm text-slate-500">Carregando…</p>}
        {data?.restricted && <p className="text-sm text-slate-400">O status das conexões é do gestor.</p>}
        {data && !data.restricted && data.integrations.length === 0 && data.channels.length === 0 && <p className="text-sm text-slate-500">Nenhuma conexão configurada ainda.</p>}

        {data?.integrations.map(c => (
          <div key={c.key} className="zf-panel p-4" data-testid="integration-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-slate-100">{c.name}</p>
              <span className={`inline-flex items-center gap-1 text-sm ${TONE[c.state].cls}`}>{TONE[c.state].icon}{c.stateLabel}</span>
            </div>
            {c.lastSyncHhmm && <p className={`mt-1 inline-flex items-center gap-1 text-xs ${c.stale ? 'text-amber-300' : 'text-slate-500'}`}><Clock className="h-3.5 w-3.5" />Última sincronização às {c.lastSyncHhmm}{c.stale ? ' — pode estar atrasada' : ''}</p>}
            {c.flows.length > 0 && <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">{c.flows.map(f => <span key={f.key} className={FLOW_CLS[f.state]}>{f.label}{FLOW_SUFFIX[f.state]}</span>)}</p>}
            {c.attentionText && <p className="mt-2 text-sm font-medium text-amber-300">{c.attentionText}</p>}
            {c.issues.length > 0 && <ul className="mt-2 space-y-1">{c.issues.map((i, k) => <li key={k} className="text-xs text-slate-400">{i.text} <span className="text-slate-500">{i.action}</span></li>)}</ul>}
            <button onClick={() => { trackAction('empresa_avancado', c.advancedViewMode); setViewMode(c.advancedViewMode as any); }} className="mt-3 inline-flex items-center gap-1 text-xs text-teal-300 hover:underline">Modo avançado (detalhes técnicos)<ArrowRight className="h-3.5 w-3.5" /></button>
          </div>
        ))}

        {data && data.channels.length > 0 && (
          <div className="zf-panel p-4" data-testid="channels-card">
            <p className="font-medium text-slate-100">Canais de atendimento</p>
            <ul className="mt-2 space-y-1">{data.channels.map(ch => <li key={ch.id} className={`flex items-center gap-2 text-sm ${TONE[ch.state].cls}`}>{TONE[ch.state].icon}<span className="text-slate-200">{ch.name}</span><span className="text-xs">{ch.stateLabel}</span></li>)}</ul>
            <button onClick={() => { trackAction('empresa_avancado', 'channels'); setViewMode('channels' as any); }} className="mt-3 inline-flex items-center gap-1 text-xs text-teal-300 hover:underline">Modo avançado (Canais e I.A.)<ArrowRight className="h-3.5 w-3.5" /></button>
          </div>
        )}
      </section>

      {pilot && !pilot.restricted && (
        <section aria-label="Uso do menu" className="space-y-2" data-testid="pilot-report">
          <h2 className="text-lg font-semibold text-slate-100">Como a equipe está usando o menu</h2>
          {pilot.state === 'disabled' && <p className="text-sm text-slate-400">A medição de uso está desligada. Para saber se o menu simplificado ajuda, ligue em Configurações → Módulos (“Medir o uso do menu”).</p>}
          {pilot.state !== 'disabled' && (
            <div className="zf-panel p-4 space-y-3">
              <p className="text-xs text-slate-500">Últimos {pilot.windowDays} dias · {pilot.sample.views} aberturas de tela · {pilot.sample.users} {pilot.sample.users === 1 ? 'pessoa' : 'pessoas'}{pilot.state === 'low_sample' ? ' · amostra pequena' : ''}</p>
              {pilot.topScreens.length > 0 && <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-200">{pilot.topScreens.slice(0, 6).map(t => <span key={t.screen}>{t.label} <span className="text-slate-500">{t.views}</span></span>)}</p>}
              <ul className="space-y-1 text-sm text-slate-300">
                {pilot.entry.explorarSharePct !== null && <li>{pilot.entry.explorarSharePct}% dos acessos passaram pelo Explorar{pilot.entry.explorarSharePct >= 50 ? ' — o 1º nível pode não estar cobrindo o que a equipe procura' : ''}.</li>}
                {pilot.hoje.actionRatePct !== null && <li>No Hoje, {pilot.hoje.actionRatePct}% das aberturas viraram clique em uma prioridade.</li>}
                {pilot.falatuQuestions.total > 0 && <li>FalaTu: {pilot.falatuQuestions.total} perguntas ({pilot.falatuQuestions.followUps} continuações).</li>}
                {pilot.searchMisses > 0 && <li>{pilot.searchMisses} {pilot.searchMisses === 1 ? 'busca' : 'buscas'} no Explorar sem resultado.</li>}
              </ul>
              {pilot.notes.map((n, i) => <p key={i} className="text-xs text-slate-500">{n}</p>)}
            </div>
          )}
        </section>
      )}

      <section aria-label="Ajustes" className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-100">Ajustes da empresa</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SHORTCUTS.map(s => (
            <button key={s.tab} onClick={() => openSettings(s.tab)} className="zf-panel-subtle flex items-start gap-3 p-3 text-left hover:border-teal-500/40">
              <span className="mt-0.5 text-teal-300">{s.icon}</span>
              <span><span className="block text-sm font-medium text-slate-100">{s.label}</span><span className="block text-xs text-slate-500">{s.hint}</span></span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
