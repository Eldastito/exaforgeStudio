---
id: referral-ask
estagio: compose
modulos: [referrals]
fonte: coreyhaines31/marketingskills — referrals (double-sided ask / make-it-effortless). Adaptado, não copiado. MIT.
versao: 1
---

# Pedido de indicação — o convite que o cliente feliz aceita fazer

> Como a IA convida um cliente satisfeito a indicar um amigo (programa opt-in do
> `ReferralService` / ADR-069: cupom de boas-vindas pro indicado + recompensa pro
> indicador quando o amigo paga). Destila `referrals` (marketing-psychology do
> pedido: reciprocidade, valor dos dois lados, atrito zero, fazer o indicador
> parecer generoso) pro contexto WhatsApp/BR/LGPD. Aplicada pelo `referralText`
> do `AIOrchestratorService` — **nunca** inventa código nem promete desconto (o
> sistema gera/valida; a IA só convida).

## Quando aplicar

Quando o programa está ligado (`referral_enabled`) e o cliente pede o próprio
código, diz que quer indicar, ou está num momento de satisfação clara
(elogiou, recebeu o pedido, agradeceu). O timing exato — o pico de satisfação —
é a rubrica-irmã `intake/referral-timing`. Aqui é a COPY do convite/entrega do
código, não o gatilho.

## Deve conter

- **Valor dos dois lados, explícito** (reciprocidade): quanto o amigo ganha na 1ª
  compra E quanto o cliente ganha na próxima — os dois percentuais reais que o
  `ReferralService.config` devolve, nunca inventados.
- **Atrito zero**: entregar o código pronto e dizer que é só o amigo mandar/colar
  na conversa — sem cadastro, sem link, sem página. O código curto do
  `getOrCreateCode` cabe no WhatsApp.
- **Enquadrar como generosidade, não venda**: o cliente está passando um desconto
  bom pra alguém de quem gosta ("seu amigo ganha X na primeira"), não "me traz
  cliente". Faz o indicador parecer bem.
- **Uma ação clara (CTA único)**: "é só ele mandar esse código na primeira compra".
- Curto, cordial-brasileiro, no máximo 1 emoji sutil.

## Nunca fazer

- **Inventar o código** ou **prometer/confirmar o desconto** pela IA — quem gera é
  o `getOrCreateCode`, quem valida/aplica é o `applyCode`. A IA convida e anexa o
  que o sistema devolve (guarda dura do `referralText`).
- **Prometer percentuais diferentes** dos configurados pela org.
- **Pressão ou urgência falsa** ("só hoje", "última chance de indicar").
- **Insistir depois de um não** — indicação é espontânea; pedir 2x irrita e some
  com a boa vontade.
- **Pedir dados do amigo** (nome, telefone) — quem chega é o indicado, colando o
  código; não se faz outbound pra um terceiro sem consentimento (LGPD Art. 7).
- Trocar o canal ou a regra de WhatsApp — a rubrica calibra o **texto**.

## Exemplos (PT-BR)

- **Entrega do código (cliente pediu):** "Boa! 🙂 Seu código é **{CÓDIGO}**. Manda
  pra quem você quiser indicar: na 1ª compra seu amigo ganha {welcome}% de
  desconto e, quando ele comprar, você ganha {reward}% na sua próxima. É só ele
  colar o código aqui na conversa."
- **Convite no pico de satisfação:** "Que bom que curtiu! 🙂 Se quiser, tem um
  amigo que ia gostar disso? Ele ganha {welcome}% na 1ª compra e você {reward}% na
  próxima — é só me pedir seu código que eu te passo."
- **Depois do código aplicado (indicado):** "Prontinho, apliquei seu {welcome}% de
  boas-vindas 🎉 Aproveita!"

## Lições (post-mortem)

_(vazio — acumula via F1.4 se a medição do programa (F6) apontar o convite como
ruído; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
