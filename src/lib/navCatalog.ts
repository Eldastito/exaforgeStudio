/**
 * navCatalog (ADR-203 F2.2) — catálogo PURO da navegação: cada tela do menu legado (Sidebar.tsx)
 * com o MESMO gate que ela já tem, agrupada para "Explorar". Superfície ≠ motor (RN-F2-1): nada
 * é removido, só reagrupado; sem lógica de negócio (RN-F2-4) — só "qual tela, sob qual gate".
 * Puro (sem React/DOM) para rodar em CI. O teste `test:simplified-navigation` garante PARIDADE
 * com o Sidebar legado: toda tela do legado existe aqui com o mesmo gate.
 */
export type NavGroup = 'vendas' | 'financeiro' | 'marketing' | 'operacao' | 'ia' | 'administracao';

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  vendas: 'Vendas & Clientes',
  financeiro: 'Financeiro',
  marketing: 'Marketing',
  operacao: 'Operação',
  ia: 'Inteligência & Insights',
  administracao: 'Administração',
};

export interface NavCtx {
  isModuleEnabled: (key: string) => boolean;
  canAccessModule: (key: string) => boolean;
  isMasterAdmin: boolean;
  isManager: boolean;
  falatuEnabled: boolean;
  missionLayerEnabled: boolean;
  vertical: string | null;
  groupAvailable: boolean;
  coachAvailable: boolean;
}

export interface NavEntry {
  viewMode: string;
  label: string;
  group: NavGroup;
  /** gate: `visible(ctx)` — idêntico ao do Sidebar legado para a mesma tela. */
  visible: (c: NavCtx) => boolean;
}

const mod = (k: string) => (c: NavCtx) => c.isModuleEnabled(k) && c.canAccessModule(k);
const always = () => true;
const master = (c: NavCtx) => c.isMasterAdmin;

export const NAV_CATALOG: NavEntry[] = [
  { viewMode: 'saude', label: 'Central de Saúde', group: 'ia', visible: c => c.canAccessModule('saude_negocio') },
  { viewMode: 'insights', label: 'Insights', group: 'ia', visible: always },
  { viewMode: 'missoes', label: 'Missões', group: 'operacao', visible: c => c.missionLayerEnabled },
  { viewMode: 'kanban', label: 'Atendimento', group: 'vendas', visible: always },
  { viewMode: 'rie', label: 'Revenue Intelligence', group: 'ia', visible: mod('rie') },
  { viewMode: 'studio', label: 'Estúdio de Criação', group: 'marketing', visible: mod('estudio') },
  { viewMode: 'beauty', label: 'Beauty AI', group: 'marketing', visible: c => mod('estudio')(c) && c.vertical === 'beleza' },
  { viewMode: 'tarefas', label: 'Tarefas', group: 'operacao', visible: mod('execucao') },
  { viewMode: 'prospect', label: 'Prospect AI', group: 'vendas', visible: mod('prospect') },
  { viewMode: 'radar_b2b', label: 'Radar B2B', group: 'vendas', visible: mod('prospect') },
  { viewMode: 'diretor', label: 'Diretor IA', group: 'ia', visible: mod('diretor') },
  { viewMode: 'agenda', label: 'Agenda', group: 'operacao', visible: mod('agenda') },
  { viewMode: 'clinica', label: 'Agenda Clínica', group: 'operacao', visible: mod('clinica') },
  { viewMode: 'advocacia', label: 'Advocacia', group: 'operacao', visible: mod('advocacia') },
  { viewMode: 'escola', label: 'Escola', group: 'operacao', visible: mod('escola') },
  { viewMode: 'reservas', label: 'Reservas', group: 'operacao', visible: mod('reservas') },
  { viewMode: 'assinaturas', label: 'Assinaturas', group: 'financeiro', visible: mod('assinaturas') },
  { viewMode: 'comigo', label: 'Comigo', group: 'financeiro', visible: mod('copiloto') },
  { viewMode: 'catalog', label: 'Catálogo', group: 'vendas', visible: mod('catalogo') },
  { viewMode: 'vendas', label: 'Vendas', group: 'vendas', visible: mod('vendas') },
  { viewMode: 'retailops', label: 'Operação da Rede', group: 'operacao', visible: mod('retail') },
  { viewMode: 'notas_entrada', label: 'Notas de Entrada', group: 'operacao', visible: mod('retail') },
  { viewMode: 'retailfloor', label: 'Atendimento de Loja', group: 'vendas', visible: mod('retail_floor') },
  { viewMode: 'sales_coach', label: 'Coach de Vendas', group: 'vendas', visible: c => c.coachAvailable },
  { viewMode: 'compras', label: 'Compras', group: 'operacao', visible: mod('compras') },
  { viewMode: 'orcamentos', label: 'Orçamentos', group: 'vendas', visible: mod('orcamentos') },
  { viewMode: 'eventos', label: 'Eventos & Grupos', group: 'operacao', visible: mod('eventos') },
  { viewMode: 'storefront', label: 'Loja Virtual', group: 'vendas', visible: mod('loja') },
  { viewMode: 'campanhas', label: 'Campanhas', group: 'marketing', visible: mod('campanhas') },
  { viewMode: 'cadencias', label: 'Cadências', group: 'marketing', visible: mod('cadencias') },
  { viewMode: 'vision', label: 'Vision VMS', group: 'operacao', visible: mod('vms') },
  { viewMode: 'radar', label: 'Radar de Execução IA', group: 'ia', visible: mod('radar') },
  { viewMode: 'channels', label: 'Canais e I.A.', group: 'administracao', visible: always },
  { viewMode: 'areas', label: 'Áreas de Atend.', group: 'administracao', visible: mod('areas') },
  { viewMode: 'contacts', label: 'Contatos', group: 'vendas', visible: always },
  { viewMode: 'integrations', label: 'Integrações', group: 'administracao', visible: mod('integracoes') },
  { viewMode: 'dashboard', label: 'Atendimento Digital', group: 'ia', visible: always },
  { viewMode: 'caixa', label: 'Caixa', group: 'financeiro', visible: c => c.canAccessModule('financeiro') },
  { viewMode: 'reports', label: 'Relatórios', group: 'ia', visible: always },
  { viewMode: 'juridico', label: 'Consultora Jurídica', group: 'administracao', visible: always },
  { viewMode: 'manifesto', label: 'Manifesto da Marca', group: 'marketing', visible: always },
  { viewMode: 'escuta', label: 'Escuta Ativa', group: 'ia', visible: always },
  { viewMode: 'grupo', label: 'Grupo', group: 'administracao', visible: c => c.groupAvailable },
  { viewMode: 'settings', label: 'Configurações', group: 'administracao', visible: always },
  { viewMode: 'admin', label: 'Admin Master', group: 'administracao', visible: master },
  { viewMode: 'product_evolution', label: 'Product Evolution', group: 'administracao', visible: master },
  { viewMode: 'ai_usage', label: 'Consumo de IA', group: 'administracao', visible: master },
  { viewMode: 'niche_intel', label: 'Inteligência de Nicho', group: 'administracao', visible: master },
  { viewMode: 'production_readiness', label: 'Prontidão de Produção', group: 'administracao', visible: master },
  { viewMode: 'radar_consultant', label: 'Radar — Consultor', group: 'administracao', visible: master },
  { viewMode: 'radar_health', label: 'Radar — Saúde', group: 'administracao', visible: c => c.isManager },
  { viewMode: 'falatu', label: 'FalaTu', group: 'ia', visible: c => c.isMasterAdmin || (c.falatuEnabled && c.canAccessModule('falatu')) },
];

export interface PrimaryNav { key: 'hoje' | 'falatu' | 'executando' | 'resultados' | 'empresa'; label: string; viewMode: string; }

/**
 * Os 5 itens de 1º nível, cada um apontando para uma tela JÁ existente (destino interino —
 * Hoje já é tela própria (F2.3); F2.4..F2.6 trocam os demais). Só aparecem se o destino é visível sob o gate legado
 * (RBAC/plano preservados, RN-F2-3). "Empresa" = gestor.
 */
export function primaryNav(c: NavCtx): PrimaryNav[] {
  const ok = (vm: string) => NAV_CATALOG.find(e => e.viewMode === vm)?.visible(c) === true;
  const out: PrimaryNav[] = [];
  out.push({ key: 'hoje', label: 'Hoje', viewMode: 'hoje' });   // F2.3 — tela própria (cockpit por exceção)
  if (ok('falatu')) out.push({ key: 'falatu', label: 'FalaTu', viewMode: 'falatu' });
  // F2.4 — fachada única sobre ações, processos, missões e tarefas; sempre disponível (lane vazia é honesta).
  out.push({ key: 'executando', label: 'Executando', viewMode: 'executando' });
  // F2.5 — Resultados: conclusão → rede → lojas → Entender (tela própria, sempre disponível).
  out.push({ key: 'resultados', label: 'Resultados', viewMode: 'resultados' });
  if (c.isManager || c.isMasterAdmin) out.push({ key: 'empresa', label: 'Empresa', viewMode: 'empresa' });
  return out;
}

/** Explorar: tudo que o usuário pode ver, agrupado; `q` filtra por rótulo (sem acento/caixa). */
export function exploreGroups(c: NavCtx, q = ''): Array<{ group: NavGroup; label: string; items: NavEntry[] }> {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const nq = norm(q.trim());
  const vis = NAV_CATALOG.filter(e => e.visible(c) && (!nq || norm(e.label).includes(nq)));
  const order = Object.keys(NAV_GROUP_LABEL) as NavGroup[];
  return order
    .map(g => ({ group: g, label: NAV_GROUP_LABEL[g], items: vis.filter(e => e.group === g) }))
    .filter(g => g.items.length > 0);
}
