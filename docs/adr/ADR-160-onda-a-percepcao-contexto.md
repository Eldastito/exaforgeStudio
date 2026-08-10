# ADR-160 — Onda A do ZEI: percepção transversal + Context Engine (aditivo sobre ADR-135/136/152/158/159)

- **Status:** **EM ANDAMENTO** — abre a **Onda A** do programa ZapFlow Execution Intelligence, sobre a base já consolidada pela Onda 0 (ADR-158 espinha única + ADR-159 governança, ambas fechadas em produção). **F1 (leitura transversal de atenção) ENTREGUE**; **F2 (snapshot como leitura default) ENTREGUE**; **F3 (convergir Context+V2) ENTREGUE**; **F4 (metas + distância à meta) ENTREGUE**; **F5 (Fala Tu → porta I/O: bridge de tarefas) ENTREGUE**; **F6 (Fala Tu → porta I/O: bridge de eventos→agenda canônica) ENTREGUE** — 2 fatias do thread de maior risco; F7+ (listas, roteamento WhatsApp, dedup de RAG) seguem.
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

### D3 — Convergir Context(string) + V2 (F3 — ENTREGUE)

Unificar o `BusinessContextService.build` (texto) com o `BusinessSnapshotV2` (JSON) num contrato só, para o Advisor parar de concatenar duas representações.

**F3 — ENTREGUE (2026-08-10).** `ContextEngineService` é o **contrato único**: `build(orgId)` funde a NARRATIVA (`BusinessContextService.build`) com o SNAPSHOT V2 por domínio (`BusinessSnapshotV2Service.read` — a leitura cacheada da F2, sob a flag `diretor_snapshot_v2`) num objeto só `{ narrative, snapshot, snapshotEnabled, sources, generatedAt, schemaVersion }`, com `sources` distinguindo cache vs fresco (herdado do `_cache` da F2). `render(orgId)` devolve **byte-a-byte** o texto que o `ExecutiveAdvisorService` colava antes (narrativa + bloco "PANORAMA EMPRESARIAL V2"), então `buildPanorama` passou a chamar o Context Engine **uma vez** em vez de conhecer os dois serviços e a ordem da colagem — o `snapshotBlockV2` privado foi removido. Fachada aditiva/reversível: `BusinessContextService` (usado também pelo Zapp orchestrator, narrativa pura) e a rota `/api/business/snapshot` seguem intactos. Contrato exposto read-only em `GET /api/business/context` p/ observabilidade. **Números:** 1 service novo (`ContextEngineService`, build+render) + 1 rota read-only + Advisor repontado (−`snapshotBlockV2`) + 1 suíte (`test:context-engine`, 14 checks, incl. equivalência byte-a-byte). 0 tabelas novas, 0 breaking changes.

### D4 — Modelo de objetivos/metas + distância à meta (F4 — ENTREGUE)

Net-new: metas por org (receita/atendimento/...) e a **distância à meta** derivada do snapshot/RIC. Consome o snapshot persistido (D2). Own scope — depende de o dono definir metas.

**F4 — ENTREGUE (2026-08-10).** `business_goals` (tabela nova, org-wide, 1 meta vigente por métrica — `UNIQUE(organization_id, metric)`, upsert) guarda **só o ALVO** definido pelo dono. `BusinessGoalService` deriva a **distância à meta**: `progress(orgId)` lê o realizado do mês por um **registro de métricas extensível** (`revenue` sai do snapshot PERSISTIDO da F2/D2 — `domains.sales.receitaMes.value`; `appointments` sai do `AnalyticsService.getMetrics().appointmentCount`, pois o snapshot não carrega contagem de atendimento) e calcula `remaining`/`attainmentPct`/`reached` + **pace** (esperado-proporcional-ao-dia-do-mês → `on_track`/`behind`/`reached`). O realizado é SEMPRE derivado por query (RN-004) — a tabela nunca guarda contador de progresso. CRUD do dono em `GET/PUT/DELETE /api/goals` (+ `GET /api/goals/progress`; mutação `requireRole(owner,admin)`). O Diretor IA ganhou `goalsBlock` (anexado ao panorama da F3) — **inerte**: sem meta definida, o bloco some e nada muda (§54 anti-inflação; nem precisa de flag, o recurso é dormente). Prior art avaliado e descartado: `retail_store_quotas`/`retail_seller_quotas` são do varejo (loja/vendedor), assunto diferente de meta org-wide. **Números:** 1 tabela nova + 1 service novo (`BusinessGoalService` — catalog/list/set/remove/progress) + 1 rota (4 endpoints) + Diretor com `goalsBlock` + 1 suíte (`test:business-goals`, 22 checks). 0 breaking changes; inerte por padrão.

### D5 — Fala Tu → porta I/O (F5+ — EM ANDAMENTO; thread de maior risco)

O Fala Tu hoje é um **domínio paralelo** (silos `falatu_tasks/events/lists/entities`) ao domínio canônico do ZapFlow (`TaskService`/`AppointmentService`/…). O alvo (estado-final §3.B/§4.2): o Fala Tu vira uma **porta (I/O)** que **escreve nos services canônicos**, não em silos próprios. Fatiado por risco crescente — cada fatia é **aditiva/reversível sob flag opt-in**, nunca big-bang; os silos são preservados (dual-write) até a convergência.

**F5 — ENTREGUE (2026-08-10) — bridge de tarefas (a beachhead mais segura).** Sob o opt-in `falatu_bridge_tasks_enabled` (default 0), ao confirmar um item de intent **TASK**, o `FalaTuService.confirm` ESPELHA a tarefa no domínio canônico via `TaskService.create` (`source:'falatu'` p/ rastreabilidade; sem assignee ⇒ sem notificação/rede) **dentro da mesma transação** do silo — atômico. O vínculo silo→canônico fica em `falatu_tasks.bridged_task_id` (aditivo). Flag off = comportamento de hoje (só silo, 0 regressão — provado pelas 3 suítes Fala Tu existentes seguindo 35/21/26 PASS). Escolhida como 1ª fatia porque tarefa é o domínio canônico mais simples (`TaskService.create` é INSERT síncrono, sem contato obrigatório); **eventos→`AppointmentService`** (exige `contact_id`), **listas** (sem equivalente canônico direto), o **roteamento WhatsApp** (`FalaTuWhatsAppService` desviando antes do choke-point) e o **dedup de RAG** (`falatu_memory_embeddings` vs `knowledge_documents`) ficam pras fatias seguintes. Porta controlável em `GET/PUT /api/falatu/bridge` (mutação owner/admin). **Números:** 1 flag + 1 coluna de vínculo + `source:'falatu'` no `TaskService` + bridge no `confirm` (+ helpers `isTaskBridgeEnabled`/`setTaskBridge`) + 1 rota (2 endpoints) + 1 suíte (`test:falatu-porta`, 16 checks). 0 tabelas novas, 0 breaking changes.

**F6 — ENTREGUE (2026-08-10) — bridge de eventos → agenda canônica.** Sob o opt-in `falatu_bridge_events_enabled` (default 0), ao confirmar um item de intent **EVENT**, o Fala Tu espelha o evento como **agendamento canônico** via `AppointmentService.create`. Ao contrário do bridge de tarefas (F5, mirror cego), a agenda é **contact-anchored** (`appointments.contact_id` é `NOT NULL`) e a criação pela borda dispara **e-mail ao contato + sync do Google Calendar** — então o espelho é **duplamente honesto**: (1) só ocorre quando o **humano vincula um contato REAL** (novo override `contactId`, validado na org) **e o evento tem data+hora** — sem isso, fica lembrete pessoal no silo `falatu_events` (RN-151: nunca inventa contato/horário/fuso; `scheduled_start` é montado com offset `-03:00` a partir de `TZ_OFFSET_MIN`); (2) cria **só o registro** — os efeitos externos (e-mail/Calendar) **não** são disparados por um bridge implícito. Refatoração estrutural que sustenta o thread: a criação canônica de agendamento foi **extraída da rota `POST /appointments` para `AppointmentService.create`** (record + validação de contato + audit; efeitos externos ficam na borda), virando a **porta única** do domínio agenda — reusada pela rota e pelo bridge. Vínculo silo→canônico em `falatu_events.bridged_appointment_id` (aditivo). Porta controlável no mesmo `GET/PUT /api/falatu/bridge` (agora `{tasks, events}`). **Números:** 1 flag + 1 coluna de vínculo + `AppointmentService.create` (novo, com a rota refatorada pra usá-lo) + bridge no `confirm` + helpers `isEventBridgeEnabled`/`setEventBridge`/`bridgeState` + 1 suíte (`test:falatu-porta-events`, 24 checks). Regressão: `test:falatu-porta`/`falatu`/`falatu-whatsapp` + agenda (`comigo-agenda`/`clinic-agenda`/`clinic-episode-appointment`/`agenda-sales-patterns`) todas PASS. 0 tabelas novas, 0 breaking changes.

> **Não abrir** listas/roteamento/RAG antes de tarefas+eventos estáveis em produção — a convergência avança por domínio, medindo regressão a cada passo.

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
| **F3** | D3 — convergir Context(string)+V2 (`ContextEngineService.build/render`; Advisor consome 1 contrato; `GET /api/business/context`) | **ENTREGUE** |
| **F4** | D4 — modelo de objetivos/metas + distância à meta (`business_goals` + `BusinessGoalService`; `/api/goals[/progress]`; Diretor `goalsBlock` inerte) | **ENTREGUE** |
| **F5** | D5 — Fala Tu → porta I/O: **bridge de tarefas** (`falatu_bridge_tasks_enabled`; confirm(TASK) espelha no `TaskService` canônico, atômico; vínculo `bridged_task_id`; `/api/falatu/bridge`) | **ENTREGUE** |
| **F6** | D5 — porta I/O: **bridge de eventos→agenda** (`falatu_bridge_events_enabled`; confirm(EVENT)+contato+data+hora espelha via `AppointmentService.create`, extraída da rota; vínculo `bridged_appointment_id`; sem e-mail/Calendar implícito) | **ENTREGUE** |
| F7+ | D5 — porta I/O: listas, roteamento WhatsApp p/ choke-point, dedup de RAG | planejada |

**Números F1:** 1 método novo (`attention`) + 1 helper (`shortSummary`) + 1 rota read-only + 1 suíte (`test:signals-attention`, 14 checks). 0 tabelas novas, 0 breaking changes.
