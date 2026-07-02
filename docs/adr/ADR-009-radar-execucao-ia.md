# ADR-009 — ZappFlow Radar de Execução IA (Fase 0 + Fase 1)

**Status:** Fase 0 (descoberta/decisões) e Fase 1 (fundação de dados e permissões) implementadas. Fases 2-5 (landing pública, painel do consultor, relatório/IA narrativa, CRM/WhatsApp/reavaliação) **ainda não implementadas**.

**Origem:** PRD externo "ZappFlow Radar de Execução IA v1" (diagnóstico de maturidade, vazamentos operacionais e oportunidades de IA), avaliado quanto à viabilidade de implementação no codebase real do ZappFlow.

## Contexto

O PRD recebido descreve um módulo comercial de entrada: diagnóstico guiado (rápido público + executivo consultivo) que mede maturidade em 7 pilares, calcula um "Índice de Gap de Execução", prioriza casos de uso de IA e converte o resultado em relatório + oportunidade no CRM. O documento foi escrito assumindo uma arquitetura de referência (Postgres/Supabase, RLS por tabela, Storage com links assinados, RBAC com 9 perfis, migrations versionadas com rollback) que **não corresponde à arquitetura real do ZappFlow**:

- Persistência: **SQLite único (`better-sqlite3`)**, arquivo compartilhado com o processo `vision-cloud` (WAL + `busy_timeout=5000`), não Postgres/Supabase.
- Isolamento multiempresa: coluna `organization_id` checada manualmente em cada query + `requireAuth`/`requireOrganizationAccess`, não RLS.
- "Migrations": blocos `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN` (idempotentes, sem rollback formal) executados no boot (`initDb()` em `src/server/db.ts`), não uma ferramenta de migração versionada.
- RBAC: `users.role` ad-hoc (`owner`/`admin`/`agent`), checado inline por rota — não existe um sistema de permissões granular com 9 perfis.
- Feature flags: dois mecanismos reais — `ModuleService`/`verticals.ts` (liga/desliga módulo inteiro por org, todo-ou-nada) e `vision_feature_flags` (flag granular por org/site) — não um serviço de feature flag genérico estilo LaunchDarkly.
- Tokens públicos: não existe Supabase signed URL; o precedente mais próximo é `org_invitations` (token + hash + `expires_at` + `status`).

Nada disso invalida os objetivos de segurança do PRD (isolamento por tenant, expiração de link, trilha de auditoria, score determinístico) — só a forma de alcançá-los precisa seguir os padrões já em produção no ZappFlow.

### Achado relevante: sobreposição com Revenue Intelligence

Parte do "motor de score/ROI/relatório" do PRD **já existe em produção**, sob o guarda-chuva "Revenue Intelligence Center" (`RevenueIntelligenceService`, `RevenueAuditService`, `RevenueSimulatorService`, `ExecutiveAdvisorService`):

- `RevenueIntelligenceService` já calcula um score 0-100 ("IQR") a partir de drivers ponderados + perda estimada de receita — conceitualmente próximo do Índice de Gap de Execução do PRD (§8), hoje limitado ao pilar comercial.
- `RevenueAuditService` já monta um relatório estruturado em seções, pronto para virar PDF.
- `RevenueSimulatorService` já implementa cenário conservador/provável (histórico real quando há ≥30 amostras, senão premissas explícitas com *guardrail* declarado) — o mesmo padrão de cenários exigido no PRD §10.
- `ExecutiveAdvisorService` já narra planos de ação a partir de dados determinísticos, com guardrail "nunca inventar números" — o mesmo papel do "AI Narrative Service" do PRD §11.
- `LgpdService`, `ReportPdfService`, `CadenceService`, `Scheduler.ts` cobrem retenção/anonimização, geração de PDF, follow-up e agendamento por data, respectivamente.

**Decisão de escopo:** o Radar não deve duplicar esses motores. Nesta Fase 1 ele cobre o que é genuinamente novo (os 7 pilares além de receita, o questionário multi-pilar, o motor de priorização de casos de uso). Integração com `RevenueIntelligenceService` para pré-preencher/validar o pilar "Receita e Atendimento" de tenants já ativos fica para uma fase futura (ver "Ideias adicionais" abaixo).

## Decisões tomadas

As perguntas de esclarecimento ao usuário falharam por instabilidade da ferramenta de UI (duas tentativas, mesmo erro). Diante disso, a implementação seguiu as opções recomendadas pela própria análise de viabilidade, documentadas aqui para revisão e possível correção:

| Decisão | Escolha | Razão |
|---|---|---|
| Destino do lead do diagnóstico rápido | **Adiado para a Fase 2** (não implementado nesta fase) | Fase 1 não inclui a landing pública nem criação de lead; a escolha entre `ProspectService` (pipeline B2B, recomendado) e `tickets`/Kanban de atendimento fica para quando a Fase 2 for implementada. |
| Nível de RBAC | **Simplificado**: owner/admin administram sessões (criar/editar/recalcular/concluir); qualquer usuário autenticado da organização pode responder perguntas | Hoje só existem 3 roles ad-hoc no projeto inteiro; os 9 perfis do PRD (Consultor, Analista, Gestor de conta etc.) exigiriam um sistema de RBAC formal que não existe em nenhum outro módulo — implementá-lo só para o Radar seria inconsistente e prematuro sem uso real desses papéis. |
| Escopo desta rodada | **Fase 0 (este documento) + Fase 1 (fundação)**: schema aditivo, gate de módulo, motor de score determinístico, endpoints internos autenticados, auditoria, seed de template + catálogo, teste de isolamento. **Sem UI, sem rotas públicas, sem IA generativa, sem PDF, sem CRM bridge.** | Reduz o raio de impacto de uma única mudança nesta base de código real em produção; cada fase seguinte é fatiável e testável isoladamente. |

## O que foi implementado (Fase 1)

### Schema (`src/server/db.ts`)
Bloco aditivo `CREATE TABLE IF NOT EXISTS` (mesmo padrão do resto do arquivo): `radar_templates`, `radar_questions`, `radar_sessions`, `radar_respondents`, `radar_answers`, `radar_pillar_scores`, `radar_use_case_catalog`, `radar_recommendations`, `radar_consent_records`. Nenhuma tabela existente foi alterada; nenhum `DROP`/rename.

`organization_id` é **nullable** apenas nesta família de tabelas (exceção documentada no código) — reserva para sessões públicas pré-conversão da Fase 2. A Fase 1 **não exercita** esse caso: `RadarService.createSession` sempre grava `organization_id = req.organizationId` da sessão autenticada.

Seed idempotente (`INSERT OR IGNORE` com IDs fixos, não `randomUUID()`, para não duplicar a cada boot): 1 template global "Diagnóstico Rápido ZappFlow" com as 18 perguntas de escala 0-4 cobrindo os 7 pilares (adaptação do PRD §10 para perguntas diretamente pontuáveis), e o catálogo de 12 casos de uso do PRD §12.

### Gate de módulo (`src/server/verticals.ts`, `src/server/ModuleService.ts`)
Módulo opcional `"radar"` adicionado a `OPTIONAL_MODULES` e **excluído de todas as verticais**, inclusive "outro" — mesmo padrão já usado por `"vms"` (opt-in explícito, PRD §3 regra 4 / `ai_execution_radar_enabled`). `MODULE_BY_ROUTE.radar = "radar"` garante que o gate server-side (`server.ts`, middleware existente) bloqueia `/api/radar/*` para qualquer organização que não tenha o módulo ligado.

Kill-switch global adicional (`AI_EXECUTION_RADAR_ENABLED=false` no ambiente) em `routes/radar.ts` — desliga o módulo para todas as organizações de uma vez, sem deploy, para o caso de incidente durante o piloto.

**Limitação conhecida:** a tela Configurações › Módulos (`src/features/SettingsView.tsx`) mantém sua própria lista espelhada e não inclui `"radar"` ainda — ativar o módulo para uma organização piloto hoje exige uma chamada direta a `PATCH /api/analytics/settings` (ou script) incluindo `"radar"` em `enabled_modules`. Adicionar a entrada na UI de Configurações fica para quando a Fase 2/3 trouxer uma tela do módulo para justificar o toggle.

### Motor de score (`src/server/RadarService.ts`)
Determinístico e versionado (`SCORING_VERSION`), sem qualquer chamada a LLM:
- Cada resposta de pergunta tipo `scale` tem `score_raw` 0-4 fixado por `options_json` (não calculado por IA).
- "Não sei" nunca vira 0 (usa o ponto médio 2, com confiança reduzida a 0,5) — regra explícita do PRD §6.3.
- Grau de confiança por resposta (PRD §7.4): 0,60 (declarada sem evidência) ou 0,75 (declarada + comentário/explicação). Os níveis 0,90/1,00 (evidência anexada/baseline medido) ficam reservados para quando `radar_evidence` existir (Fase 3/4) — não implementados aqui para não fingir uma evidência que o sistema ainda não coleta.
- Score por pilar = média ponderada das respostas daquele pilar, normalizada para 0-100. Pilares sem nenhuma resposta são **excluídos e os pesos renormalizados** (nunca tratados como "0"), para não inflar artificialmente o gap antes do questionário estar completo.
- Score geral = soma ponderada dos 7 pilares (pesos do PRD §6, somam 100).
- Nível de maturidade pelos limiares do PRD §7.2 (Inerte/Experimental/Organizando/Integrada/Inteligente).
- `execution_gap_index` fica **`NULL` nesta fase** — depende de `radar_processes` (matriz impacto/recorrência/urgência/prontidão declarada pelo consultor), que é conteúdo da Fase 3 (diagnóstico executivo). Calcular uma versão simplificada agora seria inventar um número sem lastro nos dados que o PRD define para essa métrica.
- Motor de priorização de casos de uso (PRD §9.3) adaptado: como a matriz de processos da Fase 3 ainda não existe, os componentes de impacto/prontidão usam os **scores de pilar da própria sessão** como proxy explícito (documentado em código, não uma "opinião" da IA) — ex.: `businessImpact = 100 - score(pilar_principal_do_caso_de_uso)`.

Toda ação relevante (criação/início/conclusão de sessão, resposta salva, score calculado, recomendação gerada, consentimento concedido/revogado) gera um evento em `auth_audit_logs` com `event_type` no namespace `radar_*` do PRD §24 — reaproveita a tabela de auditoria ativa mais próxima em vez de criar uma nova só para o módulo.

### API (`src/server/routes/radar.ts`, registrada em `server.ts`)
Subconjunto autenticado do PRD §14.2 (sem rotas públicas — Fase 2): `GET /templates`, `GET /templates/:id`, `GET /catalog/use-cases`, `GET/POST /sessions`, `GET/PATCH /sessions/:id`, `POST /sessions/:id/consent`, `POST /sessions/:id/answers`, `POST /sessions/:id/recalculate`, `POST /sessions/:id/complete`.

### Teste (`scripts/test-radar-isolation.ts`, `npm run test:radar-isolation`)
Segue o padrão de `scripts/test-tenant-isolation.ts` (banco temporário, sem afetar produção). Confirma: módulo desligado por padrão mesmo na vertical mais permissiva; isolamento cross-tenant de sessões/respostas; determinismo do motor de score (recalcular sem mudar respostas dá o mesmo resultado); "não sei" não zera o score; eventos de auditoria gravados. 18/18 verificações passam. O teste de isolamento pré-existente (`npm run test:isolation`) continua passando (13/13) sem alterações.

## Não implementado nesta fase (deliberadamente)

- Landing pública / diagnóstico rápido sem login (`/radar-ia`), tokens públicos, criação de lead — Fase 2.
- Painel do consultor, múltiplos respondentes por sessão, upload de evidências, `radar_evidence` — Fase 3.
- Relatório PDF/web, narrativa por IA generativa, redaction de PII, JSON Schema de saída, aprovação humana configurável — Fase 4.
- Bridge com CRM/Kanban, automação de WhatsApp/e-mail, reavaliação agendada — Fase 5.
- UI de qualquer tipo (sem tela no ZappFlow ainda) — chegará junto com a Fase 2/3.

## Ideias adicionais para fases futuras (não implementadas)

1. Pré-preencher o pilar "Receita e Atendimento" de tenants já ativos com dados reais do `RevenueIntelligenceService` (tempo de resposta, follow-up, conversão medidos) em vez de perguntar — parte do score vira medido, não declarado, subindo a confiança sem esforço do usuário.
2. Separar claramente dois modos de sessão desde o modelo de dados quando a Fase 2 chegar: `lead_diagnosis` (pré-venda, sem tenant, alimenta funil de vendas) vs. `tenant_diagnosis` (cliente ativo, medição contínua pós-implantação).
3. Anti-spam/anti-bot (honeypot + rate limit) na rota pública da Fase 2, já que captura de lead pública é alvo natural de spam.
4. Card do "Radar Score" no painel executivo já existente do tenant, reaproveitando UI em vez de criar uma ilha nova.
