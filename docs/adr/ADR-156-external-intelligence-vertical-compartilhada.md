# ADR-156 — External Intelligence: inteligência de vertical compartilhada e anonimizada (aditivo sobre ADR-135/136/152; ADR de agregação exigido pela ADR-079 D4)

- **Status:** Proposto — **Fase 0 (esta ADR)**. Nenhum código escrito; Fases DI-4.1..DI-4.4 **aguardando aprovação do dono** (é exceção deliberada à fronteira multi-tenant — precisa de revisão antes do código).
- **Data:** 2026-08-08
- **Origem:** PRD "ZapFlow Decision Intelligence Fabric 2.0" (External Intelligence / Agent-Reach) + `docs/decision-intelligence/` (Fatia DI-4). Decisão do dono (2026-08-08): "compartilhado por vertical anonimizado (exige ADR nova antes do código)".
- **Relacionadas:** **ADR-079 D4** (que adiou agregação cross-tenant "até haver ADR de agregação anonimizada" — **esta é essa ADR**), ADR-135 (Snapshot/Evidence), ADR-136 (Signals/Decision), ADR-152 (Runtime), ADR-056 (LGPD), ADR-130 (Governança de IA), ADR-153 (verticais/entitlements), ADR-154 (metering de IA). CLAUDE.md convenções nº 1 (isolamento), nº 6 (LGPD), nº 10 (opt-in), nº 12 (BusinessSignal).

---

## Contexto

O PRD quer que a IA descubra o mundo externo (mercado, concorrentes, tendências, legislação, tecnologia, comportamento) **por vertical** e reuse a pesquisa entre organizações da mesma vertical, para cortar custo e latência: "200 lojas perguntam a mesma tendência → 1 pesquisa, 200 contextualizações" (PRD §7/§24/§29).

O bloqueio é real e registrado: **ADR-079 D4** vetou agregação cross-tenant "até haver ADR de agregação anonimizada"; o isolamento por `organization_id` é convenção crítica nº 1 e critério de aceite de vários PRDs. Esta ADR remove o bloqueio **de forma estreita e segura**, definindo exatamente **o que pode ser compartilhado, o que nunca pode, e por quê** — e supersede a adiada D4 **apenas para inteligência externa de mercado** (a `prospect_learning_memory` por-tenant da ADR-079 **permanece por-tenant**; não é objeto desta ADR).

**Insight que torna isto seguro:** o que se compartilha é pesquisa sobre **o mundo externo** (ex.: "demanda de moda de inverno no Brasil, 2026"), **não** dados do tenant. "Tendência de moda masculina" é conhecimento de mercado — não é o cliente, o caixa nem o estoque da Toulon. Logo, compartilhar isso entre tenants **não cruza a fronteira de isolamento de dados privados**, desde que a camada compartilhada seja, por construção, **livre de dado por-tenant e de dado pessoal**.

---

## Decisões

### D1 — Duas camadas fisicamente separadas (o coração da segurança)

1. **`vertical_intelligence` — COMPARTILHADA, sem `organization_id`.** O "knowledge package" anonimizado. Chaveada por `fingerprint(vertical|topic|region|timeframe)`. Campos: `vertical`, `topic`, `region`, `timeframe`, `content_json` (achados da pesquisa do mundo externo), `sources_json`, `confidence`, `generated_at`, `valid_until`. **NUNCA** tem `organization_id`, nome de empresa, métrica de tenant ou dado pessoal.
2. **`organization_contextualization` — POR-ORG, isolada por `organization_id`.** Liga uma org a uma entrada de `vertical_intelligence` com o enquadramento específico daquela org ("como essa tendência se aplica à sua loja"). Toda query filtra `organization_id` (convenção nº 1). A contextualização pode combinar o pacote compartilhado com o **Evidence Package privado** da org **em tempo de request** — mas o resultado dessa combinação **nunca** é escrito de volta na camada compartilhada.

O isolamento clássico (`WHERE organization_id = ?`) continua valendo para **todo** dado por-org. A camada compartilhada é deliberadamente **org-agnóstica** e sem dado privado — é um plano de conhecimento **público**, não uma exceção ao isolamento de dado privado.

### D2 — Contrato de anonimização (regras duras, testáveis)

- **A query que vai ao provider deriva SÓ de `(vertical, topic, region, timeframe)`** — do taxonomia de verticais, **nunca** de dado que identifique o tenant, lista de clientes, ou métrica privada. O broker monta a consulta a partir da vertical, não da org.
- **A entrada compartilhada guarda só a resposta do mundo externo.** Um **filtro de anonimização** roda antes de persistir em `vertical_intelligence` e **bloqueia/remove** qualquer conteúdo com cara de dado pessoal (e-mail, CPF/CNPJ, telefone, nome de pessoa física) — cinto-e-suspensório, mesmo o provider sendo de mercado.
- **Zero `organization_id` / nome de negócio / métrica por-tenant** entra em `vertical_intelligence` (asserção de teste obrigatória).
- Contextualização por-org que toque dado privado vive **só** na camada por-org ou no request — nunca persistida no compartilhado.

### D3 — Base legal LGPD (ADR-056)

- A inteligência de vertical compartilhada trata **informação de mercado/agregada/pública** — **não é dado pessoal** (LGPD Art. 5 I). Onde não há dado pessoal, as proteções de titular não incidem.
- Se uma fonte externa retornar dado pessoal, ele é **excluído** pelo filtro de anonimização (D2) — a camada compartilhada é, por construção, não-pessoal.
- Base legal do processamento de inteligência de mercado: **legítimo interesse** (Art. 7 IX / Art. 10). **Opt-in por org** (convenção nº 10) governa se a org **consome** inteligência externa.
- Auditoria com `maskIdentifier` (Fase 32); a identidade da org consumidora **nunca** vaza cross-tenant. Sem RLS de banco (ADR-079): o isolamento por-org é `WHERE organization_id = ?` + teste + varredura do `SecurityAuditService`.

### D4 — Provider abstrato (não refém de projeto específico) — PRD §9

`ExternalResearchProvider` (interface), modelado no padrão `TryOnProvider` já existente (registry + seleção por env). Implementações plugáveis (ex.: web-search, API de dados, provider próprio). **Nada de acoplar a plataforma a `AgentReachService` concreto** — o Decision Engine pede uma **capacidade** ("preciso de pesquisa externa?"), o broker resolve o provider. Trocar a tecnologia amanhã não toca o resto.

### D5 — Research Broker (cache + dedup + freshness + budget) — reusa infra existente

`ResearchBrokerService.resolve(orgId, { vertical, topic, region, timeframe })` na ordem (PRD §6/§25/§29):
```
L1 request cache → L2 organization_contextualization (fresca?) →
L3 vertical_intelligence via fingerprint (fresca?) → provider (só no miss total)
```
O provider só é chamado se **todas** valerem: (a) miss total; (b) a org **optou** por inteligência externa; (c) **orçamento** permite (D6); (d) o Decision Engine julga que **informação externa pode mudar materialmente a decisão** (PRD §33) e o nível é **L3+** (perfil `externalResearch` do DI-1 = `yes`/`cache`; L0–L2 **não** disparam pesquisa live). Dedup por `fingerprint(vertical|topic|region|timeframe)` — "1 pesquisa, N contextualizações". Freshness por `valid_until` (janela por vertical, dias/semanas).

### D6 — Sub-budgets de IA (movidos da DI-3, agora ativos)

Aditivos em `organization_settings`: `research_budget_cents`, `external_api_budget_cents` (+ prioridade). Enforcement **antes** de chamar o provider, reusando o metering existente (`ai_usage_log`, ADR-154) e o padrão de `AiQuotaSignalService` (alerta em 80%/100%). Sem gasto externo real, estes seriam infra inerte — por isso entram **aqui**, junto do primeiro consumo externo real.

### D7 — Integração sem novo menu (reusa Evidence + Signals)

O resultado do broker preenche o slot **`externalEvidence[]`** do Evidence Package (DI-1, hoje vazio) e pode publicar em **`business_signals`** (domain `external`) via o ledger existente (convenção nº 12) — **nunca** cria tela/menu/alerta/scheduler novo (PRD §31/§37; ADR-152 D8). A pesquisa pesada roda **assíncrona** (JobQueue/Scheduler existentes, ADR-073/074) — nunca bloqueia a UI (PRD §27).

### D8 — Fatiamento (cada fatia = 1 PR draft → CI verde → merge)

- **DI-4.1** — schema (`vertical_intelligence` sem org; `organization_contextualization` por-org) + `ExternalResearchProvider` (interface + **provider stub determinístico**, sem chamada live) + `ResearchBrokerService` (cache/dedup/freshness) + **filtro de anonimização** + testes offline (inclui asserção "compartilhado nunca contém org/PII" e isolamento).
- **DI-4.2** — sub-budgets (D6) com enforcement no broker + sinais de quota.
- **DI-4.3** — fio até o `externalEvidence[]` do Evidence Package + consumo pelo `DecisionEngine` só em L3+ (roteador DI-1).
- **DI-4.4** (posterior, opt-in) — um provider real (web-search) atrás da interface, gated por env, com guardrails de chamada live + custo.

---

## Consequências

**Positivas:** custo/latência de pesquisa caem (1 pesquisa por vertical, N contextualizações); a plataforma ganha visão externa sem virar refém de um projeto; o isolamento de dado privado **permanece intacto** (a camada compartilhada é não-pessoal por construção); LGPD coberta por legítimo interesse + anonimização + opt-in.

**Trade-offs / riscos aceitos:** existe um plano de dados **compartilhado** novo — mitigado por (a) separação física das duas camadas, (b) filtro de anonimização testado, (c) query derivada só da vertical, (d) varredura do `SecurityAuditService`. A qualidade da anonimização depende do filtro — por isso é testável e conservador (na dúvida, exclui). Provider real fica para DI-4.4 com gate próprio.

**Escopo:** supersede a adiada **ADR-079 D4 apenas para inteligência externa de mercado**. A `prospect_learning_memory` **continua por-tenant** — não é objeto desta ADR.

## Testes (por fatia, padrão `scripts/test-*.ts`, tmpDir isolado)

- `vertical_intelligence` **nunca** contém `organization_id`/nome de empresa/PII (asserção dura do filtro de anonimização).
- Dedup: 2 orgs da mesma vertical/topic/region/timeframe → **1** entrada compartilhada, **2** contextualizações; provider chamado **1×** (stub conta chamadas).
- Freshness: entrada expirada (`valid_until` passado) força novo resolve; fresca é reusada.
- Roteamento: L0–L2 **não** chamam o provider; L3+ chamam (com opt-in + budget).
- Budget: acima do teto, o broker **não** chama o provider e publica sinal de quota.
- Isolamento: contextualização de uma org nunca vaza para outra (`WHERE organization_id = ?`).
- Opt-in: org sem `external_intelligence_enabled` não dispara pesquisa.

## Guardrails (RN — no header dos services + testados)

- **RN-156-1** Isolamento: todo dado por-org filtra `organization_id`; a camada compartilhada carrega **zero** dado por-org/pessoal.
- **RN-156-2** Query externa deriva só de `(vertical, topic, region, timeframe)` — nunca de dado do tenant.
- **RN-156-3** Filtro de anonimização bloqueia PII antes de persistir no compartilhado (na dúvida, exclui).
- **RN-156-4** Provider só no miss total + opt-in + budget + L3+ + "muda materialmente a decisão".
- **RN-156-5** Determinístico/regra antes de IA; pesquisa pesada é assíncrona; resultados alimentam Evidence Package + `business_signals` — sem menu/alerta/scheduler novo.
- **RN-156-6** Provider é abstrato (troca de tecnologia não vaza para o resto).
