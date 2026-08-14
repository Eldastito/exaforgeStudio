# ADR-168 — Content & Growth Intelligence Loop: Creative Intelligence, Experimentation & Business Attribution (PRD 11)

**Programa:** ZapFlow Execution Intelligence (ZEI)
**Estado:** **EM ANDAMENTO — F0 (doc-only, PR #1073), F1–F9 FECHADAS. F1–F5 = pipeline criativo. F6 `CreativeExperimentService` (campeão por ENGAJAMENTO — PROXY; §37 reusa `twoProportionZ`; `test:creative-experiment` 21). F7 Content→Lead + F8 Lead→Sale→Revenue→Margin fecham o fio de atribuição de negócio (system-of-record, fact/estimate nunca somados; `test:content-lead-attribution` 18, `test:content-revenue-attribution` 17). F9 Objective-aware Winner: `decide` prefere o RESULTADO DE NEGÓCIO (receita fact > leads) ao engajamento quando existe (RN-CG-01 operacional na decisão); `test:objective-aware-winner` 11. F10 Creative Learning 2.0: `learnFromAction` classifica o desfecho pelo NEGÓCIO (receita/leads) e não pelo engajamento → o motor único aprende "que assinatura VENDE"; engajamento é fallback (0-regressão); `test:creative-learning-2` 10. `ENGAGEMENT ≠ BUSINESS VALUE` agora completo: medição, decisão E aprendizado.** Regra Zero cumprida (F0 mergeada). O PRD 11 aprofunda a **inteligência criativa** (Brand DNA 2.0, Hook, Roteiro, adaptação multicanal — as lacunas de borda que o PRD 10 deixou) e estende a **atribuição para além do engajamento** (conteúdo → lead → venda → receita → **margem**), para que a **experimentação criativa** escolha o vencedor pelo **resultado de negócio**, não pelo like. Aditivo puro sobre PRDs 0–10 (§37 — sem 2º motor de experimento/atribuição/aprendizado/execução/aprovação/confirmação, sem 2º Estúdio/calendário/CRM/meta, sem tabela de alerta paralela, sem 2ª tela de credenciais, sem segredo no browser). Achado F0: os **dois motores de maior porte** já existem e são generalizáveis por *registry* — o motor de experimento estatístico (`ProspectResearchService` + `prospect_experiments*`, `twoProportionZ`, campeão/desafiante) e o registry de atribuição a system-of-record (`BusinessOutcomeResolver`, register-a-resolver). ~80% é COMPOR/REUTILIZAR. Plano F0–F18. Análise em `docs/prd/ANALISE-PRD11-vs-CODEBASE.md`.
**Prioridade:** P0 — fecha o loop de crescimento comercial do programa ZEI (conteúdo como instrumento de negócio, não ferramenta de social media).
**Acesso:** capacidades criativas/experimentais opt-in por flag + gated por entitlement/plano (server-side); margem/custo/dinheiro role-gated (master/owner); custo de IA restrito ao Admin Master.
**Natureza:** Inteligência criativa aprofundada + experimentação com vencedor por objetivo + atribuição de negócio (social→lead→venda→receita→margem) + autopilot de crescimento shadow.
**Estratégia:** REUTILIZAR → ESTENDER → COMPOR → **só então** CRIAR.
**Dependência dura:** PRDs 0–10 **encerrados** — pré-condição **ATENDIDA** (ADR-167 ciclo social ponta-a-ponta; ADR-165 Outcome Assurance; ADR-166 Enterprise Learning; ADR-159 Autonomy Contract; ADR-136 Ledger; ADR-156/157 External Intelligence).
**Não é:** novo motor de conteúdo, novo motor de experimento, novo mecanismo de atribuição, novo Estúdio/calendário/CRM, novo modelo de meta, nova tabela de alerta, nova camada de credenciais, nem integração direta frontend→APIs sociais.

> **Regra de ouro (PRD 11):** *`ENGAGEMENT` não é `BUSINESS VALUE`. Like/alcance/salvamento são **proxies** — o conteúdo só cumpriu seu papel quando o resultado de negócio prometido (lead, venda, receita, margem) foi confirmado e medido pelo system-of-record, e o vencedor criativo foi escolhido por esse resultado. Assim como `DONE ≠ RESULTADO` (PRD 8) e `PUBLISHED ≠ RESULTADO` (PRD 10).*

---

## 1. Contexto e objetivo

O PRD 10 (ADR-167) costurou o fio social ponta-a-ponta: inteligência externa → oportunidade contextualizada → conteúdo + variantes A/B/C → publicação governada → confirmação → **engajamento medido** → garantia → aprendizado. Isso provou que o ZapFlow *executa* conteúdo com governança. O que **falta** é fechar o loop de **crescimento**:

1. **Profundidade criativa.** O Estúdio gera arte + legenda única, mas não tem **Brand DNA estruturado** (persona/público/posicionamento/proibições — hoje só palette/tone/style/summary em dois stores desconectados), nem **gancho (hook)**, nem **roteiro de vídeo**, nem **adaptação por canal** (a legenda é a mesma para IG e TikTok). São as lacunas de borda que o PRD 10 conscientemente deixou.
2. **Atribuição para além do like.** `SocialAttributionService` para em **engajamento** (`resultAmount:null` sempre). Não existe o elo conteúdo → lead → venda → receita → **margem**. Sem esse elo, "vencedor" é o post com mais likes — que pode não vender nada.
3. **Experimentação com vencedor por objetivo.** Há variantes (A/B/C) e best-time, mas nenhum **experimento** que aloque, meça com rigor estatístico e **declare campeão** — e, crucialmente, que escolha o campeão pelo **resultado de negócio** quando ele existir.

A diferença de produto:

> *"O post B teve mais likes."* → *"O post B gerou 12 leads e 3 vendas (R$ 2.400, margem 41%) contra 40 likes do post A que não converteu; promovi o ângulo do B a campeão e a próxima campanha já nasce com ele — situações semelhantes tiveram melhor desempenho **assegurado**."*

O segundo cenário **já é quase possível** porque os motores existem (experimento em prospecção; atribuição a SoR em Outcome Assurance) — o PRD 11 os generaliza para conteúdo e liga o elo de negócio.

---

## 2. F0 — Auditoria do `main` (evidência `file:symbol`)

**Conclusão: ~80% é COMPOR/REUTILIZAR.** (Auditoria completa e narrativa em `docs/prd/ANALISE-PRD11-vs-CODEBASE.md`.)

| # | Superfície | `file:symbol` | Veredito | Papel / lacuna |
| --- | --- | --- | --- | --- |
| 1 | **Estúdio** | `StudioService.ts:55` (`generate:122`, `suggestCaption:216`, `schedulePost:231`); `CAMPAIGN_OBJECTIVES:36` | EXISTE (parcial) | Sem hook/roteiro/adaptação por canal. |
| 2 | **Brand (2 stores)** | `brand_profiles` (`db.ts:154`); `organization_settings.brand_voice_context` (`db.ts:7988`) | PARCIAL | Desconectados; sem persona/público/proibições; sem versão. |
| 3 | **Variantes A/B/C** | `CreativeVariantService.variants:56` (`ANGLES:45`, `variantKey`) | EXISTE | Só briefs; não experimenta/seleciona. |
| 4 | **Motor de experimento** | `ProspectResearchService` (`createExperiment:32`, `twoProportionZ:135`, campeão `:186`); `prospect_experiments` (`db.ts:4200`) | EXISTE (outro domínio) | **Generalizar** p/ conteúdo. |
| 5 | **Vencedor A/B** | `CollectionAbMeasurementService:78`; `SalesRecoveryAbMeasurementService:81`; `AbTrendService` | EXISTE | Lógica de winner + min-sample reusável. |
| 6 | **Best-time** | `EditorialCalendarService.bestTime:98` | EXISTE | Reusar. |
| 7 | **Hook / Roteiro / Adaptação canal** | — | AUSENTE | Lacunas duras (CRIAR mín. sobre o Estúdio). |
| 8 | **Atribuição social** | `SocialAttributionService.resolvePending:30` (`resultAmount:null` `:43`; fio `variant_key` `:76`) | PARCIAL | Para em engajamento — o elo para frente é a novidade. |
| 9 | **Atribuição de negócio (SoR)** | `BusinessOutcomeResolver` (`:32`, registry `:143`); `OutcomeAssuranceService.assessAction:34` | EXISTE (motor pronto) | Registrar `ContentOutcomeResolver`. |
| 10 | **Precedência de valor** | `SalesRecoveryAttributionService:15` (orders→quotes→avg, fact/estimate); `sales_recovery_attributions` (`db.ts:7509`) | EXISTE | Molde do "conteúdo→venda→receita". |
| 11 | **Leads** | `contacts.stage='novo_lead'` (`db.ts:54`); `lead_temperature/score` (`:714/716`); `lead.converted` (`db.ts:4161`) | EXISTE (não 1ª classe) | Link social→lead é lacuna. |
| 12 | **Produto/estoque/custo** | `products_services` (`db.ts:196`); `inventory_items.avg_cost` (`db.ts:763`); `order_items.unit_cost` (`db.ts:765`) | EXISTE | Margem derivável; sem link conteúdo→SKU. |
| 13 | **Metas** | `BusinessGoalService` (registry `:34`, `progress:148`); `business_goals` (`db.ts:8421`) | EXISTE | Registry schema-free → +1 métrica de crescimento. |
| 14 | **Campanha** | `campaigns` (`db.ts:727`); `CampaignService` | EXISTE (blast) | Sem objetivo/KPI/goal. |
| 15 | **Oportunidade** | `OpportunityMatchingService` (PRD 10 F7) | EXISTE | Estender p/ product opportunity. |
| 16 | **Aprendizado (motor único)** | `CreativeLearningService.learnFromAction:35`; `PatternMemoryService.recordOutcome` | EXISTE | Ponderar por desfecho de negócio. |
| 17 | **Proatividade** | `SocialProactivityService.digest`; `FalaTuProactiveService.selectUrgent` | EXISTE | Growth Brief = ESTENDER. |
| 18 | **Providers reais** | `InstagramChannelProvider` (PRD 10 F3) | EXISTE (1) | +1 real; demais DEFERIR. |
| 19 | **Governança / autonomia / shadow** | `DecisionActionService.propose`; `ApprovalPolicyService.resolveContract`; `CommandExecutorService.execute`; `ConfirmationEngine.expect`; `PlatformProtectionModeService` | EXISTE | Otimização governada + autopilot shadow. |
| 20 | **Entitlements / custo** | `EntitlementService.check`; `SocialEntitlementService`; custo master-only | EXISTE | Gated server-side; margem role-gated. |

---

## 3. Decisões arquiteturais

- **D1 — `ENGAGEMENT ≠ BUSINESS VALUE` é invariante, não slogan.** O vencedor criativo é escolhido pelo desfecho de negócio ASSEGURADO (via `OutcomeAssuranceService`/`BusinessOutcomeResolver`) sempre que ele existir; engajamento entra **apenas** como proxy antecipado enquanto o desfecho não maturou, e nunca é somado a dinheiro (RN-CG-01/03).
- **D2 — Atribuição de negócio = registrar um resolver, não reescrever.** `ContentOutcomeResolver` entra no `BusinessOutcomeResolverRegistry` (`BusinessOutcomeResolver.ts:143`) como 5º domínio; pergunta ao **system-of-record via SQL** (contacts/orders/receivables), **nunca ao LLM** (RN-CG-02). NÃO cria segundo mecanismo de atribuição (§37).
- **D3 — Experimento criativo generaliza o motor existente.** `CreativeExperimentService` **espelha** `ProspectResearchService` (hipótese/amostra/`twoProportionZ`/campeão-desafiante) sobre `scheduled_posts.variant_key` × `social_post_metrics`, reutilizando a lógica de winner+min-sample de `*AbMeasurementService`. NÃO cria segundo motor de experimento (§37).
- **D4 — Elo para frente reusa a precedência de `SalesRecoveryAttributionService`.** valor por precedência `orders`(pago→`fact`) > `quotes`(aceito→`estimate`) > `contacts.avg_ticket`(`estimate`) > nenhum→não atribui; margem = `price − avg_cost` derivada, `basis` explícito. Nunca inventa dinheiro (RN-CG-03).
- **D5 — Brand DNA 2.0 unifica e estrutura, sem 2º Estúdio.** ESTENDE `brand_profiles` + `brand_voice_context` num schema estruturado (persona/público/posicionamento/proibições/do-don't), versionado, grounded no real (`analyzeBrand` + cópia/bio existentes). O Estúdio **consome**; nada de nova tela de credenciais (§37).
- **D6 — Hook/Roteiro/Adaptação estendem o Estúdio.** Serviços mínimos que geram gancho e roteiro grounded no brief/objetivo, e reescrevem por canal sobre `SocialChannelProvider.capabilities`. NÃO criam segundo Estúdio nem presumem capacidade (herda RN-SI-06).
- **D7 — Product Opportunity publica `business_signal`.** "produto em-estoque/alta-margem com desempenho fraco" COMPÕE `products_services`+`inventory_items.avg_cost` × contexto → `OpportunityMatchingService` → `business_signals` (dedupe), NUNCA tabela paralela (§37/§42).
- **D8 — Meta de crescimento estende o registry.** +1 entrada em `BusinessGoalService.METRICS` (schema-free) + vínculo conteúdo→meta por `correlation_id`. NÃO cria segundo modelo de meta; a agenda/objetivo clínico permanece separado.
- **D9 — Otimização é comando GOVERNADO; autopilot é shadow-first.** Promover campeão / pausar perdedor / realocar passam por `DecisionAction → ApprovalPolicy(Autonomy Contract) → CommandExecutor → Confirmation`. Growth Autopilot nasce em **shadow** (propõe, nunca auto-executa) e nunca vai direto a GA (RN-CG-08/10).
- **D10 — Procedência e isolamento preservados.** `internal_fact`/`external_live_evidence`/`model_knowledge`/`estimate`/`hypothesis` seguem separados; concorrente é `external_evidence`, nunca fato interno; **não plagia** conteúdo/identidade de concorrente; scraping não autorizado ≠ fonte oficial (RN-CG-04). Aprendizado isolado por `organization_id`; cross-tenant proibido (RN-CG-05/§79).
- **D11 — Dinheiro/margem role-gated; custo master-only.** Valores de margem/custo só a master/owner (§73); custo de IA restrito ao Admin Master. Gate de plano server-side via `SocialEntitlementService` (esconder botão ≠ segurança).
- **D12 — Motor único de aprendizado.** Creative Learning 2.0 ESTENDE `CreativeLearningService`→`PatternMemoryService` (§184 — sem 2º Learning Engine); só `assured` ensina forte (herda RN-EL-1).

---

## 4. Guardrails duros (RN-CG — no header dos services + testados)

- **RN-CG-01** — `ENGAGEMENT ≠ BUSINESS VALUE`: vencedor prefere desfecho de negócio assegurado; engajamento é proxy antecipado, nunca somado a dinheiro.
- **RN-CG-02** — atribuição pergunta ao system-of-record (SQL), **nunca** ao LLM (`basis:"system_of_record"`).
- **RN-CG-03** — nunca inventa dinheiro; `fact`/`estimate`/`influenced` nunca somados; sem prova de valor → não atribui.
- **RN-CG-04** — não plagia concorrente (conteúdo integral/identidade visual/clone substancial); scraping não autorizado ≠ fonte oficial; só fonte pública/legal.
- **RN-CG-05** — aprendizado isolado por org; cross-tenant proibido.
- **RN-CG-06** — margem/custo/dinheiro role-gated (master/owner); custo de IA master-only.
- **RN-CG-07** — vencedor exige amostra mínima; sem amostra → `insufficient_data` honesto (nunca declara campeão no ruído).
- **RN-CG-08** — experimento não auto-executa; otimização é comando governado.
- **RN-CG-09** — Brand DNA nunca inventa; grounded em ativos/cópia reais.
- **RN-CG-10** — shadow-first; crescimento autônomo nunca direto em GA.
- **RN-CG-11** — `PUBLISHED ≠ RESULTADO` carrega adiante; publicação é hipótese até o resultado de negócio ser confirmado.
- **RN-CG-12** — nenhum motor paralelo (§37/§42/§184): experimento, atribuição, aprendizado, execução, aprovação, confirmação, meta, calendário, CRM, Estúdio — todos únicos.

---

## 5. Plano de fatias (F0–F18)

| Fatia | Entrega | Natureza | Teste |
| --- | --- | --- | --- |
| **F0** | Auditoria + `ANALISE-PRD11-vs-CODEBASE.md` + esta ADR (doc-only) | Auditoria | — |
| F1 | **Brand DNA 2.0** — schema estruturado (persona/público/posicionamento/proibições/do-don't), unifica `brand_profiles`+`brand_voice_context`, versionado | ESTENDER/CRIAR (mín.) | `test:brand-dna` |
| F2 | **Campaign Objective Contract** — objetivo ligado a `business_goal` (métrica/KPI) via `correlation_id` | ESTENDER/COMPOR | `test:campaign-objective` |
| F3 | **Hook Intelligence** — gancho de abertura grounded no brief/objetivo | ESTENDER/CRIAR (mín.) | `test:hook-intelligence` |
| F4 | **Script Intelligence** — roteiro/storyboard de vídeo (cenas/VO/CTA) | ESTENDER/CRIAR (mín.) | `test:script-intelligence` |
| F5 | **Channel Adaptation** — reescrita de legenda/hook/formato por canal (sobre `capabilities`) | ESTENDER/CRIAR (mín.) | `test:channel-adaptation` |
| F6 | **Creative Experiment Engine** — variantes → z-test/engajamento → campeão (espelha `ProspectResearchService`) | COMPOR | `test:creative-experiment` |
| F7 | **Content→Lead Attribution** — `ContentOutcomeResolver` + fio `correlation_id`→`contacts` | COMPOR | `test:content-lead-attribution` |
| F8 | **Lead→Sale→Revenue→Margin** — precedência de valor + margem derivada (`price−avg_cost`) | COMPOR | `test:content-revenue-attribution` |
| F9 | **Objective-aware Winner** — vencedor pelo resultado de negócio assegurado > engajamento | COMPOR | `test:objective-aware-winner` |
| F10 | **Creative Learning 2.0** — assinatura ponderada pelo desfecho de negócio assegurado (PatternMemory) | ESTENDER | `test:creative-learning-2` |
| F11 | **Inventory/Product Opportunity** — em-estoque/alta-margem/desempenho fraco → `business_signal` | COMPOR | `test:product-opportunity` |
| F12 | **Growth Goal metric + goal↔content** — +1 métrica no registry + vínculo por `correlation_id` | ESTENDER | `test:growth-goal` |
| F13 | **Fala Tu Growth Brief** — o que postar + impacto de negócio esperado + campeão | ESTENDER | `test:growth-brief` |
| F14 | **+1 provider social real** (ex.: Facebook feed / LinkedIn) espelhando `InstagramChannelProvider` | COMPOR/CRIAR (mín.) | `test:social-provider-<x>` |
| F15 | **Growth Autopilot shadow** — propõe campanha/otimização, nunca auto-executa | COMPOR | `test:growth-autopilot` |
| F16 | **Governed optimization** — promover campeão / pausar perdedor como comando governado | COMPOR | `test:governed-optimization` |
| F17 | **Commercial Proof** — golden paths `ENGAGEMENT≠BUSINESS VALUE` (Moda/Clínica/Restaurante) | CRIAR (teste) | `test:growth-golden-paths` |
| F18 | **Production Hardening + Runbook** — guardrails RN-CG como regressão + `docs/runbook/growth-operacao.md`; fecha ADR-168 | CRIAR (teste/doc) | `test:content-growth-hardening` |

**F1+ está bloqueada até esta F0 mergear (§43).** Cada fatia = 1 PR draft → CI verde → merge → próxima. F14 escolhe **um** provider real; demais (TikTok/YouTube/X/Ads) DEFERIDOS por API/plano/termos.

---

## 6. Critério de sucesso (§ prova comercial)

O PRD 11 encerra quando for demonstrável ponta-a-ponta: **oportunidade contextualizada** (mercado × estoque/margem × meta) → **variantes com hook/roteiro adaptados por canal** → **experimento** → **publicação governada** → resultado atribuído **além do engajamento** (lead → venda → receita → margem, via system-of-record) → **vencedor escolhido pelo resultado de NEGÓCIO** → campeão realimenta **aprendizado** e a próxima decisão. Os golden paths (Moda com estoque/margem, Clínica com agendamento, Restaurante com ticket) provam `ENGAGEMENT ≠ BUSINESS VALUE`.

---

## 7. Status das fatias

| Fatia | Estado | PR |
| --- | --- | --- |
| F0 | ✅ FECHADA (doc-only) | #1073 |
| F1 | ✅ FECHADA — `BrandDnaService`: identidade ESTRUTURADA (persona/público/posicionamento/proibições/do-don't) sobre `brand_profiles` (colunas aditivas) + VERSIONAMENTO (`brand_dna_versions` + `restore` que nunca rebobina o contador) + UNIFICAÇÃO da voz (fonte única `brand_voice_context`/ADR-155, nunca duplicada) + GROUNDED (RN-CG-09 — `save` só grava o passado, `get` devolve null/[] sem dado, `completeness` derivado). `suggestCaption` do Estúdio passa a CONSUMIR o DNA unificado (voz+persona+posicionamento+proibições; 0-regressão sem dado). Rotas `/api/studio/brand-dna[/versions[/:v]][/restore/:v]`. `test:brand-dna` 40. | #1074 |
| F2 | ✅ FECHADA — `CampaignObjectiveContractService`: liga um OBJETIVO de campanha (`CAMPAIGN_OBJECTIVES`) a uma MÉTRICA DE META de negócio (`BusinessGoalService`, §37 — sem 2º modelo de meta) via `correlation_id` (`campaign:<id>`, fio ADR-158 → atribuição F9/F12). É AQUI que `ENGAGEMENT ≠ BUSINESS VALUE` (RN-CG-01) começa: objetivos de vaidade (engajamento/alcance/educativo/data) ligam a `goalMetric=null` (honesto — não fingem métrica). `progress` compõe a distância-à-meta reusando `BusinessGoalService.progress`; GROUNDED (RN-CG-09 — sem alvo definido pelo dono → `goalDefined:false`, nunca inventa alvo; métrica desconhecida rejeitada). Tabela `campaign_objective_contracts` (aditiva). Rotas `/api/studio/campaign-objectives` + `/campaign-contracts[/:id[/progress|/cancel]]`. `test:campaign-objective` 24. | #1075 |
| F3 | ✅ FECHADA — `HookIntelligenceService`: gera GANCHOS de abertura (scroll-stopper) — 6 padrões distintos (pergunta/curiosidade/afirmação ousada/prova social/dor/identidade) grounded no TÓPICO + OBJETIVO (ordena os padrões) + BRAND DNA (F1 — persona/público/voz). ESTENDE o Estúdio (§37 — sem 2º), DETERMINÍSTICO (sem LLM, roda em CI, espelha `CreativeVariantService`). GROUNDED (RN-CG-09 — sem tópico erro; identidade só com persona/público) + respeito à marca (RN-CG-04 — gancho com termo PROIBIDO do Brand DNA é filtrado, com caveat). Sem tabela nova. Rota `POST /api/studio/hooks`. `test:hook-intelligence` 17. | #1076 |
| F4 | ✅ FECHADA — `ScriptIntelligenceService`: gera ROTEIRO/STORYBOARD de vídeo — 5 beats na ordem (Gancho→Contexto→Demonstração→Prova→CTA), cada um com duração/visual/fala; beat 1 REUSA o gancho da F3 (§37 — sem duplicar); CTA vem do OBJETIVO; duração por FORMATO (reels/story/post). ESTENDE o Estúdio (§37), DETERMINÍSTICO (sem LLM). GROUNDED (RN-CG-09 — sem tópico erro; voz/persona entram quando existem) + respeito à marca (RN-CG-04 — beat com termo PROIBIDO é saneado + caveat). Sem tabela nova. Rota `POST /api/studio/script`. `test:script-intelligence` 22. | #1077 |
| F5 | ✅ FECHADA — `ChannelAdaptationService`: adapta o conteúdo base por CANAL (limite de legenda, faixa de hashtags, FORMATO, CTA idiomática e tom) pra 6 canais (instagram/facebook/tiktok/linkedin/youtube/x). O `SocialChannelProvider` (PRD 10) só abstrai transporte; F5 acrescenta a camada de CONTEÚDO. ESTENDE o Estúdio (§37 — sem 2º), DETERMINÍSTICO (transform puro, sem LLM/DB). GROUNDED (RN-CG-09 — normas são tabela fixa; canal desconhecido rejeitado; nunca inventa hashtag, só corta o excesso). `changes[]` registra cada ajuste; `caveats[]` alerta (poucas hashtags, emoji fora de tom). `adaptMany` gera N canais de uma vez + `skipped`. Sem tabela nova. Rotas `GET /api/studio/channels` + `POST /channel-adaptation`. `test:channel-adaptation` 19. | #1078 |
| F6 | ✅ FECHADA — `CreativeExperimentService`: Creative Experiment Engine — generaliza o motor de experimento de prospecção (§37 — REUSA `ProspectResearchService.twoProportionZ`, NÃO cria 2º motor) sobre VARIANTES DE CONTEÚDO. Mede a taxa de ENGAJAMENTO de cada variante (`social_post_metrics` por `variant_key` aditivo) e decide o campeão determinístico (melhor × 2ª melhor, z ≥ confiança). RN-CG-07 (amostra mínima de impressões/variante → sem ela `insufficient_data`, mantém `running`); campeão/desafiante marca `is_champion`; RN-CG-08 (decidir NÃO executa — promover pra publicação é comando GOVERNADO na F16). ATENÇÃO RN-CG-01: vencedor AQUI é por ENGAJAMENTO (PROXY) — o vencedor por RESULTADO DE NEGÓCIO é a F9. Tabelas `creative_experiments`/`_variants` (aditivas). Rotas `/api/social/experiments[/:id[/decide]]`. `test:creative-experiment` 21. | #1079 |
| F7 | ✅ FECHADA — Content→Lead Attribution (1º elo do fio de negócio). `ContentOutcomeResolver` (domínio `content`, `appliesTo` `social_publish`) entra no `BusinessOutcomeResolverRegistry` do PRD 8 (§37 — register-a-resolver, NÃO cria 2º mecanismo de atribuição) e pergunta ao system-of-record (`content_lead_attributions` por `correlation_id`, nunca ao LLM RN-CG-02) se o conteúdo GEROU LEAD: ≥1 → `confirmed`, senão `not_confirmed` (RN-OA-2 — não é falha), sem fio → `unknown`. `ContentLeadAttributionService.attribute` ESCREVE o vínculo (valida o contato existir — não inventa lead; idempotente por UNIQUE, RN-CG-03). Um lead é MAIS que engajamento (RN-CG-01) — o dinheiro (venda/receita/margem) é a F8. Tabela `content_lead_attributions` (aditiva). Rotas `POST /api/social/attribution/lead` + `GET /attribution/leads`. `test:content-lead-attribution` 18. | #1080 |
| F8 | ✅ FECHADA — Lead→Sale→Revenue→Margin: `ContentRevenueAttributionService` estende o fio até o DINHEIRO. Pra cada lead do conteúdo resolve o valor da venda por PRECEDÊNCIA (espelha `SalesRecoveryAttributionService`, §37 — mesmo modelo): `orders` pago→`fact` > `quotes` aceito→`estimate` > `contacts.avg_ticket`→`estimate` > nenhum→NÃO atribui (RN-CG-03). Margem = Σ(unit_price−unit_cost)·qty; só `fact` quando TODO custo é conhecido, senão `null` (não inventa lucro). `fact` e `estimate` NUNCA somados (reportados à parte). O `ContentOutcomeResolver` sobe pro estágio `sale` com receita quando a venda existe. Dinheiro role-gated na rota (RN-CG-06). Tabela `content_sale_attributions` (aditiva, UNIQUE dedupe). Rotas `POST/GET /api/social/attribution/revenue`. `test:content-revenue-attribution` 17. | #1081 |
| F9 | ✅ FECHADA — Objective-aware Winner: `CreativeExperimentService.decide` passa a preferir o RESULTADO DE NEGÓCIO (receita `fact` via F8, senão leads via F7) ao engajamento quando ele EXISTE (RN-CG-01: `ENGAGEMENT ≠ BUSINESS VALUE` operacional na decisão). Cada variante ganha `correlation_id` (aditivo) que liga às atribuições; `outcomeFor` deriva receita/leads por variante. Ranqueia por (receita fact, leads); dinheiro provado antes de lead; empate→`inconclusive` (não decide no ruído); sem desfecho de negócio → cai pro engajamento (F6, 0-regressão — `test:creative-experiment` segue 21). `basis` (`business_outcome`/`engagement`) explícito. Dinheiro role-gated. Rota `GET /experiments/:id/outcome`. `test:objective-aware-winner` 11. | #1082 |
| F10 | ✅ FECHADA — Creative Learning 2.0: `CreativeLearningService.learnFromAction` passa a CLASSIFICAR o desfecho (worked/no_effect) pelo RESULTADO DE NEGÓCIO (receita `fact` via F8, senão leads via F7, pelo `correlation_id`) ao invés do engajamento quando ele existe (RN-CG-01) — o MOTOR ÚNICO (`PatternMemoryService`, §184) passa a aprender "que assinatura VENDE", não "que assinatura engaja". Sem desfecho de negócio → cai pro engajamento (proxy, 0-regressão — `test:creative-learning` segue 13). `realizedImpact` segue = engajamento (nunca mistura R$ com contagem, RN-CG-03); a ponderação vive na CLASSIFICAÇÃO. `businessBasis`/`businessValue` no retorno + note. `test:creative-learning-2` 10. | — |
| F11–F18 | ⬜ pendentes | — |
