# Auditoria de Codebase — Professional Network & Agenda Federada (F0)

> Pré-requisito da ADR-180. Formato §71 do PRD: por capacidade, **onde já existe**,
> **reusar / estender / substituir**, **risco** e **impacto**. Doc-only — nenhuma linha
> de produção escrita nesta fatia.
>
> Tese da auditoria: **~60–70% do que a Agenda Federada precisa JÁ EXISTE** no
> ZapFlow (motor de disponibilidade por profissional, Google Calendar bidirecional,
> espinha de governança/execução/confirmação, ledger de sinais). O trabalho real do
> MVP são **3 lacunas de borda**: (a) identidade de profissional **cross-org** com
> relacionamento por clínica; (b) **hold/reserva** atômico com janelas e buffers por
> profissional; (c) as **ferramentas de IA** (getAvailability/hold/confirm) plugadas
> na espinha de governança que já existe.

## Sumário por capacidade

| Capacidade | Onde já existe | Reusar / Estender / Substituir | Risco | Impacto no MVP |
| --- | --- | --- | --- | --- |
| Motor de disponibilidade por profissional | `ClinicScheduleSessionService.availability` (sugere 3 horários do MESMO profissional, ADR-145 F47) | **Estender** — falta hold, buffer e janela de trabalho por profissional | Médio | Núcleo da F3 |
| Detecção de conflito de horário | `ClinicAgendaService.findConflicts` / `checkRoomCapacity` | **Reusar** | Baixo | F3 |
| Transação atômica (SELECT COUNT dentro da tx antes do INSERT) | `addParticipant` (padrão AC-012, Fatia 41) | **Reusar como template** do confirm atômico | Baixo | F3 |
| Tabela de hold/reserva temporária | **NÃO EXISTE** | **Criar** (aditivo) `clinic_slot_holds` | Médio | F3 |
| Identidade de profissional cross-org | `professional_services` (db.ts:9269, por-org) · precedente `vertical_intelligence`(global)+`organization_contextualization`(bridge) · `retail_sellers`+`retail_seller_store_assignments` (identidade + atribuição) | **Criar** `professionals` (global) + **estender** com `clinic_professional_relationships` (bridge por-org) | **Alto** (decisão de fronteira — ver ADR-180) | Núcleo da F1 |
| Usuário pertence a 1 org | `users.email` UNIQUE; sem multi-org hoje | **Não tocar** no MVP — profissional é ENTIDADE, não usuário; webapp do profissional é DEFERIDO (F7) | Alto se antecipado | Fronteira do MVP |
| Google Calendar (criar/editar/excluir + freeBusy) | `GoogleOAuthService` (create/patch/delete event, freeBusy) · `oauth_connections` (tokens cifrados) · `EncryptionService` AES-256-GCM | **Reusar** — falta conexão POR PROFISSIONAL + escopo calendar-only + registro de eventos próprios + `getBusy` estruturado | Médio | DEFERIDO F6 |
| Espinha de governança (proposta→política→execução) | `DecisionActionService` → `ApprovalPolicyService` (Autonomy Contract) → `CommandExecutorService` (registry de handlers, 3 guards) | **Reusar** — AutoBooking = 1 handler `auto_booking` no MESMO registry | Baixo | F4 |
| Confirmação com SLA/timeout | `ConfirmationEngine.expect/confirm/sweepTimeouts` · `CONFIRMATION_METHODS` · `Scheduler.confirmationTimeoutPass` (já agendado) | **Reusar** — novo método `booking_confirmation` | Baixo | F4 |
| Ledger de sinais / atenção (fila de espera, alertas) | `business_signals` + `attention()` (dedupe_key, convenção nº 12) | **Reusar** — waitlist e "profissional não respondeu" publicam sinal, NUNCA tabela paralela | Baixo | F4 |
| Lembrete governado por WhatsApp | `TaskReminderService` (consentimento/quiet-hours/cap diário/dedupe/DLQ, ADR-172) | **Reusar** para lembrete de agendamento | Baixo | F4 (opcional) |
| Âncora de finanças (comissão clínica × profissional) | `professional_services.commission_percent` (já existe, db.ts:9269) | **Deixar quieto** — F8 finanças é DEFERIDO | Baixo | Fora do MVP |

## Detalhamento das 4 auditorias

### 1. Motor de disponibilidade & atomicidade
- `ClinicScheduleSessionService.availability` já resolve o problema central "sugerir 3
  horários do **mesmo** profissional" (RN-003 profissional fixo). É o ponto de partida
  da F3, mas **não tem**: (i) hold temporário (a vaga fica livre até o INSERT final),
  (ii) buffer entre atendimentos, (iii) janela de trabalho por profissional (hoje a
  disponibilidade deriva da agenda existente, não de um "expediente" declarado).
- `findConflicts` e `checkRoomCapacity` cobrem conflito de horário e capacidade de sala
  — reusar direto.
- `addParticipant` (padrão AC-012 da Fatia 41) é o **template** do confirm atômico:
  SELECT COUNT dentro da transação antes do INSERT evita corrida de dois agendamentos
  na mesma vaga. O confirm da F3 espelha isso.
- **Não existe tabela de hold.** É a única estrutura nova de disponibilidade que o MVP
  precisa criar (`clinic_slot_holds`, aditiva, com TTL).

### 2. Identidade cross-org — a decisão de fronteira
- Precedente físico já validado no repo: `vertical_intelligence` (GLOBAL, **sem**
  `organization_id`) + `organization_contextualization` (bridge POR-ORG, isolado,
  never-write-back RN-156-1). E `retail_sellers` (identidade) +
  `retail_seller_store_assignments` (atribuição) — identidade separada de vínculo.
- Aplicação: `professionals` GLOBAL (chaveado por conselho + registro, ex.
  `CRMV-SP 12345`) + `clinic_professional_relationships` (bridge POR-ORG com permissões:
  quais serviços a clínica pode agendar, comissão, status do convite).
- `users.email` é UNIQUE e o sistema assume **1 usuário = 1 org**. Por isso o MVP trata
  o profissional como **ENTIDADE do ecossistema**, não como usuário logável — o webapp
  de autoatendimento do profissional (F7) fica **fora do MVP** para não colidir com o
  modelo de auth atual. A clínica opera a agenda do profissional; o profissional ainda
  não loga.

### 3. Google Calendar
- `GoogleOAuthService` já faz create/patch/delete de evento e `freeBusy`; tokens ficam
  cifrados em `oauth_connections` via `EncryptionService`. A sincronização bidirecional
  **já é infra existente**.
- Lacunas para a Agenda Federada: (i) conexão **por profissional** (hoje é por-org),
  (ii) escopo **calendar-only** (menor privilégio), (iii) registro dos eventos que o
  ZapFlow criou (para editar/excluir só o que é nosso), (iv) `getBusy` estruturado por
  profissional. Tudo **DEFERIDO para a F6** — o MVP funciona com a agenda interna; o
  Google é um amplificador, não um pré-requisito.

### 4. Governança / AutoBooking
- AutoBooking **não precisa de motor novo**: é 1 `CommandHandler("auto_booking")` no
  registry do `CommandExecutorService`, com `ApprovalPolicyService` (Autonomy Contract)
  definindo a banda de autonomia via `agent_policies`, e `ConfirmationEngine.expect`
  (novo método `booking_confirmation`) armando a confirmação; `sweepTimeouts` já roda no
  Scheduler. Waitlist e "profissional não respondeu no SLA" publicam em
  `business_signals`. Lembretes via `TaskReminderService`.
- `professional_services.commission_percent` já existe como âncora de finanças — mas F8
  (previsão de receita/impostos/split) é **DEFERIDO**.

## Conclusão da F0
O MVP (F1–F4) é **majoritariamente composição** sobre motores existentes. As três peças
genuinamente novas são pequenas e aditivas: `professionals` (global) +
`clinic_professional_relationships` (bridge), `clinic_slot_holds` (hold atômico) e o
handler `auto_booking`. Nenhum motor, scheduler, policy ou confirmation paralelo (§184).
Decisão de fronteira (propriedade da identidade do profissional) formalizada na ADR-180.
