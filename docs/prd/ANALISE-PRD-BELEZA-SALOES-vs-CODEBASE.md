# Análise Comparativa — PRD Vertical Beleza & Salões × Codebase

**Escopo:** entregável do **BEAUTY-000** (Gate 0 do PRD "Vertical Beleza & Salões — ZapFlow", v1.0, 14/08/2026). Prova, com evidência `file:symbol`, o que já existe no `main` para que a implementação (F1+) seja **predominantemente REUTILIZAR / CONFIGURAR / ESTENDER** e só o mínimo CRIAR. **Documento sem código de produção** — a implementação está **bloqueada até esta F0 mergear** (Regra Zero do PRD §3 / §78).

**Tenant piloto:** Studio de Beleza Márcia. **Regra dura:** nenhum acoplamento hardcoded ao Studio — tudo por dado (`vertical_blueprints`, `organization_settings`, seeds), para que um segundo salão receba a vertical sem alteração de código (PRD §17, §65).

**Conclusão executiva:** o ZapFlow já cobre a operação essencial de um salão com **~85% de reuso puro**. O núcleo canônico da Clínica (agenda com profissional/sala/especialidade, ciclos renováveis, ficha extensível, lembretes, lista de espera, remarcação por WhatsApp) casa 1:1 com o operacional de salão (corte, coloração, escova, unhas, cabine, pacote de 10 escovas, ficha de coloração, lembrete 24h, "abriu horário sábado à tarde"). O Fashion Studio já entrega o try-on virtual completo (upload consentido → quarentena → geração via provider plugável Gemini/OpenAI → comparação lado a lado no frontend) — o Simulador de Cabelo é o **mesmo motor com prompt invertido** (preservar rosto, alterar cabelo). O Estúdio de Criação, o Execution Runtime (DecisionAction→ApprovalPolicy→CommandExecutor→ConfirmationEngine), o Fala Tu, o BusinessSignal, o Autonomy Contract, o Outcome Assurance e o Enterprise Learning são **transversais e reutilizados verbatim**. As lacunas reais são de borda: (a) registrar a chave `beleza` no catálogo de verticais e criar o blueprint `beleza_salao_v1`, (b) o Simulador de Cabelo como novo provider/tabelas espelhando `fashion_*`, (c) 3 conectores finos ao `products_services` (duração de serviço lida pela agenda; N:N profissional↔serviço) e (d) elevar consent `comunicacoes` + quiet-hours + frequency cap **do módulo Clínica para transversal** (gap load-bearing, não específico de beleza — mas a vertical exige).

> **Regra fundante do PRD (§77 / instrução final):** *"OBSERVAR → ENTENDER → PRIORIZAR → DECIDIR → EXECUTAR → ACOMPANHAR → APRENDER"* — a vertical Beleza NÃO é um ERP de salão; é o mesmo cérebro do ZapFlow (PRDs 0–11) exposto por uma superfície familiar ao segmento. **`SIMULAÇÃO ≠ AGENDAMENTO ≠ ATENDIMENTO ≠ RESULTADO`** — cada elo do fio Descobrir→Experimentar→Decidir→Agendar→Atender→Recomprar tem sua própria assinatura e evidência (herda `DONE ≠ RESULTADO` do PRD 8 e `ENGAGEMENT ≠ BUSINESS VALUE` do PRD 11).

---

## 1. Tese: o que já existe vs. o que a vertical precisa ligar

| Capacidade do PRD | Existe no `main`? | Evidência `file:symbol` |
| --- | --- | --- |
| Registro da vertical (catálogo + preset + consents) | ✅ (só faltam +1 entrada) | `verticals.ts:8-9` (`VerticalKey`), `verticals.ts:94-148` (`VERTICALS`), `verticals.ts:23-32` (`CONSENT_BY_VERTICAL`); `ADR-092:60` já previu `💇 beleza` |
| Blueprint por nicho (SKU sem deploy) | ✅ | `VerticalBlueprintService.ts`, `BlueprintSeeder.ts:49-168`, `vertical_blueprints`/`organization_blueprints` (`db.ts:7555-7593`) |
| Entitlements / plano / add-on / gate server-side | ✅ | `EntitlementService.ts:204`, `ModuleService.ts:82`, `PlanService.ts`, `AddonService.ts:18-37`, `SocialEntitlementService.assertAllowed:49` (molde do gate por capability) |
| RBAC granular + perfis customizáveis | ✅ (perfis por-vertical: gap) | `PermissionService.ts:129-152` (6 `SYSTEM_PROFILES`); `role_profiles`/`role_permissions` (`db.ts:5659-5675`); dinheiro role-gated `ContextProjectionService.hasFullBusinessVisibility:141` |
| CRM canônico (contato + memória + tags/notes) | ✅ | `contacts` (`db.ts:37-47` + `avg_ticket`, `memory_facts`, `tags`, `notes`), `CustomerProfileService.ts`, `CustomerMemoryService.ts` |
| **Agenda com profissional + sala + especialidade** | ✅ | `appointments` (`db.ts:221-235` + `professional_id:3117`, `room_id:3119`, `expected_duration_minutes:3121`); `ClinicAgendaService.ts` (createAppointment + findConflicts + checkRoomCapacity + gate de ausência) |
| Anti-double-booking (transação atômica AC-012) | ✅ | `ClinicScheduleSessionService.ts:322-374` (tx: COUNT dentro → INSERT); race-por-unique `ClinicAgendaService.scheduleFollowUp:507-528` |
| Cálculo de horários livres com profissional + ausência + sala | ✅ | `ClinicScheduleSessionService.availability:567-648`; `ClinicProfessionalAbsenceService.overlaps:170-186` |
| Lista de espera / vaga por cancelamento | ✅ | `ClinicVacancyService.ts` (`tryOfferOnCancel:82`, `pickCandidate:172`, `handleReply:264`) |
| Remarcação por WhatsApp (oferta de 3 horários) | ✅ | `ClinicRescheduleService.ts` (`findSlots:79`, `createOffer:138`, `handleChoice:192`) |
| **Pacote renovável (10 sessões, saldo derivado — RN-004)** | ✅ | `ClinicTreatmentCycleService.ts` (`usage:157`, `renew:426`, `renewalQueue:531`); `clinic_treatment_cycles` (`db.ts:2850-2878`) |
| **Janela de retorno / manutenção** | ✅ | `clinical_encounters.follow_up_recommended_days` (`db.ts:3322`); `ClinicAgendaService.followUpQueue:542-580`, `scheduleFollowUp:458-533` |
| **Ficha técnica extensível por atendimento** | ✅ | `clinical_encounters.form_data TEXT` (JSON livre, `db.ts:3252-3271`) — reuso direto para "ficha de coloração" |
| Profissional desacoplado de login | ✅ | `clinic_professionals` (`db.ts:2576-2586`, `user_id` **opcional**); PIN + registration/council (`db.ts:3221-3237`) |
| Especialidades + N:N profissional↔especialidade | ✅ | `clinic_specialties` (`db.ts:2708-2723`), `clinic_professional_specialties` (`db.ts:2734-2747`), `ClinicSpecialtyService.listProfessionalsForSpecialty:218-248` |
| Sala/cabine com capacidade | ✅ | `clinic_rooms` (`db.ts:2589-2595` + `capacity:2943`, default 1) |
| Serviços/produtos/estoque/custo | ✅ (`duration_minutes` órfã: gap #1) | `products_services` (`db.ts:196-209` + `duration_minutes:766`, `metadata_json:207`, `category:1326`); `inventory_items.avg_cost:763` |
| N:N profissional↔serviço | ❌ | zero — competência é por *especialidade*, não por serviço do catálogo |
| **Try-on virtual (upload → geração → comparação)** | ✅ (o motor exato) | `FashionTryOnService.ts:41-46` (interface plugável), `FashionAvatarService.ts` (consentimento+quarentena+EXIF+URL assinada), `fashion_avatar_assets/tryon_jobs/usage_credits/preset_avatars/consents` (`db.ts:4994-5224`); UI comparação lado a lado `src/storefront/FashionStudio.tsx:326-338,758-775` |
| Gateway de IA (chat/vision/imagem/vídeo, metering) | ✅ | `src/server/llm.ts:70-105` (`recordUsage` → `ai_usage_log`); `generateImageB64:168-186` (Imagen ‖ gpt-image-1); `editImagesGoogleB64:261-298`; `PlanService.studioAllowed:239-252` |
| Guardrail "IA nunca julga aparência" | ✅ (padrão a herdar) | `FashionAvatarService.ts:138-153` (catálogo determinístico); `llm.ts:593` (*"NUNCA descreva, avalie ou comente corpo, peso, beleza ou aparência"*); `AiGovernanceService.PEOPLE_AFFECTING:19-40` — falta entrada para sugestão estética |
| Storage privado + URL assinada HMAC | ✅ (padrão canônico) | `src/server/fileSigning.ts` (`scopeSecret = sha256(JWT_SECRET:{scope}_v1)`, TTL 15min, `timingSafeEqual`); 6 escopos hoje (`fashion_private_media_v1`, `fashion_look_share_v1`, `fashion_customer_v1`, `clinical_document_v1`, `clinical_guide_v1`, `clinical_monthly_report_v1`) |
| Jobs / filas / async / dedup / retry | ✅ | `JobQueueService.ts:55` (`enqueue`, `errorClass`, `computeBackoffSeconds:40-44`, `sweepStale:114-132`); handlers de imagem: `fashion_tryon`, `storefront_look_image` |
| Estúdio de Criação (marca→arte→legenda→publicar) | ✅ | `StudioService.ts:55` (`generate`, `suggestCaption`, `schedulePost`); `BrandDnaService.ts`; `GrimoireService.ts`; `HookIntelligenceService`, `ScriptIntelligenceService`, `ChannelAdaptationService`, `CreativeVariantService` |
| Publicação governada (`social_publish`) + calendário draft→approved | ✅ | `GovernedPublishService.ts:40`; `SocialPublishCommandHandler.ts:23-60`; `EditorialCalendarService.ts:38-98`; provider `InstagramChannelProvider` + `FacebookChannelProvider` reais |
| Fala Tu (captura multimodal + confirmar/executar) | ✅ | `FalaTuService.ts` (`interpret:192`, `confirm:439`), portas I/O opt-in `bridgeState:670`; paridade WhatsApp `FalaTuWhatsAppService.ts:91`; briefing `FalaTuBriefingTaskService.ts`; home por exceção `FalaTuHomeService.home:42` |
| **Execution Runtime completo** | ✅ | `DecisionActionService.propose:40`; `ApprovalPolicyService.resolve:62` + `resolveContract:110` (Autonomy Contract); `CommandExecutorService.execute:188` (G1/G2/G3 + idempotência durável) + registry (21 command types); `ConfirmationEngine.expect:89`/`confirm:166`/`sweepTimeouts:238`; `ProcessRuntimeService` (FSM 13 estados) |
| BusinessSignal (espinha única) + dedupe + TTL | ✅ | `business_signals` (`db.ts:5927-5949` + `correlation_id:8321`, `expires_at:8340`); `BusinessSignalService.publish:58` + `attention:109`; `SmartInboxService.build:83`; router `SignalProcessRouterService.TRIGGER_MAP:55-63` |
| Detector de "cliente inativa" | ⚠️ (só olha `orders`) | `ChurnRiskDetectorService.ts:55` (silêncio no canal, fatura vencida, ticket frio); `Scheduler.reactivationPass:1521-1585`, `repurchaseReminderPass:1995-2070`. Não olha `appointments` — gap para salão |
| **Consent `comunicacoes` (Art.7) antes de enviar** | ⚠️ **só Clínica** | 24 call-sites, todos `Clinic*` (`ClinicReminderService.ts:170`, etc.). Campanhas/cadências/NPS/recuperação comercial checam **só** `contacts.marketing_opt_out`. **Gap load-bearing** — a vertical Beleza exige. |
| Quiet-hours para outbound a cliente | ❌ | `UxPreferencesService.isAwake:86` só governa push interno ao dono (`FalaTuProactiveService.deliver:79`). Nenhum envio outbound a cliente checa hora permitida. |
| Frequency cap transversal | ❌ | Só dedupe por chave + teto de 3 tentativas em `SalesRecoveryFollowupService` + delay anti-ban 4-9s em `CampaignService:131` |
| Opt-out por palavra-chave no WhatsApp | ⚠️ 2 pontos isolados | `ClinicReminderReplyService.ts:45` (`PARAR|STOP|...` → revoga consent `comunicacoes`); `SalesRecoveryReplyService.ts:201-211` (`remove_me` → seta `marketing_opt_out=1`). Não é interceptor global do `webhookProcessor`. |
| Pesquisa de satisfação / NPS | ⚠️ CSAT 1-5 pós-`orders.paid_at` | `satisfaction_surveys` (`db.ts:874-888`); `SatisfactionService.ts`; `Scheduler.npsPass:1847`. Gatilho é sempre `orders.paid_at` — não há survey por atendimento/serviço |
| "Pedir avaliação" (Google/redes) proativamente | ❌ | módulo Reputação é reativo (ingere → investiga → responde). Handler novo + detector novo para "pedir review" |
| LGPD (consent + retenção + esquecimento + portabilidade) | ✅ | `contact_consents` (`db.ts:5329-5344`); `LgpdService.ts` (`grantConsent:225`, `revokeConsent:237` com cascata, `exportContact:66`, `forgetContact:208`, `retentionPass:24`); `maskIdentifier` `auditLog.ts:17-22` |
| Audit / telemetria / analytics derivadas por query | ✅ | `auth_audit_logs` (`logAuthEvent` `auditLog.ts:38-53`); `AnalyticsService.ts` (RN-004); `ux_telemetry_events` opt-in (`db.ts:7672-7686`) |
| Reputação (avaliações negativas + resposta governada) | ✅ | 15 services `Reputation*`; `ReputationReplyService.ts:109` (handler `reputation_publish_reply` com grounding + idempotência); `ReputationClosureService` (réplica reabre caso) |
| Outcome Assurance + Enterprise Learning | ✅ | `OutcomeAssuranceService.assessAction:34`; `BusinessOutcomeResolver` registry; `PatternMemoryService` (motor único); `CreativeLearningService` |
| StorageService / S3 mirror | ✅ (só PDF/JSON hoje) | `StorageService.ts` — `contentTypeFor:38-42` só conhece `.pdf`/`.json`. Imagens do try-on ficam no disco local (gap conhecido) |
| Multi-tenant enforcement | ✅ | `server.ts:446-473` (bloqueio); `server.ts:552-560` (gate módulo); `enforceModulePermission` `middleware/auth.ts:184-199`; convenção nº 1 (`orgId` 1º arg) |

**Achado central:** os **três motores de maior porte** que a vertical exige — try-on de imagem, agenda com profissional/sala/especialidade/ciclos e execução governada com aprendizado — **já existem, provados em produção e generalizáveis por registro/registro/registry**. Nenhuma exige motor novo. O trabalho de F1+ é **plugagem, blueprint, +1 tabela família por domínio novo (simulador de cabelo, olhando `fashion_*`) e 3 conectores finos ao catálogo de serviços**, mais o endurecimento de consent+quiet-hours+frequency-cap que a vertical trouxe à tona (mas beneficia todas).

---

## 2. Matriz REUTILIZAR / CONFIGURAR / ESTENDER / CRIAR / DEFERIR (§4 do PRD)

Cada linha aponta a origem e a classificação. Uma linha só recebe **CRIAR** quando o item não pode ser atendido por reuso/configuração/extensão de código existente (PRD §4 regra dura).

### 2.1 Fundação (BEAUTY-001 a BEAUTY-003)

| Capacidade | Existe | Reutilizar | Configurar | Estender | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Registro da vertical | ✅ | | ✅ (+1 objeto em `VERTICALS`) | | | |
| Consentimento pré-populado por vertical | ✅ | ✅ | ✅ (+1 chave em `CONSENT_BY_VERTICAL`) | | | |
| Blueprint `beleza_salao_v1` (moldes: `moda_loja_unica`, `clinica_multiespecialidades`) | ✅ | ✅ | ✅ (só dado via Master Admin) | | | |
| Fallback hidden por vertical | ✅ | | ✅ (+1 linha em `FALLBACK_HIDDEN_BY_VERTICAL`) | | | |
| Módulos do preset (agenda, catalogo, vendas, pagamentos, cadencias, campanhas, assinaturas, areas, diretor, rie, execucao, copiloto, estudio) | ✅ | ✅ | | | | |
| Módulo-corpo próprio `beleza`? | — | | | | ⚠️ **evitar** (v.PRD §7-8) — se necessário, `PLAN_GRADE` precisa entrar | |
| Tenant piloto Studio Márcia (dados via onboarding, nunca constante) | ✅ | ✅ (`POST /api/auth/register` + `POST /api/admin/organizations/:id/blueprint`) | ✅ | | | |
| Perfis por vertical (cabeleireiro, recepção, comissionado) | ⚠️ | ✅ (`role_profiles`/`role_permissions` genéricos) | ✅ (seed condicional por blueprint) | ⚠️ (opcional: `SYSTEM_PROFILES` +3) | | |
| Import de dados existentes (Fresha, planilha) | ✅ | ✅ (`SmartImportService` + `routes/import.ts`) | ✅ | | | ⏸️ scraper permanente **DEFERIR** (PRD §18) |

### 2.2 Operação (BEAUTY-004 a BEAUTY-008)

| Capacidade | Existe | Reutilizar | Configurar | Estender | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Catálogo de serviços (nome/preço/duração/imagem/ativo) | ✅ | ✅ (`products_services type='service'`) | | | | |
| **Duração do serviço lida pela agenda** | ⚠️ (coluna existe, motores ignoram) | | | ✅ (leitura em `AppointmentService.config` fallback → `products_services.duration_minutes`) | | |
| Intervalo recomendado de manutenção por serviço | ⚠️ (só por atendimento) | ✅ (`follow_up_recommended_days`) | | ✅ (opcional: `products_services.maintenance_days` como default sugerido) | | |
| N:N profissional↔serviço | ❌ | | | | ✅ **mín.** `professional_services(org, professional_id, service_id, active, is_primary)` ou reusar `clinic_professional_specialties` mapeando cada serviço como especialidade | |
| Comissão por profissional | ⚠️ (existe `retail_commission_enabled` acoplado ao Retail) | | | ✅ (`professional_services.commission_percent` opcional; roteador `RetailCommissionService`) | | ⏸️ folha/pagamento — DEFERIR |
| CRM da cliente (histórico, preferências, produtos, profissional preferido) | ✅ | ✅ (`contacts` + `memory_facts` + `tags`) | ✅ | ✅ (opcional: `contacts.preferred_professional_id` como tag até virar coluna) | | |
| Anti-double-booking (padrão AC-012) | ✅ | ✅ (`ClinicScheduleSessionService.ts:322-374`) | | | | |
| Agenda com profissional/sala/duração/status | ✅ | ✅ (`ClinicAgendaService` completo) | ✅ | | | |
| Disponibilidade com profissional + ausência + sala | ✅ | ✅ (`ClinicScheduleSessionService.availability:567-648`) | | | | |
| Lista de espera / vaga por cancelamento | ✅ | ✅ (`ClinicVacancyService`) | | | | |
| Remarcação com oferta de 3 horários | ✅ | ✅ (`ClinicRescheduleService`) | ✅ (janela hardcoded 8-18 hoje — trocar para `agenda_open_hour`) | | | |
| **Pacote renovável (10 escovas, saldo derivado)** | ✅ | ✅ (`ClinicTreatmentCycleService`) | ✅ | | | |
| Janela de retorno (retorno de mechas em 60d configurável) | ✅ | ✅ (`followUpQueue` + `scheduleFollowUp`) | ✅ | | | |
| Ficha técnica por atendimento (fórmula de coloração, alergia, escova preferida) | ✅ | ✅ (`clinical_encounters.form_data`) | ✅ (JSON por especialidade/serviço) | | | |
| Horário de funcionamento por dia da semana / intervalo de almoço / por profissional | ⚠️ (janela única `agenda_*_hour`) | | ✅ (parcial) | ✅ (`business_hours(org, dow, start, end)` como estender `organization_settings`) | | ⏸️ por profissional → F4/F5 |
| Dashboard "Hoje" simples (agendados, próximos, livres, retornar, aprovar, pendências) | ✅ | ✅ (`FalaTuHomeService.home:42`) | ✅ | ✅ (composição específica de beleza usando cards existentes) | | |
| Portal do profissional (agenda própria) | ✅ | ✅ (`ClinicProfessionalService` + `clinic_professionals.user_id` opcional) | ✅ | | | |

### 2.3 Beauty AI — Simulador + Harmonia Visual (BEAUTY-009 a BEAUTY-014)

| Capacidade | Existe | Reutilizar | Configurar | Estender | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Consentimento tipado (avatar_processing, personalization, whatsapp_notification) | ✅ | ✅ (`fashion_consents` `db.ts:5188-5197`) | ✅ (+ escopos beleza: `hair_simulation`, `use_in_marketing` separado) | | | |
| Upload consentido + quarentena + EXIF strip + validação por IA (só flags booleanas) | ✅ | ✅ (`FashionAvatarService.ts:87-131`) | | | | |
| Storage privado + URL assinada HMAC + TTL 15min | ✅ | ✅ (novo escopo `beauty_private_media_v1` via `fileSigning.ts`) | | | | |
| Retenção configurável + purga preguiçosa + Scheduler | ✅ | ✅ (`FashionAvatarService.purgeExpired` + `Scheduler.ts:827-829`) | ✅ (`storefront_settings.beauty_avatar_retention_days`) | | | |
| Try-on / edição de imagem (interface provedor plugável) | ✅ | ✅ (`FashionTryOnService.ts:41-46` — molde exato) | | | | |
| Créditos diários + idempotência por `input_hash` + fila `maxAttempts:1` | ✅ | ✅ (`FashionTryOnService:120-217`) | ✅ | | | |
| **Prompt fixo anti-injection** (para o Simulador: preservar rosto/corpo, **alterar** cabelo) | ✅ (padrão) | ✅ | | ✅ (novo prompt derivado do `SAFETY_PROMPT:51-55` invertido) | | |
| Provider real de imagem (Gemini `gemini-2.0-flash-exp`, OpenAI `gpt-image-1`) | ✅ | ✅ (`llm.editImagesGoogleB64:261-298` / `editImagesB64:232-247`) | | | | |
| Presets curados pelo salão (referências de cor/corte reais) | ✅ | ✅ (`fashion_preset_avatars` `db.ts:5214-5224` — molde para `beauty_reference_looks`) | ✅ | ✅ (colunas `hair_type`, `length`, `tone`) | | |
| Comparação lado a lado (visão frontal, ¾, perfil D, perfil E — como nas imagens de referência do PRD) | ✅ | ✅ (`FashionStudio.tsx:326-338,758-775`) | | ✅ | | |
| Escolha de referência assistida por IA (por tom de pele / tipo de cabelo) | ✅ (molde) | ✅ (`StorefrontLookGenerationService.chooseAvatar:48-72`) | | ✅ (prompt específico beleza) | | |
| Disclaimer visível de simulação | — | | ✅ (texto do PRD §31) | | | |
| **`VisualConsultation` como sessão** (objetivo + intensidade + fotos + geradas + escolhida) | ⚠️ | ✅ (`fashion_looks/_items/_requests` como molde) | | | ✅ **mín.** `beauty_visual_consultations` + `beauty_visual_simulations` | |
| Análise de Harmonia Visual (contraste/equilíbrio/destaque, sem ranking) | ❌ | | | ✅ (prompt determinístico grounded na análise proporcional) | ✅ **mín.** `beauty_visual_analyses` (linguagem descritiva, não julgamento) | |
| Guardrail: IA nunca julga aparência (Art.11) | ⚠️ (implícito) | ✅ (`llm.ts:593` prompt) | | ✅ (adicionar `estetica_appearance_advice` em `AiGovernanceService.PEOPLE_AFFECTING:19-40`) | | |
| **Look→Serviços do catálogo real** (nunca inventa serviço/preço) | ❌ | ✅ (`products_services`) | | ✅ (recomendador determinístico grounded no catálogo) | ✅ **mín.** `LookServiceRecommendationService` | |
| Look→Produtos home care | ❌ | ✅ (`products_services type='product'`) | | ✅ | ✅ **mín.** | |
| **Look→Agendamento** (visual → serviço → profissional habilitado → disponibilidade → horário) | ✅ (peças) | ✅ (composição: recomendador + `ClinicScheduleSessionService.availability`) | | | | |
| Histórico visual (antes/depois/serviços/profissional/satisfação) | ⚠️ (peças) | ✅ (`clinical_encounters.form_data`) | | ✅ (referência a `beauty_visual_consultations` + antes/depois) | | |

### 2.4 Execution Intelligence, Estúdio, Reputação, Métricas (BEAUTY-015 a BEAUTY-020)

| Capacidade | Existe | Reutilizar | Configurar | Estender | Criar | Deferir |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Detector "simulação abandonada → oportunidade" | ✅ (peças) | ✅ (`BusinessSignalService.publish` + `ChurnRiskDetectorService` como molde) | ✅ (limiar em `organization_settings`) | | ✅ **mín.** `AbandonedSimulationDetectorService` | |
| **Detector "cliente para manutenção" (janela do serviço + histórico)** | ✅ | ✅ (`ClinicAgendaService.followUpQueue`) | ✅ (per-service window opcional) | ✅ (varredura por serviço, publica sinal) | | |
| Detector "cliente inativa" que olha **appointments** (não só orders) | ❌ (todos olham orders) | ✅ (`ChurnRiskDetectorService` como molde) | ✅ | ✅ (novo fator: dias desde último appointment concluído) | | |
| Detector "horário ocioso amanhã + cliente elegível" | ⚠️ | ✅ (composição: `ClinicVacancyService` + `followUpQueue`) | ✅ | ✅ | | |
| **Pós-atendimento: pedir avaliação (Google/Instagram) grounded** | ❌ | ✅ (Reputação como resposta) | | ✅ (`ReviewInviteCommandHandler` — novo handler no MESMO registry) | ✅ **mín.** detector + handler | |
| Automação: publicação governada, opt-in, idempotente, com cooldown | ✅ | ✅ (`GovernedPublishService` + `DecisionAction→ApprovalPolicy→CommandExecutor`) | ✅ | | | |
| **Consent `comunicacoes` transversal** (checado em cadências/campanhas/NPS/oportunidades) | ❌ **gap load-bearing** | | | ✅ (mover `LgpdService.hasConsent(..., 'comunicacoes')` para o sink de outbound: `MessageProviderService` + `CampaignService.resolveSegment` + `SalesRecoveryReplyService`) | | |
| **Quiet-hours para outbound a cliente** | ❌ | | | ✅ (`UxPreferencesService` estender para `client_quiet_hours` + gate em `MessageProviderService`) | | |
| **Frequency cap por contato** | ❌ | | | ✅ (`contact_message_budget(org, contact_id, day, count)` derivado; cap default 3/dia) | | |
| Estúdio de Criação (antes/depois, transformação, dica, horário disponível, serviço, produto, depoimento, bastidores) | ✅ | ✅ (`StudioService` + `BrandDnaService` + `HookIntelligenceService` + `ScriptIntelligenceService` + `ChannelAdaptationService`) | ✅ | | | |
| Reputação (ingestão externa + investigação + resposta governada + fechamento) | ✅ | ✅ (15 services `Reputation*`) | ✅ (`reputation_connectors.enabled`) | | | |
| Fala Tu com intents de beleza | ✅ | ✅ (extender enum + switch `confirm:439` seguindo padrão FalaTuService) | ✅ | ✅ (`FalaTuIntent += "APPOINTMENT_QUERY" | "VACANCY_QUERY" | "REVIEW_REQUEST"` — se distinção pesar) | | |
| Métricas operacionais (ocupação/cancelamento/no-show/tempo ocioso) | ✅ (peças) | ✅ (`AnalyticsService` + queries derivadas) | | ✅ | | |
| Métricas Beauty AI (simulações iniciadas/concluídas/visual escolhido/simulação→serviço/simulação→agendamento) | ⚠️ | ✅ (`ux_telemetry_events` opt-in) | ✅ (whitelist +N event_types) | ✅ | | |
| Inteligência de vertical compartilhada (tendências beleza) | ✅ | ✅ (`ResearchBrokerService` + `VerticalIntelligenceService` — quando dado do Admin Master existir) | ✅ (`vertical_intelligence` com `vertical='beleza'`) | | | |
| Outcome Assurance (simulação→agendamento→atendimento→retorno) | ✅ | ✅ (`OutcomeAssuranceService.assessCorrelation`; `BusinessOutcomeResolver` registrar `BeautyOutcomeResolver`) | | ✅ | | |
| Enterprise Learning (motor único `PatternMemoryService`) | ✅ | ✅ (só `assured` ensina forte — herda RN-EL-1) | | | | |

**PROIBIDO CRIAR (PRD §7 / §8 / §77):**
- Segundo CRM (`BeautyCustomer`, `SalonCustomer`) — cliente do salão continua sendo `contacts`.
- Segunda agenda (`BeautyAgenda`, `SalonAppointment`) — reusar `appointments` + `ClinicAgendaService` com blueprint sem módulo `clinica` ativo.
- Segundo catálogo (`SalonService`, `BeautyProduct`) — `products_services type='service'|'product'`.
- Segunda entidade de profissional (`SalonProfessional`) — `clinic_professionals` (o próprio nome do domínio de origem é irrelevante — a tabela modela "quem atende, desacoplado de login, com PIN opcional").
- Segundo Estúdio, segunda fila de jobs, segundo gateway de IA, segundo executor, segundo motor de aprovação/confirmação/aprendizado, segunda tabela de alerta (`beauty_alerts`), segundo NPS, segunda tela de credenciais/OAuth, segredo no browser.
- Segundo motor de simulação — o Simulador de Cabelo é `FashionTryOnService` com prompt/tabelas próprias, atrás do MESMO contrato `TryOnProvider`.
- `if vertical === "beauty"` espalhado — vertical entra por `verticals.ts`, `EntitlementService`, `NavigationManifestService`, `AiGovernanceService`, `PermissionService` — nunca por branch no serviço de domínio.

---

## 3. Evidência por área (síntese das 4 auditorias)

### 3.1 Plataforma / verticais / RBAC / entitlements — reuso quase-total

O ZapFlow trata **vertical como dado**, não como código: `verticals.ts:94-148` lista 8 verticais como constante TypeScript; `organization_settings.vertical` (`db.ts:1561`) guarda a chave por tenant; `ModuleService.applyVertical:171-194` respeita a wishlist + `PlanService.modulesForPlan` + grandfather de add-ons + `LgpdService.seedConsentForVertical`. O `EntitlementService.check:204` é a porta única (7 estados, 5 ações, 12 reasons) que compõe módulo × plano × RBAC × billing × blueprint — **exatamente o padrão que a vertical Beleza consome sem alterar**. O blueprint `VerticalBlueprintService` + `BlueprintSeeder.INITIAL_BLUEPRINTS:49-168` permite criar `beleza_salao_v1` **por dado** via `POST /api/admin/blueprints` + `/publish` + `/organizations/:id/blueprint` — o segundo salão nasce sem deploy (PRD §17, §65). Perfis granulares `role_profiles`/`role_permissions` (`db.ts:5659-5675`) suportam papéis Beleza (recepção/cabeleireira/comissionado); dinheiro é role-gated por `ContextProjectionService.hasFullBusinessVisibility:141` (§73, RN-BS-8).

**Achado:** o Sidebar ainda não consome `/api/entitlements/navigation-manifest` (backend pronto, cliente não); a navegação por necessidade que o PRD §13 pede se ativa **do cliente**, não é bloqueio de vertical.

### 3.2 CRM / agenda / profissionais / serviços — Clínica é o molde

`contacts` é a entidade canônica (não `customers`) com `avg_ticket`, `tags` (CSV), `notes`, `memory_facts` (ADR-071). `appointments` é a tabela única — `professional_id` (`db.ts:3117`) substitui o `assigned_to` morto; `expected_duration_minutes` (`:3121`) é o gancho para "corte = 45min". `ClinicAgendaService` já traz o guard de conflito por profissional OU sala (`findConflicts:190-241`, bypass `force` com motivo obrigatório e audit), o gate de ausência (`ClinicProfessionalAbsenceService`), o padrão AC-012 de transação atômica (`ClinicScheduleSessionService.ts:322-374`), o cálculo mais completo de disponibilidade com profissional+ausência+sala (`availability:567-648`), lista de espera (`ClinicVacancyService`), remarcação com oferta de 3 horários (`ClinicRescheduleService`), ciclos renováveis com saldo derivado (`ClinicTreatmentCycleService`), fila de retorno (`followUpQueue:542-580`), e o campo `clinical_encounters.form_data TEXT` como JSON extensível por atendimento (ficha técnica de coloração, alergia, etc.). `clinic_professionals` é desacoplado de login (`user_id` opcional, `db.ts:2576-2586` + PIN `:3228-3230`) — a manicure não precisa de conta. `clinic_specialties` + `clinic_professional_specialties` (N:N, `db.ts:2708-2747`) resolvem "quem faz o quê" — mas o vínculo canônico é `profissional↔especialidade`, não `profissional↔serviço`; o PRD trata isso como um item **CRIAR mín.** (N:N `professional_services` ou mapear cada serviço como especialidade).

**Achado:** `products_services.duration_minutes` (`db.ts:766`) é escrita por `routes/products.ts:824` e **nunca lida** por motor de agenda — "corte = 45min" é digitado e nunca chega ao slot. O `AppointmentService.create:105-129` (porta canônica ADR-160 F6) **não checa conflito** (só camadas verticais têm guard). Um único horário de funcionamento por org (5 escalares `agenda_*_hour`) sem por-dia-da-semana / intervalo / por-profissional — o PRD trata isso como F4 progressiva.

### 3.3 Fashion Studio = Simulador de Cabelo pronto

`FashionTryOnService.ts:41-46` define a **interface plugável** (`avatar: Buffer` + N `garments` + `notes` → `{ok, b64}`) — é literalmente o shape do Simulador de Cabelo com `garments`→referências de cor/corte. O `SAFETY_PROMPT:51-55` já cita cabelo como atributo a preservar em try-on de roupa; para o Simulador, o prompt inverte: **preservar rosto/corpo, alterar cabelo**. O provider é selecionado por env (`FASHION_TRYON_PROVIDER:110-115`, Gemini `gemini-2.0-flash-exp` ou OpenAI `gpt-image-1` com `input_fidelity:"high"`). Idempotência real por `input_hash = sha256(avatarKey:productIds:provider.key)` (`:194-199`) evita dupla cobrança em retries. Créditos por janela (`fashion_usage_credits`) + fila `maxAttempts:1` + `refundCredit` em falha técnica. `FashionAvatarService` cobre consentimento antes do upload (`:87-89`), EXIF strip via `sharp` (`:96`), quarentena obrigatória (`:110-112`), validação por IA que **retorna só flags booleanas** (`llm.ts:590-612`) com o system prompt *"NUNCA descreva, avalie ou comente corpo, peso, beleza ou aparência"* (`llm.ts:593`), texto ao usuário vem de catálogo determinístico fixo (`:138-153`, RN-BS-11), URL assinada HMAC com escopo próprio (`sha256(JWT_SECRET:fashion_private_media_v1)`, TTL 15min, `timingSafeEqual`, `path.basename` anti-traversal), retenção configurável + purga preguiçosa no Scheduler (`Scheduler.ts:827-829`). O frontend `src/storefront/FashionStudio.tsx:326-338, 758-775` já implementa a **comparação lado a lado** (que o PRD pede em BEAUTY-011) — reuso 1:1.

**Achado:** `AiGovernanceService.PEOPLE_AFFECTING:19-40` não tem entrada para sugestão estética; hoje o guardrail vive só como prompt e catálogo determinístico. F2 adiciona `estetica_appearance_advice` na lista (RN-BS-3).

### 3.4 Execução / Fala Tu / BusinessSignal — cérebro completo

`DecisionActionService.propose:40` → `ApprovalPolicyService.resolve:62` + `resolveContract:110` (Autonomy Contract com bandas por valor, default-deny para financeiro/destrutivo) → `CommandExecutorService.execute:188` (G1/G2/G3 em série + idempotência durável por `mode='execute' AND status='done'`) → `ConfirmationEngine.expect:89`/`confirm:166`/`sweepTimeouts:238` (SLA vencido publica exceção em `business_signals` com dedupe canônico) — o fio inteiro Sinal→Decisão→Execução→Confirmação→Outcome→Aprendizado já existe, com 21 command handlers registrados (`social_publish`, `growth_optimization`, `reputation_publish_reply`, `whatsapp_send` são os mais recentes — o molde exato para `beauty_review_invite`, `beauty_maintenance_offer`, `beauty_vacancy_offer` novos). `BusinessSignalService.publish:58` com dedupe UNIQUE `(org, dedupe_key)` + TTL via `expires_at:8340` + `correlation_id:8321` (ADR-158). `SmartInboxService.build:83` já funde `attention()` + ações + processos em 7 categorias com role-scope por `ContextProjectionService`. `FalaTuService.interpret:192` classifica com LLM em vocabulário fechado (`FalaTuIntent`, `:54`) e `confirm:439` é o choke-point transacional que semeia silo + porta canônica opt-in; adicionar intent novo é **estender enum + switch + flag**, não novo motor.

**Achado (gap load-bearing para a vertical):** consent `comunicacoes` (Art.7) é checado em 24 call-sites, **todos `Clinic*`** — campanhas, cadências, NPS e recuperação comercial só olham `contacts.marketing_opt_out`. Não há **quiet-hours** para outbound a cliente (só push interno ao dono). Não há **frequency cap** transversal. Um salão que aciona 500 clientes/mês via cadência precisa dessas 3 travas antes de virar autopilot — F5 do plano faz esse endurecimento como aditivo (beneficia todas as verticais).

---

## 4. Respostas às 30 perguntas do PRD §6

1. **Cliente canônico:** `contacts` (`db.ts:37-47`). Não há `customers`. Não existe custom fields JSON por contato (a coluna `metadata_json` existe em `channels` e `products_services`, não em `contacts`). Substituto real: `tags` (CSV), `notes` (texto), `memory_facts` (ADR-071).
2. **Serviço canônico:** `products_services type='service'` (`db.ts:196-209`). Polimórfica (product/service/reservation). `metadata_json` livre disponível.
3. **Produto canônico:** mesma tabela `products_services type='product'`, com `inventory_items.avg_cost` (`db.ts:763`) para margem.
4. **Profissional canônico:** `clinic_professionals` (`db.ts:2576-2586`) — desacoplado de login (`user_id` opcional), com `registration_number`/`council`/PIN. É este que a vertical Beleza reusa. `users` é login, `employees` é RH; ambos são universos separados.
5. **Agendamento canônico:** `appointments` (`db.ts:221-235` + ~30 ALTERs). Status: `pending|confirmed|in_progress|completed|cancelled|no_show`. Cover completo `professional_id`, `room_id`, `expected_duration_minutes`, `specialty_id`, `care_episode_id`, `treatment_cycle_id`.
6. **Disponibilidade:** `ClinicScheduleSessionService.availability:567-648` (único cálculo com profissional+ausência+sala); `AppointmentService.nextFreeSlots:193-218` (genérico, sem profissional); `agenda_open_hour|agenda_close_hour|agenda_slot_minutes|agenda_days|agenda_capacity` em `organization_settings` (janela única).
7. **Isolamento entre tenants:** middleware camadas `server.ts:446-473` (bloqueio billing/status) → `server.ts:552-560` (gate módulo por org) → `enforceModulePermission` global (`middleware/auth.ts:184-199`); convenção nº 1: `orgId` 1º arg em toda função service.
8. **Registro de verticais:** `verticals.ts:94-148` como constante TS (`VERTICALS`); `organization_settings.vertical` guarda a chave. Não há tabela.
9. **Liberação por vertical/plano:** `EntitlementService.check:204` compõe `ModuleService.isEnabled` + `PlanService.modulesForPlan` + `PermissionService.levelFor` + `AddonService` + `blueprint.hiddenModules`.
10. **Menus apresentados/ocultos:** backend pronto — `NavigationManifestService.forUser:50-89` + `GET /api/entitlements/navigation-manifest`; **frontend ainda usa `isModuleEnabled`/`canAccessModule` direto no `Sidebar.tsx`** (gap opcional, não bloqueia F1).
11. **Feature flag reutilizável:** convenção nº 10 — `organization_settings.{modulo}_{feature}_enabled INTEGER DEFAULT 0` (~90 colunas hoje). Ex.: `falatu_enabled`, `execution_runtime_enabled`, `sales_recovery_enabled`, `clinic_retention_enabled`. Flags GLOBAIS em `platform_settings` (`db.ts:8222-8230`).
12. **Custom fields / metadata:** parcial. `metadata_json` em `channels` (`db.ts:32`), `products_services` (`db.ts:207`). Não em contacts. `clinical_encounters.form_data` é JSON livre por atendimento — é o gancho canônico para ficha técnica.
13. **Pipeline de mídia:** três zonas — pública (`/media/*` `express.static`), chat privada (`/media/private/*` opt-in HMAC), privada real (`private_media/*` só via rota autenticada + URL assinada). `mediaValidation.detectImageMime` sniff por magic bytes.
14. **Upload:** `routes/uploads.ts` (staff, 15 MB, whitelist mimetype); `routes/fashionPublic.ts:141` (avatar 15 MB, rate limit 10/h por cliente); `ClinicAttachmentService.ts` (15 MB, magic bytes + LGPD).
15. **Storage:** disco local `DATA_DIR/{media|media/private|private_media}` é sempre fonte da verdade; `StorageService.mirrorToS3` best-effort só `.pdf`/`.json` hoje.
16. **Gateway centralizado de IA:** `src/server/llm.ts` (não é registry — é módulo de funções: `chat`, `embed`, `describeImage`, `generateImageB64`, `editImagesB64`, `editImagesGoogleB64`, `startVideoGoogle`, `validateGuidedPhoto`). `recordUsage:70-105` grava em `ai_usage_log` (metering ADR-154). Attribution por `AsyncLocalStorage` (`usageContext.ts`).
17. **Geração/edição de imagem:** `generateImageB64:168-186` (Imagen `imagen-3.0-generate-002` ‖ `gpt-image-1`); `editImagesB64:232-247`; `editImagesGoogleB64:261-298`; `startVideoGoogle:301-341` (Veo).
18. **Estúdio de Criação reutilizável:** sim — `StudioService.ts:55` (marca→arte→legenda→publicar); `BrandDnaService` (Brand DNA 2.0 unificado, versionado); `HookIntelligenceService`, `ScriptIntelligenceService`, `ChannelAdaptationService`, `CreativeVariantService` para variantes A/B/C; `GovernedPublishService.propose:40` para publicação governada.
19. **Execution Runtime recebe eventos via:** (a) `startForSubject:194` para instância explícita; (b) `startFromSignal:228` acionado por `SignalProcessRouterService.TRIGGER_MAP:55-63` (opt-in `signal_auto_trigger_enabled`); (c) `DecisionActionService.propose` direto por comando; (d) `CommandExecutorService.dispatchGoverned:320` (semeia policy + propõe + aprova + executa em um passe).
20. **Automações executadas por:** `CommandExecutorService.execute:188` (G1/G2/G3 + idempotência durável); registry de 21 command handlers; alguns handlers usam `MessageProviderService.sendMessage:11` para efeito externo.
21. **Evitar disparos duplicados:** (a) idempotência durável do executor por `(action_id, mode='execute', status='done')` `:224-229`; (b) `ConfirmationEngine.expect` UNIQUE por `(org, action)`; (c) `BusinessSignalService.publish` UNIQUE `(org, dedupe_key)`; (d) `input_hash` no try-on; (e) UNIQUE parcial por tentativa em `sales_recovery_touches`, `collection_cadence`.
22. **Fala Tu funciona:** captura multimodal (texto/áudio/imagem) → `FalaTuService.interpret:192` (LLM json-only com prompt `EXTRACTION_SYSTEM:138-140`) + classificador determinístico por regex (`classifyFalaTuListType:65`) → INSERT em `falatu_inbox_items` → humano confirma → `confirm:439` transaciona silo + porta I/O opt-in. Paridade WhatsApp via `FalaTuWhatsAppService.ts:91` no canal `kind='internal'`.
23. **Ações do Fala Tu:** `TASK` (silo `falatu_tasks` + opt-in `TaskService`), `EVENT` (silo `falatu_events` + opt-in `AppointmentService`), `LIST` (silo `falatu_lists` + opt-in `PurchaseRequisitionService`), `NOTE`/`UNKNOWN` (só arquiva). Flags `falatu_bridge_{tasks|events|lists}_enabled`.
24. **Consentimento registrado:** `contact_consents` (`db.ts:5329-5344`) com tipos `marketing|dados_pessoais|perfilamento|comunicacoes|dados_sensiveis`, `legal_basis`, `policy_version`, `granted_at`, `revoked_at`. `LgpdService.grantConsent:225`/`revokeConsent:237` (com cascata para `patient_portal_tokens`). Consentimento de mídia (fashion): `fashion_consents` com `avatar_processing|personalization|whatsapp_notification|guardian_approval`.
25. **Audit logs:** `auth_audit_logs` (`logAuthEvent` `auditLog.ts:38-53`) — cobre toda mutação relevante. `maskIdentifier:17-22` (Art.6 III necessidade) mascara telefones/CPF em metadata (`5511987654321` → `5511***4321`). Trilhas complementares: `SecurityAuditService`, `RevenueAuditService`, `AiGovernanceService.ai_decisions`.
26. **Métricas coletadas:** `AnalyticsService.ts` 100% derivada por query (`try/catch` por tabela); `ux_telemetry_events` opt-in (LGPD-minimizada, whitelist `view_opened|action_clicked|approval_completed|clarification_requested|first_value`, `safeId` sanitiza); `PlatformTelemetryService` para infra; `ai_usage_log` para custo de IA por org/user/module/correlation.
27. **Testes que protegem outras verticais:** `scripts/test-*.ts` (~140), matrix em `.github/workflows/ci.yml`, todos com `tmpDir` isolado + helper `check(name, ok)` + cobertura de multi-tenant. Padrão a herdar em F1+ (um `test:beauty-*` por fatia).
28. **Código relacionado a estética/transformação visual:** Fashion Studio (11 ADRs — 034/035/036/037/038/039/040/041/042/103/104), `FashionTryOnService.ts` (o motor), `FashionAvatarService.ts` (consentimento+quarentena), `FashionLookService.ts` (quiz→looks), `StorefrontLookGenerationService.ts` (avatar vestindo look, IA escolhe modelo por tom de pele). É reuso quase 1:1 para o Simulador de Cabelo.
29. **Abstrações suficientes para vertical só por configuração?** Para operação (agenda/CRM/catálogo/pagamentos/campanhas/estúdio/reputação): **sim, quase por dado** (blueprint + configurações + reuso da Clínica). Para o Simulador de Cabelo (novo domínio): **não** — exige +5 tabelas (`beauty_visual_consultations`, `beauty_visual_simulations`, `beauty_avatar_assets`, `beauty_reference_looks`, `beauty_visual_analyses`) + 3 services (`BeautyVisualConsultationService`, `BeautySimulationService`, `BeautyHarmonyAnalysisService`) + 1 provider (`BeautyHairSimulationProvider` atrás do MESMO contrato). Para o elo comercial Look→Serviços: **não** — exige `LookServiceRecommendationService` grounded no `products_services`. Para o gap consent+quiet-hours+frequency-cap: **estender** o transverso (Não é do escopo Beleza puro; a vertical explicita a necessidade).
30. **Menor alteração possível para entregar a vertical:** (a) 1 linha em `VerticalKey` + 1 objeto em `VERTICALS` + 1 chave em `CONSENT_BY_VERTICAL` + 1 linha em `FALLBACK_HIDDEN_BY_VERTICAL`; (b) 1 blueprint `beleza_salao_v1` por Master Admin (dado, não código); (c) 1 tabela família `beauty_*` para o Simulador de Cabelo espelhando `fashion_*`; (d) 1 provider real `BeautyHairSimulationProvider`; (e) 3 conectores finos no catálogo (duração lida pela agenda; `professional_services`; `products_services.maintenance_days` opcional); (f) 5 command handlers novos no MESMO registry (`beauty_review_invite`, `beauty_maintenance_offer`, `beauty_vacancy_offer`, `beauty_simulation_followup`, `look_service_recommendation`); (g) endurecimento transversal de consent+quiet-hours+frequency-cap (aditivo, beneficia todas).

---

## 5. Planos (§5 do PRD)

### 5.1 Impact Map (o que pode ser afetado)

| Área tocada | Como | Risco |
| --- | --- | --- |
| `verticals.ts` (+1 objeto) | Aditivo | Nulo (leitura difusiva no repo) |
| `EntitlementService.FALLBACK_HIDDEN_BY_VERTICAL` (+1 linha) | Aditivo | Nulo |
| `LgpdService.seedConsentForVertical` (nada muda; só passa a acionar com `vertical='beleza'`) | Passivo | Nulo |
| `ModuleService.applyVertical` (nada muda) | Passivo | Nulo |
| `BlueprintSeeder.INITIAL_BLUEPRINTS` (+1) | Aditivo | Nulo — publicado só via `seedInitialBlueprints` |
| `products_services` (opcional +1 coluna `maintenance_days`) | Aditivo CREATE-then-ALTER | Nulo (default NULL) |
| Novo N:N `professional_services` OU mapeamento por `clinic_professional_specialties` | Aditivo | Baixo (decisão em F1) |
| `AppointmentService.config` — passar a considerar `products_services.duration_minutes` como fallback | Aditivo (defensivo) | Baixo (só afeta salão; produção não usa hoje) |
| `MessageProviderService.sendMessage` — passar a exigir consent `comunicacoes` sob flag global | **Transversal, opt-in por flag** | Médio — endurece toda a plataforma; feature-flag salvaguarda; audit de bloqueio |
| Novo módulo `beauty_hair_simulator` (opcional; alternativa: submódulo de `estudio`) | Aditivo | Baixo — entra em `PLAN_GRADE` ou `PLAN_FREE_ADDONS` |
| Sidebar / Views novas (`BeautyOverviewView`, `BeautyVisualConsultationView`) | Aditivo em `App.tsx` + `useStore.ViewMode` + `Sidebar.tsx` | Baixo — segue padrão Clínica |
| Novos handlers `beauty_*` no `CommandExecutorService.registerHandler` | Aditivo (import de efeito colateral em cadeia) | Baixo — G3 recusa auditada se não registrar |

**Zero mudança destrutiva.** Tudo aditivo, opt-in por flag, reversível pela flag.

### 5.2 Dependency Map

- Fase 1 (fundação) depende de: `verticals.ts`, `EntitlementService`, `ModuleService`, `PermissionService`, `LgpdService`, `BlueprintSeeder`, `App.tsx`+`Sidebar.tsx`+`useStore.ts`.
- Fase 2 (Beauty AI) depende de: Fase 1 + `FashionTryOnService`/`FashionAvatarService`/`FashionCustomerService` (moldes) + `llm.ts` (`editImagesGoogleB64`/`editImagesB64`) + `JobQueueService` + `fileSigning.ts` + `PlanService.studioAllowed` + `AiGovernanceService`.
- Fase 3 (Conversão Look→Serviços) depende de: Fase 2 + `products_services` + `inventory_items` + N:N profissional↔serviço + `ClinicScheduleSessionService.availability`.
- Fase 4 (Execution Intelligence) depende de: Fase 3 + `BusinessSignalService` + `DecisionActionService`/`ApprovalPolicyService`/`CommandExecutorService`/`ConfirmationEngine` + `Scheduler` + endurecimento transversal (Fase 5 recomendável antes).
- Fase 5 (Endurecimento consent+quiet-hours+frequency-cap) é **independente** — pode subir isolada como aditivo de plataforma (RECOMENDADO como F0.5 antes do autopilot).
- Fase 6 (Piloto Studio Márcia + generalização "Salão Teste B") depende de todas.

### 5.3 Data Model Plan

**Reutilizar sem mudança:**
- `contacts` (+ `memory_facts`, `tags`, `notes`, `avg_ticket`)
- `appointments` (com `professional_id`, `room_id`, `expected_duration_minutes`, `specialty_id`, `treatment_cycle_id`, `care_episode_id`)
- `clinic_professionals`, `clinic_rooms`, `clinic_specialties`, `clinic_professional_specialties`
- `clinic_treatment_cycles`, `clinical_encounters` (`form_data` JSON)
- `products_services`, `inventory_items`, `product_images`
- `contact_consents`, `fashion_consents` (reusar o modelo, novos escopos)
- `business_signals`, `decision_actions`, `action_execution_log`, `action_confirmations`, `agent_policies`
- `background_jobs`, `platform_settings`, `organization_settings`, `role_profiles`, `role_permissions`
- `channels`, `messages`, `tickets`, `orders`, `order_items`, `quotes`
- `studio_creations`, `scheduled_posts`, `brand_profiles`, `campaigns`, `cadences`
- `satisfaction_surveys`, `auth_audit_logs`, `ai_usage_log`, `ux_telemetry_events`
- `vertical_blueprints`, `organization_blueprints`

**Estender (colunas aditivas, CREATE-then-ALTER estrito — convenção nº 2):**
- `organization_settings`:
  - `+beauty_vertical_enabled INTEGER DEFAULT 0` (flag master da vertical — se preferir sinalização granular além do `vertical='beleza'`)
  - `+beauty_hair_simulator_enabled INTEGER DEFAULT 0` (F2 opt-in)
  - `+beauty_review_invite_enabled INTEGER DEFAULT 0` (F4)
  - `+beauty_daily_generation_limit INTEGER DEFAULT 5` (crédito diário do Simulador; espelha `fashion_daily_generation_limit`)
  - `+beauty_avatar_retention_days INTEGER DEFAULT 30`
  - `+client_quiet_hours_start INTEGER DEFAULT 8` / `client_quiet_hours_end INTEGER DEFAULT 21` (F5 transversal)
  - `+client_frequency_cap_per_day INTEGER DEFAULT 3` (F5 transversal)
  - `+outbound_consent_required INTEGER DEFAULT 0` (F5 transversal — quando 1, exige `comunicacoes` em todo sink)
- `products_services`:
  - `+maintenance_days INTEGER` (opcional; janela sugerida de manutenção do serviço — coloração 45d, escova 21d)
  - `+beauty_look_tags TEXT` (CSV — "morena_iluminada, mechas, balayage" — usado pelo `LookServiceRecommendationService`)
- `clinic_professionals`: reusar como está (renomear em UI para "Profissional"; a tabela é agnóstica).
- `contacts`:
  - `+preferred_professional_id TEXT` (opcional; hoje vai em `tags`/`memory_facts`)

**Criar mín. (novas tabelas — 5, todas espelham padrão `fashion_*`):**

```sql
CREATE TABLE IF NOT EXISTS beauty_visual_consultations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, contact_id TEXT,
  status TEXT DEFAULT 'draft',              -- draft | ready | selected | scheduled | abandoned
  goal TEXT,                                -- 'cor'|'corte'|'mechas'|'estilo'|'completo'
  intensity TEXT,                           -- 'discreto'|'moderado'|'transformacao'
  reference_photo_key TEXT,                 -- storage privado
  consent_id TEXT,
  selected_simulation_id TEXT,
  selected_at DATETIME,
  scheduled_appointment_id TEXT,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_beauty_consult_org ON beauty_visual_consultations(organization_id, status);

CREATE TABLE IF NOT EXISTS beauty_visual_simulations (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  consultation_id TEXT NOT NULL,
  simulation_type TEXT NOT NULL,            -- 'color'|'cut'|'combined'
  parameters_json TEXT,                     -- {color:'morena_iluminada', style:'ondulado', ...}
  reference_look_id TEXT,                   -- FK opcional beauty_reference_looks
  provider_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,                 -- dedupe idêntico ao fashion_tryon_jobs
  status TEXT DEFAULT 'CREATED',            -- CREATED|QUEUED|PROCESSING|SUCCEEDED|FAILED_FINAL|DELETED|EXPIRED
  output_storage_key TEXT,
  error_code TEXT, error_message_safe TEXT,
  started_at DATETIME, completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_beauty_sim_consult ON beauty_visual_simulations(organization_id, consultation_id, status);

CREATE TABLE IF NOT EXISTS beauty_avatar_assets (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, contact_id TEXT NOT NULL,
  storage_key TEXT,                         -- NUNCA /media público
  status TEXT DEFAULT 'quarantined',        -- quarantined|approved|rejected|expired|deleted
  safety_report_json TEXT,                  -- só flags, sem imagem
  consent_id TEXT,
  expires_at DATETIME, deleted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS beauty_reference_looks (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  name TEXT NOT NULL, image_storage_key TEXT,
  hair_type TEXT, length TEXT, tone TEXT, cut_style TEXT,
  suggested_services_json TEXT,             -- ["service_id_1", ...] — casa com products_services do tenant
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS beauty_visual_analyses (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
  consultation_id TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,            -- {contrast:"alto", equilibrio:"harmônico", destaque:"olhar", ...}
  narrative TEXT,                           -- linguagem descritiva, nunca ranking
  disclaimer_shown INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Opcional (avaliar em F1): `professional_services(id, organization_id, professional_id, service_id, active, is_primary, commission_percent, created_at)` — se o mapeamento por especialidade não couber. O trade-off é: usar `clinic_professional_specialties` mapeando cada serviço como especialidade evita tabela nova mas obriga a semear especialidade por serviço.

Nenhum `DROP`. Nenhum `RENAME` destrutivo. Toda migração idempotente `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN` em `try{}catch{}` seguindo convenção nº 2.

### 5.4 Migration Plan

Todas as novas colunas e tabelas entram como CREATE-then-ALTER em `db.ts`, **appended no fim** (nunca reordenar — convenção nº 2). Deploy é atômico com o resto do repo; migração roda no boot (todos os `ALTER TABLE` são `try{}catch{}` idempotentes). Zero downtime, zero rollback de schema.

### 5.5 Regression Test Plan

Suíte a proteger (rodar antes/depois de cada fatia):
- Todas as 8 verticais existentes: `test:falatu*`, `test:clinic-*`, `test:reputation-*`, `test:social-*`, `test:growth-*`, `test:comigo-*`, `test:retail-*`, `test:escola-*` (~140 scripts).
- Testes canônicos de plataforma: `test:entitlement-*`, `test:permission-*`, `test:blueprint-*`, `test:module-*`, `test:navigation-manifest-*`, `test:ai-governance-*`, `test:job-queue-*`, `test:file-signing-*`.
- Multi-tenant / RBAC / billing gate: sempre.

Novos testes por fatia (todos com `tmpDir` isolado, helper `check(name, ok)`, cobrindo happy path + edge + audit + isolamento):
- `test:beauty-registry` (registro da vertical, consent seeded, blueprint atribuído)
- `test:beauty-blueprint-piloto` (Studio Márcia via blueprint, zero constante)
- `test:beauty-catalog-duration` (duração do serviço lida pela agenda)
- `test:beauty-professional-services` (N:N escolhido)
- `test:beauty-visual-consultation` (fluxo consentimento → upload → quarentena)
- `test:beauty-hair-simulation` (provider stub determinístico; idempotência por `input_hash`)
- `test:beauty-harmony-analysis` (linguagem descritiva, sem ranking; guardrail RN-BS-3)
- `test:beauty-look-to-services` (recomendador grounded no `products_services`; nunca inventa)
- `test:beauty-look-to-appointment` (visual → serviço → profissional habilitado → disponibilidade)
- `test:beauty-abandoned-simulation` (detector publica sinal + fecha via `resolveByDedupe`)
- `test:beauty-maintenance-detector` (janela por serviço + retorno)
- `test:beauty-review-invite` (handler governado + confirmação)
- `test:beauty-outbound-consent-transversal` (F5 aditivo)
- `test:beauty-quiet-hours-transversal` (F5)
- `test:beauty-frequency-cap-transversal` (F5)
- `test:beauty-golden-paths` (fluxo E2E do §7, com Studio Márcia como fixture)
- `test:beauty-hardening` (guardrails RN-BS-01..12 como regressão; fecha o ADR)

### 5.6 Feature Flag Plan

Master (opcional além do `vertical='beleza'`): `organization_settings.beauty_vertical_enabled` (default 0) — permite ativar/desativar sub-features sem trocar vertical.

Por sub-feature (todas default 0, opt-in):
- `beauty_hair_simulator_enabled` (F2)
- `beauty_look_to_service_enabled` (F3)
- `beauty_maintenance_detector_enabled` (F4)
- `beauty_abandoned_simulation_detector_enabled` (F4)
- `beauty_review_invite_enabled` (F4)
- `beauty_vacancy_offer_beauty_enabled` (F4)

Transversais (F5, default 0):
- `outbound_consent_required` — quando 1, todo sink outbound (WhatsApp, e-mail) checa `comunicacoes`
- `client_quiet_hours_enforced` — quando 1, respeita `client_quiet_hours_{start,end}` em outbound a cliente
- `client_frequency_cap_enforced` — quando 1, aplica cap por dia

**Nada é ligado automaticamente.** Studio Márcia recebe as flags ligadas manualmente pelo Master Admin no piloto.

### 5.7 Rollback Plan

Por fatia:
1. Desligar a flag correspondente em `organization_settings` (ou `platform_settings`) → serviço volta a NO-OP.
2. Se a fatia entregou handlers: eles ficam registrados mas nunca são invocados (com flag off nenhum detector chama `dispatchGoverned`).
3. Se a fatia entregou colunas: elas ficam com default NULL/0 (aditivo — legado ignora).
4. Se a fatia entregou tabelas: ficam vazias — código não escreve nelas com flag off.

**Rollback não exige `DROP` nem restore.** No pior caso, `UPDATE organization_settings SET beauty_hair_simulator_enabled=0` desliga o Simulador imediatamente — jobs em curso terminam naturalmente ou são varridos por `sweepStale`.

### 5.8 Security & Privacy Plan

- **Fotos da cliente** = dado pessoal sensível (LGPD Art.5 II). Consentimento tipado (`hair_simulation` para simulação; **`use_in_marketing` separado** — uma não implica a outra, PRD §26); quarentena antes do processamento; EXIF strip; storage privado com URL assinada HMAC (`scope='beauty_private_media_v1'`, TTL 15min, `timingSafeEqual`, `path.basename` anti-traversal); retenção configurável (default 30d, clamp 1..365); purga preguiçosa + Scheduler.
- **Logs jamais contêm foto/base64/prompt com PII** — `safety_report_json` só flags booleanas; `ux_telemetry_events` já sanitiza via `safeId`.
- **Não vazar entre tenants:** todo query com `organization_id`; escopo do token do cliente do salão (portal) tem segredo próprio (padrão `FashionCustomerService.ts:28`).
- **Não usar para treinamento sem autorização** — chamada ao provider já é isolada; nenhum fluxo hoje reencaminha imagem para pipeline de treinamento.
- **Não reutilizar em marketing sem consent** — publicação de "antes/depois" no Estúdio depende de consent `use_in_marketing` explícito (checado no handler `social_publish` para artefato originado de `beauty_visual_consultations`).
- **Guardrail: IA não julga aparência** (Art.11): (a) prompt herdado (`llm.ts:593`), (b) narrativa da Harmonia Visual é linguagem DESCRITIVA fixa por catálogo determinístico (não ranking), (c) `AiGovernanceService.PEOPLE_AFFECTING` recebe entrada `estetica_appearance_advice` → toda sugestão exige ator humano + motivo, senão lança `human_decision_required`.
- **Recepção não vê financeiro global** — RBAC granular via `role_profiles`; dinheiro role-gated em `ExecutionResultsService`, `UxPresentationService`, `FalaTuHomeService`, `SmartInboxService`.
- **Consent `comunicacoes` transversal (F5)** — antes de qualquer envio de campanha/cadência/oportunidade, `LgpdService.hasConsent(orgId, contactId, 'comunicacoes')` é checado no sink (`MessageProviderService.sendMessage`) sob flag global.
- **Quiet-hours** — respeitar janela do dono para outbound (default 8h-21h locale São Paulo).
- **Frequency cap** — máximo 3 mensagens/dia/contato (default; configurável).

### 5.9 AI Cost & Performance Plan

- **Simulador de Cabelo:** custo por geração igual ao try-on (`GOOGLE_TRYON_COST_USD` default 0.04; `OPENAI_IMAGE_COST_USD` default 0.04). Crédito diário (`beauty_daily_generation_limit` default 5) — Studio Márcia começa com 5 gerações/cliente/dia; escala com o plano. **Idempotência real** por `input_hash` evita cobrança dupla em retries. Nunca gerar novamente por retry de frontend sem checar job existente (padrão `FashionTryOnService:196-199`).
- **Fila / concorrência:** `JobQueueService` single-process com `setImmediate`; se pico → `sweepStale` (5min) recupera; `maxAttempts: 1` no simulador (retry caro = decisão humana).
- **Timeout / falha do provider:** `errorClass` classificado (`retryable | external_unavailable | permission | non_retryable`); dead-letter automático; falha visível ao cliente sem derrubar a página (padrão `src/storefront/FashionStudio.tsx`).
- **Cache oportuno:** presets do salão (`beauty_reference_looks`) são reusáveis entre clientes; imagem gerada com mesmo `input_hash` é retornada sem gerar (`fashion_tryon` já faz).
- **Custo agregado por org:** `AiQuotaSignalService` sinaliza 80%/100% do `ai_monthly_limit_cents`; `PlanService.aiAllowed` bloqueia acima do teto (count-based).
- **Custo é master-only** — `AiUsageDashboardService` só é acessível a Master Admin (não ao lojista).

---

## 6. Fluxo E2E (§5 K do PRD)

```
CLIENTE                                     ZAPFLOW (Studio Márcia)
────────────────────────────────────────────────────────────────────
1. abre link/QR/vitrine                     → StorefrontLookService.publicLookbook (reuso)
2. autentica com telefone                   → FashionCustomerService (reuso, token isolado)
3. informa objetivo + intensidade           → beauty_visual_consultations.status='draft'
4. autoriza uso da foto (hair_simulation)   → fashion_consents (reuso do padrão)
5. envia foto                               → FashionAvatarService.upload (quarentena+EXIF+validação por IA)
                                              → beauty_avatar_assets.status='quarantined' → 'approved'
6. escolhe referência (presets ou livre)    → beauty_reference_looks (do tenant, nunca inventa)
7. gera N simulações                        → BeautyHairSimulationProvider (contrato TryOnProvider)
                                              → beauty_visual_simulations (fila JobQueue, maxAttempts:1)
                                              → idempotência por input_hash
8. compara lado a lado                      → FashionStudio.tsx UI (reuso 1:1)
9. seleciona um visual                      → beauty_visual_consultations.selected_simulation_id
10. vê análise de Harmonia (descritiva)     → BeautyHarmonyAnalysisService (linguagem, nunca ranking)
                                              → disclaimer visível (PRD §31)
11. vê serviços do CATÁLOGO REAL            → LookServiceRecommendationService (grounded em products_services)
    (mechas, tonalização, reconstrução)       → nunca inventa serviço/preço
12. escolhe serviço → profissional         → ClinicSpecialtyService.listProfessionalsForSpecialty
                                              (ou professional_services N:N)
13. escolhe horário livre                   → ClinicScheduleSessionService.availability (profissional+ausência+sala)
14. confirma agendamento                    → ClinicAgendaService.createAppointment
                                              (padrão AC-012 transação atômica)
                                              → appointments.beauty_consultation_id
15. recebe lembrete 24h antes               → ClinicReminderService.dispatch (opt-in comunicacoes)
                                              → respostas: CONFIRMAR/REMARCAR/PARAR
16. profissional inicia atendimento         → ClinicAgendaService.startCare + checkIn
17. profissional preenche ficha             → clinical_encounters.form_data (JSON — fórmula, tempo, produto)
18. profissional finaliza                   → complete + follow_up_recommended_days (janela de retorno)
19. CSAT 1-5 pós-atendimento                → SatisfactionService (reuso; opcional pedir review Google — F4)
20. próximo retorno detectado               → followUpQueue + BeautyMaintenanceDetector → business_signal
21. cliente inativa detectada               → ChurnRiskDetectorService + AbandonedAppointmentDetector (F4)
22. autopilot propõe (nunca executa)        → GrowthAutopilotService (shadow) → propõe conteúdo/manutenção
23. dona aprova no Fala Tu                  → DecisionAction → ApprovalPolicy → CommandExecutor → Confirmation
24. resultado assegurado                    → OutcomeAssuranceService → PatternMemoryService aprende
```

Cada elo tem sua própria confirmação e evidência (RN-BS-1: `SIMULAÇÃO ≠ AGENDAMENTO ≠ ATENDIMENTO ≠ RESULTADO`).

---

## 7. Guardrails RN-BS-01..12 (documentados no header dos services + testados)

- **RN-BS-01** — `SIMULAÇÃO ≠ AGENDAMENTO ≠ ATENDIMENTO ≠ RESULTADO`: cada elo tem confirmação própria; nenhum coisa "está pronta" sem o próximo elo.
- **RN-BS-02** — IA NUNCA sugere serviço/produto/preço/promoção fora do catálogo do tenant (`products_services`). Recomendador é grounded; sem match → `insufficient_catalog`.
- **RN-BS-03** — IA NUNCA julga aparência: Harmonia Visual é linguagem DESCRITIVA (contraste/equilíbrio/destaque), nunca ranking; `AiGovernanceService.PEOPLE_AFFECTING += "estetica_appearance_advice"` — sugestão estética exige ator humano + motivo (senão `human_decision_required`).
- **RN-BS-04** — Fotos são dado pessoal sensível: consent tipado antes do processamento; simulação e marketing são consents SEPARADOS (uma não implica a outra); quarentena obrigatória; EXIF strip; storage privado; URL assinada TTL 15min; retenção configurável + purga.
- **RN-BS-05** — Logs jamais contêm foto/base64/prompt com PII; `safety_report_json` só flags; `ux_telemetry_events` sanitiza via `safeId`.
- **RN-BS-06** — Idempotência real na simulação: `input_hash = sha256(avatarKey:params:provider.key)` — retry nunca cobra 2x.
- **RN-BS-07** — Isolamento cross-tenant duro: `organization_id` em toda query; token do portal do cliente do salão tem segredo próprio.
- **RN-BS-08** — Dinheiro role-gated: recepção/cabeleireira nunca veem financeiro global; owner/admin sim (§73 herdado do PRD 6).
- **RN-BS-09** — Consent `comunicacoes` transversal (F5): nenhum outbound (campanha/cadência/oportunidade/review-invite) envia sem `LgpdService.hasConsent(orgId, contactId, 'comunicacoes')` quando `outbound_consent_required=1`.
- **RN-BS-10** — Quiet-hours + frequency cap: default 8h-21h São Paulo, 3 msg/dia/contato (F5).
- **RN-BS-11** — Nunca inventa dado ausente (herdado RN-151): sem foto → sem simulação; sem serviço no catálogo → não sugere; sem histórico → não infere preferência ("desconhecido" > palpite).
- **RN-BS-12** — Shadow-first para autopilot (herdado RN-CG-10): Growth Autopilot da vertical propõe manutenção/retorno/review-invite mas NUNCA executa em `off` nem em modo `auto` — sempre GOVERNADO via `DecisionAction→ApprovalPolicy→CommandExecutor`.

---

## 8. Plano de fatias (resumo — detalhe no ADR-169)

Alinhado às **6 fases do PRD §59–§65**, entregas por PR pequeno (padrão do repo — 1 fatia = 1 PR draft → CI verde → merge → next):

| Fase PRD | Fatia | Escopo | Riscos |
| --- | --- | --- | --- |
| 0 (auditoria) | **F0** | doc-only: esta análise + ADR-169 | nenhum |
| 1 (fundação) | **F1** | Registro da vertical (`verticals.ts` +1) + `CONSENT_BY_VERTICAL` + `FALLBACK_HIDDEN_BY_VERTICAL` + `EntitlementService` overview passa a listar; testes de regressão | mudança em constante lida por muitos |
| 1 | **F2** | Blueprint `beleza_salao_v1` + Studio Márcia como tenant via `POST /api/admin/blueprints` + `/organizations/:id/blueprint` (dados, não constante) | baixo |
| 1 | **F3** | Perfis `beauty_recepcao`/`beauty_cabeleireira`/`beauty_gerente` (opcional: seed condicional) + navegação Sidebar reconhecendo a vertical | baixo |
| 1 | **F4** | Duração do serviço lida pela agenda (`AppointmentService.config` fallback → `products_services.duration_minutes`) + N:N profissional↔serviço (decidir `professional_services` OU `clinic_professional_specialties` mapeado) | baixo (aditivo defensivo) |
| 2 (Beauty AI) | **F5** | Tabelas `beauty_visual_consultations`, `beauty_avatar_assets`, `beauty_reference_looks` + `BeautyVisualConsultationService` (consentimento + upload + quarentena) reusando `FashionAvatarService` e `fileSigning` | médio (LGPD) |
| 2 | **F6** | `BeautyHairSimulationProvider` (atrás do MESMO contrato `TryOnProvider`) + `BeautySimulationService` + tabela `beauty_visual_simulations` + fila `beauty_hair_simulation` (JobQueue, `maxAttempts:1`, idempotência por `input_hash`) + prompt anti-injection invertido (preserva rosto, altera cabelo) | médio (custo IA) |
| 2 | **F7** | UI de simulação + comparação lado a lado (reusar `FashionStudio.tsx`), disclaimer, seleção do visual | baixo |
| 2 | **F8** | `BeautyHarmonyAnalysisService` (linguagem DESCRITIVA, nunca ranking) + entrada em `AiGovernanceService.PEOPLE_AFFECTING` | médio (guardrail dado a IA) |
| 3 (conversão) | **F9** | `LookServiceRecommendationService` (grounded em `products_services`; `beauty_reference_looks.suggested_services_json` casa com catálogo do tenant) — nunca inventa | baixo |
| 3 | **F10** | Fluxo look→serviço→profissional→disponibilidade→agendamento (composição de F4+F9+`ClinicScheduleSessionService.availability`+`ClinicAgendaService.createAppointment`) + histórico visual em `clinical_encounters.form_data` | baixo |
| **F5 recomendada aqui como pré-req de F11+**: | **F5-transversal** | Consent `comunicacoes` transversal + quiet-hours + frequency-cap (aditivo, opt-in por flag) — beneficia todas as verticais | médio (endurece plataforma) |
| 4 (Execution Intel) | **F11** | Detector `AbandonedSimulationDetector` publica `business_signal` (dedupe `beauty:abandoned_simulation:{consultationId}`); Growth Autopilot propõe follow-up (shadow) | baixo |
| 4 | **F12** | Detector `BeautyMaintenanceDetector` (janela do serviço + histórico); handler novo `beauty_maintenance_offer` no MESMO registry | baixo |
| 4 | **F13** | Handler `beauty_review_invite` (pedir avaliação Google/IG governada; grounded no atendimento assured; nunca sem consent) | médio (novo handler ligado a plataforma externa) |
| 4 | **F14** | Detector "horário ocioso + cliente elegível" (composição: `ClinicVacancyService` + `followUpQueue`) publica `beauty_vacancy_opportunity` | baixo |
| 4 | **F15** | Fala Tu intents de beleza (agenda/vacancy/review/prepare-post) — extende enum + switch conforme padrão FalaTuService §1.8 | baixo |
| 5 (hardening piloto) | **F16** | Testes golden-paths E2E (Studio Márcia como fixture); métricas Beauty AI em `ux_telemetry_events` (whitelist +N); dashboard master de custo/uso | baixo |
| 5 | **F17** | `test:beauty-hardening` codifica RN-BS-01..12 como regressão + runbook `docs/runbook/beleza-operacao.md` — FECHA o ADR-169 | baixo |
| 6 (generalização) | **F18** | Teste definitivo: criar "Salão Teste B" por blueprint sem alteração de código; se precisar tocar código, F18 volta a in-progress | crítico — é a prova do §65 |

Estimativa realista: **~18 fatias / 18 PRs**, seguindo cadência do ADR-168 (19 fatias). Regra Zero: F1+ bloqueado até F0 mergear.

---

## 9. Critério de sucesso (PRD §76 / §77)

A vertical Beleza & Salões estará pronta quando (todos os itens verificáveis por teste e demonstração):

1. Studio Márcia opera integralmente pelo ZapFlow: agenda (com Camila/Ana/Beatriz como profissionais, sem conta de login), CRM (clientes com histórico visual e ficha de coloração), catálogo (corte, coloração, mechas, escova com preços/duração reais), atendimento (check-in→ficha `form_data`→finalize→CSAT), lembrete 24h (com opt-out por `PARAR` respeitando `comunicacoes`).
2. Cliente entra no link do Studio, escolhe "morena iluminada", envia foto (consent duplo — simulação separado de marketing), recebe 3 simulações comparáveis lado a lado com análise de harmonia DESCRITIVA (sem "6,3/10"), escolhe uma, vê **mechas + tonalização** do catálogo real do Studio como serviços recomendados, escolhe Ana (habilitada), vê horários livres reais, agenda para sábado 14h.
3. 30 dias depois, o detector de manutenção publica sinal; a dona aprova no Fala Tu ("prepare mensagem para essas 12 clientes"); o handler `beauty_maintenance_offer` propõe → aprova → executa → confirma. Toda a operação passa por `DecisionAction→ApprovalPolicy→CommandExecutor→ConfirmationEngine`. Uma cliente responde `PARAR` → consent `comunicacoes` é revogado imediatamente — próxima cadência não a inclui.
4. Criar "Salão Teste B" via blueprint (`POST /api/admin/organizations/:id/blueprint`), configurar 2 profissionais/5 serviços/horários próprios — **sem alterar código** — e provar que ele opera todos os fluxos acima. Se em qualquer ponto for necessário tocar código, a arquitetura ainda não é generalizada (§65).
5. Testes verdes: `test:beauty-*` (17 novos) + regressão de todas as verticais existentes (~140 scripts) + `test:beauty-hardening` codifica RN-BS-01..12.
6. Rollback provado: `UPDATE organization_settings SET beauty_hair_simulator_enabled=0 WHERE organization_id='org_studio_marcia'` desliga o Simulador imediatamente — resto do ZapFlow intacto.

---

**Referências:**
- PRD "Vertical Beleza & Salões — ZapFlow", v1.0, 14/08/2026 (documento origem)
- ADR-092 §60 (`💇 beleza` prevista como vertical futura)
- ADR-145 (Clínica Jornada de Tratamento — o molde da agenda com profissional/sala/especialidade/ciclo)
- ADRs 034–044, 103–104 (Fashion Studio — o molde do try-on)
- ADR-152/158/159 (Execution Runtime + espinha única + Autonomy Contract)
- ADR-163 (Invisible UX — o molde do dashboard "Hoje" por exceção)
- ADR-165 (Outcome Assurance — `DONE ≠ RESULTADO`)
- ADR-166 (Enterprise Learning — motor único `PatternMemoryService`)
- ADR-167/168 (Social Intelligence + Growth Loop — o molde da publicação governada)
- CLAUDE.md convenções nº 1 (isolamento), nº 2 (CREATE-then-ALTER), nº 4 (URL assinada HMAC), nº 6 (LGPD), nº 10 (feature flags), nº 12 (BusinessSignal)
