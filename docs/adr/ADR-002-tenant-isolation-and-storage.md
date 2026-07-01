# ADR-002 — Tenant Isolation and Storage

**Status:** Aceito
**Data:** Fase 0

## Contexto

O PRD v1.0 original assumia RLS (Row Level Security) nativo de banco. A reconciliação técnica confirmou que:

- O projeto usa **SQLite via `better-sqlite3`**, que **não suporta RLS nativo**.
- O isolamento multi-tenant hoje é **100% em camada de aplicação**, baseado na coluna `organization_id` presente em praticamente todas as tabelas (`src/server/db.ts`: `channels:17`, `contacts:33`, `tickets:45`, `orders:467`, etc.).
- O middleware `src/server/middleware/auth.ts:18-26` decodifica o JWT e injeta `req.organizationId`; toda rota filtra manualmente com `WHERE organization_id = ?` (ex.: `src/server/routes/orders.ts:17-96`).
- Esse padrão já é **validado por teste automatizado**: `scripts/test-tenant-isolation.ts` (rodável via `npm run test:isolation`) cria duas organizações em banco temporário e verifica que nenhum dado cruza entre elas (9 verificações, incluindo `OrdersService`, `QuoteService`, `AnalyticsService`, JWT e módulos por vertical).
- Não existe hoje conceito de "site"/"unidade física" dentro de uma organização — `service_areas` (`AttendanceAreaService.ts`, `routes/areas.ts`) modela áreas de **atendimento** (departamentos), não unidades físicas com câmeras.
- O PRD v1.1 já foi corrigido pelo cliente para refletir essa realidade (§6.3): "Enquanto o core utilizar SQLite, o isolamento de tenant será garantido por controles de aplicação... A migração para PostgreSQL com RLS será avaliada como decisão arquitetural futura, sem bloquear o MVP do Vision."

## Alternativas consideradas

1. **Migrar todo o core para PostgreSQL + RLS antes do Vision MVP.** Rejeitada pelo cliente explicitamente — risco e custo desproporcionais para o problema atual; nenhuma evidência de que SQLite seja o gargalo.
2. **Manter isolamento em aplicação, replicando o padrão `organization_id` já testado, e adicionar `site_id` como segunda chave de escopo.** Escolhida.
3. **Vision Cloud usar banco separado (novo Postgres) só para si, mantendo o core em SQLite.** Rejeitada nesta fase — adicionaria uma segunda tecnologia de banco e complexidade operacional (dois motores, duas estratégias de backup) sem necessidade comprovada; o próprio PRD pede "migrations aditivas" no mesmo banco.

## Decisão

1. **Tabelas `vision_*` do Cloud residem no mesmo SQLite do core**, seguindo exatamente o padrão existente: toda tabela carrega `organization_id` (reaproveitando a convenção já usada) e uma nova coluna `site_id` para o segundo nível de escopo (tenant → site → área → câmera, conforme PRD §19).
2. **Nenhuma query Vision pode confiar em filtro de frontend.** Toda rota `/api/vision/*` deve aplicar `WHERE organization_id = ? AND site_id = ?` (quando aplicável) no servidor, replicando literalmente o padrão de `routes/orders.ts:17-96`.
3. **O Vision Edge Gateway mantém seu próprio SQLite local (Local Metadata Store)**, contendo apenas dados do site ao qual está fisicamente instalado. Isso dá um isolamento **estruturalmente mais forte** que o do Cloud: um Edge comprometido não tem acesso físico a dados de outro tenant/site, porque nunca os recebeu.
4. **Estender a suíte de teste de isolamento.** Criar `scripts/test-vision-tenant-isolation.ts` seguindo o mesmo padrão de `test-tenant-isolation.ts`, cobrindo a combinação `(organization_id, site_id)` — isso é pré-requisito de aceite antes de qualquer rota Vision ir a produção (alinhado ao critério de aceite §28.5 do PRD).
5. **Gatilho explícito para reavaliar Postgres/RLS:** se o laboratório de carga (Sprint 2/3) mostrar contenção de escrita no SQLite (erros `SQLITE_BUSY` sob volume de metadados de segmento de gravação — lembrando que `better-sqlite3` é síncrono e single-writer), abrir uma nova ADR específica de migração de banco. Não antecipar essa migração sem dado real.
6. **Credenciais de câmera (`vision_stream_credentials`)** seguem o padrão já existente de `EncryptionService` (AES-256-GCM, ver uso em `oauth_connections`, `organization_settings.pay_gateway_token`, `users.mfa_secret`) — nunca em texto plano, nunca expostas ao frontend.

## Licenças

Não aplicável (decisão de arquitetura de dados, não de biblioteca externa).

## Riscos

- **Médio**: esquecer `organization_id`/`site_id` em uma query nova é o principal vetor de vazamento entre tenants. Mitigação: teste automatizado obrigatório (item 4) e revisão de código específica para esse padrão em todo PR que toque rotas `/api/vision/*`.
- **Baixo–Médio**: contenção de escrita em SQLite sob alta frequência de eventos Vision (câmeras emitindo `device_health`/`vision_events` continuamente). Mitigado pelo gatilho explícito do item 5 e pelo fato de que o Edge já filtra/agrega localmente antes de sincronizar (ADR-007) — o Cloud não recebe volume bruto de telemetria por frame.

## Custo

Baixo — reaproveita 100% do padrão de isolamento já existente e testado; não introduz nova tecnologia de banco.

## Segurança

Isolamento físico no Edge (item 3) é mais forte que isolamento lógico no Cloud — reduzir a superfície de dados sensíveis (vídeo, credenciais RTSP) que trafegam ou residem fora do site é uma escolha deliberada de defesa em profundidade.

## Impacto de manutenção

Baixo no curto prazo (mesma stack). Dívida técnica documentada e monitorada (gatilho do item 5) para uma eventual migração de banco, sem bloquear o roadmap comercial do Vision.

## Plano de rollback

Migrations são aditivas (`CREATE TABLE IF NOT EXISTS vision_*`); rollback = `DROP TABLE` das tabelas `vision_*`, sem qualquer impacto nas tabelas existentes do core.
