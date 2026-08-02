# ADR-083 — Retail Ops: Fechamento Inteligente de Loja (Quick-Start Comércio/Varejo 2.0)

- **Status:** Aceito (fundação; implementação em fases)
- **Data:** 2026-07
- **Contexto de origem:** PRD "Quick-Start Comércio/Varejo 2.0 — Retail Ops" (cliente TOULON, rede de lojas).
- **Relacionadas:** ADR-080 (Módulo Clínica — precedente de vertical aditiva com módulo gated), ADR-019/020 (Smart Inventory — OCR de imagem → JSON com confirmação humana), ADR-011 (fila de jobs/scheduler).

## Contexto

A TOULON não pede "mais atendimento por WhatsApp" — pede uma **central de controle operacional diário das lojas**: cada loja envia o fechamento do dia pelo WhatsApp, a IA lê (texto/foto/documento), compara com a **cota**, aponta **desvio** e **divergência com o sistema**, **cobra** quem não enviou (fechamento/malote/escala), sinaliza **estoque negativo** e calcula **premiação** — guardando o acumulado do mês.

Verificação do código (não do PRD) antes de decidir:

- **Não existe dimensão de loja física** — `grep store_id|filial|branch|unit` = 0. Estoque (`inventory_items`), pedidos (`orders`) e movimentos (`stock_movements`) são **por organização**. `storefront_*` é a vitrine e-commerce, não loja física.
- **Estoque negativo é ativamente impedido** — `MAX(0, quantity - ?)` em toda saída; `reserve` lança "insuficiente".
- **Visão/OCR já existe e é forte** — `llm.ts:extractInvoiceItems()` (foto → JSON estrito, `response_format: json_object`, `confidence`, regra "nunca invente") + rota `/api/products/invoice-scan` (upload multer + sharp + **rascunho → confirmação humana**). Ler a folha de fechamento é ~1 função + 1 rota copiando isso.
- **Quick-Start** — `OnboardingTemplateService.applyPack` aplica áreas/cadências/automações/FAQ de forma **idempotente** (dedup por nome/título; automações sobrescrevem). Pack `varejo` hoje = 2 áreas + 2 cadências + 1 FAQ. Flags de automação são **colunas em `organization_settings`** (interpolação SQL crua → exigem migração real).
- **Scheduler** — `pixReminderPass` é o molde pronto de "cobrança com retry" (contador/last_reminder). `CadenceService.startForTicket(orgId, ticketId, contactId, trigger)` dispara por string livre, mas **exige um ticket aberto** por responsável.
- **Fonte externa (Alterdata, pesquisa do cliente):** o PDV de vendas é o **PdvUP**; a **API Logistic** (`APILogisticModule`) cobre **cadastros/logística/fiscal** (Empresa, **Filial**, **FilialMalote**, CentroCusto, Transportadora, IBGE, NFEConfig, NotaNumero, **TransferirEstoque**) — **NÃO** expõe Venda/Pedido/Cupom, saldo/baixa de estoque, nem emissão SEFAZ. Ou seja, **a API não dá os totais de venda**.

## Decisões

### D1. Camada ADITIVA, módulo próprio `retail` — não tocar o core de venda
Retail Ops é um módulo gated (`retail`), com tabelas `retail_*` próprias. **Não altera** `orders`/`inventory_items`/`stock_movements`. Motivo: não regride o fluxo de venda que os outros clientes usam. Segue o precedente de Clínica (ADR-080) e Vision.

### D2. Dimensão de loja nova (`retail_stores`) — identificação por WhatsApp
Cada loja tem `whatsapp_identifier` (para casar o fechamento recebido ao remetente) e `manager_contact_id`/`manager_user_id`. As lojas podem ser **cadastradas à mão** ou, no futuro, **importadas da Filial** da Alterdata (conector auxiliar, D3).

### D3. A fonte do "sistema" é EXTERNA ao ZappFlow; conectores plugáveis
O ZappFlow **não é o PDV** da TOULON — as vendas vivem no PdvUP e a API Logistic **não as expõe**. Logo o `system_total` da conciliação vem de **import externo**, não dos `orders` do ZappFlow (que ficam intocados, D1). `retail_external_sales_imports.source ∈ {csv | sheets | api | webhook}`; o lojista escolhe. **MVP = CSV** (export do PDV). A **API Logistic da Alterdata** entra como **conector auxiliar** (lojas/Filial, malote/FilialMalote, transferências/TransferirEstoque) — não como fonte de vendas.

### D4. OCR do fechamento reusa o padrão Smart Inventory (draft → confirmação humana)
`extractClosingFromImage()` em `llm.ts` (irmão de `extractInvoiceItems`): system prompt pedindo `{"dinheiro","pix","credito","debito","voucher","troca","total","confidence"}` com a MESMA guarda "nunca invente valor ilegível" + `confidence`. Rota `/api/retailops/closings/:id/scan` copia multer+sharp+rascunho de `/invoice-scan`. **A IA nunca aprova sozinha**: gera rascunho, humano confirma/corrige.

### D5. Cobrança pelo SCHEDULER, não por cadência
As pendências (fechamento/malote/escala) vivem em `retail_store_daily_tasks`. A cobrança + retry + escalonamento ao gestor rodam num pass do Scheduler no molde `pixReminderPass` (contador `reminder_count`/`last_reminder_at` na própria linha). Cadência exige ticket aberto e é para nutrição de lead — as cadências do pack ficam para a **persona/onboarding**, mas o **envio real da cobrança é do Scheduler**.

### D6. Estoque negativo = DETECÇÃO (camada por loja permite negativo)
`retail_store_inventory` **permite quantidade < 0** (sem o `MAX(0,…)` do core), justamente para expor a divergência → `retail_stock_alerts`. O estoque core continua clampado e **intocado**. Sinais da Alterdata (`TransferirEstoque`/`FilialMalote`) alimentam a explicação de causa no futuro.

### D7. Premiação sempre com aprovação humana
`retail_commission_runs` nasce `draft`; o motor gera **prévia** e compara com a premiação enviada; o gestor **aprova** (nunca pagamento automático). Toda aprovação → `logAuthEvent`.

### D8. Flags de automação = colunas em `organization_settings`
Adicionar os `retail_*` ao tipo `Automations` **e** migrar as colunas correspondentes (o `applyPack` interpola os nomes crus no `UPDATE`; leituras no Scheduler ficam em try/catch "coluna ainda não migrada").

### D9. Segurança e rollout
Isolamento por `organization_id` em toda query. Auditoria via `logAuthEvent` (novos `eventType`: `RETAIL_CLOSING_*`, `RETAIL_QUOTA_*`, `RETAIL_COMMISSION_*`). Cada fase entra atrás do módulo `retail` (gated) e é uma PR reviewável com teste offline.

## Modelo de dados (resumo)

Tabelas `retail_*` conforme o PRD §6, todas com `organization_id` e migração idempotente inline em `db.ts`: `retail_stores`, `retail_store_quotas`, `retail_daily_closings`, `retail_daily_closing_items`, `retail_store_daily_tasks`, `retail_store_inventory`, `retail_stock_alerts`, `retail_commission_rules`, `retail_commission_runs`, `retail_commission_items`, `retail_external_sales_imports`. (Detalhe de colunas: PRD §6, adotado como está, salvo `retail_store_inventory` sem o clamp — D6.)

## Plano de fases (cada uma = 1 PR reviewável, atrás do módulo `retail`)

Ordem escolhida por **valor para a dor do lojista × dependência** (a fonte confirma que A–D já entregam o coração operacional):

- **Fase A — Fundação:** módulo `retail` (gating: `OPTIONAL_MODULES` + `varejo.modules` + `MODULE_BY_ROUTE`), `retail_stores` (CRUD + tela), extensão do pack `varejo` (áreas Fechamento/Malote-Escalas/Auditoria-Estoque/Premiação + FAQ operacional), tipo `Automations` + migração das colunas `retail_*`. Sem comportamento novo.
- **Fase B — Cotas + espinha do fechamento:** `retail_store_quotas`, `retail_daily_closings(+items)`, `retail_store_daily_tasks`; APIs; Scheduler **gera** as pendências diárias por loja.
- **Fase C — Fechamento por WhatsApp + IA (OCR):** `extractClosingFromImage` + rota de scan (draft→confirmação); identificar a loja pelo remetente; realizado/desvio vs cota. **(flagship)**
- **Fase D — Cobrança automática:** passes do Scheduler (fechamento/malote/escala) com retry + escalonamento ao gestor. **← fim do MVP.**
- **Fase E — Conciliação externa (MVP CSV):** `retail_external_sales_imports`; import CSV → `system_total`/loja/dia; concilia informado × sistema → divergência + alerta.
- **Fase F — Estoque negativo por loja:** `retail_store_inventory` (permite negativo) + `retail_stock_alerts`; IA explica causa provável.
- **Fase G — Premiação/comissão:** `retail_commission_*`; motor (`percent_sales`, `quota_bonus`, depois `tiered`/`fixed`); prévia + comparação + aprovação humana.
- **Fase H — Dashboard Retail Ops + acumulado mensal + export Sheets:** cards do PRD, top produtos por loja, fechamento mensal, aba no Google Sheets (reuso `buildLiveSheetData`).
- **Fase I — Conector Alterdata (auxiliar, opcional):** sync de **Filial** → `retail_stores`; **FilialMalote** → checklist de malote; **TransferirEstoque** → sinal de estoque; mapeamento do export do PdvUP para o import de vendas (Caminho C). Depois de E/F (a espinha genérica primeiro).

## Consequências

**Positivas:**
- Reuso alto e barato onde importa: OCR (Smart Inventory), cobrança (pixReminderPass), Quick-Start (applyPack), Sheets, auditoria, gating de módulo.
- Camada aditiva → zero risco ao fluxo de venda existente.
- MVP (A–D) entrega a promessa central ("loja manda no WhatsApp, IA lê, compara com a cota, cobra quem não enviou") sem depender de integração externa.

**Trade-offs aceitos:**
- Dimensão de loja e estoque negativo são net-new (não dá para reaproveitar o core clampado) — construídos como camada própria.
- O `system_total` depende de import externo (CSV) no MVP — a conciliação automática só fica "completa" quando o PDV exporta; até lá, o desvio vs **cota** já funciona (não depende de fonte externa).
- Premiação (config-heavy) fica por último, dependendo do acumulado de fechamentos.

## Guardas da IA (D4/D7)

Pode: ler fechamento (texto/foto/documento), extrair valores, pedir correção, calcular total, comparar com cota, resumir divergência, cobrar pendência, sugerir causa de estoque negativo, gerar prévia de premiação.
Não pode: aprovar fechamento divergente sozinha, alterar/pagar premiação sem aprovação, inventar valor ilegível, dar baixa em estoque sem regra, ignorar loja/responsável não identificado.

## Extensão — Custos fixos + Resultado/Lucro por loja (2026-07)

**Pergunta que originou:** o dono das lojas perguntou onde informa os custos fixos de cada loja (aluguel, luz, condomínio de shopping...) e onde isso entra no cálculo do lucro por loja. Até aqui **não existia**: custo fixo só agregado da organização (`comigo_fixed_costs_monthly`) e contas a pagar sem `store_id` (`payables`); a DRE (`ManagerialDreService`, ADR-128) e o resultado eram só no nível org, nunca por filial.

### E1. Custos DISCRIMINADOS por tipo, por loja
Nova tabela `retail_store_fixed_costs (organization_id, store_id, category, amount)` com `UNIQUE(organization_id, store_id, category)`. Categorias fixas: `aluguel|energia|condominio|agua|internet|folha|outros`. Upsert em lote (`RetailStoreCostService.setMany`) a partir da tela "Editar loja"; valor `<= 0` zera a categoria; categoria fora da lista é ignorada. Escolha por **tabela keyed** (não colunas em `retail_stores`) para somar fácil e permitir evoluir a lista sem novas migrações de coluna.

### E2. Lucro por loja precisa de margem — não dá pra subtrair só o custo fixo do faturamento
O único dado de venda por loja é o **faturamento** (fechamentos de caixa) — não há CMV por loja. Subtrair custo fixo direto do faturamento ignoraria o custo da mercadoria e **mentiria pra cima**. Decisão: nova coluna nullable `retail_stores.gross_margin_percent` (margem bruta média da loja, premissa gerencial, clampeada 0..100). O resultado é:

```
Faturamento      = Σ fechamentos do mês (system_total do PDV quando houver, senão informed_total; exclui 'rejected')
Margem contrib.  = Faturamento × (margem bruta % / 100)
Resultado        = Margem de contribuição − custos fixos da loja
Ponto equilíbrio = custos fixos ÷ (margem bruta % / 100)   [em faturamento]
```

**Guardrail (E2a):** sem a margem cadastrada, `resultado` e `pontoEquilibrio` ficam **NULL** (a UI mostra faturamento e custos, marca a loja como "falta margem" e **não inventa lucro**). O total de lucro da rede soma só as lojas com margem informada.

### E3. Consistência de faturamento
Usa a **mesma régua** de valor da Ponte de Faturamento (`RetailRevenueBridgeService`: `COALESCE(NULLIF(system_total,0), informed_total)`), garantindo que o número bata com o que a aba "Operação da Rede" já mostra por loja. Determinístico, zero-token, isolado por `organization_id`.

### E4. Superfície
- Serviço: `RetailStoreCostService` (`list`, `setMany`, `monthlyRevenue`, `storeResult`, `allStoresResult`).
- Rotas (gated pelo módulo `retail`): `GET/PUT /api/retailops/stores/:id/costs`, `GET /api/retailops/stores/:id/result`, `GET /api/retailops/stores-result` (mutação só owner/admin, via `requireRole`).
- UI: campos de custo + margem em "Editar loja"; nova aba **"Resultado por loja"** (faturamento, custos, margem, lucro estimado, ponto de equilíbrio; total da rede).
- Teste: `test:retail-store-result` (31 verificações — upsert por tipo, faturamento por fechamento, guardrail sem margem, lucro/prejuízo/PE com margem, totais da rede, isolamento).

### E5. Custos VARIÁVEIS por loja — cadeia completa da precificação (2026-07)

**Pergunta que originou (Fatia 1 de "fechar a precificação de ponta a ponta"):** o `gross_margin_percent` sozinho subestima o "lucro por loja" — ignora ralos proporcionais à venda (taxa de cartão/Pix, imposto sobre venda, embalagem, frete). O cálculo antigo tratava a margem bruta como se fosse margem líquida; qualquer loja com taxa de maquininha alta ficava com lucro empolado no painel.

Nova tabela `retail_store_variable_costs (organization_id, store_id, category, percent, fixed_per_sale)` com `UNIQUE(organization_id, store_id, category)`. Categorias: `card_fee|pix_fee|tax_sale|packaging|freight|other`. Cada categoria carrega **duas naturezas** simultâneas: `percent` (% do faturamento, ex.: imposto/taxa cartão %) e `fixed_per_sale` (R$ por ticket, ex.: embalagem R$ 1,50/venda). Upsert em lote (`setManyVariable`) da tela "Editar loja"; percent > 100 é clampeado; valor `<= 0` zera a natureza.

**Cadeia completa (E5a):**
```
Faturamento     = Σ fechamentos do mês (mesma régua da Ponte de Faturamento)
Margem BRUTA    = Faturamento × (margem bruta % / 100)
Custo Variável  = Faturamento × Σ(percent/100) + nº vendas × Σ(fixed_per_sale)
Margem CONTRIB. = Margem BRUTA − Custo Variável
MC% efetiva     = Margem CONTRIB. ÷ Faturamento
Resultado       = Margem CONTRIB. − custos fixos da loja
Ponto equilíb.  = custos fixos ÷ MC% efetiva
```

**Contagem de vendas do mês:** vem do PDV (`retail_pdv_sales` join por `filial = retail_stores.code`); fallback pra contagem de fechamentos aprovados quando não há PDV; `null` se nenhuma das duas fontes tem registro no mês. Sem contagem, `fixed_per_sale` é **ignorado** (não estimamos por cima quantas vendas ocorreram) — a UI marca a loja com um "⚠" e exibe aviso agregado. Os `percent` continuam valendo mesmo sem contagem (dependem só do faturamento).

**Compatibilidade E1–E4:** quando nenhum custo variável está cadastrado, `Custo Variável = 0`, `Margem CONTRIB. = Margem BRUTA`, `MC% = grossMarginPercent`, `PE = fixos ÷ (grossMargin/100)` — cálculo idêntico ao antigo. O teste `test:retail-store-result` (31 verificações) segue verde na íntegra.

**Superfície:**
- Serviço: `RetailStoreCostService` ganha `listVariable`, `setManyVariable`, `monthlySalesCount`; `storeResult`/`allStoresResult` expõem `vendasCount`, `custoVariavelTotal`, `margemBruta`, `margemContribuicao`, `margemContribuicaoPercent`, `variableCostsWarning`, `totals.custosVariaveis`.
- Rotas (`retail`): `GET/PUT /api/retailops/stores/:id/variable-costs` (mutação só owner/admin).
- UI: novo bloco "Custos variáveis desta loja" em "Editar loja" (dois inputs por categoria: % e R$/venda). Aba "Resultado por loja" ganha colunas **Margem bruta** e **Custos variáveis** entre Faturamento e Custos fixos; aviso agregado quando a parte por ticket foi ignorada.
- Teste: `test:retail-store-variable-costs` (33 verificações — upsert por categoria com duas naturezas, clamp 0..100, contagem PDV, fallback fechamentos, cadeia completa numérica, guardrail sem contagem, isolamento).

### E6. CMV REAL por loja — deriva do avg_cost das notas de compra (2026-07)

**Pergunta que originou (Fatia 2 de "fechar a precificação"):** o `gross_margin_percent` do E2 é um **chute** do gestor. Quando a operação já cadastra NF-e de entrada (`POST /api/products/invoice-scan/xml`), o app tem o **custo médio ponderado** dos produtos (`inventory_items.avg_cost`) — dá pra derivar o CMV DE VERDADE via `Σ (unidades vendidas no mês × avg_cost)` dos itens do PDV. Continuar chutando quando dá pra medir é desperdício.

**Método (E6a):** `RetailStoreCostService.monthlyCogsBreakdown(orgId, storeId, period)` cruza `retail_pdv_sale_items` (item a item do PDV, join por `retail_stores.code = filial`) com `inventory_items.avg_cost` do catálogo, usando a **mesma resolução produto→catálogo** do `/pdv-top-products` (`product_variants.external_ref/sku` → `products_services.external_ref` → LIKE-prefix pra tolerar EAN 13 vs 12 dígitos). Retorna `{source, coverage, cmvReal, revenueCovered, revenueTotalPdv}`.

**Fontes de CMV (`source`):**
- `real` — 100% dos itens vendidos têm `avg_cost` cadastrado (`coverage ≥ 0.999`). Extrapola `cmvReal / revenueTotalPdv` pro faturamento oficial dos fechamentos (regra de três, cobre a parte de fechamento manual sem item detalhado).
- `blended` — parte coberta. CMV = `cmvReal (parte coberta) + (uncoveredPdv + outsidePdv) × (1 − grossMargin/100)`. Fallback proporcional pro `gross_margin_percent` no que faltou. UI mostra `cmvWarning` com a % de cobertura.
- `estimate` — nenhum item PDV tem `avg_cost` OU não há PDV item a item. Cai integralmente no fallback do E2 (`grossMargin` × faturamento) — comportamento antigo preservado.

**Guardrail (E6b):** `blended` **só extrapola se `gross_margin_percent` estiver cadastrada** — sem ela, `margemBruta`/`resultado` continuam `NULL` (mesma regra do E2a). Nunca "chutamos" o CMV do que faltou sem consentimento explícito do gestor.

**Nada de tabela nova.** Cálculo on-the-fly usando `idx_retail_pdv_sale_items_prod` e `idx_inventory_org_product` (já existiam).

**Compatibilidade E1–E5:** loja sem PDV item a item → `source='estimate'` → cálculo idêntico ao PR anterior. Testes `test:retail-store-result` (31) e `test:retail-store-variable-costs` (33) seguem verdes.

**Superfície:**
- Serviço: novo `monthlyCogsBreakdown`; `storeResult` expõe `cmv`, `cmvBreakdown`, `cmvWarning`.
- UI: aba "Resultado por loja" ganha aviso agregado ("CMV real aplicado em N lojas") e badges por linha (`real`, `87%` para blended); tooltip em "Margem bruta" mostra a fonte usada.
- Teste: `test:retail-store-cmv-real` (25 verificações — REAL 100%, BLENDED 80% com fallback proporcional, FALLBACK puro, guardrail sem margem, regressão do PR anterior, isolamento).

**Nota operacional:** `AlterdataStockMapper` NÃO popula `avg_cost` hoje — quem só usa PDV via ERP fica em `source='estimate'`. Populando via NF-e de entrada (XML/foto → `invoice-scan`) a loja migra pra `real`/`blended` automaticamente na virada do próximo cálculo.

### E7. Tela "Precificar" no varejo (2026-07)

**Pergunta que originou (Fatia 3, última):** o motor `suggestSalePrice` (`src/server/pricing.ts`) e o `avg_cost` já existiam, mas faltava a TELA pra fechar o ciclo — o gestor precisava revisar produto a produto, ver custo × preço atual × sugestão e aplicar em lote. Sem isso, a Fatia 2 (CMV real) ficava só como "número no painel" — não virava ação.

**Serviço** `RetailPricingService`:
- `listProducts(orgId, {markup, period, limit})` — junta em uma tacada `products_services` (preço atual, min_price) × `inventory_items.avg_cost` × soma agregada de `retail_pdv_sale_items` do mês (mesma resolução produto→catálogo do E6/`/pdv-top-products`). Devolve por produto: `currentPrice`, `avgCost`, `suggestedPrice` (via `suggestSalePrice(cost, targetMarkup)`), `marginAmount`, `marginPercent`, `unitsSoldMonth`, `revenueMonth`, `stockQty`, `hasCost` e um **semáforo de risco** `riskLevel`:
  - `loss` — preço abaixo do custo (`marginAmount < 0`);
  - `thin` — margem < 10% (qualquer imposto/taxa da maquininha da Fatia 1 vira prejuízo);
  - `ok` — margem ≥ 10% ou sem custo (`hasCost=false`, nunca marcado como risco).
- `applyBulk(orgId, userId, items)` — batch de até 500 linhas em transação. Cada UPDATE gera registro em `ProductEditHistory` (ADR-033, versionamento). **Não aborta o batch por linha ruim** — linhas inválidas vão pra `skipped` com razão explícita: `missing_id | invalid_price | not_found | unchanged`. `unchanged` (diff < R$ 0,005) evita histórico ruidoso quando o gestor reaplica o mesmo preço.

**Markup default** vem de `storefront_settings.default_markup_percent` (o mesmo campo já usado pelo `suggestSalePrice` no `/api/products`). O `markup` do parâmetro sobrescreve (clamp 0–500). Consistência garantida: a sugestão da nova tela bate com a sugestão que já aparece no cadastro de produto por foto/XML da nota.

**Rotas:**
- `GET /api/retailops/pricing/products?markup=&period=&limit=` — leitura pra qualquer usuário do módulo `retail`.
- `POST /api/retailops/pricing/apply` — body `{items: [{productId, newPrice}]}`, só `owner`/`admin` (`requireRole`).

**UI:** nova aba **"Precificar"** no `RetailOpsView` (ícone `Tag`). Tabela com checkbox por linha, filtros `todos | risco | sem custo`, ajuste de markup pra simular ao vivo (recalcula sugestão pra tudo), badges de risco por linha (`perda` vermelho, `magra` amarelo, `sem custo` cinza), coluna Venda no mês (contexto pra priorizar quais revisar primeiro), botão "Aplicar sugerido nos selecionados". Confirmação `window.confirm` antes de aplicar em lote.

**Nada de tabela/migração nova.** Cálculo derivado de índices existentes (`idx_retail_pdv_sale_items_prod`, `idx_inventory_org_product`) + `storefront_settings` já criado.

**Teste:** `test:retail-pricing` (40 verificações — listProducts com semáforo (loss/thin/ok), produto sem custo (`hasCost=false`, suggested=0), markup do parâmetro sobrescreve default, clamp 0..500, ordenação por revenue DESC, applyBulk misto (aplicado + inválido + inexistente + unchanged + missing_id) atualizando o BD e o `product_edit_history`, isolamento multi-tenant).

**Ciclo fechado — as 3 fatias juntas:**
1. Custos variáveis (E5) — o que a venda perde além do CMV.
2. CMV real (E6) — quanto de fato custou a mercadoria (via `avg_cost` das notas).
3. Precificar (E7) — a tela que fecha: revisar preços com base no custo real, semáforo pra "vazamentos" e aplicação em lote com histórico.

## Fase G2 — Corrida de comissão (modelo CARIOCA) + escala semanal (2026-08)

**Origem:** o dono da rede mandou a planilha "CARIOCA AGOSTO 26" (corrida do
mês) + as fotos da folha de fechamento diária e do quadro de escala. Pedido:
implementar o padrão de comissão dos vendedores E o padrão de escala por loja,
na aba Comissão da Operação da Rede. A Fase G já tinha o motor genérico
(percent/fixed/quota_bonus/tiered) — o que faltava era o modelo da CORRIDA:
prêmios condicionados ao atingimento da cota INDIVIDUAL, corrida semanal por
ranking, P.A e desvio de cota da rede.

**Regras implementadas (default = números da planilha, tudo editável na UI):**

- **Vendedor mensal:** faixas NÃO cumulativas sobre a própria venda — bateu a
  cota 1%, +10% 1,5%, +20% 2%, +30% 3% (vale a MAIOR); P.A (peças ÷
  atendimentos) ≥ 2,50 com cota batida → R$ 50.
- **Vendedor semanal:** 1º do ranking da loja COM cota batida → faixa sobre a
  venda da semana (1% / +20% 2% / +30% 3%) + P.A R$ 30; 2º com cota → 0,5%.
- **Desvio de cota da REDE (mensal):** 1º/2º maiores desvios entre vendedores
  com cota batida → R$ 250 / R$ 100. O ranking SEMPRE considera todas as
  lojas, mesmo filtrando a visualização por uma.
- **Gerente:** 1% sobre a venda da loja COM OU SEM cota (faixa `min:0`);
  faixas maiores (+10% 1,5% etc.) e P.A da loja só com cota; faixas sobre a
  venda própria (+15% 1,5%...); corrida semanal da loja (1% / +30% 2%);
  desvio entre lojas → R$ 300 / R$ 150.
- **"Só recebe quem trabalhou o mês inteiro"** NÃO é automático (RN-G2-004):
  a apuração expõe dias escalados/folgas da escala e o gestor decide na
  aprovação — o sistema não mede ausência real.

**Decisões (RN-G2-00x no header do service):**

1. **Derivado por query, nunca contador** (RN-G2-001) — `raceMonth` é só
   leitura; persistir = `createRaceRun` gera RUN **draft** da Fase G
   (`retail_commission_runs/items`, `rule_id NULL`, detalhamento no JSON) e a
   aprovação segue humana (D7).
2. **Cota individual por semana** (RN-G2-002): `retail_seller_quotas`
   (org, loja, seller_key, week_start). SEM cadastro, deriva da ESCALA: cota
   diária da loja ÷ nº de escalados 'work' no dia — exatamente o "COTA ÷ 4 =
   575" da folha de fechamento. Sem nenhuma das duas → `quotaSource:'none'` e
   nenhum prêmio condicionado à cota (a UI marca em âmbar pro gestor corrigir).
3. **Semana fecha no sábado** (RN-G2-003): começo de mês quebrado < 4 dias
   cola na semana seguinte (o "01/08 até 08/08" da planilha); ≥ 4 dias vira
   semana própria.
4. **P.A** (RN-G2-005): atendimentos = aditivo `retail_seller_sales.atendimentos`
   (o AT da folha, lançado à mão ou lido por foto — prompt da IA atualizado) +
   atendimentos ENCERRADOS do Retail Floor (ADR-150) quando a loja usa a
   lista da vez. Merge por aliases (user:/mat:/nom:) tomando o MÁXIMO entre
   aliases (nunca soma, que contaria em dobro).
5. **Plano por loja:** `retail_commission_plans` (config_json; `store_id='*'`
   = rede) — loja específica > rede > default CARIOCA hardcoded
   (`DEFAULT_RACE_PLAN`). Editor na UI com as faixas e valores.
6. **Escala é planejamento, não documento:** `retail_schedule_entries`
   (org, loja, data, seller_key, work|off) pode ser regravada ao editar a
   semana — sem retenção de documento (diferente de fechamento/prontuário).

**Entidades novas:** `retail_commission_plans`, `retail_seller_quotas`,
`retail_schedule_entries` + aditivo `retail_seller_sales.atendimentos`.

**Rotas** (em `/api/retailops`): `GET/PUT /commission/plan`,
`GET /commission/race?month=`, `POST /commission/race/run`,
`GET/PUT /schedule` + `POST /schedule/copy-week`, `GET/PUT /seller-quotas`;
`POST/PATCH /seller-sales` aceitam `atendimentos`. Escritas owner/admin.

**UI:** aba **Comissão** ganhou a seção "Corrida do mês" (apuração por loja:
tabela mensal por vendedor com cota/fonte, atingimento, faixa, P.A, semanal,
desvio e total; bloco do gerente; corrida semana a semana; ranking de desvio
da rede; botão "Gerar prévia p/ aprovação"; modal "Configurar corrida" com
editor de faixas). Nova aba **"Escala & cotas"**: grade semanal dia ×
vendedor (trabalha/folga/vazio, contagem de escalados por dia, copiar semana
anterior) + grade de cotas semanais por vendedor nas semanas da corrida.

**Teste:** `test:retail-commission-race` (46 verificações — semanas/colagem,
faixas não cumulativas, P.A com/sem cota, ranking semanal 1º/2º e razões de
não-prêmio, desvio da rede com filtro por loja, gerente com/sem cota da loja,
cota derivada da escala, precedência do plano por loja, run draft com
detalhamento, audit, isolamento multi-tenant).
