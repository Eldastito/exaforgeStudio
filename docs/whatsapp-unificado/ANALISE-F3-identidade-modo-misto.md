# F3.0 — Auditoria de Identidade, Autorização e Modo Misto (RF-04/05/06)

> Abertura da **Fase 3** do PRD WhatsApp Unificado / Fala Tu, no mesmo espírito
> da F0: **revalidar o que existe antes de mexer**. Doc-only. Todas as
> referências são `arquivo:linha` no HEAD.

## Método

Varredura read-only focada em 8 perguntas: resolução remetente→usuário; o
conceito `authorized_managers`; a decisão interno×atendimento; o enum
`channels.kind`; o caminho do Diretor sem projeção por usuário (INV-11/X5);
mecanismos reusáveis de prova de posse; estado de confirmação/pendência
(RF-06/CA-06); e testes existentes.

---

## Achados

### 1. NÃO existe resolvedor único remetente→usuário

O inbound (`webhookProcessor.ts:91`) resolve **organização + contato**, não
usuário. Org vem do **canal** que casa `identifier + provider`
(`webhookProcessor.ts:117-118`) — nunca do remetente; fallback single-tenant
(`:136-144`), senão descarta (`:142`). O remetente vira **contato** (CRM), não
usuário: `contacts` por `identifier` (`db.ts:43`, UNIQUE `db.ts:47`),
auto-criado (`webhookProcessor.ts:250-256`), **sem normalização** aqui (match
exato do `senderId`).

Coexistem **dois conceitos de identidade não relacionados**:
- `authorized_managers.identifier` — usado pelo AI orchestrator.
- `users.phone` — usado por Coordenador/Controller/FalaTu, cada serviço
  re-consultando: `GestorCommandService.resolveUser` (`:53-56`),
  `CoordenadorService.resolveUser` (`:23-27`), `FalaTuWhatsAppService` reusa o
  do Gestor (`:108`).

Normalização vive em `phoneMatch.ts`: `onlyDigits` (`:21`), `stripCountry` DDI 55
(`:27-30`), `phoneMatches` com tolerância a DDI + 9º dígito BR (`:48-74`).
`users.phone` é aditivo (`db.ts:482`). `IdentityResolutionService` existe mas
resolve **contatos** (fluxo reputação), fora do hot path do webhook.

### 2. `authorized_managers` = só filiação, SEM RBAC

Schema `db.ts:218-224`: `(organization_id, identifier, name)` — **sem coluna de
papel/permissão/user_id**. Reconhecimento em
`AIOrchestratorService.findAuthorizedManager` (`:917-930`), chamado em `:51`
(`isManager = !!manager`). Concede (só por presença do telefone, sem gate por
módulo): orquestrador "zap…" read-only (`:61-62`), intake de estoque por foto
(`:71-74`), confirmação de pendências (`:80-105`), pedido de compra por voz/texto
(`:111-113`), tarefa por voz (`:117+`). Contraste: `GestorCommandService`
verifica `PermissionService.can(...,"financeiro","read")` (`:84`) e papel
(`:88-89`). **`authorized_managers` é tudo-ou-nada por telefone.**

### 3. Interno × atendimento = `channel.kind === 'internal'` (dois caminhos)

**Caminho interno/gestão** — `webhookProcessor.ts:171` (`if kind==='internal'`):
roteia pros handlers internos e **retorna cedo, ANTES de criar contato/ticket**:
FalaTu capture (`:178`, return `:181`), Solo `trigger_only` (`:196-197`),
Controller `GestorCommandService.handle` (`:205`; `pergunta_negocio` →
`ExecutiveAdvisorService.ask` `:214`; senão `g.reply` `:218`), Coordenador
(`:225`, return `:229`).

**Caminho atendimento** (`kind` ≠ 'internal', default `'client'`): cai após
`:230` e **cria os registros de cliente**: contato (`:247-256`), ticket
(`:270-281`, `'novo_lead'`), mensagem (`:291-294`), CRM touch/score (`:297,302`),
depois `AIOrchestratorService.processMessage` (`:516`).

**Gestor no canal de atendimento = caminho DIFERENTE (read-only):** mesmo em
`'client'`, `processMessage` re-checa `findAuthorizedManager` (`:51`); "zap"
(`:61-62`) força resposta **read-only** (guarda `:407-441`, `actions:[]`).
Porém, ao chegar em `:516`, **um contato + ticket + mensagem já foram criados
para o gestor** (`:247-294`) — o gestor também é persistido como cliente no
canal de atendimento.

### 4. `channels.kind` só tem `'internal'` | `'client'`

Migração `db.ts:4008` (`DEFAULT 'client'`; base `db.ts:22-36` não tinha `kind`).
`'internal'` escrito por `FalaTuSoloWhatsAppService.ts:115-116`; `'client'` é o
default (webhook cria sem `kind`, `:150-153`). **Não existe `'mixed'`/`'ambos'`.**
Lido em `webhookProcessor.ts:171`, `TaskAudioService.ts:101`,
`ChannelBindingMigrationService.ts:49,65`.

> Consequência de projeto (RF-04 §10): o modo misto **não** deve ser só um
> `kind='mixed'` novo no enum; consumidores antigos (que leem `internal`/`client`)
> precisam seguir recebendo o contrato esperado. Usos "Atendimento/Gestão/Ambos"
> são derivados — e a RF-03 (F2.2, `channel_feature_bindings`) já é o lugar da
> finalidade por canal.

### 5. 🚩 Diretor sem projeção por usuário — CA-04 aberto (INV-11 / X5)

`ExecutiveAdvisorService.ask(orgId, question)` (`:292`) recebe **só orgId +
pergunta — sem usuário, sem papel, sem filtro**. O chamador
`FalaTuAskService.ts:325` passa só `(orgId, q)`, **descartando** o `user` que
`answer(orgId, user, question)` (`:298`) recebeu. O gate de dinheiro
`canSeeMoney` (`:307`) só dispara quando `cls.needsMoney` é true, mas pergunta
aberta é classificada `needsMoney:false` (`:203`) → **pergunta aberta pula o gate
e alcança o panorama completo**. Segundo chamador: `webhookProcessor.ts:214`
(`pergunta_negocio`), **sem checagem de papel**.

`buildPanorama` (`:42-45`) inclui `executiveBlock` (saúde do pilar Financeiro +
indicadores, `:84-93`; pior pilar + restrição nº1, `:95-98`; visão do dono,
`:100`) e `goalsBlock` (metas de receita em R$, `:53-63`). **Sem filtro por
usuário dentro de `ask()`/`buildPanorama()`.**

> **Este é o alvo nº1 da F3.1** e o item que o Gate G3 marca como bloqueador de
> rollout ("falha de autorização bloqueia rollout"). Um usuário de baixo
> privilégio reconhecido por telefone (ex.: `agent` com `falatu:read`) extrai
> financeiro org-wide por pergunta livre.

### 6. Prova de posse já existe (reusável para RF-04)

- **`falatu_protocols` + `FalaTuProtocolService`** (o análogo mais próximo):
  `phone_e164`, `phone_verified_at`, `verify_code_hash`, `verify_expires_at`,
  `verify_attempts` (`db.ts:8050-8067`). Código de 6 dígitos `randomInt`
  (`:182`), `sha256` (`:184`), `timingSafeEqual` (`:68,201`), TTL (`:199`), cap 5
  tentativas, limpa ao verificar (`:205`); telefone não-verificado não age
  (`:198,235,247,328`). **Molde pronto de prova de posse.**
- `FalaTuCaptureTokenService` (token longevo hash sha256, plaintext 1×,
  `verify()→{orgId,userId}`).
- `user_invitations` (`db.ts:394-405`, token_hash/status/expires_at) — convite
  reusável (RF-04 "convites existentes").
- `user_stores` (`db.ts:9755-9764`) — vínculo usuário↔recurso.
- `ChannelBindingService`/`ChannelBindingMigrationService` — camada de finalidade
  por canal (F2.2/F2.3), lar natural de futuros vínculos de finalidade.

### 7. Confirmação/pendência: durável no essencial, in-memory na desambiguação

**Durável, por-org (sobrevive a restart):**
- `pending_manager_actions` (`PendingManagerActions.ts`): 1 pendente por
  `(org, identifier)`, `expires_at=now+1h` (`:20-22`); resolvido em
  `AIOrchestratorService.ts:80-105` (sim `:90` / não `:91`).
- FalaTu capture ("confere"/"é N") — **derivado do DB** (`falatu_inbox_items`,
  `FalaTuWhatsAppService.pendingItem:72-78`; comentário "nunca de estado em
  memória: sobrevive a restart" `:22-26`).
- `ConfirmationEngine` (`action_confirmations`, UNIQUE por `(org,action)`).
- Aprovações governadas → `decision_actions` (`FalaTuAskService.ts:351-359`).

**🚩 In-memory / process-global (PERDE no restart) — gap CA-06:**
- `GestorCommandService.lastActions = new Map()` (`:33`) — a lista numerada
  ("aprovar 2") é módulo-global.
- `CoordenadorService.lastList = Map` (`:74,88`, chave `${orgId}:${user.id}`) — o
  "concluir 2" é in-memory; restart perde a referência de "2".

> A desambiguação numerada (a que o CA-06 exige "não confirmar a ação errada")
> é justamente a parte volátil. Alvo da F3.4.

### 8. Testes existentes (base de regressão)

`test:security-tenant`, `test:security-webhook`, `test:ai-orchestrator`
(insere `authorized_managers` `scripts/...:155`), `test:gestor-command`,
`test:falatu-whatsapp`, `test:falatu-ask-whatsapp`, `test:falatu-solo-whatsapp`,
`test:falatu-ask`, `test:falatu-trigger-only`, `test:falatu-approve-whatsapp`,
`test:falatu-capture-token`, `test:falatu-protocols` (verificação de telefone),
`test:security-money-gating` / `test:security-money-routes` /
`test:security-ai-fence` (relevantes ao CA-04).

---

## Flags de segurança (CA-04) — ordem de risco

1. **Bypass do gate de dinheiro no panorama executivo (INV-11/X5)** —
   `FalaTuAskService.ts:325` + `ExecutiveAdvisorService.ask:292`. Pergunta aberta
   `needsMoney:false` (`:203`) nunca aciona `canSeeMoney` (`:307`); `ask()` sem
   usuário; `buildPanorama` inclui financeiro (`:84-100`) e metas (`:53-63`).
   Mesma exposição por `webhookProcessor.ts:214`.
2. **`authorized_managers` sem RBAC** — `AIOrchestratorService.ts:51,919`.
   Presença do telefone = superfície de gestão inteira sem gate por módulo.
3. **Match de telefone tolerante amplia a fronteira de confiança** —
   `phoneMatch.ts:55-58` (últimos N dígitos + 9º dígito). Aplicado a
   `authorized_managers` (`:923-929`) e `users.phone`
   (`GestorCommandService.ts:55`, `CoordenadorService.ts:27`).
4. **Rejeição correta de desconhecido no canal interno** —
   `CoordenadorService.ts:61-64`, `FalaTuWhatsAppService.ts:109-115` (retornam
   "não reconheço este número", sem tocar dado interno). Sinal menor de
   enumeração.
5. **Gestor no canal de atendimento ainda vira contato/ticket** —
   `webhookProcessor.ts:247-294` roda antes do check de gestor (`:51`).

---

## Recorte proposto da Fase 3 (fatia-por-PR, aditivo/reversível)

| Fatia | Escopo | Por quê primeiro |
|---|---|---|
| **F3.0** | Esta auditoria (doc-only) | Revalidar antes de mexer (mandato do PRD) |
| **F3.1a** | **Projeção por usuário no Diretor (CA-04)** — `ExecutiveAdvisorService.ask` passa a aceitar o usuário resolvido e o panorama redige financeiro/metas conforme a permissão real (reusa `PermissionService`/`canSeeMoney`); `FalaTuAskService` e `webhookProcessor` param de descartar o usuário. 0-regressão para owner/admin. | Fecha o buraco nº1 do Gate G3 (bloqueador de rollout). Contido e testável. |
| **F3.1b** | Resolução comum de identidade (fachada `resolveSender`) conciliando `authorized_managers` × `users.phone` sem elevar privilégio; vínculo legado registra confiança, ambíguo fica pendente | Fundação para F3.2/F3.3; sem virar admin todo gestor legado |
| **F3.2** | Prova de posse no cadastro novo (reusa `FalaTuProtocolService`/convites) + preserva aliases | RF-04 vínculo verificado |
| **F3.3** | Modo misto: ordem de processamento §10 (roteia antes do CRM; papéis duplos pedem escolha; uma resposta por entrada) | CA-04/§10 |
| **F3.4** | Confirmação durável da desambiguação numerada (tira `lastActions`/`lastList` da memória) + expiração + mensagem própria | CA-06 gap in-memory |

**Recomendação:** começar por **F3.1a** — é o item que o Gate G3 nomeia como
bloqueador de rollout, é pequeno, e tem regressão pronta
(`test:security-money-gating`/`falatu-ask`).
