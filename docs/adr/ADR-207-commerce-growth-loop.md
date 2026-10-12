# ADR-207 — Commerce Growth Loop: redes sociais → CRM → Loja Virtual ZapFlow → venda → resultado

Status: **EM ANDAMENTO.** F1 em PR. Origem: conversa "ZapFlow — Atualizações de outubro (redes sociais)" + PRD Fase 6A (2026-10-12). Decisão do dono (2026-10-12): implementar as funcionalidades da conversa **desde que fiquem simples de usar, não quebrem o que já funciona e não possam tirar o ZapFlow do ar**. "Quadbase" = codebase e "Kit Hub" = GitHub (erro de digitação): não existe projeto externo a localizar; o gate da F0 do PRD sobre isso está dissolvido.

## 1. O que a auditoria do código achou (verificado no `main`)
| Peça | Estado |
| --- | --- |
| Loja virtual própria `/loja/:slug`, deep-link `/loja/:slug/produto/:p`, carrinho, cupom, pedido, coleções, looks (Fashion Studio) | **existe** (`storefrontPublic.ts`, `src/storefront/*`) |
| Reserva e-commerce com baixa pendente, sem oversell (`RetailOnlineReserveService`, opt-in) e a venda online reserva dentro da MESMA transação do pedido | **existe** (atômico: `better-sqlite3` é síncrono + `db.transaction`) |
| Instagram Direct **recebido e respondido pelo Atendente IA** (webhook `object=instagram` → `dispatchIncomingMessage`); OAuth "Instagram Login" já pede `instagram_business_manage_messages` e `_manage_comments` | **existe** — ao contrário do que a conversa supunha, não é preciso criar conexão nova nem Atendente novo |
| Comentário do Instagram como evento (`entry.changes`) | **parcial** (cai no mesmo caminho do Direct, sem classificar intenção de compra) |
| Origem do contato (first touch), canal de conversão, forma de recebimento no CRM | **NÃO existe** (`contacts` e `orders` não têm) |
| Origem da visita/pedido da loja (canal, campanha, conteúdo) | **NÃO existia** (`storefront_events` só tinha `type`+`product_id`) → **F1** |
| Retirada na loja no checkout, estoque por loja para prometer retirada, fila "separar agora" | **NÃO existe** |
| Frete / cotação | **NÃO existe** |
| Margem de contribuição por canal (física × virtual), desconto máximo seguro | **NÃO existe** (há DRE, `LossMarginService`, cupons `storefront_coupons`, comissão `RetailCommissionService`, `default_markup_percent`) |
| Custo de IA por campanha | medidor existe (`AiUsageDashboardService`); falta ligar à campanha |
| Fio conteúdo→lead→venda→receita→margem | **existe** (ADR-168) e é REUSADO |

## 2. Princípios (herdados — nada disso muda)
Sem motor/CRM/Studio/Scheduler/atribuição/cupom/estoque paralelo; aditivo e reversível (colunas `ADD COLUMN`, flags opt-in, nada destrutivo); `organization_id` em tudo; dinheiro só dono/administrador; fato ≠ estimativa; sem dado ≠ zero; IA nunca calcula dinheiro nem estoque; publicar/executar segue pela governança existente. Regra nova (do dono): **o ZapFlow nunca oferece, vende ou promete retirada de um SKU sem conseguir reservar a unidade com segurança.** Para decidir desconto/frete vale a **margem de contribuição** (custos incrementais); a margem "com rateio de aluguel" é mostrada à parte e não decide.

## 3. Fatias (cada uma = 1 PR; ordem por valor e risco)
| # | Fatia | Depende de terceiro? |
| --- | --- | --- |
| **F1** | **Atribuição social → loja**: `zf_source/zf_campaign/zf_content/zf_ref` no link da loja; visita e pedido gravam a origem; lead ligado ao conteúdo pelo token do link; funil derivado `GET /api/storefront/attribution` | não |
| F2 | CRM: **origem imutável** (first touch) + canal atual + canal de conversão + forma de recebimento; "Instagram → WhatsApp" não apaga o Instagram | não |
| F3 | **Retirar na loja** no checkout: só lojas com estoque confiável, reserva atômica já na criação do pedido, reserva expira se não pagar; atrás de flag | Alterdata (qualidade do estoque) |
| F4 | Fila **"separar agora"** para o pedido com retirada (sinal + estados separado/pronto/retirado); fecha o buraco "vendi a última peça na loja física" | não (write-back no PDV = Alterdata) |
| F5 | Link curto `/loja/:slug/go/:codigo` + gerador de link de campanha + vitrine "visto no Instagram" | não |
| F6 | **Economia por canal** (fachada read-only): margem de contribuição física × online, qualidade do dado (confiável/parcial/insuficiente), **desconto máximo seguro** sobre os cupons existentes; piso opcional | não (precisa o dono informar piso/impostos) |
| F7 | **Frete**: regras definidas pelo dono (retirada grátis, fixo, por faixa, grátis acima de X **e** acima do piso) aplicadas no checkout; cotação por transportadora em fatia posterior | cotação: Correios/Melhor Envio (contrato) |
| F8 | Custo de IA por campanha (medidor atual + `campaign/content/correlation`) | não |
| F9 | Instagram: comentário → **intenção comercial** → resposta/Direct com o contexto do produto; respeita capabilities | App Review da Meta p/ permissões em produção |
| F10 | Mídia paga etapa 1: calculadora CAC máximo / ROAS / POAS / break-even (sem API de anúncios) | não (criar/otimizar anúncio: Marketing API + review) |
| F11 | **Motor de Crescimento**: tela única que compõe Radar→Criar→Aprovar→Publicar→Vender→Aprender + onboarding conversacional (Fala Tu → Brand DNA) | não |
| F12 | Estoque ↔ campanha: não promover sem estoque; reduzir/parar quando cai | não |
| F13 | Vídeo bruto→pronto, newsletter/repurposing, TikTok/YouTube/LinkedIn/X reais | provider de vídeo, APIs/aggregador (terceiro) |

## 4. F1 — EM PR (2026-10-12)
- **Link**: `/loja/:slug?zf_source=instagram&zf_campaign=linen_out26&zf_content=reel_143&zf_ref=campaign:linen` (e o mesmo em `/produto/:p`). O slug nunca muda por campanha; link antigo segue igual.
- **Vitrine** (`src/storefront/attribution.ts`, puro): lê os `zf_*`, guarda 7 dias no navegador (para o pedido, feito depois, ainda saber a origem) e manda na visita/clique e no pedido. Sem parâmetro e sem nada guardado → exatamente como antes.
- **Servidor** (`StorefrontAttributionService`): entrada pública não confiável — só `[A-Za-z0-9_.:-]`, tamanhos curtos, canal fora da lista vira `other`, sem PII. `storefront_events` e `orders` ganham `attr_source/campaign/content/ref` (`ADD COLUMN`, nulos por padrão). O lead só é ligado ao conteúdo (`ContentLeadAttributionService`, que já existe) quando há **contato válido da própria empresa vindo do token do link** e um `zf_ref`; nunca por id do body.
- **Funil** (`GET /api/storefront/attribution?days=`, só dono/administrador): por canal/campanha/conteúdo — visitas, cliques, pedidos, pagos, receita **paga** (fato) e **aguardando** (à parte, nunca somada), conversão (null sem visitas), margem do pago (null sem custo conhecido). Pedidos sem origem aparecem à parte. Rotulado "atribuição declarada pelo link, não prova de causa".
- Teste `test:storefront-attribution` (42 checks; 10 mutações pegas — 2 guardas são defesa em profundidade: o filtro de org no UPDATE do pedido e o `contactId` antes do lead, ambos já protegidos por outra camada). Regressão verde: `storefront-seller-attribution`, `storefront-stock`, `content-lead-attribution`, `content-revenue-attribution`.
- **Limites**: nada gera o link ainda (F5) — hoje o dono monta a URL à mão; não vê no navegador (só testes e build); a atribuição é declarada pelo link (qualquer um pode digitar `zf_*`); a receita dos relatórios ADR-168 continua olhando o último pedido pago do contato, não este pedido (o funil novo lê o pedido); não há tela (só API).
