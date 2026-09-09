# F4.0 — Auditoria de Consolidação dos Registros do Fala Tu (RF-09 / CA-09)

> Abertura da **Fase 4** no mesmo espírito da F0/F3.0: **revalidar o que existe
> antes de mexer**. Doc-only. Referências `arquivo:linha` no HEAD.

## Contexto

A Onda A (ADR-160 F5–F10) já introduziu o Fala Tu como PORTA pro domínio
canônico com **dual-write opt-in por flag** + uma **reconciliação/backfill**.
A Fase 4 (RF-09) não começa do zero — ela FECHA GAPS de consolidação:
relatório por registro, backfill idempotente/retomável sem efeitos externos,
transferência de leitura, e convergência de conclusão/reabertura (CA-09).

## O que JÁ existe (reusar, não reconstruir)

### Silo do Fala Tu
`falatu_inbox_items` (envelope; `intent` TASK/EVENT/LIST/NOTE/UNKNOWN
`db.ts:7090`, `status` pending/confirmed/discarded `:7094`, `confirmed_kind`
`:7095`, `confirmed_ref_id` `:7096`) → materializa em `falatu_tasks`
(`:7104`, `completed` `:7108`), `falatu_events` (`:7118`, sem status),
`falatu_lists` (`:7131`, `list_type`/`status`) + `falatu_list_items`
(`:7147`, `realized`). Convenção `db.ts:7078`: nunca DELETE — discard é UPDATE.

### Vínculo canônico (dual-write) — 3 colunas aditivas, cada uma sob flag
- `falatu_tasks.bridged_task_id` (`db.ts:8544`, flag `falatu_bridge_tasks_enabled`) → `tasks`/`TaskService`.
- `falatu_events.bridged_appointment_id` (`db.ts:8554`, flag `falatu_bridge_events_enabled`) → `appointments`/`AppointmentService` (contact-gated).
- `falatu_lists.bridged_requisition_id` (`db.ts:8565`, flag `falatu_bridge_lists_enabled`) → `purchase_requisitions` (só `list_type='shopping'` + itens casados no catálogo).

Escritos SÓ em `FalaTuService.confirm` (`:508`/`:525`/`:555`) e no backfill
(`FalaTuBridgeReconService.ts:107`). `confirm` é dual-write numa ÚNICA
transação (`:491-609`): insere o silo e, com a flag ligada, cria o canônico e
carimba o vínculo — falha no canônico derruba a confirmação (não deixa silo
sem espelho).

### Preservação de nota pessoal (por design, já correto)
Discriminador = `intent` → `confirmed_kind`. NOTE/UNKNOWN nunca viram canônico
(`FalaTuService.ts:559`). EVENT só espelha com contato real + data + hora
(senão fica lembrete pessoal, `db.ts:8550`). LIST só `shopping` (general/
meeting/trip ficam no silo). **Não há flag `is_personal` — o split é por
`intent` + `list_type` + contato real.**

### Reconciliação (ADR-160 F10) — `FalaTuBridgeReconService`
- `report(orgId)` (`:45`): **contagens agregadas** por tipo (`total`/`bridged`/
  `unbridged`/`brokenLinks`/`coveragePct`/`ready`) + `overallReady`. Read-only.
- `backfillTasks(orgId, {limit})` (`:97`): liga tarefas históricas
  (`bridged_task_id IS NULL`) via `TaskService.create(source:"falatu")` +
  carimba. **Idempotente** (`WHERE bridged_task_id IS NULL`), flag-gated,
  `limit` 1..2000 + `remaining`.
- Rotas `GET /api/falatu/bridge/recon` + `POST /bridge/backfill-tasks`
  (owner/admin). Teste `test:falatu-bridge-recon`.

## Gaps da Fase 4 (o que FALTA)

| Fatia | O que o PRD pede | Estado hoje | Gap |
|---|---|---|---|
| **F4.1** | Relatório POR REGISTRO + classificação de conflito (RF-09 §15.1) | `report` só dá **contagem agregada** + `brokenLinks` | Falta listagem por registro e a **taxonomia de conflito** (§15.1: vínculo-válido-coerente / estados-diferentes / sem-vínculo-migrável / nota-pessoal / vínculo-quebrado / dois-objetos-possíveis) |
| **F4.2** | Lote idempotente + **checkpoint/retomada** + modo **sem efeitos externos** (dry-run) | Backfill de tarefas idempotente + `limit`/`remaining`; **sem** checkpoint persistido, **sem** dry-run, **sem** backfill de events/lists | Falta dry-run, checkpoint durável, e o backfill de events/lists |
| **F4.3** | Transferir leitura/escrita ao domínio principal, preservar notas pessoais | Escrita dual-write existe; **leitura** ainda vem do silo (`tasks()/events()/lists()` leem `falatu_*`, `FalaTuService.ts:682-706`) | Falta a virada de LEITURA (derivar do canônico quando bridged) — nota pessoal já preservada |
| **F4.4** | Conclusão/reabertura CONVERGEM; sem duplicidade; reversível (CA-09) | 🚩 **NÃO convergem**: `toggleTask` (`:686-691`) mexe SÓ no silo, não lê `bridged_task_id` nem toca a `tasks` canônica; `TaskService` não escreve de volta | **Convergência de conclusão** é o gap de correção nº1 do CA-09 |

### 🚩 Achado nº1 (correção / CA-09): conclusão não converge
`FalaTuService.toggleTask` (`:686-691`) atualiza só `falatu_tasks.completed`;
não propaga pra `tasks` canônica quando `bridged_task_id` existe. `TaskService`
tampouco escreve de volta. Concluir/reabrir num lado deixa o outro
desatualizado — viola diretamente o RF-09 §15.2 ("concluir/reabrir … precisam
convergir") e o CA-09 ("estados continuam coerentes entre interfaces").

### Bookkeeping de migração — AUSENTE
Não há tabela de mapa old-id→canônico (além das 3 colunas `bridged_*`), versão
de migração, checkpoint persistido, registro de conflito ou contagens
(o "Mapa de migração" do §15.2/§17.1). Reexecução hoje é idempotente pelo
`bridged_*_id IS NULL`, não por um id-map.

## Recorte proposto da Fase 4 (fatia-por-PR, aditivo/reversível)

| Fatia | Escopo | Por quê nesta ordem |
|---|---|---|
| **F4.0** | Esta auditoria (doc-only) | Revalidar antes de mexer |
| **F4.1** | Relatório POR REGISTRO + taxonomia de conflito (§15.1), read-only, estende `FalaTuBridgeReconService` | Observabilidade ANTES da migração (o PRD pede o relatório primeiro); risco baixo |
| **F4.2** | Backfill idempotente com **dry-run** (sem efeitos externos) + **checkpoint durável** + estende a events/lists | Migração segura, retomável, simulável (§15.2 / RF-09 "modo de simulação") |
| **F4.3** | Convergência de conclusão/reabertura (fecha o achado nº1 / CA-09): `toggleTask` propaga pro canônico quando bridged, por um caminho idempotente único | Correção nº1 do CA-09; contido |
| **F4.4** | Prova CA-09 ponta-a-ponta (migrar 2× sem perda/dup/promoção; estados coerentes) + virada de leitura opcional | Fecha o Gate G4 |

> Nota de ordem: troquei a ordem "natural" F4.3↔F4.4 do PRD porque a
> CONVERGÊNCIA de conclusão (o achado de correção) é pré-condição pra provar
> CA-09; a virada de LEITURA é a parte mais arriscada e fica por último/opcional
> (§15.3: retirar redundância só depois de tudo reconciliado — não neste
> rollout). Confirmo o recorte de cada fatia antes de tocar código quente.

**Recomendação:** começar por **F4.1** (relatório por registro) — é a primeira
fatia do PRD, read-only, e dá a base de observabilidade que as fatias de
migração e convergência vão usar.

## Guardrails RF-09 (não violar)

- Migração **por organização**, com **simulação** e **checkpoint** — nunca um
  job global sem limites (§15).
- **Nenhum efeito externo** no backfill (notificação/webhook/cobrança/sync).
- **Nunca** deduplicar por título/valor/data — exige evidência de origem.
- **Nunca** promover nota pessoal a tarefa de equipe sem política explícita.
- **Nunca** apagar tabela/rota neste rollout (§15.3) — retirada física é
  entrega posterior.
- Idempotência: reexecutar lote **não cria** novos objetos.
