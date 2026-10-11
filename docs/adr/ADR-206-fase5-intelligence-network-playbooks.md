# ADR-206 — ZapFlow Fase 5: Intelligence Network, Playbooks Verticais e Escala Multiempresa

Status: **F5.0 FECHADA (doc-only, 2026-10-10).** Nenhuma fatia de código autorizada ainda — aguarda as decisões D1–D6 (seção 4).
Análise: `docs/prd/ANALISE-PRD-FASE5-vs-CODEBASE.md`.

## 1. Contexto
O PRD da Fase 5 propõe transformar conhecimento validado em playbooks reutilizáveis, inteligência vertical e gestão multioperação. A auditoria mostrou que todos os 15 blocos têm base parcial no código e que três deles contradizem decisões registradas (ADR-166 §79, ADR-199 RN-GRP-01, ADR-204 D1). A Fase 4 continua sem piloto (ADR-205 §17).

## 2. Decisões de arquitetura propostas
- **Extensão, não motor novo (ADR-166 RN-EL-9/§184):** Knowledge Governance estende `PatternMemoryService` (+ reconcilia `ManagerSolution` e `skillos_rollout`); Playbook Registry estende `process_definitions`/`PlaybookEngine`; Arquétipo estende `RetailReplenishmentStrategyService` (generalizado como catálogo). FalaTu continua interface única.
- **Precedência explícita** `organization > archetype > vertical > platform`, implementada como UM resolvedor de configuração em camadas (hoje inexiste).
- **Escada única de autonomia** experimental → shadow → recommend → prepare → execute-dentro-de-limites (= Nível 3 atual; Nível 4 segue bloqueado). Nenhum playbook pula etapa. Rebaixamento automático permitido SÓ para baixo; subir exige humano.
- **Dado privado nunca sai da org.** Qualquer conhecimento que cruze organizações é agregado, anonimizado e com amostra mínima — e só após D1.

## 3. Guardrails (RN-F5-*)
RN-F5-1 org vence arquétipo vence vertical vence plataforma · RN-F5-2 conhecimento tem origem, escopo, status, validade · RN-F5-3 conflito de regra pergunta, nunca escolhe em silêncio · RN-F5-4 playbook versionado, histórico imutável · RN-F5-5 experimental não executa · RN-F5-6 shadow antes de qualquer autonomia · RN-F5-7 autonomia só desce sozinha · RN-F5-8 eficácia sempre com contexto (vertical, porte, n, confiança), nunca só "78%" · RN-F5-9 benchmark entre empresas só com amostra mínima e sem identificação · RN-F5-10 RLS e isolamento preservados; grupo é agregação autorizada · RN-F5-11 confiança nunca "alta" enquanto o piloto não validar · RN-F5-12 nenhum módulo/menu redundante.

## 4. Decisões pendentes do dono
- **D1** Autorizar conhecimento/benchmark ENTRE clientes (revoga/emenda ADR-166 §79)? Exige contrato/aceite de contribuição + LGPD. *Recomendação: NÃO agora* — não há 2º cliente nem amostra; manter F5.6/F5.7 bloqueadas até ≥N organizações reais e base contratual.
- **D2** Fase 5 abre antes do piloto TOULON (Fase 3/4)? *Recomendação: só F5.1–F5.5, que não dependem de 2º cliente e não criam superfície nova.*
- **D3** "Auto" da escada = Nível 3 existente (executar dentro de limites), mantendo Nível 4 bloqueado?
- **D4** Rebaixamento automático de autonomia é permitido (só para baixo, com aviso ao dono)?
- **D5** Políticas herdáveis de grupo / shared services: emendar não-objetivos do ADR-199 ou descartar? *Recomendação: descartar nesta fase.*
- **D6** Quantas organizações reais mínimas para benchmark externo (k-anonimato)? Hoje 0 no banco do repositório.

## 4b. Decisões do dono (2026-10-10 — "siga as recomendações")
- **D1** NÃO autorizado: aprendizado/benchmark ENTRE clientes continua fora de escopo (ADR-166 §79 mantido). F5.6/F5.7 do PRD (rede e benchmark entre empresas) ficam BLOQUEADAS.
- **D2** A Fase 5 abre só com F5.1–F5.5 (sem 2º cliente, sem menu novo).
- **D3** "Auto" da escada = Nível 3 existente (executar dentro de limites); Nível 4 segue bloqueado.
- **D4** Rebaixamento automático de autonomia permitido, SÓ para baixo; subir exige humano.
- **D5** Políticas herdáveis de grupo / shared services: descartadas nesta fase.
- **D6** Sem benchmark entre empresas, não há mínimo a definir agora (segue em aberto até D1 mudar).

## 5. Plano (reordenado pela auditoria)
Ordem proposta: **F5.1** Knowledge Governance (validade, expirado, conflito, origem) · **F5.2** Arquétipos (catálogo + precedência) · **F5.3** Playbook Registry (versão, vertical, arquétipo, autonomia máxima, pré-condições) · **F5.4** escada única + shadow + regressão automática · **F5.5** avaliação/eficácia por versão e backtest de playbook (limitado pelo histórico disponível) · **F5.6** onboarding conversacional por arquétipo · **F5.7** aprendizado negativo estruturado · **F5.8** Strategic Policy com pesos · **F5.9** Product/Customer Intelligence + NBA (máx. 3 prioridades) · **F5.10** orquestração multi-competência atrás do FalaTu (via SkillOS Planner, não `MaestroService`) · **F5.11** biblioteca de playbooks em Empresa → IA · **BLOQUEADAS por D1/D6:** Intelligence Network e Benchmark entre empresas. **F5.12** piloto/certificação TOULON (+ 2º cliente quando existir).
Cada fatia = 1 PR draft, flag opt-in, aditivo, teste com mutações.

## 6. Limites desta F5.0
Documento apenas. Nada foi medido com dado real. Alguns serviços (†) foram avaliados por cabeçalho, não por leitura integral. Não houve acesso à base de produção.

## 7. Status F5.1 — MERGED (#1883) (Knowledge Governance, 2026-10-10)
Estende o `PatternMemoryService` (motor único, RN-F5-12) — sem tabela nova, sem menu novo, sem tela.
- **Validade** (`valid_from`/`valid_until`, colunas aditivas em `business_patterns`, NULL = sem prazo = 0-regressão): só uma PESSOA define (rótulo de sistema recusado), só em regra CONFIRMADA; datas `AAAA-MM-DD` validadas; mudança no histórico append-only (`decision='validity'`) e na auditoria; revogar a decisão limpa o prazo.
- **Expirado** é estágio DERIVADO (`stageOf`): regra confirmada com prazo vencido deixa de valer e sai de "regras" no `/memory` (lista própria `expired`, com aviso). Nunca grava status; hipótese não expira.
- **Conflito** (RN-F5-3): duas regras confirmadas e em vigor, mesmo domínio+escopo+tipo, chaves diferentes → PERGUNTA "qual está vigente?" (sinal `memory/rule_conflict` no `business_signals`, publicado no `learn`, resolvido sozinho quando some). O sistema nunca escolhe; resolver = uma pessoa dá prazo ou revoga. É heurística de "mesmo assunto" — pode haver falso positivo, por isso é pergunta, não bloqueio.
- **Proveniência** (`provenance`): origem (regra do sistema/IA/pessoa), quem e quando decidiu, prazo, evidência e histórico — só o gravado.
- Rotas: `POST /api/insights/patterns/:id/validity` (owner/admin), `GET /api/insights/memory/conflicts`, `GET /api/insights/patterns/:id/provenance`.
- Teste: `test:knowledge-governance` (52; 5 mutações verificadas — expiração, conflito por escopo, exigir regra confirmada, limpar prazo ao revogar). Regressão verde: `test:business-memory` 60, `test:pattern-memory` 19, `test:enterprise-learning-assured` 28, `test:assured-effectiveness` 12, `test:learning-episode` 17, `test:historical-evidence` 8, `test:learning-prior` 14, `test:retail-pattern-memory` 32.
- **Limites**: sem tela (validade e conflito só por API; a tela de Memória não mostra o prazo ainda); o conflito é por assunto (domínio+escopo+tipo), não semântico — dois detectores com tipos diferentes sobre a mesma coisa não conflitam; nenhum documento/planilha entra como fonte (a proveniência cobre só `business_patterns`); `refuted` segue declarado e nunca atribuído (ADR-166 achado c). Nada validado com dado real da TOULON.

## 8. Status F5.2 — MERGED (#1884) (Arquétipo Operacional + resolvedor em camadas, 2026-10-11)
Estende o que existe (`RetailReplenishmentStrategyService`, ADR-205 §19) — sem motor novo, sem tabela nova, sem menu novo.
- **Arquétipo** (`BusinessArchetypeService`): catálogo versionado em código com SÓ dois arquétipos, os que têm política real por trás: **Moda — coleção** (`collection_sellout`) e **Moda — reposição contínua** (`continuous_replenishment`). Petshop/clínica/beleza do PRD ficam FORA do catálogo até existir uma política que os diferencie (arquétipo sem política seria enfeite). Escolha da empresa em 1 coluna aditiva `organization_settings.business_archetype` (NULL = nenhum).
- **Precedência explícita** (RN-F5-1): organização > arquétipo > vertical > plataforma. `resolve` devolve o valor E a camada de onde veio (`layers`), nunca em silêncio. A camada "vertical" existe mas está vazia (nenhuma vertical tem default próprio dessa política hoje). Valor inválido numa camada é ignorado.
- **Efeito real**: `RetailReplenishmentStrategyService.strategy()` passou a usar o resolvedor — sem escolha própria da empresa, vale o arquétipo; sem arquétipo, é exatamente o comportamento de antes (0-regressão). A escolha da empresa (toggle "Fim de coleção") continua vencendo o arquétipo.
- **Escolher o arquétipo**: só PESSOA (rótulo de sistema recusado), só entre os que cabem na vertical da empresa (moda/varejo), NÃO sobrescreve nada que a empresa já configurou, auditado (`BUSINESS_ARCHETYPE_SET`). Pergunta guiada ("repõe as mesmas peças ou trabalha por coleção?") só aparece quando a vertical tem arquétipos e a empresa ainda não escolheu.
- Rotas: `GET /api/retail-ops/archetype` (arquétipo, pergunta pendente, cada política com a origem do valor) e `PUT /api/retail-ops/archetype` (escopo de rede, como a estratégia de reposição).
- Teste: `test:business-archetype` (42; 5 mutações verificadas — ordem das camadas, checagem de vertical, rótulo de sistema, pergunta que não some, valor inválido). Regressão verde: replenishment-strategy 19, replenishment 18, floor-replenishment 13, retail-pattern-memory 32, stock-negative-clarity 19, knowledge-governance 52, business-memory 60.
- **Limites**: só API (nenhuma tela escolhe o arquétipo; o toggle "Fim de coleção" segue sendo a tela existente); catálogo com 1 política — o resolvedor é genérico, mas só uma política passa por ele; "moda"/"varejo" são tratadas como aplicáveis (não confirmei qual vertical a TOULON usa no banco de produção); onboarding conversacional por linguagem natural NÃO foi feito (isso é a F5.6 do plano). Nada validado com dado real.

## 9. Status F5.3 — EM PR (Playbook Registry versionado, 2026-10-11)
Estende `process_definitions`/`ProcessRuntimeService` — sem motor novo, sem tabela nova, sem menu novo (RN-F5-12).
- **Registry** (`PlaybookRegistryService`): catálogo de PLATAFORMA, em código, versionado e imutável (mudou o playbook → nova entrada id+versão, nunca edição), que DESCREVE os 3 playbooks que já existem (cobrança, recuperação de vendas, fechamento diário de loja): vertical, arquétipo, risco, autonomia máxima, pré-condições, métrica de sucesso, estágio (experimental|validated|certified) e a evidência do estágio. A execução segue 100% no runtime atual.
- **Honestidade do estágio**: os 3 são `validated` (testes automatizados + produção), NENHUM `certified` — certificar exige piloto com dado real, que não rodou; o `lint()` do catálogo recusa `certified` enquanto isso. Teto de autonomia nunca passa de `execute` (Nível 3, D3).
- **Regras**: `canRun` respeita o teto e não deixa playbook experimental passar de `suggest` (RN-F5-5) — é CONSULTA, não está ligada ao `startForSubject` (0-regressão; quem decide usar é o chamador). `fits` por vertical/arquétipo: vertical/arquétipo desconhecidos da empresa NÃO casam com lista restrita (não chuta).
- **Eficácia por versão** (RN-F5-8): derivada por query das instâncias reais por versão de definição da empresa — concluídas/(concluídas+falhas), canceladas e em andamento ditas à parte, n + banda de Wilson + confiança + vertical; sem instância concluída/falha → null (nunca 0%); 1/1 não vira "alta confiança".
- `forOrg`: o que existe, se cabe, se a empresa adotou, e se a autonomia da definição dela passa do teto do catálogo (sinaliza, não corrige — rebaixar é F5.4).
- Rota: `GET /api/runtime/playbook-registry` (catálogo + situação da empresa; mesmo gate/RBAC do runtime).
- Teste: `test:playbook-registry` (32; mutações verificadas — experimental, teto, completed+measured, taxa sem n; filtro por org derruba o teste por erro). 
- **Limites**: só API; nada validado com dado real; o catálogo cobre só os 3 playbooks existentes (a biblioteca de novos playbooks é F5.11); sem backtest (F5.5); sem registry em banco (o catálogo é código, publicar versão = deploy).
