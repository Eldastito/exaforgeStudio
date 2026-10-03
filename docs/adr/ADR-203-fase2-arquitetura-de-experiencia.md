# ADR-203 — ZapFlow Fase 2: Arquitetura de Experiência, Simplificação Radical e Gestão Conversacional

**Estado:** **F2.0 FECHADA (doc-only)** · **F2.1 EM PR** (roteador de intenções do FalaTu — `ConversationalIntentRules`, `ranking_lojas`/`produtos_parados`/`proposta_campanha`, carimbo de frescor do PDV; `test:falatu-intent-router` 24; runbook `docs/runbook/fase2-experiencia-operacao.md`). **Decisões D1–D5: o dono aceitou as recomendações** (Executando = fachada com Missões como seção · F2.1 antes da navegação · rótulo "Atendimento Digital" · Hoje com meta mensal + parcial · flag só na TOULON, Owner valida desktop+mobile, Gerente/Vendedor em org de teste).
**Cliente-piloto:** TOULON. **Base:** Fase 1 concluída (S1–S9) + prints reais de 02/10/2026.
**Análise:** `docs/prd/ANALISE-PRD-FASE2-vs-CODEBASE.md` (matriz PRD→código + probe executável das 19 frases do PRD).

## 1. Contexto

O PRD da Fase 2 pede transformar o ZapFlow de "coleção de módulos" em experiência de gestão: **Hoje · FalaTu · Executando · Resultados · Empresa + Explorar**, preservando todos os motores. A F2.0 provou que essa arquitetura **já está decidida e ~80% construída no backend** (ADR-163 Invisible UX; ADR-189 Mission OS): `NavigationManifestService`, `FalaTuHomeService`, `ExecutionResultsService`, `UxTelemetryService`, flag `simplified_navigation_enabled`. **Nenhuma tela as consome** — `Sidebar.tsx` segue 100% legado. A Fase 2 é, portanto, **LIGAR o frontend + CORRIGIR o roteamento do FalaTu**, não criar motor/nav concorrente (ADR-163 RN-UX-1).

## 2. Decisões

1. **Superfície ≠ motor.** Reduz-se a superfície; nenhum motor, rota ou módulo é apagado (PRD §2). Qualquer remoção só por telemetria (`LegacyReductionService`, advisório) e fora desta fase.
2. **Casco atrás de flag por org** (`organization_settings.simplified_navigation_enabled`, já existente): TOULON primeiro; legado intacto; desligar = voltar, sem rollback de backend.
3. **Fachada, não motor.** Hoje/Executando/Resultados são **composição read-only** (`ManagementOverviewService`-style) das fontes canônicas; **não recalculam** comissão, venda, estoque ou caixa (PRD §39). Uma definição por indicador: venda oficial = `RetailSalesPolicy`; caixa = `FinancialLedgerService.tracking`; metas = `RetailMonthlyGoalService`; giro = `stockCapital.giroMeasured`.
4. **FalaTu primeiro corrige, depois promove.** O roteador (`FalaTuAskService.classify` → `ExecutiveQueryRouterService`) tem 2 misroteamentos e 9 lacunas nas frases obrigatórias; isso é corrigido **antes** de o FalaTu virar a porta principal (F2.1 antes de F2.2).
5. **Executando = fachada** sobre `ExecutionResultsService.executing` + missões + tarefas + aprovações; "Missões" (ADR-189) vira seção, não concorrente (aguarda D1).

## 3. Guardrails (RN-F2)

RN-F2-1 nada apagado/rota legada preservada · RN-F2-2 flag reversível · RN-F2-3 RBAC/entitlement preservados (manifesto por papel; esconder ≠ desabilitar) · RN-F2-4 sem lógica de negócio no frontend · RN-F2-5 uma definição por indicador (universo diferente → nome diferente: "Atendimento Digital" ≠ "Venda da rede") · RN-F2-6 zero ≠ desconhecido ≠ estimado (`Metric`) · RN-F2-7 dado atrasado é carimbado ("último dado confirmado às HH:MM") · RN-F2-8 FalaTu nunca inventa; determinístico antes de LLM · RN-F2-9 Hoje ≤ 3 prioridades, cada uma com causa e verbo específico, sem código/log técnico · RN-F2-10 telemetria emitida por toda superfície nova antes de qualquer aposentadoria.

## 4. Plano (1 fatia = 1 PR draft, teste, runbook, rollback)

F2.0 análise+ADR (doc) · **F2.1 roteador do FalaTu** (backend) · F2.2 casco de navegação (flag) · F2.3 Hoje · F2.4 Executando · F2.5 Resultados (+ rótulo Dashboard) · F2.6 Empresa + Integrações/Canais normal×avançado · F2.7 Operação da Rede (19 abas → grupos) · F2.8 FalaTu 2º nível + contexto/role-aware + continuidade de conversa · F2.9 telemetria + piloto TOULON. **Fora de escopo (Fase 3):** autonomia extrema, execução financeira automática, modelos preditivos, negociação com fornecedor, remoção definitiva de módulos.

## 5. Decisões pendentes do dono

D1 Executando × Missões (proposta: Executando é a fachada; Missões vira seção) · D2 começar pela F2.1 (FalaTu) em vez da navegação · D3 rótulo do Dashboard (proposta: "Atendimento Digital") · D4 meta do dia no Hoje (TOULON usa meta mensal) · D5 escopo do piloto (flag só na TOULON; Owner valida desktop+mobile; Gerente/Vendedor em org de teste).

## 6. Evidências exigidas por fatia (checklist do PRD)

Build + typecheck + testes + regressão; desktop e mobile; Owner/Gerente/Vendedor; telemetria registrada; screenshots **de org de teste semeada** (Playwright/Chromium) — a validação na TOULON real depende dos prints do dono; pendências explicitadas no runbook.


## Status F2.2 — EM PR
Navegação simplificada atrás de `simplified_navigation_enabled` (`SimplifiedNav` + `navCatalog` + toggle em Configurações → Módulos + `PUT /api/entitlements/simplified-navigation`). Destinos dos 5 itens são interinos. `test:simplified-navigation` (24). Runbook: seção F2.2.


## Status F2.3 — pronta localmente (aguarda merge da F2.2 para abrir PR)
`TodayCockpitService` + `GET /api/ux/today` + `TodayView`. `test:today-cockpit` (24). Gap: "resolvido automaticamente hoje" sem data no ledger. Runbook: seção F2.3.


## Status F2.4 — pronta localmente (aguarda merge da F2.3)
`ExecutingBoardService` + `GET /api/ux/executing-board` + `ExecutingView`. `test:executing-board` (21). Runbook: seção F2.4.


## Status F2.5 — pronta localmente
`ResultsStoryService` + `/api/ux/results-story[/store/:id/understand]` + `ResultsView`; Dashboard → "Atendimento Digital". `test:results-story` (25). Runbook: seção F2.5.


## Status F2.6 — EM PR
`IntegrationStatusService` + `GET /api/ux/integration-status` + `CompanyView` (Empresa). `test:integration-status` (20). Runbook: seção F2.6.


## Status F2.7 — pronta localmente
RetailOps 19 abas → 5 grupos atrás da flag (`retailOpsGroups` + `RetailOpsView`). `test:retail-ops-groups` (14). Runbook: seção F2.7.


## Status F2.8 — EM PR
`FalaTuConversationService` + `/api/falatu/ask {context}` + 4 grupos no FalaTu + chips de continuidade. `test:falatu-conversation` (28). Runbook: seção F2.8.
