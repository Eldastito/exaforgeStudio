# ADR-089 — Backlog: retargeting por anúncios pagos (Pixel + públicos + campanhas)

- **Status:** Backlog (registrado a pedido; **não implementar agora** — anotação de lacuna)
- **Data:** 2026-07
- **Contexto de origem:** pedido do dono — *"anota isso aí que precisamos implementar caso o ZappFlow não tenha"*, com a definição: **retargeting = exibir anúncios personalizados para quem já visitou o site, interagiu com a marca ou abandonou o carrinho.**
- **Relacionadas:** `CampaignsView` / `SettingsView` (carrinho abandonado + reativação), `CustomerProfileService` (segmentação frio/morno/quente), `ConversionVelocityService`, `RevenueIntelligenceService`, storefront (`Storefront.tsx`/`CartDrawer.tsx`). Conectores disponíveis no ambiente: Meta Ads (MCP `Meta_Ads_Oficial`) e (potencial) Google Ads.

## O que o ZappFlow JÁ tem (retargeting por canal próprio)

Re-engajamento **direto**, por mensagem, de quem interagiu — sem mídia paga:
- **Carrinho abandonado:** `abandonedCart { enabled, hours, message, intentEnabled, intentThreshold }` — dispara WhatsApp após N horas de carrinho parado.
- **Reativação de inativos:** segmento *"Inativos +60 dias"* em `CampaignsView`; `CustomerProfileService` classifica frio/morno/quente para campanhas.
- **Disparos & Reativação** e velocidade de conversão como sinais.

Ou seja: o **"retargeting owned-channel"** (falar de novo com quem já é contato) está **coberto**.

## O que FALTA (o recorte deste backlog): retargeting por MÍDIA PAGA

A definição do pedido é **exibir anúncios** para o visitante/abandono — isso é **paid-ad retargeting**, que o ZappFlow **não tem**:

1. **Instrumentação (tag/pixel) no storefront e na loja virtual**
   - Meta **Pixel** + **Conversions API (CAPI)** server-side (eventos `PageView`, `ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase`).
   - Google **Tag**/GA4 + eventos equivalentes.
   - Consentimento **LGPD** (banner de cookies/consent mode) antes de disparar pixel — pré-requisito, não opcional.
2. **Públicos personalizados (custom audiences)**
   - Sincronizar segmentos do ZappFlow (visitou, viu produto, abandonou carrinho, inativo +60d, comprou) como **audiências** no Meta/Google — via MCP `ads_create_custom_audience` / `ads_update_custom_audience_users` (Meta já disponível no ambiente).
   - Audiências **lookalike** a partir dos melhores clientes.
3. **Campanhas de anúncio de retargeting**
   - Criar/gerir campanhas que **exibem o anúncio** para esses públicos (Meta: `ads_create_campaign/ad_set/ad/creative`).
   - Criativo dinâmico do catálogo (produto abandonado → anúncio daquele produto): **catálogo/DPA** (Dynamic Product Ads) a partir do storefront (`ads_catalog_*`).
4. **Medição de retorno**
   - Fechar o ciclo: anúncio → clique → conversão no storefront (CAPI) → atribuição, alimentando `RevenueIntelligenceService`/Impact Ledger.

## Por que anotar e não fazer agora

- É **mídia paga** (custo de anúncio do lojista) e tem **dependência regulatória** (LGPD/consentimento, políticas Meta/Google) — decisão comercial, não só técnica.
- O ambiente já tem o conector **Meta Ads** (MCP), então a lacuna real é **produto/UX + pixel/CAPI + consentimento**, não acesso à API.
- Encaixa melhor depois que o **storefront/PDV do ZappFlow Comigo** (ADR-088) e o catálogo estiverem consolidados — o catálogo é insumo do DPA.

## Próximo passo quando for priorizado

Escrever um ADR de decisão dedicado cobrindo: (a) Pixel + CAPI server-side no storefront com consent LGPD; (b) sincronização de segmentos → custom audiences (começando pelo Meta, que já está conectado); (c) catálogo → DPA; (d) atribuição de conversão. Fatiar como de praxe. **Guarda:** nada de pixel sem consentimento; isolamento por `organization_id`; a conta de anúncios é do lojista (o ZappFlow orquestra, não é o anunciante).
