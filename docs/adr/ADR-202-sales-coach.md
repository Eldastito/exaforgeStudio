# ADR-202 — Sales Coach (treinador do vendedor) — F0 (auditoria + plano)

**Origem:** PRD-ZF-UNIFIED-GAP-CLOSURE-03, item **F5** ("Sales Coach"). Onda 4.
**Status:** F0 (doc-only) — gate de aprovação. Nenhuma fatia F1+ começa antes deste F0 ser revisado/aprovado.
**Escopo confirmado pelo dono:** o Sales Coach **treina o vendedor** — analisa o desempenho/abordagem e dá feedback/roleplay **interno**. **NUNCA fala com o cliente** (isso é F6 Vendedor IA, DEFERIDO — depende da F1.1). Portanto o Sales Coach **não envia nada externo** e **não toca o choke-point da F1.1**.

---

## 1. Tese

`VENDEDOR ≠ CLIENTE.` O Sales Coach é uma camada **advisória interna**: cruza o desempenho REAL do vendedor (tendência de vendas, conversão, comissão, outreach) com conhecimento validado (soluções de gerente já aprovadas) e devolve feedback acionável + roleplay de treino. É **read-mostly / advisório** — não executa ação externa, não fala com cliente, não decide sozinho. Isso o torna a fatia de **menor risco** da Onda 4 (nenhuma superfície de envio real).

## 2. Fronteira (o que É e o que NÃO É)

**É:** análise do desempenho do vendedor · feedback grounded (baseado nos números reais dele) · recuperação de soluções humanas validadas (ADR-174) aplicáveis ao gap dele · roleplay/simulação de abordagem para treino · superfície interna (gestor + o próprio vendedor).

**NÃO é:** conversa com cliente · envio de mensagem/e-mail/PIX (F6, DEFERIDO) · avaliação de RH/punição · "nota" que vira decisão automática · motor de IA paralelo · segundo motor de aprendizado.

## 3. Auditoria — o que já existe (COMPOR/REUSAR) × o que falta (CREATE)

Estados: REUSE · EXTEND · COMPOSE · CREATE · ALREADY_DONE.

| Capacidade | Estado | Owner existente | Decisão |
| --- | --- | --- | --- |
| Coaching/roleplay/feedback do vendedor | **NÃO EXISTE** (grep: só hits incidentais — `PeoplePatternMemory` detecta queda; `RetailAdoptionService.coach` é nudge de onboarding) | — | **CREATE** (mínimo) |
| Gatilho "vendedor em queda" | ALREADY_DONE | `PeoplePatternMemory` (queda recorrente → sinal) | REUSE |
| Identidade do vendedor | ALREADY_DONE | `retail_sellers` (+ assignments) | REUSE |
| Desempenho do vendedor | ALREADY_DONE | `retail_seller_sales`, `retail_erp_seller_sales`, `RetailCommissionService`, `RetailCommissionRaceService`, `prospect_outreach` (resposta/reunião/conversão) | COMPOSE (read-model) |
| Análise LLM grounded (determinístico antes de LLM) | ALREADY_DONE | SkillOS (`SkillOsResolverService`/`Planner`/`Grounding`/`Eval`) | COMPOSE |
| Conhecimento humano validado | ALREADY_DONE | `ManagerSolutionRetrievalService` (ADR-174 — origem humana, onde funcionou, evidência) | COMPOSE |
| Aprendizado (motor único) | ALREADY_DONE | `PatternMemoryService` (ADR-166) | COMPOSE (só se F5 aprender; senão fora) |
| Governança (se algum dia propuser ação) | ALREADY_DONE | `DecisionAction→ApprovalPolicy` | fora do F5 advisório (só se surgir ação) |

**Conclusão:** ~80% COMPOR/REUSAR. O CREATE real é pequeno: um `SalesCoachService` read-mostly que (a) monta o retrato de desempenho do vendedor a partir das fontes acima, (b) identifica gaps determinísticos, (c) pede ao SkillOS um feedback grounded nesse retrato, (d) recupera soluções de gerente validadas aplicáveis, (e) opcionalmente gera um roteiro de roleplay. Zero envio externo.

## 4. Guardrails (RN-SC)

1. **VENDEDOR ≠ CLIENTE** — nunca gera nem envia mensagem para cliente. Sem superfície externa.
2. **Advisório** — o Coach sugere; o gestor/vendedor decide. Nunca punição/decisão automática.
3. **Grounded** — todo feedback é ancorado nos números REAIS do vendedor; sem dado → "sem base ainda", nunca inventa desempenho (null≠0, RN-004).
4. **Determinístico antes de LLM** — o gap e o retrato saem de query; o LLM só redige (SkillOS grounding).
5. **Conhecimento humano rotula origem** — soluções recuperadas declaram que são de gerente + onde funcionaram (ADR-174), nunca "verdade da IA".
6. **Isolamento multi-tenant** — tudo por `organization_id`; escopo de loja respeita `RetailStoreScopeService` (ADR-173).
7. **Opt-in por flag** (`sales_coach_enabled` default 0) — aditivo/reversível; 0-regressão.
8. **Sem motor paralelo** — reusa SkillOS (capacidade), PeoplePatternMemory (gatilho), PatternMemory (aprendizado), ManagerSolution (conhecimento). Não cria 2º de nada.
9. **LGPD/RH** — dado de desempenho é sensível internamente; role-gated (gestor vê time; vendedor vê o próprio); nunca expõe um vendedor a outro.

## 5. Plano de fatias (F0→Fn) — **FECHADO (F0–F7)**

- **F0** ✅ — auditoria + ADR + fronteira + guardrails. Doc-only.
- **F1** ✅ — `SalesCoachService.performanceSnapshot(orgId, sellerId)`: read-model determinístico do desempenho, COMPONDO as fontes existentes (precedência ERP > manual > PDV, nunca soma). `test:sales-coach-snapshot`. Sem LLM, roda em CI.
- **F2** ✅ — `gaps()`: identificação DETERMINÍSTICA (queda recorrente via MESMA regra do PeoplePatternMemory + comparação com mediana do time) + faixa qualitativa. `test:sales-coach-gaps`.
- **F3** ✅ — `feedback()` determinístico + `feedbackAsync()` (LLM só redige, cai no determinístico sem chave). `test:sales-coach-feedback`.
- **F4** ✅ — `solutionsForSeller()` REUSA `ManagerSolutionRetrievalService` (ADR-174), rotulando origem humana. `test:sales-coach-solutions`.
- **F5** ✅ — `roleplay()` determinístico, grounded no gap; disclaimer "nada é enviado ao cliente". `test:sales-coach-roleplay`.
- **F6** ✅ — superfície: flag + RBAC + `bundle`. Rotas `/api/sales-coach/*`. `test:sales-coach-surface`. **F6b** ✅ — aba interna "Coach de Vendas" (`SalesCoachView`, `viewMode:'sales_coach'`), gated por probe runtime.
- **F7** ✅ — hardening (`test:sales-coach-hardening`, 48 checks — codifica RN-SC-1..9 + fiação de produção) + runbook `docs/runbook/sales-coach-operacao.md`. **FECHA o ADR-202.**

**Flag:** `sales_coach_enabled` (default 0) para toda a Onda.

## 6. O que NÃO entra (explícito)

- Nada que fale com cliente (F6 Vendedor IA — DEFERIDO até F1.1).
- Nenhum envio externo → **não toca a F1.1** (por isso é seguro fazer agora).
- Sem avaliação de RH/nota-que-pune. Sem motor de IA/aprendizado paralelo.

---

_F0 doc-only — não altera comportamento. Aprovação humana deste gate destrava a F1._
