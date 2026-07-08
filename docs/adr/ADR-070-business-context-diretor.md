# ADR-070 — BusinessContextService — raio-x do negócio para o Diretor IA

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de decisão já em código, sem ADR. O gestor manda um "Zap, como estamos?" no WhatsApp e espera uma resposta em uma tacada — não uma bateria de perguntas burocráticas ("de qual período?", "de qual funil?", "quer só receita ou incluir estoque?"). Para isso, o Orquestrador precisa entregar à IA, num único prompt, uma foto consolidada do negócio: CRM, funil, vendas, estoque, campanhas, agenda. É esse o papel do `BusinessContextService.build()`.

---

## Contexto

Sem esse serviço, o `AIOrchestratorService` teria dois caminhos ruins:

1. **Deixar a IA decidir quais queries fazer** — cadeia de tool-calls (`getFunnel`, `getCRM`, `getStock`, …) executada em série, cada uma com round-trip de LLM. Custa 5–10s por pergunta, gasta tokens em orquestração e permite à IA "esquecer" de olhar uma dimensão relevante.
2. **Chamar todos os serviços separados no orquestrador** — 20+ queries dispersas por `AIOrchestratorService.ts`, cada uma com try/catch próprio, com timestamps inconsistentes (o funil lido em `t`, o estoque em `t+300ms`, a agenda em `t+800ms`).

O `BusinessContextService` resolve os dois problemas concentrando **tudo que o Diretor IA precisa saber** numa única função `build(orgId)`. Ela é chamada de dois pontos hoje:

- `AIOrchestratorService.ts:156` — quando `isOrchestratorCommand=true` (mensagem do gestor no canal Zapp).
- `ExecutiveAdvisorService.ts:26,119` — no `ask` e `briefing` do Diretor Executivo IA (ADR do RIE consome o mesmo panorama).

O serviço é **read-only por contrato**: só lê e resume, nunca escreve. Isso é o que autoriza chamá-lo sem transação e sem confirmação — a IA nunca vai "acidentalmente" alterar dados por conta do panorama.

## Decisão

**Regras invioláveis do `BusinessContextService.build(orgId)`:**

1. **Uma única chamada síncrona** que devolve **texto formatado** (`string`), não JSON. O consumidor é uma LLM — texto plano em pt-BR economiza tokens e evita re-serialização. Cada bloco é uma linha com rótulo em CAIXA ALTA (`MÉTRICAS`, `FUNIL`, `CRM`, `PEDIDOS`, `ESTOQUE BAIXO/ESGOTADO`, `MAIS VENDIDOS`, `CAMPANHAS`, `PROSPECÇÃO`, `AGENDA`, `REVENUE INTELLIGENCE`, `FONTES DA PERDA`, `TOP COMPRADORES`).
2. **Cada bloco é isolado em try/catch com noop no erro.** Uma tabela ausente (org nova, feature desativada) não pode derrubar o panorama inteiro. Silêncio parcial é melhor que 500 no chat do gestor.
3. **Consolidação temporal.** Todos os blocos rodam na mesma invocação, então a foto é coerente — não há janela onde o funil foi lido antes e a receita depois de uma venda entrar.
4. **Reaproveita serviços canônicos** — `AnalyticsService.getMetrics` (ADR-068) e `RevenueIntelligenceService.getSnapshot` (RIC/RIE). O panorama não recalcula IQR nem receita: consome o que já é fonte de verdade.
5. **Formatação BRL determinística** — `Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })`. A IA cita o número como veio; não há espaço para arredondamento criativo.
6. **Rótulos com semântica de risco.** "Potencial em risco" (não "perda"), "recuperável" (não "garantido"). O prompt do Diretor IA aprende a repetir esses rótulos e não infla narrativa.
7. **Fallback explícito.** Se nenhum bloco produzir dado, retorna `"Ainda não há dados suficientes do negócio."` — não uma string vazia. A IA sabe distinguir "org sem dados" de "erro no panorama".

## Consequências

**Positivas:**
- Uma pergunta do gestor = uma leitura de banco + uma chamada de LLM. Latência típica < 1s de DB + tempo da LLM.
- IA recebe **contexto suficiente para responder sobre qualquer dimensão** sem precisar pedir outra rodada de tool-call.
- Fonte única do panorama: `ExecutiveAdvisorService` e `AIOrchestratorService` veem exatamente o mesmo texto, então briefing por e-mail e resposta no WhatsApp não divergem.
- Blocos isolados por try/catch tornam o serviço tolerante a schema drift (nova coluna, tabela removida em feature flag).

**Trade-offs aceitos:**
- **Recalcula tudo mesmo quando a pergunta é sobre uma só dimensão.** Se o gestor pergunta "como está o estoque?", ainda pagamos as ~12 queries. Aceito porque (a) o custo é dominado pela LLM, não pelo DB, e (b) o Orquestrador não sabe *a priori* qual dimensão a IA vai querer citar de tabela.
- **Sem cache.** Cada chamada bate no SQLite. Em orgs com milhões de linhas isso passa a doer; hoje as maiores rodam em < 200ms. Cache com TTL curto (30s) é o próximo passo se aparecer regressão de latência.
- **N+1 latente no funil e no CRM.** As queries são `GROUP BY` (não N+1 real), mas cada bloco é um round-trip separado ao SQLite. Consolidar num único `WITH` seria mais rápido em teoria; na prática o overhead é irrelevante e o custo de manutenção do SQL gigante não compensaria.
- **Blocos silenciosos em erro** escondem bugs. Se uma coluna some, o bloco simplesmente não aparece e ninguém percebe até o gestor reclamar. Não há métrica de "quantos blocos falharam nesta invocação" — deveria haver.
- **Sem TZ explícita nas queries** — `datetime('now')` e `datetime('now','-60 days')` do SQLite rodam em UTC. Para orgs no fuso São Paulo isso pode desalinhar o corte de "vendas de hoje" em até 3 horas. Aceito enquanto o produto for majoritariamente BR e o gestor tolerar essa margem; documentar em plano de i18n.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-business-context-service.ts`. O serviço é exercitado indiretamente pelos testes do `AIOrchestratorService` e do `ExecutiveAdvisorService`, mas ninguém valida o **shape do texto** — a IA é tolerante à ordem dos blocos, então bug de formatação passa batido.

**Lacunas honestas** que devem virar `scripts/test-business-context-service.ts`:
- Org sem nenhum dado → retorna a string de fallback (`"Ainda não há dados suficientes do negócio."`).
- Org com dado em todas as tabelas → cada rótulo em CAIXA ALTA aparece exatamente uma vez.
- Bloco isolado quebra (mockar `db.prepare` para lançar) → outros blocos continuam presentes; nenhum vaza `Error` no texto retornado.
- Formatação BRL: `R$ 1.234,56` (separador brasileiro), sem vírgula-ponto trocados.
- Determinismo: duas invocações consecutivas sobre a mesma base devolvem exatamente o mesmo texto (protege contra `Object.keys` de reducer com ordem indefinida no bloco de temperatura de leads).

Enquanto esses testes não existirem, qualquer refactor do `build()` exige revisão manual do prompt do Diretor IA para garantir que rótulos ainda batem com o que o LLM aprendeu a citar.
