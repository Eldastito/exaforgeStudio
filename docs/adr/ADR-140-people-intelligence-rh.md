# ADR-140 — People Intelligence / RH IA: fundação (cadastro funcional + módulo RBAC)

- **Status:** Epic 7 **MVP COMPLETO** — Fatias 1 (cadastro funcional + módulo RBAC `people`), 3 (**sobrecarga com evidência**), 2 (**competências + trilhas** / lacuna) e 4 (**check-ins + reconhecimento/feedback documentado**) implementadas.
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

### D5 — Competências + trilhas de treinamento / lacuna de competência (Fatia 2)
`skills` (catálogo), `employee_skills` (nível none|basic|intermediate|advanced, upsert por `(emp, skill)`), `training_paths` (com **função alvo** e competências que desenvolve), `training_assignments` (assigned|in_progress|completed, idempotente por `(emp, path)`). `PeopleDevelopmentService.developmentPlan` cruza, de forma **determinística**, as competências exigidas pelas **trilhas aplicáveis à função** × o que o colaborador tem, e devolve a **LACUNA** (skills abaixo de `basic`) + as **trilhas recomendadas** que a cobrem — o "orientação e treinamento **aplicável à função**" do aceite §18. Rotas sob `/api/people/*` (skills, employee-skills, training-paths, training, `/employees/:id/development`).

### D6 — Check-ins + reconhecimento/feedback documentado (Fatia 4)
`performance_checkins` (kind `checkin|recognition|feedback`, `period`, `summary`, `strengths`, `next_steps`, autor). `PeopleCheckinService`: `create`/`list`/`get`/`summaryFor` (contagem por tipo + último de cada). Texto **humano documentado** — cumpre "reconhecimento e feedback documentado" (§18) sem pontuar "qualidade humana" e sem recomendação executável. RBAC `people`, isolado por org.

## Consequências
**Positivas:** o **MVP de RH** fica completo — cadastro (F1), **sobrecarga com evidência** (F3), **capacidade/desenvolvimento** (F2) e **reconhecimento/feedback documentado** (F4) — tudo determinístico, restrito a gestores, isolado por org, aditivo. O primeiro valor de RH é capacidade/desenvolvimento, não folha, exatamente como o PRD pede.

**Trade-offs / escopo:** MVP completo (F1/F2/F3/F4). Sem UI nestas fatias (backend + rotas). Os limiares de sobrecarga e o nível mínimo de competência (`basic`) são constantes por ora (não configuráveis por org).

## Guardas
- Só registro (sem pontuação de qualidade humana, sem dado sensível, sem recomendação trabalhista). RBAC restrito a gestores (via `requirePermission`, com fallback legado). Determinístico, isolado por `organization_id`.

## Testes
`test:people-registry` (F1) — **RBAC `people`**: owner/gerente veem, vendedor/atendente/financeiro não, fallback legado (owner vê, agent não); catálogo de funções idempotente por `(org, nome)`; CRUD de colaboradores (nome obrigatório, `get` com join da função, filtros por status/gestor); `update`/`setStatus` (status inválido rejeitado); isolamento por org. Regressão RBAC: `rbac-granular` 27/27, `rbac-enforcement` 15/15, `rbac-profiles-api` 28/28, `rbac-finance` 23/23.

`test:people-workload` (F3) — sobrecarregado por volume (7 abertas) + vencidas (4) → `risk` com evidência (amostra) e `reason`; tranquilo não sinaliza; **ausente com tarefas abertas** sinaliza (responsável AUSENTE); `asOfDate` fora da janela → disponibilidade volta a `available`; **só colaboradores ativos com usuário vinculado** entram; **sinais `employee_overload`** publicados (2) e **idempotentes por dia** (re-publicar não duplica); isolamento por org.

`test:people-development` (F2) — skill idempotente por nome; `employee_skill` upsert por nível; **trilhas aplicáveis à função** (função + gerais, não a de outra função); **lacuna de competência** (aponta a skill faltante, ignora a que já tem) + **trilhas recomendadas** que a cobrem; **após aprender, a lacuna zera**; atribuição idempotente + status (`completed` grava `completed_at`); validações (nível/status inválidos, skill/trilha inexistentes); isolamento por org.

`test:people-checkins` (F4) — resumo obrigatório; colaborador válido; tipos checkin/recognition/feedback (tipo inválido → checkin); lista + filtro por tipo (mais recente primeiro); `summaryFor` conta por tipo e traz o último de cada; `get` preserva os campos; isolamento por org.
