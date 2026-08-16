# ADR-171 — Tarefas recorrentes (motor de recorrência)

**Status:** Implementado (Fase 2 do PRD Moda/TOULON, frente TASK — motor).
**Origem:** PRD Moda/TOULON, TASK-001..008 + §8.3 + §9.4. O PRD manda propor ADR
curto para a recorrência.

## Contexto

O módulo de tarefas (`TaskService`) não tinha recorrência — rotinas repetitivas
eram recriadas à mão. Faltava um template de regra + materialização automática
sem duplicar.

## Decisão

Regra recorrente como **template** (`task_recurrence_rules`, aditiva). O Scheduler
**materializa** uma tarefa normal em `tasks` para cada ocorrência vencida — cada
ocorrência preserva seu próprio histórico de conclusão (TASK-002).

### Timezone (TASK-004)

`local_time` + `timezone` (IANA) definem a hora local; `next_run_at` é guardado
em **UTC**. A conversão local→UTC usa `Intl` (sem lib): calcula o offset da zona
no instante e reajusta na virada de DST. Correto inclusive fora do Brasil; para a
TOULON (`America/Sao_Paulo`, sem DST desde 2019) é exato — 09:00 local = 12:00Z.

### Idempotência (TASK-003)

Chave determinística `occurrence_dedupe_key = ${ruleId}:${scheduledAtISO}` em
`tasks`, com índice único parcial `(organization_id, occurrence_dedupe_key)`.
Reprocessar o passe do Scheduler **não duplica** (checagem + índice como backstop
contra corrida).

### Catch-up limitado

Duas fases em `materializeRule`: (1) **fast-forward** sobre ocorrências mais
velhas que a graça (2 dias) — só avança o relógio, sem materializar; (2)
materializa as ocorrências em `[graça, agora]`, limitado a `MAX_CATCHUP`. Uma
regra parada há meses NÃO gera enxurrada de tarefas atrasadas.

### Fim e pausa (TASK-006)

`ends_on` (data) e `max_occurrences` (contagem, derivada por query — RN-004)
encerram a regra (`status='completed'`). `pause`/`resume` — resume reprograma o
próximo disparo a partir de agora, sem refazer o passado.

## Modelo

`task_recurrence_rules`: frequency (daily/weekly/monthly), interval, by_weekday
(JSON 0..6), day_of_month (clampado ao fim do mês), local_time, timezone,
starts_on, ends_on, max_occurrences, next_run_at (UTC), status,
notification_policy_json, version. Colunas aditivas em `tasks`:
recurrence_rule_id, scheduled_occurrence_at, occurrence_dedupe_key.

## Rotas

`GET/POST /api/tasks/recurrence`, `GET /recurrence/:id`,
`POST /recurrence/:id/pause|/resume`, `DELETE /recurrence/:id` (encerra).
Registradas ANTES de `/:id` (senão `/recurrence` casaria `/:id`).

## Consequências

- Cobre AC-10 (regra semanal → exatamente uma ocorrência com hora local correta).
- Notificação in-app sai de graça: `TaskService.create` já notifica o responsável.
- Aditivo/retrocompatível; isolado por organização.

## Fora desta fatia (fatias seguintes)

- **TASK-007 (lembretes por WhatsApp):** `notification_policy_json` já é
  armazenado; o envio governado (nº confirmado, consentimento, quiet-hours,
  limite, dedupe por canal, retry/DLQ) é fatia própria.
- **TASK-005 (edição "só esta" × "esta e próximas"):** hoje editar a regra afeta
  as ocorrências futuras; a edição de ocorrência única é fatia própria.

Teste: `scripts/test-task-recurrence.ts` (19 checks).
