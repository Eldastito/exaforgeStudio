import React, { useState } from 'react';
import {
  MessageSquare, Target, CalendarClock, Package, BarChart3, ShieldCheck,
  ArrowRight, Check, Brain, ClipboardList, Workflow, ChevronDown,
  Hotel, Store, Briefcase, Lock, Database, KeyRound, History, Plug,
} from 'lucide-react';
import { marketingConfig, primaryCtaHref } from '@/src/config/marketing';
import { ZappFlowMark } from '@/src/brand/ZappFlowMark';

const CTA_PRIMARY = 'Agendar diagnóstico operacional';
const teal = 'var(--color-zf-teal)';
const amber = 'var(--color-zf-amber)';

function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-bold tracking-tight ${className}`}>
      Zapp<span style={{ color: teal }}>Flow</span>
    </span>
  );
}

const NAV = [
  { id: 'produto', label: 'Produto' },
  { id: 'supply', label: 'Supply' },
  { id: 'solucoes', label: 'Soluções' },
  { id: 'seguranca', label: 'Segurança' },
  { id: 'faq', label: 'FAQ' },
];

const DORES = [
  { t: 'Conversas que esfriam', d: 'Mensagens sem retorno viram oportunidade perdida.' },
  { t: 'Operação no improviso', d: 'Tarefas ficam sem responsável e sem prazo.' },
  { t: 'Estoque que só vira prioridade quando falta', d: 'A ruptura aparece quando a operação já parou.' },
  { t: 'Dados sem ação', d: 'A empresa tem números, mas eles não viram decisão.' },
];

const ETAPAS = [
  { icon: MessageSquare, t: 'Capta', d: 'Conversas, pedidos, formulários, alertas e sinais operacionais.' },
  { icon: Brain, t: 'Entende', d: 'Identifica intenção, contexto, urgência e o próximo passo.' },
  { icon: Target, t: 'Prioriza', d: 'Cria oportunidade, tarefa, agenda, alerta ou requisição.' },
  { icon: Workflow, t: 'Executa', d: 'Orienta IA, equipe e integrações.' },
  { icon: BarChart3, t: 'Aprende', d: 'Registra histórico, responsável, prazo e resultado.' },
];

const MODULOS = [
  { icon: MessageSquare, t: 'Atendimento e canais', d: 'Concentre mensagens e evite que oportunidades morram no caminho.' },
  { icon: Target, t: 'Vendas e CRM', d: 'Transforme conversas em oportunidades com próxima ação e follow-up.' },
  { icon: CalendarClock, t: 'Execução e agenda', d: 'Conecte compromissos, tarefas e demandas à rotina real da equipe.' },
  { icon: Package, t: 'Supply e reposição', d: 'Detecte estoque crítico e leve uma lista priorizada para aprovação.' },
  { icon: Store, t: 'Commerce e reservas', d: 'Do pedido no WhatsApp ao processo que realmente acontece.' },
  { icon: BarChart3, t: 'Indicadores e governança', d: 'Visão do fluxo completo, com histórico e rastreabilidade.' },
];

const SETORES = [
  { icon: Hotel, t: 'Hospitalidade', p: 'Reservas que morrem no WhatsApp.', a: 'Organize conversas, qualifique demandas e acompanhe oportunidades até a próxima ação.' },
  { icon: Store, t: 'Comércio & Varejo', p: 'Pedido por mensagem vira operação no improviso.', a: 'Atendimento, pedidos, follow-up, estoque e reposição num fluxo único.' },
  { icon: Briefcase, t: 'Serviços', p: 'Demanda dispersa entre canais e pessoas.', a: 'Centralize solicitações, responsáveis e prazos com acompanhamento.' },
];

const SEGURANCA = [
  { icon: ShieldCheck, t: 'Aprovação humana', d: 'Em ações críticas, a decisão continua com a sua equipe.' },
  { icon: Database, t: 'Dados da própria empresa', d: 'A IA trabalha sobre a sua operação, não sobre achismos.' },
  { icon: KeyRound, t: 'Permissões', d: 'Cada pessoa acessa o que é do seu papel.' },
  { icon: History, t: 'Histórico', d: 'Cada conversa e ação fica registrada e rastreável.' },
  { icon: Plug, t: 'Integrações graduais', d: 'Conecte os sistemas oficiais no seu ritmo.' },
];

const SUPPLY_ROWS = [
  { item: 'Água mineral 500ml', local: 'Hotel Central', cobertura: '2 dias', status: 'Crítico', crit: true },
  { item: 'Café em grão 1kg', local: 'Hotel Central', cobertura: '1 dia', status: 'Crítico', crit: true },
  { item: 'Toalha de banho', local: 'Resort Praia', cobertura: '3 dias', status: 'Baixo', crit: false },
  { item: 'Papel higiênico', local: 'Resort Praia', cobertura: '4 dias', status: 'Baixo', crit: false },
];

const FAQ = [
  { q: 'O ZappFlow substitui minha equipe?', a: 'Não. A IA acelera e organiza; as pessoas decidem. Em ações críticas, a aprovação humana é obrigatória.' },
  { q: 'Preciso trocar meus sistemas atuais?', a: 'Não. A ideia é conectar o que você já usa de forma gradual, sem ruptura.' },
  { q: 'O ZappFlow Supply faz compras sozinho?', a: 'Não nesta fase. Ele identifica itens abaixo do mínimo, estima a reposição com base no consumo real e prepara uma lista priorizada para a sua aprovação.' },
  { q: 'Como começo?', a: 'Com um diagnóstico operacional: olhamos seu fluxo atual e mostramos onde há demanda perdida, demora ou retrabalho.' },
];

function Cta({ children, primary = false, className = '' }: { children: React.ReactNode; primary?: boolean; className?: string }) {
  const href = primary ? primaryCtaHref() : '#diagnostico';
  const external = primary && /^https?:\/\//.test(href);
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className={`zf-button ${primary ? 'zf-button-primary' : 'zf-button-secondary'} ${className}`}>
      {children}
    </a>
  );
}

export function LandingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  return (
    <div className="min-h-screen text-zinc-100" style={{ background: 'var(--color-zf-midnight)' }}>
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-[#243B58]/60 backdrop-blur-md bg-[#07111F]/80">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <a href="#topo" className="flex items-center gap-2" aria-label="ZappFlow — início">
            {/* Marca oficial — usar sempre o componente centralizado, nunca redesenhar. */}
            <ZappFlowMark size={32} aria-hidden="true" />
            <Wordmark className="text-lg text-zinc-50" />
          </a>
          <nav className="hidden md:flex items-center gap-6" aria-label="Navegação principal">
            {NAV.map(n => <a key={n.id} href={`#${n.id}`} className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">{n.label}</a>)}
          </nav>
          <Cta primary className="h-9 text-xs">Agendar diagnóstico <ArrowRight className="w-3.5 h-3.5" /></Cta>
        </div>
      </header>

      {/* Hero */}
      <section id="topo" className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(900px 480px at 100% -10%, rgba(99,149,255,0.12), transparent 62%), radial-gradient(820px 460px at -10% 105%, rgba(34,211,182,0.10), transparent 65%)' }} />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="zf-kicker">Central de Execução e Inteligência Operacional</p>
            <h1 className="zf-display text-4xl sm:text-5xl mt-3 leading-[1.1]">Da conversa <span style={{ color: teal }}>à execução.</span></h1>
            <p className="text-zinc-300 mt-5 text-base sm:text-lg max-w-xl">
              O ZappFlow conecta atendimento, vendas, tarefas, agenda, estoque e compras para garantir que cada demanda avance para a próxima ação — com IA, controle humano e dados reais da sua operação.
            </p>
            <div className="flex flex-wrap items-center gap-3 mt-7">
              <Cta primary>Agendar diagnóstico operacional <ArrowRight className="w-4 h-4" /></Cta>
              <a href="#produto" className="zf-button zf-button-secondary">Ver como funciona</a>
            </div>
            <p className="text-[12px] text-zinc-500 mt-3">Sem promessa genérica. Olhamos seu fluxo atual e mostramos onde há demanda perdida, demora ou retrabalho.</p>
          </div>
          {/* Mock command center (ilustrativo) */}
          <div className="zf-panel p-4 sm:p-5" aria-hidden>
            <div className="flex items-center justify-between mb-3">
              <span className="zf-kicker">Visão operacional</span>
              <span className="text-[10px] text-zinc-600">exemplo</span>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-3">
              {[['Conversas', '2.842'], ['Ações executadas', '1.396'], ['Taxa de execução', '92%']].map(([l, v]) => (
                <div key={l} className="zf-panel-subtle p-3">
                  <p className="zf-data-label">{l}</p>
                  <p className="zf-data-value text-xl text-zinc-50 mt-1">{v}</p>
                </div>
              ))}
            </div>
            <div className="zf-panel-subtle p-3 space-y-2">
              {[['Em andamento', 'flow'], ['Sugestão da IA', 'intelligence'], ['Concluído', 'success'], ['Reposição sugerida', 'supply']].map(([t, k]) => (
                <div key={t} className="flex items-center justify-between">
                  <span className="text-xs text-zinc-300">{t === 'Reposição sugerida' ? 'Café em grão · cobertura 1 dia' : t === 'Concluído' ? 'Orçamento enviado · follow-up' : t === 'Sugestão da IA' ? 'Próxima ação recomendada' : 'Pedido no WhatsApp'}</span>
                  <span className={`zf-status-${k}`}>{t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Dor */}
      <section id="produto" className="max-w-6xl mx-auto px-4 sm:px-6 py-16">
        <h2 className="zf-display text-2xl sm:text-3xl">A mensagem chegou. Mas quem garantiu que ela virou resultado?</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
          {DORES.map(c => (
            <div key={c.t} className="zf-panel zf-panel-hover p-5">
              <p className="font-semibold text-zinc-100">{c.t}</p>
              <p className="text-sm text-zinc-400 mt-2">{c.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Como funciona */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-16 border-t border-[#243B58]/50">
        <h2 className="zf-display text-2xl sm:text-3xl">O ZappFlow transforma sinais da operação em ação acompanhada.</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-8">
          {ETAPAS.map((e, i) => (
            <div key={e.t} className="zf-panel p-5">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: 'var(--color-flow-soft)' }}><e.icon className="w-4 h-4" style={{ color: teal }} /></span>
                <span className="text-[11px] text-zinc-500">Etapa {i + 1}</span>
              </div>
              <p className="font-semibold text-zinc-100 mt-3">{e.t}</p>
              <p className="text-sm text-zinc-400 mt-1">{e.d}</p>
            </div>
          ))}
        </div>
        <p className="text-center text-zinc-300 mt-8 text-lg">A IA acelera. As pessoas decidem. A operação evolui.</p>
      </section>

      {/* Módulos */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-16 border-t border-[#243B58]/50">
        <h2 className="zf-display text-2xl sm:text-3xl">Um sistema, vários módulos conectados.</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-8">
          {MODULOS.map(m => (
            <div key={m.t} className="zf-panel zf-panel-hover p-5">
              <m.icon className="w-5 h-5" style={{ color: teal }} />
              <p className="font-semibold text-zinc-100 mt-3">{m.t}</p>
              <p className="text-sm text-zinc-400 mt-1">{m.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Supply em destaque */}
      <section id="supply" className="max-w-6xl mx-auto px-4 sm:px-6 py-16">
        <div className="zf-supply-card p-6 sm:p-8">
          <p className="zf-kicker" style={{ color: amber }}>ZappFlow Supply</p>
          <h2 className="zf-display text-2xl sm:text-3xl mt-2">Descobrir que faltou é tarde demais.</h2>
          <p className="text-zinc-300 mt-3 max-w-3xl">
            O ZappFlow Supply identifica itens abaixo do nível mínimo, considera o consumo real da sua operação e prepara uma lista priorizada de reposição para aprovação humana.
          </p>
          <div className="grid lg:grid-cols-3 gap-3 mt-6">
            <div className="zf-panel-subtle p-4"><p className="zf-data-label">Estoque baixo</p><p className="zf-data-value text-2xl mt-1" style={{ color: amber }}>12 itens</p></div>
            <div className="zf-panel-subtle p-4"><p className="zf-data-label">Cobertura média</p><p className="zf-data-value text-2xl text-zinc-50 mt-1">18 dias</p></div>
            <div className="zf-panel-subtle p-4"><p className="zf-data-label">Pedidos em aberto</p><p className="zf-data-value text-2xl text-zinc-50 mt-1">8</p></div>
          </div>
          <div className="mt-5 overflow-x-auto">
            <table className="zf-table text-sm min-w-[520px]">
              <thead><tr><th>Item</th><th>Local</th><th>Cobertura</th><th>Status</th></tr></thead>
              <tbody>
                {SUPPLY_ROWS.map(r => (
                  <tr key={r.item}>
                    <td className="text-zinc-200">{r.item}</td>
                    <td className="text-zinc-400">{r.local}</td>
                    <td className="text-zinc-300">{r.cobertura}</td>
                    <td><span className={r.crit ? 'zf-status-danger' : 'zf-status-supply'}>{r.crit && <span aria-hidden>●</span>}{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-zinc-600 mt-2">Dados demonstrativos (exemplo).</p>
          </div>
          <div className="mt-5 flex items-center gap-2 text-sm text-zinc-300">
            <ShieldCheck className="w-4 h-4" style={{ color: teal }} /> A IA propõe. A pessoa aprova. A operação mantém o controle.
          </div>
        </div>
      </section>

      {/* Soluções por setor */}
      <section id="solucoes" className="max-w-6xl mx-auto px-4 sm:px-6 py-16 border-t border-[#243B58]/50">
        <h2 className="zf-display text-2xl sm:text-3xl">Aplicações por setor.</h2>
        <div className="grid sm:grid-cols-3 gap-4 mt-8">
          {SETORES.map(s => (
            <div key={s.t} className="zf-panel zf-panel-hover p-5">
              <s.icon className="w-5 h-5" style={{ color: teal }} />
              <p className="font-semibold text-zinc-100 mt-3">{s.t}</p>
              <p className="text-xs text-zinc-500 mt-2"><b className="text-zinc-400">Problema:</b> {s.p}</p>
              <p className="text-xs text-zinc-400 mt-1"><b className="text-zinc-300">Aplicação:</b> {s.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Segurança */}
      <section id="seguranca" className="max-w-6xl mx-auto px-4 sm:px-6 py-16 border-t border-[#243B58]/50">
        <h2 className="zf-display text-2xl sm:text-3xl flex items-center gap-2"><Lock className="w-6 h-6" style={{ color: teal }} /> Autonomia onde é seguro. Aprovação onde é necessário.</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4 mt-8">
          {SEGURANCA.map(s => (
            <div key={s.t} className="zf-panel-subtle p-4">
              <s.icon className="w-5 h-5" style={{ color: teal }} />
              <p className="font-semibold text-zinc-100 mt-2 text-sm">{s.t}</p>
              <p className="text-xs text-zinc-400 mt-1">{s.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA final */}
      <section id="diagnostico" className="max-w-6xl mx-auto px-4 sm:px-6 py-16">
        <div className="zf-panel p-8 sm:p-12 text-center">
          <h2 className="zf-display text-2xl sm:text-3xl">Antes de automatizar, encontre onde a operação está vazando resultado.</h2>
          <p className="text-zinc-300 mt-3 max-w-2xl mx-auto">Veja, em uma conversa objetiva, onde o ZappFlow pode reduzir perda de demanda, retrabalho e improviso no seu negócio.</p>
          <div className="mt-6 flex justify-center"><Cta primary>Agendar diagnóstico operacional <ArrowRight className="w-4 h-4" /></Cta></div>
          {(marketingConfig.whatsappUrl || marketingConfig.email) && (
            <p className="text-xs text-zinc-500 mt-3">
              {marketingConfig.whatsappUrl && <a className="hover:text-zinc-300" href={marketingConfig.whatsappUrl} target="_blank" rel="noreferrer">WhatsApp</a>}
              {marketingConfig.whatsappUrl && marketingConfig.email && ' · '}
              {marketingConfig.email && <a className="hover:text-zinc-300" href={`mailto:${marketingConfig.email}`}>{marketingConfig.email}</a>}
            </p>
          )}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="max-w-3xl mx-auto px-4 sm:px-6 py-16 border-t border-[#243B58]/50">
        <h2 className="zf-display text-2xl sm:text-3xl mb-6">Perguntas frequentes</h2>
        <div className="space-y-2">
          {FAQ.map((f, i) => {
            const open = openFaq === i;
            return (
              <div key={i} className="zf-panel-subtle">
                <button onClick={() => setOpenFaq(open ? null : i)} aria-expanded={open}
                  className="w-full flex items-center justify-between gap-3 text-left px-4 py-3">
                  <span className="text-sm font-medium text-zinc-100">{f.q}</span>
                  <ChevronDown className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>
                {open && <p className="px-4 pb-4 -mt-1 text-sm text-zinc-400">{f.a}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#243B58]/60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Wordmark className="text-base text-zinc-200" />
            <span className="text-xs text-zinc-600">· Da conversa à execução.</span>
          </div>
          <nav className="flex items-center gap-5 text-xs text-zinc-500" aria-label="Rodapé">
            {NAV.map(n => <a key={n.id} href={`#${n.id}`} className="hover:text-zinc-300">{n.label}</a>)}
            <a href="/" className="hover:text-zinc-300">Entrar</a>
          </nav>
        </div>
        <p className="text-center text-[11px] text-zinc-700 pb-6">ZappFlow · Inteligência Operacional · Execução que gera resultados</p>
      </footer>
    </div>
  );
}
