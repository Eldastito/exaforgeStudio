# ADR-014 — Radar Fase 3: painel do consultor (cross-tenant) e respondentes

**Status:** Implementado e testado ponta a ponta em navegador real (duas organizações, aprovação, isolamento confirmado).
**Origem:** usuário pediu para "completar e implementar o que está faltando" no Radar. O item mais substancial ainda pendente era a Fase 3 (painel do consultor, PRD original). O PRD não deixava claro quem é o "consultor" — perguntei diretamente ao usuário antes de escrever qualquer código, porque a resposta muda o modelo de permissões: **equipe da própria ZappFlow, com visão cross-tenant de todos os clientes** (não o dono/admin do próprio tenant revisando a própria empresa).

## Decisão de segurança: reaproveitar o gate do Admin Master, não inventar um novo

Antes de escrever qualquer query cross-tenant, investiguei como o Admin Master (única outra feature do produto com visão cross-organização) já resolve isso:

- Backend: `requireMasterAdmin` (`src/server/middleware/auth.ts`) checa `req.user.email === MASTER_ADMIN_EMAIL` (env-configurável, default `eldastito@gmail.com` — `src/server/config/secret.ts`). A proteção real acontece **no mount do router** (`server.ts`: `protectedApi.use("/admin", requireMasterAdmin, adminRoutes)`), não dentro de cada handler — nenhuma rota de dentro de `admin.ts` faz a própria checagem.
- Frontend: a Sidebar só esconde o item de menu por e-mail hardcoded; a proteção real é 100% do backend. Confirmado que não existe `role='master_admin'` nem coluna especial — é literalmente o e-mail.

Segui o **mesmo padrão exato**, não um novo: `protectedApi.use("/radar-consultant", requireMasterAdmin, radarConsultantRoutes)` em `server.ts`. `RadarConsultantService.ts` não recebe `orgId` em nenhum método — de propósito, para deixar explícito no próprio tipo/assinatura que este serviço é cross-tenant por natureza e só é seguro porque quem chama já provou ser master admin antes de chegar aqui (documentado em comentário no topo do arquivo, mesmo estilo de aviso já usado em `RadarPublicService.ts` para a exceção de `organization_id NULL`).

## O que foi construído

### Backend
- **`RadarConsultantService.ts`** (novo): `listSessions(filters)` (JOIN com `organization_settings` para trazer o nome da empresa, sem filtro de org), `getSession(id)` (pilares, recomendações, respondentes, respostas — sem filtro de org), `saveNote(sessionId, consultantUserId, note)`, `approve(sessionId, consultantUserId)`.
- **`status = 'approved'`**: já existia documentado no schema de `radar_sessions` desde a Fase 1 (`draft|in_progress|awaiting_review|needs_information|approved|published|archived|expired`) mas nunca tinha sido usado em código nenhum. Vira aqui o status terminal de "consultor revisou e aprovou" — `approve()` só aceita a transição partindo de `awaiting_review` (rejeita aprovar um rascunho ou aprovar duas vezes).
- **`next_action`/`consultant_user_id`**: colunas que também já existiam sem uso desde a Fase 1, viram a nota do consultor e quem revisou por último.
- **`src/server/routes/radarConsultant.ts`** (novo): `GET /sessions`, `GET /sessions/:id`, `PATCH /sessions/:id/note`, `POST /sessions/:id/approve`. Nenhuma checagem de autorização dentro do arquivo — o mount em `server.ts` já garante isso, mesmo padrão de `admin.ts`/`audit.ts`.
- **Respondentes** (`RadarService.listRespondents`/`addRespondent`, `routes/radar.ts`): `radar_respondents` já existia como tabela desde a Fase 0/1 (e `radar_answers.respondent_id` já era aceito por `saveAnswer`), mas nada expunha essa tabela até agora. Adicionado no nível do TENANT (`org`-scoped, isolamento igual a qualquer outra tabela do Radar — testado explicitamente que a organização B não lista nem adiciona respondente numa sessão da organização A), não no painel do consultor, porque é o próprio tenant que sabe quem mais precisa ajudar a responder.

### Frontend
- **`RadarConsultantView.tsx`** (novo): lista cross-tenant (nome da empresa + organização + score + status, com filtro por status), detalhe de uma sessão (pilares, recomendações, respondentes, respostas), campo de nota do consultor e botão "Aprovar revisão" (só aparece quando o status é `awaiting_review`).
- **`Sidebar.tsx`**: item "Radar — Consultor" com o **mesmo** `user?.email === 'eldastito@gmail.com'` já usado para o item "Admin Master" — não criei uma segunda fonte de verdade para "quem é privilegiado".
- **`RadarView.tsx`** (tela do próprio tenant): seção "Respondentes" na tela de resultado (listar + cadastrar), e correção de um status que a Fase 3 tornou possível: a tela só reconhecia `completed`/`awaiting_review` como "sessão finalizada" — uma sessão que o consultor aprovou (`approved`) caía por engano no fluxo de perguntas. Corrigido para reconhecer os três status.

## Validação real

Além dos 21 testes automatizados novos (`scripts/test-radar-consultant.ts` — cross-tenant, aprovação com guarda de estado, auditoria, isolamento de respondentes por organização) e da suíte completa do projeto (**8 scripts, 134 verificações, todas passando**, nenhuma alterada por este trabalho), rodei um fluxo end-to-end real: duas organizações diferentes, cada uma com um diagnóstico completo; logado como o master admin real (`eldastito@gmail.com`, criado no boot do servidor), confirmei que o painel lista as DUAS organizações, abri o detalhe de uma delas (viu o respondente cadastrado via API), salvei uma nota, aprovei a sessão, e confirmei que o status "Aprovado" aparece de volta na lista. Também testei o caminho inverso — logado como o usuário comum da segunda organização, confirmei que o item de menu não aparece E que uma chamada direta a `GET /api/radar-consultant/sessions` com o token desse usuário comum retorna 403 (a proteção real não depende da UI esconder o botão).

## Não incluído nesta rodada (deliberado)

- **Convite de respondente por link próprio (sem login do ZappFlow).** `radar_respondents` já tem os campos para isso (`status: invited|active|completed|revoked`), mas construir o fluxo de "colega responde sem ter conta" significa replicar o padrão de token opaco + rota pública já usado no diagnóstico anônimo (`RadarPublicService`/`radarPublic.ts`, ADR-012) — uma nova superfície de escrita não-autenticada, que merece ser desenhada e revisada por si (rate limit, expiração, o que acontece se o respondente reabrir o link depois do diagnóstico já ter sido concluído). Por enquanto, o registro do respondente é só cadastro/histórico — quem efetivamente responde as perguntas continua sendo o usuário logado que criou a sessão.
- **`radar_processes` (matriz impacto/recorrência/urgência/prontidão) e `execution_gap_index`.** O PRD original amarra essa métrica a uma matriz que o consultor preencheria durante a revisão — decidi não inventar essa interação agora sem ela ter sido pedida explicitamente; o campo `execution_gap_index` continua `NULL`, como já documentado desde a ADR-009.
- **`radar_evidence` (upload de evidência).** Aumentaria o grau de confiança das respostas (0,90/1,00 da escala do PRD §7.4), mas depende de decisão de armazenamento de arquivo por resposta — `StorageService` (ADR-011) já existe e tornaria isso possível, mas não foi pedido nesta rodada.
