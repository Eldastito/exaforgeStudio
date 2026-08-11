# Runbook — Operar o Radar Empresarial (PRD 2)

**Escopo:** operar, habilitar e diagnosticar o **Radar** — a camada transversal de percepção que transforma `business_signals` num radar empresarial (anomalia + correlação + contexto + metas + impacto + evidência + prioridade). Referência de arquitetura: `docs/prd/ANALISE-PRD2-RADAR-vs-REPO.md`.

**Princípio inegociável (§5/CA1):** o Radar **não** tem ledger/feed/alerta próprio. A fonte canônica é a tabela `business_signals` e o serviço `BusinessSignalService`. Todo detector publica ali (com `dedupe_key`); nada cria tabela paralela de "alertas". Se você está pensando em criar uma, pare — releia o CA1.

---

## 1. O que o Radar é (mapa mental)

O Radar percebe por **três origens**, todas normalizadas no mesmo ledger:

| Origem | Como entra | Serviço | `basis` |
| --- | --- | --- | --- |
| **Humana** | observação de uma pessoa (Fala Tu/UI) — "terceiro cliente procurando o produto X" | `HumanSignalService.observe` (F9) | `estimate`/`hypothesis` — **nunca `fact`** |
| **Digital** | detectores de anomalia sobre os dados da org | `AnomalyDetectorRegistry` + publishers (F4) | conforme o detector |
| **Externa** | review/reclamação/menção de mercado *sobre* a org | `ExternalSignalService.ingest` (F10) | `estimate` (só `fact` se `verifiable`) |

Sobre o ledger, as camadas de inteligência (todas **determinísticas** — rodam em CI sem chave de IA):

- **Anomalia** (`anomalyPrimitives` + `AnomalyDetectorRegistry`, F4) — baseline/desvio/percentil/min-sample/cooldown/TTL.
- **Correlação** (`SignalCorrelationService`, F3) — N sinais → 1 situação (alta: mesmo sujeito; média: mesmo tipo em sujeitos distintos). **Evidência individual sempre preservada.**
- **Investigação** (`SignalInvestigationService`, F6) — causa-candidata determinística (evidência a favor/contra + confiança, `basis: hypothesis`). Síntese por IA (`investigateDeep`) só no L3+ e com budget (ver §5).
- **Priorização** (`ImpactPrioritizationService`, F5/F7) — score de 5 fatores + boosts situacionais (meta atrasada, SLA, irreversibilidade). Determinístico.
- **Roteamento** (`SignalProcessRouterService`, F8) — sinal → processo maduro (mapa explícito + `recommendedProcessType` com allowlist). **Auto-trigger ≠ auto-execute** (§43/CA13): o gate real é o RBAC/`ApprovalPolicyService`.
- **Calibração** (`SignalCalibrationService`, F11) e **Saúde** (`RadarHealthService`, F12.1) — observabilidade.

---

## 2. Habilitar por tenant (opt-in, reversível)

Todos os incrementos são **opt-in por flag** em `organization_settings` (default OFF — convenção #10). Habilitar é aditivo; desabilitar volta ao comportamento anterior sem perda de dado.

| Flag | O que liga | Fatia |
| --- | --- | --- |
| `radar_attention_correlate_enabled` | colapsa situações correlatas no attention feed | F3.2 |
| `radar_human_signals_enabled` | ingestão de observação humana (`POST /observe`) | F9 |
| `radar_external_signals_enabled` | ingestão de sinal externo (`POST /ingest-external`) | F10 |
| `radar_detector_daily_budget` | teto diário de investigação por detector (>0 = override; 0 = default 20/dia) | F12.2 |
| `signal_auto_trigger_enabled` | roteamento automático sinal→processo (ainda passa pela policy) | F8 |
| `anomaly_detector_enabled` | packs de detectores de anomalia | F4 |

Para ligar numa org (exemplo, dentro do container do app — mesmo SQLite de produção):

```sql
UPDATE organization_settings SET radar_human_signals_enabled = 1 WHERE organization_id = '<orgId>';
```

**Rollback:** `SET ... = 0`. Os sinais já publicados permanecem no ledger (nunca se apaga — retenção; cancelamento é status, não DELETE).

---

## 3. Endpoints (todos isolados por org)

| Método | Rota | Papel | Uso |
| --- | --- | --- | --- |
| GET | `/api/signals` | — | lista sinais (`?status=&domain=`) |
| GET | `/api/signals/attention` | — | leitura transversal "o que precisa de atenção" (`?correlate=1`) |
| GET | `/api/signals/correlations` | — | situações (clusters de alta confiança) |
| GET | `/api/signals/:id/investigate` | — | causa-candidata (`?deep=1` tenta a síntese por IA) |
| GET | `/api/signals/calibration` | — | qualidade por detector (false-positive/dismissal rate) |
| GET | `/api/signals/health` | **owner/admin** | saúde operacional do Radar (volume/freshness/storm/status) |
| GET | `/api/signals/detector-budget` | **owner/admin** | teto e consumo diário de investigação por detector |
| POST | `/api/signals/observe` | — | registra observação **humana** (opt-in) |
| POST | `/api/signals/ingest-external` | — | ingere sinal **externo** (opt-in) |
| POST | `/api/signals/:id/acknowledge` \| `/dismiss` | — | reconhecer / dispensar (`dismiss` aceita `reason`) |

---

## 4. Diagnóstico — comece sempre pela Saúde

`GET /api/signals/health` devolve `overall: ok | watch | degraded` e, por detector: `emittedWindow`, `ageHours`, `stale`, `stormRisk`, `calibration`, `falsePositiveRate`, `dismissalRate`, `status`. É o primeiro lugar a olhar em qualquer incidente do Radar.

> **UI:** o painel **"Radar — Saúde"** (menu Master Admin, `RadarHealthView`) materializa `/health` + `/detector-budget` — verdito geral, volume por severidade, e por detector o status/frescor/calibração + a barra de consumo do budget de IA do dia. Pura leitura.

### Incidente: detector em **storm** (volume anômalo)

- **Sintoma:** `health.detectors[].stormRisk = true`, `overall = degraded`, pico de sinais de um `source_service`.
- **Impacto contido por design:** o teto por-detector (F12.2) já impede que ele drene a verba de IA — investigações extras voltam com `aiGate: budget_exhausted` (só o determinístico). Confirme em `GET /api/signals/detector-budget`.
- **Ação:** identifique o detector; se for ruído real, revise o threshold do detector no `AnomalyDetectorRegistry` (ou o cooldown/TTL). **Não** crie supressão ad-hoc — ajuste a definição do detector.

### Incidente: detector **stale** (parou de emitir)

- **Sintoma:** `health.detectors[].stale = true`, `ageHours` alto. Como o CA16 garante que um detector isolado não derruba o resto, a falha é **silenciosa** — a Saúde é o único lugar onde ela aparece.
- **Ação:** verifique o job/publisher daquele detector (erro no pass? fonte de dados vazia? flag desligada?). Freshness voltar ao normal quando ele reemitir.

### Incidente: detector **mal calibrado** (falso-positivo alto)

- **Sintoma:** `calibration = poor` (dismissalRate > 0.9) em `/health` ou `/calibration`; `dismissReasons.incorrect` alto.
- **Ação:** o detector está gritando ruído — revise threshold/janela. Peça aos operadores que usem `dismiss` **com `reason`** (`incorrect` = falso-positivo) para a métrica refletir a realidade.

### Incidente: **budget de investigação esgotado**

- **Sintoma:** `investigateDeep` devolve `aiGate: budget_exhausted`; `/detector-budget` mostra `remaining: 0`.
- **É esperado** se o detector foi legitimamente ativo. Se um detector-chave precisa de mais, suba o override: `UPDATE organization_settings SET radar_detector_daily_budget = <N> WHERE organization_id = '<orgId>'`. O teto é proteção de **custo**, não gate de segurança — reseta no início do dia (UTC).

### Incidente: **sinal antigo não some** do attention

- **Causa histórica:** TTL inerte por comparação de string ISO (resolvido na F2.2 com `datetime(expires_at)`). Se reincidir, confirme que `expires_at` está sendo gravado e rode `BusinessSignalService.expireStale(orgId)` (idempotente) para o status refletir a expiração.

---

## 5. Guardrails que NÃO se regridem

- **Fato × interpretação (§13):** o Radar nunca promove hipótese/estimativa a fato. Sinal humano e externo entram como `estimate`/`hypothesis`; investigação sai como `hypothesis`; a manchete é sempre "a causa **mais provável** é…".
- **Auto-trigger ≠ auto-execute (§43/CA13):** o roteamento pode *disparar* um processo, mas a execução passa pelo RBAC/`ApprovalPolicyService`. O Radar não decide sozinho gastar dinheiro nem agir sobre cliente.
- **IA nunca é o loop principal (§81-83):** o default é determinístico (roda em CI sem chave). O LLM só **sintetiza/interpreta** o que as regras já calcularam, gated por impacto (L3+) e por budget (F12.2). Nunca calcula número, nunca inventa causa.
- **Isolamento multi-tenant:** toda query filtra `organization_id`; todo service recebe `orgId` como 1º arg. Cross-tenant é bug de segurança.
- **Derivado por query (RN-004):** saldo de budget, calibração, saúde, saldo de ciclo — tudo derivado, nunca contador mutável.

---

## 6. Checklist de go-live do Radar numa org

1. `anomaly_detector_enabled = 1` (detectores digitais) — confirme que os publishers rodam no Scheduler.
2. (Opcional) `radar_human_signals_enabled` / `radar_external_signals_enabled` se a org vai usar as origens humana/externa.
3. `GET /api/signals/health` → `overall = ok` e detectores frescos.
4. `GET /api/signals/attention` retornando os sinais esperados.
5. Se for usar roteamento automático: `signal_auto_trigger_enabled = 1` **e** confirme que a policy do domínio/ação existe em `ApprovalPolicyService`.
6. Ajuste `radar_detector_daily_budget` só se a org tiver detectores muito ativos que justifiquem passar do default (20/dia).
7. Acompanhe `GET /api/signals/calibration` na 1ª semana — detector `poor` = threshold a revisar.
