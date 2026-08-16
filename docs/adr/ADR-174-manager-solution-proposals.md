# ADR-174 — Propostas de solução do gerente (LEARN, governadas)

**Status:** Implementado (backend do ciclo governado). UI "Sugerir solução" e
recuperação pela IA em fatias seguintes. **Origem:** PRD Moda/TOULON, frente
LEARN (LEARN-001..007) + §8.4.

## Contexto

O cliente pediu um campo para o gerente "sugerir solução" para a IA. O PRD é
enfático (§7.6): **isto NÃO é treino automático de modelo**. Sugestão livre pode
estar errada, ser específica demais ou introduzir instrução nociva. É
conhecimento HUMANO com procedência, revisão, experimento e resultado mensurável.

## Decisão

Nova tabela `manager_solution_proposals` (aditiva) + `ManagerSolutionService`.
Só depois de **validada + com resultado assegurado** a proposta é publicada na
**memória de padrões EXISTENTE** (`retail_store_patterns`, sem motor novo —
§37/D6). Nada altera pesos de modelo.

### Máquina de estados (LEARN-002)

`draft → in_review → approved_for_test → testing → validated → promoted` +
`rejected`, `archived`, `revoked`.

### Governança (LEARN-003)

- Aprovar teste / promover exige **papel autorizado** (owner/admin, imposto na
  rota).
- O **autor não aprova sozinho** uma proposta de escopo de ORGANIZAÇÃO (várias
  lojas, `store_id` nulo). Em loja única, um papel autorizado pode.

### Experimento e evidência (LEARN-004)

`recordOutcome` grava métrica final + confiança + período. **Sem número não
valida** — a proposta só vira `validated` com resultado ASSEGURADO.

### Promoção e revogação (LEARN-005)

`promote` (só `validated`) escreve uma linha em `retail_store_patterns`
(`pattern_type='manager_solution'`, `created_by_type='user'`) com **procedência**
(autor, proposalId, baseline/final/confiança). Idempotente. `revoke` põe o padrão
em `dormant` — sai da recuperação confiável, mantendo o histórico.

### Proteções (LEARN-007)

`sanitizeText`: remove caracteres de controle, **barra linhas de injeção de
instrução** ("ignore previous", "system:", `<|...|>`) e **segredos**
(`api_key`, `password:`…), e limita o tamanho. Higiene de texto — não é IA.

### Recuperação pela IA (LEARN-006) — **IMPLEMENTADO**

`ManagerSolutionRetrievalService` (determinístico, read-only). `forPattern(orgId,
patternId)` / `retrieve(orgId, {patternType, storeId, excludePatternId})`
recuperam **só** padrões `manager_solution` `status='validated'` cuja proposta
está `promoted` (revogadas viram `dormant` e **somem**, LEARN-007), casando o
**mesmo tipo de problema** (o `pattern_type` que a proposta referenciou). Cada
item **DECLARA**: `origin:"humana"` + autor + onde funcionou (loja/rede) +
evidência (baseline/final/confiança/período), e traz **cautela graduada** — nunca
afirma eficácia geral:

- confiança < 0,6 → *insuficiente / trate como HIPÓTESE, teste antes*;
- evidência LOCAL (uma loja) → *não generalizável, teste controlado antes*;
- rede + confiante → `generalizable`, mas *ACOMPANHAR ao aplicar*.

## Rotas (§9.5)

`GET/POST /solution-proposals`, `POST /patterns/:patternId/solution-proposals`,
`POST /solution-proposals/:id/{submit,approve-test,start-test,record-outcome,
promote,reject,revoke,archive}`. Criar/listar/submeter: qualquer usuário
autenticado (o gerente propõe). Aprovar/promover/rejeitar: owner/admin.
`GET /patterns/:patternId/solutions` (LEARN-006): recupera as soluções validadas
relevantes ao padrão — leitura, qualquer usuário autenticado.

## Consequências

- Cobre AC-12 (proposta sem aprovação+resultado não aparece como prática
  validada) e AC-13 (promoção com procedência e escopo).
- Aditivo/retrocompatível; isolado por organização; sem motor paralelo.

## Fora desta fatia

- **UI "Sugerir solução"** (campo nos sinais/padrões/tarefas) + painel de gestão
  das propostas — próxima fatia.
- (nada pendente nesta linha — LEARN-006 entregue acima.)

Testes: `scripts/test-manager-solution.ts` (19 checks) +
`scripts/test-manager-solution-retrieval.ts` (11 checks, LEARN-006).
