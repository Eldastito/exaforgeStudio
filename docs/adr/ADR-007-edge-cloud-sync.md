# ADR-007 — Edge ↔ Cloud Sync

**Status:** Aceito
**Data:** Fase 0

## Contexto

O PRD (§23) exige sincronização baseada em outbox/inbox, nunca replicação bidirecional de banco ou vídeo contínuo. Não existe hoje nenhum mecanismo de outbox no codebase. O precedente mais próximo é o **retry idempotente de lembretes de PIX** em `Scheduler.ts` (progressão de tentativas, ex. 5 min, progressivos) — útil como referência de disciplina de retry, mas não é um outbox de eventos de domínio.

Também não existe hoje nenhum barramento de eventos no core (achado da reconciliação: `AIOrchestratorService` e `webhookProcessor.ts` acoplam-se a outros serviços via import direto, sem `EventEmitter`/pub-sub). Isso é relevante porque a "porta de entrada" dos eventos Vision no Cloud (Maestro, RIC, Diretor Executivo IA) precisará de um consumidor de eventos, ainda que o transporte Edge→Cloud em si seja resolvido por este ADR.

## Decisão

1. **`vision_sync_outbox` vive no SQLite local do Edge** (Local Metadata Store, ADR-002), como fila append-only. Um Sync Agent, dentro do processo/serviço vision-edge, drena essa fila para o Cloud via chamadas HTTPS autenticadas, cada uma carregando `idempotency_key`.
2. **Cloud expõe um endpoint de ingestão único (`POST /api/vision/sync`)** que faz upsert por `idempotency_key` (constraint de unicidade) — reentrega após falha de rede nunca duplica evento/incidente. Esse é o mesmo princípio de idempotência já disciplinado no retry de PIX do `Scheduler.ts`, aplicado agora a um contexto de sincronização Edge↔Cloud.
3. **Eventos são imutáveis; incidentes/configurações são versionados** (coluna `updated_at`/versão para concorrência otimista); **evidências nunca são sobrescritas silenciosamente** — a camada de ingestão no Cloud rejeita qualquer tentativa de "atualizar" um registro de evidência já existente; toda mudança gera novo registro versionado.
4. **Nunca sincronizar vídeo contínuo por padrão** (PRD §23.3) — apenas status, inventário, configuração, eventos, incidentes, tarefas, métricas, logs, metadados de evidência e comandos/respostas de controlador. Clipes só sobem quando a política do tenant permitir (ex.: evidência de incidente crítico).
5. **Clock drift**: o `detected_at` do Edge é a fonte de verdade para ordenação de eventos dentro do próprio site; a divergência entre relógio do Edge e da Cloud é monitorada e, se ultrapassar um limiar, gera o evento `clock_drift_detected` (já modelado no PRD §12.2) em vez de silenciosamente confiar no relógio do Edge para qualquer correlação entre sites.
6. **Falha de sincronização não impede operação local** — reforça o princípio "Edge continua operando" do PRD (§18): o outbox simplesmente cresce localmente até a conectividade retornar; não há perda de dados, apenas atraso de visibilidade no Cloud.
7. **Barramento de eventos interno do Cloud** (consumo por Maestro/RIC/Diretor Executivo IA) é tratado como gap de infraestrutura pré-existente do projeto, não específico do Vision — ver item correspondente na matriz de reconciliação (`docs/PRD-VISION-VMS-RECONCILIACAO.md`, bloco 3). Este ADR resolve apenas o transporte Edge→Cloud; a distribuição do evento dentro do Cloud para os demais serviços é uma decisão de arquitetura de eventos mais ampla, que deve ser avaliada uma única vez (não duplicada por módulo) e não é reaberta aqui para não conflitar com decisões futuras de outras áreas do produto.

## Licenças

Não aplicável — mecanismo próprio, sem dependência de terceiros para fila (SQLite local + HTTPS já cobertos pela stack existente).

## Riscos

- **Médio**: implementação incorreta de idempotência é o principal risco (duplicar eventos/incidentes após retry) — mitigado por constraint de unicidade em `idempotency_key` no banco (falha rápida e visível em vez de duplicação silenciosa) e por teste de integração específico já previsto no PRD (§29: "Edge offline → outbox", "Edge online → sync").
- **Baixo**: acúmulo de outbox sob desconexão prolongada — mitigado por ser apenas metadados/eventos (não vídeo), volume relativamente baixo mesmo em dias de desconexão.
- **Médio**: autenticação Edge↔Cloud precisa de mecanismo próprio (API key de gateway ou JWT de serviço), distinto do JWT de usuário do core — deve ser tratado com o mesmo rigor de segredo que `EncryptionService` já aplica a outros tokens (nunca em texto plano, rotação documentada).

## Custo

Baixo — reaproveita infraestrutura HTTP e SQLite já existentes; não introduz fila externa (Redis/RabbitMQ/Kafka) nesta fase, mantendo a filosofia de "menor infraestrutura nova possível" do restante do projeto.

## Segurança

Outbox/inbox com idempotency key evita reprocessamento malicioso ou acidental de eventos (replay). Autenticação de serviço (não de usuário) reduz superfície de abuso caso um token vaze.

## Impacto de manutenção

Baixo-médio — precisa de observabilidade dedicada (quantos itens pendentes no outbox por site, tempo médio de drenagem) para detectar Edges "silenciosamente" desconectados há muito tempo, o que por si é um sinal de saúde a expor no Gateway Health Console (PRD §10.6/§17.1).

## Plano de rollback

Se o Sync Agent apresentar bug crítico, pode ser desligado sem impacto na operação local do Edge (live view, gravação, eventos continuam) — o único efeito é a Cloud ficar com visibilidade atrasada até a correção e reativação, sem perda de dados (outbox local preserva tudo).
