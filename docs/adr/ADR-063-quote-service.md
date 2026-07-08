# ADR-063 — QuoteService — orçamentos e PDF de proposta

**Status:** Implementado (com uma ressalva importante sobre PDF — ver Consequências).

**Origem:** Fase 3 do plano de produção — retrofit. Em segmentos como eventos, serviços B2B, construção civil e catering, a *proposta escrita* **é** o produto do lojista: o cliente pede via WhatsApp, alguém do outro lado precisa devolver um documento com itens, preços e validade. O `QuoteService` nasceu para tirar isso da mão do humano — a IA colhe os requisitos, o backend resolve catálogo/estoque, monta a cotação e persiste como objeto rastreável. Rodou por meses sem ADR; este documento fecha a lacuna e é honesto sobre o que ainda **não** virou PDF de verdade.

---

## Contexto

Fluxo real hoje:

1. Cliente manda uma lista no WhatsApp ("me faz um orçamento de 3x cadeira Tiffany + 2x mesa redonda").
2. O `AIOrchestratorService` extrai a intenção como `quote_request.items` (linha 416 do orquestrador) e chama `QuoteService.buildAndSave` (linha 422).
3. O serviço resolve cada item no `products_services` (match exato, depois `LIKE`), aplica `InventoryService.sellable` para checar estoque, monta snapshot estruturado e persiste em `quotes` com `valid_until = now + quote_validity_hours` (default 72h, configurável por org).
4. Devolve o **texto humanizado** (com bullets, subtotal, total, aviso de faltantes) que é anexado à resposta do WhatsApp.
5. Aceite/recusa entram por dois caminhos: manual pela tela (`routes/quotes.ts`) ou automático pelo `webhookProcessor` quando a IA marca `new_order`/`cancel_order` (linhas 628 e 664 daquele arquivo).

Não há SLA formal para "resposta do lojista virar proposta": a IA já responde na hora com a cotação persistida — a proposta é humana só até o cliente decidir aceitar.

## Decisão

**Regras do `QuoteService`:**

1. **Orçamento é objeto de primeira classe** — tabela `quotes` com `items_snapshot` (JSON congelado no momento do envio, não join dinâmico) para que mudança de preço no catálogo depois não altere a proposta enviada.
2. **Status:** `sent` | `viewed` | `accepted` | `declined` | `expired` (tipo `QuoteStatus`). Não existe `draft` — o momento do `buildAndSave` já é `sent`, porque o produto do serviço é literalmente a mensagem que sai. `viewed` é reservado para o dia em que instrumentarmos leitura, hoje ninguém escreve nele.
3. **Match de catálogo tolerante:** exato por `lower(name)`, fallback para `LIKE %name%` ordenado pelo nome mais curto. Erra a favor de casar; itens não encontrados vão para `notFound` e viram aviso no texto sem quebrar a cotação.
4. **Estoque respeitado:** se `stock_control_enabled`, `InventoryService.sellable` corta a quantidade ou marca "sem estoque" — mas ainda persiste o item no snapshot para o lojista ver o que foi pedido.
5. **Expiração + follow-up passivos** — `passFollowupAndExpire` roda no `Scheduler` (linha 79) a cada tick: expira `sent/viewed` vencidos e cutuca até `quote_followup_max` vezes (default 2, teto 5) com intervalo `quote_followup_hours` (default 24h). Mensagem de follow-up é hard-coded em dois tons (primeiro cutucão amigável, segundo despedida).
6. **Aceite automático quando o cliente confirma pedido** — `webhookProcessor` linha 628 chama `openForContact` + `markAccepted` no fluxo de `new_order`. Simétrico para `cancel_order` → `markDeclined`.
7. **Integração com IA que "ativa `exportPdf: true`"** — hoje esse flag **não** existe no schema de retorno de `quote_request`. O `exportPdf` do orquestrador (linha 376) é do relatório gerencial do Dashboard, **não** da proposta de cotação. A geração de PDF da proposta está descrita como intenção neste ADR mas ainda não foi implementada — ver Consequências.

## Consequências

**Positivas:**
- Snapshot congelado torna a cotação auditável mesmo depois de mudança de preço no catálogo.
- Follow-up automático recupera parcelas mensuráveis de orçamentos abandonados sem sobrecarregar o lojista.
- Aceite/recusa automáticos amarram cotação → pedido sem fluxo humano no meio, com fallback manual nas rotas.

**Trade-offs aceitos:**
- **PDF de proposta não existe.** A cotação sai como texto formatado no WhatsApp; nenhum helper (nem PDFKit nem HTML→PDF) é chamado a partir daqui. Segmentos que precisam de PDF assinável (eventos formais, contratos B2B) ainda dependem de o lojista transcrever para um template externo. Fica como próximo passo natural — provavelmente HTML→PDF via `puppeteer` reaproveitando o mesmo caminho do relatório gerencial.
- **Sem assinatura digital** — aceite é "cliente disse sim no WhatsApp" mais um `UPDATE` no banco. Suficiente para o modelo de negócio atual, insuficiente para propostas de alto valor com necessidade probatória.
- **Sem versionamento de proposta** — reeditar uma cotação enviada não é suportado; o caminho é criar nova. `items_snapshot` protege o registro histórico mas não há linhagem entre versões.
- **Sem template por segmento** — o texto do WhatsApp é hard-coded (bullets + total + call-to-action de fechar pedido). Um catering e um estúdio de arquitetura recebem o mesmo layout, o que arranha o profissionalismo percebido em nichos mais formais.
- **Follow-up com copy fixa** — dois textos hard-coded para `followup_count === 0` e `> 0`. Sem A/B, sem personalização por vertical, sem opt-out do cliente.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-quote-service.ts`. O que exercita o serviço é:

- `scripts/test-tenant-isolation.ts` (linhas 41, 105-108) — semeia orçamentos em duas orgs e valida que `QuoteService.list` não vaza cross-tenant. Protege o mínimo essencial (isolamento) mas não toca em `buildAndSave`, `passFollowupAndExpire`, `markAccepted` ou match de catálogo.

**Lacunas honestas** que devem virar `scripts/test-quote-service.ts`:
- `buildAndSave` com item exato, com fuzzy `LIKE`, com item inexistente, com estoque insuficiente e com estoque zero.
- Persistência do snapshot: garantir que mudança de preço em `products_services` depois **não** altera `items_snapshot` da cotação já enviada.
- `passFollowupAndExpire` — expiração de `valid_until` vencido, respeito a `quote_followup_max`, incremento de `followup_count` e `last_followup_at`, e não-envio para cotações já aceitas/recusadas.
- Aceite/recusa automático via `webhookProcessor` quando existe `openForContact` — regressão do caminho em produção.
- Idempotência: `markAccepted` chamado duas vezes não deve reverter status nem duplicar side effects.

Enquanto esses testes não existirem, qualquer mudança em `QuoteService` exige revisão manual dos 4 pontos consumidores listados em `grep -rn QuoteService\\. src/server`.
