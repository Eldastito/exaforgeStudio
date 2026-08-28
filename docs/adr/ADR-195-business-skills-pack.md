# ADR-195 — Business Skills Pack (arquitetura + bundling)

**Estado:** **F0 aprovado — arquitetura + política de bundling.** Ainda sem
código; F1 (fachada Pricing 360) fica para PR seguinte.
**Data:** 2026-08-28.
**Natureza:** consolidação arquitetural do PRD-BSP-01
(`docs/prd/PRD-BSP-01-business-skills-pack.md`). Destrava Track C do
PRD-PEL-01. Aditivo sobre services de vertical existentes; nenhuma refatoração
de código anterior é planejada.

## 1. O problema

O ZapFlow já tem 3 sub-capacidades comerciais transversais espalhadas por
vertical:

- **Pricing 360**: `src/server/pricing.ts` (loja virtual, §ADR-023),
  `ComigoPricingService` (comigo/falatu), `RetailPricingService` (retail),
  `SupplierQuoteService`.
- **RFP / Orçamentos**: `QuoteService` (§ADR-132 F2), `MessageProviderService`
  (envio WhatsApp).
- **Local Marketing / Prospecção**: família `ProspectService*` (Discovery,
  Research, Execution, Categories).

Cada pedaço tem contrato próprio, coerente dentro da sua vertical. **Nenhum
documento no repo anuncia o Business Skills Pack como bundle comercializável**
— o que significa:

1. Cliente não pode "comprar Pricing 360" ou "Prospecção Assistida" hoje:
   essas capacidades vêm implícitas com a vertical, sem gate próprio.
2. Não há vocabulário compartilhado no marketing/onboarding.
3. Ledger PRD-PEL-01 §11.15 marcou como `PRECISA_ADAPTAR` mas sem PRD/ADR
   não pode avançar para `PRD_READY`.
4. Track C do PRD-PEL-01 (P1) permanece bloqueado.

PR #1412 (PRD-BSP-01) fechou parte do gap com o contrato de negócio; **falta
a decisão arquitetural** — como consolidar sem refatorar tudo, e como
manter herança de plano coerente. Este ADR resolve isso.

## 2. Decisões (D1–D8)

- **D1 — Fachada, não refatoração.** Introduzimos um único
  `BusinessSkillsPackService` (novo) que **delega** para os services por
  vertical intactos. Nenhuma chamada interna existente muda de assinatura.
  Reduz risco de regressão nos 6 services envolvidos
  (`pricing.ts`, `ComigoPricingService`, `RetailPricingService`,
  `SupplierQuoteService`, `QuoteService`, família `ProspectService*`).
- **D2 — Uma tabela de config, não 3.** F1 cria uma única tabela nova
  `business_skills_pack_org_config` (uma linha por org) com colunas JSON
  para as três dimensões: `pricing_prefs_json`, `quote_template_json`,
  `outreach_pack_json`, `enabled_dimensions_json`. Alternativa rejeitada:
  3 tabelas separadas — over-engineering para dados que sempre vêm juntos
  na tela de "Configurações → BSP". Aditiva ao fim de `db.ts` (CREATE-then-ALTER
  estrito, RN do CLAUDE.md).
- **D3 — Dimensões independentes com módulos separados.** Cada uma das 3
  dimensões (Pricing 360, RFP, Local Marketing) é um `module_key` distinto
  no `ModuleService`: `bsp_pricing_360`, `bsp_rfp`, `bsp_local_marketing`.
  Admin pode desligar dimensão individual (Local Marketing off em org que
  já usa CRM externo, por exemplo). Sem módulo → gate retorna
  `plan_dimension_disabled`. Alternativa rejeitada: BSP como um único
  `module_key` monolítico — flexibilidade comercial menor, força upgrade
  para dimensão indesejada.
- **D4 — Gate de plano centralizado.** `PlanService` ganha um único método
  `businessSkillsPackAllowed(orgId, {dimension?})`. Sem `dimension` retorna
  se o pack está disponível como um todo; com `dimension` retorna acesso
  à dimensão específica. Retorno padronizado
  `{allowed, reason: 'plan_no_bsp' | 'plan_dimension_disabled' | null, plan}`.
  Alternativa rejeitada: um método por dimensão (`pricingAllowed`,
  `quoteAllowed`, `prospectAllowed`) — duplica lógica de plano, torna
  refatoração de tier mais custosa.
- **D5 — Herança automática por plano.** Configuração declarativa em
  `AddonService`:
  - `pro`, `business`, `enterprise` → BSP incluído por padrão
  - `starter`, `basic` → BSP como add-on separado (`business_skills_pack`)
  - `autonomo` → BSP indisponível (upgrade obrigatório)
  Nenhuma mudança em `PlanService` além do novo método (D4);
  compatibilidade com trial e proporcionalidade é herdada da mecânica
  existente do `AddonService`.
- **D6 — Templates são JSON estruturado, não HTML/Markdown livre.** Templates
  de orçamento (`quote_template_json`) e skill packs de outreach
  (`outreach_pack_json`) são schemas JSON fixos, validados no upsert.
  Render server-side com escape estrito. Alternativa rejeitada: Markdown/HTML
  livre — XSS + escape frágil + preview inconsistente entre canais
  (WhatsApp vs PDF).
- **D7 — Integração com Track B é read-only, não invasiva.** F3 (prospect
  enriquecido) faz `LEFT JOIN` de `prospects` com `competitor_accounts` por
  `(org_id, LOWER(handle), platform)` — sem alterar schema de
  `competitor_accounts`. Nova coluna aditiva em `prospects`:
  `is_watched_competitor INTEGER DEFAULT 0`. Alternativa rejeitada:
  denormalização dupla (adicionar `competitor_id` em prospects) — piora
  isolamento e complica delete de competitor.
- **D8 — Roll-out com feature flag antes dos gates.** F1-F3 rodam sob
  flag global `bsp_soft_launch` (default off; opt-in via env) durante
  bake-in, permitindo qualquer org testar sem afetar cobrança. F4 liga
  os gates de plano de fato. Alternativa rejeitada: liberar para
  todos direto — cliente do plano `autonomo` acessaria features que
  vão bloquear em F4, gerando frustração.

## 3. Contratos

### 3.1 — Fachada `BusinessSkillsPackService` (F1+)

```typescript
export class BusinessSkillsPackService {
  // Pricing 360 (F1)
  static suggestPrice(input: {
    orgId: string;
    itemId: string;
    vertical: string;
  }): Promise<{
    suggested_price: number;
    floor_price: number | null;
    ceiling_price: number | null;
    method: string;                       // 'markup40+psycho' | 'comigo_service_matrix' | etc
    reasoning: string;
    adapter: string;                       // 'pricing.ts' | 'ComigoPricingService' | ...
  }>;

  // RFP (F2)
  static createQuoteFromTemplate(input: {
    orgId: string;
    items: Array<{ product_id: string; quantity: number; unit_price?: number }>;
    template_overrides?: Record<string, any>;
  }): Promise<{
    quote_id: string;
    rendered_text: string;                 // pronto pra whatsapp
    total: number;
  }>;

  // Local Marketing (F3)
  static enrichProspectsWithCompetitor(input: {
    orgId: string;
    limit?: number;
  }): Promise<{
    enriched: number;                      // quantidade marcada como watched
    scanned: number;
  }>;

  // Config (F1+)
  static getOrgConfig(orgId: string): Promise<OrgBspConfig | null>;
  static updateOrgConfig(orgId: string, patch: Partial<OrgBspConfig>): Promise<OrgBspConfig>;
}
```

### 3.2 — Schema (F1+, aditivo puro)

```sql
CREATE TABLE IF NOT EXISTS business_skills_pack_org_config (
  organization_id TEXT PRIMARY KEY,
  quote_template_json TEXT,           -- Template de orçamento (RN-BSP-04)
  outreach_pack_json TEXT,            -- Skill pack de outreach (RN-BSP-07)
  pricing_prefs_json TEXT,            -- Overrides de markup, arredondamento
  enabled_dimensions_json TEXT,       -- Array: ["pricing", "rfp", "local_marketing"]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bsp_org ON business_skills_pack_org_config (organization_id);
```

Nova coluna em `prospects` (F3, ALTER aditivo aceito):
```sql
ALTER TABLE prospects ADD COLUMN is_watched_competitor INTEGER DEFAULT 0;
```

### 3.3 — Adapters (F1)

Registro de adapters no `BusinessSkillsPackService` via mapa estático:

```typescript
private static PRICING_ADAPTERS: Record<string, (input) => Promise<...>> = {
  retail:       (i) => RetailPricingService.suggest(i),
  comigo:       (i) => ComigoPricingService.suggest(i),
  falatu:       (i) => ComigoPricingService.suggest(i),
  loja_virtual: (i) => pricing.sugestPrice(i.cost),
  // fallback:
  default:      (i) => Promise.resolve({ suggested_price: i.cost * 1.4, method: 'default_markup40', reasoning: 'markup padrão sem adapter específico', adapter: 'default' }),
};
```

Novo adapter é **1 linha de mapa**. Não muda o service da vertical.

## 4. Riscos

### R-01 — Divergência entre fachada e adapters
**Impacto**: Alto. Adapter da vertical muda assinatura em outra PR sem
avisar; fachada quebra silenciosamente.
**Mitigação**: Teste de contrato explícito em F1 para cada adapter
(6 checks mínimo). CI reprova adapter que muda assinatura sem PR de fachada.

### R-02 — Herança de plano confunde cliente
**Impacto**: Médio. Cliente `starter` compra add-on BSP mas Pricing continua
bloqueado porque o módulo `bsp_pricing_360` está OFF por default do
`ModuleService`.
**Mitigação**: F4 liga automaticamente todas as 3 dimensões quando o add-on
é ativado (upsert em `enabled_dimensions_json`). Documentar no help.

### R-03 — Template JSON vira XSS via WhatsApp
**Impacto**: Alto. Cliente edita template e injeta payload malicioso.
**Mitigação**: D6 — schema JSON fixo, escape server-side sempre. Validação
no upsert rejeita chaves não-esperadas.

### R-04 — Enrichment de prospects escala O(N*M)
**Impacto**: Médio. Org com 10k prospects × 100 competitors trava.
**Mitigação**: Índice composto em `competitor_accounts (organization_id,
platform, LOWER(handle))` já existe (Track B F1). Enrichment usa
`UPDATE ... FROM (SELECT ...)` ou batch com CTE — nunca loop no JS.
Rate limit interno: 1 enrichment/hora por org.

### R-05 — `autonomo` upgrade forçado gera churn
**Impacto**: Alto. Cliente do plano Autonomo que usa Pricing hoje via
`pricing.ts` (loja virtual) perde acesso ao "upgrade" para BSP.
**Mitigação**: `pricing.ts` continua acessível DIRETAMENTE (não muda);
`BusinessSkillsPackService.suggestPrice` é adicional. Autonomo continua com
`pricing.ts` puro; se quiser fachada + gate, aí upgrade. Documentar
esse gradiente no material de onboarding.

## 5. Métricas de sucesso

Após F1-F4 em produção:
- **≥ 60%** das gerações de orçamento passam pela fachada (adoção interna
  medida via log de `BusinessSkillsPackService.createQuoteFromTemplate`).
- **≥ 40%** dos prospects em orgs com competitor cadastrado recebem
  `is_watched_competitor=true` no primeiro enrichment.
- **≥ 0 regressões** nos testes de `pricing.ts`, `QuoteService`,
  `ComigoPricingService`, `RetailPricingService`, família `ProspectService*`
  (todos os testes existentes continuam verdes).
- **≥ 50%** conversion lift em prospects `is_watched_competitor=true`
  comparado ao mesmo grupo pré-enrichment. Métrica de longo prazo, tracked
  via `business_signals` (§ADR-136).

## 6. Fatias sugeridas (F1-F5)

Cópia de referência do PRD-BSP-01 §6:

- **F1** — Fachada `BusinessSkillsPackService.suggestPrice()` apenas Pricing.
  Nova tabela `business_skills_pack_org_config` com `pricing_prefs_json`.
  Endpoint `GET /api/bsp/pricing/suggest`. Teste 30+ checks (fallback,
  delegação por vertical, isolamento).
- **F2** — Templates de orçamento (RFP). Adiciona `quote_template_json`.
  Novo `createQuoteFromTemplate`. Endpoints CRUD do template. Métricas
  por vendedor (RN-BSP-05).
- **F3** — Prospect enriquecido. ALTER `prospects ADD is_watched_competitor`.
  Método `enrichProspectsWithCompetitor` em batch. Trigger endpoint.
- **F4** — Bundle comercial. `AddonService.business_skills_pack`;
  `PlanService.businessSkillsPackAllowed`; `ModuleService` expõe as 3
  keys; herança automática por plano (D5).
- **F5** — UI de gerenciamento em Configurações → BSP.

## 7. Relação com outros ADRs/PRDs

- **PRD-BSP-01** (PR #1412 merged): fonte de negócio; este ADR é a resposta
  arquitetural.
- **ADR-023** (marketplace pricing loja virtual): `pricing.ts` continua
  como adapter válido. Zero mudança.
- **ADR-132** (quote conversion metrics): `QuoteService` continua intacto;
  F2 apenas adiciona template + métricas por vendedor.
- **ADR-136** (business_signals): F4 vai emitir sinais quando limiar de
  conversão for atingido.
- **ADR-153** (Vertical Entitlements + Assinaturas + Upgrade Inteligente):
  D5 respeita a hierarquia declarativa desse ADR.
- **ADR-193** (Product Evolution Ledger): a iniciativa
  `BUSINESS_SKILLS_PACK` no ledger avança de `PRECISA_ADAPTAR` → `PRD_READY`
  (com PRD-BSP-01 checked-in) → `APPROVED` (com este ADR aprovado).

## 8. Rollback

Aditivo puro. Reverter = remover:
- Service `BusinessSkillsPackService`
- Tabela `business_skills_pack_org_config`
- Coluna `prospects.is_watched_competitor` (SQLite não suporta DROP
  COLUMN nativo; se necessário, deixar coluna e ignorar — CLAUDE.md
  proíbe reorderar db.ts, então "deletar" é conceitual)
- Endpoints `/api/bsp/*`
- `PlanService.businessSkillsPackAllowed`
- Feature flag `bsp_soft_launch`

Services de vertical (`pricing.ts`, `ComigoPricingService`, etc) continuam
funcionando como antes desta iniciativa — nenhuma mudança destrutiva neles.

---

*Este ADR fecha o caminho para Track C F1 começar. Próxima etapa
executável: PR de F1 com fachada Pricing 360 + teste 30+ checks.*

*Autor: IA Dev. Sessão: `session_01T9KRf6RUYCaQk4EkHQVfuK`.*
