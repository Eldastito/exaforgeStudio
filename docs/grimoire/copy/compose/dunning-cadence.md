---
id: dunning-cadence
estagio: compose
modulos: [cobranca]
fonte: coreyhaines31/marketingskills — churn-prevention (dunning cadence). Adaptado, não copiado. MIT.
versao: 1
---

# Cadência de cobrança (dunning) — WhatsApp / PIX / boleto

## Quando aplicar

Ao compor mensagem de cobrança de fatura/assinatura **vencida ou a vencer** numa cadência multi-tentativa (ADR-152 F4b.3). Antes de escrever, classifique o caso pela rubrica `intake/churn-risk-scoring.md` e distinga **soft decline** (falha recuperável — ex.: PIX não pago ainda, cartão recusado temporário) de **hard decline** (precisa ação nova — ex.: boleto vencido exige 2ª via).

## Deve conter

- **Identificação clara**: valor, referência (o que é) e vencimento. Sem isso a mensagem vira spam.
- **Um CTA único e acionável**: link PIX / copia-e-cola / 2ª via do boleto. Um só caminho por mensagem.
- **Tom escalando com a régua** (nunca começa duro):
  - **D0 (vencimento)** — lembrete gentil, assume esquecimento. "Passando pra lembrar…"
  - **D+3** — reforço prático, facilita o pagamento. Reenvia o PIX.
  - **D+7** — objetivo, cita consequência factual pactuada (ex.: suspensão do serviço), sem ameaça.
  - **D+10** — última tentativa amigável + caminho de negociação/contato humano.
- **Adaptação soft vs hard**: soft decline → "é só finalizar o PIX"; hard decline → "seu boleto venceu, aqui está a 2ª via atualizada".
- **Rodapé de opt-out** e remetente identificado (ver `guardrails/lgpd-e-whatsapp.md`).

## Nunca fazer

- **Culpar, envergonhar ou ameaçar** o cliente (nem "negativação" fora do que a lei e o contrato permitem).
- Inventar **juros, multa ou encargo** não pactuados.
- Enviar **mais de uma cobrança no mesmo dia** ou fora de janela/horário (ver `compose/sequence-timing.md`).
- Continuar a régua depois do **pagamento confirmado** ou de **opt-out**.
- Prometer o que não pode (ex.: "liberamos agora" sem confirmação real do pagamento — padrão 8, evidência primeiro).

## Exemplos (PT-BR)

- **D0:** "Oi, {nome}! 👋 Passando pra lembrar que sua fatura de {valor} vence hoje. Se quiser, é só pagar no PIX: {link}. Qualquer dúvida, tô por aqui."
- **D+3:** "{nome}, tudo certo? Sua fatura de {valor} está em aberto desde {data}. Pra facilitar, deixei o PIX aqui de novo: {link} 🙂"
- **D+7:** "{nome}, sua fatura de {valor} venceu em {data}. Pra manter o serviço ativo, o pagamento pode ser feito por aqui: {link}. Se precisar de outra opção, me avisa."
- **D+10:** "{nome}, essa é a última lembrança automática sobre a fatura de {valor}. Quer resolver ou combinar outra forma? Me chama que a gente ajeita. 🤝"

## Lições (post-mortem)

_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
