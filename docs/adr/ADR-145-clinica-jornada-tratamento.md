# ADR-145 — Módulo Clínica: Jornada de Tratamento (episódio + ciclos + grupo + guia)

**Status:** Aceito — **em implementação**. Fatia 34 (esta ADR + travamento de enums/contratos + confirmação com o cliente). **Fatia 35 (Especialidades normalizadas + backfill do texto legado + vínculos N:N profissional↔especialidade) — MERGED.** **Fatia 36 (Episódio de cuidado + transfer/hold/resume/cancel; alta com PIN fica pra Fatia 39) — MERGED.** **Fatia 37 (Aditivos em appointments + gate EPISODE_PROFESSIONAL_MISMATCH + assistente Adicionar Especialidade atômico) — MERGED.** **Fatia 38 (Ciclos de sessões renováveis, saldo derivado por query — RN-004, renewalQueue, hook de transição on completion, ciclo inicial no addSpecialtyForPatient) — MERGED.** **Fatia 39 (Alta explícita com PIN obrigatório + reopen com PIN — RN-007; gate EPISODE_DISCHARGED em createAppointment; appointments futuros NÃO cancelados na alta) — MERGED.** **Fatia 40 (Métricas de jornada + fila operacional + counts pra badge — RF-100 §5; fecha a Fase 2) — MERGED.** Fase 2 CONCLUÍDA. **Fatia 41 (Sessões de agenda compartilhadas — D6 primeira classe: DB + service + rotas + transação atômica AC-012; refactor do findConflicts fica pra Fatia 42) — MERGED.** **Fatia 42 (Refactor findConflicts pra RN-006 — grupo de N = 1 ocupação; checkRoomCapacity + ROOM_CAPACITY_EXCEEDED; remove force=true temporário da Fatia 41) — MERGED.** Fatias 43-48 são o roadmap incremental (Fase 3 §3: métricas/portal de grupo; Fase 4: guia; Fase 5: IA).

**Data:** 2026-07

**Origem:** PRD 1.0 "Clínica: Jornada de Tratamento, Multiespecialidades, Sessões em Grupo, Renovação e Alta" (31/07/2026), consolidado a partir de 5 áudios do cliente (`clinica.ogg` a `clinica5.ogg`). A clínica não está pedindo melhorias na agenda — está pedindo que o sistema passe a representar a **jornada longitudinal de tratamento** do paciente: profissional fixo, multiespecialidades sem recadastro, ciclos renováveis de 10 sessões, sessão em grupo estruturada, alta explícita do médico e guia emitida pela recepção.

**Relacionadas:** ADR-080 (Módulo Clínica base — reusa `contacts`/`patient_profiles`/`appointments`/`clinical_encounters`/PIN Fase T/28/snapshot Fase 29/LGPD/audit), ADR-081 (Conectores TISS — molde da evolução da guia via XML), ADR-060 (AppointmentService base), ADR-056 (LGPD consent granular), ADR-072 (ModuleService — módulo `clinica` já ativo), ADR-074 (Scheduler — para passes de renovação/alerta).

---

## Contexto

### O que o inventário mostra (após 33 fatias do ADR-080)

O módulo Clínica cobre bem o **agendamento e atendimento pontual**, mas ainda não cobre a **continuidade do tratamento**. O que **existe e se reaproveita 100%**:

- **Identidade única do paciente** — `contacts` + `patient_profiles` + `patient_plan_history` + `patient_plan_snapshot_json` (Fase 29). O paciente nunca é duplicado. Troca de plano preserva snapshot histórico.
- **Agenda + retorno + cancelamento** — `appointments` com `parent_appointment_id`, `ClinicVacancyService` com grace de 5min (Fase 31), `findConflicts` com `force=true`, cancelamento lógico (nunca `DELETE`).
- **Prontuário/documentos** — `clinical_encounters` + addendum (Fase 20) + follow-up (Fase 26); receitas/atestados/recibos com PIN (Fase T/27), snapshot canônico e hash imutável (Fase 29), delivery via WhatsApp com HMAC + PDF privado (Fase K/18).
- **Autorização** — `procedure_authorization_requests` com operadora, TUSS, protocolo, número, validade e snapshot do plano (Fase R). ADR-081 já mapeia evolução TISS.
- **Segurança/LGPD** — isolamento por `organization_id`, `LgpdService.hasConsent` por categoria (`dados_sensiveis`, `comunicacoes`), `logAuthEvent` com `maskIdentifier` (Fase 32), `verifyPin` com `timingSafeEqual` + lockout (Fase 28), `computeDocumentHash` canoniza recursivo (Fase 29).
- **Config/observabilidade** — `organization_settings` com colunas opt-in por feature (padrão fases 24/26/33), `ModuleService.isEnabled("clinica")` como porta.

### O que é greenfield (trabalho novo, delimitado)

**Não é só configuração**. Cinco peças são genuinamente novas — a ausência delas é o que impede o cliente de operar hoje sem gambiarra:

1. **Especialidade normalizada** — hoje `clinic_professionals.specialty` é texto livre; não dá pra listar "profissionais qualificados para Fonoaudiologia" nem para configurar defaults por especialidade.
2. **Episódio de cuidado longitudinal** (`clinic_care_episodes`) — entidade central que amarra paciente + especialidade + profissional fixo + estado (`active`/`on_hold`/`discharged`). Sem ela, RF-020/030/070 são combinações frágeis de appointments soltos.
3. **Ciclo renovável de sessões** (`clinic_treatment_cycles`) — bloco administrativo dentro do episódio (padrão 10 sessões, configurável). Sem ele, "consumiu as 10" vira apagar o paciente ou perder o tratamento.
4. **Sessão de agenda compartilhada** (`clinic_schedule_sessions`) — hoje "vários no mesmo horário" só funciona via `force=true`, o que quebra ocupação, capacidade, prontuário coletivo e métricas.
5. **Guia da recepção** (`clinical_guides`) — hoje só existe `procedure_authorization_requests` (a solicitação); falta o artefato "guia emitida" com snapshot, PDF, numeração e ciclo de vida próprio.

### Onde projetos assim morrem

Três armadilhas conhecidas do domínio, todas evitáveis:

- **"Grupo é um appointment só com vários pacientes"** — quebra prontuário/presença/lembrete/recibo/portal individuais. **Decisão:** cada participante mantém `appointment` próprio; todos apontam para a mesma `schedule_session_id`.
- **"Contador mutável de sessões usadas"** — diverge silenciosamente do que aconteceu na agenda. **Decisão:** `used_sessions` é sempre **derivado por query** dos appointments (`completed` + opcionalmente `no_show`), nunca coluna mutável.
- **"Alta = deixar de recomendar retorno"** — perde rastreabilidade de quem deu alta, quando e por quê. **Decisão:** alta é ação explícita, com PIN do profissional (obrigatório — confirmado pelo cliente 2026-07), tipo enum, resumo e autoria auditada.

### Restrição de produto — respostas confirmadas pelo cliente (2026-07)

Antes de escrever qualquer linha de código, três perguntas críticas foram levadas ao cliente e respondidas:

- **"Guia" = qual documento?** → **os TRÊS**: TISS convênio, encaminhamento e pedido médico. Impacto: `clinical_guides.guide_type ENUM ('tiss_authorization', 'referral', 'medical_order')`, campos específicos por tipo em `snapshot_json` (cada tipo tem seus próprios campos obrigatórios), 1 tabela + PDF template polimorfo por `guide_type`.
- **Grupo vs. paralelo — 1 modo ou 2?** → **somente GRUPO** (terapia em grupo compartilhada). Cliente não usa "paralelo" (fisio supervisionando exercícios diferentes). Impacto: `clinic_schedule_sessions.session_type ENUM ('individual', 'group')` — sem `'parallel'`. Se surgir depois, é aditivo (append no enum), não breaking.
- **Alta exige PIN?** → **SIM, obrigatório**. Reusa `verifyPin` da Fase 28 (timingSafeEqual + lockout 5×/15min). Sem PIN válido do profissional responsável (ou gestor com override auditado), rota `discharge` retorna `PIN_REQUIRED`.

As 7 demais perguntas da seção 20 do PRD ficam com os **defaults provisórios** documentados lá (10 sessões configurável, no-show não consome, appointments futuros não cancelados na alta, capacidade de sala validada, etc.). Cada default vira coluna configurável em `organization_settings` no incremento correspondente.

---

## Decisão

### D1 — Episódio de cuidado é a entidade central; appointment vira participante

`clinic_care_episodes (id, org, contact_id, specialty_id, primary_professional_id, status, started_at, on_hold_at, discharged_at, discharge_type, discharge_summary, discharged_by_professional_id, discharge_signed_with_pin, reopened_at, created_by, timestamps)`.

Chave arquitetural: `appointments` recebe **aditivos opcionais** (`care_episode_id`, `treatment_cycle_id`, `schedule_session_id`, `specialty_id`, `cycle_sequence_number`, `professional_override_reason`) — appointments legados sem esses campos continuam operando como consulta avulsa. Migração é aditiva, retrocompatível 100%.

Índice único parcial garante 1 episódio ativo por (org, paciente, especialidade):
```sql
CREATE UNIQUE INDEX idx_care_episode_active_specialty
  ON clinic_care_episodes (organization_id, contact_id, specialty_id)
  WHERE status IN ('active','on_hold');
```

Estados: `active`, `on_hold`, `discharged`, `cancelled`. Só `discharged` fecha o episódio (D5). `cancelled` é pra episódio aberto por engano — reversível.

### D2 — Especialidade é normalizada; profissional é N:N com especialidades

`clinic_specialties (id, org, name, code?, color?, default_duration_minutes, default_cycle_sessions, active, timestamps)` + `clinic_professional_specialties (id, org, professional_id, specialty_id, is_primary, active)`.

Backfill: cada valor distinto de `clinic_professionals.specialty` (texto livre) vira 1 especialidade normalizada + 1 vínculo. Coluna legada **não é apagada** na migração — fica como fallback durante transição (padrão das fases 25/29 do ADR-080).

Ao abrir tratamento em uma especialidade, sistema **só lista profissionais vinculados**. Trocar `clinic_professionals.specialty` no cadastro não afeta episódios já abertos — o vínculo é histórico.

### D3 — Profissional fixo é regra do episódio, não do appointment

`care_episodes.primary_professional_id` é a fonte da verdade. Quando `appointments.care_episode_id IS NOT NULL`, o backend valida `appointments.professional_id == episode.primary_professional_id`. Divergência retorna `EPISODE_PROFESSIONAL_MISMATCH`.

Exceção só via `force=true` + `professional_override_reason` (texto obrigatório) + audit `CLINIC_PROFESSIONAL_OVERRIDE_USED`. Override pontual **NÃO altera** o episódio — é sempre uma consulta avulsa dentro do tratamento.

Transferência real é ação separada (`POST /care-episodes/:id/transfer`) — exige novo profissional da mesma especialidade, motivo e data de vigência. Registra `clinic_care_episode_transfers`. Não altera appointments/prontuários/documentos históricos (imutabilidade Fase 29).

### D4 — Ciclos renováveis; saldo derivado, nunca contador

`clinic_treatment_cycles (id, org, episode_id, cycle_number, previous_cycle_id?, planned_sessions, no_show_consumes_session, status, authorization_id?, guide_id?, starts_at?, expires_at?, renewal_requested_at?, renewed_at?, created_by, timestamps, UNIQUE (org, episode_id, cycle_number))`.

Estados: `draft`, `pending_authorization`, `active`, `renewal_due`, `exhausted`, `renewed`, `cancelled`, `expired`.

**RN-004 (regra crítica):** saldo é sempre derivado por query, nunca coluna mutável:
```text
consumidas = appointments.completed vinculados a este cycle
           + appointments.no_show, somente se cycle.no_show_consumes_session = 1
restantes  = max(planned_sessions - consumidas, 0)
```

Um episódio tem no máximo 1 ciclo `active` por vez. Renovação: cria novo ciclo com `cycle_number = anterior + 1`, `previous_cycle_id = anterior.id`. Anterior fica imutável (`renewed`) como histórico. Renovação ilimitada.

Ao esgotar (`remaining == 0`), ciclo vira `renewal_due` — episódio **continua `active`** (RN-001 do PRD: paciente NUNCA desaparece por consumo de sessões). Novo agendamento sem saldo exige renovação (ou override de gestor com motivo).

### D5 — Alta é explícita, com PIN do profissional (obrigatório)

Reusa `verifyPin` da Fase 28 — `timingSafeEqual` + lockout 5 tentativas / 15min. Rota `POST /care-episodes/:id/discharge` exige body `{pin, dischargeType, summary}`. Tipos enum: `clinical_discharge`, `goals_met`, `patient_request`, `abandonment`, `transfer_out`, `other`.

Regras:
- Finalizar appointment **não** dá alta.
- Consumir 10 sessões **não** dá alta (RN-001).
- Deixar de recomendar retorno **não** dá alta.
- Somente `POST /discharge` fecha episódio (`status = 'discharged'`).
- Alta **NÃO cancela** appointments futuros — a UI lista e exige decisão humana (RF-070 §8).
- Episódio `discharged` bloqueia novos agendamentos (`EPISODE_DISCHARGED` na criação).
- Reabertura é ação separada (`POST /reopen`), restrita, motivo obrigatório, PIN obrigatório, audit dedicado.
- Dados/histórico **nunca** apagados pela alta.

### D6 — Sessão de agenda compartilhada (só GRUPO por ora); appointments individuais

`clinic_schedule_sessions (id, org, specialty_id, professional_id, room_id?, procedure_id?, session_type, title?, scheduled_start, scheduled_end, duration_minutes, capacity, status, created_by, timestamps)`.

`session_type ENUM ('individual', 'group')`. Individual é o comportamento legado — cada appointment também pode existir sem `schedule_session_id` (compat). `'group'` é o novo modo confirmado pelo cliente. `'parallel'` fica de fora desta entrega (append no enum se aparecer necessidade).

**RN-006 (regra crítica):** conflito é por **sessão**, não por participante:
- Adicionar participante à mesma `schedule_session_id` → permitido até `capacity`.
- Criar outra sessão sobreposta para o mesmo profissional → **bloqueado**.
- Grupo de 5 pacientes = **1 ocupação** de agenda do profissional (não 5). Métricas Fase 43.
- 5 `appointments` individuais continuam existindo pra prontuário/presença/lembrete/recibo/portal.
- Corrida na última vaga (AC-012) resolvida por transação: `SELECT COUNT` + `INSERT` sob `db.transaction()`.

Cada participante mantém tudo individual — não existe "prontuário coletivo" nesta entrega.

Sala também tem limite: aditivo `clinic_rooms.capacity INTEGER DEFAULT 1`. Validado junto com capacidade da sessão.

### D7 — Guia da recepção suporta os 3 tipos (polimorfa por `guide_type`)

Confirmado pelo cliente (2026-07): guia pode ser **TISS convênio + encaminhamento + pedido médico**. Uma única tabela `clinical_guides`, com `guide_type ENUM ('tiss_authorization', 'referral', 'medical_order')` e `snapshot_json` polimorfo com campos específicos por tipo:

- **`tiss_authorization`** (guia TISS): operadora, carteirinha, TUSS, total_sessions, autorização, validade. Liga a `procedure_authorization_requests` e `treatment_cycle_id`.
- **`referral`** (encaminhamento): especialidade destino, CRM médico solicitante, motivo, urgência, exames prévios.
- **`medical_order`** (pedido médico): itens (exames/procedimentos), justificativa clínica, CID (reusa `cid10_codes` da Fase 23), validade do pedido.

Ciclo de vida comum: `draft` → `issued` → (`submitted` → `approved` | `denied`) | `expired` | `cancelled`. Emitida vira imutável (snapshot congelado + `document_hash` no padrão canônico da Fase 29). Rascunho editável.

Numeração `internal_number` unique por `(org, guide_type)` — cada tipo tem sua própria série. PDF privado em `PRIVATE_MEDIA_DIR/clinical_guides/{orgId}/{uuid}.pdf`, URL assinada HMAC + `exp` 15min (mesmo padrão Fase K/18/33). Segredo próprio derivado `sha256(JWT_SECRET:clinical_guide_v1)` — rotacionar JWT invalida URLs antigas.

LGPD: envio via canal exige `comunicacoes` do paciente. Categoria `dados_sensiveis` obrigatória (guia carrega diagnóstico/procedimento). Reusa `ClinicDocumentDeliveryService` (Fase K/27) — o serviço já suporta polimorfismo de `DocKind`.

XML TISS e transmissão automática **fora do escopo** desta entrega. `connector_type TEXT` fica na tabela pra evolução via ADR-081 sem breaking change.

### D8 — Cinco serviços novos, sem inchar `ClinicAgendaService`

`ClinicAgendaService.ts` já passou de 3.300 linhas de UI e ~1.500 de service. Adicionar tudo neste arquivo é regressão garantida (padrão das fases 20/26/33: extrair service próprio).

Serviços novos:
- `ClinicSpecialtyService.ts` — CRUD especialidade + vínculos + backfill.
- `ClinicCareEpisodeService.ts` — abrir/transferir/alta/reopen + visão consolidada por episódio.
- `ClinicTreatmentCycleService.ts` — criar/renovar/uso/saldo + fila de renovação + garantir 1 ciclo ativo.
- `ClinicScheduleSessionService.ts` — sessão individual/grupo + conflito por sessão + capacidade + participantes + cancelamento coletivo + disponibilidade.
- `ClinicGuideService.ts` — rascunho/edição/emissão/cancelamento + snapshot canônico + numeração + PDF polimorfo por `guide_type`.

Alterações **controladas** nos serviços existentes:
- `ClinicAgendaService`: delegar conflito quando `scheduleSessionId` presente; validar `EPISODE_PROFESSIONAL_MISMATCH`.
- `ClinicAuthorizationService`: aceitar `episodeId`, `cycleId`, ligar a `guide_id`.
- `ClinicMetricsService`: métricas de episódios/renovação/grupos; ocupação por `schedule_session` (não por appointment).
- `ClinicPatientTimelineService`: eventos novos (`EPISODE_OPENED`, `CYCLE_RENEWED`, `DISCHARGED`, `GUIDE_ISSUED`).
- `ClinicPortalService`: bloco de grupo com participantes na agenda do profissional.
- `ClinicPatientPortalService`: expõe especialidades ativas do paciente; NÃO vaza dados de outros pacientes do grupo.

### D9 — Ordem de migração determinística; nunca `ALTER` antes de `CREATE`

O ADR-080 registra 4 regressões históricas (fases L/T/U/25) causadas por `ALTER TABLE ADD COLUMN` executado antes do `CREATE TABLE` correspondente. **Ordem obrigatória em `db.ts`** para cada fatia:

1. Fatia 35: `CREATE clinic_specialties` + `CREATE clinic_professional_specialties`.
2. Fatia 36: `CREATE clinic_care_episodes` + `CREATE clinic_care_episode_transfers`.
3. Fatia 37: `ALTER appointments ADD care_episode_id/specialty_id/professional_override_reason` (**depois** que as tabelas de #1 e #2 existem).
4. Fatia 38: `CREATE clinic_treatment_cycles` + `ALTER appointments ADD treatment_cycle_id/cycle_sequence_number`.
5. Fatia 41: `CREATE clinic_schedule_sessions` + `ALTER appointments ADD schedule_session_id` + `ALTER clinic_rooms ADD capacity`.
6. Fatia 44: `CREATE clinical_guides`.

Todos os `try/catch` no padrão das migrações aditivas atuais (silencia `column already exists`). Índices declarados junto do `CREATE TABLE` correspondente, nunca em bloco separado.

### D10 — Feature flags por org; rollback preservando dados

Três flags novas em `organization_settings` (padrão fases 26/33):
- `clinic_care_journey_enabled INTEGER DEFAULT 0` — porta pras rotas de episódio/ciclo.
- `clinic_group_sessions_enabled INTEGER DEFAULT 0` — porta pra sessão em grupo.
- `clinic_guides_enabled INTEGER DEFAULT 0` — porta pra guia.

Default **0 (opt-in)**: org que não ligou continua com agenda legada. Rota bloqueada retorna `FEATURE_NOT_ENABLED`. Piloto ativa em 1 org antes de generalizar.

Rollback: desligar flags esconde novos fluxos; dados novos permanecem preservados; appointments legados continuam operando. **Nunca** remover tabelas/colunas em rollback (padrão ADR-080 fases L/T/U — dados clínicos são retenção 20 anos por CFM 1.821/2007).

---

## Roadmap de fatias

Cada fatia = 1 PR mergeável independente, com teste dedicado e wiring no CI (padrão ADR-080).

**Fase 0 — ADR + validação (Fatia 34 — esta)**
- Este documento + confirmação do cliente sobre guia/grupo/PIN.

**Fase 1 — Especialidades + episódio + profissional fixo (Fatias 35-37)**
- **F35:** DB `clinic_specialties` + `clinic_professional_specialties` + `ClinicSpecialtyService` + backfill do texto legado + rotas CRUD + `test:clinic-specialties`.
- **F36:** DB `clinic_care_episodes` + `clinic_care_episode_transfers` + `ClinicCareEpisodeService` (open/transfer) + rotas + `test:clinic-care-episodes`.
- **F37:** Aditivos em `appointments` (`care_episode_id`, `specialty_id`, `professional_override_reason`) + gate RN-002 + assistente "Adicionar especialidade" (backend) + doc UI pendente + `test:clinic-episode-appointment-integration`.

**Fase 2 — Ciclos + renovação + alta (Fatias 38-40)**
- **F38:** DB `clinic_treatment_cycles` + `ClinicTreatmentCycleService.create/renew/usage` (saldo derivado) + fila renovação + `test:clinic-treatment-cycles`.
- **F39:** Rotas `POST /care-episodes/:id/discharge` + `/reopen` com PIN obrigatório (Fase 28) + tipos enum + audit + `test:clinic-discharge-reopen`.
- **F40:** `ClinicMetricsService` novas métricas + rotas fila operacional + counts pra badge (padrão Fase 31) + `test:clinic-care-journey-metrics`.

**Fase 3 — Sessão em grupo (Fatias 41-43)**
- **F41:** DB `clinic_schedule_sessions` + aditivos `appointments.schedule_session_id` + `clinic_rooms.capacity` + `ClinicScheduleSessionService` com transação atômica pra RN-006/AC-012 + `test:clinic-group-sessions`.
- **F42:** Refactor `ClinicAgendaService.findConflicts` pra conflito por sessão + validação capacidade sala/sessão + `test:clinic-conflict-by-session`.
- **F43:** Métricas ocupação por sessão + portal (bloco grupo + participantes) + `ClinicPatientPortalService` sem vazar outros pacientes + lembretes individuais + `test:clinic-group-metrics-portal`.

**Fase 4 — Guia da recepção (Fatias 44-46)**
- **F44:** DB `clinical_guides` polimorfo + `ClinicGuideService.create/edit/issue/cancel` + numeração + snapshot canônico (padrão Fase 29) + `test:clinic-guides`.
- **F45:** PDF polimorfo por `guide_type` (TISS/referral/medical_order) + rota assinada HMAC + `POST /guides/:id/send` reusando `ClinicDocumentDeliveryService` + LGPD comms + `test:clinic-guide-pdf-send`.
- **F46:** Integração `ClinicAuthorizationService` (ligação bidirecional autorização↔guia) + `treatment_cycles.guide_id` + RN-005 §8 (novo ciclo `pending_authorization` até guia) + `test:clinic-guide-authorization-cycle`.

**Fase 5 — IA operacional (Fatias 47-48)**
- **F47:** Detector `renewal_due` cria tarefa recepção (padrão Fase 26) + IA sugere 3 horários via `availability` — nunca inventa dado + `test:clinic-ai-renewal-hints`.
- **F48:** IA pré-preenche rascunho de guia com dados existentes; sinaliza campo ausente; jamais inventa TUSS/carteirinha/autorização + `test:clinic-ai-guide-draft`.

**Estimativa total:** ~18 dias úteis backend + doc UI pendente pra sessão Playwright separada. Fase 1 e Fase 2 são as dores principais dos áudios do cliente — priorização confirmada.

---

## Consequências

### Ganhos
- Cliente para de precisar de gambiarra (`force=true` pra grupo, "esquecer" paciente pra fingir alta, recadastrar pra outra especialidade).
- Base sólida pra faturamento TISS futuro (guia + autorização + ciclo já estruturados; conector é aditivo).
- Métricas de negócio novas (episódios ativos/especialidade, ciclos até alta, ocupação real, renovações por convênio).
- Isolamento multi-tenant preservado; retrocompatibilidade 100% via aditivos.

### Custos
- 6 tabelas novas + 6 aditivos + 5 serviços novos ao longo de 14 fatias. Escopo grande mas fatiado.
- Refactor de `ClinicAgendaView.tsx` (>3300 linhas) inevitável pra UI dos episódios/grupo/guia — extração incremental por componente, não big-bang.
- Backfill de especialidades legadas exige revisão manual (assistente com confirmação da recepção — não automatizar tratamento ativo por presunção).

### Riscos e mitigação
- **"Guia" com 3 tipos pode virar 3 tabelas depois** — `snapshot_json` polimorfo hoje mantém tabela única; se a divergência de campos ficar grande demais, refactor futuro pra `clinical_guide_tiss` / `clinical_guide_referral` / etc. sem breaking (view unificada).
- **Grupo pode escalar de 6 pra 20 participantes** — capacidade é coluna, não constante. Limite superior fica no service (default 20, config futura).
- **Alta com PIN pode travar operação** — configuração por org (Fase 39): `clinic_discharge_pin_required INTEGER DEFAULT 1` — cliente que confirmou hoje deixa em 1; se surgir cenário sem PIN (ex.: consultório solo do próprio dono), gestor pode desligar sob risco documentado.
- **Corrida na última vaga do grupo** — resolvida por `db.transaction()` + `SELECT COUNT... FOR UPDATE` equivalente em SQLite (transação exclusiva). Coberto por AC-012.
- **Migração de `clinic_professionals.specialty` (texto)** — coluna legada mantida durante 6 meses; após, deprecação com log de warning antes de remover.

---

## Perguntas ainda em aberto (defaults provisórios em uso)

Do PRD seção 20, respostas 4-10 usam defaults enquanto o cliente não confirma:

- Regra de 10 sessões: **padrão configurável por especialidade** (`clinic_specialties.default_cycle_sessions`, default 10).
- No-show consome sessão: **default 0** (não consome), configurável por ciclo (`treatment_cycles.no_show_consumes_session`).
- Quem pode dar alta: **profissional responsável OU gestor** (owner|admin) com autoria profissional registrada. Ambos exigem PIN (D5).
- Transferência de profissional: **owner|admin** com motivo + profissional destino da mesma especialidade.
- Sala tem limite: **sim, validado** (aditivo `clinic_rooms.capacity` D6, default 1).
- Alta cancela appointments futuros: **NÃO** cancela automaticamente; UI lista e exige decisão humana (RF-070 §8).
- Renovação exige nova guia: **sim se procedimento exige autorização** (RN-005 §8: novo ciclo nasce `pending_authorization`).

Todas viram config em `organization_settings` ou coluna em ciclo/episódio no incremento correspondente. Cliente pode ajustar sem redeploy.
