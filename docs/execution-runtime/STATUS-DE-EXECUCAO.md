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

### Fatia 1.1 — schema aditivo + `ProcessRuntimeService` mínimo
- [ ] `db.ts` — CREATE `process_definitions`, `process_instances`, `process_transitions`; ALTER `decision_actions`; ALTER `organization_settings` (`execution_runtime_enabled`)
- [ ] `ProcessRuntimeService.ts` — `defineProcess`, `startForSubject`, `startFromSignal`, `advance` (parcial), `cancel`, `getInstance`, `listInstances`, `transition` (FSM validada)
- [ ] `PlaybookEngine.ts` puro — `validateDefinition`, `evaluateCondition`, `chooseNextStep`
- [ ] `routes/runtime.ts` — CRUD de definitions/instances + advance/cancel
- [ ] `PermissionService.ts` — módulo `runtime` em `RBAC_MODULES`
- [ ] `scripts/test-runtime-process-fabric.ts`
- [ ] `package.json` — script `test:runtime-process-fabric`
- [ ] PR draft → CI verde → merge

**Critérios:** ver `PLANO-DE-IMPLEMENTACAO.md §Fase 1`.
**Rollback:** flag desativa; revert do commit.

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
