# ADR-108 — Cobrança por pessoa + baixa de malote/escala pelo WhatsApp

**Status:** Implementado (Bloco B). **Origem:** áudio do cliente TOULON (Bruno):
_"mandar mensagem para a equipe... enviar a folha de malote, o fechamento e as
escalas, e se a pessoa não mandar, aquele número de WhatsApp que não mandar ser
cobrado novamente"_.

## Contexto

Antes deste bloco a cobrança (ADR-083, `RetailTaskService.runReminders`) mandava
para **um único número por loja** (`retail_stores.whatsapp_identifier`) e a baixa
das pendências malote/escala só acontecia pelo **painel** (`markSubmitted` via
API). Faltavam duas coisas pedidas pela TOULON: cobrar **pessoas** (não só o
número da loja) e dar **baixa quando a pessoa responde no WhatsApp**.

## Decisão

### 1. Responsáveis por loja (`retail_store_responsibles`)

Nova tabela: cada loja pode ter N responsáveis (`name`, `whatsapp_identifier`,
`task_types` = `all` ou CSV de `fechamento,malote,escala`, `active`).
`RetailResponsibleService`: CRUD + `targetsForTask(store, tipo)` (responsáveis
que cobrem o tipo; **fallback no número da loja** se não houver nenhum, para
nunca deixar de cobrar) + `findStoreByResponsible(identifier)` (resolve o número
de um responsável para a loja, tolerante ao 9º dígito BR).

### 2. Cobrança por pessoa

`runReminders` passa a cobrar **cada responsável** do tipo da pendência (loop
sobre `targetsForTask`), mantendo o estado de cobrança (reminder_count,
intervalo, escalonamento ao gestor após o teto) **no nível da tarefa** — há uma
folha de fechamento/malote/escala por loja/dia, então a cobrança repete a todos
os responsáveis até que **alguém** envie. Sem responsáveis cadastrados, o
comportamento é idêntico ao anterior (número da loja).

### 3. Baixa de malote/escala pelo WhatsApp

`RetailWhatsAppIntakeService` (ADR-107) ganha:
- `matchStore` agora resolve também pelo **número do responsável** (não só o da
  loja).
- `detectTaskConfirmation(text)` — exige o **substantivo** (malote/escala) **+**
  palavra de confirmação (enviado/mandei/ok/pronto/atualizada…). "ok" sozinho
  **não** dá baixa (evita baixa por engano).
- Ao confirmar, se houver a pendência aberta do tipo no dia, dá **baixa**
  (`markSubmitted`) e a cobrança para. Cobre também foto do malote com legenda.

### Rotas

`/api/retailops/stores/:id/responsibles` (GET/POST), `/responsibles/:rid`
(PATCH/DELETE) — mutações só owner/admin.

## Consequências

**Positivas:** a equipe é cobrada por pessoa e a pendência baixa sozinha quando
alguém responde no WhatsApp — fecha o pedido de "cobrar o número que não mandou".
Retrocompatível (fallback no número da loja). **Trade-offs:** o estado de
cobrança é por tarefa (loja/dia/tipo), não por indivíduo — cobra todos os
responsáveis até alguém enviar, o que é o correto para uma folha única por loja.
Baixa de malote/escala é por confirmação textual (o fechamento continua por
foto/valor, ADR-107); a **UI** de gestão de responsáveis vem no Bloco C.

## Testes

`npm run test:retail-responsibles` (24 checks): CRUD, targetsForTask + fallback,
cobrança a N responsáveis por tipo, findStoreByResponsible tolerante,
matchStore via responsável, baixa malote/escala + idempotência,
detectTaskConfirmation, isolamento. Regressão RetailOps verde
(`retail-closing` 16, `retail-cobranca` 10, `retail-whatsapp-closing` 21).
