# ANÁLISE — PRD "ZapFlow Fase 1: Correções de Fundamento" vs. CODEBASE

> Auditoria doc-only (F0). Nenhum código alterado. Base: leitura de `db.ts`, serviços `Retail*`, `BusinessHealthService`, `GestorCommandService`, `FalaTuBriefingDigestService`, `BriefingService`, `InsightsView`/`RetailOpsView`.
> Legenda: **ESTENDER** (já existe, falta borda) · **CRIAR** (não existe) · **VERIFICAR** (depende de dado/terceiro que não pude provar no código).

## 0. Veredito

O PRD é escrito como greenfield, mas **~60% das entregas já têm motor no repo**. Seguido ao pé da letra, a IA Dev criaria tabelas/serviços paralelos (exatamente o que o PRD proíbe). Regra pra todas as fatias: **cada uma começa com "estender X", nunca "criar Y"**.

| Entrega | Já existe? | Esforço real | Risco |
|---|---|---|---|
| F1.0 Estados semânticos (item 13) | Não (base compartilhada) | Médio | Alto se ficar pro fim |
| F1.1 Identidade + alocação | Parcial (~50%) | Médio | Médio |
| F1.2 SKU/EAN no leitor | Parcial (~70%) | Baixo | Baixo |
| F1.3 Política de estoque TOULON | Parcial (~40%) | Médio | Médio |
| F1.4 Meta e comissão | Parcial (~65%) | Médio | **Alto (dinheiro)** |
| F1.5 Recorrência de meta | **Já existe por loja (~75%)** | Baixo | Médio (humano) |
| F1.6 Briefing gerencial | Peças sim, montagem não | Alto | **Alto (dado)** |
| F1.7 Linguagem/ações/FalaTu | Parcial (~30%) | Médio | Médio |
| F1.8 Homologação | Testes existentes cobrem partes | Contínuo | — |

## 1. F1.0 — Estados semânticos (mover pra PRIMEIRO)

- **Não existe** tipo compartilhado zero-real/desconhecido/não-calculado/N-A/estimado. Precedente parcial: convenção `null≠0` (RN-EL-5, RN-OA-2, RN-CG-03, `fact|estimate`), mas espalhada por serviço.
- **Recomendação:** tipo `Metric<T>` (`{ state, value, basis, confidence?, source? }`) em módulo puro (`src/lib/`), + formatador único BRL/`—`/`N/A`. Sem tabela. Antes de F1.5/F1.6, senão o briefing nasce com `0` e é refatorado depois.
- **Risco:** a UI de varejo hoje formata `?? 0` em vários pontos — auditar antes de trocar.

## 2. F1.1 — Identidade de vendedores

**Já existe** (`RetailSellerDirectoryService`, `db.ts:2341,10252`):
- `retail_sellers` = identidade canônica por org (UNIQUE `organization_id, matricula`), com `source`, `identity_status` (pending|confirmed|conflict), `erp_last_seen_at`.
- `retail_seller_store_assignments` = lotação separada (seller×store, `is_primary`, `active`, `effective_from/to`, `source`, `confirmed_by/at`). Índice único de vínculo ativo.
- `discoverByStore` lista `CAI_USUARIO` sem nome (pendência acionável) e suspeitos de código compartilhado. RN-SELL-1: nunca confirma pessoa sozinho — **já alinhado ao "nunca inventar correspondência"**.

**Falta:**
1. **Aliases.** Não existe `retail_seller_aliases` (grep zero). Identidade é 1 matrícula = 1 vendedor; "Lohan Grande Rio / LOHAN" e "Eduardo Lázaro / EDUARDO" hoje viram linhas distintas. → **CRIAR** `retail_seller_aliases(seller_id, alias_norm, kind[name|matricula|cai_usuario], source, confirmed_by)` + resolução por alias no `sellerKeyOf` (hoje chave `mat:`/`nom:`/`user:`, `RetailCommissionService.ts:383`).
2. **Assignment com tipo e período.** Tabela existente NÃO tem `assignment_type` (principal|temporária|cobertura|transferência) nem `end_date` semântico por período (tem `effective_from/to`, sem `type`). → **ESTENDER** com 1 coluna aditiva `assignment_type`. **NÃO criar `retail_seller_assignments`** (duplicaria).
3. **Merge de identidades.** Precisa operação governada "unir A em B" (mover vendas/quota/assignments por alias, sem apagar linha — retenção/histórico). Não existe.
4. **Chave de agregação:** comissão/placar/streak usam `mat:`/`nom:` → depois do alias, TODOS devem resolver pela identidade canônica, senão o mesmo humano soma duas vezes no ranking.

**Casos confirmados (dados, não código):** Vinícius Romão ≠ Nascimento (nunca fuzzy-match por primeiro nome — o resolver de alias deve exigir confirmação humana; nome parcial NÃO é evidência). Kleyton fica pendente.

**Risco:** merge errado reescreve ranking/comissão. Fazer com `identity_status=conflict` como estado seguro + auditoria + reversível.

## 3. F1.2 — SKU/EAN no Atendimento de Loja

**Já existe** (`RetailFloorScanService.scan`, `:50–115`): normaliza dígitos; variante por `product_variants.external_ref` OU `sku`; produto por `products_services.ean` OU `external_ref`; fallback por **prefixo** (EAN13 começa com `external_ref` de 12 — ADR-105); grava scan com estoque local/rede.

**Falta:**
1. **Coluna EAN na variante.** A busca de variante usa `external_ref`/`sku`, **não há `product_variants.ean`** verificado. O PRD pede "EAN da variante" primeiro. → VERIFICAR o schema de `product_variants`; se não existir, coluna aditiva + backfill do Alterdata mapper.
2. **Ordem do PRD** (EAN→SKU→ref externa→ERP→alias) ≠ código atual (variante ext_ref/sku → produto ean/ext_ref). Ajustar **sem regredir** o caso do prefixo.
3. **Tabela de aliases de código** (item 5 do PRD, "outros aliases cadastrados"): não existe → CRIAR mínima `product_code_aliases` só se o VERIFICAR do item 1 não resolver.
4. **Não-encontrado.** Hoje vira `no_assortment` (unmet demand "a loja não trabalha") — **semanticamente errado** quando o problema é cadastro. Precisa novo estado `code_unresolved` distinto de `no_assortment`, com as 3 ações (pesquisar catálogo / vincular a produto / reportar). "Vincular" grava alias → resolve na próxima leitura (loop de aprendizado, sem cadastro manual repetido).
5. Ambiguidade do prefixo (`LIMIT 2`): já detecta; garantir que mostre as 2 opções em vez de escolher.

**Critério de aceite objetivo:** teste com peça do catálogo Alterdata com EAN + com ref, ambas resolvidas sem cadastro. Estender `test-retail-floor-scan.ts`.

## 4. F1.3 — Política de estoque TOULON

**Já existe:**
- `RetailStockPolicyService` (ADR-170): mínimo/alvo por loja/produto/variante. Quantidade faltante só com META (saldo negativo ≠ falta).
- `RetailFloorReplenishmentService` (ADR-176): transferência na ruptura (sem estoque local + rede tem → pedido de transferência → `business_signals`, sem doador não inventa). **É exatamente a "oportunidade de transferência" (item 7).**
- `RetailInventoryService`: alerta `negative_stock` (aberto/resolvido) + `NEGATIVE_STOCK_CAUSES` (4 causas **em texto fixo**, heurística sem classificar por ocorrência).
- `RetailOpsSignalPublisher.ts:96–103`: publica `retail_store_stockout` (domain `inventory`, severity `risk`) — **note: a query lê `alert_type='negative_stock'`**. O "stockout" que o PRD chama de "ruptura" é, no código, **estoque negativo com nome enganoso**. Zerar (saldo=0) NÃO dispara esse sinal hoje.

**Implicação:** o problema "ruptura → recomprar" que o PRD quer eliminar pode ser **menor do que parece** no motor de sinais; a origem está nos textos/labels e no Diretor IA. → VERIFICAR onde "ruptura/reposição" aparece pro usuário (`ExecutiveQueryToolsService`, `ImpactPrioritizationService`, `SignalCorrelationService`, `InventoryPatternMemory`, `OnboardingTemplateService`) antes de mexer.

**Falta:**
1. **`replenishment_strategy` por empresa** (`collection_sellout` | `continuous_replenishment`): não existe. → coluna aditiva em `organization_settings` (opt-in, default = comportamento atual = 0-regressão), lida por RetailStockModeService-like resolver (molde: `getOrgMode`).
2. **Filtro no motor**, não na UI: os detectores (stockout, reposição, padrão de estoque) consultam a política antes de publicar. Um único resolver, N consumidores.
3. **Diagnóstico de negativo por ocorrência** (item 8): hoje só lista 4 causas possíveis. Classificar exige dados: última entrada, transferências, `stock_synced_at` (existe nos scans), última sync Alterdata (`AlterdataSyncLedgerService`). → CRIAR `NegativeStockDiagnosisService` **read-only**, agrupa por causa provável × loja. **Só classifica o que prova** (`unknown` é resposta válida — RN-EL-5 style). Agrupamento "231 ocorrências / 4 lojas / 3 causas" é derivado por query (RN-004).
4. **Guardrail (meu ponto crítico):** silenciar "zerou" NÃO pode silenciar a oportunidade de transferência (peça zerou numa loja com demanda e sobra em outra é o caso de dinheiro). São sinais distintos.

## 5. F1.4 — Meta e comissão

**Já existe (bastante):**
- Metas diárias por loja: `retail_store_quotas` (`quota_date`, `source: manual|imported|integration`) — **é a "distribuição vinda da planilha, não meta÷dias"**. Já correto por desenho.
- Cota por vendedor/semana: `retail_seller_quotas` (`seller_key`, `week_start`).
- **Comissão por competência já existe:** `retail_commission_plan_months` (loja+mês > rede+mês > plano legado > default CARIOCA), justamente "regra de setembro não recalcula agosto". `test-retail-commission-plan-months.ts`.
- Plano por loja: `retail_commission_plans` (`store_id '*'` = rede, loja tem precedência).
- Runs: `retail_commission_runs` `draft → approved|rejected`; aprovação **sempre humana (D7)**.
- Corrida 1º/2º, Avenida Brasil com política própria: `RetailCommissionRaceService` (`raceMonth`, `createRaceRun`).

**Falta:**
1. **Status de política** (draft|pending_confirmation|confirmed|active|archived): `retail_commission_plans`/`plan_months` **não têm** `status`. Runs têm status de *pagamento*, não de *regra*. → coluna aditiva `policy_status` nas duas tabelas; **default `active` para linhas existentes** (0-regressão); a apuração que alimenta pagamento consolida SÓ `confirmed|active`; `pending_confirmation` só em prévia. Este é o guardrail de dinheiro — **inegociável**.
2. **Importação inteligente** (item 21): não existe interpretação por IA de planilha de regras. Há `RetailScheduleImportService` (escala) como molde. → fatia própria, **escopo fechado a: parser → rascunho `pending_confirmation` → tela de confirmação**. Nunca ativar sozinho; a IA interpreta números de comissão → alucinação = pagamento errado. Sugiro **F1.4b (pós-Fase 1 core)**, não bloqueante.
3. Regra "Avenida Brasil: só o 1º participa" → verificar se `raceMonth` já modela (parece sim, política própria). VERIFICAR antes de codar.
4. Modal atual permanece como "edição avançada" — nada a remover.

## 6. F1.5 — Recorrência de meta (JÁ EXISTE por loja)

`RetailCommissionRaceService.sellerGoalSignals(orgId, storeId, refDate, monthsBack=6)` (`:1028–1064`) + rota em `routes/retailops.ts` + `test-retail-seller-goal-signals.ts`:
- Conta sequência de meses **fechados** consecutivos abaixo da meta; bateu → **encerra** a sequência (Julho 82 / Agosto 103 / Setembro 79 = 1º mês ✔ do PRD §15).
- Escala `ok · attention(1) · critical(2) · action(3+) · none` = 🟡 / 🟠 / 🔴 do PRD.
- Mês sem meta → **neutro (nem conta nem quebra)**.

**Responde minha pergunta anterior:** o comportamento existente para "mês não elegível" é **neutro/transparente** (sequência atravessa o mês). Decisão pendente do dono: manter "atravessa" ou "zera/congela" para férias/afastamento. Recomendo manter atravessar (mais conservador contra falso alerta) — **confirmar com Bruno**.

**Falta:**
1. **Elegibilidade** além de "sem meta": afastamento, férias completas, ainda-não-contratado, escala insuficiente. Só "quota<=0 → neutro" existe. Depende de dado de RH/escala (`retail_seller_store_assignments.effective_from` ajuda a "não contratado"; férias/afastamento **não há fonte** → VERIFICAR/definir).
2. **Escopo por loja.** Universo é `store`; vendedor com alocação temporária em 2 lojas (F1.1) é medido por loja. PRD quer **por pessoa** (rede toda). → depende de F1.1 (identidade canônica) + agregar por `seller_id` somando lojas do período.
3. **Chave `mat:`/`nom:`** — mesmo problema de alias do F1.1; hoje "Lohan" duplicado gera duas sequências.
4. **Aviso ao Bruno** (item 17): não vi publicação em `business_signals` da sinalização → CRIAR publicação (ledger, conv. nº 12; dedupe por seller+mês) e o texto agrupado. **Não criar tabela de alerta.**
5. **Oferta "analisar desempenho" + diagnóstico (item 18)**: `Diagnóstico de vendedor` cruzando vendas/PA/ticket/dias trabalhados. Existe placar (`sellerPeriodScoreboard`, `test-retail-seller-scoreboard`); montar diagnóstico determinístico com **fato × hipótese** separados (padrão RN-CG/RN-OA). Fatia própria.

**Risco (humano):** o alerta nomeia uma pessoa. Falso positivo por alias mal resolvido ou mês não elegível vira problema de RH. → só habilitar depois de F1.1 e com `identity_status=confirmed`; matrículas pendentes ("não identificado") **nunca** entram no alerta nominal.

## 7. F1.6 — Briefing gerencial (manhã / 16h / noite)

**Já existe:** `BriefingService.buildMorning` (briefing genérico por usuário, o que o PRD quer substituir), `FalaTuBriefingDigestService` (digest por WhatsApp), `RetailFloorDigestService` (resumo por loja), `RetailDashboardService`, metas diárias (`retail_store_quotas`), fechamento (`retail_daily_closings`: `informed_total`, `system_total`, `quota_amount`, `variance_*`), corrida semanal/mensal.

**Falta / VERIFICAR (dado é o gargalo, não código):**
1. **Vendas por loja em tempo (16h) — intradia.** `retail_daily_closings` é fechamento **diário**. Não provei que exista venda intradia vinda da Alterdata (o runner sincroniza preço/estoque/vendas por cursor de filial; granularidade horária = VERIFICAR com dados reais). Sem isso, "parcial das 16h" e "ritmo histórico deste horário" são impossíveis. **Pergunta bloqueante (repetida).**
2. **Dinheiro (venda em espécie).** `retail_daily_closings` NÃO tem quebra por forma de pagamento. Existem `retail_cash_week_closings`/`RetailCashDepositService` (depósito de caixa) e `RetailCardReceivable*` (cartão), o que sugere que o PDV/ERP tem forma de pagamento, mas **não o ligado a "venda em dinheiro por loja/dia"**. → VERIFICAR fonte. Se não houver: estado semântico **desconhecido (`—`)**, nunca `R$ 0,00` (F1.0).
3. **Comparação com ritmo histórico:** só afirmar com histórico suficiente (F1.0 estado "não calculado"). Precisa curva intradia histórica — mesma dependência do item 1.
4. **Acumulado semana/mês:** `RetailMonthWeeksService` (semanas da corrida, override por mês) já existe → reusar; **não** inventar semana ISO.
5. **Três momentos = 3 passes no Scheduler** (não 2º scheduler): estender `FalaTuBriefingDigestService`/`BriefingService` (janela `MORNING_START/END`); horários por org (BriefingPrefs já tem `morningTime`). Idempotência por (org, user, data, slot) — padrão `alreadySent/markSent` existe.
6. Entrega: WhatsApp interno já pronto (ADR-151 F6). Conteúdo só de exceções relevantes (sem logs técnicos) → usa F1.7.

**Recomendação:** entregar **noite primeiro** (dado de fechamento diário existe) e **manhã** (metas existem); **16h só após confirmar intradia**. Não prometer o 16h no cronograma.

## 8. F1.7 — Linguagem empresarial, ações específicas, FalaTu

**Já existe:**
- `InsightsView.tsx:151` e `RetailOpsView.tsx:383` têm o botão **"Agir"** genérico (propõe a ação recomendada via `act(p)`). → substituição progressiva por rótulo específico **vindo do tipo de sinal** (mapa `signalType → {label, verbo}`), sem trocar o `act` por baixo.
- Sinais têm `domain`/`signalType` técnicos (`retail_store_stockout`/`inventory`, etc.).
- `BusinessHealthService.ts:305`: `"Sem alertas hoje. Siga cuidando…"` quando `status==="saudavel"` — **origem da contradição** do item 26 (o texto sai do status calculado, independente da fila de atenção). → derivar a síntese da MESMA fonte que a lista de atenção (`attention()`), não de dois cálculos.
- `GestorCommandService.parse`: intents determinísticos (saldo, a_receber, a_pagar, prioridades, aprovações, `pergunta_negocio`). `pergunta_negocio` já é roteada. **Não existe `decision_analysis`.**
- `DecisionEngine.analyze` (Diretor IA) — motor único a reusar (item 24); `test-decision-intelligence-*`.

**Falta:**
1. **Camada de apresentação de sinais** (RN-UX-4 estilo `UxPresentationService`/`humanState/humanError` do ADR-163 F4 — **estender, não criar**): tabela `signalType → texto empresarial + "sua operação foi afetada?"`. **NÃO renomear `signal_type`** (quebra dedupe `retail_ops:stockout:<store>` e consumidores).
2. **Intent `decision_analysis`** no FalaTu/Gestor → chama `DecisionEngine.analyze`. Parsing de "R$180 mil, 30% de entrada, 60 dias" → parâmetros do simulador (`DecisionSimulatorService`). **Sem dado de fluxo de caixa a resposta deve ser "faltam dados: X", não parecer** (RN de grounding).
3. **Perguntas simples do item 25 (8 exemplos):** classificar quais já têm fonte:
   - "Como estão minhas lojas hoje?" → depende de F1.6/dado intradia.
   - "Quanto falta pra Grande Rio bater a meta?" → `retail_store_quotas` + vendas do dia (**dado**).
   - "Quem está há dois meses sem bater meta?" → F1.5 (`sellerGoalSignals`).
   - "Qual vendedor vendeu mais esta semana?" → placar existe (`test-retail-network-top-sellers`).
   - "Quanto vendemos em dinheiro hoje?" → **F1.6 item 2 (VERIFICAR)**.
   - "Quais lojas estão abaixo da meta?" → quota × vendas.
   - "Tenho alguma divergência de estoque?" → `negative_stock` (F1.3).
   - "Posso comprar R$180 mil?" → `decision_analysis`.
   Cada uma vira **ferramenta determinística** (padrão `ExecutiveQueryToolsService`, que já existe) — **LLM só formata, nunca calcula**.
4. **Central de Saúde** (item 26): "Nenhuma ação humana necessária / N assuntos precisam de atenção" = **1 fonte** (`attention()`), com processos técnicos auto-corrigidos excluídos (DLQ recuperado ≠ problema do Bruno).

## 9. F1.8 — Homologação e proteção de dados

- Cada fatia entrega `scripts/test-*.ts` + matrix no `ci.yml` (fluxo padrão). Regressão **obrigatória** por fatia (não só no fim): `test-retail-floor-scan`, `test-retail-seller-directory`, `test-retail-commission-*` (14 scripts), `test-retail-seller-goal-signals`, `test-retail-stock-policy`, `test-executive-retail-commission-block`.
- Teste "zero ≠ desconhecido": snapshot por métrica-chave (F1.0).
- Teste "regra pendente nunca vira pagamento": `createRun`/`report` com plan `pending_confirmation` → item de prévia, **nunca** consolidado.
- Checklist da §30 do PRD: manter; **"Mobile testado"** exige revisão manual — CI não prova.

## 10. Fechamento (item 27 — NÃO simplificar)

Estrutura pronta pro fluxo diagnóstico: `retail_daily_closings` (`informed_total`, `system_total`, `divergence_status`, `extracted_json`) + `RetailFloorReconciliationService` + `RetailBoletaService` + `RetailMoneyAuditService`. O fluxo "boleta≠origem → importação / boleta=origem,total≠soma → agregação / PDV=boletas,Sistema≠PDV → Alterdata / informado≠ → digitação" **não existe como classificador**. → **CRIAR** `ClosingDivergenceDiagnosisService` read-only (fora do escopo de "simplificar"; é ferramenta de investigação). Pré-requisito da Fase 2, não da Fase 1 — **sugiro tirar da Fase 1** ou tratar como F1.9 opcional.

## 11. Ordem recomendada (revisada)

1. **F1.0** Estados semânticos (tipo + formatador) — base.
2. **F1.2** Leitor (P0 operacional, isolado, 70% pronto).
3. **F1.1** Aliases + `assignment_type` + merge governado + chave canônica na agregação.
4. **F1.3** `replenishment_strategy` + filtro nos detectores + diagnóstico de negativo agrupado.
5. **F1.4a** `policy_status` (guardrail de pagamento). **F1.4b** importação por IA depois.
6. **F1.5** Estender `sellerGoalSignals` → por pessoa + elegibilidade + sinal ao Bruno (depende F1.1).
7. **F1.7a** camada de apresentação + rótulos específicos + Central unificada.
8. **F1.6** Briefing **noite → manhã → 16h (condicional a intradia)**.
9. **F1.7b** FalaTu: `decision_analysis` + ferramentas das perguntas simples.
10. **F1.8** regressão em TODAS as anteriores; matriz final.

## 12. Perguntas abertas (bloqueantes)

| # | Pergunta | Bloqueia |
|---|---|---|
| Q1 | A Alterdata entrega vendas **intradia**? Em que granularidade/latência? | F1.6 (16h), perguntas "hoje" |
| Q2 | Existe **forma de pagamento (dinheiro)** por venda/loja/dia no dado que o ZapFlow recebe? | F1.6 dinheiro, pergunta "dinheiro hoje" |
| Q3 | Mês com férias/afastamento: sequência **atravessa** (comportamento atual) ou **zera**? Qual a fonte de férias/afastamento? | F1.5 |
| Q4 | Regra "produto zerado = fim normal" vale para **todos** os produtos ou há exceção (básicos/alto giro)? | F1.3 |
| Q5 | Quem confirma merge de identidade (só owner? Bruno?) e como confirmar Kleyton? | F1.1 |
| Q6 | `product_variants` tem EAN próprio hoje? (checar schema/dados reais da TOULON) | F1.2 |

## 13. O que NÃO fazer (conflitos com CLAUDE.md)

- Não criar `retail_seller_assignments` (já existe `retail_seller_store_assignments`).
- Não renomear `signal_type` (dedupe/consumidores) — traduzir na exibição.
- Não criar tabela de alerta/`seller_alerts` — usar `business_signals` (conv. nº 12).
- Não criar 2º motor de decisão pro FalaTu — `DecisionEngine.analyze`.
- Não criar 2º scheduler pros 3 momentos — passes no `Scheduler.tick`.
- Não `DELETE`/reordenar em `db.ts` — CREATE-then-ALTER aditivo no fim; `policy_status` com default que preserva linhas atuais.
- Não somar `fact` com `estimate` nos totais do briefing.
