# ADR-193 — Product Evolution Ledger (backend mínimo, Fase 1)

**Estado:** **F1 aberto — 1 fatia (backend mínimo).** Aditivo sobre a Fase 0
(`docs/product-evolution/*`) que fez a auditoria inicial. Não altera nenhum
motor existente. Admin Master only.
**Data:** 2026-08-27.
**Natureza:** primeira fatia de implementação do PRD-PEL-01 (ZapFlow Product
Evolution Ledger + Gap Closure). A F0 (PR #1392) entregou apenas os docs de
auditoria; esta fatia entrega o backend mínimo pra sustentar o ledger.

## 1. O problema

Após a F0 temos a matriz das 25 iniciativas com evidência, mas ela é markdown
estático: não dá pra atualizar programaticamente, filtrar por estado, anexar
evidência nova sem editar o `.md` à mão, nem prevenir transições inválidas
(marcar `VALIDATED` sem evidência). O PRD-PEL-01 §7 pede 7 tabelas — só as 3
primeiras (items, evidence, sources) já resolvem 80% do valor. Grafo de
dependências, batches de fechamento e histórico imutável ficam para F1.5+
quando houver necessidade real.

## 2. Decisões (D1–D8)

- **D1 — Escopo global, Admin Master only.** O ledger NÃO carrega
  `organization_id`. Vive fora do isolamento multi-tenant. Rotas em
  `/api/admin/product-evolution/*` herdam `requireMasterAdmin`. Isso segue
  §4/PEL-07 do PRD e evita o custo de gate per-tenant para uma feature interna.
- **D2 — 3 tabelas, não 7.** F1 cria `product_evolution_items`,
  `product_evolution_evidence`, `product_evolution_sources`. As outras 4
  (`dependencies`, `reviews`, `closure_batches`, `batch_items`) ficam para
  F1.5+ com base em uso real, não em especulação. Todas aditivas ao fim de
  `db.ts` (CREATE-then-ALTER estrito, RN do CLAUDE.md §Convenções críticas).
- **D3 — Transições de estado codificadas como regressão.** O grafo de
  estados de `CONVENCOES.md §2` é aplicado no service (`assertTransition`):
  linear progressiva + terminais alternativos (`DEFERRED`, `REJECTED`,
  `SUPERSEDED`). Tentativas inválidas retornam erro; o teste cobre isso
  para não regredir na F1.5+.
- **D4 — Evidência é opt-in; `VALIDATED` exige evidência verificada.** Um
  item só transiciona para `VALIDATED` se tem ≥1 `product_evolution_evidence`
  com `verified=1`. Regra codificada no service (RN-PEL-4). Não é
  auto-verificação — evidência precisa ser marcada `verified` por rota
  explícita, com `verified_by` (user id) registrado.
- **D5 — `evolution_key` imutável.** Regex `^[A-Z][A-Z0-9_]{2,63}$`
  validada na criação. UPDATE de `evolution_key` retorna erro. Renomes
  vão por `SUPERSEDED` + novo item, conforme `CONVENCOES.md §1`.
- **D6 — Sem LLM na reconciliação.** F1 é puramente CRUD determinístico.
  O `ProductEvolutionScoringService` (score 0–100) e o
  `ProductEvolutionReconciliationService` (comparação PRD × branch) do
  PRD-PEL-01 §8 ficam para F3. Não escondemos LLM aqui — a
  fatia é intencionalmente burra.
- **D7 — GitHub Evidence Sync fora do escopo.** Fase 4 do PRD-PEL-01. F1
  aceita evidência do tipo `pr`/`commit` com referência estável, mas não
  busca no GitHub. Anexar via API interna basta por enquanto.
- **D8 — UI fora do escopo.** F2 abre PR próprio com a tela
  `/admin/product-evolution`. F1 só tem API; verificação por curl ou pelo
  teste.

## 3. Guardrails / invariantes (RN-PEL-01..06)

1. **`evolution_key` imutável** — regex validada na criação; UPDATE recusa.
2. **Sem `organization_id`** — as 3 tabelas são globais; qualquer FK para
   `organizations` seria bug de escopo.
3. **Transição obedece grafo** — service valida contra tabela literal (D3);
   rota retorna 400 quando inválida.
4. **`VALIDATED` requer evidência verificada** — service checa
   `EXISTS SELECT 1 FROM product_evolution_evidence WHERE item_id=? AND verified=1`
   antes de aceitar. 400 caso contrário.
5. **`SUPERSEDED` requer `superseded_by`** — service exige coluna preenchida
   ao setar esse estado. 400 caso contrário.
6. **Evidência tem tipo enumerado** — aceita apenas os 13 tipos de
   `CONVENCOES.md §3`. Fora disso, 400.

## 4. Fatias (PR-a-PR)

| Fatia | PR | Entrega |
| --- | --- | --- |
| PEL-F1 | (este PR) | 3 tabelas em `db.ts`; `ProductEvolutionLedgerService.ts`; rota `/api/admin/product-evolution/*`; `test:product-evolution-ledger` (25+ checks). |
| PEL-F1.5 | (futuro) | Tabelas `dependencies`, `reviews` (histórico imutável); grafo de dependências; snapshot de evidência ao mudar estado. |
| PEL-F2 | (futuro) | UI `/admin/product-evolution` (Matriz, Gaps, Fontes, Histórico). |
| PEL-F3 | (futuro) | Reconciliation engine + score 0–100 determinístico. |
| PEL-F4 | (futuro) | GitHub Evidence Sync opt-in (cache SQLite, rate-limit). |
| PEL-F5 | (futuro) | Import da matriz F0 como seed. |

## 5. Contratos de rota (§9 do PRD, subset mínimo)

`GET  /api/admin/product-evolution/items` — lista com filtros opcionais `?status=`, `?domain=`, `?q=` (busca em title/summary).
`GET  /api/admin/product-evolution/items/:key` — por `evolution_key`.
`POST /api/admin/product-evolution/items` — cria (body: `evolution_key`, `title`, `domain`, `summary`, `priority?`, `risk_level?`, `source_of_truth?`).
`PATCH /api/admin/product-evolution/items/:key` — atualiza (title/summary/priority/risk_level/target_release/owner_user_id/blocked_reason; NUNCA `evolution_key` nem `status`).
`POST /api/admin/product-evolution/items/:key/status` — transição de estado (body: `new_status`, `reason`, `superseded_by?`).
`POST /api/admin/product-evolution/items/:key/sources` — anexa fonte.
`POST /api/admin/product-evolution/items/:key/evidence` — anexa evidência.
`POST /api/admin/product-evolution/evidence/:id/verify` — marca evidência como verificada (body: `verified_by`).
`GET  /api/admin/product-evolution/items/:key/evidence` — lista evidência.
`GET  /api/admin/product-evolution/items/:key/sources` — lista fontes.
`GET  /api/admin/product-evolution/gaps` — filtro pré-canned (items em `PARCIAL`/`PRECISA ADAPTAR`/`PRECISA VALIDAR COM DADOS REAIS`/`NÃO EXISTE` com `blocked_reason` ou sem evidência recente).

## 6. Reuso

- `requireMasterAdmin` (`src/server/middleware/auth.ts`) — mesmo guard das outras rotas `/api/admin/*`.
- `db` singleton (`src/server/db.ts`) — segue o padrão de outros services (`PlatformTelemetryService`, `VpsSpecProfileService`).
- Padrão de rota (`AuthRequest`, `res.json/status`) — igual `routes/admin.ts`.
- Padrão de teste (`tmpDir`, `check(name, ok)`, imports dinâmicos) — igual `test-vps-spec-profile.ts`.

## 7. Diferidos (nenhum é bloqueador de F1)

- Tabelas `dependencies`, `reviews`, `closure_batches`, `batch_items` → PEL-F1.5+.
- Score 0–100 → F3.
- UI → F2.
- GitHub sync → F4.
- Seed automático da matriz F0 → F5 (por enquanto, seed manual via curl documentado no runbook futuro).
- Rota pública `/api/admin/product-evolution/matrix` (view materializada) → só quando F2 precisar.

## 8. Testes

`test:product-evolution-ledger` cobre:

1. **Criação e validação de `evolution_key`** — regex, unicidade, valores válidos/inválidos.
2. **Transições de estado** — grafo linear obedecido; SUPERSEDED requer `superseded_by`; VALIDATED requer evidência verificada.
3. **Anexar fontes** — todos os 10 tipos aceitos; tipo inválido rejeitado.
4. **Anexar evidência** — todos os 13 tipos aceitos; `verified=false` por default; verify explícito muda para `verified=true` com `verified_by`.
5. **Escopo global** — schema sem `organization_id`; grep dentro do teste para não vazar.
6. **Filtros** — `?status=`, `?domain=`, `?q=` retornam subset esperado.
7. **Gaps view** — lista items com estado gap sem evidência.
8. **Imutabilidade** — UPDATE de `evolution_key` rejeitado (400).

## 9. Rollback

Reverter este PR = drop das 3 tabelas + delete do service/rota/teste + reversão do wiring. Nenhuma tabela existente foi tocada; nenhuma migration destrutiva. Aditivo puro.
