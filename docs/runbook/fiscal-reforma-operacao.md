# Runbook — Prontidão Fiscal / Reforma Tributária do Consumo (CBS/IBS/IS)

ADR-181. Como operar a camada de prontidão fiscal do ZapFlow: perfil fiscal, base de
referência curada, motor de cálculo, breakdown nos documentos, advisor do Simples híbrido,
scaffold de emissão e projeção na DRE. **Escopo: prontidão — não emissão** (emissão real de
NFS-e/NFC-e depende de certificado A1 + prefeitura/SEFAZ; hoje é scaffold honesto).

## Mapa dos serviços

| Fatia | Serviço | Papel |
| --- | --- | --- |
| F1 | `FiscalProfileService` | Perfil fiscal da org (regime, inscrições, município IBGE, opção regime regular). |
| F2 | `TaxReferenceService` | Base de alíquotas CURADA (GLOBAL, date-effective, nasce vazia, master-only). |
| F3 | `ConsumptionTaxService` | Motor determinístico: breakdown CBS/IBS/IS por fase × regime. |
| F4 | `FiscalDocumentBreakdownService` | Bloco serializável do breakdown, congelado no snapshot do documento. |
| F5 | `SimplesHybridAdvisorService` | Advisor DAS × regime regular (informativo, nunca força). |
| F6 | `FiscalIssuanceService` | Scaffold honesto de emissão NFS-e/NFC-e (`awaiting_homologation`). |
| F7 | `FiscalDreProjectionService` | Projeção CBS/IBS na DRE gerencial (read-only, sem dupla contagem). |

## Rotas (`/api/fiscal/*`)

- `GET/PUT /profile` — perfil fiscal (owner/admin).
- `GET /reference/status` · `GET /reference/rates` · `POST /reference/curate` · `POST /reference/rates/:id/archive` — base de alíquotas (**master-only**).
- `POST /compute` — cálculo CBS/IBS/IS de um valor (owner/admin; dinheiro role-gated).
- `GET /simples-advisor` · `POST /simples-advisor/choice` — advisor híbrido (owner/admin).
- `GET /issuance/status` · `PUT /issuance/config` · `POST /issuance/disconnect` · `POST /issuance/issue` — emissão (owner/admin; `issue` responde 422 até homologar).
- `GET /dre-projection` — projeção na DRE (owner/admin).

## Fluxo de ativação (por org)

1. **Master** cura as alíquotas oficiais em `POST /reference/curate` (fonte: resolução do
   Senado / portal `consumo.tributos.gov.br`). Cada entrada exige `reviewedBy`. **A base nasce
   vazia — sem curadoria, o sistema não calcula nada** (não inventa).
2. **Dono** preenche o perfil fiscal (`PUT /profile`): regime, município (código IBGE), UF.
   Sem regime, o motor não calcula (honesto).
3. A partir daí: `POST /compute` calcula; recibos emitidos congelam o breakdown; a DRE ganha a
   projeção informativa; o advisor ajuda na decisão DAS × regime regular.

## Como curar as alíquotas na virada de fase (2026 → 2027 → …)

Quando o governo publicar novas alíquotas (ex.: CBS cheia de 2027, fixada por resolução em
dez/2026), **não é preciso mexer no código**: o master publica uma nova entrada com a nova
`effective_from`. O `rateFor` passa a usar a nova alíquota pela data do fato gerador
automaticamente (RN-FISCAL-10). Alíquota antiga: `archive` (preserva histórico) ou deixe com
`effective_to` fechado.

Exemplo (fase-teste 2026, valores de referência da LC 214):
- CBS `teste_2026` 0,9% · vigência `2026-01-01`..`2026-12-31`.
- IBS `teste_2026` 0,1% · vigência `2026-01-01`..`2026-12-31`.
- MEI no DAS: cure com `appliesTo: "mei"` (0,9% CBS + 0,1% IBS).

## Guardrails RN-FISCAL (o que o sistema NUNCA faz)

1. Nunca inventa alíquota — sem entrada curada vigente → `null` (`no_rate_for_period`).
2. Base nasce vazia; toda entrada exige `reviewed_by`.
3. Date-effective: a alíquota vale pela **data do fato gerador**.
4. Honesto quando falta dado: sem regime → não calcula; `null ≠ 0`.
5. Determinístico antes de LLM (o cálculo é aritmética pura sobre a base curada).
6. Isolamento: base de referência é GLOBAL e **sem** dado de tenant; perfil/cálculo por org.
7. Dinheiro/imposto role-gated (owner/admin).
8. Não emite documento fiscal sem homologação — `issue` LANÇA.
9. Simples default = DAS; o sistema nunca força o regime híbrido (é decisão do dono).
10. LC 214 é referência viva: mudança entra pela base curada, sem alterar código.

## Emissão fiscal (o que falta para "ligar")

`FiscalIssuanceService` está pronto para receber a integração real. Para emitir de verdade
faltam (terceiro): **certificado digital A1** da org + integração homologada com a
**prefeitura** (NFS-e) ou **SEFAZ** (NFC-e), ou um **provedor homologado** (Focus NFe / eNotas
/ PlugNotas / NFe.io). Enquanto isso não chega, o estado fica `awaiting_homologation` e `issue`
LANÇA — nunca finge emitir.

## Troubleshooting

- **`/compute` volta `profile_incomplete`** → o dono não declarou o `regime` no perfil.
- **Breakdown com `unknownTributes`** → não há alíquota curada vigente para aquela data/tributo
  (cure a fase no painel master). É honesto, não é bug.
- **Projeção na DRE não muda o resultado** → correto e proposital: é read-only, para não
  duplicar o `tax_sale` (RN sem dupla contagem).
- **`issue` retorna 422 `fiscal_awaiting_homologation`** → esperado: emissão real depende de
  homologação de terceiro (ver acima).

## Testes (regressão)

`test:fiscal-profile` (23) · `test:tax-reference` (27) · `test:consumption-tax` (24) ·
`test:fiscal-document-breakdown` (17) · `test:simples-hybrid-advisor` (17) ·
`test:fiscal-issuance-scaffold` (16) · `test:fiscal-dre-integration` (13) ·
`test:fiscal-hardening` (RN-FISCAL-1..10 + fiação de produção).
