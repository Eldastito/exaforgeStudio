# ADR-072 — ModuleService — feature flags por organização

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Nem todo lojista quer Vision, Fashion, Prospect, Radar ou Estúdio. O `ModuleService` nasceu para responder à pergunta "essa org enxerga esse módulo?" e é o único gate consultado pelo middleware de rotas em `server.ts:374`. Módulo desligado ⇒ seção some da UI (o front lê `enabled_modules` de `/api/organization`) **e** a rota do backend responde antes mesmo de chegar ao handler. O código entrou em produção com a Fase 1 das verticais (ver `docs/PLANO-FASE1-VERTICAIS.md`), mas nunca ganhou ADR — este documento fecha essa lacuna.

---

## Contexto

Duas dimensões distintas precisam ser tratadas por serviços separados, e a confusão entre elas foi a razão de existir do `ModuleService`:

- **Acesso** (o que a org contratou / o que o admin ligou em Configurações › Módulos) — responsabilidade do `ModuleService`.
- **Limite** (quanto pode usar dentro do mês, quantas criações no Estúdio, se está inadimplente) — responsabilidade do `PlanService` (ADR-059).

Um módulo pode estar contratado e ligado mas com limite mensal estourado — nesse caso `ModuleService.isEnabled` devolve `true` e o `PlanService.aiAllowed` devolve `{ allowed: false, reason: 'monthly_limit' }`. Um módulo pode estar desligado mesmo com plano cheio — nesse caso o gate corta antes de qualquer contagem. A interseção é feita dentro do próprio `isEnabled` (linha 54–55 do serviço): a lista `enabled_modules` da org é interseccionada com `PlanService.modulesForPlan(orgId)`, que retorna `null` (plano sem restrição) ou uma lista específica do plano.

O estado de "acesso" mora em `organization_settings.enabled_modules` como JSON string. Duas invariantes semânticas justificam o cuidado com `null`:

- `enabled_modules = NULL` ⇒ **tudo ligado** (compatibilidade com orgs pré-Fase 1, antes das verticais existirem).
- `enabled_modules = '[]'` ⇒ **nada opcional ligado** — apenas o CORE (`atendimento`, `contatos`, `relatorios`, `configuracoes`) segue disponível.

A tabela `MODULE_BY_ROUTE` (linhas 16–37) é o mapa canônico do 1º segmento de URL para chave de módulo. Rota fora do mapa é considerada core/infra e nunca é bloqueada — decisão deliberada para não precisar listar `/api/auth`, `/api/organization`, `/api/plans` em lugar nenhum.

## Decisão

**Regras invioláveis do `ModuleService`:**

1. **Módulos CORE nunca bloqueiam** (linha 50). `atendimento`, `contatos`, `relatorios`, `configuracoes` são o mínimo para operar; um bug em `enabled_modules` não pode tirar o lojista do ar.
2. **API única `isEnabled(orgId, moduleKey)`** consultada tanto pelo middleware de rotas quanto por handlers individuais e pela UI (via endpoint `/api/organization`).
3. **Vertical dita o preset inicial** via `applyVertical(orgId, verticalKey)` — grava vertical + `enabled_modules` no mesmo UPDATE, atômico. Cada vertical em `verticals.ts` traz o próprio `modules[]`, e o admin pode refinar depois em Configurações › Módulos (`setModules`).
4. **Sanitização defensiva** — `sanitize()` filtra qualquer entrada contra `OPTIONAL_MODULES` e deduplica. Vale para preset da vertical **e** para override manual do admin — não confiamos no que o front mandou.
5. **Backfill idempotente no boot** — `backfillNullModules()` é chamado em `server.ts:1296`. Torna explícito o conjunto de módulos das orgs legadas (`enabled_modules IS NULL OR = ''`) sem mudar o que elas enxergavam: org com vertical recebe o preset da vertical, org sem vertical recebe o preset da vertical "outro" (todos). Rodar N vezes não muda linhas na segunda passada.
6. **Interseção com plano** — quando `PlanService.modulesForPlan(orgId)` retorna lista não-nula, `isEnabled` só devolve `true` se o módulo estiver **em ambas** as listas. Isso garante que downgrade de plano derruba módulos automaticamente sem precisar reescrever `enabled_modules`.
7. **Resposta defensiva no gate** — a intenção original era `404 not_found` (não vazar existência de módulos que a org não contratou), mas o middleware atual devolve `403 { error: 'module_disabled', module }` (`server.ts:379`). Trade-off documentado abaixo.

## Consequências

**Positivas:**
- Ativar Vision, Prospect, Fashion ou Radar para um cliente novo é `applyVertical` + `setModules` — sem migração, sem redeploy.
- Downgrade de plano não exige reescrever `enabled_modules` — a interseção com `modulesForPlan` cuida disso em tempo de request.
- Backfill preguiçoso permitiu introduzir verticais sem downtime nas orgs legadas.
- Gate no middleware de rotas (uma única linha em `server.ts`) fecha por default: novo endpoint que caia sob um segmento mapeado herda o gate sem trabalho extra.
- Sanitize + `OPTIONAL_MODULES` como allowlist evita "módulo fantasma" — se alguém digitar `vms2` no JSON, entra sem efeito e sai no próximo save.

**Trade-offs aceitos:**
- **Sem histórico de ativação/desativação.** `enabled_modules` é sobrescrito em cada `setModules`; não há trilha de auditoria do "quem ligou/desligou quando". Suficiente para debugar suporte 1:1 hoje; revisitar se surgir requisito de compliance.
- **Sem trial temporário automático.** Não existe "ligar Vision por 14 dias e desligar sozinho" — isso teria que virar coluna separada (`module_trials`) com cron de expiração. O modelo atual assume ativação permanente até intervenção manual.
- **403 em vez de 404 no gate.** O middleware devolve `{ error: 'module_disabled', module: 'vms' }` — o front usa esse `module` para renderizar CTA de upgrade correto, mas vaza qual módulo estava por trás da rota. Aceitável enquanto o catálogo de módulos for público (aparece na landing); revisitar quando tivermos módulos experimentais/beta que não queiramos anunciar.
- **`enabled_modules` como JSON string em coluna TEXT** — sem constraint no banco. Confiamos no `sanitize()` da aplicação. Migrar para tabela `enabled_modules(org_id, module_key)` daria índice e integridade referencial, mas dobra o número de queries para responder `isEnabled` (chamada em quase todo request).
- **`try/catch` engolindo erros no `enabledModules`** (linha 46) — se o banco falhar, cai em `null` e a org vira "tudo ligado". Em modo degradado isso é mais gentil que 500-ar todas as rotas, mas mascara falhas de storage.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-module-service.ts`. O comportamento é exercitado transversalmente por testes de módulo que precisam ligar/desligar a flag como pré-requisito:

- `scripts/test-tenant-isolation.ts` — o mais próximo de teste do serviço: cria orgs com verticais diferentes (Hotel, Varejo) e verifica que `isEnabled("reservas")` acompanha o preset (linhas 123–124).
- `scripts/test-radar-isolation.ts` — cobre o caso "módulo `radar` desligado por padrão na vertical mais permissiva (`outro`)" e o toggle via `setModules`.
- `scripts/test-radar-*.ts`, `scripts/test-backlog-radar-infra.ts`, `scripts/test-conversion-velocity.ts` — todos começam com `applyVertical("outro")` + `setModules([...mods, "radar"])` como setup, exercitando `sanitize` e a persistência de JSON.

**Lacunas honestas** que devem virar `scripts/test-module-service.ts`:
- `enabledModules` retornando `null` para org inexistente **vs.** org com string vazia — o comportamento hoje é o mesmo, mas o teste trava isso.
- Interseção com `PlanService.modulesForPlan`: org com `vms` em `enabled_modules` mas plano que não inclui `vms` ⇒ `isEnabled === false`.
- Backfill idempotente: rodar `backfillNullModules()` duas vezes seguidas e verificar `updated === 0` na segunda.
- `sanitize` rejeitando módulo não listado em `OPTIONAL_MODULES` (ex.: `"vms2"`, `"admin"`), não-string, duplicatas.
- Round-trip UI: `setModules` → `enabledModules` → JSON parse íntegro.

Enquanto esses testes não existirem, qualquer mudança em `ModuleService` exige revisão manual das rotas que chamam direto (`analytics.ts`, `auth.ts`) e do middleware em `server.ts:374`.
