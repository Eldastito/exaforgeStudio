# ADR-147 — Comigo: Sugestão de menu por DESEJO (LLM+RAG do cardápio)

- **Status:** Merged — 2026-08-01
- **Origem:** Gap B do levantamento "Autônomos — o que ainda falta" (ADR-088 D5 nível 2). Complementa ADR-117 (nível zero-token).
- **Relacionadas:** ADR-088 D5 (frugalidade — LLM só na ponta), ADR-117 (market-basket/co-ocorrência), ADR-130 (governança de IA).

## Contexto

ADR-088 D5 divide sugestão em dois níveis:

- **Zero-token** (maioria dos casos): "mais pedidos", "quem levou X também levou Y" — ranking/co-ocorrência sobre `comigo_order_items`. Entregue em ADR-117.
- **Com LLM** (só quando o cliente escreve um desejo): "algo leve", "sem lactose", "pra 2 pessoas", "sobremesa gelada" — LLM com **RAG do cardápio real da loja**.

O Gap B era o segundo nível. Sem ele, o Balcão não tinha resposta pra "o cliente pediu algo diferente" — só via `alsoBought` do último item, que não ajuda quando o desejo é qualitativo.

## Decisões

### D1 — RAG do cardápio real, LLM só escolhe id da lista

`ComigoMenuSuggestService.interpret(orgId, desire)` monta um snapshot compacto do catálogo ativo (`products_services` com `active=1` e `price NOT NULL`), envia junto do desejo, e força o LLM a devolver **só ids presentes no snapshot** (`{items:[{id,reason}]}`). Depois, o service **valida cada id de volta contra o snapshot** — qualquer id fora é descartado. Isso é RAG minimalista: sem embeddings/vector store — o cardápio de uma loja de bairro cabe folgado no contexto do modelo, e a operação é 1 chamada síncrona (não pipeline).

Preço e nome canônico da sugestão **vêm do snapshot**, nunca do LLM. Isso fecha a superfície de ataque de "IA cita preço errado" e mantém a política do repo: dados sensíveis (preço) nunca são texto livre de IA.

### D2 — Degradação em profundidade

O atendimento no Balcão não pode quebrar. `interpret()` **sempre** responde `{items, source}` e nunca lança. Cadeia de fallback:

1. Sem `OPENAI_API_KEY` → busca literal (LIKE normalizado em nome/descrição).
2. Teto do dia estourado (D3) → literal, com `capReached=true` pra UI sinalizar.
3. LLM lança (rate-limit, timeout, rede) → literal, **não** consome cota.
4. JSON malformado → literal.
5. LLM devolveu só ids inválidos → literal.
6. Menu vazio → `source='empty'` (não chama LLM).
7. Desejo com <3 chars → `source='empty'` (guarda contra "ok"/"a").

Nunca 500 pro Balcão.

### D3 — Teto por org/dia (frugalidade RN)

Nova coluna `organization_settings.comigo_menu_suggest_daily_cap INTEGER DEFAULT 50`. Contagem via `ai_usage_log WHERE kind='comigo_menu_suggest' AND created_at >= datetime('now','-1 day')`. Quando `used >= cap`, cai pra literal. O `kind='comigo_menu_suggest'` é gravado **em separado** do `kind='chat'` que o `llm.ts` grava automaticamente pra medição de custo — assim o cap é dedicado à feature (sem misturar com outros usos de `chat()`), mas o **custo** continua sendo contabilizado no lugar único de billing.

### D4 — UI: DesireBox no Balcão

Input "Diga o que o cliente quer" logo acima da faixa zero-token (ADR-117). On-submit (Enter ou botão) chama `POST /api/comigo/menu-suggest`. Até 3 chips âmbar aparecem; toque adiciona ao pedido (mesmo caminho de `addByProductId` já usado pelo market-basket). O front **filtra de novo** contra a lista `products` carregada, defesa em profundidade contra id fantasma. Se `capReached`, uma linha discreta explica: "Limite de sugestões IA do dia atingido — mostrando busca simples."

Superfície nesta fatia = Balcão do operador. Mesa/QR (cliente final digita) fica pra fatia futura — o motor já está pronto e testado; falta só rota pública com rate-limit por sessionId da Mesa.

### D5 — Injeção pra teste (`_internals`)

Padrão consagrado no repo (ex.: `ComigoImpactService._internals`). O service expõe `_internals.setChatFn(fn)` e `_internals.setAIConfiguredFn(fn)` — testes injetam mocks (JSON válido, JSON malformado, id fantasma, throw) sem bater na OpenAI real. CI roda sem chave, offline, determinístico.

## Guardas RN

1. **Isolamento multi-tenant** — `menuIndex(orgId)`, cap por org, tudo filtra `organization_id`.
2. **Nunca inventa item** — validação de id contra snapshot elimina alucinação de produto.
3. **Nunca cita preço** — preço vem do snapshot, não do texto do LLM.
4. **Nunca 500 no atendimento** — 7 caminhos de degradação testados.
5. **Frugalidade** — min-length 3, temperature 0, cap por dia, cache implícito via literal fallback.
6. **Governança de IA (ADR-130)** — sugestão é orientativa e não afeta pessoa (nunca é `PEOPLE_AFFECTING`); adição do item ao pedido é ato humano (o operador toca no chip).

## Serviço, rotas, DB

**Service:** `src/server/ComigoMenuSuggestService.ts`
- `static async interpret(orgId, desire) → {items, source, capReached?}`
- `static status(orgId) → {cap, used, remaining, aiConfigured}`
- `_internals.setChatFn/setAIConfiguredFn` (testes)

**Rotas:**
- `POST /api/comigo/menu-suggest` — corpo `{desire}`.
- `GET /api/comigo/menu-suggest/status` — teto/uso/restante (debug/UI).

**DB (aditivo):** `organization_settings.comigo_menu_suggest_daily_cap INTEGER DEFAULT 50`.

**UI:** `DesireBox` em `src/features/ComigoView.tsx` acima da grade zero-token no Balcão.

## Testes

`test:comigo-menu-suggest` — 34 checks, offline, com chatFn injetável:
- Guardas de entrada (vazio, curto, menu vazio)
- Sem AI → literal
- LLM OK, id fantasma, todos inválidos, JSON malformado, throw
- Cap estourado → literal + capReached
- Isolamento: cap de A não vaza pra B; menu de A não aparece em B
- Item inativo (active=0) fora do snapshot

## Consequências

**Positivas:** motor de "diga o que o cliente quer" funciona em qualquer arquétipo (galeto, marmiteira, chaveiro-em-serviço). Reusa `llm.ts`/`ai_usage_log`. Teto duro por org garante previsibilidade de custo. UI aditiva — não mexe no fluxo zero-token nem no PDV.

**Trade-offs:** 1 chamada LLM por desejo custa alguns centavos (temperature 0, ~250 output tokens); cap default 50/dia é folgado pra Balcão de bairro. Para orgs com uso muito alto, ajuste em `organization_settings`. Sem embeddings/RAG "de verdade" — o cardápio inteiro cabe no contexto; se um dia surgir loja com >500 itens ativos, migra pra top-K por embedding, sem quebrar o contrato.

**Futuro (não nesta fatia):** exposição em Mesa/QR (rota pública com rate-limit por sessionId); cache LRU orgId+desire em memória (5min); tradução automática do desejo pra idioma do menu quando divergir; explicabilidade "por que sugeriu" mais rica.
