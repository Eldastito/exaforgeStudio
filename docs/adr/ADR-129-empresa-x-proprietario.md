# ADR-129 — Empresa × Proprietário (separar o dinheiro do dono do da empresa)

- **Status:** Proposto (design para aprovação; implementação por fatia depois)
- **Data:** 2026-07
- **Origem:** PRD "Central de Sobrevivência e Decisão" — Épico 10. Uma das maiores necessidades educativas do novo empreendedor: **misturar o dinheiro pessoal com o da empresa** descapitaliza o negócio sem ele perceber.
- **Relacionadas:** ADR-128 (DRE — linha de Retiradas, hoje 0), ADR-125 (Motor de Caixa — a retirada é saída de caixa), ADR-126 (Central de Saúde — pode virar gatilho/prioridade), ADR-088 D5 (frugal), ADR-091 §6 (sugere, humano decide).

## Contexto

O dono tira dinheiro da empresa sem classificar: às vezes é pró-labore (salário), às vezes é lucro, às vezes é despesa pessoal paga pelo caixa da empresa. Sem separar, ele não sabe **quanto pode retirar sem comprometer o capital de giro** — e a DRE não fecha (a linha de Retiradas está zerada, ADR-128). Este ADR cria o registro e a orientação: **classificar retiradas, alertar excesso e sugerir um pró-labore sustentável**, ligando a retirada ao **caixa** (saída real) e à **DRE** (linha de Retiradas).

## Decisões

### D1 — Retirada tipada (vocabulário do dono)
`owner_draws`: `id, organization_id, kind, amount, date, note`. Tipos (PRD §17):
- **pro_labore** — o "salário" do dono (retirada recorrente por trabalho).
- **distribuicao** — distribuição de lucro.
- **despesa_pessoal** — conta pessoal paga com o dinheiro da empresa.
- **emprestimo_socio** — adiantamento/empréstimo ao sócio (a devolver).
- **despesa_empresarial** — despesa da empresa paga pelo bolso do dono (é **aporte**, não retirada — entra dinheiro/valor para a empresa).

### D2 — Liga no caixa e na DRE (sem digitação dupla)
- Toda retirada que **sai do caixa da empresa** (pro_labore, distribuicao, despesa_pessoal, emprestimo_socio) registra um **cash_event de saída** (ADR-125), idempotente por `owner_draw:id` — o caixa reflete na hora.
- `despesa_empresarial` paga pelo dono **não** tira do caixa da empresa (foi o bolso dele) — não gera saída; fica registrada como aporte para a leitura Empresa × Proprietário.
- A **DRE** (ADR-128) passa a somar as retiradas do mês (os 4 tipos de saída) na linha **Retiradas dos sócios** — fechando o trio venda × lucro × caixa.

### D3 — Pró-labore sustentável + alerta de excesso (orientativo)
- **Sugestão de pró-labore sustentável:** a partir do resultado operacional médio recente (DRE) e do caixa, sugere um teto mensal que **não descapitaliza** (ex.: fração do resultado médio, respeitando o caixa mínimo). Determinístico, com premissas visíveis; a IA sugere, o dono decide.
- **Alerta de excesso:** quando as retiradas do mês passam de uma parcela perigosa do resultado (ex.: > 70%), sinaliza — "você está tirando mais do que o negócio gerou".
- **Impacto no capital de giro:** mostra retiradas do mês vs. caixa atual/dias de sobrevivência.

### D4 — Frugal e multi-tenant
Determinístico (zero-token); isolado por `organization_id`; reusa DRE e Motor de Caixa (não recalcula).

## Escopo (faseamento)
- **Fatia 1:** `OwnerDrawService` (record tipado + gancho de caixa; monthlyRetiradas; summary com % do resultado, sugestão de pró-labore sustentável e alerta de excesso) + **liga a linha de Retiradas da DRE** (ADR-128) + rota `/api/owner` + UI (registrar retirada + painel Empresa × Proprietário) + `test:owner-draws`.
- **Fatia 2:** recorrência do pró-labore; devolução de empréstimo do sócio; virar gatilho/prioridade na Central de Saúde quando o excesso comprometer o caixa.

## Consequências
**Positivas:** ensina a separar pessoal × empresa (dor central); fecha a DRE (Retiradas deixa de ser 0); liga a retirada ao caixa (impacto real); base para um pró-labore saudável.

**Trade-offs / riscos:** classificação depende de disciplina do dono → tipos simples e uma dica em cada um; sugestão de pró-labore pode soar prescritiva → **orientativa**, com premissas e "você decide"; `emprestimo_socio` a devolver não é controle de conta-corrente completo → registro simples na Fatia 1, devolução na Fatia 2.

## Guardas
- A retirada que sai do caixa **sempre** gera saída de caixa (idempotente) — nunca infla o caixa.
- Sugestão/alerta **orientativos** (não bloqueiam); premissas visíveis; humano decide.
- Determinístico e isolado por `organization_id`.

## Testes
- `test:owner-draws` — retirada tipada; tipos de saída geram cash_event (idempotente) e despesa_empresarial não; monthlyRetiradas soma só os tipos de saída e alimenta a DRE (linha Retiradas deixa de ser 0); alerta de excesso vs. resultado; sugestão de pró-labore com premissas; isolamento por org.
