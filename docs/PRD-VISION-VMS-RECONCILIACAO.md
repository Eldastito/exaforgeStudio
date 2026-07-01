# Reconciliação PRD × Codebase — ZappFlow Vision VMS

**Referência:** `docs/PRD-VISION-VMS.md` (PRD v1.1)
**Status:** Entregável obrigatório da Fase 0 — nenhuma tela, integração de câmera, stream, gravação, IA visual, LPR, controle de acesso ou busca de pessoa deve ser implementada antes deste documento estar validado.
**Branch:** `claude/zappflow-vision-vms-my1364` (branch de desenvolvimento designada para esta sessão; o PRD sugere `feat/zappflow-vision-vms-v11` como nome de branch — mantemos a branch já designada pelo processo de trabalho, sem impacto no conteúdo desta entrega)
**Metodologia:** cada linha abaixo é resultado de leitura direta do código-fonte (não de suposição). Onde não foi encontrado, está declarado explicitamente como `NÃO ENCONTRADO NO CÓDIGO`.

## Legenda de classificações

- `EXISTE E PODE SER REUTILIZADO`
- `EXISTE PARCIALMENTE`
- `EXISTE, MAS PRECISA SER ADAPTADO`
- `NÃO EXISTE`
- `EXISTE, MAS HÁ RISCO DE COMPATIBILIDADE`
- `PRECISA SER VALIDADO COM DISPOSITIVO REAL`
- `PRECISA SER VALIDADO COM CARGA REAL`

## Sumário executivo

O ZappFlow OS atual é um **monólito maduro e bem disciplinado** no que se refere a isolamento multi-tenant (`organization_id` + testes automatizados), RBAC básico, criptografia de segredos, LGPD, tarefas e orquestração de IA read-only. Isso é uma base sólida para reaproveitar em praticamente toda a parte "de gestão" do Vision VMS (RBAC, planos/módulos, tarefas, notificações, auditoria, LGPD, criptografia).

Por outro lado, **não existe absolutamente nenhuma peça de infraestrutura de vídeo**: sem ONVIF/RTSP, sem motor de streaming, sem storage de vídeo, sem GPU, sem processo Edge separado, sem barramento de eventos de domínio, sem webhooks de saída, sem testes automatizados de verdade (só um script de isolamento de tenant) e sem PWA/offline. Esses são os sete gaps que determinam o cronograma real da Fase 0 e das ADRs (`docs/adr/`).

O maior risco arquitetural não é "faltar código de câmera" (esperado, é produto novo) — é a **tentação de encaixar vídeo dentro do processo Express único existente**. O `server.ts` de 51KB hoje roda `Scheduler`, `NotificationService`, `PaymentService`, `ModuleService` e `EncryptionService` todos in-process, sem worker separado. Gravação, streaming e inferência de IA competindo pelo mesmo event loop do CRM violariam diretamente a regra de não regressão do PRD (§0.3) e é o motivo da ADR-001.

---

## 1. Arquitetura frontend, backend, banco, filas, storage, PWA e Docker

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Backend único servindo API + frontend | EXISTE, MAS HÁ RISCO DE COMPATIBILIDADE | `server.ts` (raiz, ~51KB) | Núcleo de gestão continua aqui; vídeo/streaming NÃO pode entrar neste processo | Criar `vision-edge` como processo/serviço separado (ver ADR-001) | Alto se vídeo for colocado no mesmo processo — bloqueio de event loop derruba CRM/WhatsApp/Kanban | `server.ts` inicia Express único porta 3000; `Scheduler`, `NotificationService`, `PaymentService`, `ModuleService`, `EncryptionService` todos in-process |
| Docker/deploy | EXISTE PARCIALMENTE | `Dockerfile` (raiz, single-stage) | Reutilizável como referência de padrão de build para o core; não serve para o Vision Edge (que precisa de FFmpeg/ONVIF/ONNX nativos) | Criar Dockerfile próprio para `vision-edge`; decidir orquestração de deploy (o Edge roda no site do cliente, não na nuvem do core) | Médio (mudança de infraestrutura de deploy) | `Dockerfile:1-27`; sem `docker-compose` no repositório |
| PWA / operação offline (frontend) | NÃO EXISTE | — | Não há base de PWA a reaproveitar | Console de Portaria deve ser servido localmente pelo próprio Vision Edge (não depende do SPA/PWA do Core Cloud) | Baixo, se a decisão for "Edge Console é standalone" | Busca não encontrou `manifest.json`, service worker, nem uso de `firebase-applet-config.json` para PWA |
| Testes automatizados | EXISTE PARCIALMENTE | `scripts/test-tenant-isolation.ts`, `package.json:13` (`test:isolation`) | Padrão replicável para um novo `test-vision-tenant-isolation.ts` (ver ADR-002); mas não existe suíte de testes unitário/integração/E2E real | Escolher framework de teste (Vitest é o mais aderente ao Vite já usado) antes do Sprint 1; sem isso, os ~30 critérios de aceite do PRD (§28) não são verificáveis automaticamente | Alto sem isso, dado o volume de regras de negócio do PRD | `package.json:11` (`"lint": "tsc --noEmit"`, sem jest/vitest/playwright) |
| Estrutura de features/telas (frontend) | EXISTE E PODE SER REUTILIZADO | `src/features/*.tsx` (34 telas), `src/store/useStore.ts` (Zustand, `ViewMode` enum) | Seguir o mesmo padrão para as 19 telas Vision listadas no PRD §24.1 | Adicionar `ViewMode 'vision_vms'` + arquivos correspondentes; registrar em `Sidebar.tsx` | Baixo | `src/store/useStore.ts` (enum `ViewMode`), `src/features/Sidebar.tsx` |
| Player de vídeo / HLS / WebRTC no frontend | NÃO EXISTE | `StudioView.tsx:14-18` (canvas 2D só redimensiona imagens) | Nenhuma base a reaproveitar | Escolher e integrar player (hls.js, video.js ou WebRTC nativo do browser) — decisão de frontend a acompanhar as escolhas de streaming da ADR-003 | Médio-alto (nova dependência de frontend; avaliar licença/performance) | `package.json` não lista `hls.js`/`video.js`/lib de WebRTC; `StudioView.tsx:14-18` usa apenas `canvas.getContext('2d').drawImage` |
| Storage de arquivos (uploads) | EXISTE PARCIALMENTE | `src/server/routes/uploads.ts:1-51`, `MEDIA_DIR` (`server.ts:68`, estático em `server.ts:294`) | Padrão de storage local em disco existe, mas é dimensionado para imagens (15MB, multer memoryStorage) | Vídeo contínuo (GB/dia por câmera) não deve passar pelo pipeline HTTP multipart existente — Vision Edge precisa de Storage Manager próprio, fora do Express/multer | Alto se tentarem reaproveitar o pipeline de upload de imagem para vídeo contínuo (não aguenta carga) | `routes/uploads.ts:13-24` (tipos PNG/JPG/WEBP/GIF/AVIF, limite 15MB); `server.ts:68,294` |
| Jobs assíncronos / cron (core) | EXISTE PARCIALMENTE | `Scheduler.ts:34-41` (timers 1h + 5min, in-process, sem fila externa) | Não serve para cargas de Vision (inferência de IA, geração de clipes são workloads pesadas) | Vision Edge deve ter scheduler/worker próprio, independente do `Scheduler.ts` do core | Alto se detectores de IA/geração de clipes forem agendados dentro do `Scheduler.ts` do core (bloqueio de event loop, latência do CRM) | `Scheduler.ts:34-41,49` (registrado em `server.ts:1058`) |

---

## 2. Multi-tenant, RBAC, isolamento de tenant e testes de isolamento existentes

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Isolamento multi-tenant (`organization_id`) | EXISTE E PODE SER REUTILIZADO | `src/server/db.ts` (todas as tabelas de negócio), `middleware/auth.ts:19-26` | Reutilizar exatamente o mesmo padrão para todas as tabelas `vision_*` | Nenhum mecanismo novo a inventar; seguir a convenção existente; estender `test-tenant-isolation.ts` (ver ADR-002) | Baixo se seguir o padrão; Alto se inventar mecanismo próprio | `db.ts` (`channels:17`, `contacts:33`, `tickets:45`, `orders:467`); `middleware/auth.ts:19-26` |
| RLS nativo de banco | NÃO EXISTE | — | SQLite não suporta RLS; isolamento é 100% em aplicação, já validado por teste automatizado | Manter isolamento em aplicação; toda query Vision deve incluir `organization_id` (e novo `site_id`) explícito; nunca confiar em filtro de frontend (ver ADR-002) | Médio — um `WHERE organization_id` esquecido é vazamento de dados entre tenants | Nenhuma menção a RLS/`PRAGMA` de segurança de linha em `db.ts` |
| Teste automatizado de isolamento | EXISTE E PODE SER REUTILIZADO | `scripts/test-tenant-isolation.ts` (`npm run test:isolation`) | Padrão direto a replicar para Vision (organização A/B em banco temporário, 9+ verificações) | Criar `scripts/test-vision-tenant-isolation.ts` cobrindo `(organization_id, site_id)` antes de qualquer rota `/api/vision/*` ir a produção | Baixo (extensão de padrão já testado) | `scripts/test-tenant-isolation.ts:1-155` (9 verificações, incl. `OrdersService`, `AnalyticsService`, JWT, módulos por vertical) |
| Hierarquia tenant → site → área | EXISTE PARCIALMENTE | `AttendanceAreaService.ts`, `routes/areas.ts:60` (`service_areas`, `assigned_user_id` apenas informativo) | Não reutilizável diretamente — é conceito de "departamento de atendimento", não "unidade física com câmeras" | Criar `vision_sites` (novo) vinculado a `organization_id`; câmeras referenciam `site_id`. Avaliar (não decidir agora) se "site" deveria virar conceito compartilhado com outros módulos no futuro | Médio — nova hierarquia paralela à de "áreas de atendimento" pode confundir admin se a nomenclatura não for clara na UI | `AttendanceAreaService.ts`; `routes/areas.ts:60` |
| RBAC — papéis | EXISTE PARCIALMENTE | `users.role` (`db.ts:354`), `routes/users.ts:21,36,43,88`, `routes/managers.ts:36-37` | Reutilizar `owner`/`admin` como papéis de topo; os 10 papéis Vision do PRD (§20.1) não existem | Criar camada de atribuição de papel por módulo+site (ex.: nova tabela `vision_role_assignments`) em vez de sobrecarregar `users.role` — evita elevar privilégio de um `agent` comum sem querer | Alto se o RBAC existente for estendido sem cuidado (risco de escalonamento de privilégio não intencional) | `db.ts:354`; `routes/users.ts:43-44`; `routes/managers.ts:36-37` |
| Autenticação JWT + MFA/TOTP | EXISTE E PODE SER REUTILIZADO | `middleware/auth.ts:18-26`, `TOTPService.ts:1-78`, `routes/mfa.ts:1-64` | Reutilizar integralmente para login de papéis Vision, inclusive tornando MFA obrigatório (não opcional) para Vision Admin e Identity Search Officer | Adicionar checagem de `mfa_enabled=true` como pré-requisito de ativação desses papéis específicos | Baixo | `middleware/auth.ts:18-26`; `TOTPService.ts:1-78`; `routes/mfa.ts:1-64` |
| Rate limiting / CORS / security headers | EXISTE E PODE SER REUTILIZADO | `server.ts:139-147` (headers), `149-161` (CORS), `174-202` (rate limit customizado) | Reutilizar no core; o processo `vision-edge` precisa de política equivalente própria (não herda automaticamente por estar em outro processo) | Replicar rate limit/CORS/security headers no novo processo `vision-edge` | Baixo | `server.ts:139-147,149-161,174-202` |

---

## 3. Serviços de tarefas, notificações, Maestro, Copiloto, RIC, Analytics e Diretor Executivo IA

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Execution Intelligence (tarefas) | EXISTE E PODE SER REUTILIZADO | `TaskService.ts:1-172`, tabelas `tasks`/`task_updates`/`task_resources` (`db.ts:1285-1339`) | Reutilizar integralmente: Vision cria tarefas via `TaskService.create()` com `source='vision'` | Adicionar `'vision'` ao enum existente de `source` (hoje `manual`/`ric`/`ia`) e um FK opcional `vision_event_id` | Baixo | `TaskService.ts:1-172`; `db.ts:1285-1339` |
| Escalonamento de tarefa/evento | NÃO EXISTE | — | Tarefas só têm `assigned_to` + `due_at`, sem regra "se ninguém agir em X min, notificar Y" | Criar mecanismo novo de escalonamento (tabela dedicada, ex. `vision_escalation_rules`, ou generalização de `tasks`) — decisão de design a amarrar com a generalização do Maestro | Médio (funcionalidade nova, mas aditiva) | Busca não encontrou "escalation"/"escalonamento" implementado em `TaskService.ts` |
| Notificações in-app | EXISTE E PODE SER REUTILIZADO | `NotificationService.ts:45-129` (Socket.io, tipos info/success/warning/alert), tabela `notifications` (`db.ts:393-401`) | Reutilizar diretamente para alertas Vision (`camera_offline`, `storage_critical`, `panic_activated`) | Adicionar métodos semânticos (`cameraOffline()`, `panicActivated()`) seguindo o padrão de `newLead()`/`handoff()` | Baixo | `NotificationService.ts:65-129` |
| WebSocket tempo real | EXISTE E PODE SER REUTILIZADO | `server.ts:1000-1048` (salas `org:{orgId}`, `ticket:{ticketId}`) | Reutilizar padrão de salas para status de câmera/eventos (ex. `site:{siteId}`) | Estender emissão de eventos Socket.io para tópicos Vision (`camera_status`, `vision_event`) | Baixo | `server.ts:1006-1048`; `Scheduler.ts:165` (`io.to('org:...')`) |
| Maestro (regras determinísticas + ação) | EXISTE PARCIALMENTE | `MaestroService.ts:5-31` (hoje só trata `onHandoff()` → cria tarefa, idempotente por `ticket_id`) | Não é o motor de regras genérico do PRD — precisa expandir para aceitar eventos de qualquer domínio (incl. `vision.*`) | Generalizar `MaestroService` para engine condição→severidade→ação, preservando 100% de compatibilidade com o fluxo de handoff atual | Alto — `MaestroService` é crítico para o atendimento hoje; qualquer refactor exige regressão completa do fluxo de handoff existente | `MaestroService.ts:5-31` |
| Barramento de eventos versionado/idempotente | NÃO EXISTE | — | Acoplamento direto via `import` (`AIOrchestratorService.ts:4-19` importa 14+ serviços diretamente); `webhookProcessor.ts` chama serviços direto; zero ocorrências de `EventEmitter`/pub-sub no projeto | Este é o gap mais crítico do PRD (§0.3 exige eventos versionados/idempotentes; §22.2 lista 30+ domain events). Decisão de mecanismo interno do Cloud deve ser tomada uma única vez (não duplicada por módulo) | Alto — grande parte da proposta de valor do PRD depende disso | `AIOrchestratorService.ts:4-19`; busca por `EventEmitter` retornou zero resultados |
| Copiloto Interno | EXISTE PARCIALMENTE | `CoordenadorService.ts:28-115` (bot de WhatsApp interno: `tarefas`/`iniciar`/`concluir`/`ajuda`/`nova`) | Reutilizável como padrão de comando, mas o canal primário do PRD Fase 1-2 é PWA/Console de Portaria, não WhatsApp | Copiloto Vision nasce como painel dentro do Console de Portaria/Command Center, reaproveitando a lógica de comando (aceitar/solicitar apoio); WhatsApp entra depois (Fase 2/3, já decidido no PRD) | Médio — não misturar número de atendimento a cliente com alertas Vision | `CoordenadorService.ts:28-115` (canal `kind='internal'`) |
| Diretor Executivo IA | EXISTE E PODE SER REUTILIZADO | `ExecutiveAdvisorService.ts:13-137` (`ask`/`auditPlan`/`taskAssist`/`briefing`, guardrail contra invenção de métricas) | Reutilizar diretamente; estender o contexto que ele consulta | Estender `BusinessContextService` para incluir bloco de métricas Vision (câmeras offline, eventos críticos, SLA de resposta) | Baixo | `ExecutiveAdvisorService.ts:13-137`; `BusinessContextService.ts:12-116` |
| RIC (Revenue Intelligence Center) | EXISTE E PODE SER REUTILIZADO | `RevenueIntelligenceService.ts:69-110` (IQR, drivers, perda estimada), `RevenueAuditService.ts:1-87` | Reutilizar estrutura de "driver" para correlações operacionais Vision (fila × abandono, §17.5) | Adicionar novo driver/seção operacional ao RIC alimentado por `vision_events` agregados, respeitando a linguagem de causalidade exigida pelo PRD ("potencial impacto sob análise", nunca afirmação causal) | Baixo, desde que o template de linguagem seja respeitado | `RevenueIntelligenceService.ts:69-110`; `RevenueAuditService.ts:1-87` |
| AnalyticsService (métricas determinísticas) | EXISTE E PODE SER REUTILIZADO | `AnalyticsService.ts:44-320` | Seguir o mesmo padrão de agregação SQL para métricas Vision (câmeras ativas, eventos por zona, tempo de revisão) | Criar `VisionAnalyticsService` seguindo o padrão existente | Baixo | `AnalyticsService.ts:44-320` |
| Webhooks de saída | NÃO EXISTE | `webhookProcessor.ts` (só entrada), `webhookSecurity.ts` (valida assinatura recebida, não emite) | Nenhum código de emissão de webhook a reaproveitar; só o padrão de retry idempotente (PIX no `Scheduler.ts`) serve de referência de disciplina | Criar serviço novo de webhook outbound (assinatura, idempotency key, retry, status de entrega) — ver PRD §16.3 | Médio-alto (funcionalidade nova, mexe com segurança de credenciais externas) | `webhookProcessor.ts` (inbound apenas); `webhookSecurity.ts` |

---

## 4. Feature gating, planos, limites e custos já existentes

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Sistema de módulos habilitáveis por tenant | EXISTE E PODE SER REUTILIZADO | `ModuleService.ts:11,15-34,36-54`, `verticals.ts:20-70`, `organization_settings.enabled_modules` (JSON) | Reutilizar padrão para os pacotes comerciais do PRD §5.3 (Core/Intelligence/Operations/Identity & Access/Enterprise) | Registrar módulo `"vms"` em `ModuleService.MODULE_BY_ROUTE`; decidir se cada pacote é um módulo próprio ou sub-flags dentro de um único módulo `vms` (ver linha abaixo) | Baixo (padrão já testado e usado por Reservas/Assinaturas) | `ModuleService.ts:11,15-34,36-54`; `verticals.ts:20-70`; `db.ts:336-342` |
| Feature flags granulares (19 flags do PRD §0.5) | NÃO EXISTE | — | Mecanismo atual só tem `enabled_modules` (lista plana por organização, sem granularidade de sub-feature nem por site/câmera) | Criar tabela nova `vision_feature_flags` (`organization_id`, `site_id` opcional, `flag_key`, `enabled`) para permitir rollout por tenant, site e câmera conforme PRD §0.3 exige ("rollout por tenant, site e câmera") | Médio (estrutura nova, porém aditiva e isolada do restante do sistema de planos) | `ModuleService.ts` (apenas lista plana, sem granularidade); PRD v1.1 §0.5 |
| Planos e limites (`PlanService`) | EXISTE E PODE SER REUTILIZADO | `PlanService.ts:11-19` (features JSON: `ai_monthly_limit`, `contacts_limit`, etc.) | Reutilizável como padrão para novos limites Vision (`vms_cameras_limit`, `vms_storage_gb_limit`, `vms_sites_limit`) | Adicionar campos de limite ao JSON de features dos planos que incluírem Vision | Baixo | `PlanService.ts:11-19` |
| Padrão de adição de módulo novo (precedente) | EXISTE E PODE SER REUTILIZADO | `ReservationService.ts`, `SubscriptionService.ts` + registro em `ModuleService`/`verticals.ts`/`server.ts` | Padrão replicável, passo a passo já mapeado (service → tabelas → rota → `MODULE_BY_ROUTE` → vertical opcional → middleware de gating automático) | Seguir o mesmo passo a passo para o módulo Vision | Baixo | `ModuleService.ts:15-34`; `verticals.ts:20-70`; `server.ts` (registro de rotas, linhas ~338-353) |

---

## 5. Estado de Edge/Intranet e sincronização

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Runtime Edge separado do core | NÃO EXISTE | — | Nenhum precedente de segundo processo, container adicional, ou runtime não-Node no repositório | Ver ADR-001 (decisão de separação de processo; linguagem final adiada para pós-laboratório) | Alto se não for tratado como processo/serviço distinto desde o início | `server.ts` roda único processo Express; nenhum worker/processo filho encontrado além dos serviços in-process já citados |
| Outbox / sincronização Edge↔Cloud | NÃO EXISTE | — | Único precedente de disciplina de retry idempotente é o lembrete de PIX (`Scheduler.ts:387-489`) — não é um outbox de eventos de domínio | Ver ADR-007 (outbox local no Edge, ingestão idempotente no Cloud via `idempotency_key`) | Alto (base estrutural do modelo Edge Hybrid do PRD) | `Scheduler.ts:387-489` (único precedente de retry idempotente no projeto) |
| Operação local sem internet (frontend/console) | NÃO EXISTE | — | Sem PWA/service worker; Console de Portaria precisa ser servido localmente pelo Edge, não pelo SPA do Core Cloud | Confirmar arquitetura: Edge Console é uma aplicação web servida localmente pelo próprio `vision-edge`, independente de conectividade com a nuvem | Baixo se a decisão acima for adotada desde o início | Busca não encontrou PWA/service worker no projeto |

---

## 6. Capacidade de jobs assíncronos, cron e webhooks

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Jobs assíncronos/cron (core) | EXISTE PARCIALMENTE | `Scheduler.ts:1-612` (timers 1h/5min in-process; reativação, lembretes, cadências, PIX, CSAT, carrinho abandonado, expiração de pedidos, retenção LGPD) | Padrão replicável para jobs leves de gestão Vision (ex.: expirar `vision_pet_zone_events` não revisados), mas não para cargas pesadas (inferência, geração de clipe) | Jobs leves de gestão Vision podem reaproveitar o padrão do `Scheduler.ts` do core; jobs pesados ficam exclusivamente no scheduler próprio do Vision Edge | Alto se cargas pesadas forem agendadas no `Scheduler.ts` do core (mesmo risco do item de jobs assíncronos da seção 1) | `Scheduler.ts:34-41` (timers), `60` (chama `LgpdService.retentionPass()`) |
| Webhooks de entrada | EXISTE PARCIALMENTE | `webhookProcessor.ts`, `webhookSecurity.ts` | Padrão de validação de assinatura recebida existe e pode inspirar a validação de webhooks de entrada do Vision Integration Gateway (§16.1) | Reaproveitar padrão de `webhookSecurity.ts` para novos webhooks de entrada Vision (ex.: confirmação de alarme externo) | Baixo | `webhookProcessor.ts`; `webhookSecurity.ts` |
| Webhooks de saída | NÃO EXISTE | — | Já coberto na seção 3 (linha "Webhooks de saída") | Ver seção 3 | Médio-alto | `webhookProcessor.ts` (apenas inbound) |

---

## 7. Possibilidades reais de storage local, playback, streaming, transcodificação e gravação

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Streaming (RTSP/ONVIF/WebRTC/HLS) | NÃO EXISTE | — | Nenhum código, nenhuma dependência no `package.json` | Ver ADR-003 (decisão de MediaMTX como Stream Gateway) | Alto (base técnica do produto inteiro) | `package.json` não lista nenhuma lib de mídia/streaming |
| Gravação/indexação de segmentos | NÃO EXISTE | — | Precedente indireto: `BackupService.ts:56,79-82,105-107` já grava snapshots JSON por org com checksum SHA-256 — útil como padrão de hashing, não de gravação de vídeo | Ver ADR-004 (padrão de hash reaproveitado de `BackupService`, aplicado a `vision_evidence`) | Alto | `BackupService.ts:19-107` |
| Transcodificação | NÃO EXISTE | — | Nenhum precedente | Ver ADR-003 (FFmpeg como processo externo, build LGPL-only) | Médio-alto | — |
| Storage de vídeo (Storage Manager) | NÃO EXISTE, testado apenas para imagens pequenas | `routes/uploads.ts:1-51` (15MB, multer memoryStorage) | Não reutilizável para vídeo contínuo (ordens de magnitude maior) | Vision Edge precisa de gerenciador de storage próprio (disco dedicado, rotação por retenção), fora do pipeline HTTP multipart do core | Alto se o pipeline de upload de imagem for reaproveitado para vídeo | `routes/uploads.ts:13-24` |
| Calculadora de armazenamento (§16.2 do PRD) | NÃO EXISTE | — | Cálculo é puramente novo (fórmula já definida no PRD) | Implementar como função pura no Vision Edge/Cloud, sem dependência de infraestrutura nova | Baixo | — |

---

## 8. Integração de dispositivos, rede local e mecanismo de update do Edge

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Descoberta ONVIF / conexão RTSP com câmera real | NÃO EXISTE e NÃO TESTÁVEL nesta sessão | — | Funcionalidade 100% nova; requer laboratório físico com câmeras homologadas (PRD §31.1/§27 Fase 0) | `PRECISA SER VALIDADO COM DISPOSITIVO REAL` — este ambiente de desenvolvimento remoto não tem acesso a rede de CFTV física; laboratório deve rodar no ambiente do cliente ou em bancada dedicada | Alto (toda a promessa comercial do produto depende disso) | — |
| Mecanismo de update do Edge (over-the-air) | NÃO EXISTE | — | Nenhum precedente de atualização remota de um serviço de campo no projeto | Desenhar mecanismo de update do `vision-edge` (versionamento, rollback, canary por site) como item de Fase 1, não bloqueante para o laboratório inicial | Médio | — |
| Rede de CFTV isolada / VLAN | NÃO APLICÁVEL AO CÓDIGO | — | Requisito de infraestrutura de rede do cliente, não de software | Incluir no checklist de instalação/diagnóstico (PRD §31.1), não é item de reconciliação de código | Baixo (fora do escopo de engenharia de software) | — |

---

## 9. Controles de auditoria, criptografia, secrets, logs e acessos

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Criptografia de credenciais (câmera RTSP) | EXISTE E PODE SER REUTILIZADO | `EncryptionService.ts:1-94` (AES-256-GCM, formato `enc:v1:...`, já usado em `oauth_connections`, `pay_gateway_token`, `mfa_secret`) | Reutilizar diretamente para `vision_stream_credentials` | Aplicar `EncryptionService.encrypt()` ao salvar credenciais de câmera; nunca devolver ao frontend, seguindo o mesmo padrão de tokens OAuth | Baixo | `EncryptionService.ts:37,75-92`; `db.ts:25` |
| Auditoria de acesso (live view/playback/export) | EXISTE PARCIALMENTE | `auth_audit_logs` (`db.ts:383-391`), `audit_logs` (`db.ts:403-410`), `routes/audit.ts:1-26` | Reutilizar estrutura de tabela; PRD exige log específico de acesso a vídeo (`vision_access_logs`, já modelado em §19.1) | Criar `vision_access_logs` seguindo o mesmo padrão (`actor`, `evento`, `metadata`, `timestamp`) com campos extras (`camera_id`, `resource_type`) | Baixo | `db.ts:383-410`; `routes/audit.ts:1-26` |
| Retenção/LGPD | EXISTE PARCIALMENTE | `LgpdService.ts:15-42` (`retentionPass`, expurga mensagens de tickets encerrados) | Padrão reutilizável, mas Vision precisa de granularidade por câmera/tipo de evento/incidente aberto (mais fino que "por organização") | Estender `LgpdService` ou criar serviço próprio de retenção Vision com a mesma lógica, incluindo a trava "incidente aberto bloqueia expurgo" (novo conceito — ver ADR-004) | Médio-alto — bug na trava de retenção é falha grave de responsabilidade jurídica | `LgpdService.ts:15-42`; `organization_settings.retention_days` (`db.ts:425-426`) |
| Exportação/portabilidade | EXISTE E PODE SER REUTILIZADO (padrão) | `LgpdService.ts:46-63` | Seguir mesmo padrão para exportação de evidência com motivo obrigatório | Criar rota `/api/vision/evidence/export` reaproveitando o padrão, gravando motivo e hash | Baixo | `LgpdService.ts:46-63` |
| Direito ao esquecimento (para templates biométricos futuros) | EXISTE PARCIALMENTE | `LgpdService.ts:70-82` (anonimiza contato) | Padrão reutilizável para expirar referências, mas biometria exige exclusão física garantida, não apenas anonimização de registro | `PRECISA SER VALIDADO COM JURÍDICO` — definir SLA de exclusão de template biométrico e mecanismo de exclusão irreversível antes de qualquer ativação de `vision_identity_search`/`vision_face_identity` | Alto (dado biométrico sensível; falha aqui é violação grave de LGPD) | `LgpdService.ts:70-82` |
| MFA para papéis sensíveis | EXISTE E PODE SER REUTILIZADO | `TOTPService.ts:1-78`, `routes/mfa.ts:1-64` | Reutilizar e tornar obrigatório para Vision Admin/Identity Search Officer/Support Técnico | Adicionar checagem de MFA ativo como pré-requisito desses papéis | Baixo | `TOTPService.ts:1-78`; `routes/mfa.ts:1-64` |
| Backup | EXISTE PARCIALMENTE | `BackupService.ts:19-107` (snapshot JSON por org, SHA-256, `TENANT_TABLES` fixa) | Reutilizável para metadados Vision; vídeo em si não deve entrar no backup JSON tradicional (volume) | Incluir tabelas `vision_*` de metadados (não binários) em `TENANT_TABLES`; vídeo segue política de retenção própria do Edge | Baixo (se apenas metadados) | `BackupService.ts:19-48,56,105-107` |

---

## 10. Bibliotecas candidatas, licença, riscos de distribuição e manutenção

Ver **`docs/adr/ADR-003-media-pipeline-and-license.md`** para a análise completa. Resumo:

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Stream Gateway (RTSP/ONVIF/WebRTC/HLS) | NÃO EXISTE, decisão registrada em ADR | — | Nenhuma dependência hoje | Adotar MediaMTX (MIT); rejeitar Janus (GPLv3) | Alto se lib copyleft for linkada estaticamente ao produto | Ver ADR-003 |
| Motor de inferência visual | NÃO EXISTE, decisão registrada em ADR | — | Nenhuma dependência hoje | Adotar ONNX Runtime (MIT) + modelos sob licença permissiva; **rejeitar Ultralytics YOLO (AGPL/comercial)** sem contrato | Alto (risco jurídico-comercial de AGPL) | Ver ADR-003 |
| OCR/LPR | NÃO EXISTE, decisão registrada em ADR | — | Nenhuma dependência hoje | **Rejeitar OpenALPR (AGPL-3.0)**; avaliar SaaS pago (Plate Recognizer) ou stack própria (Apache/MIT) | Alto (mesmo risco AGPL já sinalizado pelo cliente) | Ver ADR-003 |
| Transcodificação | NÃO EXISTE, decisão registrada em ADR | — | Nenhuma dependência hoje | FFmpeg como processo externo, build LGPL-only, sem plugins GPL | Médio | Ver ADR-003 |

---

## 11. Impacto da atual base SQLite e alternativas futuras

Ver **`docs/adr/ADR-002-tenant-isolation-and-storage.md`** para a análise completa. Resumo:

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| SQLite como banco único (core) | EXISTE E PODE SER REUTILIZADO | `db.ts` (`better-sqlite3`) | Tabelas `vision_*` residem no mesmo SQLite do core, seguindo convenção `organization_id` + novo `site_id` | Nenhuma migração de banco agora; gatilho objetivo definido (contenção de escrita sob carga real) para reavaliar Postgres/RLS no futuro | Baixo agora; a decidir conforme dado real de carga | `db.ts` (schema completo, `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` idempotente em boot, linhas 12-888) |
| SQLite local do Edge (Local Metadata Store) | NÃO EXISTE | — | Cada Vision Edge mantém seu próprio SQLite local (isolamento físico mais forte que o do Cloud) | Ver ADR-002 | Baixo | — |

---

## 12. Estratégia de testes com câmeras, NVRs, DVRs, cancelas e cargas reais

| Requisito do PRD | Estado no código | Arquivo/serviço/tabela | Reutilização ou adaptação | Ação necessária | Risco de regressão | Evidência técnica |
|---|---|---|---|---|---|---|
| Laboratório com 2+ câmeras homologadas (PRD §27 Fase 0) | NÃO REALIZÁVEL NESTA SESSÃO | — | Requer hardware físico e rede de CFTV real | `PRECISA SER VALIDADO COM DISPOSITIVO REAL` — deve rodar em ambiente do cliente/laboratório físico, fora do ambiente remoto de desenvolvimento desta sessão | Alto (toda a promessa comercial depende disso) | — |
| Testes de stream/live view/gravação/playback | NÃO EXISTE | — | Nenhum código a testar ainda | `PRECISA SER VALIDADO COM DISPOSITIVO REAL` — depende do laboratório acima | Alto | — |
| Homologação de controlador de acesso/cancela | NÃO EXISTE | — | Nenhum precedente de integração física | `PRECISA SER VALIDADO COM DISPOSITIVO REAL` — homologar exatamente um controlador na Fase 0/4 (ver ADR-006) | Alto (segurança física, responsabilidade civil) | — |
| Storage/retenção sob carga real (várias câmeras 24/7) | NÃO EXISTE | — | Nenhum dado de carga real disponível | `PRECISA SER VALIDADO COM CARGA REAL` no laboratório do Sprint 2/3, antes de comprometer perfis de hardware (Edge S/M/L) comercialmente | Alto | PRD §9.1 explicitamente declara os números de perfil como "não são promessa" |
| Sincronização Edge↔Cloud sob perda de conectividade real | NÃO EXISTE | — | Único precedente de retry idempotente é o lembrete de PIX (`Scheduler.ts:387-489`), sem outbox real | `PRECISA SER VALIDADO COM CARGA REAL` — teste de integração dedicado ("Edge offline → outbox", "Edge online → sync", já previsto no PRD §29) | Alto | `Scheduler.ts:387-489` |
| Framework de teste E2E/browser | NÃO EXISTE | — | Nenhum Playwright/Cypress no projeto | Decidir framework antes do Sprint de Live View (Playwright é o mais aderente ao stack Vite/React atual) | Alto sem isso, dado o volume de critérios de aceite do PRD (§28) | `package.json` (scripts apenas `tsc --noEmit`) |

---

## Gaps críticos — resumo executivo (ordem de prioridade para a Fase 0)

1. **Nenhum barramento de eventos interno no Cloud** (seção 3) — bloqueia a promessa central de "evento Vision vira tarefa/alerta/incidente" se não for resolvido antes do Sprint 4.
2. **Nenhuma infraestrutura de mídia** (seções 7, 8, 10) — esperado para um produto novo, mas define o cronograma real: laboratório físico é pré-requisito, não pode ser simulado inteiramente em ambiente de desenvolvimento remoto.
3. **Nenhum framework de teste automatizado real** (seções 1, 12) — risco transversal a todo o roadmap; os critérios de aceite do PRD (§28) não são verificáveis sem isso.
4. **RBAC atual é tenant-level, não site/módulo-level** (seção 2) — precisa de extensão cuidadosa para não introduzir escalonamento de privilégio.
5. **Feature flags granulares não existem** (seção 4) — o mecanismo atual (`enabled_modules`) não suporta rollout por site/câmera como o PRD exige.
6. **Retenção/exclusão de dado biométrico não tem precedente jurídico validado** (seção 9) — bloqueante específico de `vision_identity_search`/`vision_face_identity`, não do MVP Core.

## Plano de não regressão (síntese)

Reaproveitar integralmente a disciplina já existente no projeto:

- Migrations aditivas (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` em try/catch, padrão de `db.ts`).
- Isolamento por `organization_id` (+ novo `site_id`) em toda query nova, replicando `routes/orders.ts`.
- Teste de isolamento obrigatório antes de qualquer rota ir a produção (`scripts/test-vision-tenant-isolation.ts`, extensão de `test-tenant-isolation.ts`).
- Feature flags desligadas por padrão (`vision_vms=false` até ativação explícita por tenant).
- Processo `vision-edge` fisicamente separado do `server.ts` — nenhuma dependência de vídeo/streaming/IA entra no processo core em nenhuma hipótese (ADR-001).

## Próximos passos após esta reconciliação

Conforme PRD §27 (Fase 0), os itens ainda pendentes antes de iniciar a Fase 1 (Vision VMS Core) são:

1. Laboratório físico com câmeras homologadas (`PRECISA SER VALIDADO COM DISPOSITIVO REAL` — requer ambiente do cliente).
2. Threat model do Vision Edge Gateway (documento próprio, a produzir junto com o piloto de laboratório).
3. Escolha final de framework de testes (Vitest + Playwright recomendados, a confirmar com o time).
4. Desenho da tabela `vision_feature_flags` e do módulo `vms` no `ModuleService` (implementação, não apenas documento — pode começar em paralelo ao laboratório, pois não depende de hardware).
