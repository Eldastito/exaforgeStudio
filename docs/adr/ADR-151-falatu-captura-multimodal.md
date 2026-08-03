# ADR-151 — FalaTu: Captura Multimodal "Fala → Faz → Confere" (incorporação ao ZapFlow)

- **Status:** Núcleo FECHADO em 5 fatias. Fatia 1 MERGED (#747); Fatia 2 MERGED (#749); Fatia 3 MERGED (#750); Fatia 4 MERGED (#751); Fatia 5 MERGED (#752). **Fatia 6 (aditivo pós-fechamento — entrega do briefing por WhatsApp): este PR.**
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
| Webhook aberto | **não existe**: a Fatia 3 entrou pelo canal interno já autenticado por número (`phoneMatches`), sem webhook próprio |
| Confirm confia no cliente | confirm relê o item do banco (ver RN-151) |
| body 50mb global | payload de mídia limitado e validado na rota (`audio`/`image` base64 ≤ ~1.3MB dentro do limite global de 2mb já existente) |
| Entidades duplicadas | `UNIQUE(organization_id, user_id, entity_type, name_norm)` + upsert |
| Ids sequenciais enumeráveis | `randomUUID()` em tudo (convenção do repo) |
| Sem auditoria | `logAuthEvent` em capture/confirm/discard |
| DELETE físico | nunca DELETE: discard/cancel é UPDATE de status (convenção nº 9) |

## Plano de fatias

| Fatia | Escopo | Status |
| --- | --- | --- |
| **1** | Fundação: tabelas `falatu_*`, `FalaTuService` (capture → interpret IA → confirm/discard), rotas `/api/falatu/*` atrás de `requireMasterAdmin`, tarefas/eventos/listas/entidades/briefing, UI (aba `falatu` master-only), teste `scripts/test-falatu.ts` + CI | MERGED (#747) |
| **2** | Rollout multi-tenant: flag opt-in `organization_settings.falatu_enabled`, troca do gate pra RBAC (ADR-095), limites de uso por plano | MERGED (#749) |
| **3** | WhatsApp real: captura via canal interno existente (AIOrchestrator/Coordenador), sem webhook próprio — mensagem do gestor vira item de inbox | MERGED (#750) |
| **4** | Compras com conferência: lista planejada × nota fiscal fotografada — reusa `extractInvoiceItems` (ADR-021) e o matching vira tela de reconciliação | MERGED (#751) |
| **5** | Memória/desambiguação ativa ("qual Carlos?") + briefing diário proativo publicando em `business_signals` (ADR-136) | MERGED (#752) |
| **6** | Aditivo pós-fechamento: entrega do briefing diário por WhatsApp — consumidor dos sinais `falatu_daily_briefing`, molde `TeacherDigestService` (ADR-144) | **MERGED (este PR)** |

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

## Fatia 2 — detalhe (rollout multi-tenant)

O gate `requireMasterAdmin` da Fase 1 vira **três camadas**, cada uma reusando
uma fundação existente (nenhum mecanismo novo):

1. **Flag opt-in por org** — `organization_settings.falatu_enabled INTEGER
   DEFAULT 0` (convenção nº 10, aditivo no fim do `db.ts`). Quem liga é o
   operador no Admin Master (`POST /api/admin/organizations/:id/falatu`,
   auditado com `ADMIN_FALATU_TOGGLE`; coluna "FalaTu" na tabela de orgs). O
   enforcement mora no `falatuGate` (router-level em `routes/falatu.ts`,
   exportado pra teste): Master Admin sempre entra (mesmo racional do bypass
   do `requirePermission`); org sem flag recebe 403.
2. **RBAC granular (ADR-095)** — módulo `falatu` registrado em
   `RBAC_MODULES` + `ROUTE_MODULE` (segmento `/falatu`), então o
   `enforceModulePermission` global do `protectedApi` já gateia por perfil sem
   nada na rota. Perfis com default `none` (vendedor/atendente/estoquista/
   financeiro) começam SEM acesso; dono/gerente (default `full`) começam com;
   o parque legado sem perfil atribuído passa intacto (opt-in do RBAC, como
   nos demais módulos). O top-up idempotente do `seedSystemProfiles` leva o
   módulo aos perfis já semeados.
3. **Limite de uso por plano** — captura é ação de IA: `capture()` checa
   `PlanService.aiAllowed` (billing bloqueado + teto `ai_monthly_limit` do
   plano + top-ups/recompra automática, ADR-091 §4) ANTES da chamada de IA e,
   ao aceitar, registra no `ai_interactions_log` (`agent_used='falatu'`) —
   mesma régua do atendimento, sem contador novo (RN-004: consumo derivado
   por query). Org sem plano segue sem teto (padrão da plataforma).

**Frontend:** `/api/permissions/me` passa a devolver `falatuEnabled`; a
Sidebar mostra o FalaTu pra `isMasterAdmin || (falatuEnabled &&
canAccessModule('falatu'))` — cosmético, o servidor reforça nas 3 camadas.

**Teste** (`scripts/test-falatu-rollout.ts`): flag default off + isolamento;
gate (master bypass / 403 sem flag / passa com flag); RBAC (níveis por perfil,
legado não gateado, `checkRouteAccess`, `permissionMap`); teto do plano trava
a 3ª captura (limite 2) sem gravar inbox; org sem plano sem teto; billing
bloqueado trava; consumo não vaza entre orgs; auditoria.

## Fatia 3 — detalhe (captura via WhatsApp, canal interno)

**Sem webhook próprio** (o webhook aberto era o achado nº 4 do levantamento):
a captura entra pelo desvio do canal interno (`channel.kind='internal'`) do
`webhookProcessor`, que já autentica o colaborador pelo NÚMERO (`users.phone`
via `phoneMatches`) e já transcreve áudio antes do orquestrador (ADR-102) —
voz chega como texto de graça.

**`FalaTuWhatsAppService.handle`** roda ANTES do Controller (ADR-139) no
desvio interno, com gatilho **explícito e determinístico**:

- `anota …` / `anotar …` / `falatu …` → `FalaTuService.capture(source:
  'whatsapp')` e responde a interpretação (intenção, resumo, aviso de EVENT
  sem data — RN-151 "não invento", alerta de confiança < 0.5) + instruções.
- `confere` / `descarta` → resolvem o pendente; o pendente é **derivado do
  banco** (último `falatu_inbox_items` `source='whatsapp'` pendente do
  usuário, desempate por rowid) — nunca estado em memória: sobrevive a
  restart e não diverge do painel. Sem pendência ⇒ `handled=false` (a
  palavra pode ser de outro fluxo).
- Qualquer outra mensagem ⇒ `handled=false`: Controller (saldo/aprovações) e
  Coordenador (tarefas) seguem intactos. O gatilho explícito existe porque o
  fallback do Controller manda mensagem livre de gestor pro Diretor IA — sem
  prefixo, "anota comprar arroz" seria engolido.

**Gates** (mesmas 3 camadas da Fatia 2): org sem `falatu_enabled` ⇒ nada é
interceptado (módulo invisível); RBAC `write` no módulo `falatu` via
`PermissionService.can` sobre o usuário resolvido por número (mesmo desenho
do Controller com `financeiro`); teto de IA do plano enforçado pelo próprio
`capture()` — o reply devolve o motivo quando trava. Número desconhecido só
ganha o aviso de cadastro no gatilho explícito.

**Teste** (`scripts/test-falatu-whatsapp.ts`, 21 checks): org sem flag passa
reto; comandos do Controller/Coordenador não são interceptados; número
desconhecido; RBAC nega atendente; captura registra pendente sem
materializar; confere materializa / descarta descarta (UPDATE, nunca
DELETE); sem pendência caem no fluxo normal; EVENT sem data avisa; gatilho
vazio não gasta IA; teto do plano com motivo no reply; isolamento
multi-tenant do pendente.

## Fatia 4 — detalhe (compras com conferência)

Fecha o ciclo da lista de compras: planeja no FalaTu → compra → fotografa a
NOTA FISCAL → a reconciliação cruza planejado × comprado. Divisão de papéis
rígida: a **IA lê a nota** (`extractInvoiceItems`, ADR-021/030 — disciplina
"não invente item" e confiança por item já testadas), o **código pareia**
(matching determinístico: normalização lower/sem-acento + overlap de tokens
com prefixo, guloso 1:1 por melhor score ≥ 0.5, empate resolvido por mais
tokens casados — "leite condensado" pareia antes de "leite" roubar a linha) e
o **humano confirma** na tela.

**Tabela** `falatu_purchase_checks` (aditiva): congela `invoice_json`
(snapshot da leitura — reler a foto pode dar outra leitura) + `matching_json`
(sugestão) + status `pending|confirmed|discarded` (nunca DELETE). O efeito da
confirmação vive nos próprios `falatu_list_items` (`realized`).

**Guardrails RN-151 da fatia** (testados):

- A conferência NUNCA marca item sozinha: `check()` só registra a sugestão;
  `realized` é exclusivo do `confirm()` humano (que pode escolher um
  SUBCONJUNTO dos pareados).
- Extra da nota (fora da lista) NUNCA entra sem opt-in explícito
  (`addExtras` por índice); entrando, vira item `planned=0, realized=1` com
  quantidade da nota.
- `confirm()` relê DO BANCO; o cliente só escolhe ids/índices do que foi
  sugerido — nunca injeta item.
- Item já comprado (`realized=1`) não re-casa em conferência nova.
- Nota ilegível (0 itens) é recusada com mensagem clara, sem registro.

**Rotas** (`/api/falatu`, atrás do falatuGate + RBAC): `POST
/lists/:id/purchase-check` (foto base64, mesmo limite de mídia), `GET
/lists/:id/purchase-check` (pendente mais recente, pra UI restaurar), `POST
/purchase-checks/:id/confirm|discard`. Leitura de nota é ação de IA: mesmo
gate de plano da captura + contagem no `ai_interactions_log`.

**UI** (FalaTuView, aba Listas): botão "Conferir compra (foto da nota)" na
lista aberta → painel de reconciliação com 3 blocos (na nota = checkbox
ligado; não veio na nota; fora da lista = checkbox desligado) + alerta de
leitura com baixa confiança → Confirmar/Descartar.

**Teste** (`scripts/test-falatu-compras.ts`, 24 checks): matching puro
(acento, prefixo, guloso 1:1 com desempate por especificidade), check sem
efeito na lista, confirm por subconjunto, extra só com opt-in, re-casamento
bloqueado, discard como UPDATE, nota ilegível, teto do plano, isolamento
multi-tenant, auditoria (`FALATU_PURCHASE_CHECK/CONFIRM/DISCARD`).

## Fatia 5 — detalhe (memória com desambiguação ativa + briefing proativo)

Fecha o ADR com as duas pontas "inteligentes" do PRD original, mantendo a
divisão de papéis do módulo: **IA extrai, código decide, humano confirma**.

### Memória com desambiguação ativa ("qual Carlos?")

A captura cruza as menções extraídas (pessoas/projetos) com a memória do
usuário (`falatu_entities`) por regra de CÓDIGO — a IA nunca escolhe a quem
o nome se refere. Matching por nome normalizado (lower/sem acento, mesma
régua da Fatia 4), exato ou por prefixo de palavra ("Carlos" ↔ "Carlos
Silva"):

- **0 correspondências** → `new`: confirmação cria a entidade (como antes).
- **1 correspondência** → `known`: auto-vínculo determinístico (match único
  não é chute) — a confirmação ATUALIZA o contexto da entidade existente em
  vez de criar a duplicata "carlos".
- **2+ correspondências** → `ambiguous`: o sistema PERGUNTA. No painel, o
  ConfirmCard mostra o seletor "Qual Carlos?"; no WhatsApp, o reply lista as
  opções numeradas e o humano responde `é 1` (`é 0` = outro/novo) — a
  resposta numérica segue a regra da Fatia 3: só é interceptada com
  pendência derivada do banco E menção ambígua em aberto.

O resultado vive em `falatu_inbox_items.memory_json` (aditivo). Guardrails
RN-151 da fatia (testados): a escolha do humano é validada contra os
candidatos sugeridos (`resolveMention` — cliente não injeta vínculo
arbitrário); ambígua SEM resolução não vincula nem cria entidade na
confirmação (memória não é poluída por palpite); itens pré-F5 (sem
`memory_json`) seguem o comportamento original.

### Briefing diário proativo (`business_signals`, ADR-136)

`FalaTuBriefingTaskService.run` (sweep idempotente, rodado pelo
`Scheduler.falatuBriefingPass` e disparável por `POST
/api/falatu/signals/sweep`): pra cada usuário com dados FalaTu na org,
deriva os fatos do dia POR QUERY (RN-004) e publica UM sinal por
(usuário, dia) — `dedupe_key falatu:daily_briefing:{userId}:{date}`,
convenção nº 12 (nunca tabela própria de alerta). Dia "acionável" = inbox
pendente, compromisso de hoje ou compromisso SEM data (o que a RN-151 não
inventou e o humano precisa completar); tarefas abertas são só contexto na
evidência. Severidade: `attention` com pendência de ação humana, `info`
quando é só agenda. Sinais que deixaram de valer (dia virou, pendências
resolvidas) fecham por `resolveByDedupe` — mesmo desenho do
`ClinicRenewalTaskService` (ADR-145 F47). O sweep NUNCA cria/edita/envia
nada: só sinaliza. Gate do Scheduler: org com `falatu_enabled` (ou a org do
operador da plataforma — mesmo bypass do `falatuGate`). `GET
/api/falatu/signals` devolve só os sinais do PRÓPRIO usuário (briefing é
pessoal; não vaza entre colegas da mesma org).

**Teste** (`scripts/test-falatu-memoria.ts`, 26 checks): new/known/ambiguous
por regra de código, confirm memory-aware (contexto atualizado sem
duplicata; ambígua sem escolha não toca a memória), resolveMention com
validação de candidato + isolamento org/user + auditoria
(`FALATU_RESOLVE_MENTION`), `mentionResolutions` no confirm ("new" cria),
WhatsApp ("qual Carlos?" numerado, `é N` fora do intervalo, resolução
persistida derivada do banco, `é 1` sem pergunta pendente passa reto),
briefing (publica/deduplica/resolve, nunca materializa, isolamento
multi-tenant, lista pessoal, gate do Scheduler com bypass do operador).

## Fatia 6 — detalhe (entrega do briefing por WhatsApp) — aditivo pós-fechamento

Fecha o laço da Fatia 5: o sweep publica o briefing em `business_signals`, e
agora um CONSUMIDOR desses sinais entrega o resumo da manhã no WhatsApp do
usuário. O ledger continua sendo a fonte da verdade — o digest só lê o sinal
do dia e formata; não recomputa nem cria sinal (se o sweep não publicou, não
há o que entregar). Espelha o `TeacherDigestService` (ADR-144): texto
DETERMINÍSTICO (zero-token), janela da manhã em hora de São Paulo, dedupe por
dia, envio `send` INJETADO (testável sem rede).

**Porta de canal** (`FalaTuBriefingDigestService`): flag de org
`falatu_briefing_wa_enabled` (aditivo, convenção nº 10) — mandar mensagem
proativa é outbound, então é um opt-in SEPARADO da `falatu_enabled` (que só
liga o módulo). Default 0.

**Dedupe de entrega**: tabela best-effort `falatu_briefing_deliveries` com
`UNIQUE(organization_id, user_id, briefing_date)` (convenção nº 7/8: insert
que ignora `SQLITE_CONSTRAINT_UNIQUE`) — o FalaTu não tem tabela de perfil
como o professor (`last_agenda_date`), então o registro de "já entreguei hoje"
mora aqui. Marca SÓ após o envio (retenta no tick seguinte se falhar).

**Scheduler** (`falatuBriefingDigestPass`, roda DEPOIS do `falatuBriefingPass`
no tick — o sweep publica, o digest consome): só orgs com o opt-in de canal
e canal ativo; resolve o canal como o `teacherAgendaPass`; best-effort por-org.

**Rotas** (`/api/falatu`, atrás do falatuGate + RBAC): `GET|POST
/briefing/whatsapp` (lê/liga a porta) + `POST /briefing/whatsapp/send-now`
("enviar meu resumo agora" — ignora janela/dedupe, respeita a porta, só pro
próprio usuário). **UI** (aba Briefing): switch "Resumo diário no WhatsApp" +
botão "Enviar agora".

**Guardrails**: o digest NUNCA cria/edita tarefa, evento, lista ou entidade
(só lê o sinal e envia); isolado por org+user; a entrega de uma org não
alcança usuário de outra. Refino futuro: opt-in por-usuário (hoje a porta é
da org — todos os usuários do FalaTu com telefone e sinal do dia recebem).

**Teste** (`scripts/test-falatu-briefing-digest.ts`, 14 checks): porta
desligada não entrega; fora da janela SP não entrega; entrega só a quem tem
sinal + telefone; texto determinístico (inbox/agenda/sem-data) a partir da
evidência; dedupe por (org, usuário, dia); digest nunca materializa; send-now
ignora janela/dedupe mas respeita a porta e a existência de briefing;
isolamento multi-tenant.
