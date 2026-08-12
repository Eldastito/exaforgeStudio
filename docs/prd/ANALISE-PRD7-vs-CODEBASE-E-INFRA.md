# Análise Comparativa — PRD 7 (Platform Reliability & Capacity) × Codebase + Infra

**Escopo:** entregável da F0 do PRD 7 (ADR-164). Prova, com evidência `file:symbol`, o que já existe no `main` e o que é genuinamente novo — para que a implementação seja **predominantemente REUTILIZAR/ESTENDER/COMPOR**, e só o mínimo CRIAR.

**Conclusão executiva:** a espinha de **Action Trust** (autonomia/policy/executor/rollout/canary/kill-switch/audit) está pronta e é reusada, não recriada. A lacuna real é **Delivery Trust**: o ZapFlow sabe se está *configurado* para funcionar, mas não sabe se *continuará* funcionando sob crescimento de carga. A instrumentação de séries temporais (host/app/DB/fila/provider) é a única capacidade de fundo nova — confirmada pela **ausência de `prom-client`/OpenTelemetry** no `package.json`.

---

## 1. Matriz REUTILIZAR / ESTENDER / COMPOR / CRIAR

| Capacidade | Existe | Parcial | Não existe | Reutilizar | Estender | Criar |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Configuration Readiness (`ProductionReadinessService`) | ✅ | | | | ✅ | |
| Job Queue health (`JobQueueService.health`) | ✅ | | | ✅ | ✅ | |
| Banco WAL + backup | | ✅ | | ✅ | ✅ | |
| Métricas de latência/tamanho de query (DB) | | | ✅ | | | ✅ |
| Scheduler (passes) | ✅ | | | ✅ | | |
| Provider health — IA (`SkillOsProviderHealthService`) | ✅ | | | ✅ | | |
| Provider health — WhatsApp/Asaas/e-mail/storage | | | ✅ | | | ✅ |
| `correlationId` de domínio + `ExecutionTraceService` | ✅ | | | ✅ | | |
| `requestId`/`traceId` de HTTP (middleware) | | | ✅ | | | ✅ |
| Ledger global (`research_usage_log`, `platform_settings`) | ✅ | | | ✅ | | |
| "Platform Health Event" dedicado (não-tenant) | | | ✅ | | | ✅ (mínimo) |
| Deploy/version/commit no runtime | | | ✅ | | | ✅ |
| Métricas de aplicação (p50/p95/p99, rps, 5xx, event-loop) | | | ✅ | | | ✅ |
| Área Admin Master "Prontidão de Produção" | ✅ | | | | ✅ | |
| Telemetry provider agnóstico | | | ✅ | | | ✅ (contrato) |
| Baseline/anomalia/headroom/forecast/root-cause/recomendação | | | ✅ | | | ✅ (determinístico) |
| Reliability-aware execution (Protection Mode) | | ✅ | | ✅ (Runtime) | | ✅ (estado) |
| Autonomy/Policy/Executor/rollout/canary/kill-switch/audit | ✅ | | | ✅ | | |

---

## 2. Evidência por área (resumo da auditoria F0)

1. **Configuration Readiness** — `ProductionReadinessService.ts:57` `report()` → `ready\|degraded\|blocked` sobre env/config; rota `routes/admin.ts:28`; view `ProductionReadinessView.tsx`; probe `server.ts:399`. **Não mede runtime.**
2. **Job Queue** — `JobQueueService.ts:48` in-process (`setImmediate` `:62`, comentário `:6`); `health()` `:143` = pending/processing/completed/failed/total/oldestPending; retry/dead-letter `:163/:181`.
3. **Banco** — `db.ts:12` WAL; `busy_timeout=5000` `:16`; **sem** PRAGMAs de perf; `BackupService.ts:53` via `Scheduler.backupPass:1208`; **sem** métrica de query.
4. **Scheduler** — `Scheduler.ts:70`, `tick` horário `:733` / `fastPass` 5min `:95`; dezenas de `xxxPass`. Encaixe direto para pass de coleta/baseline.
5. **Provider health** — só IA: `SkillOsProviderHealthService.ts:34` `state()` (`healthy/watch/degraded/open`), `AiReliabilityKernel.ts:35` `latencyMs`. Não-IA: ausente.
6. **Trace** — `correlationId` de domínio (`business_signals`/`decision_actions`/`process_instances`), `ExecutionTraceService.ts:36`; **sem** requestId/traceId HTTP.
7. **Ledger** — `business_signals` per-tenant (`db.ts:5941`); global: `platform_settings:8195`, `research_usage_log:8179` (append-only, "sem organization_id"), `vertical_intelligence:8115`. Sem "Platform Health Event".
8. **Deploy/versão** — `package.json:4` `0.0.0`; `/api/health` `server.ts:397` sem version/commit/uptime.
9. **Métricas de app** — ausência confirmada (p50/p95/p99/rps/5xx/event-loop). Única latência: IA (`ai_usage_log`).
10. **Admin Master** — `Sidebar.tsx:93` `production_readiness` gated `isMasterAdmin`; estender a view/rota, sem menu novo.

---

## 3. Riscos e fronteiras (o que não fazer)

- **Não** recriar Runtime, Policy Engine, Radar ou Production Readiness (RN-PRC-8 / CA20).
- **Não** gravar raw time-series no SQLite operacional (RN-PRC-3 / CA19) — usar backend de observabilidade; persistir só incidente/previsão/recomendação/snapshot/decisão.
- **Não** migrar banco/fila nem instalar stack por hábito antes de medir (§10/§19).
- **Não** recomendar upgrade por pico único (RN-PRC-1) nem executar ação de infra em V1 (D6/CA16).
- **Não** vazar dados de plataforma para tenants (RN-PRC-4 / CA18).

---

## 4. Pendência de ambiente (bloqueia F1)

O GitHub prova o código, não a infra. Antes da F1, o operador fornece (ver ADR-164 §9): VPS spec (vCPU/RAM/storage/banda/SO), orquestração + limites de container, telemetria já exposta pelo host (Prometheus-compatível?), volumes/backup + tamanho atual do `.db`. Enquanto ausente: recursos marcados `operator_configured` e forecast declara ausência (§59) — nunca inventa.
