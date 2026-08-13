# Análise Comparativa — PRD 11 (Content & Growth Intelligence Loop: Creative Intelligence, Experimentation & Business Attribution) × Codebase

**Escopo:** entregável da **F0** do PRD 11 (ADR-168). Prova, com evidência `file:symbol`, o que já existe no `main` para que a implementação (F1+) seja **predominantemente REUTILIZAR/ESTENDER/COMPOR** e só o mínimo CRIAR. **Documento sem código de produção** — a implementação está **bloqueada até esta F0 mergear** (Regra Zero / §43).

**Conclusão executiva:** o PRD 10 (ADR-167) já entregou o ciclo social ponta-a-ponta — percepção → oportunidade → conteúdo + variantes A/B/C → publicação governada → confirmação → **engajamento medido** → garantia → aprendizado. O PRD 11 **NÃO é um segundo motor de conteúdo**: é a camada que (a) **aprofunda a inteligência criativa** (Brand DNA estruturado, Hook, Roteiro, adaptação multicanal — as lacunas que o PRD 10 deixou de borda) e (b) **estende a atribuição para além do engajamento**, ligando conteúdo → lead → venda → receita → **margem**, para que a experimentação criativa escolha o vencedor pelo **resultado de negócio**, não pelo like. O achado central: **os dois motores que o PRD 11 mais precisa — um motor de experimento estatístico (`ProspectResearchService` + `prospect_experiments*`) e um registry de atribuição a system-of-record (`BusinessOutcomeResolver`) — já existem e são generalizáveis.** ~80% é COMPOR/REUTILIZAR.

> **Regra nova e fundante do PRD 11: `ENGAGEMENT ≠ BUSINESS VALUE`.** Engajamento é *proxy*, não resultado. Assim como `DONE ≠ RESULTADO` (PRD 8) e `PUBLISHED ≠ RESULTADO` (PRD 10), o PRD 11 estabelece que o **vencedor criativo** só é confiável quando escolhido pelo desfecho de negócio ASSEGURADO — e o engajamento entra apenas como sinal antecipado quando o desfecho ainda não maturou.

---

## 1. Tese: o que já existe vs. o que o PRD 11 precisa ligar

| Camada do fluxo PRD 11 | Existe no `main`? | Evidência |
| --- | --- | --- |
| Estúdio (marca→imagem/vídeo→legenda→publicar) | ✅ | `StudioService.ts:55` (`generate:122`, `suggestCaption:216`, `schedulePost:231`) |
| **Brand DNA estruturado** (voz/persona/público/posicionamento/proibições) | ⚠️ **parcial** | `brand_profiles` (`db.ts:154`: só palette/tone/style/summary) **+** `organization_settings.brand_voice_context` (`db.ts:7988`) **desconectados**; sem persona/público/do-don't |
| Variantes criativas A/B/C | ✅ | `CreativeVariantService.variants:56` (ângulos determinísticos, `variantKey`) |
| **Motor de experimento** (hipótese→amostra→vencedor estatístico→campeão) | ✅ **(outro domínio)** | `ProspectResearchService` (`createExperiment:32`, `twoProportionZ:135`, champion/challenger `:186`); `prospect_experiments` (`db.ts:4200`) |
| Lógica de vencedor A/B (rate + min-sample) | ✅ | `CollectionAbMeasurementService:78`, `SalesRecoveryAbMeasurementService:81`, `AbTrendService` |
| Best-time-to-post (aprendido) | ✅ | `EditorialCalendarService.bestTime:98` (por dow/hora, `insufficient_data` §MIN) |
| **Hook / gancho de abertura** | ❌ | zero — `suggestCaption` gera legenda única, sem gancho/scroll-stopper |
| **Roteiro / storyboard de vídeo** | ❌ | zero (`roteiro` grep vazio); vídeo é 1 briefing→prompt Veo (`StudioService.ts:167`) |
| **Adaptação de conteúdo por canal** | ❌ | `SocialChannelProvider:157` abstrai **transporte**; sem reescrita/formato por canal (IG×TikTok×Reels×LinkedIn) |
| Atribuição de publicação | ⚠️ **para em engajamento** | `SocialAttributionService.resolvePending:30` — `resultAmount:null` SEMPRE (`:43`); chega a engajamento, **não** a lead/venda/receita/margem |
| **Atribuição de negócio a system-of-record** | ✅ **(motor pronto)** | `BusinessOutcomeResolver` registry (`:143`) — 4 resolvers (Cobrança/Comercial/Reputação/Varejo); `OutcomeAssuranceService.assessAction:34` |
| Precedência de valor (orders→quotes→avg, fact/estimate) | ✅ | `SalesRecoveryAttributionService:15-24` (o molde do "conteúdo→venda→receita") |
| Produtos / estoque / custo | ✅ | `products_services` (`db.ts:196`), `inventory_items.avg_cost` (`db.ts:763`), `stock_movements` (`db.ts:788`), `order_items.unit_cost` (`db.ts:765`) |
| **Margem / flag alta-margem** | ⚠️ **derivável, não armazenada** | `price − avg_cost` derivável; `LossMarginService`; sem coluna/flag de margem no produto |
| **Link conteúdo → produto (SKU promovido)** | ❌ | zero — nenhum post referencia `product_service_id` |
| Metas / distância-à-meta | ✅ | `BusinessGoalService` (registry `revenue`+`appointments` `:34`, `progress:148` pace) ; `business_goals` (`db.ts:8421`) |
| **Métrica de meta de crescimento/conteúdo** | ⚠️ **ponto de extensão** | registro de métricas é schema-free (`BusinessGoalService.ts:21`) — 1 entrada nova; sem métrica social/lead hoje |
| **Objetivo de campanha ligado a meta** | ❌ | `campaigns` (`db.ts:727`) = blast de WhatsApp, **sem** `objective`/KPI/goal |
| Aprendizado (motor único) | ✅ | `CreativeLearningService.learnFromAction:35` → `PatternMemoryService.recordOutcome` (só `assured`) |
| Superfície proativa (Fala Tu/Radar) | ✅ | `SocialProactivityService.digest`; `FalaTuProactiveService.selectUrgent` |
| Providers sociais reais | ⚠️ **1 real** | só `InstagramChannelProvider`; FB-feed/TikTok/LinkedIn/YouTube/X DEFERIDOS (PRD 10 §4) |
| Autonomia / shadow / governança | ✅ | `ApprovalPolicyService.resolveContract` (Autonomy Contract ADR-159); `PlatformProtectionModeService` (shadow-first) |
| Execução governada / confirmação / garantia | ✅ | `DecisionActionService.propose`, `CommandExecutorService.execute`, `ConfirmationEngine.expect`, `OutcomeAssuranceService` |

**Achado central:** os **dois motores de maior porte** do PRD 11 — experimento estatístico e atribuição a system-of-record — **já existem** (em prospecção e em Outcome Assurance respectivamente) e são **generalizáveis por registro/registry, não por reescrita**. As lacunas reais são: (1) profundidade criativa (Brand DNA 2.0, Hook, Roteiro, adaptação multicanal), (2) o **elo para frente** engajamento→lead→venda→receita→margem, (3) o link conteúdo→produto, e (4) a métrica de meta de crescimento. Nenhuma exige motor novo.

---

## 2. Matriz REUTILIZAR / ESTENDER / COMPOR / CRIAR / DEFERIR (§1/§43)

### 2.1 Inteligência criativa (o que o PRD 10 deixou de borda)

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Estúdio (marca→arte→legenda→publicar) | ✅ (`StudioService.ts:55`) | ✅ | ✅ | | | |
| `brand_profiles` (palette/tone/style/summary) | ✅ (`db.ts:154`) | ✅ | ✅ | | | |
| `brand_voice_context` (voz livre, ADR-155) | ✅ (`db.ts:7988`) | ✅ | ✅ | | | |
| **Brand DNA 2.0** (persona/público/posicionamento/proibições, unificado + versionado) | ⚠️ (2 stores soltos) | | ✅ | | ✅ (mín. schema) | |
| `CAMPAIGN_OBJECTIVES` (8 objetivos hardcoded) | ✅ (`StudioService.ts:36`) | ✅ | ✅ | | | |
| **Campaign Objective Contract** (objetivo ligado a `business_goal`) | | | ✅ | ✅ | ✅ (mín.) | |
| Variantes A/B/C (briefs) | ✅ (`CreativeVariantService.ts:56`) | ✅ | ✅ | | | |
| `suggestCaption` (legenda única) | ✅ (`StudioService.ts:216`) | ✅ | ✅ | | | |
| **Hook Intelligence** (gancho de abertura) | | | ✅ | | ✅ (mín.) | |
| **Script Intelligence** (roteiro/storyboard de vídeo) | | | ✅ | | ✅ (mín.) | |
| **Channel Adaptation** (reescrita/formato por canal) | ⚠️ (transporte só) | | ✅ | | ✅ (mín.) | |
| Formatos (post/story/banner) | ✅ (`StudioService.ts:28`) | ✅ | ✅ | | | |
| Carousel / reels / thread | | | ✅ | | | ⏸️ conforme provider |

### 2.2 Experimentação criativa & vencedor por objetivo

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Motor de experimento** (hipótese/amostra/z-test/decisão) | ✅ (`ProspectResearchService`) | ✅ | ✅ | ✅ | | |
| `twoProportionZ` / confiança | ✅ (`ProspectResearchService.ts:135`) | ✅ | | | | |
| Campeão/desafiante + aposentar perdedor | ✅ (`ProspectResearchService.ts:186`) | ✅ | ✅ | | | |
| Lógica de vencedor A/B (rate + min-sample) | ✅ (`CollectionAbMeasurementService:78`) | ✅ | | ✅ | | |
| Banda de confiança / null sem amostra (Wilson) | ✅ (`statsWilson.wilsonInterval`) | ✅ | | | | |
| `variant_key` em `scheduled_posts` | ✅ (PRD 10 F10) | ✅ | | | | |
| **`CreativeExperimentService`** (experimento sobre variantes de conteúdo) | | | | ✅ | ✅ (mín.) | |
| **Vencedor por OBJETIVO** (resultado de negócio > engajamento) | | | | ✅ | ✅ (mín.) | |
| Creative Learning (assinatura→PatternMemory) | ✅ (`CreativeLearningService.ts:35`) | ✅ | ✅ | | | |

### 2.3 Atribuição de negócio (o elo para frente)

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Atribuição social (para em engajamento) | ⚠️ (`SocialAttributionService.ts:30`) | ✅ | ✅ | | | |
| Fio `correlation_id`/`variant_key` na publicação | ✅ (`SocialAttributionService.ts:76`) | ✅ | ✅ | | | |
| **`BusinessOutcomeResolver` registry** (SoR, register-a-resolver) | ✅ (`BusinessOutcomeResolver.ts:143`) | ✅ | | ✅ | | |
| Resolvers existentes (Cobrança/Comercial/Reputação/Varejo) | ✅ (`:47/76/95/116`) | ✅ | | | | |
| **`ContentOutcomeResolver`** (conteúdo→lead→venda→receita) | | | | ✅ | ✅ (mín.) | |
| Escada Outcome Assurance (executed→…→impact_measured) | ✅ (`OutcomeAssuranceService.ts:34`) | ✅ | | ✅ | | |
| Precedência de valor (orders→quotes→avg, fact/estimate) | ✅ (`SalesRecoveryAttributionService:15`) | ✅ | | ✅ | | |
| `sales_recovery_attributions` (schema molde) | ✅ (`db.ts:7509`) | ✅ | | | | |
| Receivables / retail closings / orders (SoR) | ✅ (`db.ts:6347/1760/…`) | ✅ | | | | |
| **Leads como entidade 1ª classe** | ⚠️ (`contacts.stage='novo_lead'`) | ✅ | ✅ | | | |
| **Link social→lead** (touch que originou o lead) | | | | ✅ | ✅ (mín.) | |
| Medição fact/estimate/influenced (nunca somados) | ✅ (`OutcomeMeasurementService.basis`) | ✅ | | | | |

### 2.4 Produto, meta, providers, autonomia, plataforma

| Capacidade | Existe | Reutilizar | Estender | Compor | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Catálogo / estoque / custo | ✅ (`products_services`/`inventory_items.avg_cost`) | ✅ | ✅ | | | |
| **Margem derivada / flag alta-margem** | ⚠️ (derivável) | ✅ | | ✅ | | |
| **Product Opportunity** (promover em-estoque/alta-margem) | | | | ✅ | ✅ (mín.) | |
| `OpportunityMatchingService` (mercado×org→sinal) | ✅ (PRD 10 F7) | ✅ | ✅ | | | |
| Metas + distância-à-meta | ✅ (`BusinessGoalService.progress:148`) | ✅ | ✅ | | | |
| **Métrica de crescimento/conteúdo** | ⚠️ (registry schema-free) | ✅ | ✅ | | | |
| Superfície proativa (Fala Tu/Radar) | ✅ (`SocialProactivityService`) | ✅ | ✅ | | | |
| **Fala Tu Growth Brief** (o que postar + impacto esperado) | | | ✅ | ✅ | | |
| Provider social real (`InstagramChannelProvider`) | ✅ (PRD 10 F3) | ✅ | ✅ | | | |
| **+1 provider real (ex.: Facebook feed / LinkedIn)** | | | | ✅ | ✅ (mín.) | |
| TikTok / YouTube / X / Ads | | | | | | ⏸️ **DEFERIR** (API/plano/termos) |
| Autonomy Contract / shadow-first | ✅ (`ApprovalPolicyService`/`PlatformProtectionModeService`) | ✅ | ✅ | | | |
| **Growth Autopilot (shadow)** | | | | ✅ | ✅ (mín.) | |
| Execução governada (otimização = comando) | ✅ (`CommandExecutorService`) | ✅ | ✅ | ✅ | | |
| Entitlements server-side + custo master-only | ✅ (`EntitlementService`/`SocialEntitlementService`) | ✅ | ✅ | | | |

**PROIBIDO CRIAR (§37):** segundo Maestro/orquestrador · segundo Scheduler · segundo JobQueue · segundo Decision Engine · segundo Learning Engine (`PatternMemoryService` é o único, §184) · segundo Approval/Autonomy Engine · segundo Confirmation Engine · segundo Outcome/Impact Ledger · **segundo motor de experimento** (generalizar o de prospecção) · **segundo mecanismo de atribuição** (registrar resolver, não reescrever) · segundo Estúdio · segundo calendário · segundo CRM · segundo modelo de meta · tabela de alerta social paralela (`social_alerts`/`growth_alerts`) · segunda tela de credenciais/OAuth fora de Canais · segredo OAuth no browser · pesquisa por-tenant quando reutilizável por vertical.

---

## 3. Evidência por área (síntese das 2 auditorias)

### 3.1 Inteligência criativa — madura na base, rasa na profundidade
- **Estúdio:** `StudioService.ts:55` — `getBrand:56`, `analyzeBrand:67` (LLM descreve 1–5 posts → identidade), `generate:122` (imagem plan-gated, injeta "brandLine"), `startVideo/pollVideo:151/178` (Veo), `suggestCaption:216` (legenda + objetivo + CTA + hashtags), `schedulePost:231`. `CAMPAIGN_OBJECTIVES:36` (8: vendas/agendamento/promocao/engajamento/alcance/educativo/reativacao/data).
- **Brand (2 stores desconectados):** `brand_profiles` (`db.ts:154`: `palette/tone/style/summary`, 1 linha/org) **e** `organization_settings.brand_voice_context` (`db.ts:7988`, voz livre, flag `brand_voice_enabled`, consumida por `GrimoireService.promptForOrg`, **não** ligada ao Estúdio). Brand vem **só** de análise de imagem; sem persona/público/posicionamento/proibições; sem versionamento.
- **Variantes:** `CreativeVariantService.variants:56` — A/B/C determinístico (ângulos `ANGLES:45`: Benefício / Tendência-prova-social / Identidade), cada uma um `briefingText` + `variantKey` (`{signalId}:{label}`) + `correlationId`. Produz **texto de brief**, não gera/testa/seleciona.
- **Best-time:** `EditorialCalendarService.bestTime:98` (dow×hora do próprio `social_post_metrics`, `MIN_SAMPLES=3`).
- **Lacunas duras:** Hook (gancho) — zero; Roteiro/storyboard — zero (`roteiro` grep vazio; vídeo é 1 prompt Veo); adaptação por canal — `SocialChannelProvider:157` é transporte, `suggestCaption` é canal-agnóstico.

### 3.2 Experimentação — o motor existe (em prospecção)
- **Motor completo:** `ProspectResearchService` — `createExperiment:32`, `startExperiment:61`, `metricsForExperiment:113`, `twoProportionZ:135`, decisão campeão/desafiante que seta `is_champion` e **aposenta perdedores** (`:186-197`), emite `experiment.winner_found`, registra aprendizado. Tabelas `prospect_experiments` (`db.ts:4200`: `hypothesis/variable_under_test/success_metric/sample_size/window_days/confidence_z/decision/winner_variant_id`), `prospect_message_variants` (`db.ts:4180`: `is_champion/tone/cta`), `prospect_experiment_results` (`db.ts:4223`).
- **Vencedor A/B (outros domínios):** `CollectionAbMeasurementService:78` e `SalesRecoveryAbMeasurementService:81` (control×calibrated, `winner` por rate + `MIN_SAMPLE`); `AbTrendService` (snapshots com `winner`); `GrimoirePostmortemService:27` (post-mortem gated em winner/min-sample).
- **Reuso:** generalizar o experimento de prospecção (ou `CreativeExperimentService` que **espelha** o contrato) sobre `scheduled_posts.variant_key` × `social_post_metrics`, com seleção por z-test/engajamento **e**, quando o desfecho de negócio existir (§3.3), por resultado de negócio (RN-CG-01).

### 3.3 Atribuição — o elo para frente é a novidade real
- **Hoje para em engajamento:** `SocialAttributionService.resolvePending:30` casa confirmação `social_publish` × `social_post_metrics` por `post_external_id`, confirma com `engagementOf = likes+comments+shares+saves` e **`resultAmount:null` sempre** (`:43`, "resultado social = engajamento, NÃO dinheiro"). O fio `variant_key`/`correlation_id` está lá (`:76`) — é o gancho para estender.
- **Motor de atribuição de negócio (pronto):** `BusinessOutcomeResolver` (`:32` interface, `resolve→confirmed|not_confirmed|unknown`, `basis:"system_of_record"`, "pergunta ao SoR via SQL, **nunca** ao LLM" `:14`). 4 resolvers: Cobrança (`receivables.status='received'` `:59`), Comercial (`sales_recovery_attributions` por `action_id` `:82`), Reputação (`business_signals.status='resolved'` `:102`), Varejo (`retail_daily_closings.status IN(approved,reconciled)` `:125`). Registry `register/resolve` (`:143`) — **adicionar domínio = registrar resolver, não editar enum** (`:9`). `OutcomeAssuranceService.assessAction:34` compõe a escada e chama o registry (`:55`); `assessCorrelation:95` sobe o fio inteiro.
- **Precedência de valor (molde do "conteúdo→venda→receita"):** `SalesRecoveryAttributionService:15-24` — `orders.total_amount`(pago→`fact`) > `quotes.total_amount`(aceito→`estimate`) > `contacts.avg_ticket`(`estimate`) > nenhum→**não atribui**. Tabela `sales_recovery_attributions` (`db.ts:7509`: `ticket_id/action_id/ticket_value/revenue_recovered/source/basis/outcome_id`, UNIQUE dedupe).
- **Leads:** sem tabela `leads`; modelados em `contacts` (`stage='novo_lead'` `db.ts:54`, `lead_temperature:714`, `lead_score:716`); funil tem `event_type` `lead.replied|lead.converted` (`db.ts:4161`). **Lacuna:** link social→lead (qual touch originou o lead).
- **Produto/margem:** `products_services` (`db.ts:196`), `inventory_items.avg_cost` (`db.ts:763`), `product_variants` (`db.ts:775`), `stock_movements` (`db.ts:788`), `order_items.unit_cost` (`db.ts:765`). Margem = `price − avg_cost` **derivável**; sem coluna/flag; sem link conteúdo→SKU.
- **Metas:** `BusinessGoalService` (métricas `revenue`(snapshot)+`appointments`(analytics) `:34-59`, `progress:148`→`remaining/attainmentPct/paceStatus`). Registry schema-free (`:21`) → 1 entrada nova habilita métrica de crescimento. `business_goals` (`db.ts:8421`). `campaigns` (`db.ts:727`) = blast, **sem objetivo/KPI**.

### 3.4 Governança / plataforma — tudo EXISTS (reusar)
- Execução: `DecisionActionService.propose`, `ApprovalPolicyService.resolveContract` (Autonomy Contract), `CommandExecutorService.execute` (auditado, guard `action_already_executed`), `ConfirmationEngine.expect`. Shadow: `PlatformProtectionModeService` (postura shadow-first).
- Aprendizado: `PatternMemoryService.recordOutcome` (idempotente, só `assured` ensina forte — RN-EL-1). `CreativeLearningService.ts:35` já liga publicação assegurada → assinatura → PatternMemory.
- Proatividade: `SocialProactivityService.digest`, `FalaTuProactiveService.selectUrgent` (quiet-hours/limiar, PRD 6).
- Entitlements: `EntitlementService.check` + `SocialEntitlementService` (gate server-side módulo `estudio`, custo master-only §73).

---

## 4. Gaps que a implementação (F1+) fecha — sem motor novo

| # | Gap | Onde fecha (REUTILIZAR/ESTENDER/COMPOR) |
| --- | --- | --- |
| G1 | Brand DNA raso e em 2 stores soltos | ESTENDER `brand_profiles` + `brand_voice_context` num schema estruturado unificado (persona/público/posicionamento/proibições/do-don't), versionado; reusar `analyzeBrand`. |
| G2 | Objetivo de campanha sem vínculo a meta | COMPOR `CAMPAIGN_OBJECTIVES` × `BusinessGoalService` → Campaign Objective Contract (objetivo→métrica de meta, via `correlation_id`). |
| G3 | Sem gancho (hook) | ESTENDER Estúdio: geração de hook grounded no brief/objetivo (CRIAR mín. serviço, sem 2º Estúdio). |
| G4 | Sem roteiro/storyboard | ESTENDER Estúdio: roteiro de vídeo (cenas/VO/CTA) a partir do brief (CRIAR mín.). |
| G5 | Sem adaptação por canal | ESTENDER sobre `SocialChannelProvider.capabilities` → reescrita de legenda/hook/formato por canal (CRIAR mín. camada). |
| G6 | Sem experimento criativo/vencedor | COMPOR o motor de `ProspectResearchService`/`*AbMeasurement` sobre `variant_key`×`social_post_metrics` → `CreativeExperimentService`. |
| G7 | Atribuição para em engajamento | ESTENDER `SocialAttributionService` + COMPOR `BusinessOutcomeResolver` novo (`ContentOutcomeResolver`) via `correlation_id`. |
| G8 | Sem elo social→lead→venda→receita→margem | COMPOR precedência de `SalesRecoveryAttributionService` (orders→quotes→avg) + derivação de margem (`price−avg_cost`); leads via `contacts.stage`. |
| G9 | Vencedor pelo like, não pelo negócio | COMPOR `CreativeExperimentService` + `OutcomeAssuranceService` → vencedor prefere resultado ASSEGURADO; engajamento só como proxy antecipado (RN-CG-01). |
| G10 | Creative Learning só de engajamento | ESTENDER `CreativeLearningService` p/ ponderar pela assinatura com desfecho de NEGÓCIO assegurado (PatternMemory, motor único). |
| G11 | Sem link conteúdo→produto / oportunidade de produto | COMPOR `products_services`+`inventory_items.avg_cost` (em-estoque/alta-margem) → `OpportunityMatchingService` (sinal em `business_signals`). |
| G12 | Sem métrica de meta de crescimento | ESTENDER `BusinessGoalService` (1 entrada no registry) + ligar conteúdo→meta por `correlation_id`. |
| G13 | Sem brief de crescimento proativo | ESTENDER `SocialProactivityService.digest`/`FalaTuProactive` (o que postar + impacto esperado + vencedor). |
| G14 | Só 1 provider social real | COMPOR +1 provider real espelhando `InstagramChannelProvider` (ex.: Facebook feed/LinkedIn); demais DEFERIR. |
| G15 | Sem autopilot de crescimento | COMPOR `ApprovalPolicyService`/`PlatformProtectionModeService` → Growth Autopilot shadow (propõe, nunca auto-executa). |
| G16 | Otimização precisa ser governada | COMPOR `CommandExecutorService` p/ ações de otimização (promover campeão/pausar perdedor) como comando governado. |

---

## 5. Guardrails (RN-CG-01..12) — já cumpríveis por herança

| RN-CG | Regra | Onde já se apoia |
| --- | --- | --- |
| 01 | **ENGAGEMENT ≠ BUSINESS VALUE** — vencedor prefere desfecho de negócio; engajamento é proxy | `OutcomeAssuranceService` (assured); `BusinessOutcomeResolver` (SoR) |
| 02 | Atribuição pergunta ao system-of-record, nunca ao LLM | `BusinessOutcomeResolver.ts:14` (`basis:"system_of_record"`) |
| 03 | Nunca inventa dinheiro; fact/estimate/influenced nunca somados | `OutcomeMeasurementService.basis`; `SalesRecoveryAttributionService` precedência |
| 04 | Não plagia concorrente (conteúdo/identidade); scraping não autorizado ≠ fonte oficial | `CompetitiveIntelligenceProvider` (fonte pública/legal, RN-SI-11) |
| 05 | Aprendizado isolado por org; cross-tenant proibido | `PatternMemoryService` por `organization_id` (§79) |
| 06 | Margem/custo/dinheiro role-gated (master/owner) | `SocialEntitlementService`/§73; custo master-only |
| 07 | Vencedor exige amostra mínima; sem amostra → honesto | `statsWilson`/`MIN_SAMPLE`/`insufficient_data` |
| 08 | Experimento não auto-executa; otimização é comando governado | `DecisionAction→ApprovalPolicy→CommandExecutor` |
| 09 | Brand DNA nunca inventa; grounded em ativos/cópia reais | `analyzeBrand` (deriva do real); RN-SI-02 grounding |
| 10 | Shadow-first; crescimento autônomo nunca direto em GA | `PlatformProtectionModeService`; Autonomy Contract |
| 11 | `PUBLISHED ≠ RESULTADO` carrega adiante | `OutcomeAssuranceService`; RN-SI-03 herdado |
| 12 | Nenhum motor paralelo (§37/§42/§184) | convenção `CLAUDE.md:89`; motor único de aprendizado |

---

## 6. Plano de fatias (resumo — detalhe no ADR-168)

| Fatia | Entrega | Natureza |
| --- | --- | --- |
| **F0** | Esta análise + ADR-168 (doc-only) | Auditoria |
| F1 | Brand DNA 2.0 (schema estruturado + unificação + versionamento) | ESTENDER/CRIAR (mín.) |
| F2 | Campaign Objective Contract (objetivo ligado a `business_goal`) | ESTENDER/COMPOR |
| F3 | Hook Intelligence (gancho grounded) | ESTENDER/CRIAR (mín.) |
| F4 | Script Intelligence (roteiro/storyboard de vídeo) | ESTENDER/CRIAR (mín.) |
| F5 | Channel Adaptation (reescrita/formato por canal) | ESTENDER/CRIAR (mín.) |
| F6 | Creative Experiment Engine (variantes → z-test/engajamento → campeão) | COMPOR |
| F7 | Content→Lead Attribution (`ContentOutcomeResolver` + fio) | COMPOR |
| F8 | Lead→Sale→Revenue→Margin (precedência + margem derivada) | COMPOR |
| F9 | Objective-aware Winner (resultado de negócio > engajamento) | COMPOR |
| F10 | Creative Learning 2.0 (assinatura ponderada por desfecho assegurado) | ESTENDER |
| F11 | Inventory/Product Opportunity (em-estoque/alta-margem → sinal) | COMPOR |
| F12 | Growth Goal metric + goal↔content | ESTENDER |
| F13 | Fala Tu Growth Brief (o que postar + impacto esperado) | ESTENDER |
| F14 | +1 provider social real (ex.: Facebook feed / LinkedIn) | COMPOR/CRIAR (mín.) |
| F15 | Growth Autopilot shadow (propõe, nunca auto-executa) | COMPOR |
| F16 | Governed optimization (promover campeão / pausar perdedor) | COMPOR |
| F17 | Commercial Proof — golden paths `ENGAGEMENT≠BUSINESS VALUE` | CRIAR (teste) |
| F18 | Production Hardening + Runbook + fecha ADR-168 | CRIAR (teste/doc) |

**F1+ está bloqueada até esta F0 mergear (§43).** Cada fatia = 1 PR draft → CI verde → merge → próxima.

---

## 7. Critério de sucesso (o teste ponta-a-ponta)

O PRD 11 só encerra quando for demonstrável: **uma oportunidade contextualizada** (mercado × estoque/margem × meta) → gera **variantes criativas com hook/roteiro adaptados por canal** → entram num **experimento** → são **publicadas sob governança** → o resultado é atribuído **para além do engajamento** (lead → venda → receita → margem, via system-of-record) → o **vencedor é escolhido pelo resultado de NEGÓCIO** (não pelo like) → o campeão realimenta o **aprendizado** e a próxima decisão. Os golden paths por vertical (Moda com estoque/margem, Clínica com agendamento, Restaurante com ticket) provam `ENGAGEMENT ≠ BUSINESS VALUE` ponta-a-ponta.
