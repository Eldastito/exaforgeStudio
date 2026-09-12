# Runbook — Sales Coach (ADR-202)

Coach de vendas INTERNO: **treina o vendedor, nunca fala com cliente** (RN-SC-1).
Advisório e read-mostly — sugere, o gestor/vendedor decide (RN-SC-2). Aditivo,
reversível, opt-in por flag. Não toca envio, produção nem motores existentes.

## Mapa dos serviços

Tudo em `src/server/SalesCoachService.ts` (métodos `static`, `orgId` 1º arg,
determinísticos, read-only):

| Fatia | Método | O que faz |
| --- | --- | --- |
| F1 | `performanceSnapshot(orgId, sellerId, {months?, asOf?})` | Retrato de desempenho por PRECEDÊNCIA de fonte: ERP (`retail_erp_seller_sales`) > manual/foto (`retail_seller_sales`) > PDV (`orders.seller_user_id`). Nunca soma as três. Fonte rotulada. Sem dado → `hasData:false`, nulos (null≠0). |
| F2 | `gaps(orgId, sellerId, opts)` | Gaps DETERMINÍSTICOS: queda recorrente (MESMA regra do PeoplePatternMemory — ≥3 quedas mês-a-mês) + comparação com a mediana do time (≥2 comparáveis). Severidade qualitativa (high/medium/low), nunca nota que pune. |
| F3 | `feedback(orgId, sellerId, opts)` | Feedback grounded determinístico (base garantida, roda em CI). |
| F3 | `feedbackAsync(...)` | Reescreve o feedback via `chat` (tier economy). Best-effort: sem chave/erro → cai no determinístico (`aiUsed:false`). |
| F4 | `solutionsForSeller(orgId, sellerId, opts)` | REUSA `ManagerSolutionRetrievalService` (ADR-174): soluções de gerente VALIDADAS aplicáveis ao gap, rotulando origem humana + onde funcionou + caveat. Sem solução → vazio (não inventa). |
| F5 | `roleplay(orgId, sellerId, opts)` | Roteiros de treino determinísticos por gap. `customerLine` é a fala que o vendedor TREINA responder — NUNCA enviada a ninguém (disclaimer explícito). |
| F6 | `isEnabled` · `listSellers` · `sellerForUser` · `canView` · `bundle` | Superfície: flag + RBAC + composição F1–F5. |

## Rotas (`/api/sales-coach/*`, `src/server/routes/salesCoach.ts`)

Gate SERVER-SIDE por flag: router inteiro dá **404** com a flag off (0-regressão).

| Rota | Acesso | Retorno |
| --- | --- | --- |
| `GET /sellers` | gestor (owner/admin) | vendedores ativos do org |
| `GET /me` | qualquer usuário logado | bundle do vendedor ligado ao usuário (404 se não vinculado) |
| `GET /seller/:sellerId` | RBAC `canView` | bundle do vendedor (gestor: qualquer um; vendedor: só a si — 403) |

## UI (F6b)

Aba **"Coach de Vendas"** (`src/features/SalesCoachView.tsx`), `viewMode:'sales_coach'`.
Entrada no Sidebar gated por probe runtime (`status !== 404` em `/api/sales-coach/sellers`).
Gestor escolhe o vendedor do time; vendedor vê só a si.

## Como ligar

1. `UPDATE organization_settings SET sales_coach_enabled = 1 WHERE organization_id = ?`.
   Default 0 → módulo invisível e rotas 404 (RN-SC-7).
2. Vincular vendedores a usuários (`retail_sellers.user_id`) para a visão `/me` do
   próprio vendedor. Sem vínculo, só o gestor acessa via `/seller/:id`.

## Guardrails (RN-SC) — codificados em `test:sales-coach-hardening`

1. **VENDEDOR ≠ CLIENTE** — sem superfície externa; nada é enviado ao cliente.
2. **Advisório** — sugere, nunca pune; severidade qualitativa.
3. **Grounded** — só os números reais; sem dado → "sem base ainda" (null≠0, RN-004).
4. **Determinístico antes de LLM** — gap/retrato de query; LLM só redige.
5. **Conhecimento humano rotula origem** — soluções de gerente (ADR-174), nunca "verdade da IA".
6. **Isolamento multi-tenant** — tudo por `organization_id`.
7. **Opt-in por flag** (`sales_coach_enabled` default 0) — aditivo/reversível.
8. **Sem motor paralelo** — reusa PeoplePatternMemory (gatilho) / ManagerSolution (conhecimento) / `chat` (redação).
9. **LGPD/RH** — desempenho é sensível; role-gated (gestor vê time; vendedor só a si).

## Testes

`test:sales-coach-snapshot` · `-gaps` · `-feedback` · `-solutions` · `-roleplay`
· `-surface` · `-hardening` (codifica RN-SC + fiação de produção; FECHA o ADR-202).

## O que NÃO entra (explícito)

- Nada que fale com cliente (Vendedor IA externo — DEFERIDO até a F1.1 do choke-point).
- Nenhum envio externo → não toca a F1.1.
- Sem avaliação de RH/nota-que-pune. Sem motor de IA/aprendizado paralelo.

## Troubleshooting

- **Aba não aparece** → flag off (`sales_coach_enabled=0`) ou o probe recebeu 404. Confirme a flag.
- **`/me` dá 404** → o usuário não está em `retail_sellers.user_id` do org.
- **Desempenho "sem base"** → não há venda na janela em nenhuma fonte (ERP/manual/PDV). Esperado, não é erro.
- **Feedback sem reescrita de IA** → sem `OPENAI_API_KEY`; o determinístico é a base garantida (`aiUsed:false`).
