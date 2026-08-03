# Status de Execução — ZappFlow Execution Runtime

**Instrução obrigatória** (PRD §3): a próxima sessão de trabalho da IA Dev DEVE começar lendo, em ordem:
1. `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md` (fonte imutável)
2. `docs/adr/ADR-152-zappflow-execution-runtime.md` (decisões arquiteturais)
3. `docs/execution-runtime/ANALISE-ARQUITETURAL.md` (o que já existe no repo)
4. `docs/execution-runtime/DECISOES-E-PENDENCIAS.md` (bloqueios ativos)
5. `docs/execution-runtime/PLANO-DE-IMPLEMENTACAO.md` (o "como")
6. Este arquivo (o "onde parou")
7. `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` (rastreabilidade item‑a‑item)

**Não iniciar código sem antes atualizar este arquivo** com "sessão em andamento".

---

## Legenda
- `[ ]` Não iniciado
- `[~]` Em andamento
- `[x]` Concluído
- `[!]` Bloqueado (ver `DECISOES-E-PENDENCIAS.md §C`)
- `[-]` Removido após decisão (ver `DECISOES-E-PENDENCIAS.md §B`)

Cada atualização deve registrar: data, fase, item, arquivos alterados, testes executados, resultado, pendências, próximo passo.

---

## Fase 0 — Análise crítica

- [x] Ler PRD por completo
- [x] Analisar repositório atual (232 services, 152 ADRs, rotas, DB)
- [x] Identificar componentes reutilizáveis (ADR-136 Epic 2, ADR-085, ADR-073, ADR-074, ADR-091, ADR-095, ADR-058, ADR-150, ADR-046)
- [x] Comparar arquitetura proposta × real (`ANALISE-ARQUITETURAL.md §2`)
- [x] Apontar riscos/inconsistências (`ANALISE-ARQUITETURAL.md §5`)
- [x] Registrar ponderações técnicas (`ADR-152` + `ANALISE`)
- [x] Propor ajustes ao PRD (`DECISOES-E-PENDENCIAS.md §B`)
- [x] Plano em fases pequenas testáveis reversíveis (`PLANO-DE-IMPLEMENTACAO.md`)
- [x] Salvar 5 documentos + PRD + ADR (este PR)

**Fase 0 concluída.**

## Fase 1 — Process Fabric (Runtime v1)

### Fatia 1.1 — schema aditivo + `ProcessRuntimeService` mínimo — **ENTREGUE**
- [x] `db.ts` — CREATE `process_definitions`, `process_instances`, `process_transitions`; ALTER `decision_actions` (9 aditivos nullable); ALTER `organization_settings` (`execution_runtime_enabled`)
- [x] `ProcessRuntimeService.ts` — `defineProcess` (versionamento auto), `startForSubject` (dedupe por subject vivo), `startFromSignal` (carrega evidência), `advance` (detected→planned + retorna nextStep), `completeStep` (roteia por condição, `onFailure` fallback|escalate|fail, successCondition), `cancel`, `getInstance`, `listInstances`, `listTransitions`, `transition` (FSM validada com 13 estados + 27 transições)
- [x] `PlaybookEngine.ts` puro — `validateDefinition` (Zod-like manual, bloqueia refs quebradas / ids duplicados / commandType ausente / onFailure=fallback sem fallbackStep), `evaluateCondition` (truthy/eq/gte/lte/and/or/not), `chooseNextStep` (string direto, array de `{when, next}` com default, `$end`)
- [x] `routes/runtime.ts` — `runtimeGate` (flag `execution_runtime_enabled`, master bypass) + CRUD de definitions/instances + advance/complete-step/cancel/transition
- [x] `PermissionService.ts` — módulo `runtime` em `RBAC_MODULES` + `ROUTE_MODULE` + `RBAC_MODULE_LABELS`
- [x] `server.ts` — `protectedApi.use("/runtime", runtimeRoutes)`
- [x] `scripts/test-runtime-process-fabric.ts` — **42/42 checks PASS** (PlaybookEngine puro, defineProcess, startForSubject dedupe, FSM válida × inválida, roteamento por condição, successCondition, onFailure=escalate, cancel terminal, startFromSignal, isolamento multi-tenant, flag default 0, auditoria)
- [x] `package.json` — script `test:runtime-process-fabric`
- [x] Regressão: `test:decision-actions` (16/16), `test:outcome-measurement` (17/17), `test:command-executor` (17/17), `test:business-signals` (12/12), `test:impact-prioritization` (14/14), suítes do FalaTu (35+24+21+24+26+14) — zero regressão
- [x] `tsc --noEmit` limpo

**Critérios de aceite Fase 1 — todos cumpridos:**
1. Regressão zero em suítes existentes ✓
2. `test-runtime-process-fabric.ts` verde ✓
3. `tsc --noEmit` limpo ✓
4. Sem alteração de comportamento com `execution_runtime_enabled=0` (default) ✓
5. Zero regressão em `decision_actions` (todos aditivos nullable) ✓

**Rollback:** `execution_runtime_enabled=0` (default) bloqueia o `/api/runtime/*` via `runtimeGate` (403). Se necessário reverter o schema, revert do commit — nenhum dado de produção populou as tabelas novas ainda.

## Fase 2 — Execute + Confirmation
- [ ] Ver `PLANO §Fase 2` (Fatias 2.1 executor.execute, 2.2 handlers concretos, 2.3 ConfirmationEngine, 2.4 backoff/dead‑letter)

## Fase 3 — Outcomes estendidos + UI Operações
- [ ] Ver `PLANO §Fase 3`

## Fase 4a — Piloto Retail Closing
- [!] BLOQUEADO em decisões 1, 2, 5 e 8 do `DECISOES-E-PENDENCIAS.md §F`

## Fase 4b — Piloto Cobrança
- [ ] Depende de F4a estável

## Fase 4c — Piloto Recuperação Comercial
- [!] BLOQUEADO em decisão 4 do `DECISOES-E-PENDENCIAS.md §F` (revisão LGPD)

---

## Log de sessões

### Sessão 2026-08-03 (Fase 0)
- **Fase:** 0
- **Itens executados:** todos os 9 itens acima da Fase 0
- **Arquivos criados:**
  - `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`
  - `docs/adr/ADR-152-zappflow-execution-runtime.md`
  - `docs/execution-runtime/ANALISE-ARQUITETURAL.md`
  - `docs/execution-runtime/PLANO-DE-IMPLEMENTACAO.md`
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md` (este)
  - `docs/execution-runtime/DECISOES-E-PENDENCIAS.md`
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`
- **Arquivos alterados:** nenhum em `src/**` (Fase 0 = só documentação, conforme PRD §20)
- **Testes executados:** nenhum (Fase 0 não altera código executável)
- **Resultado:** Fase 0 concluída; 6 documentos + 1 ADR + 1 PRD persistidos no repo
- **Pendências criadas:** 10 decisões do dono do produto em `DECISOES-E-PENDENCIAS.md §F` (destaques: escolha de piloto, Sicredi, LGPD, nome da aba)
- **Próximo passo:** aguardar aprovação para iniciar Fase 1 / Fatia 1.1. **Antes do primeiro código, revisitar as decisões pendentes 5 (ordem dos pilotos) e 8 (org piloto).**

### Sessão 2026-08-03 (Fatia 1.1 do ADR-152 — Process Fabric)
- **Fase:** 1
- **Itens executados:** todos os 10 itens da Fatia 1.1 (schema, PlaybookEngine, ProcessRuntimeService, rotas, RBAC, server.ts wiring, teste, package.json, regressão, tsc)
- **Arquivos criados:**
  - `src/server/PlaybookEngine.ts` (motor puro)
  - `src/server/ProcessRuntimeService.ts` (FSM + Process Fabric)
  - `src/server/routes/runtime.ts`
  - `scripts/test-runtime-process-fabric.ts`
- **Arquivos alterados:**
  - `src/server/db.ts` (aditivos: 3 tabelas novas + 9 colunas em decision_actions + `execution_runtime_enabled`)
  - `src/server/PermissionService.ts` (módulo `runtime` em RBAC_MODULES + ROUTE_MODULE + labels)
  - `server.ts` (import + `protectedApi.use("/runtime", ...)`)
  - `package.json` (`test:runtime-process-fabric`)
  - `docs/execution-runtime/STATUS-DE-EXECUCAO.md` (esta atualização)
  - `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md` (status atualizado dos itens F1)
- **Testes executados:**
  - `npm run test:runtime-process-fabric` → **42/42 PASS**
  - Regressão ADR-136: decision-actions 16/16, outcome-measurement 17/17, command-executor 17/17, business-signals 12/12, impact-prioritization 14/14
  - Regressão FalaTu: 6 suítes (35+24+21+24+26+14 = 144/144)
  - `npx tsc --noEmit` → limpo (exit 0)
- **Resultado:** Fatia 1.1 concluída — Process Fabric no ar, com feature flag desligada. Nenhuma quebra em produção.
- **Pendências criadas:** nenhuma nova; as 10 decisões pendentes do dono (§F) continuam bloqueando F4a/F4c mas não afetam F1.2 ou F2.
- **Próximo passo:** aguardar aprovação para iniciar **Fatia 1.2** (opcional — se dividirmos) ou pular direto pra **Fase 2 (Execute + Confirmation)**. Recomendo Fase 2 direto: F1 já entrega o Process Fabric completo em uma fatia. F1.2 se torna desnecessária.

### Sessão AAAA-MM-DD (template para próxima)
- **Fase:** …
- **Itens executados:** …
- **Arquivos criados:** …
- **Arquivos alterados:** …
- **Testes executados:** … (comando + resultado)
- **Resultado:** …
- **Pendências criadas:** …
- **Próximo passo:** …

---

## Como marcar item como concluído
Um item **NÃO** é `[x]` só por ter código. Precisa (do PRD §22):
- Implementação backend + persistência + validação + autorização + auditoria
- Interface (quando aplicável) + estados vazios + loading + tratamento de erro
- Teste automatizado verde na CI
- Documentação atualizada
- Feature flag + migração + rollback documentado
- **Linha correspondente na `MATRIZ-DE-COBERTURA-DO-PRD.md` marcada `[x]` com evidência**
- Evidência (script, comando, screenshot ou commit hash) registrada aqui neste STATUS
