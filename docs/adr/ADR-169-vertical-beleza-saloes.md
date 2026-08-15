# ADR-169 — Vertical Beleza & Salões (PRD 12)

**Programa:** ZapFlow Distribuição por Vertical (segunda onda)
**Estado:** **F0 MERGEADA (PR #1121)** · **F1 MERGEADA (PR #1122)** · **F2 MERGEADA (PR #1123)** · **F3 em andamento** — perfis por-vertical Beleza semeados **CONDICIONALMENTE pelo blueprint** (não em `SYSTEM_PROFILES`, 0-regressão pras 8 verticais existentes). `PermissionService.seedBeautyProfiles(orgId)` cria 3 perfis CUSTOM (`is_system=0`) idempotentes por nome: **Recepção (Beleza)** — agenda/atendimento/contatos/vendas write, pagamentos read, financeiro **none** (RN-BS-08); **Cabeleireira (Beleza)** — atendimento write, agenda **read** (não remarca — recepção faz), sem campanhas/cadências/financeiro; **Gerente (Beleza)** — quase-full, cobranca read, configuracoes read, financeiro read (vê resumo, não modifica — §73). `VerticalBlueprintService.assignToOrganization` chama `seedBeautyProfiles` **síncrono, best-effort** quando `bp.baseVertical === "beleza"` (mesmo padrão de `LgpdService.seedConsentForVertical` em `ModuleService.applyVertical`). `test:beauty-profiles` 75/75 codifica: shape das 3 permissões coerentes com o papel, idempotência, preserva edição do admin (re-seed não sobrescreve), side-effect no assign, assign de outros blueprints NÃO semeia beleza, isolamento cross-tenant, integração completa com `assignToUser`+`levelFor`+`can`, `SYSTEM_PROFILES` intocado (6 templates canônicos), zero hardcoded Studio Márcia. Regressão: `test:rbac-granular` 27/27, `test:rbac-profiles-api` 28/28, `test:vertical-blueprint-service` 48/48, `test:beauty-blueprint-piloto` 54/54, `test:beauty-registry` 42/42, tsc limpo. Sidebar/UI reconhecendo a vertical fica DEFERIDA (opcional na tabela §5) — Sidebar hoje já consome `isModuleEnabled`/`canAccessModule` que naturalmente refletem o blueprint. — blueprint `beleza_salao_v1` publicado + piloto Studio de Beleza Márcia atribuído POR DADO (§17/§65). +1 entrada em `BlueprintSeeder.INITIAL_BLUEPRINTS` (baseVertical=beleza, min=start, default=growth, sem bundle, required=agenda+vendas+pagamentos, optional=campanhas/cadencias/assinaturas/estudio/areas/integracoes/diretor/rie/execucao, hidden=clinica/escola/retail/retail_floor/vms/prospect, quickStartPack=null — pack de beleza é fatia futura F17+); +1 branch em `inferBlueprintKeyFor` (`beleza` sempre mapeia pra `beleza_salao_v1` independente do plano, mesmo padrão da saúde). `test:beauty-blueprint-piloto` (54 checks) codifica: blueprint publicado + idempotente + shape completo, inferência em todos os planos + regressão nos outros, piloto atribuído com `assignToOrganization` (fixture com `randomUUID`, não constante), `EntitlementService.check` usa `hiddenModules` DO BLUEPRINT (não do FALLBACK) com `source.verticalBlueprint="beleza_salao_v1:v1"`, módulos do preset ficam active, `migrateExistingOrgs` migra tenants beleza legados, cross-tenant piloto↔clínica isolado, applyVertical + assign coexistem, zero hardcoded do Studio Márcia. Regressão em `test:blueprint-seeder` (78/78 — teste é dinâmico, reconhece o novo blueprint automaticamente), `test:vertical-blueprint-service` (48/48), `test:entitlement-hidden-via-blueprint` (28/28), `test:beauty-registry` (42/42), `tsc --noEmit` limpo. Achado F0: **~85% é COMPOR / REUTILIZAR / CONFIGURAR** — a operação essencial de salão (agenda com profissional/sala/especialidade, ciclos renováveis, ficha extensível, lembrete 24h, lista de espera, remarcação por WhatsApp) já existe canonicalizada como Clínica; o Simulador de Cabelo é o **Fashion Studio com prompt invertido** (preservar rosto/corpo, alterar cabelo — mesmo contrato `TryOnProvider`, mesma família de tabelas, mesma comparação lado a lado já pronta no frontend). O trabalho de F1+ é: (a) 1 chave em `verticals.ts` + 1 blueprint `beleza_salao_v1`; (b) 1 família `beauty_*` de tabelas espelhando `fashion_*` + 1 provider; (c) 3 conectores finos ao `products_services` (duração lida pela agenda, N:N profissional↔serviço, `maintenance_days` opcional); (d) 5 command handlers novos no MESMO registry; (e) endurecimento **transversal** de consent+quiet-hours+frequency-cap (aditivo, beneficia todas). Nenhum motor novo. Plano F0–F18. Análise em `docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md`.

**Prioridade:** P0 — primeira vertical nova após a onda inicial (ADR-092 §60 já a previa como `💇 beleza`; ficou represada até o Bloco A do Autônomo, que já fechou).
**Acesso:** vertical + Beauty AI opt-in por flag; blueprint atribuído pelo Master Admin; dinheiro/margem role-gated; custo de IA restrito ao Master Admin.
**Tenant piloto:** **Studio de Beleza Márcia** — configurado exclusivamente por dado (`vertical_blueprints` + `organization_settings` + seeds), **nunca** por constante hardcoded (§17/§65 do PRD).
**Estratégia:** REUTILIZAR → CONFIGURAR → ESTENDER → **só então** CRIAR (§4 do PRD).
**Dependência dura:** ADRs 060 (Appointment), 145 (Clínica Jornada), 034–044/103–104 (Fashion Studio), 059/072/091/092/095/153 (planos/módulos/blueprint/RBAC), 073/074 (JobQueue/Scheduler), 075 (Storage), 130 (AI Governance), 136 (BusinessSignal), 152/158/159 (Runtime/espinha/Autonomy), 156 (External Intelligence), 163 (Invisible UX), 165 (Outcome Assurance), 166 (Enterprise Learning), 167/168 (Social/Growth) — **todos FECHADOS**.
**Não é:** novo CRM, nova agenda, novo Estúdio, novo motor de simulação, novo gateway de IA, novo executor, nova tabela de alerta, nova tela de credenciais, nem `if vertical === "beauty"` espalhado.

> **Regra de ouro (PRD 12):** *`SIMULAÇÃO ≠ AGENDAMENTO ≠ ATENDIMENTO ≠ RESULTADO`. Cada elo da jornada Descobrir→Experimentar→Decidir→Agendar→Atender→Recomprar tem sua própria confirmação e evidência.* Herda `DONE ≠ RESULTADO` (PRD 8) e `ENGAGEMENT ≠ BUSINESS VALUE` (PRD 11).

---

## 1. Contexto e objetivo

O PRD "Vertical Beleza & Salões" (v1.0, 14/08/2026) pede uma nova vertical para salões/barbearias/estética/nail designers, com o Studio de Beleza Márcia como piloto. A ordem é dura: **não desenvolver de forma hardcoded para o Studio** — tudo deve ser configurável para que um segundo salão (ex.: "Salão Teste B") receba a vertical sem alteração de código (§65 — o teste definitivo).

A vertical combina operação (agenda, clientes, profissionais, serviços, atendimento, produtos, comissão, campanhas, reputação, métricas) com um domínio novo específico do segmento: **Beauty AI** (Simulador de Cabelo, Análise de Harmonia Visual, Look→Serviços do catálogo real, Look→Agendamento). O PRD é enfático que Beauty AI **não pode ser entretenimento** — a simulação existe para virar agendamento e receita, sempre grounded no catálogo real do tenant, nunca inventando serviço/preço/promoção.

**Achado F0 (auditoria completa em 4 frentes — `docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md`):** o ZapFlow já entrega ~85% do que a vertical exige. Os três motores de maior porte — try-on de imagem, agenda com profissional/sala/especialidade/ciclos, execução governada com aprendizado — já existem, provados em produção e generalizáveis por registro/registro/registry, não por reescrita. As lacunas reais são de borda (registrar a chave, criar o blueprint, +5 tabelas do domínio Beauty AI, 3 conectores finos ao catálogo) e um endurecimento transversal que a vertical traz à tona (consent `comunicacoes` transversal + quiet-hours + frequency-cap) mas que beneficia todas as verticais.

---

## 2. F0 — Auditoria do `main` (evidência `file:symbol`)

**Conclusão: ~85% é COMPOR/REUTILIZAR/CONFIGURAR.** (Auditoria completa em `docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md`.)

| # | Superfície | `file:symbol` | Veredito | Papel / lacuna |
| --- | --- | --- | --- | --- |
| 1 | **Registro de vertical** | `verticals.ts:8-9` (`VerticalKey`), `:94-148` (`VERTICALS`), `:23-32` (`CONSENT_BY_VERTICAL`) | EXISTE (registry como dado) | +1 objeto (`beleza`) |
| 2 | **Blueprint por nicho** | `VerticalBlueprintService.ts`, `BlueprintSeeder.ts:49-168`, `vertical_blueprints`/`organization_blueprints` (`db.ts:7555-7593`) | EXISTE | +1 seed (`beleza_salao_v1`) |
| 3 | **Entitlements + gate server-side** | `EntitlementService.check:204`; `SocialEntitlementService.assertAllowed:49` (molde) | EXISTE | Reusar verbatim |
| 4 | **RBAC + role_profiles** | `PermissionService.ts:129-152`; `role_profiles`/`role_permissions` (`db.ts:5659-5675`); `ContextProjectionService.hasFullBusinessVisibility:141` (§73) | EXISTE | Perfis por-vertical: **opcional** F3 |
| 5 | **CRM canônico** | `contacts` (`db.ts:37-47` + `avg_ticket`, `memory_facts`, `tags`, `notes`); `CustomerProfileService`, `CustomerMemoryService` | EXISTE | Sem custom fields JSON (gap conhecido; usar `memory_facts`/`tags`) |
| 6 | **Agenda + profissional + sala + duração** | `appointments` (`db.ts:221-235` + `professional_id:3117`, `room_id:3119`, `expected_duration_minutes:3121`); `ClinicAgendaService` completo | EXISTE | Reusar; renomear em UI |
| 7 | **Anti-double-booking (AC-012)** | `ClinicScheduleSessionService.ts:322-374` (tx: COUNT dentro → INSERT); race-por-unique `ClinicAgendaService.scheduleFollowUp:507-528` | EXISTE (o molde canônico) | Reusar |
| 8 | **Disponibilidade prof+ausência+sala** | `ClinicScheduleSessionService.availability:567-648`; `ClinicProfessionalAbsenceService.overlaps:170-186` | EXISTE (único com todos os filtros) | Reusar |
| 9 | **Profissional desacoplado de login** | `clinic_professionals` (`db.ts:2576-2586`, `user_id` **opcional**) + PIN (`:3228-3230`) | EXISTE | Reusar (a manicure não precisa de conta) |
| 10 | **N:N profissional↔especialidade** | `clinic_professional_specialties` (`db.ts:2734-2747`); `ClinicSpecialtyService.listProfessionalsForSpecialty:218-248` | EXISTE | **N:N profissional↔serviço**: gap (F4) |
| 11 | **Sala/cabine com capacidade** | `clinic_rooms` (`db.ts:2589-2595` + `capacity:2943`) | EXISTE | Reusar |
| 12 | **Ciclo renovável (10 sessões, saldo RN-004)** | `ClinicTreatmentCycleService` (`usage:157`, `renew:426`); `clinic_treatment_cycles` (`db.ts:2850-2878`) | EXISTE | Reusar (pacote de 10 escovas) |
| 13 | **Janela de retorno / manutenção** | `clinical_encounters.follow_up_recommended_days` (`db.ts:3322`); `ClinicAgendaService.followUpQueue:542-580` | EXISTE | Reusar |
| 14 | **Ficha extensível por atendimento** | `clinical_encounters.form_data TEXT` (JSON livre, `db.ts:3252-3271`) | EXISTE | Reusar (fórmula de coloração) |
| 15 | **Lista de espera / vaga por cancelamento** | `ClinicVacancyService` (`tryOfferOnCancel:82`, `pickCandidate:172`, `handleReply:264`) | EXISTE | Reusar |
| 16 | **Remarcação por WhatsApp (3 horários)** | `ClinicRescheduleService` (`findSlots:79`, `createOffer:138`, `handleChoice:192`) | EXISTE | Janela hardcoded 8-18 (`:36-37`) — trocar por `agenda_open_hour` |
| 17 | **Lembrete 24h + opt-out `PARAR`** | `ClinicReminderService.dispatch:215`; `ClinicReminderReplyService.ts:45` (OPTOUT revoga consent `comunicacoes`) | EXISTE | Reusar |
| 18 | **Catálogo (product/service)** | `products_services` (`db.ts:196-209` + `duration_minutes:766`, `metadata_json:207`, `category:1326`); `inventory_items.avg_cost:763` | EXISTE | `duration_minutes` órfã (gap F4) |
| 19 | **Try-on virtual completo** | `FashionTryOnService.ts:41-46` (contrato); `FashionAvatarService` (consent+quarentena+EXIF+URL assinada); `fashion_*` tabelas | EXISTE (motor exato) | Espelhar como `beauty_*` |
| 20 | **Comparação lado a lado (UI)** | `src/storefront/FashionStudio.tsx:326-338, 758-775` | EXISTE | Reusar 1:1 |
| 21 | **Gateway de IA + custo** | `llm.ts` (`chat`, `generateImageB64`, `editImagesGoogleB64`, `editImagesB64`); `recordUsage:70-105` → `ai_usage_log`; `PlanService.studioAllowed` | EXISTE | Reusar |
| 22 | **Storage privado + URL assinada** | `fileSigning.ts` (`sha256(JWT_SECRET:{scope}_v1)`, TTL 15min); 6 escopos hoje | EXISTE (padrão canônico) | +1 escopo `beauty_private_media_v1` |
| 23 | **JobQueue + retry + idempotência** | `JobQueueService:55` (`enqueue`, `errorClass`, `sweepStale:114`); handlers `fashion_tryon`/`storefront_look_image` | EXISTE | Reusar |
| 24 | **Estúdio de Criação** | `StudioService.ts:55`; `BrandDnaService`, `Hook/Script/ChannelAdaptation/CreativeVariantService`; `GovernedPublishService.propose:40` | EXISTE | Reusar |
| 25 | **Execution Runtime + Autonomy** | `DecisionActionService.propose:40`; `ApprovalPolicyService.resolveContract:110`; `CommandExecutorService.execute:188` (21 handlers); `ConfirmationEngine.expect:89`/`confirm:166`/`sweepTimeouts:238` | EXISTE (completo) | Reusar; +5 handlers `beauty_*` |
| 26 | **BusinessSignal + dedupe + TTL** | `business_signals` (`db.ts:5927-5949`); `BusinessSignalService.publish:58` + `attention:109`; `SignalProcessRouterService.TRIGGER_MAP:55-63` | EXISTE | Reusar |
| 27 | **Fala Tu (choke-point `confirm`)** | `FalaTuService.interpret:192`/`confirm:439` (silo + porta I/O opt-in); paridade WhatsApp `:91` | EXISTE | Estender enum + switch |
| 28 | **Detector "cliente inativa"** | `ChurnRiskDetectorService.ts:55` (só olha `orders`); `Scheduler.reactivationPass:1521` | EXISTE (parcial) | Novo fator: dias desde último `appointment` (F11-F12) |
| 29 | **Consent `comunicacoes`** | 24 call-sites, **todos `Clinic*`** | ⚠️ **GAP LOAD-BEARING** | Mover para sink transversal (F5-transversal) |
| 30 | **Quiet-hours / frequency-cap outbound** | ❌ (só push interno ao dono) | AUSENTE | CRIAR mín. transversal (F5-transversal) |
| 31 | **CSAT 1-5 pós-`orders.paid_at`** | `satisfaction_surveys` (`db.ts:874-888`); `Scheduler.npsPass:1847` | EXISTE (gatilho: pedido) | Não há survey por atendimento; "pedir review Google" → F13 |
| 32 | **Reputação (ingerir + investigar + responder)** | 15 services `Reputation*`; `ReputationReplyService.ts:109` | EXISTE | Reusar |
| 33 | **LGPD (consent + retenção + esquecimento)** | `contact_consents` (`db.ts:5329-5344`); `LgpdService` completo; `maskIdentifier:17-22` | EXISTE | Reusar |
| 34 | **Outcome Assurance + Learning** | `OutcomeAssuranceService.assessAction:34`; `BusinessOutcomeResolver` registry; `PatternMemoryService` (único) | EXISTE | +1 resolver `BeautyOutcomeResolver` |
| 35 | **`AiGovernanceService.PEOPLE_AFFECTING`** | `AiGovernanceService.ts:19-40` | EXISTE | +1 entrada `estetica_appearance_advice` (F8) |

---

## 3. Decisões arquiteturais

- **D1 — `SIMULAÇÃO ≠ AGENDAMENTO ≠ ATENDIMENTO ≠ RESULTADO` é invariante.** Cada elo tem confirmação própria; nenhum coisa "está pronta" sem o próximo elo. `beauty_visual_consultations.status='selected'` NÃO cria appointment; `appointments.status='confirmed'` NÃO conta como atendimento; `completed` sem `clinical_encounters` fecha via `OutcomeReconcilerService` (herdado PRD 8).
- **D2 — Vertical = dado, não código.** Registrar `beleza` em `verticals.ts` (§1 auditoria) é 1 linha; blueprint `beleza_salao_v1` é seed via Master Admin (`POST /api/admin/blueprints` + `/publish` + `/organizations/:id/blueprint`). O segundo salão nasce sem deploy. `if vertical === "beauty"` é proibido — quem decide é `EntitlementService`, `NavigationManifestService`, `PermissionService`, `AiGovernanceService` (§7 do PRD).
- **D3 — Simulador de Cabelo = Fashion Studio com prompt invertido.** Mesmo contrato `TryOnProvider` (`FashionTryOnService.ts:41-46`), mesma família de tabelas (`beauty_*` espelha `fashion_*`), mesmo provider real (Gemini `gemini-2.0-flash-exp`), mesmo `input_hash` para idempotência, mesma fila `maxAttempts:1`, mesma URL assinada HMAC, mesma comparação lado a lado no frontend. O prompt inverte a regra: preservar rosto/corpo (herdado do `SAFETY_PROMPT:51-55`), **alterar cabelo**. NÃO cria segundo motor de simulação (§8 do PRD).
- **D4 — Recomendador Look→Serviços é DETERMINÍSTICO e GROUNDED no catálogo.** `LookServiceRecommendationService` cruza `beauty_reference_looks.suggested_services_json` × `products_services` do tenant; sem match → `insufficient_catalog` (nunca inventa serviço, preço, promoção — RN-BS-02). Sem serviço no catálogo → não sugere. Mesma barra do PRD 11 (`ENGAGEMENT ≠ BUSINESS VALUE`) aplicada ao domínio Beleza.
- **D5 — Agenda com profissional/sala/especialidade = Clínica.** A tabela `clinic_professionals` é agnóstica ao domínio (o nome é histórico; modela "quem atende, desacoplado de login, com PIN opcional"). A vertical Beleza a renomeia em UI para "Profissional" e reusa `ClinicAgendaService`, `ClinicScheduleSessionService.availability`, `ClinicVacancyService`, `ClinicRescheduleService`, `ClinicTreatmentCycleService`, `ClinicProfessionalAbsenceService`. NÃO cria segunda agenda (§8 do PRD). O blueprint `beleza_salao_v1` NÃO liga o módulo `clinica` (evita expor prontuário/TISS/etc. — só reusa os services).
- **D6 — N:N profissional↔serviço: decisão em F4.** Duas opções:
  - **(a) `professional_services` (tabela nova) **— mín. `(org, professional_id, service_id, active, is_primary, commission_percent)`. Mais claro semanticamente, permite comissão.
  - **(b) `clinic_professional_specialties` mapeando cada serviço como especialidade** — reuso puro, sem tabela nova; mas exige semear especialidade por serviço.
  - Recomendação: **(a)** — evita ambiguidade "corte é especialidade ou serviço?" e libera comissão por serviço nativamente.
- **D7 — Ficha técnica = `clinical_encounters.form_data`.** JSON livre por atendimento — o único campo extensível por atendimento em todo o sistema. Ficha de coloração (fórmula, produto, tempo, sensibilidade) vai aí. NÃO cria tabela nova.
- **D8 — Automação = comando GOVERNADO.** Manutenção detectada, retorno sugerido, vaga aberta, pedido de review → tudo via `DecisionAction → ApprovalPolicy(Autonomy Contract) → CommandExecutor → ConfirmationEngine` (D4 herdado PRD 10). +5 command handlers no MESMO registry (`beauty_maintenance_offer`, `beauty_review_invite`, `beauty_vacancy_offer`, `beauty_simulation_followup`, `look_service_recommendation`). NÃO cria segundo executor (§8).
- **D9 — Consent `comunicacoes` transversal, quiet-hours, frequency-cap.** A vertical Beleza torna explícito um gap load-bearing que hoje só o módulo Clínica endereça. F5-transversal move o check `LgpdService.hasConsent(orgId, contactId, 'comunicacoes')` para o sink (`MessageProviderService.sendMessage`), adiciona quiet-hours e frequency-cap. **Opt-in por flag global** — `outbound_consent_required`, `client_quiet_hours_enforced`, `client_frequency_cap_enforced` (default 0 para não quebrar tenants existentes; ligado no Studio Márcia no piloto).
- **D10 — Autopilot shadow-first (herdado RN-CG-10).** Beauty Autopilot propõe manutenção/retorno/review-invite/publicação mas NUNCA executa em `off` ou `auto` — sempre GOVERNADO. Aceitação da dona vira comando via `DecisionAction.propose`, nasce `awaiting_approval`, atravessa a autonomia.
- **D11 — Fotos = LGPD Art.5 II (dado pessoal sensível).** Consent tipado (`hair_simulation`) **separado** de consent `use_in_marketing` (§26 PRD — uma não implica a outra). Quarentena antes do processamento. EXIF strip. Storage privado. URL assinada HMAC (`beauty_private_media_v1`, TTL 15min). Retenção configurável (default 30d). Purga preguiçosa + Scheduler.
- **D12 — IA nunca julga aparência.** Herdado do Fashion Studio (`llm.ts:593` — *"NUNCA descreva, avalie ou comente corpo, peso, beleza ou aparência"*). Harmonia Visual é linguagem DESCRITIVA (contraste/equilíbrio/destaque), nunca ranking. `AiGovernanceService.PEOPLE_AFFECTING += "estetica_appearance_advice"` — sugestão estética passa a exigir ator humano + motivo, senão lança `human_decision_required`.
- **D13 — Dinheiro role-gated (§73 herdado).** `ContextProjectionService.hasFullBusinessVisibility:141` — recepção/cabeleireira nunca veem financeiro global; owner/admin sim. Vale para dashboard, Fala Tu, resultado de execução.
- **D14 — Isolamento cross-tenant duro.** Token do cliente do salão (portal) usa segredo próprio (padrão `FashionCustomerService.ts:28` — `sha256(JWT_SECRET:beauty_customer_v1)`). Toda query com `organization_id`. `beauty_avatar_assets`/`beauty_visual_consultations`/etc. **JAMAIS compartilhados entre tenants**.
- **D15 — Motor único de aprendizado.** Creative Learning e futuras aprendizagens Beleza escrevem em `PatternMemoryService` (§184 herdado — sem 2º Learning Engine). Só `assured` ensina forte (RN-EL-1).

---

## 4. Guardrails duros (RN-BS — no header dos services + testados)

- **RN-BS-01** — `SIMULAÇÃO ≠ AGENDAMENTO ≠ ATENDIMENTO ≠ RESULTADO`: cada elo com confirmação própria.
- **RN-BS-02** — IA NUNCA sugere serviço/produto/preço/promoção fora do catálogo do tenant (`products_services`). Sem match → `insufficient_catalog`.
- **RN-BS-03** — IA NUNCA julga aparência: Harmonia Visual descritiva, nunca ranking; `AiGovernanceService.PEOPLE_AFFECTING += "estetica_appearance_advice"`.
- **RN-BS-04** — Fotos são dado pessoal sensível: consent tipado antes do processamento; simulação e marketing são consents SEPARADOS; quarentena; EXIF strip; storage privado; URL assinada TTL 15min; retenção configurável + purga.
- **RN-BS-05** — Logs jamais contêm foto/base64/prompt com PII; `safety_report_json` só flags; `ux_telemetry_events` sanitiza via `safeId`.
- **RN-BS-06** — Idempotência real na simulação: `input_hash = sha256(avatarKey:params:provider.key)` — retry nunca cobra 2x.
- **RN-BS-07** — Isolamento cross-tenant duro: token do portal do cliente do salão tem segredo próprio; `beauty_*` sempre filtra `organization_id`.
- **RN-BS-08** — Dinheiro role-gated: recepção/cabeleireira nunca veem financeiro global; owner/admin sim (§73).
- **RN-BS-09** — Consent `comunicacoes` transversal (F5): nenhum outbound (campanha/cadência/oportunidade/review-invite) envia sem `LgpdService.hasConsent(..., 'comunicacoes')` quando flag ativa.
- **RN-BS-10** — Quiet-hours + frequency cap: default 8h-21h São Paulo, 3 msg/dia/contato (F5-transversal).
- **RN-BS-11** — Nunca inventa dado ausente: sem foto → sem simulação; sem serviço no catálogo → não sugere; sem histórico → não infere preferência.
- **RN-BS-12** — Shadow-first para autopilot: propõe mas NUNCA executa em `off`/`auto` — sempre GOVERNADO (RN-CG-10 herdada).

---

## 5. Plano de fatias — status

Cada fatia = 1 PR draft → CI verde → merge → next. Fluxo padrão do repo (CLAUDE.md).

| Fatia | Escopo | Status |
| --- | --- | --- |
| **F0** | doc-only: `docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md` + este ADR-169; Reuse Matrix, Impact/Dependency/Data Model/Migration/Regression/Flag/Rollback/Security/AI-Cost/E2E, RN-BS-01..12, plano F1–F18 | **MERGED (PR #1121)** |
| **F1** | Registro da vertical: +1 chave em `VerticalKey`/`VERTICALS`/`CONSENT_BY_VERTICAL` + `EntitlementService.FALLBACK_HIDDEN_BY_VERTICAL`; `test:beauty-registry` 42/42 | **MERGED (PR #1122)** |
| **F2** | Blueprint `beleza_salao_v1` publicado + inferência + piloto por dado; `test:beauty-blueprint-piloto` 54/54 | **MERGED (PR #1123)** |
| **F3** | `PermissionService.seedBeautyProfiles(orgId)` cria 3 perfis CUSTOM (Recepção/Cabeleireira/Gerente Beleza) idempotentes por nome, chamado síncrono best-effort pelo `assignToOrganization` quando `bp.baseVertical === "beleza"`. Recepção/cabeleireira sem financeiro global (RN-BS-08); gerente vê financeiro read (§73). `test:beauty-profiles` 75/75 (permissões coerentes, idempotência, preserva edição do admin, side-effect no assign, assign de outros blueprints não semeia beleza, cross-tenant isolado, integração com assignToUser+levelFor+can, SYSTEM_PROFILES intocado, zero hardcoded Studio Márcia). Regressão: `test:rbac-granular` 27/27, `test:rbac-profiles-api` 28/28, `test:vertical-blueprint-service` 48/48, `test:beauty-blueprint-piloto` 54/54, `test:beauty-registry` 42/42, tsc limpo. Sidebar/UI DEFERIDA (Sidebar já consome `isModuleEnabled`/`canAccessModule` que refletem o blueprint) | **em andamento (esta PR)** |
| **F4** | Duração do serviço lida pela agenda (fallback `AppointmentService.config` → `products_services.duration_minutes`); N:N `professional_services` (decidir tabela ou mapear especialidade — D6 recomenda tabela); `test:beauty-catalog-duration`, `test:beauty-professional-services` | pendente |
| **F5** | Tabelas `beauty_visual_consultations` + `beauty_avatar_assets` + `beauty_reference_looks` + `BeautyVisualConsultationService` (consentimento + upload + quarentena + URL assinada escopo `beauty_private_media_v1`); espelha `FashionAvatarService`; `test:beauty-visual-consultation` | pendente |
| **F6** | `BeautyHairSimulationProvider` (contrato `TryOnProvider`) + `BeautySimulationService` + `beauty_visual_simulations` + fila JobQueue `beauty_hair_simulation` (`maxAttempts:1`, idempotência por `input_hash`); prompt anti-injection invertido; `test:beauty-hair-simulation` | pendente |
| **F7** | UI de simulação + comparação lado a lado (reusa `FashionStudio.tsx`), disclaimer, seleção do visual; nova view `BeautyVisualConsultationView` no `App.tsx`+`useStore`+`Sidebar`; `test:beauty-visual-ui` | pendente |
| **F8** | `BeautyHarmonyAnalysisService` (linguagem DESCRITIVA, nunca ranking, catálogo determinístico); +`estetica_appearance_advice` em `AiGovernanceService.PEOPLE_AFFECTING`; `test:beauty-harmony-analysis` | pendente |
| **F9** | `LookServiceRecommendationService` (grounded em `products_services`; `beauty_reference_looks.suggested_services_json` casa com catálogo do tenant); nunca inventa; `test:beauty-look-to-services` | pendente |
| **F10** | Composição look→serviço→profissional→disponibilidade→agendamento (F4+F9+`ClinicScheduleSessionService.availability`+`ClinicAgendaService.createAppointment`); histórico visual em `clinical_encounters.form_data`; `test:beauty-look-to-appointment` | pendente |
| **F5-transversal** | Consent `comunicacoes` transversal + quiet-hours + frequency-cap (aditivo, opt-in por flag `outbound_consent_required` / `client_quiet_hours_enforced` / `client_frequency_cap_enforced`); check no sink `MessageProviderService.sendMessage`; `test:beauty-outbound-consent-transversal`, `test:beauty-quiet-hours-transversal`, `test:beauty-frequency-cap-transversal` — **RECOMENDADA antes de F11+** | pendente |
| **F11** | `AbandonedSimulationDetector` publica `business_signal` (dedupe `beauty:abandoned_simulation:{consultationId}`); Beauty Autopilot propõe follow-up (shadow); `test:beauty-abandoned-simulation` | pendente |
| **F12** | `BeautyMaintenanceDetector` (janela do serviço + histórico); handler `beauty_maintenance_offer` no MESMO registry; `test:beauty-maintenance-detector` | pendente |
| **F13** | Handler `beauty_review_invite` (pedir avaliação governada; grounded no atendimento assured; nunca sem consent `comunicacoes`); `test:beauty-review-invite` | pendente |
| **F14** | Detector "horário ocioso + cliente elegível" (composição `ClinicVacancyService` + `followUpQueue`) publica `beauty_vacancy_opportunity`; handler `beauty_vacancy_offer`; `test:beauty-vacancy-opportunity` | pendente |
| **F15** | Fala Tu intents de beleza (extende enum + switch conforme padrão FalaTuService §1.8 da auditoria); `test:beauty-falatu-intents` | pendente |
| **F16** | Métricas Beauty AI em `ux_telemetry_events` (whitelist +N event_types); dashboard master de custo/uso (reusa `AiUsageDashboardService`); `test:beauty-metrics` | pendente |
| **F17** | `test:beauty-golden-paths` (Studio Márcia fixture, fluxo E2E do §7 da análise); `test:beauty-hardening` codifica RN-BS-01..12 como regressão + runbook `docs/runbook/beleza-operacao.md`; **FECHA o ADR-169** | pendente |
| **F18** | **Prova §65**: cria "Salão Teste B" via blueprint, configura profissional/serviços/horários próprios — **sem alterar código** — e roda `test:beauty-tenant-b-generalization`. Se precisar tocar código, F18 volta a in-progress | pendente |

---

## 6. Rollout

**OFF (default) → shadow → single-tenant (Studio Márcia) → cohort → GA.** Todas as flags nascem `default 0`. Studio Márcia recebe ativação manual pelo Master Admin no piloto. Autopilot **nunca vai direto a GA** (RN-BS-12/RN-CG-10 herdada). F18 é o gate para GA: se a generalização "Salão Teste B" precisar tocar código, a arquitetura não está pronta.

---

## 7. Testes por fatia

Padrão do repo (CLAUDE.md fluxo de fatia): cada fatia entrega 1 script `scripts/test-beauty-*.ts` (idempotente, `tmpDir` isolado, helper `check(name, ok)`, cobre happy path + edge + audit + multi-tenant). Adicionado ao `package.json` + matrix do `.github/workflows/ci.yml`. F17 (`test:beauty-hardening`) tem dupla função: (a) codifica RN-BS-01..12 como regressão tocando os serviços REAIS de F1–F16; (b) verifica fiação de produção (services importáveis, rotas montadas, passes no Scheduler, handlers no registry canônico, runbook presente).

Regressão em cada fatia: rodar toda a suíte anterior + suíte das outras 8 verticais (`test:falatu*`, `test:clinic-*`, `test:reputation-*`, `test:social-*`, `test:growth-*`, `test:comigo-*`, `test:retail-*`, `test:escola-*`). Flag OFF preserva comportamento atual de tenants existentes (matriz A do PRD §58).

---

## 8. Consequências

**Positivas:**
- Segundo salão nasce por blueprint, sem deploy — cumpre §17/§65 do PRD.
- Reuso máximo: Clínica libera agenda profissional/sala/especialidade/ciclo; Fashion libera try-on; Runtime libera automação governada; Learning libera aprendizado — nada de motor duplicado.
- Endurecimento transversal (F5-transversal) beneficia todas as verticais existentes (consent `comunicacoes`, quiet-hours, frequency-cap) — aditivo, opt-in, reversível.
- Studio Márcia como fixture real pra `test:beauty-golden-paths` — a "dona de baixa afinidade com tecnologia" (§11 PRD) é aferida no teste E2E, não apenas em produção.

**Riscos e mitigações:**
- **Custo de IA** (simulador de cabelo): créditos por dia + idempotência por `input_hash` + master-only observability. Escalar quota com plano.
- **Guardrail "IA não julga aparência"**: entrada em `PEOPLE_AFFECTING` + prompt herdado + narrativa determinística. `test:beauty-harmony-analysis` codifica a regra.
- **Consent transversal (F5)**: opt-in por flag global; default 0 não quebra tenants; audit de bloqueio em cada sink.
- **Generalização (F18)**: teste explícito. Se falhar, é a arquitetura que ainda não está pronta — F18 volta a in-progress e itera até passar.

**Neutras / trade-offs:**
- Reusar `clinic_*` tables e services para uma vertical "beleza" pode parecer estranho semanticamente, mas o custo de renomear é maior que o benefício (breaking changes em 15+ ADRs, retrocompatibilidade). O nome da tabela é histórico; o modelo é agnóstico. F17 documenta claramente no runbook a decisão.
- Não abrir módulo-corpo `beleza` no `PLAN_GRADE` inicialmente — a vertical usa módulos já existentes (`agenda`, `catalogo`, `vendas`, `campanhas`, `estudio`, `diretor`, `rie`, `execucao`, `copiloto`) + `beauty_hair_simulator_enabled` como flag sub-feature. Se um bundle "Beleza + Simulador" for necessário comercialmente, entra em `PLAN_BUNDLES` como aditivo (molde: `growth_clinica` em `plansGrade.ts:106-124`).

---

## 9. Referências

- **PRD:** "Vertical Beleza & Salões — ZapFlow", v1.0, 14/08/2026 (documento origem)
- **Análise F0:** `docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md` (Reuse Matrix + 30 perguntas do PRD §6 + Plans + E2E)
- **ADRs pai:**
  - ADR-092 (distribuição por vertical — §60 previa `💇 beleza`)
  - ADR-145 (Clínica Jornada — molde da agenda profissional/sala/especialidade/ciclo)
  - ADRs 034–044, 103–104 (Fashion Studio — molde do try-on)
  - ADR-153 (Vertical Entitlements / Blueprint)
  - ADR-060 (Appointment), ADR-072 (Module), ADR-091 (Planos), ADR-095 (RBAC granular)
  - ADR-136 (BusinessSignal), ADR-152/158/159 (Runtime + espinha + Autonomy)
  - ADR-163 (Invisible UX — molde do "Hoje" por exceção)
  - ADR-165 (Outcome Assurance), ADR-166 (Enterprise Learning)
  - ADR-167/168 (Social + Growth — molde da publicação governada e da conversão)
- **CLAUDE.md convenções críticas:** nº 1 (isolamento), nº 2 (CREATE-then-ALTER), nº 4 (HMAC), nº 6 (LGPD), nº 10 (feature flags), nº 12 (BusinessSignal)
