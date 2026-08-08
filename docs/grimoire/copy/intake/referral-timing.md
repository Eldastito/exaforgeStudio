---
id: referral-timing
estagio: intake
modulos: [referrals]
fonte: coreyhaines31/marketingskills — referrals (ask at peak happiness). Adaptado, não copiado. MIT.
versao: 1
---

# Quando pedir indicação — o pico de satisfação, não o fim da venda

> O gatilho do pedido de indicação: o pedido só converte (e só é bem-visto)
> quando chega no MOMENTO CERTO. Destila o princípio de `referrals` (pedir no
> pico de satisfação) pro contexto conversacional do ZappFlow. Antecede a
> `compose/referral-ask` (a copy do convite). É leitura de sinal, não copy.

## Quando aplicar

Antes de a IA decidir se cabe convidar o cliente a indicar (programa
`referral_enabled` ligado). Serve pra escolher a HORA — não sair pedindo em toda
conversa.

## Deve conter

- **Sinal de satisfação recente e concreto**: elogio explícito ("amei",
  "ficou ótimo"), agradecimento espontâneo, confirmação de entrega recebida,
  recompra, ou o próprio cliente perguntando do programa.
- **Contexto de compra concluída/paga** — o pico é logo depois de uma experiência
  boa, não no meio de uma negociação ou de um problema em aberto.
- **Respeito ao estado do ticket**: se há reclamação, atraso, cobrança pendente
  ou dúvida não resolvida, NÃO é hora — resolver primeiro.
- **No máximo um convite por ciclo de satisfação** — pedir uma vez e recuar.

## Nunca fazer

- **Pedir no meio de um problema** (reclamação, atraso, suporte aberto) — queima
  a relação e a indicação.
- **Pedir a frio**, sem nenhum sinal de satisfação — vira spam de indicação.
- **Repetir o pedido** pra quem já disse não ou já indicou nesse ciclo.
- **Forçar o gatilho** por meta de indicação — o gatilho é o cliente feliz, não a
  necessidade da loja.

## Exemplos (PT-BR)

- **Pico bom (pedir):** cliente diz "chegou certinho, amei!" → é hora: seguir pra
  `referral-ask` e oferecer o código.
- **Pico bom (pedir):** cliente recompra e comenta que sempre volta → hora de
  convidar a indicar.
- **Não é hora (recuar):** cliente pergunta do programa mas ainda tem um pedido
  atrasado em aberto → resolver o atraso primeiro; indicação depois.
- **Não é hora (recuar):** conversa é reclamação ou dúvida de preço → nada de
  convite no meio.

## Lições (post-mortem)

_(vazio — acumula via F1.4 se a medição do programa (F6) mostrar convite fora de
hora derrubando a boa vontade; cada lição entra datada.)_
