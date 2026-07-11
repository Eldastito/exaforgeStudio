# Runbook — Ativação da Continuity Layer em produção (ADR-082)

Guia operacional para **ligar gradualmente** as flags da camada de resiliência,
observando o impacto a cada passo e sabendo como reverter. Todo o código já está
mergeado e testado; ativar é uma ação de **operação** (variáveis de ambiente no
deploy), não de código.

> **Regra de ouro:** uma flag por vez, observando `GET /api/admin/continuity/health`
> por algumas horas antes da próxima. Todas nascem **desligadas** — o
> comportamento atual não muda até você ligar.

## Onde as flags ficam

São variáveis de ambiente do serviço `core` (no painel do deploy — Coolify).
Depois de alterar, **faça restart/redeploy do container**: os timers de fundo
(`MessageDeliveryService`, `EdgeInboxProcessor`) fazem *self-gate* no **boot** —
ligar a flag sem reiniciar não sobe o dispatcher.

| Flag | O que liga | Raio de impacto | Default |
|---|---|---|---|
| `CONTINUITY_EVENTS_ENABLED` | Grava `domain_events` (event log + delta sync) | Só escrita de eventos; nenhuma mudança no envio | OFF |
| `CONTINUITY_DELIVERY_QUEUE_ENABLED` | Envio (manual **e** bot) passa pela fila com retry/backoff e recibos de entrega | Muda o caminho de saída de mensagens | OFF |
| `CONTINUITY_EDGE_SYNC_ENABLED` | Protocolo de sync do Edge + processamento do inbox | Só relevante se houver nó Edge implantado | OFF |

## Painel de observação

- **Cross-tenant (master-admin):** `GET /api/admin/continuity/health` — flags
  ligadas, fila agregada (`queued/sent/delivered/failed`), `oldestQueuedAt`,
  `stuckQueued` (fila com 3+ tentativas = canal quebrado), `deliveredLast24h`,
  `failedLast24h`, total de eventos e nós Edge.
- **Por organização:** `GET /api/continuity/status` (JWT do dono) — a mesma
  visão para uma única org.

Sinais de alerta durante o rollout:
- `stuckQueued` subindo → algum canal está recusando (token/escopo). Investigue o
  canal, não a camada.
- `oldestQueuedAt` muito antigo → dispatcher não está drenando (checar se o
  container reiniciou após ligar a flag).
- `failedLast24h` alto logo após ligar → provável canal mal configurado.

## Sequência recomendada (menor → maior risco)

### Passo 1 — `CONTINUITY_EVENTS_ENABLED=true`
O mais seguro: só passa a **gravar** `domain_events`. Melhora a reconexão (delta
sync) sem tocar no caminho de envio.
- **Verificar:** `events.total` no health cresce conforme há atividade; nenhuma
  mudança em entrega. Reconectar o painel após uma queda recupera o que faltou.
- **Reverter:** remover a flag + restart. Os eventos já gravados ficam (inertes).

### Passo 2 — `CONTINUITY_DELIVERY_QUEUE_ENABLED=true`
Envio de mensagens (rota manual **e** respostas do bot) passa a ir pela **fila de
entrega**: `queued → sent → delivered/failed`, com retry/backoff e recibos reais
do WhatsApp ("entregue ✓✓").
- **Pré-requisito:** Passo 1 ligado (para os eventos de entrega fluírem no delta).
- **Verificar:** mande uma mensagem de teste; o balão deve percorrer
  `enviando… → na fila… → enviada ✓ → entregue ✓✓`. No health, `sent`/`delivered`
  sobem e `stuckQueued` fica em 0.
- **Reverter:** remover a flag + restart. O envio volta ao caminho **inline** de
  sempre. Entregas que ficaram `queued` são retomadas se a flag for religada
  (o dispatcher pega as vencidas no boot) — não se perdem.

### Passo 3 — `CONTINUITY_EDGE_SYNC_ENABLED=true` (opcional)
Só ligue quando for **implantar um nó Edge** no cliente. Sem um nó rodando
(`apps/edge`, `build:edge`/`start:edge`) e provisionado (`POST /api/edge/devices`),
não há efeito. Liga o protocolo de sync e o processamento do inbox de comandos.
- **Verificar:** `edge.devices`/`edge.active` no health; `edge.lastSeenAt` recente
  quando o nó bate heartbeat.
- **Reverter:** remover a flag + restart. Os nós param de sincronizar; nada se
  perde (o outbox do nó segura os comandos até religar).

## Rollback geral

Qualquer passo se reverte removendo a flag e reiniciando o container. Nenhuma
migração é destrutiva (as tabelas ficam, inertes). Como o caminho antigo (inline)
é preservado atrás de cada flag, desligar restaura exatamente o comportamento
anterior.
