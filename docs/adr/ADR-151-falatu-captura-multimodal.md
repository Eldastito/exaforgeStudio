# ADR-151 — FalaTu: Captura Multimodal "Fala → Faz → Confere" (incorporação ao ZapFlow)

- **Status:** Fatia 1 em implementação (fundação + inbox + confirmação + UI, exclusivo Master Admin).
- **Data:** 2026-08-03
- **Origem:** repositório `Eldastito/FalaTu` (protótipo AI Studio applet) — levantamento completo na seção "Levantamento do repositório de origem".
- **Relacionadas:** ADR-136 (Decision-Action Ledger — briefing proativo futuro), ADR-095 (RBAC — rollout multi-tenant futuro), ADR-021/ADR-030 (leitura de nota fiscal por IA — reuso direto na conferência de compras), ADR-102 (tarefa por voz do gestor — mesmo princípio de confirmação antes de criar).

## Contexto

O FalaTu é um protótipo de assistente multimodal ("caixa de entrada mental"):
o usuário fala, digita ou fotografa; a IA transcreve, resume, detecta a
intenção (tarefa/compromisso/lista/nota) e sugere uma ação; **nada é criado
sem confirmação humana** (ciclo "Fala → Faz → Confere"). O protótipo foi
gerado no Google AI Studio com stack própria (React 19 + Express + Drizzle/
PostgreSQL + Firebase Auth + Gemini) e o dono da plataforma quer o produto
DENTRO do ZapFlow — começando restrito ao **Master Admin** (operador da
plataforma, `requireMasterAdmin`), antes de qualquer rollout para clientes.

## Levantamento do repositório de origem (`Eldastito/FalaTu`)

### Estrutura

~30 arquivos, monólito pequeno e legível:

- `server.ts` (414 linhas) — TODAS as rotas Express num arquivo só (sem camada
  de service; handlers chamam helpers de DB direto).
- `src/db/` — Drizzle ORM sobre PostgreSQL: `users`, `tasks`, `events`,
  `lists`, `list_items`, `entities`, `inbox_items`. Helpers por tabela
  (`tasks.ts`, `lists.ts`…). `drizzle.config.ts` presente, **nenhuma migração
  commitada** (schema push manual).
- `src/middleware/auth.ts` — Bearer token do Firebase Auth verificado via
  `firebase-admin` (correto).
- `src/App.tsx` (684 linhas) + 5 componentes de view (Tasks/Events/Lists/
  Memory/Briefing) — mobile-first, bottom nav, gravação via MediaRecorder.
- `docs/PRD-FALA-TU.md` + `docs/IMPLEMENTATION-PLAN.md` + `AGENTS.md` — PRD
  claro, plano em 7 marcos, instruções permanentes pra agentes de IA.

### Desenvolvimento

- **3 commits, todos no mesmo dia (2026-07-20)**, autor único. Marcos 1–7
  inteiros entraram num único commit ("feat: implement core backend and UI
  features") — não há histórico incremental, não há PRs, não há branches além
  de `main`, não há tags/releases.
- Sem testes de qualquer tipo. `npm run lint` = só `tsc --noEmit`. **Sem CI**
  (nenhum workflow), sem lint de estilo, sem hooks.
- Duplicação literal: o system prompt da extração aparece 2× em `server.ts`
  (rota webapp e webhook), já divergindo em um campo.

### Governança

- Pontos positivos: PRD e plano de implementação bem escritos; `AGENTS.md`
  fixa princípios corretos (human-in-the-loop, sem mock em produção, chave de
  API nunca no cliente).
- Lacunas: sem LICENSE, sem README, sem CONTRIBUTING, sem proteção de branch,
  sem processo de review (commits diretos na main), sem registro de decisões
  (o equivalente a ADRs). O plano marca marcos como "Concluído" sem critérios
  de aceite verificáveis (não há teste que prove).

### Segurança (achados concretos)

1. **IDOR em tarefas** — `toggleTaskCompletion(taskId, userId, completed)`
   recebe `userId` mas o UPDATE filtra **só** `tasks.id`: qualquer usuário
   autenticado alterna tarefa de qualquer outro.
2. **IDOR em listas** — `getListItems`/`createListItem`/
   `toggleListItemRealized` nunca verificam dono da lista: leitura e escrita
   cross-usuário por id sequencial (serial → enumerável).
3. **IDOR em inbox** — `/api/action/confirm` atualiza
   `inbox_items.status='CONFIRMED'` filtrando só o `id` recebido do cliente.
4. **Webhook aberto** — `/api/webhook/whatsapp` sem autenticação nem
   verificação de assinatura (Twilio/Meta HMAC); associa a mensagem ao
   "primeiro usuário do banco"; em erro, vaza `stack` na resposta.
5. **Confirmação confia no cliente** — `/api/action/confirm` aceita
   `intent`/`entities`/`summary` do body em vez de reler o item processado no
   servidor: o cliente pode "confirmar" qualquer coisa que a IA nunca sugeriu.
6. **`express.json({ limit: "50mb" })`** global — vetor de DoS barato.
7. **Sem rate limit, sem helmet/headers, sem validação de schema** nos bodies;
   `JSON.parse` da resposta do LLM sem fallback (500 em JSON malformado).
8. **OAuth super-escopado** — o login Google pede 13 escopos de Drive
   (incluindo `drive` completo e `drive.scripts`) para uma feature que só lê
   um arquivo; token de acesso fica cacheado em variável de módulo no cliente.
9. `drizzle.config.ts` com `ssl: false`; credenciais admin do banco via env
   distintas das de runtime (ok), mas sem migração versionada.
10. Sem isolamento multi-tenant (modelo single-user por design) — incompatível
    como está com a convenção nº 1 do ZapFlow.

### Pontos de melhoria (no produto, além dos de segurança)

- Data/hora de compromisso é **inventada** (`new Date()` = hoje) quando o
  texto não traz data — viola o próprio princípio "não invente" do PRD.
- Entidades duplicam a cada confirmação (sem chave única nem dedup).
- Briefing não filtra "hoje" nem listas ativas (comentários `// in a real app`
  no código).
- Retry de LLM só para 503; sem timeout; sem medição de custo/token.
- Modelo `gemini-3.5-flash` fixo no código (2 ocorrências divergentes).

## Decisão de arquitetura

**Reimplementar como módulo nativo (`falatu_*`), não importar código.** As
stacks são incompatíveis (Drizzle/PG/Firebase/Gemini vs better-sqlite3/JWT/
OpenAI) e o valor do FalaTu está no **produto** (PRD + fluxo de confirmação),
não nas ~1.400 linhas de protótipo. A incorporação reusa as fundações da
plataforma:

1. **IA**: camada única `llm.ts` (`chat` JSON + `transcribeAudio` Whisper +
   `extractStructuredFromImage`) — ganha de graça medição de custo por org
   (`ai_usage_log`), modelo configurável por env e disciplina "nunca invente"
   já testada nos prompts de visão (ADR-019/021/030/083).
2. **Auth/gate**: rota `/api/falatu/*` montada no `protectedApi` atrás de
   `requireMasterAdmin` — mesmo padrão de `/api/admin`, `/api/audit` e
   `/api/radar-consultant`. Nenhuma flag de módulo nesta fase: o gate é o
   e-mail do operador da plataforma.
3. **Dados**: tabelas `falatu_*` com `organization_id` + `user_id` em TODAS as
   linhas e em TODOS os filtros (convenção nº 1), mesmo com um único usuário
   hoje — o rollout multi-tenant (Fatia 2) vira só a troca do gate.
4. **UI**: aba `falatu` no app autenticado, item de Sidebar visível só com
   `isMasterAdmin` (cosmético; segurança real é o middleware — mesmo padrão
   do AdminMasterView/RadarConsultantView).

### Guardrails RN-151 (duros, testados)

A IA do FalaTu **nunca**:

- Cria tarefa/evento/lista sem confirmação humana explícita (`confirm` é uma
  ação separada do `capture`; o teste prova que nada materializa antes).
- Inventa data/hora de compromisso — sem data no texto ⇒ campo `null` e o
  humano preenche na confirmação (corrige o bug "hoje por padrão" da origem).
- Inventa itens de lista que não estão na entrada.
- É confirmada com payload do cliente: o `confirm` relê **do banco** o que a
  IA extraiu; o cliente só pode sobrepor campos explicitamente editáveis
  (título, data, hora, itens) — nunca o vínculo dono/organização.
- `confidence` obrigatório na extração; a UI usa pra pedir mais atenção.

### Correções de segurança em relação à origem

| Achado na origem | Aqui |
| --- | --- |
| IDOR tarefa/lista/inbox | toda query filtra `organization_id` + `user_id`; itens de lista validam dono via JOIN |
| Webhook aberto | **não existe** nesta fase (WhatsApp real virá pela infra de canais própria, Fatia 3) |
| Confirm confia no cliente | confirm relê o item do banco (ver RN-151) |
| body 50mb global | payload de mídia limitado e validado na rota (`audio`/`image` base64 ≤ ~1.3MB dentro do limite global de 2mb já existente) |
| Entidades duplicadas | `UNIQUE(organization_id, user_id, entity_type, name_norm)` + upsert |
| Ids sequenciais enumeráveis | `randomUUID()` em tudo (convenção do repo) |
| Sem auditoria | `logAuthEvent` em capture/confirm/discard |
| DELETE físico | nunca DELETE: discard/cancel é UPDATE de status (convenção nº 9) |

## Plano de fatias

| Fatia | Escopo | Status |
| --- | --- | --- |
| **1** | Fundação: tabelas `falatu_*`, `FalaTuService` (capture → interpret IA → confirm/discard), rotas `/api/falatu/*` atrás de `requireMasterAdmin`, tarefas/eventos/listas/entidades/briefing, UI (aba `falatu` master-only), teste `scripts/test-falatu.ts` + CI | **MERGED (este PR)** |
| 2 | Rollout multi-tenant: flag opt-in `organization_settings.falatu_enabled`, troca do gate pra RBAC (ADR-095), limites de uso por plano | planejada |
| 3 | WhatsApp real: captura via canal interno existente (AIOrchestrator/Coordenador), sem webhook próprio — mensagem do gestor vira item de inbox | planejada |
| 4 | Compras com conferência: lista planejada × nota fiscal fotografada — reusa `extractInvoiceItems` (ADR-021) e o matching vira tela de reconciliação | planejada |
| 5 | Memória/desambiguação ativa ("qual Carlos?") + briefing diário proativo publicando em `business_signals` (ADR-136) | planejada |

## Fatia 1 — detalhe

**Tabelas** (aditivas, fim do `db.ts`): `falatu_inbox_items` (conteúdo,
transcrição, resumo, intenção, entidades JSON, sugestão, confiança, status
`pending|confirmed|discarded`, vínculo com o que foi criado),
`falatu_tasks`, `falatu_events`, `falatu_lists`, `falatu_list_items`,
`falatu_entities` (com unique de dedup).

**Service** (`FalaTuService.ts`): `interpret()` isola a chamada de IA
(mockável em teste, mesmo padrão do `TaskAudioService.extractTaskFromText`);
`capture` / `listInbox` / `confirm` / `discard` / `tasks` / `toggleTask` /
`events` / `lists` / `listItems` / `toggleListItem` / `entities` /
`briefing`. `orgId` sempre 1º argumento.

**Rotas** (`routes/falatu.ts`): validação de forma na rota, invariantes no
service (convenção do repo). Montagem:
`protectedApi.use("/falatu", requireMasterAdmin, falatuRoutes)`.

**Teste** (`scripts/test-falatu.ts`): tmpDir isolado, `check()` helper, IA
mockada (sem chave OpenAI), cobre: captura texto/áudio/imagem, nada criado
antes do confirm, confirm de TASK/EVENT/LIST, RN de data não inventada,
override do humano na confirmação, discard, dedup de entidades, toggle com
dono errado falha, briefing, isolamento multi-tenant e auditoria.
