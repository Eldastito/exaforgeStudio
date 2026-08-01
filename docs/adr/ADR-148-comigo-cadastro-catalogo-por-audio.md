# ADR-148 — Comigo: Cadastro do catálogo por ÁUDIO (Whisper + LLM)

- **Status:** Merged — 2026-08-01
- **Origem:** Gap A do levantamento "Autônomos — o que ainda falta" (ADR-088 D2).
- **Relacionadas:** ADR-088 D2 (cadastro áudio; venda toque), ADR-019/020/030 (Smart Inventory — humano confirma), ADR-102 (TaskAudio, mesmo padrão service com fn injetável), ADR-130 (governança IA).

## Contexto

ADR-088 D2: "Digitar é o atrito." O empreendedor autônomo (galeto, marmiteira, chaveiro, foodtruck) precisa cadastrar rapidamente uma lista de itens no PDV — "bolo de pote P, 8 reais; galeto inteiro, 45; água mineral, 3". Sem esse cadastro rápido, ele desiste antes de vender o primeiro item pelo Balcão. `transcribeAudio()` (Whisper) e `chat()` (OpenAI) já existiam no `llm.ts`; faltava juntar num fluxo dedicado com guardas de custo, de qualidade e de UX.

## Decisões

### D1 — Serviço que devolve preview, NUNCA cria sozinho

`ComigoAudioCatalogService.parseAudio(orgId, buffer, mime)` → `{transcript, items[], source}`. O SERVICE NÃO INSERE em `products_services` — devolve preview. O front mostra cada item numa linha editável e o dono clica "Salvar N" pra criar via `POST /api/products` (endpoint que já existe). Mesma disciplina do Smart Inventory (ADR-030): humano CONFIRMA antes de qualquer INSERT. Reusa a rota de produtos existente — sem inflar API.

### D2 — Cadeia de degradação explícita (nunca 500)

Estados possíveis do resultado:
1. `no_transcript` — buffer < 512 bytes, sem OPENAI_API_KEY, Whisper vazio, ou Whisper lançou. Não consome cap.
2. `cap_reached` — teto do dia estourou. Whisper NÃO é chamado (é o mais caro). HTTP 429 na rota.
3. `empty` — Whisper ouviu algo, LLM lançou ou devolveu JSON malformado / lista vazia. Transcript é preservado pra dono ver e digitar à mão se quiser.
4. `llm` — sucesso, `items[]` normalizado.

Nunca 500 pro atendimento. Front tem UI dedicada pra cada estado.

### D3 — Cap por org/dia via `ai_usage_log`

Nova coluna `organization_settings.comigo_audio_catalog_daily_cap INTEGER DEFAULT 30`. Whisper é ~10x mais caro por minuto que `chat` — default menor que o do menu-suggest (50). Meter `kind='comigo_audio_catalog'` gravado APÓS Whisper suceder e ANTES de chamar LLM. Ordem importa: se cap estourado, nem transcreve (economiza o mais caro).

### D4 — Normalização defensiva do JSON do LLM

Parser rejeita:
- Nome vazio ou só whitespace.
- `type` fora de `{product, service}` → força `'product'` (padrão seguro; `reservation` do `products_services` fica de fora dessa fatia).
- Preço não-numérico ("combinar", "sob consulta"), zero, negativo → `null` (dono digita à mão).
- Trunca em **20 itens** por chamada (evita LLM devolver 100 itens fantasma).
- Nome/description clipados por tamanho (120/200 chars).

### D5 — UI: MediaRecorder + preview editável

Componente `AudioCatalogPanel` no topo da aba Precificação (que já é o hub de cadastro de fichas — semanticamente relacionado). Fluxo:

1. Botão sky "🎤 Cadastrar por áudio" → `getUserMedia({audio:true})` → `MediaRecorder` em `audio/webm;codecs=opus` (padrão universal) com fallback `ogg/opus`.
2. Durante gravação: botão vermelho "⏹ Parar" + linha "● Gravando... dite 'nome tal, preço tal'".
3. Ao parar: upload multipart pra `POST /api/comigo/catalog/parse-audio`.
4. Preview: cada item vira uma linha editável (nome, preço number, product/service). Chip amarelo ⚠ pra `confidence < 70`. "Remover" descarta a linha.
5. "Salvar N" faz loop `POST /api/products` — só grava linhas com nome não-vazio + preço > 0.

Front nunca depende do backend salvar em batch — cada `POST` é independente; se 3 de 5 falharem, os 2 que passaram ficam gravados e o toast conta quantos deu certo.

### D6 — Injeção pra teste (`_internals`)

Mesmo padrão consagrado (`ComigoImpactService`, `ComigoMenuSuggestService`). Expõe `_internals.setChatFn / setTranscribeFn / setAIConfiguredFn`. Teste roda 100% offline — 45 checks cobrindo cada estado do fluxo.

## Guardas RN

1. **Isolamento multi-tenant** — cap por org, meter por org, snapshot por org.
2. **Nunca inventa item** — normalização descarta nome vazio; se todos os itens forem lixo, source='empty'.
3. **Nunca cria sozinho** — service devolve preview; INSERT só acontece via `POST /api/products` disparado pelo humano.
4. **Nunca 500** — 4 estados explícitos de saída; try/catch em todos os IOs.
5. **Frugalidade** — Whisper é o mais caro; se cap estourou, nem transcreve. Meter dedicado (`kind='comigo_audio_catalog'`) separado do `kind='chat'`/`'audio'` do `llm.ts` (billing preservado).
6. **Governança IA (ADR-130)** — cadastro de produto não é `PEOPLE_AFFECTING`; sugestão orientativa, humano confirma.
7. **Retrocompatibilidade** — aditivo em `organization_settings` (única coluna nova).

## Serviço, rotas, DB

**Service:** `src/server/ComigoAudioCatalogService.ts`
- `static async parseAudio(orgId, buffer, mime='audio/ogg') → {transcript, items, source, capReached?}`
- `static status(orgId) → {cap, used, remaining, aiConfigured}`
- `_internals.setChatFn/setTranscribeFn/setAIConfiguredFn`

**Rotas:**
- `POST /api/comigo/catalog/parse-audio` — multipart `file`, até 5MB, audio/webm|ogg|mp3|wav|m4a.
- `GET /api/comigo/catalog/audio-status` — teto/uso/restante.

**DB (aditivo):** `organization_settings.comigo_audio_catalog_daily_cap INTEGER DEFAULT 30`.

**UI:** componente `AudioCatalogPanel` em `src/features/ComigoView.tsx`, dentro de `Precificacao` (list view).

## Testes

`test:comigo-audio-catalog` — 45 checks, offline, sem OpenAI real:
- Guardas de entrada (buffer minúsculo, sem AI configurado, transcrição vazia)
- transcribeFn lança sem consumir cap
- LLM OK: normalização de nome/type/price/description/confidence
- Preços string/null/0/negativo → null
- type inválido / não suportado → force 'product'
- Truncamento em 20
- JSON malformado / LLM lança → empty com transcript preservado
- Cap estourado → cap_reached, Whisper NÃO chamado
- Isolamento entre orgs (cap de A não afeta B)
- Nome vazio → descartado

## Consequências

**Positivas:** cadastro de catálogo por voz — o autônomo destrava o Balcão em minutos, sem letramento digital. Reusa `llm.ts` inteiro (Whisper + chat + billing) e `POST /api/products` inteiro (sem duplicar lógica de INSERT). UI dá controle total ao humano (edita/remove antes de salvar). Custo previsível (cap por org/dia).

**Trade-offs:** Whisper custa ~$0.006/min → 30 chamadas/dia com 30s cada = ~$0.09/dia/org (folgado pra Balcão de bairro). MediaRecorder não funciona no iOS Safari < 14.1 (raro em 2026, mas existe); fallback é digitar à mão via botão "Nova ficha" que já existe. Sem cache local — cada gravação é upload novo.

**Futuro (não nesta fatia):** cadastro por áudio no WhatsApp (usa o mesmo service, entrada via webhook do provider); linkagem automática com `comigo_recipes` (criar ficha vazia junto do produto); suporte a "editar produto por áudio" ("aumenta o galeto pra 50 reais"); vincular foto do produto tirada na hora (ADR-030 pipeline).
