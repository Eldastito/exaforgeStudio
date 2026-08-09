# ADR-158 — Espinha Única: rastreabilidade ponta-a-ponta + consolidação das pontas do ciclo (aditivo sobre ADR-135/136/152)

- **Status:** **EM ANDAMENTO** — Onda 0 do programa ZapFlow Execution Intelligence (ZEI). **F1 entregue** (correlationId + schema_version + ExecutionTraceService). F2..F4 planejadas.
- **Data:** 2026-08-09
- **Origem:** `PRD 0 — ZapFlow Execution Intelligence` + `ZAPFLOW — ESTADO FINAL ESPERADO`; auditoria de partida em `docs/prd/ANALISE-ESTADO-FINAL-vs-REPO.md`.
- **Relacionadas:** ADR-136 (Decision & Action Ledger / `business_signals`), ADR-135 (Snapshot/Evidence), ADR-152 (Runtime), ADR-085 D4 (separação de categorias de impacto). CLAUDE.md convenções nº 1 (isolamento), nº 2 (CREATE-then-ALTER), nº 4 (derivação por query), nº 12 (BusinessSignal).

---

## Contexto

A auditoria do `main` (docs/prd/ANALISE-ESTADO-FINAL-vs-REPO.md) constatou que a espinha dorsal do ciclo universal **já existe**:

```
business_signals → ProcessRuntime → decision_actions → CommandExecutor → ConfirmationEngine → action_outcomes
```

Mas com três defeitos estruturais: **(1)** as duas pontas estão fragmentadas em ilhas paralelas (7 tabelas de "alerta"; ≥6 contabilidades de impacto); **(2)** o elo sinal→processo não é automático; **(3)** não há um fio único (`correlationId`) atravessando o fluxo — logo o sistema não consegue responder "por que o ZapFlow fez isso?" (PRD 0 §50, Estado Final §66).

Esta ADR ataca o problema **de forma aditiva e reversível**, sem criar engine/tabela novos de percepção ou de impacto (PRD 0 §54 anti-inflação).

---

## Decisões

### D1 — `correlation_id` como fio único do ciclo (F1 — ENTREGUE)

Todo registro das três tabelas-espinha ganha `correlation_id TEXT` (aditivo). Regras de herança determinísticas:

- **Sinal sem correlationId enraíza a própria cadeia** (`correlation_id = id` do sinal).
- **Decisão herda** o correlation_id do sinal de origem (via `signalId`); sem sinal, enraíza cadeia própria; um correlationId explícito sempre vence.
- **Outcome herda** o correlation_id da ação.
- **Dedupe nunca reescreve** o correlation_id (a identidade da cadeia é estável).

Compatibilidade: linhas legadas ficam com `correlation_id NULL` — não aparecem no trace, e nenhum fluxo pré-existente muda.

### D2 — `schema_version` por registro (F1 — ENTREGUE)

Cada registro-espinha ganha `schema_version INTEGER NOT NULL DEFAULT 1` para evoluir o contrato sem quebrar leitores antigos (base para F2/F3 abaixo).

### D3 — Primitiva de rastreabilidade (F1 — ENTREGUE)

`ExecutionTraceService.trace(orgId, correlationId)` reconstrói o fio `sinais → ações → outcomes`, isolado por org (o correlationId sozinho nunca vaza cadeia de outro tenant — toda query filtra `organization_id`, convenção nº 1). Exposto em `GET /api/decision-intelligence/trace/:correlationId` (read-only). `closedLoop = true` quando há sinal **e** ação **e** outcome no fio — a métrica de "ciclo fechado" do PRD §35.

### D4 — Consolidar a ponta de PERCEPÇÃO (F2 — PLANEJADA)

Migrar detectores fora-do-contrato (`OpportunityRadar`→`opportunities`, `RecoveryRadar`→`recovery_events`, `ManipulationRadar`→`manipulation_alerts`) para publicar em `business_signals` (novos domains `opportunity`/`recovery`/`reputation`), com as tabelas antigas viradas em projeção ou aposentadas. Adicionar `subject_type` de 1ª classe e `expires_at`/TTL ao contrato de sinal. **Nunca** criar tabela de alerta nova (convenção nº 12).

### D5 — Consolidar a ponta de IMPACTO (F3 — PLANEJADA)

Retail/Comigo/RIC passam a **emitir em `action_outcomes`** via adaptadores (sem 2ª contabilidade), reusando `evidence_json` para rastreabilidade. Categorias faltantes do PRD (receita incremental, retenção, inadimplência recuperada, risco mitigado) entram como colunas aditivas — **nunca somadas entre si** (ADR-085 D4).

### D6 — Auto-disparo sinal→processo (F4 — PLANEJADA)

Roteador genérico que, para sinais de domínio/tipo mapeados, inicia a `process_instance` correspondente automaticamente — fechando o elo hoje manual — sob feature flag e governado pelo Autonomy Contract (ADR-159).

---

## Guardrails (RN-158, testados)

- **RN-158-1** — Isolamento: `trace()` e toda leitura por correlation_id filtram `organization_id`. Um correlationId de um tenant retorna vazio em outro (testado).
- **RN-158-2** — Aditividade: colunas via CREATE-then-ALTER no fim de `db.ts` (convenção nº 2), nunca reordenadas; linhas legadas seguem válidas.
- **RN-158-3** — Dedupe estável: republicar um sinal não troca seu correlation_id nem duplica o fio (testado).
- **RN-158-4** — Sem 2ª contabilidade/percepção: F2/F3 **estendem** `business_signals`/`action_outcomes`; é proibido criar tabela de alerta ou de impacto paralela (convenção nº 12, PRD 0 §54).

## Status das fatias

| Fatia | Escopo | Status |
| --- | --- | --- |
| **F1** | correlation_id + schema_version + herança sinal→decisão→outcome + `ExecutionTraceService` + rota trace + teste | **ENTREGUE** |
| **F2.1** | Contrato ganha `subject_type`+`expires_at`; **OpportunityRadar** projeta em `business_signals` (domain=opportunity) sob flag `radar_signals_unified_enabled`; `disguised_opportunities` vira projeção | **ENTREGUE** |
| F2.2 | **RecoveryRadar** → `business_signals` (domain=recovery), mesma flag; `recovery_events` vira projeção | planejada |
| F2.3 | **ManipulationRadar** → `business_signals` (domain=reputation), mesma flag; `manipulation_alerts` vira projeção | planejada |
| F3 | Adaptadores Retail/Comigo/RIC → `action_outcomes` (+categorias faltantes) | planejada |
| F4 | Auto-disparo genérico sinal→process_instance (flag + governado) | planejada |

**F2.1 (entregue) — desenho de não-regressão:** a publicação é **opt-in** (flag `radar_signals_unified_enabled`, default 0) e **best-effort** (nunca derruba o scan). O sinal é DERIVADO da mesma computação do `upsert` (dedupe_key `opportunity:<id>` = 1 sinal por oportunidade), então `disguised_opportunities` e `business_signals` **não divergem** — a tabela antiga segue intacta para os consumidores atuais (rota da UI, `SalesStalledDealDetector`), agora como projeção. Categorias heurísticas por palavra-chave → `basis='estimate'`. Números: 2 colunas aditivas no contrato + 1 flag + 1 índice + 1 método (`publishOpportunitySignal`) + 1 suíte (`test:radar-signals-unified`, 17 checks). 0 breaking changes.

**Números F1:** 6 colunas aditivas + 3 índices + 1 service novo (`ExecutionTraceService`) + 1 rota read-only + 1 suíte de teste (`test:execution-trace`, 19 checks). 0 breaking changes.
