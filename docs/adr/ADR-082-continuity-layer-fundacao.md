# ADR-082 — ZappFlow Continuity Layer: fundação (eventos, idempotência, contingência)

**Status:** Aceito (fundação e faseamento; Fase 0 é hotfix de produção, Fases 1+ implementação sob feature flag).

**Origem:** PRD "ZappFlow Continuity Layer" + inventário do repositório. O produto foi construído como SaaS conectado à nuvem; quando a internet do cliente cai, o ponto de operação (navegador) exibe informações enganosas, perde ações locais e pode deslogar o usuário. Este ADR fixa as decisões de arquitetura da camada de continuidade **antes** de construí-la, porque é uma mudança **transversal** (mexe em envio de mensagem, autenticação, socket e store) e tem risco de regressão maior que os módulos aditivos anteriores.

---

## Contexto

### Falhas confirmadas no código (não hipóteses)

O inventário validou o diagnóstico do PRD linha a linha:

- **Mensagem fantasma** (`src/store/useStore.ts:477-514`): o `set()` que adiciona a mensagem à tela roda **incondicionalmente**; a chamada nem checa `res.ok`, então **um HTTP 500 (provedor recusou) também aparece como "enviado"**. O mesmo bug existe em **`toggleAiPaused`**. No backend, a rota manual (`src/server/routes/messages.ts:45-59`) **envia→grava** e devolve 500 sem persistir nada em caso de falha.
- **Logout indevido por queda de rede** (`src/contexts/AuthContext.tsx:41-53`): o `.catch` de `/api/auth/me` **não distingue** 401/403 de erro de rede/DNS/timeout — qualquer falha apaga token+usuário e cai na tela de login.
- **Reconexão sem resync** (`src/App.tsx:98-102`): `socket.on('connect')` só faz `join_org`; `hydrate()` roda apenas no efeito do token. Eventos emitidos durante a queda **se perdem**.
- **Sem indicador de conectividade**, **sem PWA real** (`vite.config.ts` só react+tailwind; sem Service Worker, Workbox, IndexedDB), **sem idempotência**, **sem event log / delta sync** (o ADR-007 já admite: "não há barramento de eventos no core").

### O que já existe e é reaproveitável (o PRD subestima)

- **O padrão correto de envio já está no backend**: o fluxo do bot (`webhookProcessor.ts:855-900`) **grava primeiro**, depois envia, marca `delivery_status='sent'|'failed'` e emite `message_delivery_failed`. A rota manual é a única sem essa disciplina — corrigir a fantasma é **espelhar um padrão existente**.
- **Fila de jobs** (`JobQueueService`/`background_jobs` + `setImmediate` + `sweepStale`): backbone reutilizável para a fila de entrega ao provedor.
- **Outbox resiliente já materializado no Vision** (`vision_webhook_deliveries` + `webhookDispatcher.ts`): retry com backoff exponencial + HMAC-SHA256 + idempotency-key, rodando. É o **molde concreto** para a fila de saída ao WhatsApp e para o outbox do Edge.
- **Isolamento de processo do Vision** (`scripts/supervisor.ts`, SQLite próprio em `apps/vision-cloud/db.ts`, auth de máquina por API-key bcrypt em `gateways.ts`): esqueleto do "ZappFlow Edge genérico".

### Nuance importante

O **outbox Edge→Cloud** (`vision_sync_outbox`) e o `/api/vision/sync` do ADR-007 estão **apenas decididos, não implementados**. O precedente concreto a generalizar é o **dispatcher de outbox de webhooks** (Cloud→externo), não o sync bidirecional do ADR-007 — que ainda é papel.

## Decisão

### D1. Continuity Layer é capacidade transversal do OS, em três níveis

Não é recurso de um módulo (CRM/WhatsApp/restaurante). É uma camada horizontal em três níveis, implementada de fora para dentro conforme a necessidade:

```
Continuity Browser  — PWA + IndexedDB + Outbox de comandos
Continuity Cloud    — Comandos idempotentes + Event log + Delta sync + Fila de entrega
ZappFlow Edge       — Operação local entre dispositivos na LAN
```

O **servidor continua a fonte da verdade**; o navegador passa a manter uma cópia local protegida e uma fila durável de comandos.

### D2. Fase 0 é hotfix de produção, isolado e primeiro

As correções de integridade (fantasma, logout, reconexão, indicador de conectividade, estado real de envio) saem **antes** e **desacopladas** da visão maior, atrás de mudanças localizadas e testes de queda. São bugs de produção, não melhoria futura. Construir Edge/outbox sem corrigir isso levaria os mesmos erros para dentro da LAN.

### D3. Idempotência anda PAREADA com o outbox, nunca depois

O PRD ordena outbox (Fase 1) antes da idempotência (Fase 2). Invertemos parcialmente: **no minuto em que existir uma fila que faz retry, o servidor precisa aceitar `command_id` e deduplicar** — senão o próprio outbox gera os duplicados que o PRD teme (mensagens/pedidos/reservas em dobro). A aceitação de idempotency-key nos comandos críticos entra **com (ou logo antes de)** o outbox do navegador.

### D4. Event log com sequência por org é a fonte do delta sync; Socket.IO vira apenas notificador

Criamos `domain_events` com **sequência monotônica por organização** (`event_id` crescente), `aggregate_type`/`aggregate_id`, `event_type`, `payload`, `created_at`. O Socket.IO deixa de ser fonte da verdade: passa a **avisar que algo mudou**; na reconexão o cliente pede `GET /events?after=<lastEventId>` e recebe o delta. Isso substitui o "refresh manual" e elimina a perda de eventos. Na Fase 0, um `hydrate()` na reconexão é o paliativo até o delta sync existir.

### D5. Command bus começa pelos 2-3 comandos de maior risco, não universal

Nada de envelope genérico para toda ação de uma vez. A idempotência+outbox começam por **enviar mensagem, mover ticket e fechar ticket** (os de maior dano se duplicados/perdidos), e expandem incrementalmente. `client_commands` guarda `command_id, organization_id, device_id, user_id, operation_type, status, attempts, created_at, processed_at`.

### D6. Reusar o dispatcher de outbox do Vision; não reinventar

A fila de entrega ao provedor (Fase 3) e o outbox do Edge (Fase 4) reaproveitam o **padrão do `webhookDispatcher` do Vision** (retry/backoff/HMAC/idempotency-key) sobre a fila de jobs existente, em vez de uma segunda arquitetura de contingência.

### D7. Service Worker cacheia só o app shell; dado de tenant em IndexedDB por usuário

Terminais de clínica/loja/PDV são compartilhados. O SW cacheia **apenas o shell** (JS/CSS/assets), **nunca** respostas autenticadas de API. Dados de tenant vivem em **IndexedDB escopado por usuário** e são **limpos no logout**. É requisito de segurança/LGPD, não detalhe de implementação.

### D8. Auth distingue sessão inválida de falha de rede

Só **401/403** encerram a sessão. Timeout/DNS/servidor indisponível **mantêm** a sessão e ativam o **modo de contingência**. A interface nunca mais desloga por queda de rede.

### D9. Nenhuma ação aparece como concluída sem confirmação do servidor

`sendMessage` e `toggleAiPaused` (e os demais comandos) deixam de atualizar a UI incondicionalmente. Estados obrigatórios visíveis: `draft → pending → syncing → sent → failed → conflict → cancelled`. A mensagem só mostra "enviado" após confirmação real (espelhando o fluxo do bot: persistir com `delivery_status`).

### D10. Feature flags por fase; mudança horizontal exige cautela

Diferente de Prospect/Clínica (aditivos), esta é uma mudança **horizontal**. Cada fase entra atrás de feature flag, com testes que **simulam a queda** (os 10 cenários do PRD). A Fase 0 é localizada (segura); Fases 1-2 são arquiteturais.

### D11. Plano de fases

- **Fase 0 — Integridade (hotfix):** fantasma (rota manual grava-primeiro com `delivery_status` + front só mostra "enviado" após confirmação; idem `toggleAiPaused`); auth distingue 401/403 de rede (D8); badge de conectividade; `hydrate()` na reconexão; estados de envio visíveis.
- **Fase 1+2 (pareadas) — Continuity Cloud + Outbox do navegador:** `domain_events` + delta sync (D4); `client_commands` + idempotency-key nos comandos críticos (D3, D5); IndexedDB + outbox no navegador com os estados de D9.
- **Fase 1b — Outbox do navegador (entregue):** IndexedDB + fila `pending→syncing→sent|failed` (D9), reenvio idempotente por `commandId`, flusher ao voltar `online`.
- **Fase 1c — PWA real (entregue):** `vite-plugin-pwa`/Workbox cacheando **só** o app shell (`navigateFallback` para `/index.html`, denylist para `/api` e rotas públicas; sem `runtimeCaching` da API, então dado por-tenant nunca encosta no cache); IndexedDB de continuidade limpo no logout (D7).
- **Fase 3 — Fila de entrega ao provedor (entregue):** `message_deliveries` separa "salvo no ZappFlow" de "entregue ao WhatsApp" — a mensagem grava como `queued` e um dispatcher no core tenta o provedor com retry/backoff exponencial (`30,120,600,1800,7200,21600`s, teto 6), evoluindo `queued→sent→delivered/failed` (mesmo padrão do `webhookDispatcher` do Vision, D6). Atrás da flag `CONTINUITY_DELIVERY_QUEUE_ENABLED` (default OFF → `/send` inline intacto). Painel atualizado ao vivo por `message_delivery_status` (casa pelo `command_id`). `delivered` é gancho pronto (`markDelivered`) para o webhook de status do provedor.
- **Fase 4 — ZappFlow Edge genérico:** generalizar supervisor + SQLite próprio + outbox + auth de máquina; construir o sync Edge↔Cloud que nem o Vision tem ainda (ADR-007). Por ser a fatia mais pesada e horizontal, é decomposta em sub-fases reviewáveis:
  - **Fase 4a — Protocolo de sync no Cloud (entregue):** a superfície que qualquer nó Edge conversa com o servidor, sem processo novo. Tabela `edge_devices` (registro de nós por org, `cursor`, `last_seen_at`); auth de MÁQUINA por API key (`edg_*` + segredo, só o hash bcrypt persiste, headers `X-Edge-Device`/`X-Edge-Key`) — generalizando o gateway do Vision. `POST /api/edge/pull` (delta de `domain_events` via `ContinuityService.since`, fora do `protectedApi`), `POST /api/edge/push` (lote idempotente do outbox do nó → `client_commands`, dedupe por `command_id`, o `idempotency_key` do ADR-007 concretizado), `POST /api/edge/heartbeat`. Provisionamento (`/api/edge/devices`) sob JWT de owner/admin. Atrás da flag `CONTINUITY_EDGE_SYNC_ENABLED` (default OFF → 503). Isolamento por org em pull/push/revogação.
  - **Fase 4b — Runtime do Edge (entregue):** `apps/edge` — processo STANDALONE que roda on-premise no cliente (deploy separado da nuvem; o supervisor da nuvem fica intocado, mas o mesmo padrão de `scripts/supervisor.ts` pode supervisioná-lo no site via `/health`). SQLite PRÓPRIO e local (`edge.db`, `EDGE_DATA_DIR`) com `edge_outbox`/`edge_inbox`/`edge_state`. Outbox local copiando o lease/backoff do `MessageDeliveryService` (pré-claim antes da rede, idempotência ponta a ponta por `command_id`). `EdgeSyncClient` dirige um ciclo `heartbeat → push → pull` contra a Fase 4a; transporte plugável (`HttpEdgeTransport` real / in-process nos testes). Entrypoint expõe `/health` + `/enqueue` (intake local offline) e roda o loop (`build:edge`/`start:edge`/`dev:edge`). Puxar/aplicar os eventos do `edge_inbox` por agregado continua na 4c.
  - **Fase 4c — Reconciliação bidirecional (entregue):** fecha o loop nas duas pontas. **Edge→Cloud:** `EdgeInboxProcessor` (core) pega os comandos `received` em `client_commands`, executa um handler POR TIPO (registry + handler padrão que emite `edge.command.applied`), marca `processed`/`failed` (com teto de tentativas) e ANEXA um domain_event — o resultado volta a fluir no delta. **Cloud→Edge:** `EdgeInboxApplicator` (nó) aplica o `edge_inbox` em ordem de `seq` na projeção local `edge_aggregates`, idempotente e last-write-wins pelo `seq` monotônico (o versionamento otimista do ADR-007 D3, com `seq` como versão; reaplicar seq ≤ é no-op). Chamado ao fim do `syncOnce`. Materializar cada tipo em tabela dedicada (eventos "gordos") e a deriva de relógio (D5) ficam como evolução conforme mais agregados emitem payload completo.

> **Fase 4 completa** — com 4a (protocolo Cloud), 4b (runtime do Edge) e 4c (reconciliação), o ZappFlow Edge genérico existe: um nó on-premise com banco próprio, outbox durável e sync bidirecional idempotente contra a nuvem — o que nem o Vision tinha (ADR-007 saiu do papel, de forma genérica). Encerrada a Fase 4, **toda a Continuity Layer desta ADR está entregue** (Fases 0, 1, 1b, 1c, 3, 4a-c).

## Consequências

**Positivas:**
- A falha mais perigosa (funcionário achar que respondeu quando não respondeu) morre já na Fase 0, barata e localizada.
- Reaproveita padrões prontos (fluxo do bot, fila de jobs, dispatcher do Vision) — pouca infra nova nas fases iniciais.
- Vira promessa comercial forte: "sua empresa pode perder a internet, não a operação".

**Trade-offs aceitos:**
- Mudança horizontal → risco de regressão maior que os módulos; mitigado por feature flags + testes de queda por fase.
- Idempotência+outbox pareados adiam um pouco o "outbox visível" para não introduzir duplicação.
- Edge (Fase 4) inclui construir o que o próprio Vision só tem no papel (sync bidirecional) — esforço real, corretamente por último.
- Continuity Browser não faz dispositivos compartilharem dados offline entre si — isso é só no Edge (Fase 4).

## Testes (por fase, simulando a queda — os 10 cenários do PRD)

Enviar com a internet caindo no instante; 30 min offline; refresh sem conexão; 10 ações offline; dois dispositivos no mesmo registro; internet intermitente; a mesma fila sincronizando várias vezes; **nenhuma** mensagem/pedido/reserva duplicada; **nenhuma** ação confirmada some; o usuário distingue `pendente/enviado/falhou`. Cada fase entrega os testes dos cenários que cobre; a Fase 0 já cobre 1, 3, 5 (distinção de estado), 9 e 10.
