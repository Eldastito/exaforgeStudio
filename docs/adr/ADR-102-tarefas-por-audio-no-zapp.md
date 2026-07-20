# ADR-102 — Tarefas por áudio/texto no Zapp (gestor)

**Status:** Aprovado (Fase 1 em implementação).

**Origem:** Item #15 do `docs/BACKLOG-CAMPO-TOULON.md`. O dono/gerente autorizado
no modo Zapp (WhatsApp de gestão) manda um áudio — "agenda tarefa X pra Fulano
até sexta" — e a IA cria a tarefa, atribui e cobra o responsável.

---

## Contexto

O padrão já existe no código: o **pedido de compra por áudio** (ADR-099) faz
exatamente esse arco — áudio transcrito → extração via LLM → casamento fuzzy →
confirmação SIM/NÃO → cria rascunho. Tarefas por áudio é o espelho disso.

O que já está pronto e é reaproveitado inteiro:
- **Transcrição:** `transcribeAudio` roda no webhook do Evolution **antes** do
  orquestrador — um áudio do gestor já chega como texto ao `processMessage`.
- **Gestor reconhecido no Zapp:** `authorized_managers` + gatilho "Zapp".
- **Máquina de confirmação:** `savePendingAction`/`executePendingAction` +
  `CONFIRM_TYPES` (SIM/NÃO), compartilhada com compra e campanha.
- **CRUD de tarefa:** `TaskService.create` (todos os campos + notificação in-app
  de atribuição já embutida).
- **Envio WhatsApp:** `MessageProviderService.sendMessage(channelId, to, texto)`
  + canal interno (`channels.kind='internal'`).

## Decisão

### 1. Tamanho do bloco — Fase 1 = criar + atribuir + cobrar

- **Fase 1 (este ADR):** o gestor dita e a IA **cria** a tarefa, **atribui** a um
  colaborador e **cobra** o responsável por WhatsApp. Editar/confirmar/excluir por
  áudio ficam para a **Fase 2** (bloco menor depois) — o fluxo conversacional de
  edição é sensível e merece PR próprio.

### 2. Cobrança proativa por WhatsApp — com degradê seguro

- Ao criar com responsável, dispara um WhatsApp proativo ao colaborador pelo
  **canal interno** da org (o mesmo do Coordenador IA), usando `users.phone`.
- **Fallback:** se o responsável não tem telefone cadastrado **ou** a org não tem
  canal interno, cai só na **notificação in-app** (que o `TaskService` já emite).
  Nunca falha o fluxo por causa da cobrança.
- Escopo: o ping por WhatsApp é disparado **só pelo fluxo de áudio** (não muda o
  comportamento de tarefas criadas no painel — essas seguem só com in-app).

### 3. Nome não encontrado — nunca chuta responsável

- "pra Fulano" é casado por **fuzzy match** contra `users.name`.
- Match único e claro → atribui. **Ambíguo (dois nomes próximos) ou sem match →
  cria a tarefa SEM responsável** e avisa na confirmação ("não achei 'Fulano' —
  criei sem responsável; atribua na aba Tarefas"). Nunca atribui ao colaborador
  errado.

### 4. Nada é criado sem confirmação

Espelha a compra: o gestor recebe a tarefa montada (título, responsável, prazo,
prioridade) e responde **SIM** para criar ou **NÃO** para cancelar
(`CONFIRM_TYPES += "task_create_audio"`). Extração com `isTask=false` (conversa
que não é tarefa) não dispara nada — segue o fluxo normal do orquestrador.

## Consequências

**Positivas:** o gestor delega tarefas na velocidade da fala, sem abrir o painel;
o responsável é cobrado no canal que ele já usa. Reaproveita 90% do arco do
ADR-099 — risco baixo.

**Trade-offs:**
- Extração e resolução de prazo dependem do LLM; mitigado por confirmação
  obrigatória (o gestor vê e aprova antes de criar).
- Fuzzy de nome pode não achar em equipe com nomes parecidos; mitigado por
  "sem responsável + aviso" em vez de chute.
- A cobrança por WhatsApp exige canal interno configurado; sem ele, degradê para
  in-app (não quebra).

## Implementação (Fase 1)

1. **`TaskAudioService`**: `extractTaskFromText` (LLM → `{isTask, title,
   assignee, dueAt, priority}`), `matchAssignee` (fuzzy vs `users.name`, nulo se
   ambíguo), `pingAssignee` (WhatsApp pelo canal interno, com fallback).
2. **`AIOrchestratorService`**: intent de tarefa (regex `tarefa|delega`) →
   `handleTaskOrderIntent` (monta + salva pendência `task_create_audio`);
   `task_create_audio` em `CONFIRM_TYPES`; branch em `executePendingAction`
   (cria via `TaskService.create` source=`ia` + `pingAssignee`).
3. **Teste** `test:task-audio-intent`: extração vira tarefa, fuzzy de nome,
   ambíguo → sem responsável, confirmação cria a tarefa, não-tarefa não dispara.

**Fase 2 (depois):** editar/mover/cancelar tarefa por áudio (intents mapeando
para `TaskService.update`/`move`, status `cancelada` já existe).

## Aprovação

Aprovado por Emerson (jul/26): Fase 1 = criar + atribuir + cobrar por WhatsApp
(com fallback in-app); nome não encontrado vira tarefa sem responsável + aviso;
nada sem confirmação. Editar/excluir por áudio = Fase 2. Item #15 do backlog.
