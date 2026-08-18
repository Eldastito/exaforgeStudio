# Análise — PDR Estabilização da Homologação TOULON (Moda) vs repositório

**Base auditada pelo PDR:** commit `1ac62f9`. **Reverificado em:** `main` atual (fatia-por-PR).
**Método:** auditoria estática, alegação por alegação, com evidência `file:line`.

## A anomalia-raiz (o que estava "impedindo de funcionar")

**Boletas aparentam sumir no reload após 21h — causa: data comercial em UTC.**

- `todayStr()` = `new Date().toISOString().slice(0,10)` devolve data **UTC** (`RetailOpsView.tsx:14`).
- `BoletaPanel` fixa o dia no mount (`RetailOpsView.tsx:1436`), e o servidor confia no `day` do cliente (`routes/retailops.ts:1262+`).
- No Rio (UTC−3), após 21:00 a data UTC já é D+1 → o reload consulta a chave `(org, loja, D+1)`, vazia → contagem "zera". **Os dados nunca se perdem** (`retail_boleta_events`, `db.ts:6900`); a leitura é que usa a chave errada.

## Veredictos (resumo)

| Fatia | Situação | Ação |
|---|---|---|
| A — data comercial | bug UTC confirmado; sem coluna `timezone`; sem `BusinessTimeService`; sem idempotência de clique | **corrigir (esta fatia)** + idempotência (próxima) |
| B — ranking/POS | ranking com largura fixa (não responsivo); `card_fee` agregado sem crédito/débito; POS sem tarifa/custo esperado | ajustar |
| C — vendedores | `retail_sellers` global sem lotação; `user_stores` é por-usuário; unmapped `CAI_USUARIO` some da escala; nome via `window.prompt`; matrícula-sem-nome não vira pendência | implementar lotação + pendências |
| D — cotas | cota total existe (corrida/fechamento) mas duplicada inline | componente único |
| E — salvamento | 3 saves separados + `.catch(()=>{})` + sucesso incondicional; sem endpoint atômico; telas mascaram erro HTTP como vazio | atômico + erros honestos |
| F — performance | `allStoresResult` N+1; CMV/mais-vendidos com `LIKE prefix`; `retail_pdv_sale_items` sem catálogo resolvido; índices finos | ingestão resolvida + set-based + índices |
| G — conectividade | chip "Instável" vem só do Socket.IO (`App.tsx:82`), sem health REST | estados separados + probe |

**Preservar (atendido):** comissão configurável, escala 4 semanas, trabalha/folga, cotas, escopo de loja (ADR-173, imposto no servidor), suítes de teste (CI auto-descobre `test:*`).

## Plano por fases (fatia = 1 PR draft, com flag/teste/rollback)

- **Fase 0** — reprodução + testes que falham + baseline (este doc).
- **Fase 1 (P0) FECHADA** — 1A data comercial ✅ · 1B boletas idempotentes/histórico ✅ · 1C salvamento atômico ✅ · 1D erros honestos ✅ · 1E ranking mobile ✅.
- **Fase 2 (P1)** — 2A diretório + lotação + descoberta por filial ✅ · 2B UI "Vendedores da loja" ✅ · 2C escala por loja (roster + "de outra loja", fallback legado) ✅ · 2D comissão com fonte/pendência · cota total única.
- **Fase 3 (P1)** — `retail_store_pos_fee_rules` (crédito/débito) + resumo POS com custo esperado.
- **Fase 4 (P2)** — catálogo resolvido na ingestão + índices medidos + set-based + cache + carga.
- **Fase 5 (P2)** — estados de conectividade + health probe.
- **Fase 6** — piloto controlado (rollout por loja).

## Fatia 1A — Data comercial (ESTA fatia)

`BusinessTimeService` (fuso da org via `Intl`, fallback `America/Sao_Paulo`) + coluna aditiva
`organization_settings.timezone` + `GET /api/context/business-time`. As rotas de boleta passam a
ser **autoritativas no dia** (TIME-003): `open`/`click` usam a data comercial do servidor e o
`GET /boletas/day` assume o dia comercial quando o cliente não pede um dia histórico. A UI do
`BoletaPanel` deixa de calcular "hoje" em UTC — lê o dia do servidor e exibe a data operacional +
horário da última leitura (BOL-001). Correção sistêmica (fuso), nunca "−3h" fixo (RN-TIME-2).

Nota de escopo: os demais `todayStr()` (default de data do fechamento, período da comissão, semana
da escala, mês da corrida — TIME-004) entram numa fatia seguinte de Fase 1; são *defaults* de
seletor (o usuário troca a data), sem o efeito de "perda" da boleta.

Teste: `scripts/test-business-time.ts` (10 checks — virada de dia 20:59/21:00/23:59/00:00 SP com
servidor em UTC, fuso por org, `dayBounds`, `context`). Regressão `test:retail-boletas` verde.
