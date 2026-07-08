# ADR-058 — Webhook Processor — dispatch, assinatura de origem e fila

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. O webhook é a **superfície pública mais delicada** do backend: qualquer mensagem de cliente entra por aqui e vira resposta da IA no minuto seguinte. Uma vulnerabilidade nesta camada = SPAM em massa saindo por canais legítimos do lojista (Meta suspende número) + IA respondendo a payloads forjados (custa Gemini + corrompe CRM). ADR-029 já cobriu o mecanismo do toggle da fila; este ADR documenta o **pipeline completo** que existe hoje (dispatcher único + validação de origem por provedor) e os trade-offs assumidos.

---

## Contexto

O produto recebe mensagens de quatro origens distintas, cada uma com formato e mecanismo de autenticidade próprio:

- **WhatsApp Cloud (Meta)** e **Instagram (Meta)** — mesma rota `/api/webhooks/meta`. Autenticidade via `META_VERIFY_TOKEN` no handshake GET; POST vem sem nosso segredo.
- **Evolution API / Evolution Go (WhatsApp não-oficial)** — rotas `/api/webhooks/evolution*`. Autenticidade por segredo compartilhado (header `x-webhook-secret` ou query `?secret=`).
- **Meta faz retry** se o webhook demorar > ~5s; Evolution também retransmite em cascata. Processar inline (IA + Gemini + envio de retorno) pode passar do orçamento em produção → precisa de fila.

Cada provedor tem também um formato de payload diferente (Evolution GO em Pascal, Evolution API em camel, Meta com `entry[].changes[]` etc.). Consolidar num único ponto interno é o que permite tratar segurança e SLA no mesmo lugar.

## Decisão

**Regras invioláveis do processador de webhook:**

1. **Ponto único** — todo webhook aprovado chama `dispatchIncomingMessage(payload, io)` em `src/server/webhookProcessor.ts`. Nada de `processIncomingMessage()` direto de handler HTTP. Isso garante que a decisão inline-vs-fila seja **uma única linha** de código.
2. **Validação de origem por provedor**, ANTES do dispatch:
   - **Evolution:** `verifyWebhookSecret()` (server.ts) exige o segredo guardado por `src/server/webhookSecurity.ts` (auto-gerado, persistido em `app_config.webhook_secret`, override via env `WEBHOOK_SECRET`). Cada rejeição grava `recordWebhookHit(false, ...)` para o dono ver na tela por que a Evolution parou de entregar.
   - **Meta:** `META_VERIFY_TOKEN` no GET de handshake; POST autenticado pelo `payload.object` estar na allowlist (`whatsapp_business_account | instagram | page`). Trade-off assumido abaixo.
3. **Toggle da fila com default correto por ambiente** (Fase 1 do plano):
   - `NODE_ENV=production` → fila LIGADA por padrão (webhook responde 200 na hora, worker processa em background — protege o SLA da Meta/Evolution).
   - Desenvolvimento → fila DESLIGADA (inline é mais fácil de debugar).
   - Env `WEBHOOK_QUEUE_ENABLED=true|false` sempre vence.
4. **`maxAttempts: 1`** no job — DELIBERADO. Retry automático de mensagem que falhou no meio duplicaria a resposta da IA ao cliente. Falha vira registro auditável na fila, não reprocesso silencioso (mesma decisão da ADR-029, mantida por escrito aqui porque é a superfície onde o risco realmente aparece).
5. **Enforce opt-in**, com auto-provisionamento — `webhookSecurity.ts` gera o segredo na 1ª vez sem exigir intervenção humana, mas `isWebhookEnforced()` começa `false` para não quebrar setups antigos antes do dono atualizar a URL na Evolution. Um `console.warn` toda inicialização avisa que o webhook está aberto.

## Consequências

**Positivas:**
- Um único ponto de entrada para todo o pipeline crítico de atendimento — impossível rota nova esquecer a fila/segurança.
- Segredo auto-gerado/persistido (`whk_...`) elimina o modo "esqueci de setar env, webhook fica aberto pra sempre".
- `MetaWebhookLogService` grava TODA chamada (aceita ou rejeitada), incluindo motivo — o dono não fica no escuro quando o Instagram para de entregar.
- Fila com `maxAttempts=1` + `delivery_status` na mensagem = falha visível ao lojista sem risco de duplicar resposta.

**Trade-offs aceitos:**
- **Autenticidade Evolution é fraca (só token compartilhado)** — quem descobrir a URL + segredo consegue injetar mensagens. Mitigado por: segredo rotacionável (`rotateStoredWebhookSecret`), HTTPS obrigatório e o próprio isolamento multi-tenant (payload sem canal casado é descartado com aviso).
- **Meta POST não valida `X-Hub-Signature-256`** hoje — confia no handshake GET com `META_VERIFY_TOKEN`. Aceitável porque a URL do webhook não é descoberta trivialmente, mas é o próximo item de hardening.
- **Sem rate limit por origem** no webhook (o `express-rate-limit` global exclui `/api/webhooks/*` deliberadamente para não bloquear provedores legítimos). Um atacante com o segredo pode inundar até estourar a fila.
- Fila desligada em dev significa que bugs de serialização de job só aparecem quando alguém liga em staging — mitigado pelo teste automatizado abaixo.

## Testes

- `scripts/test-nfe-signature.ts` (npm run test:nfe-signature) — cobre o **toggle da fila** nos dois modos (flag off = inline preservado; flag on = job enfileirado com `maxAttempts=1` e worker entrega payload intacto ao handler). Referenciado aqui para não duplicar em outro script.
- `scripts/test-meta-webhook-debug.ts` (npm run test:meta-webhook-debug) — cobre `MetaWebhookLogService`: verificação GET com/sem token, POST com `payload.object` desconhecido, headers registrados, marcação `processed`/`failed` com motivo.
- `scripts/test-vision-webhooks.ts` — cobre parsing de payload de mídia (fluxo do WhatsAppInventoryIntake) que também entra por este dispatcher.

Segurança do webhook Evolution (segredo obrigatório vs. modo aberto) hoje é validada manualmente via UI (Integrações › Segurança do WhatsApp); um script dedicado é próximo passo natural — mesma abordagem do `test-connector-public.ts` (ADR-052) aplicada a `/api/webhooks/evolution`.
