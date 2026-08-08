---
id: churn-risk-scoring
estagio: intake
modulos: [cobranca, recuperacao, falatu]
fonte: coreyhaines31/marketingskills — churn-prevention (health-score model). Adaptado, não copiado. MIT.
versao: 1
---

# Score de risco de churn (classificar antes de agir)

## Quando aplicar

No **intake** — antes de decidir escrever/abordar — pra estimar a **temperatura/risco** do cliente e calibrar o tom. É também o modelo de referência do **ChurnRiskDetector** (ADR-155 F4), que publica `business_signal` (`churn_risk_high`). Aqui a rubrica define **os sinais e pesos**; o detector implementa a query.

## Deve conter

- **Score 0–100 derivado por query** sobre sinais que já existem — **nunca contador mutável** (RN-004). Sinais líderes sugeridos (calibrar depois — padrão 10, gate só bloqueia após calibração):
  - Pagamento atrasado / falha recente (peso alto).
  - Silêncio no canal (sem resposta a N mensagens).
  - Uso caindo vs. baseline da própria org.
  - Tickets/reclamações recentes ou NPS baixo.
  - Fim de ciclo/contrato se aproximando.
- **Explicabilidade rica** (padrão 5): cada score acompanha **por que subiu** (quais sinais, com `confidence` e `source_ref`). Proibido codificar certeza que não se tem — baixa `confidence` e marca o status.
- **Faixas → ação sugerida** (sugerir, não agir): 0–39 baixo (rotina), 40–69 médio (atenção/priorizar), 70–100 alto (cadência de retenção + sinal na operação, ADR-152 aba Operações).
- **Dedupe** via `dedupe_key` no `business_signal` (convenção nº 12) — nunca tabela própria de alertas.

## Nunca fazer

- **Contador mutável** de risco (é sempre derivado por query — RN-004).
- **Decidir/agir sozinho**: o score **sugere**, humano/regra decide (RN-014). Não cancela, não dá desconto, não renova.
- **Inventar sinal** sem evidência (sem `source_ref`, não entra no score).
- Criar tabela de "alertas" própria em vez de `business_signals` (ADR-136).

## Exemplos (PT-BR)

- **Explicação de score:** "Risco 78/100 (alto): fatura atrasada há 9 dias (peso 40, alta confiança) + sem resposta às últimas 3 mensagens (peso 25) + uso −60% vs. mês passado (peso 13)."
- **Faixa → ação:** "78 → alto: entra na cadência de retenção e publica `churn_risk_high` na operação; humano confirma a ação."

## Lições (post-mortem)

_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_
