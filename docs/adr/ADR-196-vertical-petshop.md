# ADR-196 — Vertical Petshop / Veterinário

**Estado:** F0 — **composição fechada em `verticals.ts` desde o commit inicial da vertical** (preset selecionável no onboarding + módulos ligados). F1+ (terminologia pet/tutor, campos pet-específicos como espécie/raça/carteira de vacina, plano de saúde pet) fica pra fatias seguintes. Este ADR consolida a decisão retrospectivamente pra fechar o `blocked_reason: "Sem ADR próprio nem PRD dedicado — composição implícita"` do `PETSHOP` no Product Evolution Ledger.
**Data:** 2026-08-28.
**Natureza:** vertical de 1ª classe que **COMPÕE** módulos existentes (VAREJO + CLÍNICA + SERVIÇOS), sem motor novo. Precedente do padrão que ADR-191 (Advocacia) formaliza depois; ADR-196 codifica o Petshop como o **exemplo original de composição vertical**.
Convenções herdadas: isolamento por org, CREATE-then-ALTER estrito em `db.ts`, opt-in por preset da vertical, aditivo/reversível, `business_signals` (nunca alerta paralelo), CEO Operating Layer horizontal (ADR-190), LGPD via `LgpdService`.

---

## 1. Auditoria — o que já existe (matriz compõe × novo)

Reconhecimento sobre `src/server/verticals.ts` + módulos correlatos. **Veredito: composição pura.** Nenhuma engenharia nova nesta fatia.

| # | Necessidade petshop | Reuso | Veredito |
| --- | --- | --- | --- |
| 1 | Config da vertical | `verticals.ts:178` (`key: "petshop"`, ícone 🐾, descrição, `modules`, `saleMode: "unit"`) + `CONSENT_BY_VERTICAL["petshop"]` | **COMPÕE** — preset já plugado |
| 2 | Cliente (tutor) | `contacts` (sujeito universal) | **COMPÕE** (terminologia "tutor" vira relabel em fatia seguinte) |
| 3 | Pet | `contacts` estendido em fatia futura com metadados pet-específicos (espécie/raça/idade/vacinas). Alternativa: nova tabela `pets` referenciando `contact_id` | **FUTURA** |
| 4 | Produtos (ração, brinquedo, medicamento OTC) | `products_services` + módulo `catalogo` + `vendas` + `loja` + `pagamentos` + `compras` | **COMPÕE** |
| 5 | Serviços (banho & tosa, hospedagem) | `products_services` + `agenda` + `areas` (vários banheiros/salas) | **COMPÕE** |
| 6 | Consulta veterinária | módulo `clinica` (`ClinicProfessional*`, `ClinicSpecialty*`, `ClinicCareEpisode*`, `ClinicDocuments*`, `ClinicAgendaService`, `ClinicPetService`, `ClinicPetCareService`, `ClinicPetHistoryService`) | **COMPÕE** — motor clínico funciona pra medicina veterinária tal como pra clínica humana |
| 7 | Cirurgia / internação | mesmo motor `clinica` + `appointments` de longa duração + `ClinicCareEpisode` longitudinal | **COMPÕE** |
| 8 | Plano de saúde pet | módulo `assinaturas` (`SubscriptionService`) + `receivables` | **COMPÕE** |
| 9 | Retorno de vacina / vermífugo | módulo `cadencias` (`CadenceService`) + agenda | **COMPÕE** — schedule por tipo de pet vira uma fatia seguinte |
| 10 | Prontuário do pet | `ClinicCareEpisode` + `ClinicDocuments` (draft→issued, SHA-256, PIN, PDF) | **COMPÕE** |
| 11 | Terminologia pet/tutor × paciente/responsável | `src/lib/clinicTerms.ts` já é o padrão (pet/tutor coexiste com paciente/responsável no dicionário) | **COMPÕE o padrão** |

## 2. Decisões (D1–D6)

- **D1 — Vertical COMPÕE**. Nada de motor novo enquanto a composição
  atual atende. VAREJO cobre produtos/estoque/loja; CLÍNICA cobre a
  parte veterinária (prontuário, agenda profissional, documentos com
  assinatura por PIN); SERVIÇOS cobre banho & tosa via `agenda +
  areas`; `assinaturas` + `cadencias` cobrem plano de saúde pet e
  lembretes de vacina/vermífugo.
- **D2 — Terminologia é relabel, não schema**. Pet/tutor vs
  paciente/responsável já convive em `clinicTerms.ts`. Adaptação de
  labels em UI/mensagens é fatia seguinte e não requer migração.
- **D3 — Campos pet-específicos (espécie/raça/vacinas) ficam pra
  F1+**. Decisão futura: estender `contacts` com colunas opcionais
  (aditivo, LGPD OK — `dados_pessoais`) ou criar tabela `pets`
  referenciando `contact_id` (pet != tutor; mesmo tutor pode ter
  múltiplos pets). Padrão do repo favorece a extensão de tabela
  existente quando o cardinality é 1:1 dominante — mas Petshop tem
  1:N (um tutor, muitos pets), então uma tabela `pets` dedicada é o
  design provável. Fora do escopo deste ADR.
- **D4 — Sem gate de plano específico**. Petshop usa os mesmos módulos
  já cobertos pelos planos existentes (`modules: [catalogo, vendas,
  loja, pagamentos, compras, agenda, clinica, areas, cadencias,
  assinaturas, campanhas, integracoes, diretor, rie, execucao]`). Se
  o plano da org não tem `clinica`, a org não pode selecionar
  Petshop no onboarding — o gating existe implicitamente via
  `ModuleService.isEnabled`.
- **D5 — CEO Operating Layer é horizontal**. A vertical Petshop
  herda automaticamente executive briefing, missões,
  business_signals, sem código adicional.
- **D6 — LGPD segue `CONSENT_BY_VERTICAL["petshop"] = ["dados_pessoais",
  "comunicacoes", "marketing"]`** (`verticals.ts:42`). Categoria
  extra `saude_pet` (histórico veterinário, alergias) fica reservada
  pra F1+ quando os campos pet-específicos entrarem — provavelmente
  reusa `dados_pessoais` (não é saúde humana; base legal padrão do
  Petshop já cobre).

## 3. Guardrails / invariantes (RN-PS-01..04)

1. **RN-PS-01 — Vertical COMPÕE, não redefine**. Qualquer capability
   nova pra Petshop precisa passar primeiro pelo teste "posso resolver
   via módulo existente?". Só em caso de "não" (com evidência de por
   quê) considerar código novo.
2. **RN-PS-02 — Pet ≠ Tutor**. Quando os campos pet-específicos
   entrarem (F1+), a modelagem preserva a distinção. Um `contact`
   pode ter N pets; um pet tem exatamente 1 tutor primário (mais
   tutores secundários se necessário).
3. **RN-PS-03 — Estoque de medicamento controlado usa `compras`
   normal**. Não inventar módulo separado — se receita/prescrição
   veterinária virar necessidade regulatória, reusa o motor de
   `ClinicDocuments` (draft→issued, assinatura por PIN, PDF).
4. **RN-PS-04 — Lembretes de vacina/vermífugo via `cadencias`, não
   via `alertas` paralelos**. Segue a regra universal do repo:
   `business_signals` é o canal de alertas; `cadencias` é o motor de
   follow-up.

## 4. Fatias (PR-a-PR, referência pra futuro)

| Fatia | Escopo | Estado |
| --- | --- | --- |
| **F0** (este ADR) | Documentar a composição existente; fechar `blocked_reason` no Ledger | ✅ este PR |
| F1 | Terminologia pet/tutor em UI (relabel via `clinicTerms.ts`) | pendente |
| F2 | Campos pet-específicos (espécie/raça/idade/carteira de vacina) — decisão entre estender `contacts` ou criar tabela `pets` | pendente |
| F3 | Schedule de vacinas/vermífugos por tipo de pet (integra com `cadencias`) | pendente |
| F4 | Prescrição veterinária como tipo específico de documento clínico | pendente |
| F5 | UI dedicada de "meu pet" no portal do cliente (opt-in) | pendente |

## 5. Reuso

- `verticals.ts` — preset (já existe)
- `ModuleService.applyVertical` — liga os módulos ao selecionar (já existe)
- `ClinicPetService`, `ClinicPetCareService`, `ClinicPetHistoryService` — hooks pet-específicos no motor clínico (já existem — servem de base pras fatias F1+)
- `src/lib/clinicTerms.ts` — dicionário terminológico
- `LgpdService`, `SubscriptionService`, `CadenceService`, `SupplierQuoteService` — todos utilitários horizontais

## 6. Diferidos (nenhum é bloqueador de F0)

- Modelagem detalhada da tabela `pets` (F2).
- Federação de médicos veterinários com CRMV (análogo a `professionals` global com `council=CRMV` — já cabe no motor `ADR-180`, sem código específico neste ADR).
- Prescrição controlada com carimbo digital do CRMV (F4 + edge case regulatório).

## 7. Rollback

Este ADR é doc-only. Nada a reverter no código. Se a decisão de composição
mudar (pouco provável — a vertical está em produção há tempo), a
alteração vem em ADR-197+ superseding este.

## 8. Fecha

`PETSHOP.blocked_reason` no `scripts/seed-product-evolution-ledger.ts` — troca de
`"Sem ADR próprio nem PRD dedicado — composição implícita"` → removido; `source_of_truth: "ADR-196"`.
