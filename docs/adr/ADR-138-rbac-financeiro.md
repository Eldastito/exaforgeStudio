# ADR-138 — RBAC financeiro: proteger caixa, DRE, retiradas e saúde por perfil (opt-in por org)

- **Status:** Epic 0 / Fatias 1 (gate financeiro opt-in + testes de negação) e 2 (ocultar no menu o que o perfil não acessa) implementadas. Reduzir os erros de typecheck legados (`npm run lint` zero) vem na fatia seguinte.
- **Data:** 2026-07
- **Origem:** PRD "ZappFlow Enterprise Intelligence" (Epic 0, §11). Hoje **Caixa, DRE, Saúde e Empresa × Proprietário não têm autorização RBAC específica** (§4, item 8): as rotas `/cash`, `/dre`, `/owner`, `/health-center` não estavam mapeadas a nenhum módulo, então passavam sem checagem de perfil. "Não se deve conectar IA a finanças enquanto o acesso financeiro não está explicitamente protegido."
- **Relacionadas:** ADR-095 (RBAC granular — `PermissionService`, perfis, `enforceModulePermission`), ADR-129 (Empresa × Proprietário), ADR-126 (Central de Saúde). PRD §11.

## Decisões

### D1 — Módulos financeiros no catálogo RBAC
Adicionados a `RBAC_MODULES`: **`financeiro`**, **`saude_negocio`**, **`empresa_proprietario`** (com rótulos para o editor de perfis). Mapeamento de rota (PRD §11, item 4): `/cash`, `/dre`, `/owner` → `financeiro`; `/health-center` → `saude_negocio`.

### D2 — Enforcement financeiro **opt-in por organização** (não quebrar)
Flag `organization_settings.rbac_finance_enabled` (default **0**). Os módulos financeiros só são gateados quando a org liga o flag — ligado **só para contas validadas** (ex.: Toulon em produção). Com o flag **desligado** (todo o parque), o acesso financeiro segue **exatamente como hoje** (sem regressão). A regra vive em `PermissionService.checkRouteAccess`, que o `enforceModulePermission` consome:
- **módulo financeiro + flag off** → não gateia (intacto);
- **módulo financeiro + flag on** → enforce para **todos** (perfil atribuído OU fallback legado por papel);
- **módulos não-financeiros** → comportamento atual (opt-in via `hasProfile`, parque legado intacto).

### D3 — Templates: quem vê finanças
`Dono` e `Gerente` (default `full`) enxergam tudo. `Financeiro` recebe `financeiro: full`, `saude_negocio: read`, `empresa_proprietario: read`. `Vendedor`, `Estoquista` e `Atendente` (default `none`) **não** veem finanças — cumprindo o aceite "atendente e vendedor não podem ver DRE/retiradas".

### D4 — Top-up idempotente dos perfis já semeados
`seedSystemProfiles` passou a **completar** perfis de sistema já existentes com os módulos novos via `INSERT OR IGNORE` — adiciona `financeiro`/`saude_negocio`/`empresa_proprietario` **sem sobrescrever** níveis já editados pelo admin. Assim uma org já semeada (ex.: Toulon) recebe o acesso financeiro correto ao ligar o flag.

### D5 — Auditoria de acesso financeiro sensível (PRD §11, item 6)
Todo acesso a módulo financeiro numa org com o flag on é auditado (`logAuthEvent`): `FINANCE_READ` / `FINANCE_WRITE` quando concedido, `FINANCE_ACCESS_DENIED` quando negado. Toggle do flag registra `RBAC_FINANCE_TOGGLED`. Rota: `GET/PUT /api/permissions/finance-rbac` (perfil `usuarios`).

### D6 — Menu espelha o enforcement (Fatia 2)
`PermissionService.permissionMap` (consumido por `GET /api/permissions/me`) passa a **omitir os módulos financeiros quando o flag está desligado** e incluí-los (com o nível real) quando ligado. Como o cliente já trata "módulo ausente do mapa" como visível (`canAccessModule` → `undefined ⇒ true`), o menu fica **idêntico ao de hoje** no parque legado e **esconde Caixa/Central de Saúde** exatamente para os perfis sem acesso quando o flag está on — sem lógica nova no cliente. Na `Sidebar`, os itens **Caixa** (`financeiro`) e **Central de Saúde** (`saude_negocio`) passaram a ser gateados por `canAccessModule(...)` (antes eram fixos). Fonte única de verdade: o backend continua reforçando via `enforceModulePermission`; o menu é só coerência visual.

## Consequências
**Positivas:** finanças passam a ter proteção RBAC explícita **e** o menu deixa de mostrar o que o perfil não pode abrir — ativável **sem risco** para o parque legado (opt-in por org). Reusa toda a fundação da ADR-095. Auditável. Cumpre a condição do PRD de "acesso financeiro explicitamente protegido" antes de ampliar autonomia de IA sobre finanças.

**Trade-offs / escopo:** esta fatia entrega o **gate de backend + testes de negação**. Ocultar no menu o que o perfil não acessa (front-end), e a redução dos ~28 erros de typecheck legados (`npm run lint` zero, item 1/2 do Epic 0), ficam para as próximas fatias. `people`/`production` (módulos citados no §11) entram junto dos seus épicos.

## Guardas
- Opt-in por organização (default off) — parque legado intacto. Determinístico. Isolado por `organization_id`. Fallback legado preservado (sem perfil → papel decide). Auditoria de leitura e mutação financeira sensível.

## Testes
`test:rbac-finance` (Epic 0) — org com flag: owner/gerente/financeiro acessam caixa/DRE/retiradas; **vendedor/atendente/estoquista NÃO** (DRE/retiradas/caixa); saúde é leitura para `financeiro` (GET ok, POST negado); fallback legado (owner acessa, agent não); módulo não-financeiro segue a regra atual. Org **sem flag**: caixa/DRE/saúde **não gateados** (intacto). **Top-up**: perfil já semeado ganha o módulo financeiro sem sobrescrever edição. **Menu (Fatia 2)**: com flag, o `permissionMap` inclui `financeiro`/`saude_negocio` com o nível real (vendedor `none`, owner `full`); sem flag, os módulos financeiros são **omitidos** (menu intacto) e os não-financeiros seguem no mapa. Regressão: `test:rbac-enforcement` 15/15, `test:rbac-granular` 27/27, `test:rbac-profiles-api` 28/28, `test:rbac-audit` 11/11.
