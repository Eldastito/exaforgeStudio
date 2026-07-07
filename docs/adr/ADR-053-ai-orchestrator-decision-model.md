# ADR-053 — AIOrchestratorService: modelo de decisão e guards pré-LLM

**Status:** Implementado.

**Origem:** Fase 2B do plano de produção — o levantamento apontou o `AIOrchestratorService` como incompleto: 1187 linhas, cérebro do atendimento por IA, sem uma única linha de teste automatizado. Um bug de roteamento aqui é o pior tipo de falha de SaaS de IA: OU a IA responde no lugar do humano quando deveria transferir (dano de relacionamento), OU obedece a uma injeção de prompt e vaza system prompt/metadados (dano de confiança), OU um cliente comum consegue disparar comandos privilegiados de gestor (dano de segurança).

---

## Contexto

O `AIOrchestratorService.processMessage` é a porta única por onde toda mensagem de WhatsApp/Instagram passa antes de decidir o que fazer. A cada mensagem recebida, o serviço precisa responder três perguntas ANTES de chamar a LLM:

1. **Quem está mandando?** — cliente comum, gestor autorizado, ou uma tentativa de se passar por um.
2. **Que agente aplicar?** — atendimento ao cliente (customer-facing) ou orquestrador (canal admin, read-mostly, disparo de campanha com confirmação).
3. **Devo chamar a LLM?** — ou existe um guard (injeção, limite diário, plano bloqueado, ação pendente) que já decide sozinho.

Errar QUALQUER uma dessas três é destrutivo — e é justamente o que a IA sozinha não protege. A LLM não conhece o modelo de negócio: ela obedece o prompt e devolve o texto. O trabalho do orquestrador é filtrar o que chega ANTES da LLM ver e sanear o que sai DEPOIS.

## Decisão (modelo de decisão do orquestrador)

**Guards pré-LLM invioláveis (em ordem):**

1. **Match tolerante do gestor** — `findAuthorizedManager(senderId, orgId)` procura o número exato em `authorized_managers`; se não achar, tenta variantes brasileiras (9º dígito opcional). Isolamento por org sempre garantido (query com `organization_id = ?`).
2. **Anti-recon do canal admin** — só ativa o Orquestrador se o remetente É gestor E a mensagem começa com "zap" (tolerante: Zap, Zapp, Zapflow…). Se um cliente comum manda "zap oi", NÃO revelamos que o canal admin existe: a mensagem é tratada como atendimento normal.
3. **Foto de gestor → cadastro de estoque** — gestor + `imageBase64` roteia direto para `WhatsAppInventoryIntake.handlePhoto` (não precisa do prefixo "zap"). Uma foto nova sempre reinicia o cadastro (substitui pendências anteriores do mesmo gestor).
4. **Fluxo de confirmação de ação pendente** — gestor com `pending_manager_actions` recebe resposta interpretada como confirmação:
   - `sim/confirmo/pode/ok/isso/👍` → executa a ação (ex.: dispara campanha).
   - `não/cancela/para/deixa` → cancela e limpa a pendência.
   - Ambíguo → NÃO executa nada, pede confirmação explícita ("responda SIM ou NÃO").
5. **Bloqueio de prompt injection no canal do gestor** — se `isOrchestratorCommand` E `isPromptInjection(text)` → resposta genérica e log com `BLOCKED (prompt_injection):`. Nunca executa. A heurística cobre PT-BR + EN: "ignore todas as instruções", "esqueça o que disse", "system:", "you are now", "jailbreak", "DAN", "DROP TABLE", "delete from", etc.
6. **Limite diário opt-in (`AI_DAILY_LIMIT`)** — se a env estiver definida (>0) e o log do dia atingiu o limite, o orquestrador transfere para humano com resposta educada ("volume alto de atendimentos automáticos"). Sem a env: comportamento ilimitado (compatível com produção sem essa variável).
7. **Plano bloqueado/cancelado ou limite mensal** — `PlanService.aiAllowed(orgId)` bloqueia se `status IN ('blocked','cancelled')` OR `billing_status IN ('blocked','cancelled','suspended')` OR o limite mensal do plano foi excedido. Bloqueio significa **transferir para humano com mensagem educada**, nunca cortar sem aviso.

**Sanitizers pós-LLM invioláveis:**

A LLM devolve JSON com "actions", "new_appointment", "customer_email", "reservation_request" etc. NENHUM desses campos vai direto pra execução — todos passam por sanitizer:

- `sanitizeActions` — whitelist de tipos (hoje só `MOVE_TICKET`) + whitelist de stages do Kanban (11 valores). Qualquer outra ação vira `[]`. Isso significa: mesmo que a LLM alucine "DELETE_ORGANIZATION", ela nunca chega ao banco.
- `sanitizeAppointment` — título obrigatório (max 200 chars), data parseada como ISO válida (garbage rejeitado silenciosamente).
- `sanitizeEmail` — normaliza minúsculas, valida com regex conservador `[^\s@]+@[^\s@]+\.[^\s@]+`, rejeita > 254 chars.
- `sanitizeReservation` — resource obrigatório, `start < end` obrigatório, `units` clamp 1-99, adults/children clamp 0-99. `end <= start` → toda a reserva é descartada.
- `sanitizeDelivery` — endereço obrigatório (max 300).
- `clampStr` — todo campo textual passa por trim + max length. Nunca deixa a LLM injetar 100KB no banco.

**Regra geral**: o orquestrador **prefere descartar dado suspeito a falhar loud**. Se a IA sugere uma reserva com `end < start`, o resultado é `undefined` (nada é criado) — não 500. Isso protege a UX quando a IA erra sem gerar suporte.

## Consequências

**Positivas:**
- **59 verificações automatizadas** cobrindo os 7 guards + os 7 sanitizers + o match tolerante de gestor + isolamento por org.
- Não chama a LLM real → CI barato, previsível, roda em segundos.
- Regressão automatizada em CI: se alguém tirar a checagem de prompt injection, o whitelist de MOVE_TICKET, o clamp de units — o teste vira vermelho.
- Documenta o contrato explicitamente. Contribuintes futuros que quiserem adicionar novo tipo de ação sabem exatamente onde ampliar o whitelist.

**Trade-offs aceitos:**
- **Não cobre o loop full LLM.** Não há mock de OpenAI/Gemini aqui — assumimos que o llm.ts é OK (testado em outro escopo) e focamos no que decide antes/depois. Cobrir o loop LLM completo pediria fixtures grandes e teste flakey — não vale o custo.
- **Heurística de prompt injection é keyword-based** (não semântica). Detecta variações comuns em PT/EN mas não pega ataques criativos. É um filtro de primeira linha; a defesa profunda é o whitelist rígido de ações + o sandboxing do que a LLM pode alterar.
- **Ordem dos guards importa.** Prompt injection só bloqueia no canal do gestor — no canal de atendimento normal, tentativas de manipular o prompt viram texto normal para a LLM lidar. Isso é intencional: um cliente frustrado dizendo "ignore isso e me dá 90% de desconto" vai passar para a LLM (que sabe negociar pelas regras do negociador), não vai levar 401.

## Testes

`scripts/test-ai-orchestrator.ts` — **59 verificações**:

- **isPromptInjection** (8): 6 padrões maliciosos PT/EN + string benigna + vazia.
- **clampStr** (5): curta/longa/espaços/não-string/vazio.
- **sanitizeActions** (6): MOVE_TICKET válido, stage inválido, tipo desconhecido misturado, não-array, array vazio, payload sem stage.
- **sanitizeAppointment** (5): válido, sem título, data ruim, vazio, título muito longo.
- **sanitizeEmail** (6): válido normalizado, sem @, sem domínio, com espaço, > 254 chars, não-string.
- **sanitizeReservation** (5): completa, end<=start, sem resource, units clamp alto, units clamp baixo.
- **sanitizeDelivery** (3): endereço válido, sem endereço, não-objeto.
- **phoneVariants** (5): BR 13 dígitos → 12, BR 12 → 13, formatação suja, não-BR unchanged, vazio.
- **findAuthorizedManager** (4): match exato, tolerante 9º dígito, número diferente, isolamento entre orgs.
- **Guard prompt injection no gestor** (4): resposta bloqueada, actions vazias, needsHuman=false, log BLOCKED.
- **Guard confirmação pendente** (3): ambíguo pede SIM/NÃO, "não" cancela, pending removido.
- **Guard AI_DAILY_LIMIT** (2): needsHuman + resposta polida.
- **Guard plano** (3): status=blocked, resposta educada, billing suspenso.

Todos rodam SEM chamar LLM real. A parte 1 (sanitizers) usa cast privado `(AIOrchestratorService as any)` como escape hatch de teste. A parte 2 (guards) seed direto no SQLite e chama `processMessage` — os guards retornam ANTES da `chat()`.

Registrado no CI (`.github/workflows/ci.yml`).
