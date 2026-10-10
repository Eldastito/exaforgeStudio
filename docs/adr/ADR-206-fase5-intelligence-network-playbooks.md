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

## 5. Plano (reordenado pela auditoria)
Ordem proposta: **F5.1** Knowledge Governance (validade, expirado, conflito, origem) · **F5.2** Arquétipos (catálogo + precedência) · **F5.3** Playbook Registry (versão, vertical, arquétipo, autonomia máxima, pré-condições) · **F5.4** escada única + shadow + regressão automática · **F5.5** avaliação/eficácia por versão e backtest de playbook (limitado pelo histórico disponível) · **F5.6** onboarding conversacional por arquétipo · **F5.7** aprendizado negativo estruturado · **F5.8** Strategic Policy com pesos · **F5.9** Product/Customer Intelligence + NBA (máx. 3 prioridades) · **F5.10** orquestração multi-competência atrás do FalaTu (via SkillOS Planner, não `MaestroService`) · **F5.11** biblioteca de playbooks em Empresa → IA · **BLOQUEADAS por D1/D6:** Intelligence Network e Benchmark entre empresas. **F5.12** piloto/certificação TOULON (+ 2º cliente quando existir).
Cada fatia = 1 PR draft, flag opt-in, aditivo, teste com mutações.

## 6. Limites desta F5.0
Documento apenas. Nada foi medido com dado real. Alguns serviços (†) foram avaliados por cabeçalho, não por leitura integral. Não houve acesso à base de produção.
