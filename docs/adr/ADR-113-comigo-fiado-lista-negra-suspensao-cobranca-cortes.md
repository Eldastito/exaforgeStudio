# ADR-113 — Comigo/Fiado: lista negra, suspensão de venda e cobrança amigável e cortês

- **Status:** Proposto (escopo aprovado; schema entra já no PR #1, enforcement/UI nas fatias seguintes)
- **Data:** 2026-07
- **Origem:** pedido de campo — "lista negra para os fiados + suspensão de venda para quem está na lista + cobrança amigável e cortês".
- **Relacionadas:** ADR-112 (fiado no Balcão — este ADR estende a caderneta), ADR-111 (módulo `copiloto`/Comigo), ADR-091 §6 (princípio "IA recomenda, não bloqueia por previsão" — reusado aqui na sugestão de lista negra).

## Contexto

A caderneta (ADR-112) resolve "quem me deve e quanto". Falta o outro lado: **parar de cavar o buraco** com quem não paga, e **recuperar** o que está em aberto sem queimar o relacionamento. Duas coisas distintas:

1. **Lista negra + suspensão** — deixar de dar fiado a quem já provou que não paga.
2. **Cobrança cortês** — recuperar o devido de forma amigável (é vizinho, é cliente da feira; humilhar perde o cliente **e** o dinheiro).

## Decisões

### D1 — Lista negra por cliente (manual + sugestão da IA, o dono confirma)
Flag na ficha de crédito do cliente (`comigo_customer_credit`): `blacklisted`, `blacklisted_at`, `blacklisted_reason`, `blacklist_source`.
- **Manual:** o dono marca/desmarca a qualquer momento.
- **Sugerida:** uma regra simples detecta inadimplência crônica (saldo vencido além de N dias, ou liberações acima do limite repetidas) e **sugere** a lista negra — **nunca marca sozinha** (mesmo princípio do ADR-091 §6: a IA recomenda, o dono decide). A sugestão vira um aviso; o dono confirma para valer.

### D2 — Suspensão de venda (fiado sempre; tudo, opcional)
Interpretação: "suspender venda" tem dois graus, e o dono escolhe:
- **Padrão — suspende o FIADO (bloqueio duro, sem override):** cliente na lista negra **não** fecha mais no fiado. Diferente do limite do ADR-112 (que avisa e libera): a lista negra é a linha que **não** se cruza — é o sentido dela. Ele ainda pode comprar **à vista** (não se recusa dinheiro).
- **Opcional — `block_all_sales` (suspensão total):** flag por cliente (default desligada) que, ligada, **suspende qualquer venda** (inclusive à vista), com aviso claro no Balcão. Cobre o "não vendo mais pra esse" literal, sem impor isso a todos por padrão.

O Balcão sempre mostra o porquê (*"Cliente na lista negra desde 12/03 — fiado suspenso"*), nunca um erro seco.

### D3 — Cobrança amigável e cortês (recuperar sem constranger)
Régua de lembretes **gentis** sobre saldo em aberto, via WhatsApp (reusa a entrega de mensagem do core), **opt-in** (`comigo_fiado_reminder_enabled`) + disparo **manual** pelo dono ("Enviar lembrete gentil") por cliente.
- **Tom:** cordial, sem ameaça, sem vexame — extensão do guarda-corpo do tutor (ADR-088 D6): *ensinar sem humilhar* vira *cobrar sem constranger*. Ex.: *"Oi Fulano! Passando só pra lembrar com carinho que ficou R$45 do fiado. Quando puder dá um jeitinho? Qualquer coisa a gente parcela 🙂"*.
- **Régua suave (dias após a compra/vencimento):** D+3 lembrete carinhoso · D+10 segundo toque · D+20 proposta de parcelar/conversar. Configurável; nunca escala para tom agressivo.
- **Frugal (ADR-088 D5):** templates prontos primeiro; LLM só para personalizar o tom quando ligado — o texto-base é template, zero-token.
- **Lista negra ≠ parar de cobrar:** quem está na lista negra **continua** recebendo cobrança cortês (queremos o dinheiro de volta) — só não ganha fiado novo.
- **LGPD:** dívida é dado sensível do cliente — só se comunica **com o próprio devedor**, nunca expõe a terceiros; auditoria em toda escrita/envio.

## Modelo de dados (estende ADR-112)
- **`comigo_customer_credit`** ganha: `blacklisted INTEGER DEFAULT 0`, `blacklisted_at`, `blacklisted_reason`, `blacklist_source ('manual'|'suggested')`, `block_all_sales INTEGER DEFAULT 0`.
- **`comigo_fiado_reminders`** — `id, organization_id, contact_id, order_id?, level, channel, template_key, body, status ('sent'|'failed'), created_by, created_at`.
- `organization_settings`: `comigo_fiado_reminder_enabled INTEGER DEFAULT 0`, `comigo_fiado_reminder_cadence` (JSON da régua), `comigo_blacklist_suggest_days INTEGER DEFAULT 20`.

## Escopo (encaixe nos PRs)
- **PR #1 (schema):** cria as colunas de lista negra em `comigo_customer_credit` + `comigo_fiado_reminders` + settings. (Este PR.)
- **PR #3 (Balcão):** enforcement — fiado bloqueado p/ lista negra; `block_all_sales` avisa/bloqueia à vista.
- **PR #4 (Caderneta):** marcar/desmarcar lista negra, ver sugestões, botão "Enviar lembrete gentil", régua de cobrança.

## Consequências
**Positivas:** fecha o ciclo do fiado (dar → controlar → parar → recuperar); a sugestão automática poupa o dono de rastrear inadimplência na memória; a cobrança cortês recupera dinheiro **preservando** o cliente — coerente com o tom "sócio que caminha junto" do produto.

**Trade-offs / riscos:** lista negra é decisão sensível (errar mancha um bom cliente) — por isso é do dono, reversível e auditada; cobrança automática mal calibrada irrita — por isso é opt-in, manual por padrão e com teto de tom; dívida é PII sensível — comunicação só com o devedor.

## Guardas
- Lista negra suspende fiado com bloqueio duro; suspensão total é opt-in por cliente.
- IA **sugere** lista negra; quem marca é o dono (ADR-091 §6).
- Cobrança sempre cortês, nunca ameaçadora; opt-in + manual por padrão.
- LGPD: dívida só se fala com o próprio devedor; auditoria e isolamento por `organization_id`.

## Testes
`test:comigo-fiado` (estendido) — blacklist bloqueia fiado (sem override); `block_all_sales` bloqueia à vista; sugestão dispara após N dias mas não marca sozinha; lembrete cortês gera registro em `comigo_fiado_reminders`; blacklisted ainda recebe cobrança.
