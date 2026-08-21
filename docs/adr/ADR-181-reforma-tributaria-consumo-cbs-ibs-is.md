# ADR-181 — Prontidão para a Reforma Tributária do Consumo (CBS / IBS / IS)

**Estado:** **F0 MERGEADA (PR #1264)** · **F1 MERGEADA (PR #1265)** · **F2 MERGEADA (PR #1266)**
· **F3 MERGEADA (PR #1267)** · **F4 MERGEADA (PR #1268)** · **F5 MERGEADA (PR #1269)** · **F6
MERGEADA (PR #1270)** · **F7 MERGEADA (PR #1271)** · **F8 MERGEADA (PR #1272)** · **F8b EM PR**
— UI (FECHA o ADR-181).
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
- **F4 — Wiring nos documentos (EM PR).** `FiscalDocumentBreakdownService` — camada fina/
  reutilizável sobre o motor (F3) que produz um BLOCO serializável (`fiscal_breakdown_v1`, em
  centavos) pronto pra CONGELAR no snapshot de qualquer documento + `renderLines` pro PDF.
  Honesto: perfil incompleto → `applicable:false`; tributo sem alíquota → `unknownTributes`
  (nunca R$ 0). Wired no `ClinicReceiptService.issue` (coluna aditiva
  `clinical_receipts.fiscal_breakdown_snapshot`): o bloco congela junto do snapshot canônico
  (convenção nº 3 — recurar alíquota depois NÃO muda o recibo emitido) + bloco informativo no
  PDF. Best-effort (nunca bloqueia a emissão). `test:fiscal-document-breakdown` (17);
  `test:clinic-receipt` segue 65/65.
- **F5 — Advisor do Simples híbrido (EM PR).** `SimplesHybridAdvisorService.advise` — só pro
  Simples (mei/presumido/real → `not_simples`); expõe os fatores ESTRUTURAIS dos dois caminhos
  (DAS simples-sem-crédito × regime regular por-fora-com-crédito, LC 214 art. 47 §9), reflete a
  escolha atual, aterra UM sinal real (`hasCreditableInputs` via `payables`) e é HONESTO sobre
  o que NÃO sabe (`clientMixKnown:false` — mix PJ×consumidor). **NUNCA recomenda um lado nem
  força** (RN-FISCAL-9); disclaimer cravado. `setChoice` só PERSISTE a decisão do dono (delega
  ao `FiscalProfileService`; só Simples). Rotas owner/admin `GET /api/fiscal/simples-advisor` +
  `POST /simples-advisor/choice`. `test:simples-hybrid-advisor` (17).
- **F6 — Scaffold honesto de emissão (EM PR).** `FiscalIssuanceService` (molde
  `SicrediCobrancaService`/ADR-177): tabela `fiscal_issuance_connections` (config CIFRADA
  AES-GCM, opt-in, UNIQUE(org)); `status`/`configure`/`disconnect`/`issue`. NUNCA marca
  `connected` sem homologação (RN-FISCAL-8 — certificado A1 + prefeitura/SEFAZ ou provedor
  homologado); com credencial → `awaiting_homologation`; capacidades (nfse/nfce/cancel/query)
  DESCOBERTAS indisponíveis; segredo cifrado/redigido (nunca volta no status); `issue` LANÇA
  `fiscal_awaiting_homologation`/`fiscal_not_configured` — nunca finge emitir nota nem inventa
  número. Rotas owner/admin `/api/fiscal/issuance/{status,config,disconnect,issue}`.
  `test:fiscal-issuance-scaffold` (16).
- **F7 — Integração DRE/financeiro (EM PR).** `FiscalDreProjectionService.project(orgId,
  period)` — projeta CBS/IBS sobre a receita líquida do período (via `ManagerialDreService` +
  motor F3) como bloco READ-ONLY. Resolve a dupla contagem ESTRUTURALMENTE: a projeção NUNCA é
  somada no `sobra` da DRE, então jamais duplica o `tax_sale`. Tratamento pelo regime:
  Simples/MEI (das_embedded) → `informative_embedded` (já no DAS; se usa `tax_sale`, avisa que é
  o mesmo ônus, não some); regime regular → `operating_expense`. Honesto: sem regime →
  indisponível; alíquota não curada → amount null. Rota owner/admin `GET
  /api/fiscal/dre-projection`. `test:fiscal-dre-integration` (13).
- **F8 — Hardening + runbook (EM PR; FECHA o backend).** `test:fiscal-hardening` (18) —
  doc-of-record executável: (A) codifica RN-FISCAL-1..10 como regressão sobre os serviços reais
  F1–F7 (nunca inventa · reviewedBy obrigatório · date-effective · honesto sem dado · base
  GLOBAL sem org · não emite sem homologação · Simples default DAS · sem dupla contagem) + (B)
  verifica fiação (rota montada, 8 testes wired, runbook/ADR presentes) + runbook
  `docs/runbook/fiscal-reforma-operacao.md`.
- **F8b (UI-only) — EM PR; FECHA o ADR-181.** `FiscalProfilePanel` (nova aba **Fiscal** em
  `SettingsView`, owner/admin): perfil (regime/inscrições/município IBGE) + `completeness` +
  advisor DAS×regime-regular (marca a escolha) + simulador de tributos de uma venda (honesto —
  "aguardando alíquota" quando não curada). `TaxRateCurationPanel` (em `AdminMasterView`,
  master): publica/lista/arquiva alíquotas date-effective (molde `LaborLawCurationPanel`).
  UI-only sobre as rotas testadas F1–F7; tsc+build verdes.

**Critério de sucesso:** com a base curada carregada da resolução oficial e o perfil da org
preenchido, o ZapFlow **computa e mostra** CBS/IBS/IS corretos pela **data do fato gerador**,
por regime, sem inventar nada — pronto para a virada de fase sem retrabalho de código.
