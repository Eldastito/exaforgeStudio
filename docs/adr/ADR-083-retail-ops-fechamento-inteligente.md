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
