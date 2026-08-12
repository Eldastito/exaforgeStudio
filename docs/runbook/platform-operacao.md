# Runbook — Operar Platform Trust, Reliability & Capacity (PRD 7 / ADR-164)

Referência única de operação da inteligência de plataforma: o que cada motor faz, como
ligar, quais rotas do Admin Master responder, e os guardrails que **não se regridem**.
Tudo é **GLOBAL/Admin Master** (nunca vaza pro tenant — RN-PRC-4), determinístico (roda em
CI sem chave de IA) e **advisório** (V1 nunca redimensiona/migra/compra — D6/CA16). Nada de
Runtime/Policy/observabilidade concorrente foi criado (CA20).

## 1. O que a onda é (mapa mental)

O `ProductionReadinessService` responde "**este deploy está configurado pra funcionar?**"
(Configuration Readiness). O PRD 7 acrescenta a outra metade — "**vai continuar bem sob
carga?**" (Delivery Trust) — observando, prevendo e recomendando, sem nunca agir sozinho.

| Camada | Service | Papel |
| --- | --- | --- |
| Contrato de telemetria | `PlatformTelemetryService` (+`PlatformTelemetryContract`) | Fachada única provider-agnóstica; Null honesto por default |
| Métricas de processo/runtime | `NodeHostTelemetryProvider` | Só o que o Node vê (RSS/heap/event-loop/loadavg); host/infra → `requires_host_provider` |
| SLI HTTP | `HttpMetricsCollector` (+middleware) | p50/p95/p99, rps, 5xx/4xx por rota normalizada — em memória, efêmero |
| Saúde de dependências | `DependencyHealthService` | Fila + banco + provider health num snapshot; não-instrumentado nunca vira "healthy" |
| Operational Health | `OperationalHealthService` | Config Readiness + runtime + SLI + deps num estado só |
| Baseline & anomalia | `PlatformBaselineService` (+`platform_health_snapshots`) | Baseline agregado sazonal; anomalia = HIPÓTESE; sem histórico → `insufficient_history` |
| Headroom | `CapacityHeadroomService` | Folga+zona por recurso (HEALTHY→CRITICAL); host-only → `not_available` |
| Forecast | `CapacityForecastService` | Tendência+confiança; ETA até o crítico; sem dias → `insufficient_history` |
| Causa provável | `PlatformRootCauseService` | Correlação sintoma→causa como HIPÓTESE; deploy → `not_available` |
| Recomendação | `CapacityRecommendationService` | Advisória e explicável; nunca executa |
| Protection Mode | `PlatformProtectionModeService` | Postura NORMAL/CAUTIOUS/PROTECTED; **shadow** por default |
| Master Alerts | `PlatformAlertService` (+`platform_health_events`) | Evento de plataforma com anti-spam; separado de `business_signals` |
| Capacity Envelope | `CapacityEnvelopeService` (+`loadtest:capacity`) | Limite seguro de rps derivado de teste de carga fora de produção |

## 2. Ligar a telemetria (opt-in, global)

A coleta e todos os motores de baseline/alerta ficam **desligados** até o operador ligar a
flag global (em `platform_settings`, não `organization_settings`):

```
PlatformTelemetryService.setEnabled(true)   // liga captura horária (Scheduler) + refresh de alertas
```

Enquanto desligada, **toda leitura é honesta** (`available:false`/`not_configured`) — ausência
nunca vira "saúde" (RN-PRC-6). Ligar não fabrica histórico: baseline/forecast só produzem
resultado útil **depois de dias acumulando** (§103).

## 3. Rotas do Admin Master

Todas herdam `requireMasterAdmin` (montagem do router `admin`). Nenhuma expõe segredo.

| Rota | Responde |
| --- | --- |
| `GET /api/admin/operational-health` | Estado operacional composto (F5) |
| `GET /api/admin/platform-baseline?metric=&seasonal=&days=` | Baseline de uma métrica (F6) |
| `GET /api/admin/platform-anomalies?days=` | Candidatos a anomalia (F6) |
| `GET /api/admin/capacity-headroom` | Folga por recurso + primeiro gargalo (F7) |
| `GET /api/admin/capacity-forecast?metric=&days=&horizon=` | Forecast (sem metric → visão de capacidade) (F8) |
| `GET /api/admin/platform-root-cause?days=` | Hipóteses de causa (F9) |
| `GET /api/admin/capacity-recommendations?days=&horizon=` | Recomendações advisórias (F10) |
| `GET /api/admin/protection-mode` · `POST /protection-mode/enforce {enforce}` | Postura + liga/desliga enforcement (F11) |
| `GET /api/admin/platform-alerts?severity=` · `POST /platform-alerts/refresh` | Eventos abertos + sync com recomendações (F12) |
| `GET /api/admin/capacity-envelope` · `POST /capacity-envelope {samples,sloP95Ms}` | Envelope corrente + derivar/persistir (F13) |

## 4. Rodar o teste de carga (fora de produção)

```
BASE_URL=https://staging.exemplo LEVELS=10,25,50,100 SLO_P95_MS=500 npm run loadtest:capacity
```

Aponte **para staging, nunca produção** (§107). O harness imprime as amostras + o envelope
derivado; **revise e só então** persista via `POST /capacity-envelope` (ou
`CapacityEnvelopeService.store`). Sem esse passo, `capacity-envelope` responde
`awaiting_load_test` — não inventa limite (§59).

## 5. Interpretar Protection Mode

- **Shadow (default):** a postura (`NORMAL/CAUTIOUS/PROTECTED`) é só reportada; `active:false`
  — não muda comportamento nenhum. Use pra observar antes de confiar.
- **Enforcement ligado** (`POST /protection-mode/enforce {enforce:true}`): em `PROTECTED`, só
  **trabalho adiável de plataforma** (captura de baseline pesada, digests, recomputações em
  lote) é candidato a diferir. **Operação crítica de cliente/execução confirmada/cobrança
  NUNCA é sacrificada** (CA23 — `neverDefers` no payload).

## 6. Guardrails que NÃO se regridem (RN-PRC — testados em `test:platform-hardening`)

1. **Raw fora do SQLite operacional** (RN-PRC-3) — persiste só agregado/incidente/envelope, nunca série bruta.
2. **Recomendação ≠ execução** (D6/CA16) — V1 nunca redimensiona, migra ou compra.
3. **Admin Master only** (RN-PRC-4) — nada de infra vaza pro tenant; flags em `platform_settings`.
4. **Determinístico antes de LLM** (§56/§57) — todos os motores rodam sem chave de IA.
5. **Telemetria ausente ≠ saúde** (RN-PRC-6) — sem dado → `available:false`/`not_available`.
6. **Nunca perde operação crítica** (RN-PRC-7/CA23) — o Guard só adia trabalho de plataforma.
7. **Não inventa** (§59/§103/RN-PRC-9) — sem histórico → `insufficient_history`; sem carga → `awaiting_load_test`.
8. **Platform Health Event separado** de `business_signals` per-tenant (F12).
9. **Anti-spam** (CA17) — 1 evento aberto por chave; notificação reflora só após a janela.

## 7. Pendência de AMBIENTE (declarada, não inventada)

Duas fatias dependem de dados que o GitHub não contém (§9 do ADR-164):

- **Fatia HOST/INFRA da F2** — disco/rede/swap/limites de container exigem o **provider de host**
  (VPS spec, orquestração, endpoint de métricas). Hoje respondem `requires_host_provider`.
- **SLO por jornada crítica (F3.4)** — depende de baseline real acumulado + definição de SLO.

Enquanto ausentes, os recursos ficam `not_available`/`insufficient_history` — **honestos**, nunca
fabricados. Assim que o operador fornecer os dados de ambiente, registra-se o provider real
(F2+) e o baseline/forecast passam a produzir resultado útil.
