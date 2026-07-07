# ADR-044 — Correção do envio de DM no Instagram + itens Vision software-only + housekeeping

**Status:** Implementado.

**Origem:** (1) Um lojista real relatou que a IA não estava respondendo suas DMs do Instagram, apesar do painel mostrar a resposta como se tivesse ido — investigação mostrou que era um bug de host/token, não configuração. (2) Aproveitar o mesmo PR para fechar itens do Vision/VMS que são software-only (não dependem do Vision Edge físico) e um cleanup de copy.

---

## 1. Instagram DMs — a IA respondia no painel, mas não chegava no cliente

**Causa raiz** (identificada linha a linha): a conexão OAuth do Instagram usa o produto **"Instagram API with Instagram Login"**, cujo token é válido **apenas contra `graph.instagram.com`**. Mas `MessageProviderService.sendMessage` estava postando em `https://graph.facebook.com/v19.0/{ig_id}/messages` (host do Messenger antigo/Facebook Login). A Meta rejeitava a chamada, o erro era engolido pelo `try/catch` genérico em `webhookProcessor.ts:852`, a mensagem do bot era persistida e emitida via socket para o painel — e o cliente no Instagram não recebia nada. Sintoma que o lojista via: "a IA aparece respondendo, mas ninguém recebe".

**Correções aplicadas:**
1. **Host correto**: `MessageProviderService.ts` agora posta em `https://graph.instagram.com/v21.0/me/messages` para `provider = 'instagram'` — mesmo host usado por `InstagramService` para o resto das chamadas com o mesmo token. WhatsApp Cloud continua em `graph.facebook.com` (não regrediu — coberto por teste).
2. **Inscrição automática no webhook `messages`**: após o OAuth guardar o canal, chama `POST graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages`. Sem essa inscrição, a Meta **nunca** entrega as DMs no nosso webhook, e o lojista fica cego. Antes essa era uma etapa manual no App Dashboard.
3. **Erro visível em vez de silencioso**: duas colunas novas em `messages` (`delivery_status`, `delivery_error`). Quando o envio quebra, marcamos `failed` + motivo, emitimos `message_delivery_failed` no socket e disparamos uma **notificação de alerta** (dedupe 60min por canal): *"Resposta da IA não chegou ao Instagram. Reconecte o canal ou verifique escopos/inscrição do webhook."*

Assim, mesmo que amanhã um token expire ou o escopo mude, o lojista vai saber — não vai passar horas descobrindo que perdeu clientes.

## 2. Vision/VMS — 4 itens software-only fechados

**Calculadora de armazenamento (§16.2)** — função pura `calculateStorage()` + endpoint `POST /api/vision/storage/calc`. Aceita câmeras, resolução, codec (H.264/H.265/MJPEG), FPS, horas/dia, dias de retenção, factor de gravação por movimento; devolve GB/TB estimados. Bitrates de referência conservadores (720p/1080p/2K/4K @ 15 fps em H.264). Testes cobrem os escalares de codec e sanidade de input inválido. Serve para o lojista dimensionar disco **antes** de comprar hardware.

**Auditoria de acesso a evidências (§19.1, LGPD)** — nova tabela `vision_access_logs` (org, user, câmera, site, `action ∈ live_view|playback|export|snapshot`, target_ref, janela de tempo do playback, UA, IP). Serviço `recordAccess`/`listAccess` best-effort (nunca lança para a rota chamadora). Rota `GET /api/vision/access-logs` restrita a `vision_admin` + `evidence_auditor`. As chamadas de gravação real (streaming, playback, export) — que ainda não existem — chamarão `recordAccess()` quando forem implementadas.

**Webhook `vision.event.reviewed`** — topic novo emitido em toda transição de revisão de evento (`acknowledge/resolve/false_positive/escalate`), não só na criação do incident. Fecha o ciclo de vida do evento para integrações externas (BI, sistema de rondas).

**Descoberta importante**: o `docs/PRD-VISION-VMS-RECONCILIACAO.md` listava "Webhooks de saída — NÃO EXISTE" como gap, mas `webhookDispatcher.ts`, `enqueueWebhookDeliveries` e o CRUD administrativo já existem e funcionam com HMAC + retry + backoff. O documento estava desatualizado; só faltava emitir o topic de revisão.

## 3. Housekeeping

`SettingsView.tsx:415` dizia "IA gera imagens (**e em breve vídeos**)" — corrigido para "**imagens e vídeos**". O `StudioService.startVideo` via Google Veo já estava em produção; a copy só não tinha sido atualizada.

## Testes

`scripts/test-instagram-fix-vision-batch.ts` — **24 verificações**. Instagram usa `graph.instagram.com` (não regride para `graph.facebook.com`); WhatsApp Cloud continua no host antigo; colunas `delivery_status/error` persistem; calculadora de storage bate as fórmulas (com ±3% de tolerância); codec H.265 ≈ 50% do H.264 e MJPEG ≈ 5×; access logs registram/listam/filtram/isolam por tenant; webhook `vision.event.reviewed` valida e enfileira.

Regressão completa (isolamento, sla-barcode-consult-sheets, ean-radar-consultation, seo-reactivation-categories) sem quebras.
