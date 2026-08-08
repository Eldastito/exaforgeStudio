---
id: pre-send-checklist
estagio: review
modulos: [cobranca, recuperacao, falatu]
fonte: Interno ZappFlow
versao: 1
---

# Checklist pré-envio (auto-crítica antes de emitir)

## Quando aplicar

Depois de compor e **antes de emitir** qualquer mensagem outbound. É a camada de review do grimoire — o redator (ou um gate) roda este checklist como último portão. Liga nos padrões 2 e 8 (`docs/patterns/agentic-pipeline-lessons.md`): julgamento subordinado a regra + só envia com o essencial verificado.

## Deve conter

Checklist — **todo item precisa passar**:

1. **CTA único e acionável?** Um caminho claro (link/ação), não vários.
2. **Dados corretos e reais?** Valor, vencimento, nome — sem número inventado (anti-alucinação; se não tem o dado, não afirma).
3. **Tom certo pro estágio?** Bate com a régua da rubrica de `compose/` (não começou duro).
4. **Guardrails ok?** Passou por `guardrails/lgpd-e-whatsapp.md`: base legal, opt-out presente, dentro da janela/template, sem dado sensível a mais.
5. **Timing ok?** Horário/fuso/espaçamento conforme `compose/sequence-timing.md`; não é a 2ª do dia.
6. **Evento de parada checado?** Não está enviando após pagamento/opt-out/objetivo atingido.

## Nunca fazer

- **Emitir sem passar o checklist inteiro.**
- **Marcar item como ok sem verificar** (marcar por marcar derrota o gate).
- Deixar o modelo "resgatar" um item que uma regra determinística já reprovou (padrão 2: regra tem veto).

## Exemplos (PT-BR)

- **Reprovado (para o envio):** "Item 2 falhou — a mensagem cita 'multa de R$ 20' mas não há multa pactuada. Corrigir antes de enviar."
- **Aprovado:** "6/6 ok → pode emitir."

## Lições (post-mortem)

_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
