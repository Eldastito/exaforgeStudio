# ADR-140 — People Intelligence / RH IA: fundação (cadastro funcional + módulo RBAC)

- **Status:** Epic 7 / Fatia 1 (cadastro funcional `employees`/`employee_roles` + módulo RBAC `people`) implementada. Competências/treinamentos, disponibilidade, carga de tarefas e alertas de sobrecarga vêm nas fatias seguintes.
- **Data:** 2026-07
- **Origem:** PRD "ZappFlow Enterprise Intelligence" (Epic 7, §18). "O primeiro valor de RH deve ser capacidade e desenvolvimento, não folha." Condição de entrada do PRD — "Snapshot V2, RBAC, Ledger e Maestro estáveis" — cumprida (ADRs 135, 138, 136).
- **Relacionadas:** ADR-138 (RBAC granular / módulos), ADR-136 (Ledger/tarefas), ADR-051 (WhatsApp interno). PRD §18.

## Decisões

### D1 — Cadastro funcional (`employees` + `employee_roles`)
`employees` (função, gestor, unidade, jornada, status active|inactive|leave, admissão, vínculo OPCIONAL a `users` quando o colaborador tem acesso ao sistema) + `employee_roles` (catálogo de funções por org, idempotente por `(org, nome)`). `EmployeeService`: CRUD de funções e colaboradores, filtros por status/gestor, `update`/`setStatus`. Determinístico, isolado por `organization_id`.

### D2 — Módulo RBAC `people` (só gestores por padrão)
`people` entra em `RBAC_MODULES` + mapeamento de rota (`/people` → `people`). Nos templates, **owner** e **gerente** (default `full`) enxergam RH; **vendedor/estoquista/financeiro/atendente** (default `none`) **não**. As rotas usam `requirePermission("people", …)`, que aplica o RBAC **inclusive no fallback legado** (sem perfil: owner→full, agent→none) — então RH é restrito a gestores em qualquer organização, sem depender de flag. `seedSystemProfiles` faz o top-up idempotente do módulo nos perfis já semeados.

### D3 — Limites do PRD são de projeto, não só de UI (§18)
Esta fatia é **só registro**. Nada de: pontuar "qualidade humana" por conversa privada; inferir saúde/religião/política/gravidez ou dados sensíveis; recomendar demissão; reconhecimento facial disciplinar. Decisões trabalhistas seguem **humanas e registradas**. O modelo não tem campos sensíveis; as fatias seguintes (competências, sobrecarga) manterão isso — sinal/evidência determinísticos, recomendação humana.

## Consequências
**Positivas:** abre a fundação de RH (capacidade/desenvolvimento) reusando o RBAC granular — restrito a gestores, isolado por org, aditivo (tabelas e rotas novas; nenhum fluxo atual muda). Base para carga de tarefas, disponibilidade e alertas de sobrecarga com evidência.

**Trade-offs / escopo:** só o **cadastro**; `skills`/`employee_skills`, `training_paths`/`training_assignments`, `employee_availability_events`, `performance_checkins` e os alertas de sobrecarga/lacuna de competência ficam para as próximas fatias. Sem UI nesta fatia (backend + rotas).

## Guardas
- Só registro (sem pontuação de qualidade humana, sem dado sensível, sem recomendação trabalhista). RBAC restrito a gestores (via `requirePermission`, com fallback legado). Determinístico, isolado por `organization_id`.

## Testes
`test:people-registry` (Epic 7) — **RBAC `people`**: owner/gerente veem, vendedor/atendente/financeiro não, fallback legado (owner vê, agent não); catálogo de funções idempotente por `(org, nome)`; CRUD de colaboradores (nome obrigatório, `get` com join da função, filtros por status/gestor); `update`/`setStatus` (status inválido rejeitado); isolamento por org (colaboradores e funções não vazam). Regressão RBAC: `rbac-granular` 27/27, `rbac-enforcement` 15/15, `rbac-profiles-api` 28/28, `rbac-finance` 23/23.
