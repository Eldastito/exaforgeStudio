# ADR-160 — Onda A do ZEI: percepção transversal + Context Engine (aditivo sobre ADR-135/136/152/158/159)

- **Status:** **EM ANDAMENTO** — abre a **Onda A** do programa ZapFlow Execution Intelligence, sobre a base já consolidada pela Onda 0 (ADR-158 espinha única + ADR-159 governança, ambas fechadas em produção). **F1 (leitura transversal de atenção) ENTREGUE**; **F2 (snapshot como leitura default) ENTREGUE**; F3..F4 planejadas.
- **Data:** 2026-08-10
- **Origem:** `PRD 0 — ZapFlow Execution Intelligence` + `ZAPFLOW — ESTADO FINAL ESPERADO`; auditoria de partida `docs/prd/ANALISE-ESTADO-FINAL-vs-REPO.md` §8 (sequência recomendada) e a matriz REUTILIZAR/ESTENDER/CRIAR §2.
- **Relacionadas:** ADR-158 (espinha única — `business_signals`/`correlation_id`/`subject_type`/`expires_at`), ADR-159 (governança — Autonomy Contract **já entregue**, thread 4 da Onda A), ADR-135/136 (Snapshot/Evidence, Decision & Action Ledger). CLAUDE.md convenções nº 1 (isolamento), nº 2 (CREATE-then-ALTER), nº 4 (derivar por query), nº 12 (BusinessSignal — sem tabela de alerta nova).

---

## Contexto

Fechada a Onda 0 (a espinha desfragmentada + o hardening de governança), a **Onda A** entrega as capacidades do PRD 0 **sobre base limpa**. A auditoria (§8) recomenda explicitamente **não** começar pelo Fala Tu (o "segundo cérebro" — 18 tabelas `falatu_*` paralelas a `TaskService`/`AppointmentService`; maior risco arquitetural), e sim consolidar percepção/contexto primeiro. Dos 4 threads da Onda A, o **Autonomy Contract já foi entregue pela ADR-159** (bandas valor→papel, escalonar, progressive autonomy). Restam:

1. **Percepção transversal** — a ADR-158 F2 já unificou os detectores (Opportunity/Recovery/Manipulation) em `business_signals` na ESCRITA; falta uma **leitura ÚNICA** "o que precisa de atenção agora" que funda sinais + riscos + prioridades.
2. **Context Engine** — `BusinessSnapshotV2` recalcula stateless a cada chamada (§4.4, custo/latência); o `EvidencePackageService` (DI-1) já persiste/versiona/cacheia sob flag, mas não é o caminho de leitura default. Convergir `Context(string)` + `V2`.
3. **Fala Tu → porta I/O** — o refactor de maior risco; **deferido** para o fim da onda.

Aditivo e reversível (PRD 0 §54 anti-inflação): **estender** o que existe, nunca duplicar.

---

## Decisões

### D1 — Leitura transversal de atenção (F1 — ENTREGUE)

`BusinessSignalService.attention(orgId)` é a superfície ÚNICA de percepção: funde, **ranqueado por severidade** e **ciente do `expires_at`** (TTL da F2), os `business_signals` abertos e os `decision_risks` (DI-2) ainda vivos — normalizando os dois vocabulários de severidade numa escala só (`critical>risk>attention>info`). **Derivado por query** (RN-004): zero tabela nova (RN-158-4). Exposto em `GET /api/signals/attention`. É o feed que a UX invisível usa pra fundir os "4 inbox de prioridades" (§7) e que consumidores downstream (Diretor IA, metas) leem como um lugar só.

### D2 — Context Engine: snapshot como leitura default (F2 — ENTREGUE)

Apontar os consumidores do snapshot (Diretor/Advisor) pro `EvidencePackageService` (que já persiste/versiona/cacheia o `BusinessSnapshotV2`) em vez de recomputar stateless; opcional `schema_version` no `evidence_packages`. Mata o custo/latência do §4.4 — sem capacidade nova, só adoção.

**F2 — ENTREGUE (2026-08-10).** `BusinessSnapshotV2Service.read(orgId, period)` é o novo caminho de leitura default: quando a org liga o Evidence Layer (`evidence_layer_enabled`, DI-1), serve o snapshot do **cache TTL'd** do `EvidencePackageService` (persistido); senão computa fresco — **comportamento idêntico ao de hoje** (flag default 0 → 0 regressão). A forma devolvida é a MESMA do `build()` (organization/period/dataQuality/domains/topPriorities), reconstruída **sem perda** do pacote (`internalEvidence`=domains), + `schemaVersion` (contrato) + `_cache` (freshness/cacheHit/generatedAt/expiresAt) aditivos. Os 2 consumidores diretos (`ExecutiveAdvisorService.snapshotBlockV2` e `GET /api/business/snapshot`) foram repontados de `.build` → `.read`. Ciclo ESM `BusinessSnapshotV2Service`↔`EvidencePackageService` resolvido por binding vivo (acesso só em tempo de chamada). **Números:** 1 método novo (`read`) + 2 consumidores repontados + 1 suíte (`test:snapshot-read-default`, 12 checks). 0 tabelas novas, 0 breaking changes.

### D3 — Convergir Context(string) + V2 (F3 — PLANEJADA)

Unificar o `BusinessContextService.build` (texto) com o `BusinessSnapshotV2` (JSON) num contrato só, para o Advisor parar de concatenar duas representações.

### D4 — Modelo de objetivos/metas + distância à meta (F4 — PLANEJADA, CRIAR)

Net-new: metas por org (receita/atendimento/...) e a **distância à meta** derivada do snapshot/RIC. Consome o snapshot persistido (D2). Own scope — depende de o dono definir metas.

> Fala Tu → porta I/O fica para o **fim da Onda A** (maior risco; refatora roteamento WhatsApp + 2 stacks de RAG + domínio task/event/list/entity). Não abrir antes de percepção/contexto estáveis.

---

## Guardrails (RN-160, testados)

- **RN-160-1** — Isolamento: `attention()` e toda leitura filtram `organization_id` (convenção nº 1).
- **RN-160-2** — Derivar por query, sem tabela/contador novo (RN-004 + nº 12 + RN-158-4). F1 não cria storage.
- **RN-160-3** — TTL respeitado: sinal `expired` (via `expires_at` da F2) não aparece na atenção; `acknowledged/resolved` e risco `resolved` idem.
- **RN-160-4** — Aditivo/reversível: sem migração; consumidores atuais (`/api/signals`, DI-2) inalterados.

## Status das fatias

| Fatia | Escopo | Status |
| --- | --- | --- |
| **F1** | D1 — leitura transversal de atenção (`BusinessSignalService.attention` + `GET /api/signals/attention`; funde sinais+riscos, ranqueada por severidade, TTL-aware) | **ENTREGUE** |
| **F2** | D2 — snapshot como leitura default (`BusinessSnapshotV2Service.read` via `EvidencePackageService`; cache TTL'd quando ligado, fresco quando off) | **ENTREGUE** |
| F3 | D3 — convergir Context(string)+V2 | planejada |
| F4 | D4 — modelo de objetivos/metas + distância à meta (CRIAR) | planejada |
| F5+ | Fala Tu → porta I/O (deferido; maior risco) | planejada |

**Números F1:** 1 método novo (`attention`) + 1 helper (`shortSummary`) + 1 rota read-only + 1 suíte (`test:signals-attention`, 14 checks). 0 tabelas novas, 0 breaking changes.
