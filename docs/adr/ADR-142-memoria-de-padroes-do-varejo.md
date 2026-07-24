# ADR-142 — Memória de Padrões do Varejo: o loop de aprendizado da loja (IA que observa, hipotetiza e valida)

- **Status:** Proposto (plano). Escopo em 3 fatias; nada implementado ainda.
- **Data:** 2026-07
- **Origem:** Levantamento com o dono da Toulon — *"como uso IA (LLM) para aprender com os dados determinísticos e começar a atuar para entender, observar e aprender/identificar os padrões de como funcionam os processos da loja?"* O produto é **determinístico** (calcula por regra) e usa LLM para **ler foto** (OCR) e **narrar** (Diretor IA). Falta o loop que faz o entendimento **acumular no tempo**.
- **Relacionadas:** ADR-083/084 (Operação da Rede — fechamento/comissão/divergência/estoque), ADR-135/136 (Enterprise Intelligence Kernel — `business_signals`, Pareto), ADR-125/126 (Motor de Caixa + Impact Ledger — esperado×realizado), ADR-114 (perdas por driver), `ExecutiveAdvisorService`/`BusinessContextService` (Diretor IA), **`ProspectService`** (o loop signals→hipóteses→score→outcome já existe para B2B — é o molde), ADR-088 D5 (frugal/zero-token), ADR-091 §6 (IA sugere, humano decide), ponte Fechamento→Faturamento (venda de loja vira caixa/receita).

## Contexto / princípio

"Aprender", para um LLM aqui, **não é treinar pesos** — é um **loop de memória + verificação** sobre dados que o motor determinístico já gera. Esses dados são uma **série no tempo** (histórico), não uma foto do dia. O ciclo:

```
OBSERVAR → HIPOTETIZAR → VERIFICAR → LEMBRAR → (volta)
determinístico   LLM lê a       determinístico     memória persiste
(fatos datados)  HISTÓRIA e     confere contra      e alimenta o
                 propõe padrões  dados novos →       próximo ciclo
                 (evidência+conf) ajusta confiança
```

O **entendimento acumula**: cada ciclo parte da memória do anterior. A confiança de um padrão sobe quando ele se repete e cai quando não — **evidência**, não treino.

**Este loop já roda em produção**, no `ProspectService` (prospecção B2B): `prospect_signals` (observações+confiança) → `generateHypotheses` (LLM lê os sinais → JSON com evidência+confiança) → `prospect_score_snapshots` (score determinístico + explicação) → `recordOutcome` (won/lost). Este ADR **replica essa forma para o varejo**, reusando o que já existe (`business_signals`, Impact Ledger, Diretor IA).

## Decisões

### D1 — Tabela de memória: `retail_store_patterns`
Um padrão observado de uma loja, no molde de `prospect_hypotheses`. Campos:
`id, organization_id, store_id (NULL = rede toda), pattern_type, description, evidence_json,
confidence REAL (0..1), status (candidate|validated|refuted|dormant), occurrences INT,
last_seen_date, first_seen_date, created_by_type (ai|rule|user), created_at, updated_at`.
- **Idempotência:** upsert por `(organization_id, store_id, pattern_type, chave-normalizada da descrição)` — o mesmo padrão **atualiza** (incrementa `occurrences`, move `last_seen`, ajusta confiança), não duplica.
- `pattern_type` de partida (vocabulário fechado, o que a IA usa pra atribuir): `caixa_divergente_recorrente`, `ruptura_recorrente`, `slow_mover_persistente`, `capital_parado`, `meta_batida_por_dia_semana`, `fechamento_atrasado`, `estoque_negativo_recorrente`.
- **Sem PII.** Padrões são sobre **processo/loja**, não sobre cliente. (Padrão ligado a cliente = Fase 2 de vendas + LGPD, fora daqui.)

### D2 — O passe de aprendizado (`RetailPatternMemoryService`) — determinístico no núcleo, LLM só na hipótese
`RetailPatternMemoryService.learnPass(orgId, {asOf})`:
1. **Observar (determinístico):** monta o **histórico** (janela default 8 semanas) a partir de `business_signals`, `retail_daily_closings` (variação/divergência), `retail_stock_alerts` (negativo), `RetailImpactService` (capital parado/slow-mover). Zero-token.
2. **Hipotetizar (LLM, frugal):** UMA chamada por passe, passando o **resumo agregado** do histórico (não linha a linha). O LLM devolve **JSON** de padrões candidatos `{pattern_type, description, evidence:[refs], confidence}`. Guardrail: **só padrões apoiados na evidência do resumo; nunca inventa número** (mesmo do `ExecutiveAdvisorService`).
3. **Verificar (determinístico):** cada padrão candidato é conferido por regra contra os dados da janela (ex.: "divergência às sextas" = ≥N sextas divergentes em M). Recorrência confirma → `occurrences++`, confiança↑, `status=validated`; não repetiu no ciclo → confiança↓, e após K ciclos vira `dormant`/`refuted`. **A confiança é da regra, não do LLM.**
4. **Lembrar:** upsert em `retail_store_patterns` (D1).

**Gatilho:** passe **semanal** no Scheduler (frugal — não a cada evento) + rota `POST /api/retailops/patterns/learn` sob demanda. **Opt-in** por org (flag `retail_pattern_memory`, default off).

### D3 — Realimentar o Diretor IA (a loja "aparece" para o gestor)
Os padrões `validated` entram no panorama do Diretor via `ExecutiveAdvisorService.buildPanorama` (bloco novo, sob a mesma flag), e viram **sinais** no `business_signals` (ADR-136) → **fluem sozinhos para o Pareto e o briefing**. Efeito: o Diretor passa a "conhecer" a loja — *"a loja 1079 costuma divergir no caixa às sextas; atenção hoje."* IA **sugere**; humano decide (ADR-091 §6).

### D4 — Fechar o loop com resultado (Impact Ledger)
Quando um padrão vira **ação** (o gestor age) e a ação tem **resultado medido** (Impact Ledger, ADR-125 — esperado×realizado), a confiança do padrão e do `pattern_type` se **ajusta pelo desfecho** — o análogo do `recordOutcome` do ProspectService. É assim que o sistema "aprende o que funciona" nesta loja, sem treinar.

### D5 — Escopo mínimo, aditivo, reversível, em 3 fatias
- **Fatia 1 (fundação):** D1 + D2 — tabela + passe (observar→hipotetizar→verificar→lembrar) + rota + flag off + teste offline (LLM mockado). O loop de aprendizado existe e persiste.
- **Fatia 2:** D3 — injeta padrões validados no Diretor/Pareto/briefing.
- **Fatia 3:** D4 — feedback do Impact Ledger ajusta a confiança pelo desfecho.
Cada fatia é um PR testável e reversível (flag). Nenhum fluxo atual muda.

## Guardas

- **Determinístico é a verdade; o LLM interpreta, não inventa** (guardrail do `ExecutiveAdvisorService`). A confiança dos padrões é calculada por **regra** (recorrência/desfecho), não pelo LLM.
- **IA sugere, humano decide** (ADR-091 §6) — padrão vira alerta/sugestão, nunca ação automática.
- **Frugal / zero-token no núcleo** (ADR-088 D5) — LLM só 1 chamada no passe **semanal**, sobre o **resumo** (não o histórico bruto). Observação e verificação são SQL.
- **Isolado por `organization_id`**; **sem PII** (padrões de processo, não de cliente).
- **Opt-in** (`retail_pattern_memory`, default off) — orgs existentes não mudam.
- **Depende de dado entrando:** a memória só fica rica se a venda entrar (ponte Fechamento→Faturamento + fechamentos). Sem venda, aprende só o lado de estoque.

## Consequências

**Positivas:** o ZappFlow deixa de só "calcular o dia" e passa a **acumular entendimento da loja** — padrões recorrentes, linhas de base por loja, e (Fatia 3) o que de fato funcionou. Reusa o loop já provado do `ProspectService`, o ledger de sinais, o Impact Ledger e o Diretor IA. Determinístico, frugal, auditável, sem PII.

**Trade-offs / limites:** não é ML (não generaliza além da evidência observada); qualidade do aprendizado é limitada pela qualidade/volume do dado que a loja alimenta; o LLM pode propor padrão fraco → mitigado pela **verificação determinística** que só valida por recorrência. Padrões ligados a cliente/SKU ficam para a Fase 2 de vendas (LGPD).

## Testes (planejados)

- `test:retail-pattern-memory` (Fatia 1) — com histórico sintético (ex.: 6 de 8 sextas divergentes): o passe **cria** o padrão `caixa_divergente_recorrente` com confiança alta; padrão sem recorrência entra `candidate` e **decai** para `dormant`; **idempotente** (re-passe não duplica, incrementa `occurrences`); LLM mockado (offline, zero-token); isolado por org; flag off → passe não faz nada.
- Fatia 2 — padrão `validated` aparece no panorama do Diretor e vira sinal no Pareto.
- Fatia 3 — desfecho positivo no Impact Ledger sobe a confiança do `pattern_type`; desfecho ruim baixa.
