# ADR-123 — Comigo: boosts de divulgação (fecha a Fatia 3)

- **Status:** Proposto (escopo aprovado; implementação neste PR — fecha a Fatia 3)
- **Data:** 2026-07
- **Origem:** Fatia 3 do Comigo (ADR-111). Implementa os "boosts" do ADR-088 D8.
- **Relacionadas:** ADR-088 D8 (boosts: post automático, Pix dinâmico, catálogo — só paga depois de sentir o dinheiro entrar), ADR-119 (Mesa/QR — o link do catálogo), ADR-117 (sugestão — mais vendidos), ADR-118 (Pix dinâmico, já entregue).

## Contexto

O ADR-088 D8 lista **boosts** — impulsos de crescimento que o autônomo aciona: **post automático** de divulgação, **catálogo** compartilhável, Pix dinâmico (já feito). São a base do modelo "grátis até provar valor; boosts como upsell". Aqui entregamos os dois que faltam, **zero-token** (viral por natureza: cada link/post que a pessoa manda é propaganda — ADR-088 D8).

## Decisões

### D1 — Boosts geram conteúdo pronto pra compartilhar (um toque)
- **Post do dia:** monta uma legenda pronta (nome do negócio + os mais vendidos com preço) pra pessoa colar no status/Instagram/grupo. Template, **zero-token**; usa o ranking do Comigo (ADR-117), com fallback pros produtos ativos quando ainda não há histórico.
- **Compartilhar cardápio:** o link do Mesa/QR (ADR-119) + um texto convidativo pronto pro WhatsApp. Distribuição viral: o cliente pede e paga pelo próprio link.

### D2 — Registrar o uso (base do paywall futuro)
Cada boost acionado fica em `comigo_boost_log`. Hoje os boosts são **grátis** (gerar conteúdo/compartilhar); o empacotamento pago (ADR-088 D8: "só paga depois de sentir o dinheiro entrar", via Impact Ledger) fica como refino futuro — o log já prepara o terreno.

### D3 — Frugalidade
Sem IA generativa: legenda e texto são template a partir de dados que já temos. O nível com-LLM (post mais elaborado / imagem) pode vir depois, como boost pago.

## Modelo de dados
`comigo_boost_log` — `id, organization_id, boost_key, created_by, created_at`.

## Serviço (`ComigoBoostService`)
- `postDoDia(orgId)` → `{ caption }` (mais vendidos com preço; fallback produtos ativos).
- `catalogoShare(orgId)` → `{ link, text }` (link do Mesa/QR + convite).
- `list(orgId)` → os boosts prontos.
- `use(orgId, key, actorId)` → registra no log.
- Rotas `GET /api/comigo/boosts`, `POST /api/comigo/boosts/:key/use`.
- UI: aba **Divulgar** com os cards (copiar legenda / copiar-abrir link).

## Consequências
**Positivas:** fecha a Fatia 3; dá alavanca de crescimento sem custo de token; cada compartilhamento é propaganda (viral, ADR-088); log prepara o paywall de boosts.
**Trade-offs:** post é template (não é arte gerada) — suficiente pro MVP; monetização dos boosts fica pra depois (ligada ao Impact Ledger).

## Guardas
- Zero-token (template); só conteúdo do próprio negócio; isolamento por `organization_id`.
- Boosts grátis por ora; nenhum cobra sem decisão explícita futura.

## Testes
`test:comigo-boosts` — post do dia lista os mais vendidos com preço (e cai no fallback sem histórico); catálogo devolve o link do Mesa/QR + texto; `use` registra no log; isolamento.
