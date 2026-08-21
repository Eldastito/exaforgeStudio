# ADR-181 — Prontidão para a Reforma Tributária do Consumo (CBS / IBS / IS)

**Estado:** **F0 MERGEADA (PR #1264)** · **F1 MERGEADA (PR #1265)** · **F2 MERGEADA (PR #1266)**
· **F3 EM PR** — Motor `ConsumptionTaxService`. Fatias seguintes fatia-por-PR.
**Data:** 2026-08-21.
**Contexto legal:** EC 132/2023 + **LC 214/2025** (regulamentação). Substitui a ADR-nada
(fiscal era **greenfield** — ver auditoria abaixo). Aditivo/reversível, opt-in por org.
**Convenções herdadas:** isolamento multi-tenant, CREATE-then-ALTER estrito, feature flags
opt-in, `business_signals` (nunca tabela de alerta paralela), determinístico antes de LLM.

---

## 1. Por que agora

A Reforma Tributária do Consumo entra em vigor de forma **faseada** e o primeiro degrau já
é agora. O dono pediu que o ZapFlow esteja **pronto para a virada do ano**, aplicando as
regras novas sem retrabalho manual. Como quase todos os tenants são **MEI / Simples
Nacional** de varejo, clínica, beleza e petshop, a mudança os atinge diretamente.

### 1.1. O que a reforma cria (aterrado nas fontes)

| Novo tributo | Esfera | Substitui | Papel |
| --- | --- | --- | --- |
| **CBS** — Contribuição sobre Bens e Serviços | Federal | **PIS + COFINS** | IVA federal |
| **IBS** — Imposto sobre Bens e Serviços | Estadual + Municipal | **ICMS + ISS** | IVA subnacional |
| **IS** — Imposto Seletivo ("imposto do pecado") | Federal | — (novo) | sobretaxa a bens nocivos à saúde/meio ambiente |

### 1.2. Cronograma de transição (o eixo que o motor precisa respeitar)

- **2026 — ano-teste.** Cobrança-teste de **CBS 0,9% + IBS 0,1%**, com **destaque em
  documento fiscal**; o valor-teste é **compensável com PIS/COFINS** (efeito de caixa ~zero,
  mas exige o cálculo e o destaque).
- **2027.** **PIS e COFINS extintos** → **CBS em alíquota cheia** (percentual **fixado por
  resolução do Senado prevista para dez/2026 — AINDA NÃO DEFINIDO**). **IS começa.** IBS
  segue em **0,1%** (com CBS reduzida em 0,1 p.p. em 2027–2028).
- **2029–2032.** ICMS e ISS caem **10% ao ano**; IBS sobe gradual para compensar.
- **2033.** Sistema novo **pleno**; ICMS/ISS/PIS/COFINS extintos.

### 1.3. Simples Nacional e MEI (a maioria dos nossos tenants)

- O **Simples foi mantido** (a **guia única DAS continua**), mas a LC 214/2025 inseriu a
  lógica de IBS/CBS dentro dele.
- **Decisão inédita a partir de 2027:** recolher IBS/CBS **dentro do DAS** (default,
  simplificado) **ou** migrar para o **regime híbrido** — recolher IBS/CBS **por fora**, pelo
  regime regular. Só no híbrido a empresa **gera e aproveita crédito** de CBS/IBS (LC 214,
  art. 47 §9º: optante do Simples **não** se apropria de crédito sem optar pelo regime
  regular) e acessa benefícios (ex.: alíquota zero de cesta básica).
- **MEI:** dentro do DAS, a LC 214 sugere **0,9% CBS + 0,1% IBS** além do INSS obrigatório.

> **Fontes** (WebSearch; o portal oficial `consumo.tributos.gov.br` e a maioria dos domínios
> de conteúdo estão bloqueados pelo egress da sessão — política da org, não contornável):
> Serasa Experian (cronograma), Contábeis, CRCSP, e-Auditoria / eSimples / SEFAZ-RO / SEFAZ-CE
> (Simples híbrido). **As alíquotas efetivas de 2027+ NÃO estão fixadas** — dependem de
> resolução do Senado. Isso é a restrição de design nº 1 (§4).

---

## 2. Auditoria do estado atual (3 varreduras, evidência file:line)

### 2.1. Fiscal / emissão = **GREENFIELD** (não existe)

- Zero `FiscalService` / `NotaFiscal*` / provedor (Focus, eNotas, PlugNotas, NFe.io).
- Só existe **entrada**: `nfeParser.ts:33` (parse de XML de NF-e de **fornecedor** p/ estoque)
  e `nfeSignature.ts:34` (verifica assinatura **localmente**; o header `:14-20` declara que
  NÃO consulta SEFAZ porque exige certificado da org — infra inexistente).
- Campos tributários **pontuais e sem regra**: `clinic_professional_relationships.
  tax_withholding_percent` (`db.ts:10278`, retenção de repasse) e `retail_store_variable_costs`
  categoria `tax_sale` (`db.ts:6531`, um **%** que o lojista digita só p/ margem — não apura
  Simples, não gera guia).
- Dados fiscais da org mínimos: `organization_settings.comigo_cnpj` + `comigo_formalization`
  (`mei`/`empresa`/`informal`, `ComigoGraduationService.ts:81`). **Sem regime detalhado, sem
  inscrição municipal/estadual, sem certificado A1 fiscal** (o A1 existente é só de TISS).
- Documentos com snapshot canônico (recibo `ClinicReceiptService`, atestado, guia TISS) são
  **probatórios, NÃO fiscais** — não têm número de nota, não vão à prefeitura.

### 2.2. Financeiro / DRE = **maduro** (reaproveitável, não é alvo desta ADR)

`ManagerialDreService` (DRE gerencial org-wide, ADR-128), `FinancialLedgerService` (contas a
pagar/receber + caixa), `CashForecastService` (13 semanas), `BusinessHealthService` +
`ExecutiveAdvisorService` (camada executiva read-only). **Ponto de conexão futuro:** quando
CBS/IBS forem efetivos, entram como tributo na DRE (F7) — sem dupla contagem com `tax_sale`.

### 2.3. Cobrança / pagamento = **real** (ASAAS/Mercado Pago/Stone chamam API; Sicredi é
scaffold honesto `awaiting_homologation`). **Molde de scaffold honesto = ADR-177.**

---

## 3. Escopo — PRONTIDÃO, não emissão fiscal

O que é **buildável agora** e entrega a prontidão pedida ("na virada, já aplica"):

1. **Perfil Fiscal da org** — CNPJ, regime (MEI / Simples / Simples-híbrido / Presumido /
   Real), inscrições municipal/estadual, município+UF (código IBGE p/ IBS), opção pelo
   regime regular. Honesto: perfil incompleto → não calcula, avisa.
2. **Base de Referência Tributária curada** — alíquotas **date-effective por fase**
   (CBS/IBS/IS, vigência início/fim, fonte, `reviewed_by`), **GLOBAL, master-only, NASCE
   VAZIA** (molde `labor_law_entries`/ADR-178). O ZapFlow **nunca inventa alíquota**; carrega
   da resolução oficial quando publicada.
3. **Motor de cálculo determinístico** — dado (base, data do fato gerador, tipo de item,
   perfil), devolve o breakdown CBS/IBS/IS **da fase vigente naquela data**, respeitando
   Simples-DAS × regime regular. Determinístico (roda em CI), honesto quando falta base.
4. **Wiring nos documentos existentes** — mostrar o breakdown (informativo no ano-teste) no
   recibo/pedido, congelado no snapshot canônico.
5. **Emissão fiscal (NFS-e/NFC-e) = scaffold honesto/DEFERIDO** — depende de certificado A1 +
   SEFAZ/prefeitura (homologação de terceiro). Molde Sicredi (ADR-177): estado observável,
   `issue` LANÇA `fiscal_awaiting_homologation`, **nunca finge emitir**.

**Fora de escopo (agora):** emissão fiscal real; apuração/geração de DAS; SPED; crédito
tributário automático B2B; imposto sobre importação. Ficam como tracks futuros.

---

## 4. Guardrails RN-FISCAL (duros — no header dos services + testados em hardening)

1. **Nunca inventa alíquota nem regra.** Todo número vem da **base curada** (§3.2). Sem
   entrada vigente p/ a data → **honesto** (`no_rate_for_period`), nunca um palpite.
2. **Base nasce vazia + `reviewed_by` obrigatório** (molde ADR-178). Curadoria master-only.
3. **Date-effective.** A fase/alíquota valem pela **data do fato gerador**, não pela data de
   hoje — o motor consulta a vigência. (Cronograma muda por resolução; é configurável.)
4. **Honesto quando falta dado.** Perfil fiscal incompleto → não calcula, sinaliza o que
   falta. `null ≠ 0` (imposto desconhecido nunca vira zero).
5. **Determinístico antes de LLM.** O cálculo é aritmética pura sobre a base; LLM só explica.
6. **Isolamento multi-tenant.** Perfil e cálculo por `organization_id`. Base de referência é
   GLOBAL (lei é igual p/ todos) e **sem dado de tenant**.
7. **Dinheiro/imposto role-gated** (§73) — valores de tributo owner/admin.
8. **Não emite documento fiscal sem homologação** — emissão é scaffold que LANÇA (§3.5).
9. **Simples default = DAS.** O sistema **nunca força** o regime híbrido; a opção é uma
   **decisão informada do dono** (advisory na F5), gravada explicitamente no perfil.
10. **LC 214 é referência viva.** Mudanças (resolução do Senado, ajustes) entram pela base
    curada e por novas vigências — **sem alterar código de regra**.

---

## 5. Reuso vs. novo

- **Reusar:** padrão de base curada nasce-vazia + `reviewed_by` (`labor_law_entries`,
  ADR-178); scaffold honesto `awaiting_homologation` (`SicrediCobrancaService`, ADR-177);
  `organization_settings` fiscais (`comigo_cnpj`, `comigo_formalization`); snapshot canônico
  dos documentos (recibo/pedido) p/ congelar o breakdown; painel de curadoria master
  (`AdminMasterView`, molde `LaborLawCurationPanel`); `EntitlementService`/RBAC (role-gate);
  `business_signals` (avisos, ex.: "perfil fiscal incompleto p/ 2027").
- **Estender:** `ManagerialDreService`/`FinancialLedgerService` (F7, quando efetivo);
  os documentos existentes (F4).
- **Criar (aditivo, mínimo):** `FiscalProfileService` + colunas fiscais em
  `organization_settings`; `tax_reference_rates` (GLOBAL curada) + `TaxReferenceService`;
  `ConsumptionTaxService` (motor determinístico); scaffold `FiscalIssuanceService`.

---

## 6. Plano por fatias (fatia = 1 PR draft, com flag/teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — Perfil Fiscal da org (EM PR).** 6 colunas aditivas em `organization_settings`
  (`fiscal_regime`, `fiscal_regime_regular_optin` default 0, inscrição municipal/estadual,
  `fiscal_municipality_ibge`+nome) + `FiscalProfileService` (`get`/`save` só-patch/`completeness`
  derivado RN-004). Nada presumido (regime null sem declarar — RN-FISCAL-4); híbrido só liga
  no Simples (RN-FISCAL-9); CNPJ reflete `comigo_cnpj` (fonte única); UF reflete
  `address_state`. Rotas owner/admin `GET/PUT /api/fiscal/profile`. `test:fiscal-profile` (23).
- **F2 — Base de Referência Tributária curada (EM PR).** Tabela GLOBAL `tax_reference_rates`
  (sem `organization_id`) date-effective — tributo (cbs/ibs/is), fase, alíquota, `applies_to`
  (null=geral | mei | simples_das…), vigência `effective_from`..`effective_to`, fonte,
  `reviewed_by` obrigatório, status published/archived. **NASCE VAZIA** (molde ADR-178);
  curadoria master-only. `TaxReferenceService.curate`/`list`/`archive`/`status` +
  `rateFor(tributo, date, {appliesTo})` — retorna a alíquota vigente **na data do fato
  gerador** com precedência de recorte (específico > geral, vigência mais recente); **sem
  entrada → `null`** (RN-FISCAL-1, nunca inventa). Rotas master-only `/api/fiscal/reference/*`.
  `test:tax-reference` (27).
- **F3 — Motor de cálculo `ConsumptionTaxService` (EM PR).** `compute(orgId, {baseValue,
  date, itemType, selective})` → breakdown CBS/IBS/IS da fase vigente (via `rateFor`) × perfil.
  O regime decide recorte+modo+crédito: MEI→`mei`/DAS/sem-crédito, Simples→`simples_das`/DAS/
  sem-crédito, híbrido & Presumido/Real→`geral`/por-fora/gera-crédito (LC 214 art. 47 §9).
  Determinístico (aritmética pura). Honesto: sem regime → `profile_incomplete` (não calcula,
  RN-FISCAL-4); tributo sem alíquota vigente → `unknown` (amount **null**, nunca 0 —
  RN-FISCAL-1); `partial` sinaliza breakdown incompleto. IS só em item **seletivo** explícito
  (não presume). Rota owner/admin `POST /api/fiscal/compute` (dinheiro role-gated §73).
  `test:consumption-tax` (24).
- **F4 — Wiring nos documentos.** Breakdown informativo no recibo/pedido, congelado no
  snapshot. `test:fiscal-document-breakdown`.
- **F5 — Advisor do Simples híbrido.** Comparação informativa DAS × regime regular (grounded,
  nunca decide/força — RN-FISCAL-9), grava a opção no perfil. `test:simples-hybrid-advisor`.
- **F6 — Scaffold honesto de emissão** (`FiscalIssuanceService`, molde Sicredi/ADR-177):
  estado observável, `issue` LANÇA `fiscal_awaiting_homologation`. `test:fiscal-issuance-scaffold`.
- **F7 — Integração DRE/financeiro** (quando efetivo): CBS/IBS como tributo na DRE gerencial,
  reconciliado com `tax_sale` (sem dupla contagem). `test:fiscal-dre-integration`.
- **F8 — Hardening + runbook.** `test:fiscal-hardening` codifica RN-FISCAL-1..10 como
  regressão + runbook `docs/runbook/fiscal-reforma-operacao.md`.
- **UI:** perfil fiscal (owner/admin) + painel de curadoria de alíquotas (master).

**Critério de sucesso:** com a base curada carregada da resolução oficial e o perfil da org
preenchido, o ZapFlow **computa e mostra** CBS/IBS/IS corretos pela **data do fato gerador**,
por regime, sem inventar nada — pronto para a virada de fase sem retrabalho de código.
