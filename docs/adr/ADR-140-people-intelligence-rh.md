# ADR-140 — People Intelligence / RH IA: fundação (cadastro funcional + módulo RBAC)

- **Status:** Epic 7 / Fatias 1 (cadastro funcional + módulo RBAC `people`) e 3 (**sobrecarga com evidência** — carga de tarefas + disponibilidade declarada) implementadas. Competências/treinamentos e check-ins de performance vêm nas fatias seguintes.
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

### D4 — Sobrecarga com evidência (Fatia 3)
`employee_availability_events` (ausência/reduzida DECLARADA — sem inferência). `WorkloadService`: `assess(orgId, {asOfDate})` cruza, por colaborador **ativo com usuário vinculado**, a **carga de tarefas** (abertas + vencidas, de `tasks.assigned_to`) com a **disponibilidade** do dia, e sinaliza sobrecarga por **regras determinísticas** (≥6 abertas; ≥3 vencidas; ausente com tarefas abertas; reduzida com carga alta) — cada linha traz `reason` e `evidence` (contagens + amostra de tarefas + disponibilidade), cumprindo o aceite "com evidência". `publishOverloadSignals` publica um sinal `people`/`employee_overload` por sobrecarregado, **idempotente por `employee:dia`** (entra no ledger/Pareto, sem duplicar). `severity` = risk quando há vencidas ou ausência. Rotas: `GET /api/people/workload`, `POST /api/people/employees/:id/availability`, `POST /api/people/workload/publish-signals`.

## Consequências
**Positivas:** abre a fundação de RH (capacidade/desenvolvimento) reusando o RBAC granular **e** entrega o valor que o gestor sente — **sobrecarga baseada em fatos, com evidência** (tarefas + disponibilidade), que flui para o ledger de sinais. Restrito a gestores, isolado por org, aditivo (tabelas e rotas novas; nenhum fluxo atual muda).

**Trade-offs / escopo:** entregues cadastro (F1) e sobrecarga (F3); `skills`/`employee_skills`, `training_paths`/`training_assignments` (lacuna de competência) e `performance_checkins`/reconhecimento ficam para as próximas fatias. Sem UI nestas fatias (backend + rotas). Os limiares de sobrecarga são constantes por ora (não configuráveis por org).

## Guardas
- Só registro (sem pontuação de qualidade humana, sem dado sensível, sem recomendação trabalhista). RBAC restrito a gestores (via `requirePermission`, com fallback legado). Determinístico, isolado por `organization_id`.

## Testes
`test:people-registry` (F1) — **RBAC `people`**: owner/gerente veem, vendedor/atendente/financeiro não, fallback legado (owner vê, agent não); catálogo de funções idempotente por `(org, nome)`; CRUD de colaboradores (nome obrigatório, `get` com join da função, filtros por status/gestor); `update`/`setStatus` (status inválido rejeitado); isolamento por org. Regressão RBAC: `rbac-granular` 27/27, `rbac-enforcement` 15/15, `rbac-profiles-api` 28/28, `rbac-finance` 23/23.

`test:people-workload` (F3) — sobrecarregado por volume (7 abertas) + vencidas (4) → `risk` com evidência (amostra) e `reason`; tranquilo não sinaliza; **ausente com tarefas abertas** sinaliza (responsável AUSENTE); `asOfDate` fora da janela → disponibilidade volta a `available`; **só colaboradores ativos com usuário vinculado** entram; **sinais `employee_overload`** publicados (2) e **idempotentes por dia** (re-publicar não duplica); isolamento por org (assess vazio; availability rejeita colaborador de outra org).
