---
id: lgpd-e-whatsapp
estagio: guardrails
modulos: [cobranca, recuperacao, falatu]
fonte: Interno ZappFlow
versao: 1
---

# Guardrails transversais — LGPD + WhatsApp

## Quando aplicar

**Sempre.** Regras duras que valem pra toda composição outbound, independente de módulo ou estágio. Toda rubrica de `compose/` herda estes limites; o `review/pre-send-checklist.md` confere que foram respeitados.

## Deve conter

- **Base legal (LGPD)**: comunicação só com base legal válida (execução de contrato Art. 7 pra cobrança; consentimento/legítimo interesse quando aplicável). Envio de leitura sensível segue `dados_sensiveis` (Art. 11); envio em si, `comunicacoes` (Art. 7).
- **Opt-out honrado e fácil**: toda cadência oferece saída ("responda SAIR pra não receber mais"), e o opt-out **encerra** a sequência e é registrado. Reusa o opt-out das fatias 4c.2.
- **Janela do WhatsApp**: dentro da janela de 24h (sessão iniciada pelo cliente) → mensagem livre; fora da janela → **template aprovado** obrigatoriamente. O framework de copy transfere; a regra de canal é do WhatsApp e não se burla.
- **Remetente identificado** e tom respeitoso.
- **Minimização**: só o dado necessário na mensagem; `maskIdentifier` em audit (Fase 32).

## Nunca fazer

- Enviar **sem base legal / sem opt-in** quando exigido.
- **Ignorar opt-out** (uma vez que saiu, não recebe mais daquela cadência).
- Mandar **template não aprovado fora da janela** de 24h.
- Expor **dado sensível** desnecessário (valor de dívida a terceiros, dado de saúde, etc.).
- Tom de **ameaça, coação ou constrangimento**.

## Exemplos (PT-BR)

- **Rodapé de opt-out:** "Se não quiser mais receber estas mensagens, responda SAIR."
- **Dentro vs. fora da janela:** cliente respondeu hoje → texto livre; passou 24h sem resposta → só template aprovado ("Olá {nome}, temos uma atualização sobre sua fatura…").

## Lições (post-mortem)

_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
