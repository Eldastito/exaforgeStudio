# ADR-011 — Hardening: RBAC central, auditoria única, fila de jobs, storage plugável

**Status:** Implementado.
**Origem:** quatro "fraquezas de produto" listadas numa análise SWOT anterior desta sessão (comparando o ZappFlow real com um relatório de mercado): RBAC ad-hoc, sem trilha de auditoria genérica, trabalho pesado síncrono (IA/webhook/PDF), e storage/processo únicos presos a uma instância. Pedido explícito do usuário: "faça o que for melhor para o projeto, cuidado para não quebrar nada, documente para manutenção futura."

## Por que estas quatro, nesta ordem

Das quatro fraquezas, duas (migração SQLite→Postgres e adapter Redis do Socket.io) foram **deliberadamente não tocadas** — só importam quando o ZappFlow rodar em mais de uma réplica, o que não é o caso hoje; mexer nelas agora trocaria simplicidade operacional por complexidade sem benefício observável, e o próprio time já documentou o gatilho certo para a migração de banco (ADR-002: quando a contenção de escrita aparecer de fato). As outras duas foram resolvidas integralmente, e a terceira (trabalho síncrono) parcialmente, com o motivo explicado em cada seção.

## 1. RBAC central (`middleware/auth.ts: requireRole`)

**Antes:** 8 checagens `if (actor.role !== 'owner' && actor.role !== 'admin') return res.status(403)...` copiadas à mão em `managers.ts`, `users.ts` e `audit.ts` — qualquer ajuste (ex.: adicionar um papel novo) exigiria lembrar de mudar em 8 lugares.

**Depois:** `requireRole(...roles)` — middleware de rota (`router.post("/x", requireRole("owner","admin"), handler)`), mesma checagem, um lugar só. Não é o RBAC granular de 9 perfis que outras análises desta sessão cogitaram (isso continua prematuro sem uso real desses papéis) — é consolidar os 3 papéis que já existem (`owner`/`admin`/`agent`).

**Caso não convertido de propósito:** `users.ts PUT /:id/phone` ("o próprio usuário OU owner/admin") é uma condição híbrida que `requireRole` não expressa sozinho (precisa do `:id` da rota) — ficou como checagem inline, sem forçar uma abstração que não caberia bem.

**Teste:** `scripts/test-rbac-audit.ts` (`npm run test:rbac-audit`).

## 2. Auditoria única (`src/server/auditLog.ts`)

**Achado maior do que o esperado:** a função `logAuthEvent` (grava em `auth_audit_logs`) já existia — mas **copiada e colada em 10 arquivos de rota** (`auth.ts`, `products.ts`, `tickets.ts`, `messages.ts`, `rag.ts`, `channels.ts`, `integrations.ts`, `admin.ts`, `appointments.ts`, `notifications.ts`), corpo idêntico em 9 delas. Ao mesmo tempo, `managers.ts` e `users.ts` faziam `INSERT` direto na tabela sem passar por nenhum helper — e tinham mutações **sem nenhum registro de auditoria**: troca de papel de usuário (`PUT /users/:id/role`, o mais sensível — pode dar acesso de admin a alguém) e remoção de gestor autorizado (`DELETE /managers/:id`).

**Decisão de não criar uma segunda tabela:** a tabela genérica `audit_logs` (organization_id/user_id/action/details) existe no schema desde antes mas nunca teve um único `INSERT` real no código — estava morta. Em vez de ressuscitá-la como um SEGUNDO sistema de auditoria paralelo (fragmentando "onde eu olho para saber o que mudou" em duas tabelas), a decisão foi: `auth_audit_logs` **é**, na prática, a trilha de auditoria genérica do produto (apesar do nome) — já cobre eventos de negócio bem além de login/segurança (`PRODUCT_UPDATED`, `STOCK_MOVEMENT`, `ADMIN_PLAN_UPDATED` etc.). Consolidar nela é menos superfície para manter do que introduzir uma segunda tabela concorrente. `audit_logs` foi deixada como está (não excluída — só não usada).

**Bug real corrigido de brinde:** `routes/audit.ts` fazia `SELECT u.username` — coluna que não existe em `users` (só `name`). A tela de auditoria do master admin quebrava com "no such column: u.username" toda vez que alguém tentava abri-la. Corrigido para `u.name`; o teste prova que a consulta antiga de fato lançava erro (não é suposição).

**Teste:** mesmo `scripts/test-rbac-audit.ts` — cobre `requireRole`, `logAuthEvent`, os dois eventos que antes não existiam, e o bug do `audit.ts` (inclusive confirmando que a versão antiga da query quebrava).

## 3. Fila de jobs em background (`JobQueueService`) — parcial, por decisão deliberada

**Achado:** o padrão "grava um job 'pending', dispara com `setImmediate`, atualiza ao terminar" **já existia**, mas só para backup (`backup_jobs` + bloco inline em `routes/integrations.ts`). Generalizado em `JobQueueService` (tabela nova `background_jobs`, registro de handler por tipo, retry até `max_attempts`, e uma varredura de segurança — chamada pelo passe rápido do `Scheduler.ts`, a cada 5 min — que reprocessa jobs presos por reinício do processo).

**Não é Redis/BullMQ.** Continua sendo um processo só, mesma limitação de sempre (documentado no próprio código). O que muda é que trabalho pesado para de rodar preso ao ciclo da requisição.

**Consumidor migrado — só um, e atrás de feature flag desligada por padrão:** a geração de PDF do relatório do Zapp gestor (dentro do processamento de webhook, `webhookProcessor.ts`) foi identificada como o offensor mais nítido — já rodava síncrono dentro do próprio pipeline de mensagem. Migrada para `JobQueueService`, mas **só quando `PDF_REPORT_ASYNC_ENABLED=true`** (padrão: `false`, comportamento 100% igual ao de antes).

**Por que não migrei o processamento do webhook inteiro também, e por que a flag existe:** `processIncomingMessage` é literalmente como o produto atende clientes reais no WhatsApp hoje, em produção. Mudar esse caminho sem poder testar contra tráfego real do WhatsApp/Evolution API é o tipo de risco que o pedido explícito ("cuidado para não quebrar nada") existe para evitar. A flag entrega a capacidade (infraestrutura pronta, testada, documentada) sem mudar nenhum comportamento observável até alguém decidir validar com tráfego real e ligar.

**Teste:** `scripts/test-job-queue.ts` (`npm run test:job-queue`) — cobre enqueue não-bloqueante, sucesso, retry até `max_attempts`, tipo sem handler, varredura de job travado, e isolamento por organização.

## 4. Storage plugável (`StorageService`) — mirror opcional para S3

**Decisão:** disco local continua sendo a **fonte de verdade** para PDF (`ReportPdfService`) e backup (`BackupService`) — nada nesse caminho muda por padrão. Quando `S3_ENABLED=true` (qualquer provedor S3-compatível: AWS S3, Cloudflare R2, Backblaze B2, MinIO — via `S3_ENDPOINT`/`S3_FORCE_PATH_STYLE`), o arquivo já escrito localmente é espelhado para o bucket **depois** de gravado, nunca no lugar disso. Se o mirror falhar (rede, credencial, bucket errado), a falha é só logada — quem chamou nunca percebe, o arquivo local continua servindo normalmente.

**Por que mirror, e não "mover para S3 e servir de lá":** trocar a fonte de verdade exigiria reescrever download/exclusão de backup (que hoje têm proteção contra path traversal — `BackupService.resolveFile` — que eu não queria arriscar tocar) e mudar o contrato de quem espera um arquivo local. Mirror é estritamente aditivo: resolve o problema real (redundância/portabilidade entre instâncias) sem tocar em nada que já funciona.

**Dependência nova:** `@aws-sdk/client-s3` (oficial, mantida pela AWS, usada por praticamente qualquer provedor S3-compatível — evita assinatura SigV4 feita à mão, que seria código sensível a segurança para acertar sozinho).

**Teste:** `scripts/test-storage-service.ts` (`npm run test:storage-service`) — confirma desligado por padrão, e o ponto mais importante: um S3 mal configurado (endpoint inalcançável) nunca impede a geração do PDF nem lança exceção.

## Resultado

6 suítes de teste, 89 verificações, todas passando: `test:isolation` (13), `test:radar-isolation` (18), `test:conversion-velocity` (23), `test:rbac-audit` (11), `test:job-queue` (15), `test:storage-service` (9). Nenhuma pré-existente foi alterada em comportamento — só as duas lacunas de auditoria e o bug do `audit.ts`, ambos corrigidos para o estado correto, não para um estado diferente por opção de design.

## Não incluído nesta rodada (deliberado)

- RBAC granular multi-perfil (permissões por recurso, além de owner/admin/agent).
- Migrar o processamento de webhook para a fila (infraestrutura pronta; decisão de ligar fica para quando houver como validar com tráfego real).
- Migração SQLite → Postgres/RLS (sem sinal de contenção de escrita; gatilho já documentado na ADR-002).
- Adapter Redis para Socket.io (só relevante com 2+ réplicas — não é o caso hoje).
- Mover a fonte de verdade de PDF/backup para o S3 (hoje é só espelho; trocar exigiria reescrever download/exclusão com a proteção de path traversal existente).
