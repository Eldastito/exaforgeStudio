# Convenções — Product Evolution Ledger

Convenções fixas usadas por `INITIAL-GAP-MATRIX.md`, `STATUS-DE-EXECUCAO.md` e
pelas fatias futuras do Ledger (backend/UI/reconciliação).

Este arquivo é referência normativa. Se um documento futuro divergir daqui,
é o documento futuro que precisa se ajustar (ou este é atualizado num commit
próprio, com justificativa no corpo).

## 1. `evolution_key`

- **Formato**: regex `^[A-Z][A-Z0-9_]{2,63}$`. UPPER_SNAKE, 3–64 chars, começa
  com letra, sem hífen, sem espaço.
- **Estabilidade**: chave é imutável após publicada. Consumidores externos
  (labels de PR, rótulos de log, futuras URLs) dependem dela.
- **Renomes**: proibidos. Substituição = novo item com estado `SUPERSEDED`
  apontando para o sucessor via `superseded_by`.
- **Aninhamento**: 1 nível apenas. Ex.: `DECISION_INTELLIGENCE` +
  `DECISION_INTELLIGENCE_RADAR` está OK; `DECISION_INTELLIGENCE_RADAR_ANOMALY_DETECTION`
  não — coloque como propriedade/tag, não como chave.
- **Exemplos válidos**: `VISUAL_RECIPE_ENGINE`, `BUSINESS_SKILLS_PACK`,
  `WIFI_PRESENCE_CSI`, `VISION_EDGE_PERCEPTION`.

## 2. Estados (`status`)

Ordem canônica de progressão:

| Estado | Definição operacional |
| --- | --- |
| `IDEA` | Discussão em chat/reunião. Sem doc estruturado. |
| `ANALYZED` | Análise técnica escrita (ex.: `docs/prd/ANALISE-*`). Sem PRD final. |
| `PRD_READY` | PRD/ADR fechado no repo. Sem código ainda. |
| `APPROVED` | Alguém explicitamente autorizou implementação (nota no PR, ADR marcado como aprovado, mensagem do dono do repo). |
| `IMPLEMENTING` | Existe branch/PR aberto com código concreto. |
| `CODED` | Código mergeado. Sem teste ainda no CI matrix. |
| `TESTED` | Suíte roda no CI (`npm run test:<nome>` no matrix de `.github/workflows/ci.yml`). |
| `PILOT` | Ativo por flag em ≥1 organização real, com telemetria. |
| `PRODUCTION` | Habilitado por default (ou piloto expandido a maioria) e sem regressão. |
| `VALIDATED` | Evidência do resultado esperado (métrica, feedback, comparação antes/depois). |
| `DEFERRED` | Reconhecido mas adiado. Reason + próximo gate registrados. |
| `REJECTED` | Decisão de não fazer. Reason + alternativa registradas. |
| `SUPERSEDED` | Substituído por outro item. `superseded_by` obrigatório. |

**Sub-estado usado na Fase 0 apenas**: `PRECISA VALIDAR COM DADOS REAIS` —
código existe, mas nenhuma amostra permite classificar entre `CODED` e
`PRODUCTION`. Não é estado do Ledger; é anotação da matriz inicial que
força um humano a decidir na revisão.

## 3. Evidência

Uma evidência precisa ter:

- **Tipo** (`code` | `migration` | `route` | `ui` | `test` | `test_run` |
  `pr` | `commit` | `rollout` | `production_check` | `runbook` | `metric` |
  `customer_validation`)
- **Referência estável** (path relativo do repo, SHA, número de PR/issue)
- **Descrição de 1 linha** explicando o que a referência prova

Não conta como evidência:

- resumo executivo em PRD marcado como "concluído";
- header de ADR dizendo "FECHADO";
- contador agregado ("X módulos em produção");
- print de tela sem link para o commit correspondente.

## 4. Score de maturidade

**Não usar score como métrica primária.** O estado é primário. Score é 0–100 e
serve só para ordenação/filtro secundária. Regras (do PRD §6):

- Sem runtime real → cap em 49.
- Só PRD/ADR → cap em 20.
- Só UI sem backend real → cap em 30.
- Stub/dados simulados reduzem a dimensão runtime.
- "PRODUCTION" sem evidência não pode ser auto-atribuído.

A Fase 0 **não** calcula score — só estado. Score entra na Fase 3
(reconciliation engine).

## 5. Fontes (`sources`)

Tipos aceitos:

`chat` · `prd` · `adr` · `file` · `github_pr` · `github_commit` · `issue` ·
`meeting` · `manual` · `external_repository`

Cada fonte precisa de: título curto, data (mesmo que aproximada), referência
externa (URL, path, ID). Fontes de chat devem citar o participante e a data
sem colar conteúdo integral (privacidade).

## 6. Dependências

Tipos aceitos:

- `requires` — B só funciona depois de A pronto.
- `enhances` — B melhora se A estiver pronto, mas funciona sozinho.
- `blocks` — A precisa esperar B ser resolvido antes de avançar.
- `related` — relação semântica sem gate.

Fase 0 não cria grafo formal; só menciona dependências óbvias em prosa na
matriz.

## 7. Isolamento e RBAC

O Ledger é **Admin Master apenas** (§4 PEL-07 do PRD). Consequências:

- Sem `organization_id` nas tabelas do Ledger (é escopo global).
- Rotas em `/api/admin/product-evolution/*`.
- `requireRole` restringe a role master do repo (a mesma usada por
  `/api/admin/*` existente — verificar no ADR do Ledger).
- **Evidências** que apontam para dados de tenant (ex.: "validado no
  cliente X") devem respeitar isolamento na leitura — nunca vazam PII
  cross-tenant em views agregadas.

## 8. Reconciliação (regra dura)

- Reconciliação **não usa LLM** para inferir estado (§8.2 do PRD).
- Se PRD divergir da branch atual, **código vence** (§PEL-04). PRD é
  atualizado ou marcado `SUPERSEDED`.
- Sugestão de estado por LLM pode existir na UI, mas **humano confirma**.

## 9. GitHub Evidence (Fase 4, não desta fatia)

Quando implementado, o `GitHubEvidenceService` precisa:

- ser opt-in via env (`GITHUB_TOKEN` + `GITHUB_EVIDENCE_ENABLED=1`);
- rate-limit desde o commit 1 (respeitar quota da API, 5000/h autenticado);
- cache local (SQLite) obrigatório;
- read-only — nunca cria/edita PR ou issue automaticamente;
- **nunca** infere que um commit "fecha" um item só pelo texto — vínculo
  precisa ser explícito (label/anotação/edição manual).

## 10. Regressão zero

Todas as fatias futuras (F1..) precisam:

- migrations aditivas no fim de `db.ts` (CREATE-then-ALTER estrito);
- nenhuma remoção de rota existente;
- nenhum rename público sem camada de compat;
- isolamento multi-tenant preservado;
- baseline antes/depois documentado no PR body;
- rollback documentado.

Regras do repo (CLAUDE.md §Convenções críticas) permanecem — o Ledger não é
exceção.
