# ADR-172 — Lembrete de tarefa por WhatsApp (governado)

**Status:** Implementado (Fase 2 do PRD Moda/TOULON, frente TASK — TASK-007).
**Origem:** PRD Moda/TOULON, TASK-006/007. Extensão do motor de recorrência
(ADR-171).

## Contexto

A tarefa recorrente já notifica o responsável IN-APP (via `TaskService.create`).
Faltava o lembrete por **WhatsApp** — mas mandar mensagem a uma pessoa exige
governança (consentimento, janela de silêncio, não spammar, não repetir).

## Decisão

`TaskReminderService` envia o lembrete **best-effort**, OPT-IN por regra
(`notification_policy_json.whatsapp`), com guardas:

- **Número:** `users.phone` do responsável; sem número → só in-app (skip honesto).
- **Janela de silêncio:** `UxPreferencesService.isAwake(org, horaSP)` — fora da
  janela acordada não envia (sem log; re-tenta num passe acordado).
- **Limite diário** por responsável (anti-spam).
- **Dedupe:** índice único `(org, task, channel, reminder_type)` em
  `task_reminder_log` — nunca manda o mesmo lembrete 2x.
- **Falha não cancela a tarefa (TASK-006):** vira `failed` no log e é RE-TENTADA
  nos passes seguintes até 3 tentativas; depois vira **DLQ** (para de tentar).

O ENVIO é **injetado** (`send`), como em `RetailTaskService.runReminders` —
mantém o serviço testável offline e desacoplado do canal. O passe do Scheduler
resolve o canal WhatsApp ativo da org e usa `MessageProviderService.sendMessage`.

## Modelo

`task_reminder_log` (aditiva): org, task_id, assigned_to, channel, reminder_type,
status (`sent`|`failed`), attempts, detail. Índice único de dedupe + índice por
status.

## UI

No formulário de recorrência (ADR-171), toggle **"Avisar o responsável por
WhatsApp"** → grava `notificationPolicy: { whatsapp: true }`. Aviso honesto: só
envia se o responsável tiver WhatsApp no perfil.

## Consequências

- Cobre AC-11 (falha de mensagem não elimina a tarefa; in-app permanece; envio
  com retry auditado).
- Aditivo/retrocompatível; isolado por organização; opt-in por regra.

## Fora de escopo (fatias/decisões seguintes)

- **Confirmação de número + consentimento explícito por pessoa:** hoje a presença
  de `users.phone` + opt-in da regra é o sinal; um fluxo de confirmação de número
  é fatia própria.
- **Template aprovado (WhatsApp Business API):** o texto é livre no canal atual
  (Evolution). Se um canal exigir template aprovado, é fatia própria.
- **Lembretes antecipados ("30 min antes"):** hoje o lembrete sai na
  materialização da ocorrência; janelas de antecedência são fatia própria.

Teste: `scripts/test-task-reminder.ts` (13 checks).
