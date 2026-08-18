# Runbook — Piloto controlado & homologação TOULON (Moda)

> **Fase 6 do PDR *Estabilização da Homologação TOULON***. As Fases 1–5 (correções
> técnicas) já estão em produção; esta fase é **operacional**: subir loja por loja,
> monitorar e obter o aceite formal. Doc de operação — não é código.
>
> Referência: `docs/prd/ANALISE-PDR-ESTABILIZACAO-TOULON.md` (mapa das fatias) e o
> PDR original (§14 métricas, §16 riscos, §17 perguntas, §18 Definition of Done).

---

## 1. O que entrou (mapa das entregas × onde olhar)

| Fatia | Entrega | Serviço / superfície | Reversão |
| --- | --- | --- | --- |
| **1A** | Data comercial no fuso da org (boletas não somem no reload após 21h) | `BusinessTimeService` · `GET /api/context/business-time` · coluna `organization_settings.timezone` | reverter PR 1A |
| **1B** | Clique de boleta idempotente + histórico 7 dias | `RetailBoletaService` · `retail_boleta_events.idempotency_key` | reverter PR 1B |
| **1C** | Salvamento financeiro atômico + versão otimista (409) | `RetailStoreCostService.saveFinancialSettings` · `financial_settings_version` | reverter PR 1C |
| **1D** | Estados de erro honestos nas telas analíticas | `fetchAnalytics`/`AnalyticsBanner` (`RetailOpsView`) | reverter PR 1D |
| **1E** | Ranking do fechamento responsivo + nome protegido no scan | `RetailOpsView` | reverter PR 1E |
| **2A** | Diretório de vendedores + lotação por loja | `RetailSellerDirectoryService` · `retail_seller_store_assignments` | reverter PR 2A |
| **2B** | Tela "Vendedores da loja" (cobertura/dar nome/lotação) | `RetailOpsView` · `GET /seller-coverage` | reverter PR 2B |
| **2C** | Escala por loja consumindo o roster | `RetailOpsView` (ScheduleTab) | reverter PR 2C |
| **2D** | Comissão explica a fonte + matrícula sem nome = pendência | `RetailCommissionService` | reverter PR 2D |
| **3A** | Tarifas POS crédito/débito + custo esperado | `RetailPosFeeService` · `retail_store_pos_fee_rules` | reverter PR 3A |
| **3B** | Componente único "Cota total da loja" | `RetailOpsView` (`StoreQuotaSummary`) | reverter PR 3B |
| **4A** | Catálogo resolvido na ingestão | `RetailPdvCatalogResolver` · colunas em `retail_pdv_sale_items` · `Scheduler` | reverter PR #1198 |
| **4B** | Resultado da Rede set-based + índice medido | `RetailStoreCostService` (`monthlyCogsBreakdownAll`/`allStoresResult`) | reverter PR #1199 |
| **4C** | Cache curto + envelope de erro correlacionado | `RetailAnalyticsCache` · `/api/health`... | reverter PR #1200 |
| **4D+4E** | Cancelamento/último snapshot na UI + precificação por item + correção do blowup sob carga | `useAnalytics` (`RetailOpsView`) · `RetailPricingService.applyBulk` | reverter PR #1201 |
| **5A** | Probe leve autenticado | `HealthProbeService` · `GET /api/health/ping` | reverter PR #1202 |
| **5B–5D** | 4 estados de conexão + diagnóstico + guardrail CONN-005 | `src/lib/connectivity.ts` · `App.tsx` | reverter PR #1203 |

---

## 2. Feature flags & rollback — a realidade (honesto)

O PDR **sugeriu** 8 flags de runtime (`retail_business_date_v1`, `retail_boleta_idempotency_v1`,
`retail_closing_mobile_v2`, `retail_seller_store_roster_v1`, `retail_pos_fee_detail_v1`,
`retail_financial_settings_atomic_v1`, `retail_analytics_resolved_products_v1`,
`connectivity_status_v2`).

**O que foi realmente entregue:** as correções são **aditivas e retrocompatíveis** e
foram para produção como **comportamento padrão seguro**, não atrás de toggles de
runtime. O mecanismo de rollback é **reverter o PR da fatia** (uma fatia = um PR;
cada um isolado). Dados são só ALTER aditivo (colunas/índices novos) — reverter o
código não perde dado nem quebra o legado.

Exceção de configuração: a data comercial usa `organization_settings.timezone`
(default `America/Sao_Paulo`) — não é liga/desliga, é o fuso da org.

### Kill-switches de runtime (Fase 6B) — as duas mudanças de maior risco

Para reverter no piloto **sem deploy**, por organização, as duas mudanças de
maior risco têm flag de runtime (DEFAULT LIGADO = comportamento novo; setar 0
volta pro legado). `RetailFeatureFlagService`:

| Flag (coluna em `organization_settings`) | Ligado (default) | Desligado (0) |
| --- | --- | --- |
| `retail_business_date_v1` | data comercial no fuso da org (Fatia 1A) | volta ao **dia UTC** (bug original) |
| `retail_analytics_resolved_products_v1` | analíticas consomem a coluna resolvida (4A/4B) | volta ao **LIKE-prefix por consulta** (lento, porém caminho antigo provado) |

Rotas (owner/admin): `GET /api/retailops/feature-flags` (estado) ·
`PUT /api/retailops/feature-flags/:key` com `{ "enabled": true|false }`
(`key` = `business_date` | `resolved_products`). Desligar invalida o cache
analítico da org. Equivalência numérica ligado × desligado provada em
`test:retail-feature-flags`.

> As demais fatias seguem no modelo de rollback por PR (§10) — são UI/bugfix que
> revertem limpo. Se a TOULON quiser kill-switch para alguma outra, é só pedir.

---

## 3. Pré-requisitos por loja (antes de ativar)

Antes de rodar o roteiro numa loja, confirme:

1. **Fuso** — se a loja opera fora de `America/Sao_Paulo`, gravar `organization_settings.timezone`. (TOULON é Rio → default já correto.)
2. **Vendedores × loja** — matrícula → nome e lotação mapeados na tela **Vendedores da loja** (2B). Matrículas sem nome aparecem como **pendência**; código único com muito volume vira suspeita de **caixa compartilhado** (não é pessoa) — usar lançamento manual/foto nessa loja.
3. **Tarifas do POS** — cadastrar crédito/débito por loja (3A). **Confirmar com a TOULON** a regra da "tarifa fixa" (por transação? mensal por terminal? por bandeira/parcela?) — §17 perguntas 1–3. Não assumir default.
4. **Escopo do usuário** — quem vai homologar tem papel **owner/admin** e escopo para a(s) loja(s) (ADR-173). O "não consigo salvar" do relato pode ser escopo (§17 pergunta 10).
5. **Código de filial Alterdata** — o `code` da loja bate com o `filial` que chega no PDV (§17 pergunta 5).

---

## 4. Estágios do rollout (§ PDR "Piloto controlado")

```
1. Avenida Brasil (baseline)  →  2. 2ª loja com vendedores mapeados  →
3. Expansão a todas as lojas  →  4. Monitoramento de 7 dias  →  5. Aceite formal
```

- **Não expandir** para todas as lojas antes de **duas lojas** concluírem o roteiro (DoD §18).
- Cada estágio: rodar o **roteiro de homologação** (§5), checar os **gates** (§6), registrar evidências (screenshots mobile/desktop, contagens antes/depois).

---

## 5. Roteiro de homologação por loja (o que testar)

Marcar cada item por loja. Todos reproduzem um sintoma do relato original.

- [ ] **Boletas após 21h** — abrir boletas, passar das 21h (fuso Rio), **recarregar** a página: a contagem é a MESMA (não zera). Duplo-clique não conta boleta duas vezes (1A/1B).
- [ ] **Resultado por loja / da rede** — abre com número; erro de servidor/timeout mostra **mensagem própria + "Tentar de novo"**, nunca "nenhuma loja com dados"; 403 diz "sem permissão" (1D/4D). p95 ≤ 2 s (§6).
- [ ] **Precificar** — lista abre; aplicar preço em lote mostra **quantos confirmaram** e oferece **retry dos que falharam** (nunca sucesso otimista) (4E).
- [ ] **Mais vendidos** — abre; item sem match no catálogo aparece em âmbar com o código do ERP (não some) (4A/1D).
- [ ] **Salvar config financeira** (margem/custos) — salvar com sucesso confirmado; dois admins na mesma loja → o 2º recebe **409 conflito**, não sobrescreve em silêncio (1C).
- [ ] **Vendedores da loja** — cobertura correta; dar nome a uma matrícula pendente reflete na comissão; código compartilhado sinalizado (2B/2D).
- [ ] **Comissão** — bate com a fonte declarada; matrícula sem nome = pendência visível (2D).
- [ ] **Cota total da loja** — o mesmo componente na corrida e no fechamento; divergência vs cotas individuais é EXIBIDA, não ajustada em silêncio (3B).
- [ ] **Tarifas POS** — custo esperado usa a tarifa detalhada (crédito/débito), sem dupla contagem com a tarifa legada (3A).
- [ ] **Chip de conectividade** — derrubar o Wi‑Fi do tempo real (ou simular): o chip diz **"Tempo real reconectando — consultas e salvamentos continuam disponíveis"**, NÃO "a plataforma caiu". Clicar abre o diagnóstico (internet/API/tempo real/Alterdata/pendentes) (5B–5D).

---

## 6. Monitoramento de 7 dias — gates & onde olhar (§14 PDR)

| Métrica | Gate | Onde |
| --- | --- | --- |
| Resposta de **Resultado por loja** (p95) | **≤ 2 s** no volume da TOULON | tempo de carga da aba; `loadtest:retail-analytics` no ambiente-alvo |
| **Boletas** antes/depois do reload | contagem idêntica | roteiro §5 + relato dos operadores |
| **Persistência financeira** | zero `sucesso` sem resposta confirmada | logs; nenhum `.catch(()=>{})` em save financeiro |
| **Erros das telas analíticas** | 403/500/timeout distintos de "vazio" | roteiro §5; envelope `analytics_timeout`/`analytics_error` com `correlationId` |
| **Cache** | invalida após sync/fechamento/custo/preço | abrir tela após um fechamento → número novo, não velho |
| **Conectividade** | queda do WebSocket NÃO vira "servidor caiu" | chip = `realtime_degraded` com API `online` no diagnóstico |
| **Escopo/RBAC** | usuário fora de escopo é barrado no servidor | tentativa negativa retorna 403 |

Rodar o **teste de carga** (`npm run loadtest:retail-analytics`, com `STORES/PRODUCTS/ITEMS`
≥ ao volume da TOULON) num ambiente equivalente ANTES de expandir — ele prova o p95
das telas e a resiliência da precificação em lote.

---

## 7. Definition of Done (§18 PDR) — checklist de aceite

- [ ] Critérios de aceite P0 e P1 passam.
- [ ] Mesma contagem de boletas antes e depois do reload.
- [ ] Nenhum `.catch(() => {})` em persistência financeira obrigatória.
- [ ] Nenhum toast de sucesso sem resposta confirmada.
- [ ] Todas as lojas com **cobertura de vendedores documentada**.
- [ ] Matrículas pendentes e códigos compartilhados visíveis.
- [ ] Escala, fechamento, corrida e comissão usam o **mesmo vendedor canônico**.
- [ ] Tarifa POS com fórmula, origem, vigência e sem dupla contagem.
- [ ] Resultado/Precificar/Mais vendidos distinguem **erro de ausência de dados**.
- [ ] Performance atende ao gate (p95 ≤ 2 s) no ambiente-alvo.
- [ ] RLS/RBAC e escopo de lojas com testes negativos.
- [ ] Feature flags e rollback documentados (este runbook, §2).
- [ ] Screenshots mobile/desktop + métricas antes/depois + resultados das suítes anexados.
- [ ] **TOULON concluiu o roteiro em ≥ 2 lojas antes da expansão.**

---

## 8. Perguntas de homologação a fechar com a TOULON (§17 PDR)

Não bloqueiam as correções já entregues, mas precisam de resposta antes do aceite:

1. Tarifa "fixa" do POS: por transação, mensal por terminal, ou outra?
2. Vale só crédito, também débito, varia por parcela/bandeira?
3. Nome correto do adquirente citado no áudio?
4. Dispositivo, navegador e horário em que as boletas aparentaram zerar?
5. Todas as lojas e seus códigos de filial Alterdata?
6. Existe cadastro mestre de vendedores na Alterdata ou só `CAI_USUARIO` nas vendas?
7. O mesmo vendedor atua em mais de uma loja? (presumido: **sim**)
8. Quais filiais usam código individual e quais usam caixa/login compartilhado?
9. O "PF" citado era P.A, peças, valor ou outro indicador?
10. Quem não conseguiu salvar tinha papel owner/admin e escopo de todas as lojas?

---

## 9. Riscos & mitigação no piloto (§16 PDR)

| Risco | Mitigação (já no código) |
| --- | --- |
| UTC vazar em outra rota | `BusinessTimeService` compartilhado + testes de virada do dia |
| Duplicar vendedor ao vincular a outra loja | Identidade canônica + tabela de lotação |
| Código compartilhado virar pessoa | Diagnóstico + confirmação humana (nunca auto-atribui) |
| Dupla tarifa de cartão | Precedência detalhada > legada (nunca soma) |
| "Otimização" mudar valores | Teste de equivalência antes/depois (`test:retail-store-result-setbased`) |
| Cache mostrar dado velho | Invalidação por sync/fechamento/custo/preço (`test:retail-analytics-cache`) |
| WebSocket = falso alarme de servidor | Estados + probe separados (`test:connectivity`) |
| Backfill travar o banco | Lotes pequenos no Scheduler (`limit` por passe) |
| Salvar financeiro offline sem confirmar | Rascunho local + retry explícito; financeiro nunca no outbox silencioso (`test:connectivity` guardrail CONN-005) |

---

## 10. Rollback (procedimento)

1. **Escopo do problema** — identificar a fatia pela tabela §1.
2. **Reverter o PR** da fatia (`Revert` no GitHub ou `git revert <merge>`), abrir PR de revert, CI verde, merge. Como cada fatia é isolada e aditiva, o revert não afeta as outras nem perde dado.
3. **Colunas/índices** aditivos podem permanecer (inertes) — não precisam de down-migration; o código revertido simplesmente não os usa.
4. **Config** — se o problema for de fuso, ajustar `organization_settings.timezone` da org (não exige deploy).
5. Registrar no checklist de homologação o que foi revertido e por quê.

---

## 11. Critério de encerramento da Fase 6

Fase 6 encerra quando: (a) ≥ 2 lojas passaram o roteiro §5, (b) os gates de 7 dias §6
se mantiveram, (c) a DoD §18 está toda marcada, e (d) a TOULON deu **aceite formal**.
A partir daí, expansão a todas as lojas segue o mesmo roteiro por loja.
