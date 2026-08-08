---
id: sequence-timing
estagio: compose
modulos: [cobranca, recuperacao]
fonte: coreyhaines31/marketingskills — sms + emails (lifecycle sequence timing). Adaptado, não copiado. MIT.
versao: 1
---

# Timing de sequência (o "quando" e o espaçamento)

## Quando aplicar

Ao definir **quando** e **com que espaçamento** as mensagens de uma cadência multi-tentativa saem (Cobrança F4b.3, Recuperação F4c.3). Governa o ritmo; o conteúdo de cada passo vem da rubrica de `compose/` do tipo (ex.: `dunning-cadence`). O canal do ZappFlow é **WhatsApp-first** — o framework de sequência transfere, as regras de canal (janela/template) são próprias e vivem em `guardrails/lgpd-e-whatsapp.md`.

## Deve conter

- **Horário humano**: enviar em horário comercial no **fuso da org** (default America/Sao_Paulo). Nada de madrugada.
- **Espaçamento crescente**: tentativas próximas no início, cada vez mais espaçadas (ex.: D0 → D+3 → D+7 → D+10). Evita fadiga.
- **Uma por dia por cadência, no máximo**: nunca empilhar mensagens do mesmo fluxo no mesmo dia.
- **Parada dura por evento**: pagamento confirmado, resposta positiva, objetivo atingido ou opt-out **encerram** a sequência imediatamente.
- **Teto de tentativas** + escalonamento pra humano quando esgota (padrão 3: terminação garantida; reusa o approval humano das fatias 4b/4c).
- **Cobrança formal**: preferir dias úteis; evitar fim de semana/feriado pro passo "sério" da régua.

## Nunca fazer

- Enviar **de madrugada** ou fora do horário comercial do fuso da org.
- **Duas mensagens da mesma cadência no mesmo dia.**
- Ignorar o **fuso** (mandar 8h no horário do servidor ≠ 8h do cliente).
- Continuar a sequência após **opt-out** ou **objetivo atingido** (padrão 8: o evento real manda, não o cronograma).

## Exemplos (PT-BR)

- **Espaçamento cobrança:** D0 (vencimento, manhã) → D+3 → D+7 → D+10; depois disso, escala pra humano.
- **Espaçamento recuperação:** D0 (mesmo dia do abandono/perda) → D+2 → D+5; para no engajamento ou opt-out.
- **Regra de corte:** "pagamento confirmado no D+2 → cancela D+7 e D+10 automaticamente."

## Lições (post-mortem)

_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
