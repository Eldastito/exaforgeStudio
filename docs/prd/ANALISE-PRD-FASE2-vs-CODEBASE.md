# Análise Comparativa — PRD ZapFlow Fase 2 (Arquitetura de Experiência, Simplificação Radical e Gestão Conversacional) × Codebase

**Escopo:** entregável da **F2.0** (doc-only). Prova, com evidência `arquivo:símbolo`, o que já existe no `main` (commit `91d9530c`, pós-S9) para que a Fase 2 seja **predominantemente LIGAR (frontend) + CORRIGIR (roteamento)**, não construir arquitetura nova. Cliente-piloto: TOULON.
**Método:** leitura do código + **probe executável** (19 frases do PRD §8/§45 rodadas contra o roteador real, em org de teste com 3 lojas) + auditoria das telas reais enviadas pelo dono (prints de 02/10/2026).

## 0. Conclusão executiva

1. **O PRD acerta a tese e a arquitetura-alvo — e ela já está desenhada e ~80% construída no BACKEND.** ADR-163 (Invisible UX, FECHADO) entregou `NavigationManifestService` (nav por necessidade: Hoje · Fala Tu · Executando · Resultados · Empresa + Explorar, por papel+plano), `FalaTuHomeService.home` (Hoje por exceção), `ExecutionResultsService.executing/results`, `UxTelemetryService`, a flag `organization_settings.simplified_navigation_enabled` e a rota `GET /api/entitlements/navigation-manifest`. O doc `docs/ux/ADR-163-F1-information-architecture.md` já mapeia **cada item do Sidebar → destino** (nada removido) e `docs/prd/SIDEBAR-UX-AUDIT.md` classifica MANTER/ESCONDER/FUNDIR/CONVERSAR.
2. **O que NÃO existe é o consumo no FRONTEND.** `grep` em `src/features`, `src/components`, `src/lib`, `src/store`: **nenhuma tela chama** `/api/entitlements/navigation-manifest`, `/api/falatu/home`, `/api/ux/executing`, `/api/ux/results` ou `/api/ux/telemetry` (só o `HelpOrb` consome `/api/ux/help*`). O comentário de `entitlements.ts:68` diz "Consumido pelo Sidebar quando `simplifiedNavEnabled`" — **não é verdade hoje**: `Sidebar.tsx` (215 linhas, ~40 entradas) segue 100% legado. O PRD está certo no diagnóstico.
3. **O ponto mais perigoso é o FalaTu, não a navegação.** O PRD faz do FalaTu a "porta principal"; o probe mostra que **a frase-âncora do PRD (R$ 180 mil de coleção) é roteada pelo FalaTu como `record_expense`** (§3.1) — em vez de análise de decisão — e que **9 de 19 frases obrigatórias não têm rota determinística** (caem no LLM aberto) — mais 1 que responde só parcialmente. Transformar o FalaTu em porta principal ANTES de corrigir isso amplifica um erro.
4. **Duas linhagens de navegação coexistem e precisam ser reconciliadas:** ADR-163 (5 superfícies + Explorar) e ADR-189 *Mission OS* ("Executando fundiu em Missões", `missionsNav` no manifesto; `Sidebar.tsx:71` mostra "Missões" quando `missionLayerEnabled`). O PRD pede "Executando"; a TOULON já vê "Missões" no menu (print). Decisão D1 abaixo.
5. **Regra inviolável do PRD (nada apagado, flag reversível, sem lógica duplicada) é compatível com tudo o que existe** — a flag e o manifesto já nasceram para isso.

## 1. Matriz PRD → código

Legenda: ✅ existe · ⚠️ parcial · ❌ não existe · 🔌 backend pronto, **frontend não consome**.

| PRD § | Pede | Estado | Evidência |
| --- | --- | --- | --- |
| §3 / §43 F2.1 | Nav 1º nível: Hoje, FalaTu, Executando, Resultados, Empresa, Explorar | 🔌 | `NavigationManifestService.forUser` (`primary[]`, `explore[]`, `moreInPlan`); flag `simplified_navigation_enabled` (`db.ts:8869`); `Sidebar.tsx` legado |
| §34 | Explorar com busca e grupos | ⚠️ | `explore[]` existe (só módulos `active`+visíveis); **sem busca nem grupos** (Vendas/Financeiro/…) |
| §4–§6 F2.2 | Hoje: cockpit por exceção, ≤3 prioridades, sem código técnico | 🔌 ⚠️ | `FalaTuHomeService.home` (`attention`, `todayLine`, `resolvedSinceYesterday`, `goals`) + `GET /api/falatu/home` (`falatu.ts:252`); **nenhuma tela**. Falta: meta da rede/vendido/atingimento, "lojas que precisam de atenção", teto de 3 e causa por prioridade |
| §6 | 4 níveis (técnico → incidente → consequência → decisão) | ⚠️ | S8 já tira `runtime`/`platform` das contagens do Insights (`routes/insights.ts`); `SignalLanguage.audience:"technical"`; **sem a camada "incidente→consequência" nem "Resolvido automaticamente hoje"** |
| §7–§8 F2.3 | FalaTu como interface universal + 10 frases obrigatórias | ⚠️ | `FalaTuAskService.classify` → `ExecutiveAdvisorService.ask` (que usa `ExecutiveQueryRouterService`). **Probe §3: 9/19 sem rota; 1 misroteada p/ gravar despesa; 1 misroteada p/ análise de decisão** |
| §9–§10 | Análise de decisão conversacional (R$180k, 30%/60d), sem fingir certeza | ⚠️ | S4b: `analisar_decisao`→`DecisionEngine.analyze` + parser (`ExecutiveDecisionTools.parse`), caixa não confiável vira risco. **Via Diretor IA/Gestor-WhatsApp funciona; via FalaTu não** (misroteado). Formato "O que sabemos/assumindo/cenário/risco/sugestão" só parcial |
| §11 | FalaTu: 1º nível Conversar / Para mim / Organizar / Mais | ❌ | `FalaTuView.tsx:302`: 9 abas planas (`inbox,ask,tasks,events,lists,memory,briefing,plugues,protocols`) |
| §12–§13 | Briefings (manhã/16h/noite) no FalaTu + continuação da conversa ("Por quê?") | ⚠️ | WhatsApp: `RetailDayBriefService` + `RetailAfternoonBriefService` + Tutor (Fase 1). **Sem briefing dentro do FalaTu; sem continuidade** (cada mensagem é avulsa — a auditar `FalaTuThreadService` na F2.3) |
| §14–§16 F2.4 | Executando: aprovação / em andamento / aguardando / concluído; Missão=Tarefa=Ação na UX | 🔌 ⚠️ | `ExecutionResultsService.executing` (+`assurance`); `MissionsView`, `TarefasView`, Radar de Execução, ações dos Insights — **4 telas independentes**; `/api/ux/executing` não consumida |
| §17–§19 F2.5 | Resultados: rede→lojas→equipe→financeiro→estoque, conclusão primeiro, drill "Entender" | 🔌 ⚠️ | `ExecutionResultsService.results`, `RetailDayBriefService.nightSnapshot` (rede/loja/semana/mês), `SellerDiagnosisService` (S5), `BusinessHealthService`; **sem tela-fachada** e sem "Entender" |
| §20–§21 | Dashboard → "Atendimento Digital"; KPIs só digitais | ⚠️ | `DashboardPanel.tsx:417` título "Performance de Atendimento"; menu ainda diz **"Dashboard"**; a taxa de conversão já é digital-only (Fase 1) — falta só o **rótulo** |
| §22–§23 | Revenue Intelligence e Relatórios descem p/ Explorar; KPIs-chave em Resultados | ✅ (mapa) | `ADR-163-F1` já os classifica 📊/🧭 |
| §24–§26 F2.6 | Empresa; Integrações/Canais com modo normal × avançado | ❌ | `AlterdataConnector*`/Integrações/Canais: telas técnicas únicas; **sem "status simples"** (🟢 conectada · última sync · produtos/vendas/estoque · "1 filial requer atenção") |
| §27 F2.7 | Operação da Rede: 19 abas → grupos | ❌ | `RetailOpsView.tsx:765` `TABS` com **19** itens planos (confere) |
| §28 | Fechamento: visão simples + conferência ao abrir | ⚠️ | `RetailClosingService`; Fase 1 consolidou fonte única (`RetailSalesPolicy`); UI ainda detalhada |
| §29–§30 F2.8 | Contexto corrente + role-aware (Owner/Gerente/Vendedor) | ⚠️ | RBAC + `RetailStoreScopeService` (ADR-173, trava de loja no servidor) + `ContextProjectionService` + manifesto por papel; **FalaTu não herda "loja corrente"** da tela |
| §31 | Coach de Vendas oferecido no momento certo | ⚠️ | `SellerGoalStreakService` (sinal "N-ésimo mês abaixo da meta") + `SellerDiagnosisService` (S5) + Sales Coach (ADR-202); **a oferta "Criar plano de desenvolvimento p/ X?" não existe** |
| §32–§33 | Central de Saúde/Insights/Radar e Diretor IA como motores | ✅ (mapa) | `ADR-163-F1` + `SIDEBAR-UX-AUDIT` |
| §35 | Busca/comandos no topo ("Pergunte ou procure") | ❌ | topo tem "Buscar leads ou tags…" (print) — busca de contatos, não de funcionalidade |
| §36 / F2.9 | Telemetria (acesso a módulos, Hoje→detalhe, FalaTu→intenção, Explorar, buscas sem resultado) | 🔌 | `UxTelemetryService` + `ux_telemetry_events` + `POST /api/ux/telemetry` (opt-in, LGPD-minimizada) e `LegacyReductionService` (gate **advisório**); **o frontend não emite nenhum evento** |
| §37 | Flag `simplified_navigation_enabled`, TOULON primeiro, legado intacto | ✅ | coluna existe (`db.ts:8869`), lida pelo manifesto; falta o **toggle de operador** (a auditar: `ModuleService`/Módulos) |
| §38–§40 | Sem rotas/lógica duplicadas; serviço de composição; 1 definição por indicador | ✅ (regra) | Fase 1 consolidou: `RetailSalesPolicy` (venda oficial), `FinancialLedgerService.tracking().cashBasis`, `RetailMonthlyGoalService`, `stockCapital.giroMeasured` (S9) |
| §41–§42 | Não inventar; "último dado confirmado às HH:MM"; confiança só quando muda a decisão | ⚠️ | `AfternoonBrief.dataAsOf/stale` ✅, `Metric` (`unknown/not_computed/estimate`) ✅, S9 ✅; **falta carimbo de frescor nas respostas do FalaTu/Hoje** |

## 2. O que a Fase 1 já deixou pronto para a Fase 2 (reuso direto)

- **Linguagem de gestor** (`SignalLanguage.presentSignal` — título/significado/ação/"o que acontece se eu clicar"), `UxPresentationService` (Decision Card + humanState/humanError), `SignalBriefService` ("Entendi o que aconteceu… Quer que eu execute?").
- **Exceções com dono** (`RetailExceptionSignalService`: sem escala, vendedores a identificar) → alimentam as prioridades do Hoje do PRD §4 sem código novo.
- **Rituais TOULON** (manhã/16h/noite) como read-models (`RetailDayBriefService`, `RetailAfternoonBriefService`) — o PRD §12 pede mostrá-los no FalaTu.
- **Honestidade de dado**: `giroMeasured` (S9), `capitalKnown`, `formatBRL` ("—"), alertas técnicos fora das contagens (S8).
- **Diagnóstico de vendedor** (`SellerDiagnosisService`) → o "Entender" do PRD §19 e a oferta de Coach do §31.

## 3. Evidência executável — probe do roteador (19 frases do PRD §8 e §45)

Rodado contra `FalaTuAskService.classify` (1º degrau do FalaTu) e `ExecutiveQueryRouterService.detect` (motor determinístico), em org de teste com lojas Grande Rio/Carioca/Bangu.

| Frase | FalaTu `classify` | Ferramenta determinística | Veredito |
| --- | --- | --- | --- |
| Como estão minhas lojas hoje? | open | `meta_do_dia` | ✅ |
| Quem não bate meta há dois meses? | open | `vendedores_abaixo_meta` | ✅ (`RetailQuestionTools.vendedoresAbaixoMeta(minMonths=2)`) |
| Quanto falta para a Grande Rio? | open | — | ❌ LLM aberto |
| Qual loja está com pior desempenho? | open | — | ❌ LLM aberto |
| Quem vendeu mais esta semana? | open | `vendas_por_loja` | ⚠️ (devolve por **loja**; a pergunta é por **vendedor** — `ranking_vendedores` existe mas exige a palavra "vendedor" na frase, `ExecutiveQueryRouterService:103`) |
| Tem problema no estoque? | open | — | ❌ LLM aberto (`divergencia_estoque` existe) |
| Quanto vendemos em dinheiro? | `cash_on_day` | `dinheiro_do_dia` | ✅ |
| Como fechou ontem? | (não classifica) | — | ❌ LLM aberto |
| **Estou pensando em comprar R$180 mil… 30% de entrada… 60 dias. Analisa para mim.** | **`record_expense`** | — | 🔴 **misrotea: o FalaTu entende "despesa de R$180.000" (a palavra "fornecedor" casa `EXPENSE_KW_RE`, `FalaTuAskService:134`)** |
| Como estão minhas lojas? | open | — | ❌ (sem o "hoje" cai no LLM) |
| Quanto a Carioca precisa vender hoje? | open | — | ❌ LLM aberto |
| Quem está no segundo mês sem bater meta? | open | `vendedores_abaixo_meta` | ✅ |
| Como foi a semana? | open | — | ❌ LLM aberto |
| Tem alguém abaixo da meta? | open | `metas_abaixo_cota` | ✅ |
| Qual foi a venda em dinheiro? | open | `dinheiro_do_dia` | ✅ |
| O que está acontecendo na Grande Rio? | open | — | ❌ LLM aberto |
| Posso comprar R$180 mil de coleção? | open | `simular_compra` | ✅ (§25 do PRD 7 — simples) |
| **Crie uma campanha para quem não compra há 90 dias.** | open | **`analisar_decisao`** | 🔴 **misrotea: pedido de campanha vira "análise de decisão" (regra `/(compr\|invest)/` + número, da S4b)** |
| Mostra os produtos parados. | open | — | ❌ LLM aberto (e **S9**: para a TOULON o "parado" é *não medido*) |

**Contagem:** 7 ✅ · 1 ⚠️ · **9 ❌ sem rota determinística** · **2 🔴 misroteadas** (a âncora do PRD e o pedido de campanha). Sem chave de LLM em produção as ❌ viram "não sei"; com LLM, respondem em texto livre **sem o gate determinístico** (RN "determinístico antes de LLM").

## 4. Achados críticos (o que o PRD não viu e que muda o plano)

1. **Ordem de entrega do §43 está invertida para risco.** O PRD começa pela navegação (F2.1) e põe o FalaTu na F2.3. Mas a nav promove o FalaTu a "porta principal" — e hoje ele erra a frase-âncora do próprio PRD. **Recomendação: corrigir o roteador do FalaTu primeiro** (backend puro, sem risco visual, testável em CI), depois o casco de navegação.
2. **"Executando" ≠ "Missões".** O PRD §14–§16 reinventa o que o Mission OS (ADR-189) entrega (missão → plano reverso → próximo passo governado → checkpoint). Na TOULON "Missões" já está no menu. O correto é **Executando = fachada que compõe** `ExecutionResultsService.executing` + missões + tarefas + aprovações, com Missão/Tarefa/Ação como rótulos internos.
3. **Hoje não pode recalcular nada** (PRD §39) — o exemplo do §4 ("Meta da rede R$ 10.600 · Vendido até agora") depende do **parcial do PDV** (`dataAsOf`, pode estar atrasado) e da **meta do dia** (cota diária, que a TOULON ainda não cadastra — usa meta mensal). O cockpit precisa honrar §41: "último dado confirmado às HH:MM", e **não** inventar a "meta do dia" a partir da mensal (já recusamos isso na S6).
4. **§13 (continuar a conversa a partir do briefing) é a peça mais cara e menos pronta.** Exige contexto de conversa por usuário (qual loja/assunto o briefing citou). `FalaTuThreadService` existe mas **não foi auditado** para isso; é um risco de escopo — proponho fatia própria.
5. **Telemetria sem emissor.** O backend (`UxTelemetryService`) está pronto e o gate de aposentadoria é advisório, mas **nenhuma tela emite evento**; sem F2.9 junto da F2.1 não haveria base para a decisão do PRD §36 ("não remover sem evidência").
6. **Validação "mobile + owner + gerente + vendedor" do checklist** exige dados e perfis reais; no ambiente de desenvolvimento só dá para validar com **org de teste semeada** (Chromium/Playwright disponíveis). Evidência da TOULON real só com os prints do dono.

## 5. Plano proposto (reconcilia o §43 com a evidência)

Cada fatia = 1 PR draft, flag/rollback, teste em `scripts/test-*.ts`, runbook, **sem apagar nada**.

| Fatia | Entrega | Natureza | Risco |
| --- | --- | --- | --- |
| **F2.0** | Esta análise + ADR-203 | doc | nulo |
| **F2.1** | **Roteador de intenções do FalaTu**: corrigir os 2 misroteamentos; cobertura determinística das 9 ❌ + o ⚠️ reusando motores existentes (`ranking_vendedores` sem exigir a palavra "vendedor", `falta p/ meta da loja`, `divergencia_estoque`, `fechamento de ontem`, `semana`, `status da loja`, `pior desempenho`, `produtos parados`+S9); carimbo de frescor; "Criar campanha" → proposta governada (não análise) | backend | baixo (aditivo, testável em CI) |
| **F2.2** | **Casco de navegação** atrás de `simplified_navigation_enabled`: `Sidebar` consome o manifesto; Hoje/FalaTu/Executando/Resultados/Empresa + Explorar (busca + grupos); legado intacto; **emite telemetria** | frontend | médio (visível) — só TOULON |
| **F2.3** | **Hoje**: cockpit por exceção (rede + lojas a atenção + ≤3 prioridades com causa e verbo) compondo `FalaTuHome` + rituais + exceções + SignalLanguage; "Resolvido automaticamente hoje"; hierarquia técnico→incidente→consequência | front + fachada | médio |
| **F2.4** | **Executando**: fachada única (aprovar / em andamento / aguardando / concluído) sobre `ExecutionResultsService` + missões + tarefas | front + fachada | médio |
| **F2.5** | **Resultados**: rede→loja→"Entender" (compõe `nightSnapshot` + `SellerDiagnosis`); Dashboard renomeado "Atendimento Digital" | front + fachada | médio |
| **F2.6** | **Empresa** + Integrações/Canais **modo normal × avançado** (Alterdata: status simples; técnico preservado) | frontend | médio |
| **F2.7** | **Operação da Rede**: 19 abas → ~6 grupos (mesmos componentes, só agrupamento) | frontend | baixo |
| **F2.8** | **FalaTu 2º nível** (Conversar/Para mim/Organizar/Mais) + **contexto corrente + role-aware** + continuidade de conversa (§13) | front + back | alto → pode virar 2 fatias |
| **F2.9** | Telemetria + piloto TOULON: leitura do `LegacyReductionService`, decisão por evidência | operação | baixo |

**O que NÃO entra (PRD §47 / Fase 3):** autonomia extrema, execução financeira automática, modelos preditivos, negociação com fornecedor, remoção definitiva de módulos.

## 6. Decisões que dependem do dono (sem elas a F2.2+ trava)

- **D1 — "Executando" × "Missões":** a TOULON já vê "Missões". Proposta: Executando vira a fachada e Missões passa a ser uma seção dentro dela (a flag `missionsNav` já prevê isso). Confirma?
- **D2 — Ordem:** começar pela **F2.1 (FalaTu)** em vez da navegação, como recomendado em §4.1?
- **D3 — Rótulo do Dashboard:** "Atendimento Digital" ou "Vendas Digitais"? (o conteúdo é tickets/leads/IA/handoffs — não vendas do PDV; recomendo **Atendimento Digital**).
- **D4 — Meta do dia no Hoje:** a TOULON usa **meta mensal**; o Hoje do PRD mostra "Meta da rede R$ 10.600" (cota diária). Mostramos só meta mensal + parcial (honesto) ou você vai cadastrar cotas diárias?
- **D5 — Escopo do piloto:** a flag liga **só na org TOULON**, e você (Owner) valida desktop+mobile; Gerente e Vendedor ficam com org de teste. Aceita?
