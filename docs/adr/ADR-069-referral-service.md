# ADR-069 — ReferralService — programa de indicação opt-in

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Indicação de cliente é o CAC mais barato que existe: o comprador feliz conta pra amiga dele no zap sem que a org gaste um centavo em Meta Ads. O SaaS opta por facilitar isso — cupom de boas-vindas para quem chega via indicação, cupom de recompensa para quem indicou quando a compra do amigo é paga. O `ReferralService` entrou junto com a IA que sabe pedir e aplicar código (ADR do AIOrchestrator), mas o programa ficou sem ADR próprio. Este documento fecha a lacuna.

---

## Contexto

Programa **opt-in por lojista** (`organization_settings.referral_enabled`), com dois percentuais configuráveis: `referral_welcome_percent` (desconto para o indicado na 1ª compra) e `referral_reward_percent` (desconto para o indicador na próxima compra). Ambos são clampeados em [1, 90] na leitura — evita cupom de 0% (silencioso) e cupom de 100% (fraude óbvia por má configuração).

Estado ficando em duas tabelas: `referral_codes` (código único por `contact_id` dentro da org) e `coupons` (unidade de valor emitida — `kind ∈ {'referral_welcome','referral_reward'}`, `owner_contact_id`, `source_contact_id`, `status`). A relação indicador↔indicado fica em `contacts.referred_by_contact_id`, criada no momento em que o código é aplicado — é o que garante que a recompensa só sai quando a primeira compra daquele indicado for paga.

A IA é o **único ponto de entrada em produção**: no `AIOrchestratorService` o prompt ganha, quando `referralText` está ativo, duas flags de saída — `referral_code_request` (o cliente pediu o próprio código ou disse que quer indicar) e `apply_referral_code` (o cliente colou um código recebido). O `webhookProcessor.ts:531-551` traduz isso em `getOrCreateCode` / `applyCode` e anexa a confirmação à resposta. Não há UI de "resgatar cupom" — o cliente conversa, a IA aplica, o `OrdersService` já cria o pedido com desconto (`webhookProcessor.ts:609-621`) e `PaymentService.ts:405` dispara `rewardReferrerIfDue` quando o pagamento entra.

## Decisão

**Regras invioláveis do `ReferralService`:**

1. **Opt-in explícito.** `config()` devolve `enabled=false` na ausência de `organization_settings.referral_enabled`. Todos os métodos de emissão (`applyCode`, `rewardReferrerIfDue`) fazem short-circuit em `null` quando `!cfg.enabled`. Desligar o programa **para de emitir cupom novo**, mas cupom já emitido continua válido (não caça retroativa).
2. **Código curto e sem ambiguidade.** 6 caracteres em `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — sem `0/O`, `1/I/L`, sem minúsculas. Cabe em um WhatsApp sem ambiguidade de leitura. Colisão testada por SELECT em `referral_codes(organization_id, code)`; 20 tentativas antes de cair no fallback `uuidv4().slice(0,8)`.
3. **Um código por contato, para sempre.** `getOrCreateCode` é idempotente — o mesmo cliente recebe sempre o mesmo código, mesmo depois de reenviar dez vezes.
4. **Anti auto-indicação.** `applyCode` rejeita quando `referrer === referredContactId`. É a fraude mais óbvia (cliente indica ele mesmo pra ganhar desconto) e é barrada na fonte.
5. **Uma indicação por contato.** Se `contacts.referred_by_contact_id` já está preenchido, `applyCode` devolve `null`. Cliente não pode "trocar de padrinho" para acumular boas-vindas.
6. **Boas-vindas é só para clientes novos.** `applyCode` verifica `orders` (excluindo `cancelado`) — quem já comprou antes não ganha desconto retroativo por colar código.
7. **Recompensa uma única vez por indicação.** `rewardReferrerIfDue` faz `SELECT` em `coupons` com o par (`owner=referrer`, `source=indicado`, `kind='referral_reward'`) antes de emitir. Chamar duas vezes seguidas no mesmo pagamento não gera dois cupons.
8. **Recompensa gated por pagamento.** É `PaymentService.ts:405` que chama `rewardReferrerIfDue` — não o `OrdersService.createOrder`. Amigo cria pedido e cancela antes de pagar → indicador não ganha nada.
9. **Consumo automático no próximo pedido.** `activeCoupon` devolve o mais antigo em `status='active'`; `webhookProcessor.ts:609` aplica no `createOrder`; `redeem` marca `used` com `used_order_id`. Cliente não precisa "colar" o cupom próprio — a IA aplica sozinha.

## Consequências

**Positivas:**
- CAC quase zero: canal orgânico dentro da própria conversa do WhatsApp, sem plugin, sem link de afiliado, sem página de landing.
- Lojista decide o esforço (percentuais) e liga/desliga a qualquer momento sem migração de dado.
- Fluxo 100% conversacional — não existe estado "cliente tem cupom mas esqueceu de aplicar". `activeCoupon` + `redeem` fecham o loop sozinhos.
- Auditável: `coupons.source_contact_id` + `contacts.referred_by_contact_id` permitem reconstruir a árvore de indicações a qualquer momento.

**Trade-offs aceitos:**
- **Sem análise estatística de fraude.** Só barramos os dois casos triviais (auto-indicação, indicado que já comprou). Um lojista malicioso pode criar N contatos-fantasma e distribuir códigos entre eles para gerar cupons — o teto é o `referral_reward_percent` que ele mesmo configurou. Aceitável: o prejuízo é só dele, não do SaaS.
- **Sem programa multi-nível.** Indicação é 1 hop — quem foi indicado não vira "indicador de segundo nível" acumulando comissão. Complexidade de pirâmide não paga o CAC extra no volume atual.
- **Sem cashback em conta.** A recompensa é sempre cupom de **desconto percentual na próxima compra**, não crédito em carteira nem PIX de volta. Cliente que não comprar de novo perde o cupom — é feature, não bug: é o que mantém o programa alinhado com recompra.
- **Sem expiração de cupom.** `activeCoupon` não filtra por data. Cupom emitido em janeiro pode ser resgatado em dezembro. Trade-off consciente para não frustrar cliente esquecido; revisitar se estoque de cupons ativos crescer demais.
- **Sem teto de cupons por indicador.** Um cliente pode indicar 100 amigos e acumular 100 cupons `referral_reward`. Como `activeCoupon` devolve um por vez (FIFO), na prática ele resgata 1 por pedido — mas o passivo fica no banco. Não implementamos limite porque nunca vimos passar de dezenas em nenhum tenant.
- **Sem notificação assíncrona ao indicador.** Quando o amigo paga, `rewardReferrerIfDue` cria o cupom mas o indicador só descobre na próxima vez que ele mesmo mandar mensagem. Faltou um `NotificationService.referralRewarded(...)` — anotado como dívida.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-referral-service.ts` — `ls scripts/ | grep referral` volta vazio. O programa passou por validação manual em staging (código gerado, código aplicado, pagamento, cupom de recompensa criado) e nunca virou script automatizado.

**Testes adjacentes que exercitam o caminho de forma indireta:**
- `scripts/test-orders-service.ts` (via `OrdersService.createOrder` com `couponId` + `discountPercent` — não valida a origem do cupom, mas garante que o desconto é aplicado corretamente no total do pedido).
- `scripts/test-payment-service.ts` (paga um pedido — o gancho `rewardReferrerIfDue` roda sem quebrar, mas o teste não checa se o cupom de recompensa foi criado).

**Lacunas honestas** que devem virar `scripts/test-referral-service.ts`:
- `getOrCreateCode` idempotente: duas chamadas devolvem o mesmo código; código único por contato dentro da org.
- Colisão de código: forçar `Math.random` determinístico e verificar que o retry funciona.
- `applyCode` anti auto-indicação: dono do código = indicado → `null`.
- `applyCode` só para novos: contato com pedido não-cancelado → `null`.
- `applyCode` uma vez só: rodar duas vezes seguidas → segunda chamada devolve `null` e não cria segundo cupom.
- `rewardReferrerIfDue` uma vez só: chamar duas vezes no mesmo indicado → segunda chamada é no-op.
- `rewardReferrerIfDue` respeita `enabled=false`: desligar o programa entre `applyCode` e o pagamento → recompensa não sai.
- `activeCoupon` + `redeem`: FIFO, transição `active` → `used` com `used_order_id` preenchido.

Enquanto esses testes não existirem, qualquer mudança em `ReferralService` ou nos gatilhos da IA (`referral_code_request` / `apply_referral_code` no `AIOrchestratorService.ts:305-306`) exige revisão manual dos 3 consumidores listados em `grep -rn ReferralService\. src/server`.
