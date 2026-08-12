# ADR-164 — Platform Trust, Reliability & Capacity Intelligence (PRD 7)

**Programa:** ZapFlow Execution Intelligence (ZEI)
**Estado:** Em implementação — **F0–F5 FECHADAS (contrato + runtime + SLI HTTP + health de dependências + Operational Health); fatia HOST/INFRA da F2, o SLO por jornada (F3.4) e a F6+ (baseline/anomalia/headroom/forecast) dependem de dados de AMBIENTE / baseline real acumulado**
**Prioridade:** P0 — crítica para escala comercial
**Acesso:** Admin Master
**Natureza:** Observabilidade + Reliability Engineering + Capacity Intelligence + Trust
**Estratégia:** REUTILIZAR → ESTENDER → COMPOR → **só então** CRIAR
**Dependência:** PRD 6 (ADR-163) **funcionalmente fechado** (F0–F16 em produção) — pré-condição atendida.
**Não é:** novo Radar, novo Runtime, novo Policy Engine, nem substituto de stack de observabilidade.

> **Regra de ouro (PRD 7 §116):** *a primeira pessoa a perceber que o ZapFlow está caminhando para ficar lento deve ser o próprio ZapFlow — não o cliente.*

---

## 1. Contexto e objetivo

O `ProductionReadinessService` responde bem "**este deploy está configurado para funcionar?**" (Configuration Readiness). Ele **não** responde "**este deploy continuará funcionando bem quando o tráfego crescer?**". Essa é a lacuna real que o PRD 7 fecha, transformando a infraestrutura de algo administrado reativamente em **capacidade operacional observada, previsível e governada**.

A confiança passa a ter dois lados:
- **Action Trust** — a IA fez o que estava autorizada a fazer? (já existe: Autonomy Contract, ApprovalPolicy, CommandExecutor, SkillOS rollout/canary/kill-switch, ConfirmationEngine, audit).
- **Delivery Trust** — a plataforma tem capacidade para executar com qualidade? (**o foco novo deste PRD**).

Esta seção entrega a **metade de codebase** da F0 (§7/§117): auditoria do `main` com evidência `file:symbol` + matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR. A **metade de ambiente** (§8/§68) — capacidade real da VPS, limites de container, telemetria já exposta pelo host — depende de dados que o GitHub não conta e fica registrada como pendência (§13 abaixo).

---

## 2. F0 — Auditoria do `main` (evidência `file:symbol`)

**Conclusão: a base de *Action Trust* e os hooks operacionais existem; a instrumentação de *Delivery Trust* (métricas de infra/app time-series) é genuinamente nova.** Não há `prom-client` nem OpenTelemetry no `package.json` — a coleta sistemática de séries temporais é capacidade a criar, não duplicação.

| # | Superfície | `file:symbol` | Veredito | Papel atual |
| --- | --- | --- | --- | --- |
| 1 | **Configuration Readiness** | `ProductionReadinessService.ts:57` `report()`; rota `routes/admin.ts:28`; `ProductionReadinessView.tsx` | EXISTE | Checa só env/config (openai/jwt/app_url/backup/asaas/telefonia/whatsapp/push/email/skillos) → `ready\|degraded\|blocked`. **Não mede runtime.** |
| 2 | **Job Queue** | `JobQueueService.ts:48`; `health()` `:143`; rota `routes/admin.ts:345` | EXISTE (in-process) | `setImmediate` (não distribuída, `:6/:62`). `health()` = pending/processing/completed/failed/total/oldestPending. retry/dead-letter em métodos separados (`:163/:181`). |
| 3 | **Banco (better-sqlite3)** | `db.ts:12` WAL; `busy_timeout=5000` `:16`; `BackupService.ts:53`; `Scheduler.backupPass` `:1208` | PARCIAL | WAL ligado; **sem** PRAGMAs de perf (`synchronous`/`cache_size`/`mmap_size`); **sem** métrica de latência/tamanho de query. |
| 4 | **Scheduler** | `Scheduler.ts:70` (`tick` horário `:733` / `fastPass` 5min `:95`) | EXISTE | Dezenas de `xxxPass` best-effort, per-org. Lugar natural de um pass de coleta/baseline. |
| 5 | **Provider health** | `SkillOsProviderHealthService.ts:34` `state()`; `AiReliabilityKernel.ts:35` `latencyMs` | PARCIAL | Só **IA** tem circuit-breaker/estado (`healthy/watch/degraded/open`). WhatsApp/Asaas/e-mail/storage **não** têm health nem latência medida. |
| 6 | **Correlação / trace** | `business_signals.correlation_id`; `ExecutionTraceService.ts:36` | PARCIAL | `correlationId` de DOMÍNIO (perceber→decidir→medir) existe e circula. **requestId/traceId de HTTP não existem** — nenhum middleware de request-id em `server.ts`. |
| 7 | **Ledger global vs por-tenant** | `business_signals` (per-tenant, `db.ts:5941`); `platform_settings:8195`; `research_usage_log:8179` (global, append-only); `vertical_intelligence:8115` (compartilhado) | PARCIAL | Existe **precedente de ledger global** (`research_usage_log` "sem organization_id — gasto de plataforma"). **Não existe** "Platform Health Event" dedicado. |
| 8 | **Deploy / versão** | `package.json:4` `version:0.0.0`; `GET /api/health` `server.ts:397` | NÃO EXISTE | `version` placeholder; health sem version/commit/uptime/deploy-ts. Nenhuma env de commit SHA. |
| 9 | **Métricas de aplicação** | (ausência confirmada) | NÃO EXISTE | Sem p50/p95/p99, rps, latência de rota, event-loop lag, 5xx. Única latência medida é a de IA (`ai_usage_log.latencyMs`). |
| 10 | **Área Admin Master** | `Sidebar.tsx:93` (`production_readiness`, gated `isMasterAdmin`); `ProductionReadinessView.tsx` | EXISTE | Superfície master própria — **estender** com abas Operational Health + Capacity, sem item de menu novo (§48). |

---

## 3. Matriz de Reutilização (entregável obrigatório da F0)

| Capacidade PRD 7 | Veredito | Base / ação concreta |
| --- | --- | --- |
| §6/§48 Operational + Capacity Readiness | **ESTENDER** | Compor **acima** do `ProductionReadinessService` (config) as camadas Operational Health e Capacity Intelligence — mesma view/rota master, sem duplicar (CA20). |
| §9 Telemetry Provider agnóstico | **CRIAR (contrato)** | `PlatformTelemetryProvider` (`queryMetric/queryRange/health`); implementações via host/Prometheus/OTel **validadas na F0-ambiente**. Domínio consome telemetria normalizada. |
| §12 C1 Host/VPS · C2 Container/Proc · C3 Aplicação · C4 Dependências | **CRIAR (instrumentação) + COMPOR** | Camadas 1-2 vêm do provider externo; C3 exige instrumentação HTTP nova (p50/p95/p99, event-loop, 5xx); C4 compõe provider-health. |
| §16-17 Database health/capacity | **ESTENDER** | Wrapper de métrica sobre `better-sqlite3` (query/write latency, locked/busy, tamanho, WAL/checkpoint) — **não** migrar banco (RN-PRC-8). |
| §18-19 Job Queue health | **REUTILIZAR + ESTENDER** | `JobQueueService.health()` + throughput/queue-delay/age-p95/failure-rate/backlog-growth. Fila distribuída só com evidência → ADR própria (§19). |
| §20-21 Provider/dependency health | **REUTILIZAR (IA) + CRIAR (não-IA)** | Reusar `SkillOsProviderHealthService`; criar health de WhatsApp/Asaas/e-mail/storage (latency/timeout/errors/breaker). |
| §22-23 Trace/correlation + deploy correlation | **CRIAR (mínimo)** | Middleware de `requestId` + propagação; capturar version/commit/deploy-ts no runtime e no `/api/health`. Reusa a filosofia `correlationId` da espinha. |
| §27-32 Headroom + Capacity Zones + Forecast | **CRIAR (determinístico)** | Zonas HEALTHY/OBSERVE/PLAN/ACT/CRITICAL por recurso; forecast trend+seasonality com `confidence` (§58). Sem LLM no cálculo (§57). |
| §35-37 Root-cause com evidência | **CRIAR + COMPOR** | Taxonomia (§36) correlacionando infra×app×DB×fila×provider×deploy; epistemologia fact/correlation/hypothesis/confidence (mesma do Radar/Context Engine). |
| §38-39 Recommendation Engine | **CRIAR (advisório)** | Diagnóstico → recomendação **explicável** (§77); **nunca executa** (V1, §39/CA16). |
| §41-45 Reliability-aware execution / Protection Mode | **CRIAR (estado) + REUTILIZAR (Runtime)** | Estado derivado NORMAL/PROTECT/DEGRADED/CRITICAL consumido pelo Runtime/Scheduler — **não** é Policy Engine novo (§42). Nunca perde operação crítica (§45). |
| §46-47 Platform Health Event (não-tenant) | **CRIAR (mínimo)** | Ledger global mínimo (molde `research_usage_log`), **jamais** em `business_signals` per-tenant (§47/RN-PRC-4). |
| §49-53 UX Admin Master + alertas | **ESTENDER** | Estender a view "Prontidão de Produção" (abas) + alertas proativos por Fala Tu/Push/in-app/e-mail (§53), com anti-spam por incidente (§54). |
| §60-65 Capacity Envelope / Load tests | **CRIAR (fora de produção)** | Envelope versionado por hardware/versão; testes só em staging/janela autorizada (§61). |
| §56-59 Anomaly + forecast confidence | **CRIAR (determinístico)** | Baseline/percentil/deviation/seasonality; toda previsão com sampleSize/horizon/method/confidence/dataQuality; sem dados → "não sei" (§59). |
| §82-86 Quality score + forecast accuracy | **CRIAR (derivado)** | Score composto abrível; accuracy das previsões medida a posteriori (§85). |

---

## 4. Decisões de arquitetura (D)

- **D1 — Não duplicar Production Readiness (§6/§48/CA20).** Configuration Readiness (existe) + **Operational Health** (novo) + **Capacity Intelligence** (novo) na MESMA área master.
- **D2 — Telemetria provider-agnóstica (§9/§10).** Contrato `PlatformTelemetryProvider`; ZapFlow **interpreta**, não vira TSDB. Implementação escolhida na F0-ambiente conforme o que o host já expõe.
- **D3 — Raw time-series NUNCA no SQLite operacional (§11/CA19).** O banco operacional guarda só incidente/previsão/recomendação/snapshot agregado/decisão. Raw fica no backend de observabilidade.
- **D4 — Sintoma antes de causa (§13).** Diagnóstico parte de SLO/latência/erro (cliente) → app → fila/banco/integração → container → host. Nunca começa pela CPU.
- **D5 — Determinístico antes de LLM (§56/§57).** Percentil/headroom/tendência/forecast são determinísticos; LLM só sintetiza/explica/compara hipóteses — nunca calcula número.
- **D6 — Recomendação ≠ execução (§39/CA16).** V1 nunca redimensiona/reinicia/migra/apaga automaticamente. Admin Master decide. Ação de infra governada fica **DEFERIDA** (§40).
- **D7 — Reliability Guard é ESTADO derivado, não Policy Engine (§42).** NORMAL/PROTECT/DEGRADED/CRITICAL — informação extra consumida pelo Runtime/Scheduler pra adiar carga NÃO-crítica; nunca toca no crítico (§43/§45).
- **D8 — Platform data é Admin Master only (§46/§87).** Tenant nunca vê infra global nem outro tenant; health público segue mínimo (§88).
- **D9 — Epistemologia fact/correlation/hypothesis/confidence (§35).** Mesma do Radar (ADR-161)/Context Engine; sem amostra → declara ausência, não inventa prazo (§59/CA11).
- **D10 — Platform Health Event separado do tenant (§47).** Ledger global mínimo (molde `research_usage_log`), fisicamente distinto de `business_signals`.

---

## 5. Guardrails duros (RN-PRC, a testar por fatia)

- **RN-PRC-1** — nunca recomendar upgrade de VPS por um pico único; correlacionar tráfego/CPU/RAM/disco/IO/rede/banco/fila/provider/deploy/SLO (§24/§39).
- **RN-PRC-2** — diferenciar **capacity problem × software regression × provider degradation** (CA13/CA14).
- **RN-PRC-3** — raw time-series jamais no SQLite operacional; só agregados/incidentes/decisões (§11/CA19).
- **RN-PRC-4** — Admin Master only; tenant nunca vê infra global; sem cross-tenant; nunca misturar platform event com `business_signals` per-tenant (§46/§47/§92/CA18).
- **RN-PRC-5** — telemetria nunca exporta secret/token/PII/prompt/mensagem de cliente; controle de cardinalidade (sem userId/contactId/phone em métrica global) (§89/§90/§91).
- **RN-PRC-6** — telemetria ausente/stale **≠** saúde; mostrar "observabilidade parcial" (§95/§96/CA24).
- **RN-PRC-7** — Reliability Guard nunca descarta/perde operação crítica nem marca execução como concluída sem execução (§45/CA23).
- **RN-PRC-8** — não migrar banco/fila nem instalar stack de observabilidade por hábito antes de medir (§10/§19/§117).
- **RN-PRC-9** — todo forecast carrega sampleSize/horizon/method/confidence/dataQuality; sem amostra suficiente não há previsão; accuracy medida a posteriori (§58/§59/§85/CA10/CA11).

---

## 6. Plano de fases (F0–F14) — mapeado ao PRD §98

| Fase | Entrega | Reúso dominante |
| --- | --- | --- |
| **F0** | **Esta auditoria (codebase) + matriz; metade de ambiente pendente (§13)** | doc/auditoria |
| **F1** | **Telemetry Contract (`PlatformTelemetryProvider`) + Null provider + fachada (FECHADA)** | CRIAR contrato |
| **F2** | **Host & Container metrics (C1/C2): fatia PROCESSO/RUNTIME (`NodeHostTelemetryProvider`) FECHADA; fatia HOST/INFRA pendente de ambiente** | COMPOR provider |
| **F3** | **Application SLI (p50/p95/p99, rps, 5xx/4xx por rota) via `HttpMetricsCollector` FECHADA; SLO por jornada crítica (F3.4) depende de baseline** | CRIAR instrumentação |
| **F4** | **Database + Queue + Provider health (`DependencyHealthService`) FECHADA** | REUTILIZAR + ESTENDER |
| **F5** | **Operational Health (`OperationalHealthService`, estende Production Readiness) FECHADA** | ESTENDER |
| F6 | Baselines & Anomaly detection (determinístico) | CRIAR |
| F7 | Capacity Headroom por recurso | CRIAR |
| F8 | Capacity Forecast (trend+seasonality+confidence) | CRIAR |
| F9 | Root-cause correlation (infra×app×DB×fila×provider×deploy) | CRIAR + COMPOR |
| F10 | Recommendation Engine (advisório, explicável) | CRIAR |
| F11 | Reliability-aware execution (Protection Mode, sem Policy Engine) | CRIAR estado + REUTILIZAR Runtime |
| F12 | Master Alerts (Fala Tu/Push/in-app/e-mail, anti-spam) | REUTILIZAR canais |
| F13 | Load tests & Capacity Envelope (fora de produção) | CRIAR controlado |
| F14 | Production hardening (security/cardinality/failure-injection/runbook) | ENDURECER |

**Ordem obrigatória (§101/§117):** telemetria → baseline → SLO → anomalia → headroom → forecast → causa → recomendação → alerta → só então considerar Reliability Guard. Rollout: local → staging → telemetry-only prod → baseline → shadow diagnosis → recomendações → alertas → guard (§101). **Shadow mode antes de o Guard alterar comportamento** (§102).

---

## 7. Critérios de aceite (§112, CA1–CA24) — rastreados

Os 24 CAs mapeiam às fases: (CA1) saúde operacional além de config → F5; (CA2-CA5) host/app/DB observáveis → F2-F4; (CA6) JobQueue incorporada → F4; (CA7) provider vs host latency → F4/F9; (CA8) deploy↔regressão → F9; (CA9) headroom por recurso → F7; (CA10/CA11) forecast com confidence e sem inventar → F8/RN-PRC-9; (CA12) SLO no centro → D4; (CA13/CA14) capacity × regression × provider → RN-PRC-2; (CA15) recomendação explicável → F10/§77; (CA16) upgrade nunca automático → D6; (CA17) aviso antes do crítico → F12; (CA18) tenant sem infra global → RN-PRC-4; (CA19) raw fora do SQLite → RN-PRC-3; (CA20) nada duplicado → D1; (CA21) Capacity Envelope versionado → F13; (CA22) forecast accuracy → F8/§85; (CA23) Guard nunca perde crítico → RN-PRC-7; (CA24) telemetria ausente ≠ saúde → RN-PRC-6.

---

## 8. O que NÃO construir (§117)

Outra plataforma de monitoramento dentro do ZapFlow; TSDB próprio; outro Runtime; outro Policy Engine; migração de banco/fila antes de medir; instalação de stack de observabilidade por hábito; recomendação de compra por pico único; execução automática de infra em V1.

---

## 9. Pendência de AMBIENTE (metade B da F0 — bloqueia F1)

O código foi auditado; **os números reais de produção não estão no GitHub** (§8/§68/§117). Antes da F1, o operador precisa fornecer:

1. **VPS/host:** vCPU, RAM, storage, banda (se exposta), SO — vira o `VPS Spec Profile` (§68/§69, `operator_configured`).
2. **Orquestração:** Docker/Coolify? limites de container (CPU/RAM/restart)?
3. **Telemetria já disponível:** o host/Coolify expõe métricas Prometheus-compatíveis / endpoint de métricas? — decide a implementação do `PlatformTelemetryProvider` (§9/§10).
4. **Volumes/backup:** onde o SQLite e os backups moram; tamanho atual do arquivo `.db`.

Sem esses dados, os recursos ficam marcados como pendentes (`operator_configured`) e o forecast declara ausência (§59) — nunca inventa.

---

## 10. Status

- **F0 — FECHADA (metade codebase).** Auditoria das 10 superfícies com evidência `file:symbol` + matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR. Confirmado: *Action Trust* e hooks operacionais existem; instrumentação time-series de *Delivery Trust* é nova (sem prom-client/OTel). Análise comparativa em `docs/prd/ANALISE-PRD7-vs-CODEBASE-E-INFRA.md`.
- **F5 — FECHADA.** Operational Health. `src/server/OperationalHealthService.ts` — **estende** a Prontidão de Produção sem duplicá-la (D1/CA20): compõe num snapshot único **Configuration Readiness** (reusa `ProductionReadinessService.report`) + **Operational Health** (runtime da F2 + SLI HTTP da F3 + dependências da F4) + **Capacity Intelligence** (`not_available`, F7+ — honesto). O estado operacional é derivado por limiar **absoluto e provisório**, e a **latência p95/p99 é REPORTADA mas NÃO classifica estado sozinha** — isso exige SLO/baseline (§14, F3.4/F6); só erro 5xx, event-loop lag e saúde de dependências entram no estado. Guardrails: sub-sinal indisponível → `unknown` (nunca "saúde", RN-PRC-6); platform-global/Admin Master (§46); só leitura (RN-PRC-3). Rota `GET /api/admin/operational-health` (herda `requireMasterAdmin`). `test:operational-health` (10 checks). Regressão `dependency-health`/`http-metrics`/`node-host-telemetry` PASS. **0 tabelas novas, 0 flags novas**, 0 breaking changes.
- **F4 — FECHADA.** Saúde de dependências. `src/server/DependencyHealthService.ts` — COMPÕE (não recria) fila + banco + provider health num snapshot único (Camada 4, §12), reusando `JobQueueService.health()`, `SkillOsProviderHealthService` e um probe LEVE de banco (latência de `SELECT 1` + tamanho do arquivo `.db`+WAL + modo journal). Deriva estado humano por limiar determinístico (healthy/watch/degraded): backlog velho (>15min) ou taxa de falha alta (>25%) na fila; latência de probe no banco; estado do provider de IA reusado do SkillOsProviderHealth. `overall` = pior dos três. **Guardrails:** provider de efeito externo ainda não instrumentado (WhatsApp/Asaas/e-mail/storage) é declarado `not_instrumented` — **nunca "healthy"** (RN-PRC-6); sub-probe que falha → `available:false`/`unavailable` (não finge); só leitura/derivação, nada de raw no SQLite (RN-PRC-3). Platform-global (§46). `test:dependency-health` (12 checks). Regressão `job-queue`/`http-metrics`/`node-host-telemetry` PASS. **0 tabelas novas, 0 flags novas**, 0 breaking changes.
- **F3 — FECHADA (instrumentação SLI HTTP).** `src/server/HttpMetricsCollector.ts` + middleware ligado no `server.ts` logo após o parse de JSON. Mede a experiência de entrega no próprio processo (não precisa de infra): buffer EM MEMÓRIA bounded das requisições recentes → `snapshot` deriva p50/p95/p99/max (**não média** — §15), rps e taxa de erro 5xx/4xx por classe + rotas mais lentas por p95. Middleware mede em `res.on('finish')` (zero latência no caminho da resposta), nunca lança. **Guardrails:** raw só em memória, efêmero, bounded — nunca no SQLite (RN-PRC-3); rota **normalizada** (`:id` pra num/uuid/hex/token, querystring removida) — baixa cardinalidade, sem URL-com-id/PII (RN-PRC-5/§90); sem amostra → `available:false`/`no_data` (RN-PRC-6). Platform-global (§46). O SLO por jornada crítica (§14/§99 F3.4) depende de baseline real (fase later). `test:http-metrics` (15 checks). **0 tabelas novas, 0 flags novas**, 0 breaking changes.
- **F2 — FECHADA (fatia processo/runtime).** `src/server/NodeHostTelemetryProvider.ts` — provider REAL que satisfaz o contrato da F1 lendo só o que o Node observa direto (`os`+`process`+event-loop delay), **sem nenhuma config de infra**: processo (RSS/heap/external, CPU acumulada, uptime, event-loop lag) + host visível ao Node (loadavg, memória total/livre/usedPct, nº de CPUs). O que o Node NÃO vê (disco/rede/swap/limites de container/IOPS) responde **honestamente `available:false`/`requires_host_provider`** (RN-PRC-6) — é a fatia HOST/INFRA da F2, pendente do provider real + dados de ambiente. `queryRange` responde `no_history` (Node só dá instantâneo; histórico exige TSDB — RN-PRC-3, não fabrica série). Registra no `PlatformTelemetryService` da F1. `test:node-host-telemetry` (18 checks). Regressão `platform-telemetry-contract` PASS. **0 tabelas novas, 0 flags novas**, 0 breaking changes.
- **F1 — FECHADA.** Telemetry Contract provider-agnóstico. `src/server/PlatformTelemetryContract.ts` (tipos `MetricPoint/MetricQuery/MetricResult/MetricRangeResult/TelemetryProviderHealth` + interface `PlatformTelemetryProvider` `queryMetric/queryRange/health` + `NullTelemetryProvider`) e `src/server/PlatformTelemetryService.ts` (fachada única + registry + flag). O domínio consulta métricas **normalizadas** sem conhecer o provider (§9). **Guardrails:** o Null é o padrão e responde **honestamente `available:false`/`not_configured`** (RN-PRC-6 — ausência nunca vira saúde); flag `platform_telemetry_enabled` + provider ativo vivem em `platform_settings` (**GLOBAL, não per-tenant** — RN-PRC-4); só leitura, nada de raw no SQLite (RN-PRC-3). Registrar/ativar provider real é da F2+. `test:platform-telemetry-contract` (15 checks). **0 tabelas novas, 0 flags per-tenant** (reusa `platform_settings`), 0 breaking changes.
- **F0 — metade AMBIENTE: PENDENTE** de dados do operador (§9 acima). Refinamento: **a F1 (contrato) NÃO dependia desses dados** — a abstração existe justamente pra construir o domínio antes de escolher o provider (§9). O que os dados de ambiente destravam é o **provider REAL** (host/container metrics) a partir da **F2**.
- **F2–F14 — pendentes**, cada uma = 1 fatia/PR, opt-in por flag (§100), Admin Master only, sem duplicar engine (CA20). Rollout shadow-first (§101/§102). **F2 bloqueada pelos dados de ambiente** (§9).
