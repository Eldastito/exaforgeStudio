# ADR-154 — FalaTu Standalone + AI Metering + Blueprint Solo + RAG na memória

- **Status:** RASCUNHO (aguardando aprovação do dono da plataforma pra fatiar). Nenhuma fatia implementada.
- **Data:** 2026-08-05
- **Origem:** conversa de produto com o dono da plataforma (2026-08-05) — pedido explícito de "vender add-ons como aplicativos únicos" (FalaTu como assistente pessoal) mantendo os dois mundos (embedded no ZapFlow + standalone), com recarga de tokens, cotas por usuário, Evolution dedicado por assinante e memória tipo RAG.
- **Relacionadas:**
  - **ADR-151** (FalaTu núcleo — módulo em produção, base deste ADR).
  - **ADR-153** (Vertical Entitlements + Blueprints — mecanismo que já decide o que a org enxerga; aqui ganha o modo Solo).
  - **ADR-091** (Nova grade de planos + top-ups de IA — recarga admin existe; falta self-service pro usuário final).
  - **ADR-116** (Multi-instância WhatsApp + onboarding — molde pra Evolution dedicado por org).
  - **ADR-067** (Gemini RAG — molde de embeddings + busca vetorial no repo; aqui é reuso, não invenção).
  - **ADR-136** (Decision-Action Ledger — o ledger de tokens segue o mesmo desenho de "sinal dedupável por chave", NÃO tabela mutável de contador — RN-004).
  - **ADR-152** (Runtime Execution) — sem dependência funcional; nomes independentes.
  - **ADR-095** (RBAC granular) — cota por USUÁRIO herda o desenho.
  - **ADR-130** (Governança de IA) — o ledger de tokens é a evidência que a governança pede.

## Contexto

O FalaTu (ADR-151) fechou 6 fatias em produção e virou o melhor candidato a **primeiro add-on vendido isolado** — assistente pessoal por WhatsApp, cobrado por assinatura + saldo de tokens. O dono da plataforma pediu, na mesma conversa:

1. **Vender FalaTu como aplicativo único** — org solo, sem enxergar Clínica/Escola/Retail/Comigo etc.
2. **Manter o FalaTu embedded** funcionando exatamente como está pra quem já tem a suíte.
3. **Instância Evolution dedicada por assinante** (número próprio do usuário conectado por QR), sem misturar com o pool interno do ZapFlow.
4. **Modo "só responde ao gatilho"**: no Solo, a IA NÃO responde livremente ao WhatsApp — só quando a palavra de ativação é dita. O restante das mensagens é do dono do número, o assistente não interfere.
5. **Memória virando RAG**: a extração deve *primeiro* consultar a memória do usuário (embeddings + busca vetorial nas notas + entidades) e *depois* recorrer a outros lugares. Hoje a memória é match determinístico por nome — bom pra desambiguação de "qual Carlos?", ruim pra "o que eu combinei com o cliente X mês passado?".
6. **Recarga de tokens self-service**: o usuário final compra pacote de tokens direto no app, sem admin. Hoje o top-up é do plano (ADR-091) e passa pelo admin da org.
7. **Tela master admin de gastos de IA**: o operador da plataforma precisa ver quanto cada org está gastando por módulo/modelo, definir cotas, alertar antes do estouro.

Nada disso é novidade estrutural — cada pedido tem molde no repo:
- Blueprint Solo → `VerticalBlueprintService` (ADR-153 F3.1/3.2/3.3).
- Evolution dedicada → ADR-116 (multi-instância + onboarding QR).
- RAG na memória → ADR-067 (Gemini RAG já rodando em outros módulos).
- Ledger de tokens → convenção nº 12 (BusinessSignal, mas aqui `ai_usage_ledger` porque é métrica granular, não sinal binário).
- Cota por usuário → `PlanService.aiAllowed` estendido com `user_id` opcional.
- Recarga self-service → checkout Asaas/Stone já existe pra assinatura (ADR-091 §6); mesmo pattern.
- Configuração do módulo → `FalaTuSettingsView` como aba do próprio módulo (não da SettingsView geral).

O ganho de agrupar os 7 pedidos num único ADR é que **todos tocam a mesma superfície** (billing/entitlement do FalaTu) e fatiar por fase (não por pedido) evita retrabalho — ex.: implementar recarga self-service antes do ledger de tokens seria escrever a UI de "saldo" antes de existir saldo.

## Decisão de arquitetura

**6 fases, ordenadas por dependência**, cada uma um marco funcional. Cada fase se fatia em 1..N PRs draft → CI verde → merge → próxima. Nenhuma fase invalida a anterior (aditivo puro em DB, mesma convenção nº 2/10 do repo).

### Fase 1 — AI Usage Ledger + tela master admin

**Nova tabela `ai_usage_ledger`** (aditiva, fim do `db.ts`):

```
id (uuid), organization_id, user_id (nullable — algumas chamadas são de sistema),
module (falatu|clinica|escola|retail|comigo|...), model (gpt-4o-mini|whisper-1|...),
operation (chat|transcription|vision|embedding), input_tokens, output_tokens,
cost_cents (INTEGER — sempre em centavos, nunca float), latency_ms,
occurred_at, request_id (nullable — pra tracing)
```

**Interceptor único** em `llm.ts` (`chat`/`transcribeAudio`/`extractStructuredFromImage`/novo `embed`): cada chamada passa `{orgId, userId, module}` (obrigatório na interface tipada — não é opcional, o TypeScript recusa chamada sem contexto) e o helper grava a linha do ledger *depois* do sucesso, best-effort (try/catch, nunca throw pro caller — convenção nº 7).

**Cotas** ficam em `organization_settings.ai_monthly_limit_cents` (já existe pra ADR-091) e nova `organization_settings.ai_user_monthly_limit_cents` (opcional — se null, sem teto por usuário, só o da org). Consumo derivado por query no ledger (RN-004: nunca contador mutável).

**Tela master admin** (`AiUsageDashboardView`, `/admin/ai-usage`):
- Lista de orgs com consumo do mês (input/output tokens, custo, % da cota) — ordenável por custo.
- Drill-down por org → gráfico temporal (últimos 30 dias) + breakdown por módulo + breakdown por modelo + breakdown por usuário.
- Alertas: sinal em `business_signals` (`ai_quota_warning`, `ai_quota_exceeded`) quando org passa 80%/100% da cota — o gate `PlanService.aiAllowed` já bloqueia em 100%, o sinal só notifica.
- Ação: ajustar cota (`POST /admin/organizations/:id/ai-quota`) auditado com `ADMIN_AI_QUOTA_UPDATE`.

**Fatias:** F1.1 tabela + interceptor (backend); F1.2 tela admin + gráficos; F1.3 sinais + alertas.

### Fase 2 — Blueprint "Solo" genérico + seed FalaTu Solo

Reusa **integralmente** o `VerticalBlueprintService` da ADR-153. A ideia é generalizar, não duplicar:

- Novo campo em `vertical_blueprints`: `mode TEXT DEFAULT 'suite'` (`suite`|`solo`). No modo `solo`, o UI esconde qualquer navegação/menu fora do primeiro `visibleModules[0]` — vira app single-purpose.
- Seed do blueprint `falatu-solo` (id: `falatu-solo-v1`): `visibleModules: ['falatu']`, `hiddenModules: [<todos os outros>]`, `mode: 'solo'`, `defaultRole: 'owner'` (usuário solo é dono do próprio tenant).
- Pricing tier no catálogo: **"Assistente Pessoal FalaTu"** (nome comercial), plano com `ai_monthly_limit_cents` menor e `plan_bundle: falatu-solo-v1`.
- Onboarding: cadastro em https://.../assistente-pessoal cria org de 1 usuário com blueprint `falatu-solo-v1` já aplicado — sem passar pela seleção de vertical.

**Guardrail:** blueprint Solo NÃO ganha módulos "por acidente" — a evolução v1→v2 (ADR-153 F3.3) rejeita adicionar módulo fora da whitelist do modo. Alteração de whitelist é decisão de produto, muda o `mode` explicitamente.

**Fatias:** F2.1 campo `mode` + seed `falatu-solo-v1` + onboarding standalone; F2.2 catálogo comercial + checkout.

### Fase 3 — FalaTuSettingsView (aba de config completa)

Nova aba `Config` dentro do próprio `FalaTuView` — vale nos dois mundos (embedded e Solo). Um único componente que muda de acordo com o contexto (Solo mostra tudo; embedded esconde o que não faz sentido — ex.: usuário embedded não gerencia Evolution dedicada, ele usa o canal interno).

Blocos:
1. **WhatsApp** — status do canal (interno/dedicado), palavra de ativação (config por-org: `falatu_activation_word` default `"anota"`), porta do briefing WA (F6 da ADR-151), botão "Enviar resumo agora".
2. **Memória** — listar entidades (pessoas/projetos), editar contexto, apagar (LGPD art. 18), toggle "usar RAG na captura" (opt-in — Fase 5).
3. **Tokens** — saldo do mês, gráfico de consumo (últimos 30 dias), botão "Comprar mais" (Fase 6).
4. **Timezone** — timezone do briefing (default São Paulo).
5. **LGPD** — exportar meus dados (JSON), apagar minha conta (Solo apaga a org; embedded apaga só o `user_id` no FalaTu).

**Fatias:** F3.1 blocos WhatsApp + Timezone + LGPD; F3.2 bloco Memória (depende da F5 pra o toggle RAG existir de verdade); F3.3 bloco Tokens (depende da F6).

### Fase 4 — Evolution dedicado por org Solo + modo "só gatilho"

**Evolution dedicada** — reusa o pattern da ADR-116 (multi-instância):
- Nova coluna `organizations.whatsapp_instance_kind TEXT DEFAULT 'shared'` (`shared`|`dedicated`).
- Org com `mode='solo'` no blueprint recebe `whatsapp_instance_kind='dedicated'` no onboarding: cria instância no Evolution API (nome derivado do org id), gera QR, usuário conecta o próprio número.
- Webhook da Evolution aponta pro `webhookProcessor` já existente (mesmo endpoint), com `X-Instance-Id` no header pra roteamento.

**Modo "só gatilho"** — nova coluna `organization_settings.falatu_reply_mode TEXT DEFAULT 'trigger_only'` pra org Solo (`always`|`trigger_only`). Quando `trigger_only`:
- `FalaTuWhatsAppService.handle` mantém o gatilho explícito (`anota…`/`confere`/`descarta`/`é N` — já é assim, ADR-151 F3).
- **NENHUM outro consumidor de mensagem roda** — Controller/Coordenador/Diretor IA/Comprador IA todos ficam bypassed no `webhookProcessor` quando `whatsapp_instance_kind='dedicated' && falatu_reply_mode='trigger_only'`. A checagem é uma única linha no roteador do webhook.
- Mensagem que não bate gatilho → o `webhookProcessor` retorna `handled=true` (silêncio absoluto — o assistente não interfere com a vida pessoal do dono do número).

**Guardrail RN-154 (duro, testado):** org Solo com Evolution dedicado + `trigger_only` NUNCA envia mensagem outbound sem gatilho humano — nem briefing proativo automático (Fase 6 da ADR-151) sem opt-in explícito da porta (`falatu_briefing_wa_enabled`). O usuário paga pra ter assistente sob demanda, não pra ser espionado.

**Fatias:** F4.1 instância dedicada + onboarding QR; F4.2 `falatu_reply_mode` + bypass no `webhookProcessor` + teste de "não interfere".

### Fase 5 — RAG na memória (embeddings + busca vetorial → consulta antes de outros lugares)

Hoje a memória do FalaTu é `falatu_entities` (pessoas/projetos) + `falatu_inbox_items.summary` (texto livre das notas) — nenhum índice vetorial. A busca hoje é `SELECT ... WHERE name_norm LIKE ...` (Fatia 5 da ADR-151), boa pra desambiguação, ruim pra "consulta livre".

**Novidade — `falatu_memory_embeddings`** (aditiva):
```
id (uuid), organization_id, user_id, source_type (entity|note), source_id (uuid),
content_snippet (TEXT — o texto usado pra gerar o embedding),
embedding BLOB (vetor 1536-dim serializado — mesma dimensão do `text-embedding-3-small`),
created_at, model (default 'text-embedding-3-small')
```

**Interceptor de captura** (opt-in via `falatu_rag_enabled` da org): a cada `confirm()` que materializa entidade ou nota, dispara embedding assíncrono via job (`JobQueue`) e grava a linha. Nada síncrono no caminho da captura (não pode atrasar o "Fala → Faz → Confere").

**Interceptor de interpretação**: `capture()` ANTES de mandar pro `llm.chat` faz *primeiro* uma busca top-K (K=5) por similaridade cosseno no embedding da entrada, monta um bloco `<memoria_relevante>` no prompt e prepend na chamada. Ou seja: a LLM recebe "seu contexto de memória" **antes** de decidir intent. É a definição de RAG do pedido — "buscar primeiro na memória depois em outros lugares".

**Cálculo de similaridade** — busca em SQLite via extensão `sqlite-vss` ou fallback puro em JS (loop com cosseno) se a extensão não estiver disponível. Fallback é aceitável porque o volume por usuário é pequeno (algumas centenas de embeddings — a maioria vai ter <1000).

**Guardrails RN-154 do RAG:**
- Embedding é gerado só sobre conteúdo que o humano confirmou (RN-151: `pending` não gera embedding, só `confirmed`).
- O bloco `<memoria_relevante>` no prompt é rotulado como "contexto histórico" e a IA é instruída (system prompt) a NÃO inventar fatos a partir dele — se a memória contradiz a entrada, prevalece a entrada (RN-151 "não invente"). O teste prova.
- Isolamento multi-tenant é filtro OBRIGATÓRIO no top-K (`WHERE organization_id = ? AND user_id = ?`).
- LGPD: apagar entidade/nota apaga também o embedding (mesma transação).
- Custo de embedding entra no `ai_usage_ledger` (Fase 1) — operation `embedding`, module `falatu`.

**Fatias:** F5.1 tabela + gerador de embedding assíncrono no confirm (não muda a captura ainda); F5.2 busca top-K + injeção no prompt (feature flag `falatu_rag_enabled` default off); F5.3 UI: toggle na `FalaTuSettingsView` (F3.2 depende disto) + backfill opcional pros itens antigos da org.

### Fase 6 — Recarga self-service de tokens (checkout do usuário final)

**Novidade — `ai_token_purchases`** (aditiva):
```
id (uuid), organization_id, user_id, tokens_purchased_cents (crédito em centavos),
price_paid_cents (o que o cliente pagou — pode ser < por promo), gateway (asaas|stone),
gateway_transaction_id, status (pending|paid|failed|refunded), created_at, paid_at
```

Saldo do usuário/org = `SUM(purchases.paid) - SUM(ledger.cost)` no mês (RN-004 novamente — derivado, nunca contador).

**Fluxo:** UI da `FalaTuSettingsView` (Fase 3, bloco Tokens) mostra saldo + pacotes pré-definidos (ex.: R$ 20 = 400.000 tokens, R$ 50 = 1.100.000 com bônus). Clique cria PIX/checkout via gateway já configurado. Webhook do gateway (mesmo caminho da assinatura ADR-091) marca `paid` e cria a linha de crédito no ledger.

**Gate:** `PlanService.aiAllowed` já checa `ai_monthly_limit_cents` — ganha uma consulta a mais no saldo comprado (se `plan_limit_exceeded && purchased_balance > cost_of_next_call`, permite). Mesma régua pros dois mundos (embedded ou Solo).

**Guardrails:**
- Não existe "reembolso automático" — se a chamada de IA falhar depois do débito, o ledger fica com o custo mesmo assim (senão vira vetor de abuso). Erros catastróficos são tratados por reembolso manual do operador (evento no `business_signals`).
- Saldo NUNCA fica negativo — última chamada que estouraria retorna erro tratado antes de custar.
- LGPD: `ai_token_purchases` retido por 20 anos (não é dado clínico, mas é fiscal — ADR-055/056).

**Fatias:** F6.1 tabela + fluxo checkout (webhook + PIX); F6.2 UI de saldo + pacotes na FalaTuSettingsView (F3.3 depende); F6.3 sinal de "saldo baixo" em `business_signals` + notificação por WhatsApp no canal do usuário.

## Guardrails RN-154 (duros, testados por fase)

A IA/módulo Solo do FalaTu **nunca**:

1. **Vaza módulo fora do blueprint** — usuário Solo NUNCA vê link/navegação/rota de módulo `hidden` (frontend + backend enforça, mesmo padrão da F1.4 da ADR-153).
2. **Responde WhatsApp sem gatilho** no modo `trigger_only` — nenhum agente/consumidor da plataforma pode intervir na vida do dono do número.
3. **Envia mensagem outbound sem opt-in** — briefing WA só com `falatu_briefing_wa_enabled=1` (já é assim, F6 da ADR-151); nada novo se automatiza sem opt-in equivalente.
4. **Inventa fato a partir da memória RAG** — o bloco `<memoria_relevante>` é contexto histórico, não fonte de verdade; entrada humana prevalece.
5. **Cobra token que não foi debitado no ledger** — o ledger é a fonte da verdade, saldo derivado (RN-004).
6. **Deixa saldo negativo** — a última chamada que estouraria custa retorna erro antes de gastar.
7. **Cross-tenant no RAG** — embedding só é buscado com filtro `organization_id + user_id` obrigatório (compilador rejeita chamada sem contexto na Fase 1).
8. **Deleta física** — apagar entidade/nota do usuário é UPDATE de status + apagar embedding correspondente (LGPD), NÃO DELETE do registro histórico (retenção fiscal do purchase é intocável).

## Retrocompatibilidade

100% aditivo. Nenhuma coluna renomeada. Nenhum contador mutável. Todos os defaults preservam o comportamento atual:
- `mode='suite'` default no blueprint → orgs existentes continuam suíte.
- `whatsapp_instance_kind='shared'` default → orgs existentes seguem no pool interno.
- `falatu_reply_mode='always'` default pra suíte → Controller/Coordenador seguem funcionando.
- `falatu_rag_enabled=0` default → memória segue funcionando por match exato (F5 da ADR-151); orgs ligam quando quiserem.
- `ai_user_monthly_limit_cents=null` default → só o teto da org vale, comportamento igual ao de hoje.

## Plano de fatias (16 fatias em 6 fases)

| Fase | Fatia | Escopo | Depende | Peso |
|------|-------|--------|---------|------|
| 1 | 1.1 | `ai_usage_ledger` + interceptor tipado em `llm.ts` + backfill best-effort dos módulos existentes | — | Grande |
| 1 | 1.2 | `AiUsageDashboardView` (tabela + drill-down + gráfico temporal) | 1.1 | Média |
| 1 | 1.3 | Sinais de cota (80%/100%) em `business_signals` + rota `POST /admin/organizations/:id/ai-quota` | 1.1 | Pequena |
| 2 | 2.1 | Campo `blueprint.mode` + seed `falatu-solo-v1` + onboarding standalone | ADR-153 F3.1 | Média |
| 2 | 2.2 | Catálogo comercial "Assistente Pessoal" + checkout Asaas/Stone | 2.1, ADR-091 | Média |
| 3 | 3.1 | `FalaTuSettingsView` aba Config — blocos WhatsApp + Timezone + LGPD | — | Média |
| 3 | 3.2 | Bloco Memória (toggle RAG + listar/editar/apagar) | 5.2 | Média |
| 3 | 3.3 | Bloco Tokens (saldo + gráfico + botão comprar) | 6.1 | Pequena |
| 4 | 4.1 | Evolution dedicada por org Solo + onboarding QR (molde ADR-116) | 2.1 | Grande |
| 4 | 4.2 | `falatu_reply_mode=trigger_only` + bypass no `webhookProcessor` + teste "não interfere" | 4.1 | Média |
| 5 | 5.1 | `falatu_memory_embeddings` + gerador assíncrono no `confirm()` | 1.1 (custo) | Média |
| 5 | 5.2 | Busca top-K + injeção `<memoria_relevante>` no prompt + flag opt-in | 5.1 | Grande |
| 5 | 5.3 | Backfill opcional pros itens antigos da org (botão na Fase 3.2) | 5.2, 3.2 | Pequena |
| 6 | 6.1 | `ai_token_purchases` + fluxo checkout self-service + webhook gateway | 1.1 (débito) | Grande |
| 6 | 6.2 | Bloco Tokens da FalaTuSettingsView consumindo saldo real | 6.1, 3.3 | Pequena |
| 6 | 6.3 | Sinal "saldo baixo" + notificação por WhatsApp no canal do usuário | 6.1 | Pequena |

**Ordem recomendada de execução:** 1.1 → 1.2 → 1.3 → 2.1 → 4.1 → 4.2 → 5.1 → 5.2 → 6.1 → 3.1 → 3.2 → 3.3 → 6.2 → 5.3 → 6.3 → 2.2 (mais tarde, quando o produto estiver pronto pra vender de verdade).

## Métricas de sucesso

- **AI Metering:** 100% das chamadas de IA da plataforma passam pelo interceptor tipado (grep no repo prova zero call site fora — a interface tipada garante em compile time).
- **Blueprint Solo:** usuário Solo faz login, só vê FalaTu, e o network tab do browser não retorna nada de módulo `hidden` (teste E2E).
- **RAG:** 3 casos de uso reais validados manualmente ("o que combinei com X mês passado?", "qual foi a última reunião do projeto Y?", "quem é a Ana?" → puxa contexto sem re-perguntar).
- **Recarga self-service:** conversão end-to-end de "clique em comprar" → PIX pago → saldo creditado < 60 segundos, medido no ledger.
- **Não-intervenção do trigger_only:** logs de 30 dias de uma org Solo mostram 0 mensagens outbound sem gatilho humano (auditado).

## O que este ADR NÃO cobre (out of scope, futuros)

- **Voz-por-voz sintética** (o assistente respondendo em áudio TTS) — hoje resposta é sempre texto. Se pedirem, novo ADR (ADR-155?).
- **Multi-idioma** — hoje PT-BR fixo. Mesmo destino.
- **Assistente Pessoal com integração de calendário externo** (Google Calendar/Outlook) — molde é ADR-066, novo ADR.
- **Compartilhamento de memória entre usuários** (ex.: casal, sócios) — hoje memória é estritamente por `user_id`. Discussão de produto.
- **Add-ons Solo além do FalaTu** (Cobrança Solo, Recuperação Solo etc.) — a Fase 2 abre o mecanismo (`blueprint.mode='solo'`), mas seed + tela específica de cada um vem em ADR próprio quando decidido comercializar.

## Status por fatia

| Fatia | Status | PR |
|-------|--------|----|
| 1.1 | MERGED | #791 |
| 1.2 | MERGED | #792 |
| 1.3 | MERGED | #793 |
| 2.1 | MERGED | #795 |
| 2.2 | Pending | — |
| 3.1 | Pending | — |
| 3.2 | Pending | — |
| 3.3 | Pending | — |
| 4.1 | MERGED | #796 |
| 4.2 | MERGED | #797 |
| 5.1 | MERGED | #798 |
| 5.2 | In Progress | — |
| 5.3 | Pending | — |
| 6.1 | Pending | — |
| 6.2 | Pending | — |
| 6.3 | Pending | — |
