# INITIAL-GAP-MATRIX — Fase 0 do PRD-PEL-01

**Data da auditoria**: 2026-08-27
**Branch auditada**: `main` @ `c57a773`
**Autor**: Fase 0 automatizada (3 auditorias paralelas por cluster, revisão humana pendente)
**Escopo**: 25 iniciativas listadas em PRD-PEL-01 §11 + 1 iniciativa transversal (Studio base) descoberta durante a auditoria.

## Como ler este documento

Este arquivo é a **matriz inicial** do Product Evolution Ledger — não é o ledger em si (que virá como serviço em fatia futura). É o baseline que responde, com evidência de repo, à pergunta: *"cada iniciativa dessas foi implementada? em qual estado real?"*.

Cada linha carrega:

- **Chave (`evolution_key`)** — UPPER_SNAKE estável, conforme `CONVENCOES.md §1`.
- **Estado sugerido** — proposta baseada em evidência; humano confirma na revisão.
- **Evidência-chave** — ADRs, PRDs, services, rotas, tabelas, testes (paths reais).
- **Bloqueadores** — dependências externas ou decisões pendentes.

Estados sugeridos usam a taxonomia de `CONVENCOES.md §2`. O sub-estado `PRECISA VALIDAR COM DADOS REAIS` aparece quando o código existe mas nenhuma amostra observável permite classificar entre CODED e PRODUCTION — força revisão humana.

**Nenhuma linha desta matriz é vinculante.** É proposta. A Fase 3 (reconciliation engine) recalcula o estado a partir de evidências verificadas por humano.

## Sumário executivo

| Estado sugerido | Iniciativas | % |
| --- | ---: | ---: |
| `EXISTE` (production/tested) | 9 | 35% |
| `PARCIAL` (falta wiring, adapter, ou consolidação) | 8 | 31% |
| `PRECISA ADAPTAR` (espalhado, falta pacote unificado) | 1 | 4% |
| `PRECISA VALIDAR COM DADOS REAIS` | 1 | 4% |
| `NÃO EXISTE` (só ADR/PRD conceitual, ou nem isso) | 5 | 19% |
| `BLOQUEADO POR TERCEIRO` (dependência externa) | 2 | 8% |

Descoberta crítica destacada abaixo em `Gaps estruturais §Gap-2`: **PRD-BSP-01 não está checked-in no repo**.

## Matriz resumida

| # | `evolution_key` | Iniciativa | Estado sugerido | ADR(s) principais | Track PRD-PEL-01 |
| --: | --- | --- | --- | --- | --- |
| 1 | `CEO_OPERATING_LAYER` | CEO Operating Layer | EXISTE | ADR-190, ADR-192 | — |
| 2 | `MISSION_OPERATING_LAYER` | Mission Operating Layer | EXISTE | ADR-189 | — |
| 3 | `DECISION_INTELLIGENCE_RADAR` | Decision Intelligence / Radar | EXISTE | ADR-135, ADR-136, ADR-152, ADR-156, ADR-158, ADR-161 | — |
| 4 | `EXECUTION_RUNTIME_ZAPPFLOW` | Execution Runtime (ZappFlow) | PARCIAL | ADR-152, ADR-165 | — |
| 5 | `FALA_TU` | Fala Tu | EXISTE | ADR-151, ADR-154 (rascunho) | — |
| 6 | `RETAIL_FLOOR_TOULON` | Retail Floor / TOULON | PRECISA VALIDAR COM DADOS REAIS | ADR-083, ADR-150, ADR-170, ADR-175, ADR-176 | — |
| 7 | `PETSHOP` | Petshop | PARCIAL | — (composição via `verticals.ts`) | — |
| 8 | `AGENDA_FEDERADA` | Agenda Federada | EXISTE | ADR-060, ADR-180 | — |
| 9 | `BEAUTY_SALOES` | Beauty (salões) | EXISTE | ADR-169 | — |
| 10 | `ADVOCACIA` | Advocacia | EXISTE | ADR-178, ADR-191 | — |
| 11 | `CONTENT_GROWTH_ENGINE` | Content & Growth Engine | PARCIAL | ADR-168 | Track B (adjacente) |
| 12 | `SOCIAL_PROVIDERS` | Social Providers | PARCIAL / BLOQUEADO POR TERCEIRO | ADR-167 | Track B |
| 13 | `INTELLIGENCE_HUB` | Competitor / Vertical / Social Intelligence | PARCIAL | ADR-135, ADR-156, ADR-157, ADR-166, ADR-167 (F5) | Track B |
| 14 | `VISUAL_RECIPE_ENGINE` | Visual Recipe Engine | NÃO EXISTE | — (encosta em ADR-034–ADR-045) | Track A (P0) |
| 15 | `BUSINESS_SKILLS_PACK` | Business Skills Pack (Pricing/RFP/Local Mktg) | PRECISA ADAPTAR | — (fragmentado em ADR-023 e services por vertical) | Track C (P1) |
| 16 | `VISION_VMS_CONTROL_PLANE` | Vision VMS Control Plane | PARCIAL | ADR-001..ADR-008 | — |
| 17 | `VISION_EDGE_PERCEPTION` | Vision Edge Perception | NÃO EXISTE | ADR-001 (parcial), ADR-003, ADR-005 | Track E (P1) |
| 18 | `WIFI_PRESENCE_CSI` | Wi-Fi Presence / CSI | NÃO EXISTE | — | Track F (P1/P2, POC) |
| 19 | `ZAPFLOW_SENSE` | Sensor Fusion / ZapFlow Sense | NÃO EXISTE | — | Track G (após E/F) |
| 20 | `PLATFORM_RELIABILITY_CAPACITY` | Platform Reliability & Capacity Intelligence | EXISTE | ADR-164 | Track D (P1) |
| 21 | `INTEGRATION_FACTORY` | Integration Factory | PARCIAL | — (fragmentado em ADR de vertical) | P2 |
| 22 | `RECLAME_AQUI_INTELLIGENCE` | Reclame Aqui Intelligence | PARCIAL / BLOQUEADO POR TERCEIRO | ADR-162 | P3 (mas já muito avançado — reclassificar) |
| 23 | `ENTERPRISE_INTELLIGENCE_CONTROLER` | Enterprise Intelligence / CONTROLER | EXISTE | ADR-135, ADR-166 | — |
| 24 | `AI_RELIABILITY` | AI Reliability / Outcome Assurance | EXISTE | ADR-165 | — |
| 25 | `INTELLIGENCE_HUB_SUPERSEDED_LEGACY` | Social/Competitive Vertical Intelligence (PRDs históricos) | SUPERSEDED | ADR-135, ADR-156 | — |
| **X** | `STUDIO_IMAGE_GEN_CORE` | Studio base (motor Gemini/Veo + OpenAI fallback) | EXISTE | ADR-032, ADR-034–ADR-045 | — (dependência do Track A) |

## Detalhamento por iniciativa

Para cada linha da tabela acima, seção com evidência concreta.

### 1. `CEO_OPERATING_LAYER`
- **ADRs**: ADR-190 (CEO Operating Layer — F0–F11 em produção), ADR-192 (Coerência Comercial Verticais)
- **PRDs/análises**: `docs/prd/ANALISE-CEO-OPERATING-LAYER-vs-CODEBASE.md`, `docs/prd/ANALISE-ESTADO-FINAL-vs-REPO.md`
- **Services**: `src/server/ExecutiveMissionBridgeService.ts`, `ExecutiveAdvisorService.ts`, `ExecutiveVisionService.ts`, `ExecutiveBusinessSnapshotService.ts` + ~10 outros `Executive*Service.ts`
- **Rotas**: `src/server/routes/executive.ts` montado em `/api/executive` (server.ts:706) — `GET /briefing`, `/effectiveness`, `POST /ask`, `GET|PUT /vision`
- **Tabelas**: reutiliza `business_signals`, `decision_actions`, `missions` — sem tabelas dedicadas (aditivo puro)
- **Testes**: `scripts/test-ceo-golden-path.ts`, `test-ceo-hardening.ts`, `test-executive-*.ts` (10+)
- **Justificativa do estado**: ADR-190 declara F0–F11 fechado; camada composicional sobre `business_signals`/`missions` sem tabela própria; cobertura de testes densa incluindo hardening.

### 2. `MISSION_OPERATING_LAYER`
- **ADRs**: ADR-189 (Mission Operating Layer & Simplificação Radical — F0–F28 em produção, F29 em PR)
- **PRDs/análises**: `docs/prd/ANALISE-MISSION-SIMPLIFICATION-vs-CODEBASE.md`, `docs/prd/MISSION-REUSE-MATRIX.md`, `docs/prd/LEGACY-REDUCTION-PLAN.md`
- **Services**: `src/server/MissionService.ts`, `MissionRuntimeService.ts`, `MissionCheckpointService.ts`, `MissionDebriefService.ts`, `MissionIntentService.ts`, `MissionMetricsService.ts`, `MissionNextStepService.ts`, `MissionProactiveService.ts`, `MissionReadinessService.ts`, `MissionPilotReadinessService.ts`, `MissionReversePlanner.ts`
- **Rotas**: `src/server/routes/missions.ts` em `/api/missions` (server.ts:668), gate por `mission_layer_enabled`
- **Tabelas**: `missions` (`db.ts:10617`); colunas `mission_layer_enabled`, `mission_proactive_mode` em `organization_settings`
- **Testes**: 18 arquivos `scripts/test-mission-*.ts` (golden-path, contract, checkpoint, debrief, readiness, runtime, reverse-plan)
- **Bloqueadores**: F29 (prontidão ciente da métrica) em PR aberto — reduzir score de maturidade até merge.

### 3. `DECISION_INTELLIGENCE_RADAR`
- **ADRs**: ADR-135, ADR-136, ADR-152, ADR-156, ADR-158, ADR-161
- **PRDs/análises**: `docs/prd/ANALISE-PRD2-RADAR-vs-REPO.md`, `docs/prd/ANALISE-PRD3-CONTEXT-ENGINE-vs-REPO.md`, `docs/decision-intelligence/ANALISE-COMPARATIVA-PRD-vs-REPO.md`, `docs/decision-intelligence/PLANO-E-FATIAS.md`
- **Services**: `DecisionEngine.ts`, `DecisionActionService.ts`, `DecisionMetricsService.ts`, `DecisionRiskService.ts`, `DecisionSimulatorService.ts`, `RadarService.ts`, `RadarB2BService.ts`, `RadarConsultantService.ts`, `RadarHealthService.ts`, `RadarScoringEngine.ts`, `OpportunityRadarService.ts`, `BusinessSignalService.ts`, `ManipulationRadarService.ts`, `RecoveryRadarService.ts`
- **Rotas**: `/api/decision-intelligence`, `/api/radar`, `/api/opportunities`, `/api/radarB2B`, `/api/public/radar`; endpoints `POST /analyze`, `GET /evidence`, `GET /priorities`, `GET /trace/:correlationId`, `GET /assurance/action/:actionId`
- **Tabelas**: `business_signals` (db.ts:5954), `decision_actions` (:6241), `decision_risks`, `ai_decisions` (:6335), `action_execution_log`, `radar_templates`, `radar_questions`, `radar_sessions`, `radar_respondents`, `radar_evidence`, `radar_answers`, `radar_pillar_scores`, `radar_use_case_catalog`, `radar_recommendations`, `radar_consent_records`, `radar_consultation_requests`, `radar_velocity_snapshots`
- **Testes**: ~15 `test-decision-intelligence-di[1-5]*.ts` + 10 `test-radar-*.ts` + `test-decision-actions.ts`, `test-decision-simulator.ts`
- **Runbook**: `docs/runbook/radar-operacao.md` (mencionado no CLAUDE.md)

### 4. `EXECUTION_RUNTIME_ZAPPFLOW`
- **ADRs**: ADR-152 (ZappFlow Execution Runtime), ADR-165 (Universal Closed Loop, dependente do runtime)
- **PRDs/análises**: `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md` + 5 docs em `docs/execution-runtime/` (ANALISE-ARQUITETURAL, MATRIZ-DE-COBERTURA-DO-PRD, PLANO-DE-IMPLEMENTACAO, STATUS-DE-EXECUCAO, DECISOES-E-PENDENCIAS)
- **Services**: `ExecutionResultsService.ts`, `ExecutionTraceService.ts`, `SkillOsExecutionBridge.ts`, `AutoBookingCommandHandler.ts`, `BeautyReviewInviteCommandHandler.ts`, `ProspectExecutionService.ts`
- **Rotas**: `src/server/routes/runtime.ts` em `/api/runtime` — `POST /definitions`, `GET /definitions`, `POST /definitions/:id/active`, `POST /instances`
- **Tabelas**: colunas `execution_runtime_enabled`, `execution_mode`, `execution_log`, `execution_log_corr` em `organization_settings` e correlatas — **sem tabela `execution_traces` dedicada** (armazenamento via colunas JSON/log)
- **Testes**: `test-runtime-execute-e2e.ts`, `test-runtime-executor-execute.ts`, `test-execution-trace.ts`, `test-execution-trace-fullcycle.ts`, `test-command-executor.ts`, `test-skillos-execution-bridge.ts`, `test-ux-execution-results.ts`, `test-prospect-execution.ts`
- **Justificativa do estado (PARCIAL)**: PRD dedicado + trabalho ativo em fatias; services e rota wired mas armazenamento via colunas JSON pode limitar rastreabilidade agregada. Ler `docs/execution-runtime/STATUS-DE-EXECUCAO.md` para % real por fase (não fizemos leitura direta nesta Fase 0 — vale checar na revisão).

### 5. `FALA_TU`
- **ADRs**: ADR-151 (falatu-captura-multimodal — 5 fatias fechadas), ADR-154 (standalone AI metering + solo-RAG — RASCUNHO)
- **PRDs/análises**: `docs/prd/ANALISE-COMPARATIVA-PRD1-FALATU-vs-REPO.md`
- **Services** (20+): `FalaTuService.ts`, `FalaTuApprovalService.ts`, `FalaTuBridgeReconService.ts`, `FalaTuBriefingDigestService.ts`, `FalaTuBriefingTaskService.ts`, `FalaTuCaptureTokenService.ts`, `FalaTuEmailService.ts`, `FalaTuFileIntakeService.ts`, `FalaTuHomeService.ts`, `FalaTuMemoryEmbeddingsService.ts`, `FalaTuProactiveService.ts`, `FalaTuProtocolService.ts`, `FalaTuPurchaseService.ts`, `FalaTuPushService.ts`, `FalaTuReportService.ts`, `FalaTuSoloWhatsAppService.ts`, `FalaTuThreadService.ts`, `FalaTuWhatsAppService.ts`, `FalatuCheckoutService.ts`, `FalatuRefundService.ts`, `FalatuSaveOfferService.ts`
- **UI**: `src/falatu-app/FalatuApp.tsx`, `FalatuAuth.tsx`, `useFalatuTheme.ts`
- **Rotas**: `src/server/routes/{falatu,falatuIngest,falatuPublic,falatuSoloWhatsapp}.ts`
- **Tabelas** (19): `falatu_inbox_items`, `falatu_tasks`, `falatu_events`, `falatu_lists`, `falatu_list_items`, `falatu_entities`, `falatu_purchase_checks`, `falatu_briefing_deliveries`, `falatu_proactive_deliveries`, `falatu_memory_embeddings`, `falatu_capture_tokens`, `falatu_push_vapid`, `falatu_push_subscriptions`, `falatu_push_deliveries`, `falatu_email_optins`, `falatu_email_deliveries`, `falatu_protocols`, `falatu_protocol_activations`, `falatu_cancellation_intents`
- **Testes**: ~40 scripts `test-falatu-*.ts`

### 6. `RETAIL_FLOOR_TOULON`
- **ADRs**: ADR-083, ADR-150, ADR-170, ADR-175, ADR-176
- **PRDs/análises**: `docs/prd/ANALISE-PDR-ESTABILIZACAO-TOULON.md`, `docs/GO-LIVE-TOULON.md`, `docs/BACKLOG-CAMPO-TOULON.md`
- **Services** (~16): `RetailFloorService.ts`, `RetailFloorAnalyticsService.ts`, `RetailFloorAttendanceService.ts`, `RetailFloorDigestService.ts`, `RetailFloorPilotService.ts`, `RetailFloorReconciliationService.ts`, `RetailFloorReplenishmentService.ts`, `RetailFloorScanService.ts`, `RetailFloorShiftService.ts`, `RetailFloorSignalPublisher.ts`, `RetailStockPolicyService.ts`, `RetailStockModeService.ts`, `RetailOpsService.ts`, `RetailBoletaService.ts`, `RetailClosingPlaybook.ts`, `RetailReconciliationService.ts` (+ ~30 outros `Retail*`)
- **Rotas**: `src/server/routes/retailFloor.ts`, `retailops.ts`
- **Tabelas** (~40 `retail_*`): `retail_floor_settings`, `retail_floor_shifts`, `retail_floor_queue_state`, `retail_floor_attendances`, `retail_floor_attendance_scans`, `retail_floor_unmet_demand`, `retail_floor_digest_log`, `retail_stock_policies`, `retail_stock_alerts`, `retail_stock_transfers`, `retail_stock_transfer_items`, `retail_boleta_days`, `retail_boleta_events`, `retail_pdv_sales/*`, `retail_seller_*`, `retail_stores`, `retail_daily_closings` etc.
- **Testes**: `scripts/pilot-retail-floor.ts`, `pilot-retail-floor.cli.ts`, `loadtest-retail-analytics.ts`, `test-piloto-fechamento-retail.ts`, ~30 `test-retail-*.ts`
- **Justificativa do estado (PRECISA VALIDAR COM DADOS REAIS)**: ADRs 170/175/176 marcados implementados; espinha completa. Estabilização TOULON exige verificação em campo — docs de análise + backlog de campo apontam pendências operacionais.
- **Bloqueadores**: dependência de dados reais Alterdata e homologação TOULON no ar.

### 7. `PETSHOP`
- **ADRs**: **nenhum ADR dedicado**. Vertical registrada em `src/server/verticals.ts:9` e `:178` como composição VAREJO + CLÍNICA + SERVIÇOS.
- **PRDs/análises**: sem PRD dedicado (menção em `docs/ESTRATEGIA-VERTICAIS.md`, `docs/READINESS-VERTICAIS.md`)
- **Services**: `ClinicPetService.ts`, `ClinicPetCareService.ts`, `ClinicPetHistoryService.ts`, `ClinicGroomingService.ts` (extensão do módulo Clinic)
- **Rotas**: sem `petshop.ts` — reuso via `src/server/routes/clinic.ts`
- **Tabelas**: `clinic_pets`, `clinic_pet_vaccinations`, `clinic_pet_preventive_treatments` (F7), `clinic_pet_hospitalizations` (F5), `clinic_pet_surgeries` (F5)
- **Testes**: `test-petshop-vertical.ts` (Fase 1 — definição + preset), `test-clinic-pet.ts`, `test-clinic-pet-history.ts`, `test-clinic-pet-treatment.ts`, `test-clinic-petcare.ts`, `test-clinic-pet-care-upcoming.ts`
- **Justificativa do estado (PARCIAL)**: vertical registrada e domínio implementado como extensão do Clinic. Falta ADR próprio, PRD e superfície UI/rota dedicada — hoje é composição implícita.

### 8. `AGENDA_FEDERADA`
- **ADRs**: ADR-180 (professional-identity-federated-calendar — MVP F0–F1+ fechado), ADR-060 (appointment-service-agenda)
- **Services**: `AppointmentService.ts`, `ProfessionalService.ts`, `ProfessionalAuthService.ts`, `ProfessionalAvailabilityService.ts`, `ProfessionalBookingService.ts`, `ProfessionalScheduleConfigService.ts`, `ProfessionalSelfService.ts`, `ProfessionalGoogleService.ts`, `ProfessionalNetworkSettingsService.ts`, `LegalProfessionalFederationService.ts`, `LegalProfessionalBookingService.ts`, `LegalProfessionalScheduleService.ts`, `AgendaPatternMemory.ts`
- **Rotas**: `src/server/routes/appointments.ts`, `professionalPublic.ts`, `advocacia.ts` (federação legal)
- **Tabelas**: `appointments`, `professionals`, `professional_services`, `professional_auth_tokens`, `professional_google_connections`, `professional_portal_tokens`, `clinic_professionals`, `clinic_professional_specialties`, `clinic_professional_windows`, `clinic_professional_offerings`, `clinic_professional_absences`, `clinic_professional_relationships`
- **Testes**: `test-professional-network.ts`, `test-professional-network-settings.ts`, `test-legal-federation.ts`, `test-legal-professional-booking.ts`, `test-legal-professional-schedule.ts`

### 9. `BEAUTY_SALOES`
- **ADRs**: ADR-169 (vertical-beleza-saloes — segunda onda de distribuição)
- **PRDs/análises**: `docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md`
- **Services**: `BeautyClientService.ts`, `BeautyFalaTuIntents.ts`, `BeautyHairSimulationService.ts`, `BeautyHarmonyAnalysisService.ts`, `BeautyLookToAppointmentService.ts`, `BeautyMaintenanceDetector.ts`, `BeautyQueueService.ts`, `BeautyReceptionService.ts`, `BeautyReviewInviteCommandHandler.ts`, `BeautyVacancyDetector.ts`, `BeautyVisagismService.ts`, `BeautyVisualConsultationService.ts`, `AbandonedBeautySimulationDetector.ts`
- **Rotas**: `src/server/routes/beauty.ts`, `beautyPublic.ts`
- **Tabelas**: `beauty_consents`, `beauty_visual_consultations`, `beauty_avatar_assets`, `beauty_reference_looks`, `beauty_visual_simulations`, `beauty_visual_analyses`, `beauty_visagism_analyses`, `beauty_client_profiles`
- **Testes**: ~30 `test-beauty-*.ts` (incluindo golden-paths e tenant-B)

### 10. `ADVOCACIA`
- **ADRs**: ADR-191 (F0–F12 + UI fechadas), ADR-178 (legal-trabalhista-scaffold — curadoria pendente)
- **Services**: `LegalAdvisorService.ts`, `LegalCaseService.ts`, `LegalDeadlineService.ts`, `LegalDocumentService.ts`, `LegalFeeService.ts`, `LegalHearingService.ts`, `LegalPracticeService.ts`, `LegalPrivilegeService.ts`, `LegalProfessionalBookingService.ts`, `LegalProfessionalFederationService.ts`, `LegalProfessionalScheduleService.ts`, `LegalSuccessFeeService.ts`, `LegalTimesheetService.ts`
- **Rotas**: `src/server/routes/advocacia.ts`, `legal.ts`
- **Tabelas**: `legal_consultations`, `legal_cases`, `legal_holidays`, `legal_deadlines`, `legal_documents`, `legal_fees`, `legal_time_entries`, `legal_success_fees`
- **Testes**: 19 arquivos `test-{advocacia,legal}-*.ts` (plan-gated, hardening, federation-hardening)
- **Bloqueadores**: curadoria de conteúdo trabalhista (ADR-178) — não afeta estado geral.

### 11. `CONTENT_GROWTH_ENGINE`
- **ADRs**: ADR-168 (content-growth-intelligence-loop, PRD 11)
- **PRDs/análises**: `docs/prd/ANALISE-PRD11-vs-CODEBASE.md`
- **Services**: `ContentLeadAttributionService.ts`, `ContentRevenueAttributionService.ts`, `GrowthAutopilotService.ts`, `GrowthOptimizationService.ts`, `GrowthOptimizationCommandHandler.ts`, `HookIntelligenceService.ts`
- **Rotas**: **sem rota `content.ts`/`growth.ts` dedicada** — endpoints espalhados por `social.ts`, `campaigns.ts`, `insights.ts`, `decisionIntelligence.ts`
- **Tabelas**: `content_lead_attributions`, `content_sale_attributions`; reutiliza social/campaigns/growth do PRD 10
- **Testes**: `test-content-growth-hardening.ts`, `test-content-lead-attribution.ts`, `test-content-revenue-attribution.ts`, `test-growth-{autopilot,brief,goal,golden-paths,optimization}.ts`, `test-{hook,script}-intelligence.ts`
- **Justificativa do estado (PARCIAL)**: núcleo implementado (ADR-168), mas contrato público disperso — consolidação de rota vale como fatia dedicada antes de expor externamente.

### 12. `SOCIAL_PROVIDERS`
- **ADRs**: ADR-167 (final-integration-social-intelligence — F0–F18 em produção)
- **PRDs/análises**: `docs/prd/ANALISE-PRD10-vs-CODEBASE.md`
- **Services**: `SocialChannelProvider.ts` (contrato), `SocialConnectionService.ts`, `SocialAnalyticsService.ts`, `SocialAttributionService.ts`, `SocialEntitlementService.ts`, `SocialProactivityService.ts`, `SocialPublishCommandHandler.ts`, `InstagramChannelProvider.ts`, `InstagramService.ts`, `FacebookChannelProvider.ts`, `FacebookService.ts`, `MetaWebhookLogService.ts`, `GoogleAutomationService.ts`, `GoogleOAuthService.ts`, `GooglePlacesService.ts`
- **Rotas**: `src/server/routes/social.ts`, `instagramOAuth.ts`, `metaDebug.ts`
- **Tabelas**: `social_connections`, `social_post_metrics` (reutiliza `oauth_connections`, `integrations`)
- **Testes**: `test-social-{analytics-sync,attribution,channel-contract,connection-hub,entitlement,golden-paths,hardening,intelligence-hardening,proactivity,provider-facebook,provider-instagram}.ts`, `test-instagram-{fix-vision-batch,send}.ts`, `test-meta-webhook-debug.ts`
- **Justificativa do estado (PARCIAL / BLOQUEADO POR TERCEIRO)**: contrato + Instagram/Facebook + Google prontos; TikTok/LinkedIn/X apenas mencionados em comentário sem adapters. Meta Ads/Google Ads deferidos por default no ADR-167 §4.
- **Bloqueadores**: adapters TikTok/LinkedIn/X, credenciais OAuth de terceiros, decisão sobre ads-side.

### 13. `INTELLIGENCE_HUB` (Competitor/Vertical/Social Intelligence)
- **ADRs**: ADR-167 F5 (competitor adapter), ADR-156 (external-intelligence-vertical-compartilhada), ADR-157 (external-intelligence-automacao-curadoria-longitudinal), ADR-166 (enterprise-learning-external-intelligence), ADR-135 (enterprise-intelligence-kernel)
- **Services**: `CompetitiveIntelligenceProvider.ts`, `CompetitiveIntelligenceService.ts`, `VerticalIntelligenceService.ts`, `VerticalIntelligenceReminderService.ts`, `VerticalIntelligenceResearchService.ts`, `VerticalSocialIntelligenceService.ts`, `ExternalResearchProvider.ts`
- **Rotas**: expostas via `src/server/routes/decisionIntelligence.ts` (linhas 25/263/267)
- **Tabelas**: `vertical_intelligence` (GLOBAL, sem `organization_id`), `vertical_intelligence_history`, `vertical_intelligence_schedule` (db.ts:8178–8343); deps: `vertical_blueprints`
- **Testes**: `test-competitive-intelligence.ts`, `test-vertical-social-intelligence.ts`, `test-social-intelligence-hardening.ts`, 12 `test-decision-intelligence-di*.ts`
- **Justificativa do estado (PARCIAL)**: camada global existe; provider competitivo é stub sem rede/db real; sem rota `market-intel` dedicada nem tabela `market_competitors` — Closure Track B do PRD-PEL-01 é a consolidação prevista.
- **Bloqueadores**: contrato/fonte externa de dados competitivos.

### 14. `VISUAL_RECIPE_ENGINE` (Track A — P0 do PRD-PEL-01)
- **ADRs**: nenhum dedicado. Infra adjacente reutilizável em ADR-034..ADR-045 (Fashion Studio, provedor Gemini, presets, tryon, wearable).
- **Grep por comandos**: `/ProductExplosion`, `/3Dbillboard`, `/MagazineCover`, `/AddCreative`, `/3DSoft`, `/LifestyleShort` — **zero hits** no repo.
- **Grep por chaves**: `visual_recipe`, `studio_visual_recipes`, `recipe_key`, `recipe_alias` — **zero hits**.
- **Infra disponível para reuso** (ver `STUDIO_IMAGE_GEN_CORE`): `StudioService.ts` (291 linhas), `FashionStudioService.ts` (233), `StorefrontLookGenerationService.ts` (217), `FashionTryOnService.ts` (330), `FashionAvatarService.ts`, `StudioBriefService.ts`, rotas em `src/server/routes/studio.ts` (344 linhas)
- **Justificativa do estado (NÃO EXISTE)**: motor de comandos "recipe" nunca foi codado. Pipeline base de geração já existe — o gap é a camada declarativa (aliases, presets, versionamento de receita).
- **Prioridade**: P0 no PRD-PEL-01 §21. Fatia dedicada na Fase 6.

### 15. `BUSINESS_SKILLS_PACK` (Track C — P1)
- **ADRs**: nenhum ADR-BSP-01 no repo. Sub-capacidades encostam em ADR-023 (marketplace pricing).
- **PRDs/análises**: **`PRD-BSP-01` não está checked-in** — grep case-insensitive em `docs/` retorna vazio. Apenas `docs/PRD-REVENUE-INTELLIGENCE-CENTER.md` tangencia Pricing 360.
- **Services fragmentados por vertical**:
  - Precificação: `src/server/pricing.ts` (markup Loja Virtual), `ComigoPricingService.ts` (recipes/costs/calibrate), `RetailPricingService.ts`
  - Proposta/RFP-RFQ: `QuoteService.ts`, `SupplierQuoteService.ts` (adjacente, não é RFP formal)
  - Marketing Local & Conversão: **NÃO EXISTE** `LocalMarketingService`. Parcial via `CampaignService.ts`, `CampaignObjectiveContractService.ts`, rota `campaigns.ts`
- **Rotas**: `/api/comigo` (`/recipes`, `/recipes/:id/calibrate`), `/api/quotes` (`/settings`, `/:id/accept|decline`). Nada de `/api/local-marketing` nem `/api/proposals`.
- **Tabelas**: nenhuma `proposals`, `rfp`, `rfq`, `local_marketing`. `manager_solution_proposals` é contexto diferente.
- **Testes**: `test-comigo-pricing.ts`, `test-retail-pricing.ts`, `test-pricing.ts`, `test-quote-service.ts`
- **Justificativa do estado (PRECISA ADAPTAR)**: as 3 sub-capacidades existem espalhadas por vertical, sem pacote unificado. Marketing Local & Conversão praticamente ausente como capability nomeada.
- **Bloqueadores**: ~~falta PRD-BSP-01 no repo~~ **destravado** — ver `docs/prd/PRD-BSP-01-business-skills-pack.md` (rascunho inicial, ADR-BSP-01 pendente antes de F1). Decisão sobre compor/rebrandar serviços verticais foi tomada em favor de fachada aditiva (RN-BSP-02).

### 16. `VISION_VMS_CONTROL_PLANE`
- **ADRs**: ADR-001..ADR-008 (Vision Edge Runtime, Tenant Isolation, Media Pipeline, Recording/Evidence, Vision AI Inference, Access Control, Edge-Cloud Sync, Process Supervisor)
- **PRDs/análises**: `docs/PRD-VISION-VMS.md`, `docs/PRD-VISION-VMS-RECONCILIACAO.md`
- **Diretório dedicado**: `apps/vision-cloud/` (~2.6k linhas, processo separado)
- **Services**: `apps/vision-cloud/{server,db,auth,crypto,accessLogs,healthMonitor,storageCalc,webhookDispatcher,webhooks,zoneRules,events}.ts` + ponte `src/server/MaestroService.ts` (`vision_events`)
- **Rotas**: `apps/vision-cloud/routes/{sites,gateways,devices,cameras,zones,events,incidents,webhooks,roleAssignments,accessLogs,panic,storage}.ts`. UI: `src/features/VisionVmsView.tsx` (731 linhas)
- **Tabelas** (em `apps/vision-cloud/db.ts`): `vision_sites`, `vision_gateways`, `vision_devices`, `vision_cameras`, `vision_role_assignments`, `vision_events`, `vision_incidents`, `vision_webhooks`, `vision_webhook_deliveries`, `vision_zones`, `vision_rules`, `vision_zone_occupancy`, `vision_access_logs`; supervisor em `scripts/supervisor.ts`
- **Testes**: `test-vision-foundation.ts`, `test-vision-events.ts`, `test-vision-incidents.ts`, `test-vision-webhooks.ts`, `test-vision-maestro-bridge.ts`, `test-vision-zone-rules.ts`, `test-supervisor.ts`
- **Justificativa do estado (PARCIAL)**: control plane CODED/TESTED completo. `zoneRules.recordObservation` é alimentado à mão via `routes/zones.ts` — **nenhuma câmera real publica ocupação**. Status `online/offline` é metadado.
- **Bloqueadores**: ausência de Vision Edge Perception (§17 abaixo); precisa validar com dispositivo real (ONVIF/RTSP).

### 17. `VISION_EDGE_PERCEPTION` (Track E — P1)
- **ADRs**: ADR-001 (parcial — runtime "adiado para pós-laboratório"), ADR-003, ADR-005
- **PRDs/análises**: `docs/PRD-VISION-VMS.md §6.1`, `docs/PRD-VISION-VMS-RECONCILIACAO.md` classifica ONVIF/RTSP/FrameSampler como `NÃO EXISTE`
- **Diretório `apps/edge/`**: **NÃO é o Vision Edge**. É a ZappFlow Edge da Continuity Layer (ADR-082) — `EdgeInboxApplicator.ts`, `EdgeOutbox.ts`, `EdgeSyncClient.ts` — só sync offline via SQLite `edge.db`; zero código de câmera.
- **Services**: nenhum. Grep por `ONVIFAdapter|RTSPStreamAdapter|FrameSampler|PersonDetector|ZoneMapper|OccupancyPublisher` só retorna citações em ADR-001/003 e nos dois PRDs — nunca em código-fonte.
- **Rotas**: n/a. Consumidor a jusante `vision_zone_occupancy` já existe em vision-cloud.
- **Testes**: `test-edge-*.ts` cobrem apenas outbox/inbox de continuity.
- **Justificativa do estado (NÃO EXISTE)**: só ADR (parcial, runtime não escolhido) + PRD. Nenhum adapter escrito.
- **Bloqueadores**: ADR-001 adia escolha de runtime (Node/Go/Rust) para pós-laboratório; precisa dispositivo real antes de codar.
- **Prioridade**: P1 no PRD-PEL-01 §21. Fatia dedicada na Fase 10.

### 18. `WIFI_PRESENCE_CSI` (Track F — P1/P2, POC antes de produto)
- **ADRs**: nenhum
- **PRDs**: nenhum dedicado no repo. `PRD-PEL-01` declara conceitual.
- **Services**: nenhum. Grep por `WifiSensorAdapter`, `channel_state_information`, `physical_sensor_observations` sem hits em código.
- **Rotas**: nenhuma
- **Tabelas**: nenhuma
- **Testes**: nenhum
- **Justificativa do estado (NÃO EXISTE)**: puramente conceitual. Só existe como string em `CONVENCOES.md §1` (exemplo de nome).
- **Bloqueadores**: hardware CSI-capable; sem ADR; sem código; sem dado.
- **Prioridade**: P1/P2 no PRD-PEL-01. F0–F4 do Track F (hardware study → lab POC → calibration → site pilot → production decision).

### 19. `ZAPFLOW_SENSE` (Track G — após E/F)
- **ADRs**: nenhum
- **PRDs**: nenhum dedicado; só referência genérica em PRD-PEL-01
- **Services**: nenhum. Grep por `PhysicalContextFusionService`, `sensor_fusion` — hits em `LegalDocumentService.ts`, `ClinicReceiptService.ts`, `test-radar-signals-unified.ts`, `test-decision-simulator.ts`, `test-business-signals.ts` são para outros conceitos de "signal/fusion" (anomalia comercial, sinais Radar); **não** sensores físicos.
- **Justificativa do estado (NÃO EXISTE)**: depende de §17 (Vision Edge) e §18 (Wi-Fi CSI) — ambos NÃO EXISTE. Sem observações físicas para fundir.

### 20. `PLATFORM_RELIABILITY_CAPACITY` (Track D — P1)
- **ADRs**: ADR-164 (Platform Trust, Reliability & Capacity Intelligence — F0–F14 + fatias de ambiente em produção)
- **PRDs/análises**: `docs/prd/ANALISE-PRD7-vs-CODEBASE-E-INFRA.md`, `docs/OPERACAO-CAPACIDADE-EVOLUTION.md`, `docs/PERFORMANCE-AUDIT.md`, `docs/RUNBOOK-CONTINUITY-ROLLOUT.md`, `docs/runbook/platform-operacao.md`
- **Services**: `CapacityHeadroomService.ts`, `CapacityEnvelopeService.ts`, `CapacityForecastService.ts`, `CapacityRecommendationService.ts`, `PlatformTelemetryService.ts`, `PlatformTelemetryContract.ts`, `PlatformBaselineService.ts`, `PlatformAlertService.ts`, `PlatformProtectionModeService.ts`, `PlatformRootCauseService.ts`
- **Rotas**: em `/api/admin/*` (operational-health, platform-baseline/anomalies, capacity-headroom/forecast/recommendations/envelope, platform-root-cause, protection-mode[+enforce], platform-alerts[+refresh])
- **Tabelas**: `platform_health_events` (db.ts:8940), `platform_health_snapshots` (:7729), `platform_settings` (GLOBAL) — 0 tabelas per-tenant
- **Testes**: `test-platform-{alerts,baseline,hardening,protection,rootcause,telemetry-contract}.ts`, `test-capacity-{envelope,forecast,headroom,recommendation}.ts`, `scripts/loadtest-capacity.ts`
- **Justificativa do estado (EXISTE)**: ADR-164 F0–F14 + ambiente em produção. §103 do ADR-164 diz que baseline/forecast/envelope só produz resultado útil após dias acumulando — pode reduzir score de "PRODUCTION" para "PILOT/PRODUCTION-DATA-DEPENDENT" após revisão humana.
- **Observação**: Track D no PRD-PEL-01 assume que capacidade estava "parcial/ausente" — está desatualizado; a maior parte do escopo já foi entregue.

### 21. `INTEGRATION_FACTORY`
- **ADRs**: nenhum "Integration Factory" nomeado. Conectores tratados por ADR de vertical.
- **PRDs/análises**: `docs/integrations/alterdata-fase2-vendas.md`, `docs/integrations/alterdata-homologacao-contrato.md`, `docs/CONECTOR-PMS.md`, `docs/INTEGRACAO-ALTERDATA-EXPLICACAO.md`, `docs/INTEGRACAO-ALTERDATA-PERGUNTAS.md`, `docs/ECOSSISTEMA-SUPPLY.md`
- **Services**: `AlterdataConnectorService.ts`, `AlterdataSyncService.ts`, `AlterdataSyncRunner.ts`, `AlterdataPriceMapper.ts`, `AlterdataStockMapper.ts`, `AlterdataSupplyMapper.ts`; genérico via rota `integrations.ts` (usa tabela `integrations` sem service factory)
- **Rotas**: `src/server/routes/integrations.ts` em `/api/integrations`, `connector.ts`, `connectorPublic.ts` (`/api/connector-in`)
- **Tabelas**: `integrations` (db.ts:252), `oauth_connections` (:261), `alterdata_integration_settings` (:5119), `webhook_endpoints`, `webhook_deliveries`
- **Testes**: `test-alterdata-connector.ts`, `test-alterdata-*-mapper.ts`, `test-alterdata-sync*.ts`
- **Justificativa do estado (PARCIAL)**: conectores específicos existem + tabela genérica `integrations`, mas **não há "fábrica" abstrata (registry)** — cada conector é service+route dedicado, wiring OAuth hard-coded em server.ts:752–768. Falta ADR/PRD.
- **Prioridade**: P2 no PRD-PEL-01 §21 (após P0/P1).

### 22. `RECLAME_AQUI_INTELLIGENCE` (Track — reclassificar)
- **ADRs**: ADR-162 (Customer Recovery & Reputation Intelligence, PRD 5 — 15 fatias F0–F14 em produção)
- **PRDs/análises**: sem `ANALISE-PRD5-*.md` dedicado
- **Services** (~17): `ReputationCaseService.ts`, `ReputationClassificationService.ts`, `ReputationClosureService.ts`, `ReputationConnectorService.ts`, `ReputationEscalationRiskDetectorService.ts`, `ReputationHandoffService.ts`, `ReputationHealthService.ts`, `ReputationImpactService.ts`, `ReputationIngestionService.ts`, `ReputationInvestigationService.ts`, `ReputationProvider.ts` (contrato), `ReputationRecoveryService.ts`, `ReputationReplyService.ts`, `ReputationResolutionService.ts`, `ReputationRootCauseService.ts`, `RecoveryRadarService.ts`, `SalesRecovery*Service.ts` (12)
- **Rotas**: `src/server/routes/{reputation,recovery,signals}.ts`
- **Tabelas**: `reputation_connectors` (gated por flag `reclame_aqui_connector_enabled` em `organization_settings`, db.ts:8596–8617); `recovery_events`, `ric_recovery_actions`, `sales_recovery_touches`, `sales_recovery_attributions`
- **Testes**: 14 `test-reputation-*.ts` + 12 `test-sales-recovery-*.ts`
- **Justificativa do estado (PARCIAL / BLOQUEADO POR TERCEIRO)**: ADR-162 entregou espinha completa. Ingestão externa gated por flag; comentário em `db.ts:8596–8606` afirma que exige contrato externo verificado.
- **Bloqueadores**: contrato/parceria com Reclame AQUI (API oficial). Sem isso o provider fica stub e a ingestão longitudinal não roda.
- **Reclassificação sugerida**: PRD-PEL-01 §21 lista Reclame Aqui como P3 backlog "ausente". Na verdade a espinha está pronta — a prioridade real é destravar o conector externo, não construir o motor.

### 23. `ENTERPRISE_INTELLIGENCE_CONTROLER`
- **ADRs**: ADR-135 (enterprise-intelligence-kernel), ADR-166 (Enterprise Learning & External Intelligence 2.0, PRD 9 — F0–F14 em produção). CONTROLER = PRD-E-007 referenciado em `routes/controler.ts:2` sem doc PRD dedicado.
- **PRDs/análises**: `docs/prd/ANALISE-PRD9-vs-CODEBASE.md`
- **Services** (dois blocos):
  - Enterprise Learning: `PatternMemoryService`, `PatternLearningFromAssuranceService`, `LearningEpisodeService`, `EvidencePackageService`, `LearningMetricsService`, `ContextualFusionService`, `LiveSearchResearchProvider`, `ResearchNeedService`
  - CONTROLER: `DepartmentService`, `CostCenterService`, `InventoryLocationService`, `OperationalItemService`, `MaterialRequestService`, `ConsumptionLedgerService`, `CostCenterStatementService`
- **Rotas**: `/api/controler` (server.ts:723) — `/departments`, `/departments/tree`, etc; Enterprise Learning em `/api/decision-intelligence` e `/api/insights`
- **Tabelas**: (CONTROLER) `business_departments`, `cost_centers`, `consumption_events`, `material_consumptions`, `material_requests`, `material_request_items`; (Enterprise) `business_patterns`, `business_pattern_type_stats`, `business_pattern_outcomes` (com `event_key`/idempotência F1)
- **Testes**: `test-controler-{foundation,consumption,items,locations}.ts`; `test-enterprise-learning-{assured,hardening}.ts`, `test-assured-effectiveness.ts`, `test-anonymize-tenant-terms.ts`
- **Observação**: pode ser tratado como 2 iniciativas separadas na Fase 3 se a reconciliação humana preferir (`ENTERPRISE_LEARNING` + `CONTROLER_OPERATIONAL`).

### 24. `AI_RELIABILITY`
- **ADRs**: ADR-165 (Universal Closed Loop & Outcome Assurance, PRD 8 — F0–F13 em produção)
- **PRDs/análises**: `docs/prd/ANALISE-PRD8-vs-CODEBASE.md`, `docs/runbook/outcome-assurance-operacao.md`
- **Services**: `AiReliabilityKernel.ts`, `AiGovernanceService.ts`, `AiQuotaSignalService.ts`, `AiUsageDashboardService.ts`, `AIOrchestratorService.ts`, `SkillOsGroundingService.ts`, `SkillOsExecutionBridge.ts`, `ApprovalPolicyService.ts`, `BusinessOutcomeResolver.ts`, `OutcomeAssuranceService`, `ProcessOutcomeContractService`, `OutcomeReconcilerService`, `OutcomeCorrectionService`, `OutcomeAssuranceMetricsService`, `ConfirmationEngine`
- **Rotas**: `/api/ai-governance` (server.ts:670), `/api/decision-intelligence` (:716) para `/assurance/*`, `/assurance/metrics`, `/assurance/action/:actionId`
- **Tabelas**: `ai_interactions_log`, `ai_usage_log`, `ai_topup_credits`, `ai_decisions`, `skillos_capabilities`, `skillos_skills`, `skillos_model_profiles`, `skillos_eval_cases`, `skillos_eval_runs`, `skillos_rollout`, `skillos_platform_markers`. Grounding é derivado por query — sem tabela `grounding_events`/`hallucinations` explícita.
- **Testes**: `test-ai-{governance,orchestrator,quota-signal,usage-dashboard,usage-ledger}.ts`, `test-skillos-{reliability,grounding,execution-bridge}.ts`, `test-outcome-assurance-hardening.ts`

### 25. `INTELLIGENCE_HUB_SUPERSEDED_LEGACY`
- **Motivo**: PRDs históricos "Social Intelligence/PRD 10" e "Vertical Intelligence Hub" foram consolidados em ADR-135/156/167/168. Não são iniciativas ativas — devem ser marcados `SUPERSEDED`, apontando `superseded_by` = `INTELLIGENCE_HUB` (§13) e `CONTENT_GROWTH_ENGINE` (§11).
- **Ação**: nada a implementar. Apenas registro para o ledger não voltar a criá-los como itens ativos.

### X. `STUDIO_IMAGE_GEN_CORE` (dependência descoberta)
- **ADRs**: ADR-032 ("Fase B — Foto de estúdio a partir da foto real"), ADR-034..ADR-045 (Fashion Studio, ADR-042 fixa Gemini), ADR-044 (Instagram fix + vision software-only)
- **PRDs/análises**: menções em `docs/PRD-VERTICAL-ENTITLEMENTS-ASSINATURAS.md`, `docs/prd/ANALISE-PRD11-vs-CODEBASE.md`
- **Services**: `src/server/llm.ts` (`generateImageB64` → Google Imagen `imagen-3.0-generate-002` via `GOOGLE_AI_API_KEY`/`GEMINI_API_KEY`, fallback OpenAI `gpt-image-1`; `editProductImageB64`, `editImagesB64`, `editImagesGoogleB64`; `startVideoGoogle`/`pollVideoGoogle`/`downloadVideoBuffer` para Veo). `StudioService.ts`, `FashionStudioService.ts`, `FashionTryOnService.ts`, `FashionAvatarService.ts`, `FashionPresetAvatarService.ts`, `StorefrontLookGenerationService.ts`, `StudioBriefService.ts`, `StudioCatalogPhotoService.ts`, `BrandDnaService.ts`, `HookIntelligenceService.ts`, `ScriptIntelligenceService.ts`, `ChannelAdaptationService.ts`, `InstagramService.ts`
- **Rotas**: `src/server/routes/studio.ts` em `/api/studio` (server.ts:646), `fashionPublic.ts`, `storefront.ts`, `storefrontPublic.ts`
- **Tabelas**: `storefront_settings.fashion_studio_enabled`, `fashion_events`, `studio_creations` (galeria)
- **Testes**: `test-studio-brief.ts`, ~13 `test-fashion-*.ts`, `test-storefront-{look-generation,looks,seller-attribution}.ts`, `test-instagram-fix-vision-batch.ts`
- **Por que aparece**: PRD-PEL-01 §12.4 diz "reutilizar o motor atual" — este é ele. Registrar como iniciativa separada evita duplicar quando o Visual Recipe Engine (§14) for construído.

## Gaps estruturais

### Gap-1: Vision Edge / Wi-Fi / Sensor Fusion — 3 iniciativas em cascata sem código
Iniciativas §17, §18, §19 estão todas em `NÃO EXISTE`. §19 depende transitivamente das outras duas. O PRD-PEL-01 já reconhece isso ao colocar Track G após E e F. A cascata implica que qualquer sinalização de "Sensor Fusion pronto" antes de §17 e §18 é falsa. Registrar dependências no Ledger na Fase 1 como `requires`.

### Gap-2: ~~PRD-BSP-01 não está checked-in no repositório~~ — **RESOLVIDO**
~~O PRD-PEL-01 §14 diz textualmente:~~
~~> Fonte autoritativa: **PRD-BSP-01 — ZapFlow Business Skills Pack**~~

~~E instrui: *"Importar o PRD para o Ledger e executar a Fase 0 descrita nele"*.~~

~~**Grep case-insensitive em `docs/` retorna vazio para `BSP-01`, `Business Skills Pack`, `Precificação Inteligente 360`.** Apenas `docs/PRD-REVENUE-INTELLIGENCE-CENTER.md` tangencia (Pricing 360). Sub-capacidades existem espalhadas em services de vertical (`ComigoPricingService`, `RetailPricingService`, `pricing.ts`, `QuoteService`).~~

**Resolvido em `docs/prd/PRD-BSP-01-business-skills-pack.md`** — PRD escrito consolidando as 3 sub-capacidades (Pricing 360, RFP, Local Marketing) como bundle transversal, com fatiamento F0-F5 sugerido, arquitetura de fachada e RN-BSP-01..12. `BUSINESS_SKILLS_PACK` no ledger pode agora ir de `PRECISA_ADAPTAR` → `PRD_READY`, destravando Track C.

### Gap-3: Vision Edge Perception (Track E) não pode começar sem decisão de runtime
ADR-001 explicitamente adia a escolha de runtime (Node/Go/Rust) para pós-laboratório. Track E (P1) depende dessa decisão. Registrar como bloqueador do próprio track, não da Fase 0.

### Gap-4: Visual Recipe Engine (Track A P0) sem ADR nem PRD dedicado
Escrever ADR próprio antes da Fase 6 do PRD-PEL-01 — o ADR define o contrato dos comandos (`/ProductExplosion` etc.), tabelas (`studio_visual_recipes`, `studio_visual_recipe_aliases`), reuso de `StudioService`/`llm.ts`.

### Gap-5: Rota consolidada de Content/Growth
`CONTENT_GROWTH_ENGINE` (§11) tem núcleo pronto mas superfície pública dispersa. Consolidar `/api/content` ou `/api/growth` numa fatia própria antes de expor externamente ou documentar como cliente parceiro.

### Gap-6: PRDs históricos superseded ainda referenciados
Vertical Intelligence Hub, Social Intelligence PRD 10, Enterprise Intelligence antigo — todos foram absorvidos por ADR-135/156/166/167/168. Registrar cada um como `SUPERSEDED` no Ledger (Fase 5 — importar backlog inicial) evita que uma futura auditoria pense que estão pendentes.

### Gap-7: Reclassificação de prioridades vs realidade
O PRD-PEL-01 §11 tratou Reclame Aqui como "ausente" (P3), Platform Capacity como "parcial/ausente" (Track D P1), Vision VMS como "parcial/avançado". As auditorias mostram que:
- Reclame Aqui / ADR-162 → espinha COMPLETA, falta só conector externo
- Platform Capacity / ADR-164 → EXISTE F0–F14 + ambiente
- Vision VMS control plane → PARCIAL só porque falta ingestão real

Isso não invalida o PRD — significa que a matriz precisa ser a fonte de verdade na revisão humana, não o §11 do PRD.

## Referências

- `docs/product-evolution/README.md` — propósito e regra central
- `docs/product-evolution/CONVENCOES.md` — formato de `evolution_key`, estados válidos, definição de evidência
- `docs/product-evolution/STATUS-DE-EXECUCAO.md` — baseline de execução (branch, testes, PRs abertos)
- PRD-PEL-01 — fonte deste trabalho (não checked-in no repo; ver upload da sessão)

## Próximos passos (não desta fatia)

1. **Revisão humana** da matriz — humano confirma cada estado sugerido e decide sobre §Gap-2.
2. **Abrir ADR do Ledger** (`docs/adr/ADR-193-product-evolution-ledger.md` ou próximo número disponível) descrevendo as fatias F1..F5.
3. **Fatia F1**: backend mínimo — tabelas `product_evolution_items` + `product_evolution_evidence` + `product_evolution_sources` + `ProductEvolutionLedgerService` + rotas Admin Master. Batches/dependencies/reviews ficam para F1.5.
4. **Fatia F2**: UI Admin Master (`/admin/product-evolution`) com abas Matriz + Gaps.
5. **Fatia F3**: Reconciliation engine (score determinístico).
6. Depois, Closure Tracks P0 → P1 → P2 → P3 conforme §21 do PRD-PEL-01, cada um em fatia própria.
