/**
 * SEED — Product Evolution Ledger (ADR-193 F5).
 *
 * Popula o ledger com as 26 iniciativas mapeadas na Fase 0 do PRD-PEL-01
 * (`docs/product-evolution/INITIAL-GAP-MATRIX.md`). Cada linha vira 1 item +
 * 1..N sources com ADRs/PRDs referenciados; o status inicial é levado até o
 * estado sugerido na matriz via `seedProgressTo` (respeita STATUS_GRAPH).
 *
 * IDEMPOTENTE:
 *   - item que já existe → skip create; ainda ajusta status se diverge.
 *   - source que já existe (mesmo source_type + source_reference) → skip.
 *   - evidence NÃO é populada aqui (o próprio ledger separa "estado" de
 *     "evidência verificada" — F1 RN-PEL-4; anexar evidência real é
 *     trabalho manual da revisão humana).
 *
 * Uso:
 *   npm run seed:product-evolution-ledger
 *   npm run seed:product-evolution-ledger -- --dry-run     (não escreve)
 *
 * Sem side-effect externo (só SQLite local em DATA_DIR). Safe pra re-rodar.
 */
import { ProductEvolutionLedgerService as PEL, Status, SourceType } from "../src/server/ProductEvolutionLedgerService.js";
import db from "../src/server/db.js";

const DRY_RUN = process.argv.includes("--dry-run");

interface SeedSource {
  source_type: SourceType;
  title: string;
  source_reference?: string;
  notes?: string;
}

interface SeedDependency {
  depends_on_key: string;
  dependency_type: "requires" | "enhances" | "blocks" | "related";
  notes?: string;
}

interface SeedItem {
  evolution_key: string;
  title: string;
  domain: string;
  summary: string;
  priority?: "P0" | "P1" | "P2" | "P3";
  risk_level?: "low" | "medium" | "high";
  source_of_truth?: string;
  blocked_reason?: string;
  target_status: Status;
  /** Necessário quando target_status === "SUPERSEDED". Aponta pro
   *  `evolution_key` que substituiu esta iniciativa. */
  superseded_by?: string;
  sources: SeedSource[];
  /** Arestas do grafo de dependência (STATUS-DE-EXECUCAO §5.4).
   *  Idempotente via UNIQUE (item, depends_on, type). */
  dependencies?: SeedDependency[];
}

// Dados curados a partir de docs/product-evolution/INITIAL-GAP-MATRIX.md.
// Ordem: id da linha na matriz.
const SEED: SeedItem[] = [
  // ─── Governança / Operating Layers ───
  {
    evolution_key: "CEO_OPERATING_LAYER",
    title: "CEO Operating Layer",
    domain: "governance",
    summary: "Camada composicional sobre business_signals/missions com Executive*Service e rota /api/executive.",
    source_of_truth: "ADR-190",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-190 — CEO Operating Layer (F0–F11 em produção)", source_reference: "docs/adr/ADR-190-ceo-operating-layer.md" },
      { source_type: "adr", title: "ADR-192 — Coerência Comercial Verticais", source_reference: "docs/adr/ADR-192-coerencia-comercial-verticais.md" },
      { source_type: "prd", title: "Análise CEO Operating Layer vs Codebase", source_reference: "docs/prd/ANALISE-CEO-OPERATING-LAYER-vs-CODEBASE.md" },
    ],
  },
  {
    evolution_key: "MISSION_OPERATING_LAYER",
    title: "Mission Operating Layer",
    domain: "governance",
    summary: "MissionService/Runtime/Checkpoint/Debrief + tabela missions + flag mission_layer_enabled. F0–F28 em produção, F29 em PR.",
    source_of_truth: "ADR-189",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-189 — Mission Operating Layer & Simplificação Radical", source_reference: "docs/adr/ADR-189-mission-operating-layer.md" },
      { source_type: "prd", title: "Análise Mission Simplification vs Codebase", source_reference: "docs/prd/ANALISE-MISSION-SIMPLIFICATION-vs-CODEBASE.md" },
    ],
  },
  {
    evolution_key: "DECISION_INTELLIGENCE_RADAR",
    title: "Decision Intelligence / Radar",
    domain: "governance",
    summary: "DecisionEngine + Radar* services + business_signals + 25+ testes. Pipeline evidence→analyze→trace.",
    source_of_truth: "ADR-136",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-136 — Decision-Action Ledger", source_reference: "docs/adr/ADR-136-decision-action-ledger.md" },
      { source_type: "adr", title: "ADR-161 — Radar Empresarial", source_reference: "docs/adr/ADR-161-radar-empresarial-percepcao-transversal.md" },
      { source_type: "prd", title: "Análise PRD2 Radar vs Repo", source_reference: "docs/prd/ANALISE-PRD2-RADAR-vs-REPO.md" },
    ],
  },
  {
    evolution_key: "EXECUTION_RUNTIME_ZAPPFLOW",
    title: "Execution Runtime (ZappFlow)",
    domain: "governance",
    summary: "ExecutionResults/Trace services + /api/runtime. Armazenamento via colunas JSON — precisa revisão de tabelas dedicadas.",
    source_of_truth: "ADR-152",
    target_status: "TESTED",
    blocked_reason: "storage via JSON pode limitar rastreabilidade agregada; revisar em F1.5+",
    sources: [
      { source_type: "adr", title: "ADR-152 — ZappFlow Execution Runtime", source_reference: "docs/adr/ADR-152-zappflow-execution-runtime.md" },
      { source_type: "prd", title: "PRD ZappFlow Execution Runtime", source_reference: "docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md" },
      { source_type: "file", title: "docs/execution-runtime/STATUS-DE-EXECUCAO.md", source_reference: "docs/execution-runtime/STATUS-DE-EXECUCAO.md" },
    ],
  },

  // ─── Verticais em produção ou avançados ───
  {
    evolution_key: "FALA_TU",
    title: "Fala Tu",
    domain: "verticals",
    summary: "20+ FalaTu*Service, 19 tabelas, 40+ testes. ADR-151 fechado; ADR-154 (standalone metering) rascunho.",
    source_of_truth: "ADR-151",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-151 — Fala Tu Captura Multimodal", source_reference: "docs/adr/ADR-151-falatu-captura-multimodal.md" },
      { source_type: "prd", title: "Análise Comparativa PRD1 Fala Tu vs Repo", source_reference: "docs/prd/ANALISE-COMPARATIVA-PRD1-FALATU-vs-REPO.md" },
    ],
  },
  {
    evolution_key: "RETAIL_FLOOR_TOULON",
    title: "Retail Floor / TOULON",
    domain: "verticals",
    summary: "~16 RetailFloor* services + ~40 tabelas retail_*. Estabilização TOULON exige validação em campo.",
    source_of_truth: "ADR-175",
    target_status: "PILOT",
    blocked_reason: "Precisa validar com dados reais Alterdata e homologação TOULON no ar",
    sources: [
      { source_type: "adr", title: "ADR-175 — Retail Floor Talão Atendimento", source_reference: "docs/adr/ADR-175-retail-floor-talao-atendimento.md" },
      { source_type: "adr", title: "ADR-176 — Retail Floor Reposição Ruptura", source_reference: "docs/adr/ADR-176-retail-floor-reposicao-ruptura.md" },
      { source_type: "prd", title: "Análise PDR Estabilização TOULON", source_reference: "docs/prd/ANALISE-PDR-ESTABILIZACAO-TOULON.md" },
    ],
  },
  {
    evolution_key: "PETSHOP",
    title: "Petshop",
    domain: "verticals",
    summary: "Vertical composta VAREJO+CLÍNICA+SERVIÇOS via verticals.ts + módulo Clinic (ClinicPet*Service). Falta ADR próprio.",
    target_status: "IMPLEMENTING",
    blocked_reason: "Sem ADR próprio nem PRD dedicado — composição implícita",
    sources: [
      { source_type: "file", title: "src/server/verticals.ts (definição petshop)", source_reference: "src/server/verticals.ts" },
      { source_type: "manual", title: "Composição VAREJO+CLÍNICA+SERVIÇOS via preset", notes: "Sem ADR próprio" },
    ],
  },
  {
    evolution_key: "AGENDA_FEDERADA",
    title: "Agenda Federada",
    domain: "verticals",
    summary: "AppointmentService + Professional* + LegalProfessionalFederation. MVP F0–F1+ fechado.",
    source_of_truth: "ADR-180",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-180 — Professional Identity Federated Calendar", source_reference: "docs/adr/ADR-180-professional-identity-federated-calendar.md" },
      { source_type: "adr", title: "ADR-060 — Appointment Service Agenda", source_reference: "docs/adr/ADR-060-appointment-service-agenda.md" },
    ],
  },
  {
    evolution_key: "BEAUTY_SALOES",
    title: "Beauty (salões)",
    domain: "verticals",
    summary: "13 Beauty* services, 8 tabelas beauty_*, ~30 testes incluindo golden-paths e tenant-B.",
    source_of_truth: "ADR-169",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-169 — Vertical Beleza Salões", source_reference: "docs/adr/ADR-169-vertical-beleza-saloes.md" },
      { source_type: "prd", title: "Análise PRD Beleza Salões vs Codebase", source_reference: "docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md" },
    ],
  },
  {
    evolution_key: "ADVOCACIA",
    title: "Advocacia",
    domain: "verticals",
    summary: "13 Legal* services, 8 tabelas legal_*, 19 testes plan-gated + hardening + federation.",
    source_of_truth: "ADR-191",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-191 — Vertical Advocacia (F0–F12 + UI fechadas)", source_reference: "docs/adr/ADR-191-vertical-advocacia.md" },
      { source_type: "adr", title: "ADR-178 — Legal Trabalhista Scaffold", source_reference: "docs/adr/ADR-178-legal-trabalhista-scaffold.md" },
    ],
  },

  // ─── Content, Growth, Social, Intelligence, Reputation ───
  {
    evolution_key: "CONTENT_GROWTH_ENGINE",
    title: "Content & Growth Engine",
    domain: "growth",
    summary: "Content*/Growth* services + tabelas de atribuição. Falta rota consolidada — endpoints dispersos.",
    source_of_truth: "ADR-168",
    target_status: "TESTED",
    blocked_reason: "Consolidar rota /api/content ou /api/growth antes de exposição externa",
    sources: [
      { source_type: "adr", title: "ADR-168 — Content Growth Intelligence Loop", source_reference: "docs/adr/ADR-168-content-growth-intelligence-loop.md" },
      { source_type: "prd", title: "Análise PRD11 vs Codebase", source_reference: "docs/prd/ANALISE-PRD11-vs-CODEBASE.md" },
    ],
  },
  {
    evolution_key: "SOCIAL_PROVIDERS",
    title: "Social Providers",
    domain: "growth",
    summary: "SocialChannelProvider + Instagram/Facebook/Google prontos; TikTok/LinkedIn/X mencionados sem adapters.",
    source_of_truth: "ADR-167",
    target_status: "TESTED",
    blocked_reason: "Adapters TikTok/LinkedIn/X + credenciais OAuth de terceiros. Meta Ads/Google Ads deferidos.",
    sources: [
      { source_type: "adr", title: "ADR-167 — Final Integration Social Intelligence (F0–F18 em produção)", source_reference: "docs/adr/ADR-167-final-integration-social-intelligence.md" },
      { source_type: "prd", title: "Análise PRD10 vs Codebase", source_reference: "docs/prd/ANALISE-PRD10-vs-CODEBASE.md" },
    ],
  },
  {
    evolution_key: "INTELLIGENCE_HUB",
    title: "Competitor / Vertical / Social Intelligence",
    domain: "growth",
    priority: "P1",
    summary: "Track B (Content Competitor Intelligence) entregue: ledger de contas monitoradas + storage de posts + classificação por VRE + insights agregados + crossover no Estúdio. vertical_intelligence GLOBAL persiste como legado (provider externo stub).",
    source_of_truth: "ADR-156",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-156 — External Intelligence Vertical Compartilhada", source_reference: "docs/adr/ADR-156-external-intelligence-vertical-compartilhada.md" },
      { source_type: "adr", title: "ADR-157 — Automação Curadoria Longitudinal", source_reference: "docs/adr/ADR-157-external-intelligence-automacao-curadoria-longitudinal.md" },
      { source_type: "file", title: "CompetitorIntelligenceService (Track B F1)", source_reference: "src/server/CompetitorIntelligenceService.ts" },
      { source_type: "file", title: "CompetitorPostsService + Classification + Insights (Track B F2-F4)", source_reference: "src/server/CompetitorInsightsService.ts" },
      { source_type: "file", title: "UI crossover em StudioView (Track B F5)", source_reference: "src/features/StudioView.tsx", notes: "Card 'O que seus concorrentes estão usando'" },
    ],
  },
  {
    evolution_key: "VISUAL_RECIPE_ENGINE",
    title: "Visual Recipe Engine (Track A P0)",
    domain: "studio",
    priority: "P0",
    summary: "Track A entregue: StudioVisualRecipeService com dropdown de recipes + inputs + generate, analytics de uso, sugestão a partir de briefing (F3.5), aliases per-org (F5). ADR-194 formaliza o motor. UI integrada no StudioView.",
    source_of_truth: "ADR-194",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-194 — Visual Recipe Engine", source_reference: "docs/adr/ADR-194-visual-recipe-engine.md" },
      { source_type: "file", title: "StudioVisualRecipeService", source_reference: "src/server/StudioVisualRecipeService.ts" },
      { source_type: "file", title: "UI no StudioView (Track A F3-F5)", source_reference: "src/features/StudioView.tsx" },
    ],
    dependencies: [
      { depends_on_key: "STUDIO_IMAGE_GEN_CORE", dependency_type: "enhances",
        notes: "STATUS §5.4 — motor base do Studio é opcional; VRE reusa o pipeline Imagen/Veo mas pode ser trocado." },
    ],
  },
  {
    evolution_key: "BUSINESS_SKILLS_PACK",
    title: "Business Skills Pack (Pricing 360 / RFP-RFQ / Local Marketing)",
    domain: "platform",
    priority: "P1",
    summary: "Track C entregue: fachada aditiva BusinessSkillsPackService sobre services vertical-específicos (RN-BSP-02). F1 Pricing 360 + F2 RFP templates + F3 Local Marketing enrichment + F4 gate por dimensão com soft launch + F5 aba UI em Configurações. 194 checks de teste totais.",
    source_of_truth: "ADR-195",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "prd", title: "PRD-BSP-01 — ZapFlow Business Skills Pack", source_reference: "docs/prd/PRD-BSP-01-business-skills-pack.md" },
      { source_type: "adr", title: "ADR-195 — Business Skills Pack", source_reference: "docs/adr/ADR-195-business-skills-pack.md" },
      { source_type: "file", title: "BusinessSkillsPackService (fachada aditiva)", source_reference: "src/server/BusinessSkillsPackService.ts" },
      { source_type: "file", title: "Rotas /api/bsp/*", source_reference: "src/server/routes/bsp.ts" },
      { source_type: "file", title: "UI aba Business Skills Pack em Configurações", source_reference: "src/features/settings/BspSettingsPanel.tsx" },
      { source_type: "file", title: "Services vertical intactos (RN-BSP-02)", source_reference: "src/server/pricing.ts" },
    ],
  },
  {
    evolution_key: "VISION_VMS_CONTROL_PLANE",
    title: "Vision VMS Control Plane",
    domain: "vision",
    summary: "Control plane completo em apps/vision-cloud/ (~2.6k linhas). Nenhuma câmera real publica ocupação — recordObservation alimentado à mão.",
    source_of_truth: "ADR-001",
    target_status: "TESTED",
    blocked_reason: "Ausência de Vision Edge Perception; precisa validar com dispositivo real ONVIF/RTSP",
    sources: [
      { source_type: "adr", title: "ADR-001..008 — Vision VMS foundation", source_reference: "docs/adr/ADR-001-vision-edge-runtime.md" },
      { source_type: "prd", title: "PRD Vision VMS", source_reference: "docs/PRD-VISION-VMS.md" },
    ],
    dependencies: [
      { depends_on_key: "VISION_EDGE_PERCEPTION", dependency_type: "requires",
        notes: "STATUS §5.4 — Vision VMS Control Plane só sai de TESTED (PILOT/PRODUCTION) quando houver runtime de Edge Perception real (câmera ONVIF/RTSP publicando ocupação)." },
    ],
  },
  {
    evolution_key: "VISION_EDGE_PERCEPTION",
    title: "Vision Edge Perception (Track E P1)",
    domain: "vision",
    priority: "P1",
    summary: "apps/edge/ NÃO é Vision Edge — é a Continuity Layer (ADR-082). Nenhum ONVIFAdapter, FrameSampler, PersonDetector escrito.",
    target_status: "IDEA",
    blocked_reason: "ADR-001 adia escolha de runtime (Node/Go/Rust) para pós-laboratório; precisa dispositivo real antes de codar",
    sources: [
      { source_type: "adr", title: "ADR-001 — Vision Edge Runtime (parcial, adiado)", source_reference: "docs/adr/ADR-001-vision-edge-runtime.md" },
      { source_type: "prd", title: "PRD-PEL-01 §16 Closure Track E", notes: "Não checked-in" },
    ],
  },
  {
    evolution_key: "WIFI_PRESENCE_CSI",
    title: "Wi-Fi Presence / CSI (Track F P1/P2)",
    domain: "vision",
    priority: "P2",
    summary: "Puramente conceitual. Sem ADR, sem código, sem dados. F0–F4: hardware study → lab POC → calibration → site pilot → production decision.",
    target_status: "IDEA",
    blocked_reason: "Requer hardware CSI-capable; sem ADR, sem código",
    sources: [
      { source_type: "prd", title: "PRD-PEL-01 §17 Closure Track F", notes: "Não checked-in" },
    ],
  },
  {
    evolution_key: "ZAPFLOW_SENSE",
    title: "Sensor Fusion / ZapFlow Sense (Track G)",
    domain: "vision",
    priority: "P2",
    summary: "Depende de VISION_EDGE_PERCEPTION e WIFI_PRESENCE_CSI, ambos NÃO EXISTE. Sem observações físicas para fundir.",
    target_status: "IDEA",
    blocked_reason: "Depende de Vision Edge Perception e Wi-Fi CSI (ambos NÃO EXISTE)",
    sources: [
      { source_type: "prd", title: "PRD-PEL-01 §18 Closure Track G", notes: "Não checked-in" },
    ],
    dependencies: [
      { depends_on_key: "VISION_EDGE_PERCEPTION", dependency_type: "requires",
        notes: "STATUS §5.4 — ZAPFLOW_SENSE depende de observações físicas de Vision Edge (câmera/pessoa)." },
      { depends_on_key: "WIFI_PRESENCE_CSI", dependency_type: "requires",
        notes: "STATUS §5.4 — ZAPFLOW_SENSE depende do sinal Wi-Fi/CSI pra fusão sensorial." },
    ],
  },
  {
    evolution_key: "PLATFORM_RELIABILITY_CAPACITY",
    title: "Platform Reliability & Capacity Intelligence",
    domain: "platform",
    summary: "ADR-164 F0–F14 + fatias de ambiente em produção. 10 services + 3 tabelas globais + 11 testes.",
    source_of_truth: "ADR-164",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-164 — Platform Trust, Reliability & Capacity Intelligence", source_reference: "docs/adr/ADR-164-platform-reliability-capacity.md" },
      { source_type: "prd", title: "Análise PRD7 vs Codebase e Infra", source_reference: "docs/prd/ANALISE-PRD7-vs-CODEBASE-E-INFRA.md" },
      { source_type: "file", title: "docs/runbook/platform-operacao.md", source_reference: "docs/runbook/platform-operacao.md" },
    ],
  },
  {
    evolution_key: "INTEGRATION_FACTORY",
    title: "Integration Factory",
    domain: "platform",
    priority: "P2",
    summary: "Conectores específicos (Alterdata + Instagram/Google OAuth). Sem 'fábrica' abstrata — cada conector é service+route dedicado.",
    target_status: "IMPLEMENTING",
    blocked_reason: "Sem ADR/PRD de fábrica; decisão pendente entre reengenharia da tabela integrations ou pacote novo",
    sources: [
      { source_type: "file", title: "docs/integrations/alterdata-fase2-vendas.md", source_reference: "docs/integrations/alterdata-fase2-vendas.md" },
      { source_type: "file", title: "src/server/AlterdataConnectorService.ts", source_reference: "src/server/AlterdataConnectorService.ts" },
    ],
  },
  {
    evolution_key: "RECLAME_AQUI_INTELLIGENCE",
    title: "Reclame Aqui Intelligence",
    domain: "growth",
    priority: "P3",
    summary: "ADR-162 F0–F14: espinha completa (~17 services, rota, tabelas). Ingestão externa gated por flag reclame_aqui_connector_enabled.",
    source_of_truth: "ADR-162",
    target_status: "TESTED",
    blocked_reason: "Requer contrato/parceria com Reclame AQUI (API oficial)",
    sources: [
      { source_type: "adr", title: "ADR-162 — Customer Recovery & Reputation Intelligence (PRD 5)", source_reference: "docs/adr/ADR-162-customer-recovery-reputation-intelligence.md" },
      { source_type: "file", title: "docs/runbook/reputation-operacao.md", source_reference: "docs/runbook/reputation-operacao.md" },
    ],
  },
  {
    evolution_key: "ENTERPRISE_INTELLIGENCE_CONTROLER",
    title: "Enterprise Intelligence / CONTROLER",
    domain: "governance",
    summary: "Dois blocos: Enterprise Learning (ADR-166 F0–F14) + CONTROLER operacional (7 services, 6 tabelas). Wired em /api/controler e /api/decision-intelligence.",
    source_of_truth: "ADR-166",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-166 — Enterprise Learning & External Intelligence 2.0 (PRD 9)", source_reference: "docs/adr/ADR-166-enterprise-learning-external-intelligence.md" },
      { source_type: "adr", title: "ADR-135 — Enterprise Intelligence Kernel", source_reference: "docs/adr/ADR-135-enterprise-intelligence-kernel.md" },
      { source_type: "prd", title: "Análise PRD9 vs Codebase", source_reference: "docs/prd/ANALISE-PRD9-vs-CODEBASE.md" },
    ],
  },
  {
    evolution_key: "AI_RELIABILITY",
    title: "AI Reliability / Outcome Assurance",
    domain: "platform",
    summary: "ADR-165 F0–F13. AiReliabilityKernel + governance + grounding + orchestrator + Outcome Assurance com metrics/reconciler/correction.",
    source_of_truth: "ADR-165",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-165 — Universal Closed Loop & Outcome Assurance (PRD 8)", source_reference: "docs/adr/ADR-165-universal-closed-loop-outcome-assurance.md" },
      { source_type: "prd", title: "Análise PRD8 vs Codebase", source_reference: "docs/prd/ANALISE-PRD8-vs-CODEBASE.md" },
      { source_type: "file", title: "docs/runbook/outcome-assurance-operacao.md", source_reference: "docs/runbook/outcome-assurance-operacao.md" },
    ],
  },

  // ─── Dependência descoberta ───
  {
    evolution_key: "STUDIO_IMAGE_GEN_CORE",
    title: "Studio base — motor Gemini/Veo + OpenAI fallback",
    domain: "studio",
    summary: "llm.ts com Google Imagen (imagen-3.0) via GEMINI_API_KEY + fallback OpenAI + Veo para vídeo. StudioService, FashionStudio, StorefrontLook — pipeline pronta pra reuso pelo VISUAL_RECIPE_ENGINE.",
    source_of_truth: "ADR-042",
    target_status: "PRODUCTION",
    sources: [
      { source_type: "adr", title: "ADR-042 — Fashion Studio Provedor Google Gemini", source_reference: "docs/adr/ADR-042-fashion-studio-provedor-google-gemini.md" },
      { source_type: "adr", title: "ADR-034 — Fashion Studio Fase 0 Fundação", source_reference: "docs/adr/ADR-034-fashion-studio-fas0-fundacao.md" },
      { source_type: "file", title: "src/server/llm.ts (generateImageB64 + startVideoGoogle)", source_reference: "src/server/llm.ts" },
    ],
  },

  // ─── SUPERSEDED (STATUS-DE-EXECUCAO §5.5) ───
  // Registrar como SUPERSEDED evita re-abertura desses PRDs históricos.
  {
    evolution_key: "SOCIAL_INTELLIGENCE_PRD10_LEGACY",
    title: "Social Intelligence (PRD 10 histórico)",
    domain: "growth",
    summary: "PRD 10 original de Social Intelligence — visão conceitual pré-consolidação. Absorvido por ADR-167 (Social Providers) + INTELLIGENCE_HUB atual.",
    target_status: "SUPERSEDED",
    superseded_by: "INTELLIGENCE_HUB",
    sources: [
      { source_type: "prd", title: "ANALISE-PRD10-vs-CODEBASE", source_reference: "docs/prd/ANALISE-PRD10-vs-CODEBASE.md" },
      { source_type: "adr", title: "ADR-167 — Final Integration Social Intelligence", source_reference: "docs/adr/ADR-167-final-integration-social-intelligence.md" },
    ],
  },
  {
    evolution_key: "VERTICAL_INTELLIGENCE_HUB_LEGACY",
    title: "Vertical Intelligence Hub (histórico)",
    domain: "growth",
    summary: "Iteração histórica do Vertical Intelligence Hub antes da consolidação em vertical_intelligence GLOBAL + provider externo. Superseded pela INTELLIGENCE_HUB atual (ADR-156 + Track B).",
    target_status: "SUPERSEDED",
    superseded_by: "INTELLIGENCE_HUB",
    sources: [
      { source_type: "adr", title: "ADR-135 — Enterprise Intelligence baseline", source_reference: "docs/adr/ADR-135-enterprise-intelligence-kernel.md" },
      { source_type: "adr", title: "ADR-156 — External Intelligence Vertical Compartilhada", source_reference: "docs/adr/ADR-156-external-intelligence-vertical-compartilhada.md" },
    ],
  },
  {
    evolution_key: "ENTERPRISE_INTELLIGENCE_PRE_ADR166_LEGACY",
    title: "Enterprise Intelligence (pré-ADR-166)",
    domain: "governance",
    summary: "Design de Enterprise Intelligence anterior à ADR-166 (CONTROLER Operational + Enterprise Learning). Absorvido pela iniciativa ENTERPRISE_INTELLIGENCE_CONTROLER atual.",
    target_status: "SUPERSEDED",
    superseded_by: "ENTERPRISE_INTELLIGENCE_CONTROLER",
    sources: [
      { source_type: "adr", title: "ADR-135 — Enterprise Intelligence (baseline pré-166)", source_reference: "docs/adr/ADR-135-enterprise-intelligence-kernel.md" },
      { source_type: "adr", title: "ADR-166 — Enterprise Learning + External Intelligence (versão vigente)", source_reference: "docs/adr/ADR-166-enterprise-learning-external-intelligence.md" },
    ],
  },
];

// ═══════════════ Runner ═══════════════

interface Summary {
  created: string[];
  skipped_existing: string[];
  status_bumped: Array<{ key: string; from: string; to: string }>;
  sources_added: Array<{ key: string; count: number }>;
  dependencies_added: Array<{ key: string; count: number }>;
  errors: Array<{ key: string; error: string }>;
}

function sourceKey(itemKey: string, src: SeedSource): string {
  return `${itemKey}::${src.source_type}::${src.source_reference || src.title}`;
}

/** Upsert idempotente das arestas de dependência.
 *  `addDependency` já é idempotente por UNIQUE (item, depends_on, type)
 *  — usamos `listDependencies.outgoing` pra saber quantas SÃO novas. */
function upsertDependencies(itemKey: string, deps: SeedDependency[]): number {
  if (!deps || deps.length === 0) return 0;
  const before = new Set(PEL.listDependencies(itemKey).outgoing.map(
    d => `${d.depends_on_key}::${d.dependency_type}`,
  ));
  let added = 0;
  for (const d of deps) {
    const k = `${d.depends_on_key}::${d.dependency_type}`;
    if (before.has(k)) continue;
    if (DRY_RUN) { added++; continue; }
    PEL.addDependency({
      evolution_key: itemKey,
      depends_on_key: d.depends_on_key,
      dependency_type: d.dependency_type,
      notes: d.notes ?? null,
    });
    added++;
  }
  return added;
}

function upsertSources(itemKey: string, sources: SeedSource[]): number {
  // Busca fontes existentes por (source_type, source_reference OR title) pra dedup.
  const existing = PEL.listSources(itemKey);
  const existingKeys = new Set(existing.map(s => sourceKey(itemKey, {
    source_type: s.source_type as SourceType,
    title: s.title,
    source_reference: s.source_reference || undefined,
  })));
  let added = 0;
  for (const src of sources) {
    if (existingKeys.has(sourceKey(itemKey, src))) continue;
    if (DRY_RUN) { added++; continue; }
    PEL.addSource(itemKey, {
      source_type: src.source_type,
      title: src.title,
      source_reference: src.source_reference ?? null,
      notes: src.notes ?? null,
    });
    added++;
  }
  return added;
}

/**
 * Executa o seed. Reutilizável por testes (não chama process.exit).
 * Retorna o summary agregado.
 */
export async function runSeed(opts: { silent?: boolean } = {}): Promise<Summary> {
  const s: Summary = {
    created: [], skipped_existing: [], status_bumped: [], sources_added: [],
    dependencies_added: [], errors: [],
  };

  const log = opts.silent ? () => {} : console.log.bind(console);
  log(`\n=== Seed Product Evolution Ledger (${DRY_RUN ? "DRY-RUN" : "LIVE"}) ===`);
  log(`${SEED.length} iniciativas a processar\n`);

  for (const seed of SEED) {
    try {
      let item = PEL.getItem(seed.evolution_key);
      if (!item) {
        if (!DRY_RUN) {
          item = PEL.createItem({
            evolution_key: seed.evolution_key,
            title: seed.title,
            domain: seed.domain,
            summary: seed.summary,
            priority: seed.priority ?? null,
            risk_level: seed.risk_level ?? null,
            source_of_truth: seed.source_of_truth ?? null,
          });
          if (seed.blocked_reason) {
            PEL.updateItem(seed.evolution_key, { blocked_reason: seed.blocked_reason });
          }
        }
        s.created.push(seed.evolution_key);
      } else {
        s.skipped_existing.push(seed.evolution_key);
      }

      const added = upsertSources(seed.evolution_key, seed.sources);
      if (added > 0) s.sources_added.push({ key: seed.evolution_key, count: added });
      // Dependências ficam pra um 2º passo — ambos os endpoints do edge
      // precisam existir antes de addDependency, e o SEED não está em
      // ordem topológica (ex.: VRE aparece antes de STUDIO_IMAGE_GEN_CORE).

      if (!DRY_RUN && item) {
        const before = item.status;
        // SUPERSEDED é terminal — seedProgressTo não passa por ele
        // (precisa superseded_by). Caminho: IDEA → IMPLEMENTING via
        // seedProgressTo, depois setStatus explícito pra SUPERSEDED.
        if (seed.target_status === "SUPERSEDED") {
          if (!seed.superseded_by) {
            throw new Error(`SUPERSEDED requer superseded_by (${seed.evolution_key})`);
          }
          if (before !== "SUPERSEDED") {
            // Só avança até IMPLEMENTING se ainda não passou. Se já está
            // em IMPLEMENTING/CODED/TESTED/PILOT/PRODUCTION, pula direto.
            const activeStates: Status[] = [
              "IMPLEMENTING", "CODED", "TESTED", "PILOT", "PRODUCTION",
            ];
            if (!activeStates.includes(before as Status)) {
              PEL.seedProgressTo(seed.evolution_key, "IMPLEMENTING", "seed F5 → SUPERSEDED (via IMPLEMENTING)");
            }
            const after = PEL.setStatus(seed.evolution_key, {
              new_status: "SUPERSEDED",
              reason: `seed F5 → SUPERSEDED por ${seed.superseded_by}`,
              superseded_by: seed.superseded_by,
            }).status;
            if (before !== after) s.status_bumped.push({ key: seed.evolution_key, from: before, to: after });
          }
        } else {
          const after = PEL.seedProgressTo(seed.evolution_key, seed.target_status, `seed F5 → ${seed.target_status}`).status;
          if (before !== after) s.status_bumped.push({ key: seed.evolution_key, from: before, to: after });
        }
      }
    } catch (e: any) {
      s.errors.push({ key: seed.evolution_key, error: e?.message || String(e) });
    }
  }

  // ── 2º passo: dependências (após todos os items existirem) ──
  for (const seed of SEED) {
    if (!seed.dependencies || seed.dependencies.length === 0) continue;
    try {
      const depsAdded = upsertDependencies(seed.evolution_key, seed.dependencies);
      if (depsAdded > 0) s.dependencies_added.push({ key: seed.evolution_key, count: depsAdded });
    } catch (e: any) {
      s.errors.push({ key: `${seed.evolution_key} (deps)`, error: e?.message || String(e) });
    }
  }

  // Verifica coerência: quantos items existem no ledger agora
  const total = (db.prepare("SELECT COUNT(*) AS n FROM product_evolution_items").get() as any).n;

  log("─── Resultado ───");
  log(`criados:       ${s.created.length}${s.created.length ? ` (${s.created.slice(0, 5).join(", ")}${s.created.length > 5 ? "…" : ""})` : ""}`);
  log(`já existiam:   ${s.skipped_existing.length}`);
  log(`status ajustado: ${s.status_bumped.length}`);
  for (const b of s.status_bumped) log(`   ${b.key}: ${b.from} → ${b.to}`);
  log(`fontes anexadas: ${s.sources_added.reduce((a, b) => a + b.count, 0)}`);
  log(`dependências anexadas: ${s.dependencies_added.reduce((a, b) => a + b.count, 0)}`);
  log(`erros:         ${s.errors.length}`);
  for (const e of s.errors) log(`   ✗ ${e.key}: ${e.error}`);
  log(`\ntotal no ledger: ${total} items ${DRY_RUN ? "(dry-run — sem escrita)" : ""}`);

  return s;
}

// Entrypoint CLI — só executa quando invocado diretamente (não quando importado por teste).
// Como tsx roda o arquivo como se fosse o main sempre que ele é o arg, detectamos via
// URL match do processo argv1 com este arquivo.
const isMain = (() => {
  try {
    const invoked = process.argv[1] || "";
    return invoked.endsWith("seed-product-evolution-ledger.ts") ||
           invoked.endsWith("seed-product-evolution-ledger.js");
  } catch { return false; }
})();

if (isMain) {
  runSeed().then(s => process.exit(s.errors.length > 0 ? 1 : 0))
    .catch(e => { console.error(e); process.exit(1); });
}
