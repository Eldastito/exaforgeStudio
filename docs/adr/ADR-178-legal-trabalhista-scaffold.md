# ADR-178 — LEGAL: Orientação trabalhista (scaffold honesto, gated em curadoria)

- **Status:** Implementado (1 fatia — scaffold). Conteúdo PENDENTE de curadoria
  jurídica humana (terceiro).
- **Data:** 2026-08-16
- **Origem:** PRD "ZapFlow Moda/TOULON — Melhorias v1.0", frente LEGAL/trabalhista.
- **Relacionadas:** ADR-115 (`LegalAdvisorService` — consultora jurídica ancorada
  no CDC), ADR-156 (camada compartilhada global, escrita master-only).

## Contexto

A `LegalAdvisorService` (ADR-115) já orienta o lojista ancorada no **CDC**
(relação de consumo), GROUNDED numa base curada — nunca inventa lei. Falta o lado
**TRABALHISTA** (admissão, jornada/ponto, férias, rescisão/verbas rescisórias,
FGTS…). Diferente do CDC, cuja base já foi revisada, a base trabalhista **precisa
ser validada por advogado/contador** antes de virar produto: errar em verba
rescisória ou jornada expõe o lojista a passivo. Curadoria jurídica é um
terceiro humano — não dá para gerar isso com LLM sem revisão.

## Decisão

Um **scaffold honesto** de orientação trabalhista: a estrutura pronta, o conteúdo
gated na curadoria. Espelha o GROUNDING do CDC (recuperação determinística por
termos, nunca inventa) e a camada compartilhada global da ADR-156 (federal, uma
base para todos, escrita master-only).

1. **Tabela** `labor_law_entries` — **GLOBAL** (sem `organization_id`; lei federal
   é a mesma p/ todos), escrita **só pelo admin master**, lida por todos. **Nasce
   VAZIA**: cada entrada exige `reviewed_by` (quem revisou juridicamente).
2. **`LaborLawAdvisorService`**:
   - `LABOR_TOPICS` — taxonomia dos 10 temas (estrutura; sem regra).
   - `status()` — `awaitingCuration` quando vazia; cobertura por tema; disclaimer.
   - `advise(question)` — recuperação **determinística por termos** sobre a base
     curada; base vazia/sem match → `grounded:false` + "aguardando validação
     jurídica" — **NUNCA inventa CLT**. Disclaimer cravado por código.
   - `curate(entry)` — publica entrada curada; **EXIGE `reviewedBy`** e `topic`
     válido (master-only via rota).
3. **Rotas** (sob `/api/legal`, core): `GET /labor/status`, `GET /labor/advise?q=`,
   `POST /labor/curate` (`requireMasterAdmin`).

## Regras de Negócio (RN-178)

- **RN-178-001 (grounded):** só orienta com base curada; sem amparo → honesto.
- **RN-178-002 (nunca inventa lei):** base vazia/sem match → aguardando curadoria.
- **RN-178-003 (revisão obrigatória):** `curate` exige `reviewedBy` (o jurista).
- **RN-178-004 (curadoria de plataforma):** escrita master-only; tenant read-only.
- **RN-178-005 (disclaimer sempre):** toda resposta carrega o aviso legal.

## Consequências

- O lojista vê os temas trabalhistas e um estado honesto ("aguardando validação
  jurídica"); quando o curador publicar entradas revisadas, o advisor passa a
  orientar GROUNDED — sem trocar de arquitetura.
- Aditivo/retrocompatível; base global isolada da lógica por-tenant; sem motor
  paralelo (reusa o padrão do CDC advisor).

## Fora desta fatia (pendente de terceiro)

- **Conteúdo curado** por advogado/contador (as entradas revisadas) — o produto
  só orienta trabalhista quando isso existir.
- Redação por LLM a partir das entradas recuperadas (como o CDC faz) — opcional,
  sempre GROUNDED na base curada.
- UI de "Consultora trabalhista" e o painel master de curadoria (o backend já
  responde).

Teste: `scripts/test-labor-law-advisor.ts` (14 checks).
