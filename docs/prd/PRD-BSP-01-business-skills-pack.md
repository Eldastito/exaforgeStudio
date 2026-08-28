# PRD-BSP-01 — ZapFlow Business Skills Pack (Pricing 360 · RFP · Local Marketing)

**Consolidação de capacidades transversais de venda, precificação e prospecção sob um único contrato.**

- **Produto:** ZapFlow
- **Repositório:** `Eldastito/exaforgeStudio`
- **Prioridade:** Alta — destrava Track C do PRD-PEL-01 (Product Evolution Ledger + Gap Closure Program).
- **Responsável pela execução:** IA Dev.
- **Tipo:** PRD funcional + técnico + política de bundling.
- **Status:** **Rascunho inicial** — desbloqueia `Gap-2` do `docs/product-evolution/INITIAL-GAP-MATRIX.md`. ADR arquitetural em `docs/adr/ADR-195-business-skills-pack.md`.
- **ADR associado:** [ADR-195 — Business Skills Pack (arquitetura + bundling + gates de plano)](../adr/ADR-195-business-skills-pack.md).
- **Dependências principais:** `PlanService`, `AddonService`, `PermissionService`, `ModuleService`, `pricing.ts` (§ADR-023), `ComigoPricingService`, `RetailPricingService`, `QuoteService`, `SupplierQuoteService`, `ProspectService`, `ProspectDiscoveryService`, `ProspectResearchService`, `ProspectExecutionService`, `StudioService` (Track A), `CompetitorInsightsService` (Track B).

---

## §0 — Contexto e motivação

O PRD-PEL-01 identificou (`Gap-2`) que o **Business Skills Pack** apareceu no ledger inicial como iniciativa PRECISA_ADAPTAR (§11.15 da matriz), mas **não tem contrato consolidado no repositório**. O que existe são sub-capacidades espalhadas em services de vertical:

- **Pricing 360 (precificação assistida)**:
  - `src/server/pricing.ts` — sugestão markup 40% (§ADR-023) para Loja Virtual, condicionada a custo real via `InventoryService.recordMovement`
  - `src/server/ComigoPricingService.ts` — pricing por serviço (vertical Comigo/Falatu)
  - `src/server/RetailPricingService.ts` — pricing por produto (vertical Retail)
  - `src/server/SupplierQuoteService.ts` — quotes vindas do fornecedor
- **RFP / Orçamentos (cotação estruturada)**:
  - `src/server/QuoteService.ts` — orçamentos como objeto rastreável (`sent/viewed/accepted/declined/expired`), com métricas de conversão (§ADR-132 Fatia 2)
  - Composição com `MessageProviderService` para envio via WhatsApp
- **Local Marketing / Prospecção**:
  - `src/server/ProspectService.ts` — cadastro de prospects
  - `src/server/ProspectDiscoveryService.ts` — descoberta de leads
  - `src/server/ProspectResearchService.ts` — enriquecimento
  - `src/server/ProspectExecutionService.ts` — execução de ações comerciais
  - `src/server/prospectCategories.ts` — taxonomia

Cada pedaço tem escopo próprio, coerente dentro da vertical em que foi construído. **Nenhum documento anuncia o Business Skills Pack como bundle comercializável** — o que significa que:

1. Um cliente não pode "comprar Pricing 360" ou "comprar Prospecção Assistida" hoje: essas capacidades vêm implícitas com a vertical.
2. Não há gate de plano coerente entre as capacidades (cada service tem seu próprio `PlanService.<xxx>Allowed`).
3. Não existe um vocabulário compartilhado no marketing/onboarding — as RN não estão consolidadas.
4. O ledger PRD-PEL-01 não consegue avançar de PRECISA_ADAPTAR para PRD_READY sem contrato.

Este PRD **fecha o Gap-2** entregando o contrato mínimo necessário para Track C (§6) começar.

## §1 — Escopo

### §1.1 — In scope (o que o BSP consolida)

**Dimensão A — Pricing 360**

Uma capacidade unificada de **precificação assistida por vertical**, com contrato único:
- `PricingService.suggestPrice({ orgId, item, vertical, context })` — retorna `{ suggested_price, floor_price, ceiling_price, method, reasoning }`
- Adapters por vertical delegam para os services existentes (`ComigoPricingService`, `RetailPricingService`, `pricing.ts` [Loja Virtual])
- Uniformização das RN de arredondamento psicológico (§ADR-023 já usa `psychologicalRound`) e markup mínimo
- **Nada de mudar as chamadas internas atuais** — este PRD introduz uma fachada, não substitui os services

**Dimensão B — RFP (orçamentos como serviço estruturado)**

- Reuso direto do `QuoteService` já existente
- Adição de **template de orçamento configurável por org** (JSON: cabeçalho, condições, prazo, itens de linha)
- Métricas expandidas: além de conversão temporal já existente, agregar por vertical e por vendedor
- CTA "gerar orçamento" no bar do agente de atendimento

**Dimensão C — Local Marketing / Prospecção**

- Reuso da família `ProspectService` já existente
- Adição de **skill pack de outreach** (mensagens padrão para WhatsApp, tom por vertical, seguindo o padrão que o Studio F3.5 já usa para classificação — briefing → suggest → recipe)
- Integração com **Track B (Competitor Intelligence)**: prospect com competitor account cadastrado ganha classe `similar_to_competitor` para priorização

**Dimensão D — Bundling comercial**

- Novo add-on `business_skills_pack` no `AddonService` com política de gates coerente
- Contém as 3 sub-capacidades acima
- Herança: `plan.pro` e superior já incluem BSP; planos `basic/starter` compram como add-on
- ModuleService expõe as capacidades como toggles individuais dentro do bundle para clientes que só querem uma dimensão

### §1.2 — Out of scope

- **Refatoração dos services por vertical** — cada service continua onde está, com sua API interna
- **Integrações novas com CRMs externos** (Salesforce/Hubspot/Pipedrive) — vira fatia própria após o pack estabilizar
- **AI-powered pricing prediction** — pricing continua rule-based nesta versão; ML de preço é iniciativa separada
- **Nova vertical inteira** — BSP é transversal, não introduz vertical nova

### §1.3 — Não-objetivos explícitos

- Não é um "CRM completo" — é uma camada de capacidades **combinadas** com o atendimento omnichannel que já existe
- Não substitui o Studio (Track A) — Studio é criação de arte; BSP é venda/precificação/prospecção
- Não substitui a análise de concorrentes (Track B) — BSP consome os sinais de B para priorização, mas não os produz

## §2 — Instrução obrigatória para a IA Dev

Antes de iniciar qualquer alteração, a IA Dev deverá:

1. Ler este PRD integralmente.
2. Ler o ADR-BSP-01 quando existir (a criar em §11).
3. Analisar o codebase dos 4 services agrupados (Pricing, Quote, Prospect, e o novo BSP proposto).
4. Verificar quais RN abaixo já estão implementadas em cada service.
5. Identificar divergências entre este documento e o código.
6. Registrar suas ponderações em `docs/product-evolution/STATUS-DE-EXECUCAO.md` antes de abrir qualquer fatia.

## §3 — Regras de negócio (RN-BSP-01..12)

### RN-BSP-01 — Bundle transversal

O Business Skills Pack é um **bundle** que agrupa 3 capacidades (Pricing 360, RFP, Local Marketing). Sob nenhuma hipótese o BSP é uma nova vertical.

### RN-BSP-02 — Fachada, não substituição

`PricingService.suggestPrice` (novo) é uma **fachada** que delega para o service certo baseado em vertical:

| Vertical            | Adapter                     |
|---------------------|-----------------------------|
| `retail`            | `RetailPricingService`      |
| `comigo`/`falatu`   | `ComigoPricingService`      |
| `loja_virtual`      | `pricing.ts` (`sugestPrice`)|
| outras              | fallback markup 40%         |

Nenhuma chamada existente muda; a fachada é aditiva.

### RN-BSP-03 — Isolamento multi-tenant

Toda operação BSP filtra por `organization_id`. Nenhuma query cross-tenant. Consistente com todo o resto do repo.

### RN-BSP-04 — Templates de orçamento por org

Cada organização tem 0 ou 1 template ativo de orçamento (JSON): cabeçalho, condições, prazo, footer. Fallback = template default do BSP quando ausente.

### RN-BSP-05 — Métricas por vendedor

`QuoteService` estende a agregação existente com breakdown por `agent_id` (autor do orçamento). Não substitui, adiciona.

### RN-BSP-06 — Prospect enriquecido por competitor

Quando um prospect tem `handle_@platform` que casa com um `competitor_accounts.handle+platform` da org (Track B F1), o prospect ganha flag `is_watched_competitor=true` e recebe boost na priorização.

### RN-BSP-07 — Skill pack de outreach

Mensagens de outreach são **templates versionados** por vertical (padrão comparável a Visual Recipes da Track A, mas texto em vez de imagem). Fora do escopo desta fatia: definir esses templates. Escopo aqui: reservar a estrutura no PRD.

### RN-BSP-08 — Gate de plano no bundle

`PlanService` recebe novo método `businessSkillsPackAllowed(orgId, {dimension?})`:
- Se `dimension` ausente → retorna se a org tem acesso ao pack como um todo
- Se `dimension` = 'pricing' | 'rfp' | 'local_marketing' → retorna acesso à dimensão específica
- Retorno: `{allowed: bool, reason: 'plan_no_bsp' | 'plan_dimension_disabled' | null, plan: string}`

### RN-BSP-09 — Herança de planos

- Planos `pro`, `business`, `enterprise` → **incluem BSP completo** por padrão
- Planos `starter`, `basic` → BSP fica disponível **como add-on** (`business_skills_pack`)
- Plano `autonomo` → BSP indisponível (upgrade obrigatório)

### RN-BSP-10 — Módulo dentro do bundle

Cada dimensão do BSP aparece como um `module_key` no `ModuleService`:
- `bsp_pricing_360`
- `bsp_rfp`
- `bsp_local_marketing`

Toggle-able individualmente pelo admin da org (útil pra desligar Local Marketing em orgs que já usam CRM externo, por exemplo). Módulo desligado → gate `plan_dimension_disabled`.

### RN-BSP-11 — PT-BR em tudo

Rótulos, mensagens de erro, templates, prompts LLM: tudo em pt-BR (consistente com o resto do produto).

### RN-BSP-12 — Nada quebra

Aditivo puro: services existentes não mudam de assinatura pública. Adaptação = novos métodos + fachada + nova tabela de templates. Testes de regressão (pricing, quote, prospect) permanecem verdes.

## §4 — Arquitetura proposta

```
┌─────────────────────────────────────────────────────────────┐
│  BusinessSkillsPackService (novo)                            │
│  - suggestPrice() → delega                                   │
│  - createQuoteFromTemplate() → delega + template merge       │
│  - enrichProspectWithCompetitor() → cruza com Track B        │
│  - listSalesMetrics({dimension})                             │
└─────┬───────────────┬───────────────┬────────────────────────┘
      │               │               │
      │               │               │
┌─────▼────────┐  ┌──▼──────────┐  ┌─▼────────────────────┐
│ Pricing      │  │ Quote       │  │ Prospect             │
│ services     │  │ services    │  │ services             │
│ (existentes) │  │ (existentes)│  │ (existentes)         │
│              │  │             │  │                      │
│ pricing.ts   │  │ QuoteService│  │ ProspectService      │
│ Comigo...    │  │ Supplier... │  │ Discovery/Research/  │
│ Retail...    │  │             │  │ Execution            │
└──────────────┘  └─────────────┘  └──────────────────────┘

Suportes transversais:
  - PlanService.businessSkillsPackAllowed()
  - AddonService (add-on 'business_skills_pack')
  - ModuleService (3 module_keys: bsp_pricing_360, bsp_rfp, bsp_local_marketing)
  - Nova tabela: business_skills_pack_org_config (templates + toggles)
```

### §4.1 — Nova tabela: `business_skills_pack_org_config`

```sql
CREATE TABLE IF NOT EXISTS business_skills_pack_org_config (
  organization_id TEXT PRIMARY KEY,
  quote_template_json TEXT,           -- Template de orçamento (RN-BSP-04)
  outreach_pack_json TEXT,            -- Skill pack de outreach (RN-BSP-07)
  pricing_prefs_json TEXT,            -- Overrides de markup/psychological rounding
  enabled_dimensions_json TEXT,       -- Array: ["pricing", "rfp", "local_marketing"]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Uma linha por org, apendada no fim de `db.ts` (CREATE-then-ALTER estrito). Zero migração em tabelas existentes.

## §5 — Casos de uso (US-BSP-01..06)

### US-BSP-01 — Sugerir preço para item novo (loja virtual)

**Ator**: dono de loja virtual, plano Business.
**Fluxo**:
1. Cadastra produto no `inventory_items` com custo via nota fiscal.
2. UI chama `BSP.suggestPrice({orgId, itemId, vertical:'loja_virtual'})`.
3. BSP delega para `pricing.ts.sugestPrice(cost)`.
4. Retorna `{suggested_price, method:'markup40+psycho', reasoning:'markup padrão + arredondamento'}`.
5. Humano ajusta ou aceita.

### US-BSP-02 — Enviar orçamento pelo agente WhatsApp

**Ator**: agente de atendimento (humano ou IA), plano Pro.
**Fluxo**:
1. Cliente pede cotação de 3 itens no WhatsApp.
2. Agente aciona `quote_request` no bar.
3. BSP compõe template configurado (org tem `quote_template_json`).
4. `QuoteService` persiste em `quotes` com status `sent`.
5. Métricas contam para a agenda comercial do agente.

### US-BSP-03 — Descobrir prospects com boost de concorrente

**Ator**: gestor comercial, plano Business.
**Fluxo**:
1. Gestor abriu a tela de prospects.
2. `BSP.enrichProspectWithCompetitor` roda em background.
3. Prospect cujo `handle_@platform` casa com `competitor_accounts` recebe badge "concorrente vigiado".
4. Boost na ordenação: aparece no topo.

### US-BSP-04 — Análise de conversão por vendedor

**Ator**: dono do negócio, plano Enterprise.
**Fluxo**:
1. Abre relatório de vendas.
2. BSP consulta `QuoteService.listSalesMetrics({dimension:'per_agent'})`.
3. Dashboard mostra conversão por vendedor (RN-BSP-05).

### US-BSP-05 — Upgrade para desbloquear BSP

**Ator**: pequena loja no plano Starter que descobriu Pricing 360.
**Fluxo**:
1. Clica em "Sugerir preço" na tela do produto.
2. `PlanService.businessSkillsPackAllowed(orgId, {dimension:'pricing'})` → `{allowed:false, reason:'plan_no_bsp', plan:'starter'}`.
3. UI mostra modal: "Pricing 360 é do Business Skills Pack. Ver planos ou adicionar como add-on".
4. Botão redireciona para `AddonService` ou `/planos`.

### US-BSP-06 — Admin desliga Local Marketing

**Ator**: admin de org que já usa Salesforce.
**Fluxo**:
1. Vai em Configurações → Módulos.
2. Toggle "Local Marketing (BSP)" em OFF.
3. `ModuleService` grava em `business_skills_pack_org_config.enabled_dimensions_json`.
4. Sub-menu de prospecção some do sidebar; endpoints retornam 402 com `plan_dimension_disabled`.

## §6 — Plano de fatias (F0..F5)

Sugestão de fatiamento para Track C. Cada fatia = 1 PR pequeno, aditivo, testável.

### F0 — Contrato + auditoria (este PR)

Este PRD-BSP-01. Nenhum código; só documento. Desbloqueia Gap-2. Atualiza `INITIAL-GAP-MATRIX.md` e `STATUS-DE-EXECUCAO.md`.

### F1 — Fachada `BusinessSkillsPackService` (Pricing 360 apenas)

- Novo service com só `suggestPrice({orgId, itemId, vertical})`
- Delega para o adapter certo (RN-BSP-02)
- Nova tabela `business_skills_pack_org_config` com colunas mínimas (`organization_id`, `pricing_prefs_json`)
- Endpoint `GET /api/bsp/pricing/suggest?itemId=&vertical=`
- Teste 30+ checks (fallback markup, delegação, isolamento)

### F2 — Templates de orçamento (RFP)

- Adiciona `quote_template_json` a `business_skills_pack_org_config`
- Novo método `BSP.createQuoteFromTemplate({orgId, items, ...})` que compõe o template com dados dinâmicos
- Endpoints CRUD para o template
- Métricas por vendedor (`RN-BSP-05`)

### F3 — Prospect enriquecido com competitor (Local Marketing)

- Novo método `BSP.enrichProspectWithCompetitor(orgId)` — batch job
- Cruza `prospects.handle` + `prospects.platform` com `competitor_accounts`
- Adiciona coluna `is_watched_competitor` em `prospects` (ADD COLUMN aditivo)
- Endpoint para trigger manual

### F4 — Bundle comercial

- `AddonService` ganha `business_skills_pack`
- `PlanService.businessSkillsPackAllowed({dimension?})`
- `ModuleService` expõe `bsp_pricing_360`, `bsp_rfp`, `bsp_local_marketing`
- Herança automática por plano
- Teste 40+ checks

### F5 — UI de gerenciamento

- Nova aba em Configurações → "Business Skills Pack"
- Toggles de dimensão
- Editor de template de orçamento
- Editor de skill pack de outreach
- Preview de sugestão de preço

## §7 — Métricas de sucesso

Após F1-F4 em produção:
- **≥ 60%** das gerações de orçamento no repo passam a usar `createQuoteFromTemplate` (adoção interna).
- **≥ 40%** dos prospects nas orgs com competitor cadastrado (Track B F1 populado) recebem `is_watched_competitor=true` corretamente.
- **≥ 0** regressões em `QuoteService`, `pricing.ts`, `ComigoPricingService`, `RetailPricingService`, família `ProspectService*` (testes verdes).
- **≥ 50%** de conversion lift em prospects marcados como watched competitor (comparado ao mesmo grupo antes do enrichment). **Métrica de longo prazo**, medida via `business_signals` (ADR-136).

## §8 — Riscos e mitigações

### R-01 — Cliente confunde BSP com nova vertical

**Risco**: cliente acha que precisa "escolher a vertical BSP".
**Mitigação**: BSP é add-on/módulo, não vertical. UI e documentação sempre chamam de "pacote" ou "bundle", nunca "vertical".

### R-02 — Serviços por vertical divergem da fachada

**Risco**: `RetailPricingService` muda assinatura, `BSP.suggestPrice` quebra.
**Mitigação**: Testes de contrato explícitos entre BSP e cada adapter. Padrão DI para tests (mesmo padrão do `GitHubEvidenceSyncService`).

### R-03 — Templates de orçamento viram XSS/injection

**Risco**: cliente customiza template com HTML/JS malicioso.
**Mitigação**: Template é JSON estruturado (não HTML livre); render server-side com escape estrito; validação de schema no upsert.

### R-04 — Enriquecimento pesa em prospects grandes

**Risco**: org com 10k prospects + 100 competitors = O(N*M) queries.
**Mitigação**: Índice composto em `competitor_accounts (org, LOWER(handle), platform)` já existe (F1 Track B); enrichment usa `IN (SELECT ...)` uma vez em vez de loop.

### R-05 — Herança de plano quebra Autonomo

**Risco**: cliente Autonomo tenta acessar Pricing 360 pelo Studio e vê tela quebrada.
**Mitigação**: RN-BSP-09 explícita — Autonomo NÃO tem BSP; UI mostra upgrade. `PlanService.businessSkillsPackAllowed` cobre isso.

## §9 — Regras de rollout

- **F1-F2 primeiro**: Pricing + RFP são features mais visíveis. Local Marketing (F3) é backend-only até UI.
- **Gate de plano só em F4**: F1-F3 rodam sem gate durante bake-in (feature flag global `bsp_soft_launch`), permitindo qualquer org testar. F4 liga os gates.
- **Reversibilidade**: cada fatia é aditiva; reverter uma fatia = reverter 1 PR sem tocar em outras.

## §10 — Integração com outras iniciativas do PRD-PEL-01

| Iniciativa relacionada                       | Integração                                                        |
|----------------------------------------------|-------------------------------------------------------------------|
| Track A F1-F5 (VRE)                          | Nada direto; Studio continua separado de BSP                      |
| Track B F1-F4 (Competitor Intelligence)      | **RN-BSP-06**: prospects cruzam com competitors da org           |
| `PRD-PEL-01`                                 | Este PRD desbloqueia Gap-2; iniciativa 15 vai de `PRECISA_ADAPTAR` → `PRD_READY` |
| Vertical Entitlements (PRD existente)        | RN-BSP-09 respeita as regras de plan/vertical/module já normalizadas |
| Studio Insights UI (PR #1411)                | UI de BSP F5 segue o mesmo padrão visual (cards + delta bars)     |

## §11 — Próximos passos e itens pendentes

- ~~Criar ADR-BSP-01 consolidando as decisões arquiteturais~~ — **feito** em [ADR-195](../adr/ADR-195-business-skills-pack.md) (D1-D8 cobrindo fachada, tabela única, herança de plano, roll-out com feature flag)
- **Ratificar RN-BSP-11 e RN-BSP-12** com o time comercial
- **Validar preços de add-on** com finance (fora deste PRD)
- **Escolher se F1 começa por Pricing ou por RFP** — recomendação: **Pricing** por já ter 3 adapters prontos

## §12 — Aprovação

- [ ] **IA Dev / dono do produto** — leu §0-§11
- [ ] **Timeline** — aceita fatiamento §6
- [ ] **ADR-BSP-01** — a criar antes de F1

---

*Este PRD desbloqueia `Gap-2` do `docs/product-evolution/INITIAL-GAP-MATRIX.md`. Depois deste merge, a iniciativa `BUSINESS_SKILLS_PACK` no `product_evolution_items` pode ser evoluída de `PRECISA_ADAPTAR` → `PRD_READY` no ledger.*

*Autor: IA Dev. Sessão: `session_01T9KRf6RUYCaQk4EkHQVfuK`.*
