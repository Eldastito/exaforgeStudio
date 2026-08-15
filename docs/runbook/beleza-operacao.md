# Runbook — Vertical Beleza & Salões (ADR-169)

**Status:** F17 — fecha o ADR-169.
**Escopo:** guia operacional pra ligar, monitorar, responder incidentes e evoluir a vertical Beleza sem regredir os guardrails RN-BS-01..12.

---

## 1. Mapa dos serviços

| Camada | Serviço | O que faz | Fatia |
| --- | --- | --- | --- |
| **Registro / preset** | `verticals.ts` + `EntitlementService` | Registra `beleza` + mapeia hidden modules por vertical | F1 |
| | `BlueprintSeeder.INITIAL_BLUEPRINTS` + `VerticalBlueprintService.assignToOrganization` | Publica `beleza_salao_v1` + atribui piloto por DADO (§17/§65) | F2 |
| | `PermissionService.seedBeautyProfiles` | Semeia perfis Recepção/Cabeleireira/Gerente CONDICIONALMENTE no assign | F3 |
| **Agenda / catálogo** | `AppointmentService.create` | Calcula `scheduled_end` pela `products_services.duration_minutes` | F4 |
| | `ProfessionalServiceService` | N:N profissional↔serviço (comissão nativa) | F4 |
| **Beauty AI (fundação)** | `BeautyVisualConsultationService` | Consent tipado, quarentena, EXIF strip, URL assinada HMAC, retenção configurável | F5 |
| | `BeautyHairSimulationService` + `HairSimulationProvider` (Stub / Gemini) | Simulador de cabelo com prompt invertido; idempotência por input_hash | F6 |
| | `routes/beauty.ts` + `routes/beautyPublic.ts` | 10 endpoints admin + URL assinada pública | F7 |
| | `BeautyHarmonyAnalysisService` | Análise DESCRITIVA (RN-BS-03); actor+reason obrigatórios | F8 |
| **Comercial** | `LookServiceRecommendationService` | Recomenda serviços do CATÁLOGO REAL (RN-BS-11) | F9 |
| | `BeautyLookToAppointmentService` | Availability + book (fecha o ciclo, snapshot derivável) | F10 |
| **Freios transversais (opt-in)** | `OutboundConsentGuardService` | Gate LGPD `comunicacoes` no sink `sendMessage` | F5-A |
| | `ClientQuietHoursGuardService` | Janela silenciosa (default 22h→8h SP) no sink | F5-B |
| | `ClientFrequencyCapGuardService` | Cap N/janela por contato no sink (default 3/24h) | F5-C |
| **Autopilot em SHADOW** | `AbandonedBeautySimulationDetector` | Sinaliza consultas 'ready' com sim SUCCEEDED sem 'selected' há >X horas | F11 |
| | `BeautyMaintenanceDetector` | Sinaliza par (contato, serviço) com `maintenance_days` vencido | F12 |
| | `BeautyVacancyDetector` | Sinaliza gap futuro na agenda + ≥1 elegível | F14 |
| | `BeautyReviewInviteCommandHandler` | Handler governado `beauty_review_invite` (herda 3 freios F5) | F13 |
| **Superfície proativa** | `BeautyFalaTuIntents` | Classificador determinístico de intents beauty pro Fala Tu | F15 |
| **Observability** | `UxTelemetryService.beautyMetrics` | Funil visual (7 event_types + 4 taxas) | F16 |
| | `AiUsageDashboardService.byOrg` | Cost/uso do provider Gemini (ADR-154) | — |

---

## 2. Rotas HTTP

| Método | Rota | Uso | Auth/gate |
| --- | --- | --- | --- |
| `GET` | `/api/beauty/vocabulary` | Vocabs abertos (color/cut/consent scopes) | requireBeauty |
| `POST` | `/api/beauty/consents` | Concede consent (hair_simulation/use_in_marketing/etc) | requireBeauty |
| `DELETE` | `/api/beauty/consents` | Revoga consent (LGPD Art.18 — apaga assets) | requireBeauty |
| `POST` | `/api/beauty/consultations` | Inicia consulta visual | requireBeauty |
| `GET` | `/api/beauty/consultations/:id` | Consulta + assets + simulations | requireBeauty |
| `POST` | `/api/beauty/consultations/:id/upload` | Upload multipart (15MB, whitelist mimetype) | requireBeauty |
| `POST` | `/api/beauty/assets/:id/approve|reject` | Aprovação manual | requireBeauty |
| `POST` | `/api/beauty/consultations/:id/simulate` | Dispara simulação | requireBeauty + requireSimulator |
| `GET` | `/api/beauty/simulations/:id` | Status + result_asset_key + URL assinada | requireBeauty |
| `POST` | `/api/beauty/simulations/:id/cancel` | Cancela QUEUED | requireBeauty |
| `GET` | `/api/beauty/vocabulary/harmony` | Vocab das 5 dimensões | requireBeauty |
| `POST` | `/api/beauty/consultations/:id/analysis` | Análise harmonia (400 sem actor+reason) | requireBeauty + PEOPLE_AFFECTING |
| `GET` | `/api/beauty/consultations/:id/analyses` | Lista análises | requireBeauty |
| `GET` | `/api/beauty/analyses/:id` | Detalhe análise | requireBeauty |
| `GET` | `/api/beauty/vocabulary/recommendations` | KEYWORDS_COLOR/CUT + RECOMMENDATION_RELEVANCE | requireBeauty |
| `GET` | `/api/beauty/simulations/:id/recommendations` | Recomenda serviços do catálogo | requireBeauty |
| `GET` | `/api/beauty/consultations/:id/recommendations` | Recomenda pra consulta | requireBeauty |
| `GET` | `/api/beauty/consultations/:id/availability` | Slots por pro capaz | requireBeauty |
| `POST` | `/api/beauty/consultations/:id/book` | Reserva agendamento | requireBeauty |
| `POST` | `/api/beauty/consultations/:id/select` | Seleciona simulação | requireBeauty |
| `GET` | `/api/public/beauty/media/:key` | URL assinada HMAC (TTL 15min) | pública c/ HMAC |

---

## 3. Passes no Scheduler.tick

Todos best-effort per-org, opt-in por flag:

- `AbandonedBeautySimulationDetector.pass` — publica `beauty:abandoned_simulation:{consultationId}`
- `BeautyMaintenanceDetector.pass` — publica `beauty:maintenance_due:{contactId}:{serviceId}`
- `BeautyVacancyDetector.pass` — publica `beauty:vacancy_opportunity:{proId}:{slotStartISO}`

Handlers registrados no `CommandExecutorService`:

- `BeautyReviewInviteCommandHandler` (`beauty_review_invite`) — envia via sink freado pelos 3 gates F5-transversal

---

## 4. Flags opt-in por org (organization_settings)

| Flag | Default | Efeito |
| --- | :-: | --- |
| `beauty_hair_simulator_enabled` | 0 | Habilita rotas `/simulate` (Simulador de Cabelo) |
| `beauty_avatar_retention_days` | 30 | Janela de retenção da foto (LGPD; clamp 1..365) |
| `beauty_abandoned_detector_enabled` | 0 | Liga detector F11 no Scheduler |
| `beauty_abandoned_after_hours` | NULL (=24) | Janela pra considerar consulta abandonada |
| `beauty_maintenance_detector_enabled` | 0 | Liga detector F12 |
| `beauty_vacancy_detector_enabled` | 0 | Liga detector F14 |
| `outbound_consent_required` | 0 | Gate LGPD `comunicacoes` no sink (F5-A) |
| `client_quiet_hours_enforced` | 0 | Gate janela silenciosa no sink (F5-B) |
| `client_quiet_hours_start_hour` / `_end_hour` | NULL (=22/8) | Custom da janela |
| `client_frequency_cap_enforced` | 0 | Gate cap por contato (F5-C) |
| `client_frequency_cap_max_per_window` / `_window_hours` | NULL (=3/24) | Custom do cap |
| `ux_telemetry_enabled` | 0 | Habilita gravação de eventos UX (inclui beauty_*) |

Flag opt-in POR SERVIÇO em `products_services`:
- `maintenance_days` (NULL = sem manutenção; INTEGER >0 = dias entre serviço e retorno sugerido)

---

## 5. Fluxo canônico (Golden Path)

```
consent (hair_simulation) →
  startConsultation('draft') →
    uploadReferencePhoto (quarantined) →
      approveAsset ('approved') →
        requestSimulation → JobQueue (beauty_hair_simulation) → SUCCEEDED ('ready') →
          analyze harmony (actor+reason) →
            recommendForSimulation (catálogo real) →
              select ('selected') →
                availability(consultationId, serviceId) →
                  book(pro, slot) ('scheduled', appt.professional_id, snapshot derivável)
                    → [atendimento realizado, status='completed'] →
                      beauty_review_invite (governed handler → sink 3-freios)
```

---

## 6. Guardrails RN-BS (codificados no código + regressão)

| Regra | Enforcement |
| --- | --- |
| **RN-BS-01** — foto tratada como dado sensível LGPD Art.5 II | `private_media`, EXIF strip, retenção config, URL HMAC TTL 15min, consent tipado |
| **RN-BS-02** — nunca vaza foto entre tenants | Isolamento cross-tenant DURO em TODAS as queries (testado) |
| **RN-BS-03** — IA NUNCA julga aparência | `AiGovernanceService.PEOPLE_AFFECTING['estetica_appearance_advice']` + actor+reason + validador HARD 20+ palavras proibidas + narrativa por template |
| **RN-BS-04** — consent tipado, escopos separados | `hair_simulation` ≠ `use_in_marketing` ≠ `whatsapp_notification` ≠ `guardian_approval`; consent LGPD `comunicacoes` também separado |
| **RN-BS-05** — nunca log de foto/base64/prompt | `safety_report_json` só flags booleanas; `ux_telemetry_events` sem colunas de conteúdo |
| **RN-BS-06** — quarentena obrigatória antes de qualquer processamento | Upload nasce `quarantined`; simulate exige `approved` |
| **RN-BS-07** — isolamento multi-tenant estrito | `organization_id` em toda query; cross-tenant testado em cada fatia |
| **RN-BS-08** — dinheiro role-gated | Rotas de valor gated por `requireRole` + ProfileGerente vê financeiro read (§73) |
| **RN-BS-09** — LGPD Art.18 direito ao apagamento | Revogar `hair_simulation` APAGA assets + arquivos imediatamente |
| **RN-BS-10** — retenção configurável e purgeExpired | Default 30d; clamp 1..365; purge lazy no acesso + Scheduler pass |
| **RN-BS-11** — IA NUNCA inventa dado | Vocab fechado (COLOR/CUT); catálogo vazio → `insufficient_catalog`; sem elegível → não publica vaga; sem maintenance_days → não sinaliza; sem consent → não recomenda; profissional sem link → rejeita |
| **RN-BS-12** — Autopilot NUNCA GA direto | Detectores só SINALIZAM; handler `beauty_review_invite` roda só APÓS `ApprovalPolicy.approve`; herda 3 gates F5-transversal |

---

## 7. Rollout (§4 do PRD)

**OFF (default) → shadow → single-tenant (Studio Márcia) → cohort → GA**

1. **OFF**: nada muda pras 8 verticais existentes; blueprints beauty publicados mas sem tenants assigned.
2. **Shadow**: Master Admin atribui `beleza_salao_v1` ao Studio Márcia via `VerticalBlueprintService.assignToOrganization`. Perfis Beauty são semeados. Detectores F11/F12/F14 podem ligar (flag opt-in) — só SINALIZAM, autopilot não age.
3. **Single-tenant piloto**: Studio Márcia usa Beauty AI, dono aprova cada ação individual do autopilot. Métricas F16 acompanham o funil.
4. **Cohort**: 3–5 salões adicionais atribuídos pelo Master Admin. Cada um configura suas flags individualmente. Nenhum passa a "auto" — decisão sempre humana (RN-BS-12).
5. **GA**: liberação geral do blueprint. Autopilot continua em SHADOW/single-approval até PRD futuro autorizar autonomia mais ampla.

**Rollback**: cada fatia é opt-in por flag. Desligar a flag zera o comportamento novo instantaneamente. Nenhuma migração destrutiva; blueprints e serviços podem ser desatribuídos sem perda de dado.

---

## 8. Como conectar um novo salão (§65 — sem tocar código)

1. **Master Admin** cria org com `vertical='beleza'`, `plan_id='growth'` (ou start/max) em `organization_settings`.
2. **Master Admin** roda `VerticalBlueprintService.assignToOrganization(orgId, bpBelezaId, actor)` — perfis Beauty semeados automaticamente.
3. **Dono do salão** cadastra:
   - Profissionais em `clinic_professionals` (via UI ou seed)
   - Serviços em `products_services` (type='service', duration_minutes, maintenance_days opcional)
   - N:N via `ProfessionalServiceService.link(orgId, proId, svcId)` (rota `/api/beauty/professional-services`)
4. **Dono** liga as flags que quer (via UI de configurações ou API):
   - `beauty_hair_simulator_enabled=1` pra habilitar Beauty AI
   - Opt-in seletivo dos detectores/gates conforme maturidade
5. **Cliente** entra no fluxo canônico da §5.

**Nada disso exige deploy.** Prova §65 codificada no `test:beauty-golden-paths` (fluxo E2E) e no `test:beauty-hardening` (0 hardcoded do Studio Márcia em `src/server`/`src/features`).

---

## 9. Troubleshooting

### 9.1 Foto sumiu do link assinado
- `beauty_avatar_retention_days` venceu — normal (LGPD Art.9 §1º). Cliente re-envia foto se quiser nova simulação.
- Cliente revogou `hair_simulation` — RN-BS-09 apaga assets imediatamente (por DESIGN).

### 9.2 Simulação SUCCEEDED mas cliente não vê resultado
- Verificar `beauty_visual_simulations.output_storage_key` — se null, provider falhou (`error_code`/`error_message_safe` populados).
- Se Gemini: verificar `AiUsageDashboardService.byOrg` — pode ter estourado quota.
- Fallback: Stub provider (`BEAUTY_HAIR_SIMULATION_PROVIDER=stub`) SEMPRE responde (determinístico, sem chamar rede).

### 9.3 Detector F11 não sinaliza consulta abandonada
- Verificar `beauty_abandoned_detector_enabled=1` na org.
- Verificar `beauty_abandoned_after_hours` — default 24; se custom, checar valor.
- Verificar consent `hair_simulation` ativo (RN-BS-11 — revogado ≠ sinaliza).
- Verificar que consulta está `ready` E `selected_at IS NULL`.

### 9.4 Autopilot enviou mensagem em hora silenciosa
- Isso NÃO deve acontecer — reportar como bug crítico.
- Se `client_quiet_hours_enforced=1`, `MessageProviderService.sendMessage` DEVE lançar `OutboundQuietHoursError` antes do fetch.
- Verificar log da ação: `RUNTIME_BEAUTY_REVIEW_SENT` audit deve ter falhado, ou sink foi bypassado (proibido — §37 canonical loop).

### 9.5 Recomendação inclui serviço que não existe
- Impossível — F9 filtra `products_services WHERE type='service' AND active=1`. Se aparecer, é bug crítico (RN-BS-11 violado).
- Ids em `beauty_reference_looks.suggested_services_json` que não existem no catálogo são IGNORADOS silenciosamente (testado).

### 9.6 Métricas de funil sumidas
- Verificar `ux_telemetry_enabled=1` na org.
- `UxTelemetryService.beautyMetrics` retorna `{restricted:true}` pra não-gestor (§73).
- `null` em conversion → denominador=0 (não há erro; simplesmente ainda não há dado suficiente).

---

## 10. Como adicionar um novo domínio ao Beauty Autopilot

1. Criar detector novo (padrão canônico F11/F12/F14):
   - `sweep(orgId, now?)` + `pass()` + `isEnabled/setEnabled`
   - Publica em `business_signals` com dedupe `beauty:<sinal>:{ids}` (D6/§42 — sem tabela paralela)
   - Registrar no `Scheduler.tick` best-effort
2. Criar handler novo (padrão canônico F13):
   - Implementa `CommandHandler` (`key`, `commandTypes`, `prepare`, `execute`)
   - Envia via `MessageProviderService.sendMessage` (herda F5-transversal automaticamente)
   - Registra via side-effect import
3. Escrever teste `test:beauty-<dominio>` cobrindo happy path + guardrails RN-BS
4. Adicionar entrada no `package.json` (CI-shard descobre automaticamente)
5. Atualizar este runbook (§1 mapa dos serviços) e ADR-169 (status + tabela de fatias)

---

## 11. Referências

- **ADR-169**: `docs/adr/ADR-169-vertical-beleza-saloes.md`
- **PRD 12** (Vertical Beleza & Salões): trata do fluxo §7 e das RN-BS-01..12
- **Análise F0**: `docs/prd/ANALISE-PRD-BELEZA-SALOES-vs-CODEBASE.md`
- **Runbooks irmãos** relevantes: `growth-operacao.md`, `social-intelligence-operacao.md`, `outcome-assurance-operacao.md`, `learning-operacao.md`
