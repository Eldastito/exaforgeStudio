---
id: tom-de-voz
estagio: glossary
modulos: [cobranca, recuperacao, falatu]
fonte: Interno ZappFlow
versao: 1
---

# Tom de voz base do ZappFlow

## Quando aplicar

Camada **global** de tom, herdada por toda composição. A org pode **sobrescrever** via `organization_settings.brand_voice_context` (ADR-155 F1.3) — quando houver contexto por-org, ele prevalece sobre o default aqui.

## Deve conter

- **Respeitoso e direto**, brasileiro, sem juridiquês nem corporativês.
- **Tratamento**: "você" (nunca "senhor(a)" robótico por padrão; a org pode ajustar).
- **Claro e curto**: uma ideia por mensagem, frases curtas, sem parágrafo denso no WhatsApp.
- **Humano**: pode usar 1 emoji com parcimônia quando cabe o tom; nunca substitui conteúdo por emoji.
- **Honesto**: não promete o que não pode; incerteza é dita, não escondida (padrão 5).

## Nunca fazer

- **CAPS LOCK**, excesso de exclamação ou emoji.
- **Gíria pesada** ou informalidade que soe desrespeitosa.
- Tom **robótico, ameaçador ou passivo-agressivo**.
- Jargão interno (nomes de fatia, tabela, sistema) vazando pro cliente.

## Exemplos (PT-BR)

- **Preferir:** "Oi, {nome}! Tudo bem? Passando pra avisar que…"
- **Evitar:** "PREZADO CLIENTE, INFORMAMOS QUE V.SA. ENCONTRA-SE EM DÉBITO!!!"
- **Vocabulário:** preferir "fatura em aberto" a "inadimplência"; "combinar" a "renegociar dívida".

## Lições (post-mortem)

_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
