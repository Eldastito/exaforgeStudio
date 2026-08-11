# Runbook — Operar o ZapFlow SkillOS (PRD 4)

**Escopo:** operar, promover, frear e diagnosticar o **SkillOS** — a camada de coordenação (Capabilities/Skills) que roda sobre a infra existente (Runtime ADR-152/159, Radar, Context Engine, Decision/Approval, Business Signals). Referência de arquitetura: `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` e o estado por fatia em `docs/skill-os/STATUS-DE-EXECUCAO.md`.

**Princípios inegociáveis:**
- **§67 / ADR-159 — sem bypass.** Uma Skill NUNCA executa efeito direto. O efeito vira `decision_action` (`DecisionActionService.propose`) e só corre pelo choke-point único (`CommandExecutorService.execute`, guardas G1 autonomia / G2 execution_mode / G3 aprovado). Não existe 2º executor. Se você pensou em criar um, pare.
- **§30 — custo só Admin Master.** R$/US$ do consumo de IA vivem só em `/api/admin/ai-usage` (`requireMasterAdmin`). Toda visão de tenant é em ações/%/contagens (guarda `SkillOsObservabilityService.assertTenantSafe`).
- **P7 — determinístico antes de probabilístico.** Validação/scorer/rollout são determinísticos e rodam na CI sem chave de IA. IA é proposta sujeita a validação, nunca decisão final.
- **RN-014 — IA nunca auto-eleva autonomia.** `autonomous` nunca é semeado por rollout; humano sempre no laço.

---

## 1. Mapa mental (o que é cada peça)

| Camada | Serviço | Papel |
| --- | --- | --- |
| Contratos puros | `skillosModel.ts` | tipos + guardas determinísticas (taxonomia de falha, scorers de eval, rollout) |
| Registro | `SkillOsRegistryService` | catálogo de Capabilities/Skills (plataforma, §49) |
| Resolução | `SkillOsResolverService` | escolhe a Skill (determinístico, sem IA) + fallbackChain |
| Kernel | `AiReliabilityKernel` | envelopa a chamada de IA (validação + taxonomia + retry por política + AI Run) |
| Roteamento de modelo | `SkillOsModelRouterService` + `SkillOsProviderHealthService` | casa requisitos×modelo + circuit breaker derivado |
| Grounding/Confiança | `SkillOsGroundingService` + `SkillOsConfidenceService` | gate `UNSUPPORTED_CLAIM` (§19) + confiança |
| Planner | `SkillOsPlannerService` | objetivo → ExecutionPlan (reusa ProcessRuntime) |
| Ponte de execução | `SkillOsExecutionBridge` | Skill → `propose` → CommandExecutor (SEM bypass) |
| Observabilidade | `SkillOsObservabilityService` | AI Runs pro tenant, §30-safe |
| Consumo do tenant | `SkillOsTenantUsageService` | %-franquia + tendência + alerta reusado |
| Evals/Shadow | `SkillOsEvalService` | harness determinístico + gate de regressão |
| **Rollout/Kill/Readiness** | **`SkillOsRolloutService`** | **esteira §68 + canário + kill switch + prontidão** |

---

## 2. Promover uma skill na esteira (§68)

A escada de rollout (maturidade crescente): `development → shadow → pilot → assisted → approved_execution → broader`. Cada estágio mapeia pro `execution_mode` existente da ADR-159 (nunca uma escala nova):

| Estágio | `execution_mode` | Efeito |
| --- | --- | --- |
| `development` | — (não exposto) | só dev/testes; a skill não aparece pra tenant |
| `shadow` | `shadow` | roda em sombra, SEM efeito (compara candidata×atual via `SkillOsEvalService.shadow`) |
| `pilot` | `assisted` | exposta ao **cohort de canário** (`canaryPercent`), humano assiste |
| `assisted` | `assisted` | idem, cohort maior |
| `approved_execution` | `approved_execution` | efeito só após aprovação (choke-point) |
| `broader` | `approved_execution` | geral, ainda com aprovação humana |

**Comandos** (owner/admin):
- Avançar: `POST /api/skillos/rollout/:skillId { "stage": "pilot" }`
- Ajustar canário: `POST /api/skillos/rollout/:skillId { "canaryPercent": 25 }`
- Ver decisão pra org atual: `GET /api/skillos/rollout/:skillId`

**Cohort de canário é estável:** a mesma `(skill, org)` cai sempre no mesmo balde (hash puro `hashPercent`). Subir 10% → 25% só **adiciona** orgs — nunca embaralha quem já estava dentro. `shadow` e `broader` ignoram o percentual (shadow é universal-sem-efeito; broader é geral).

**Sequência recomendada por skill** (pilotos §61 — Collection Intent Classifier, Sales Recovery Message, Signal Investigation): `shadow` (compare notas no eval) → `pilot 10%` → observe readiness/evals → subir % → `approved_execution` → `broader`.

**Promoção dos 3 pilotos pra `pilot 10%` (atalho batch, aplicado no boot):** os 3 pilotos §61 já sobem juntos de `shadow` → `pilot @10%` — automático no deploy (idempotente) ou manual via `POST /api/skillos/promote-pilots { "percent": 10 }`. É **one-time** (marker `pilots_pilot10_v1`): aplica a decisão UMA vez e nunca re-dispara, então um **rollback** posterior (`/rollout/:id/rollback`) fica de pé. Só **avança** de `shadow` — skill que o operador já subiu além é preservada (nunca rebaixa, nunca mexe no canário dela). Daí pra frente, cada piloto segue individualmente pela esteira normal acima.

**Subir o canário dos 3 pilotos (batch, aplicado no boot):** amplia o cohort dos 3 de uma vez — automático no deploy ou manual via `POST /api/skillos/raise-pilots-canary { "percent": 25 }`. **Não mexe no estágio**, só no percentual. **One-time por-percentual** (marker `pilots_canary_<percent>_v1`) e **só sobe** (nunca estreita o cohort): skill cujo canário o operador já pôs ≥ percent é preservada, e skill em `shadow` é pulada (percentual não se aplica). Subir (10% → 25% → 50% → 100%) só **adiciona** orgs — quem já estava no balde menor continua dentro (hash estável); a **100%** o cohort é universal (todas as orgs). Os degraus compõem em sequência (markers independentes por percentual).

**Avançar o estágio dos 3 pilotos (batch, aplicado no boot):** sobe o **estágio** (não o canário) dos 3 de uma vez — automático no deploy ou manual via `POST /api/skillos/advance-pilots-stage { "stage": "approved_execution" }`. Sobe o **teto de `execution_mode`** (ADR-159): em `approved_execution` o efeito só ocorre após aprovação no choke-point (nos pilotos §61 segue inerte — nenhum tem `commandType` próprio — mas o teto é real). **One-time por-estágio** (marker `pilots_stage_<stage>_v1`) e **só avança** (nunca rebaixa): skill que o operador já pôs em/além do alvo é preservada; o **canário é preservado**. Estado atual dos pilotos: **`approved_execution @100%`** (todas as orgs; efeito gated por aprovação). Próximo/último degrau: `broader` (geral, ainda com aprovação humana — `autonomous` nunca é semeado por rollout).

> **Durabilidade:** o estágio é **estado do operador** — o onboarding (`seedPilots`, roda a cada boot) semeia `shadow` só na 1ª vez e **nunca sobrescreve** promoção/rollback depois. Uma promoção pela rota `/rollout` sobrevive a reboot.

---

## 3. Frear / reverter (§69 — do mais leve ao mais duro)

1. **Rollback de estágio:** `POST /api/skillos/rollout/:skillId/rollback` — desce UM degrau (`development` é o piso). Reversível com `setStage`.
2. **Kill por-skill:** `POST /api/skillos/rollout/:skillId/kill { "on": true }` — corta só aquela skill. `{ "on": false }` revive.
3. **Kill switch de plataforma:** `POST /api/skillos/kill-switch { "on": true }` — desliga o **SkillOS inteiro** num comando (a linha `__global__` em `skillos_rollout`). `{ "on": false }` religa.
4. **Provider fallback:** o Router já desvia de provider com breaker aberto (F5). Nada a fazer manualmente; confira em readiness.
5. **Rollback de versão de skill/prompt:** re-registre o caso/skill anterior (o `prompt_version` fica no AI Run pra auditoria).
6. **Migration:** todas as migrations do SkillOS são **aditivas** (CREATE/ALTER no fim de `db.ts`); reverter = desligar via flag/kill, nunca dropar coluna.

O kill switch e o gate de rollout **não** substituem o gate de execução (ADR-159): mesmo uma skill `broader` só executa efeito pelo choke-point, com aprovação. São camadas independentes que se somam.

---

## 4. Diagnosticar (readiness)

`GET /api/skillos/readiness` (owner/admin) — derivado por query (RN-004), §30-safe. Retorna `ok` + o que bloquearia produção:

| Campo | Fonte | O que significa |
| --- | --- | --- |
| `globalKill` | `skillos_rollout.__global__` | kill switch de plataforma ativo → SkillOS desligado |
| `killedSkills[]` | `skillos_rollout.killed=1` | skills cortadas individualmente |
| `regressedSkills[]` | último `skillos_eval_runs` com `regressed=1` | eval regrediu (passRate caiu ou caso que passava falhou) |
| `openProviders[]` | `SkillOsProviderHealthService.state='open'` | provider com breaker aberto (rajada de falhas) |

O mesmo sinal aparece no relatório geral de produção (`GET /api/admin/production-readiness`, master admin) como o check `skillos` (nível `optional` — SkillOS é opt-in, não derruba o status geral sozinho).

**Fluxo de triagem:**
1. `regressedSkills` não-vazio → investigue o eval (`GET /api/skillos/evals/:skillId`), corrija a skill/prompt ou faça `rollback`/`kill` da skill até resolver.
2. `openProviders` não-vazio → o Router já desvia; confira `GET /api/skillos/provider-health/:provider`. Se persistir, é incidente de provider (fora do SkillOS).
3. `globalKill` inesperado → alguém acionou o kill de plataforma; `POST /api/skillos/kill-switch { "on": false }` pra reativar depois de confirmar a causa.

---

## 5. SLO e drills

**SLOs sugeridos** (observáveis por `readiness` + `SkillOsObservabilityService.aiRuns`):
- **Grounding:** `byGrounding.unsupported / total` < 5% por skill madura.
- **Fallback:** `fallbackRate` < 10% na janela.
- **Eval:** 0 skills com `regressed=1` no último run em produção (`broader`/`approved_execution`).
- **Provider:** 0 providers em `open` de forma sustentada (> 15min).

**Drills (game day):**
1. **Kill switch:** acione `POST /api/skillos/kill-switch { "on": true }`, confirme que `isLiveForOrg` de qualquer skill vira `live:false reason:"kill switch global ativo"`, depois reative. Tempo-alvo: < 1 min.
2. **Rollback de regressão:** injete um caso de eval que quebra (regressão), confirme `regressedSkills` no readiness, `rollback` a skill, confirme readiness limpa.
3. **Canário estável:** suba `canaryPercent` de 10→25 e confirme que as orgs do cohort de 10% continuam dentro (hash estável).

---

## 6. O que NÃO fazer

- Criar um executor/scheduler/ledger/alerta paralelo (duplicidade = regressão arquitetural, PRD §3).
- Expor R$/US$ em qualquer rota de tenant (§30 — o guarda `assertTenantSafe` lança).
- Semear `execution_mode: 'autonomous'` via rollout (RN-014/LGPD — humano sempre no laço).
- Dropar coluna/tabela pra "reverter" (migrations são aditivas; reverta por flag/kill).
