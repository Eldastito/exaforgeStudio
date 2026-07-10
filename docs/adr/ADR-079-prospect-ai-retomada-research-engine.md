# ADR-079 — Retomada do Prospect AI + AutoProspect Research Engine

**Status:** Aceito (implementação em fases A–E, ver plano abaixo).

**Origem:** PRD "ZapFlow Prospect AI + AutoProspect Research Engine v1.0". O ADR-077 congelou o módulo `prospect` como experimental por falta de gatilho de negócio, registrando: "quando o gatilho existir — hipótese específica testável — o custo de retomar é linha reta". O PRD é esse gatilho: transforma o Prospect AI no módulo principal de prospecção com um motor interno de experimentação (inspirado no método do `karpathy/autoresearch`: baseline → hipótese → experimento → métrica → decisão keep/discard → aprendizado acumulado).

Este ADR **supersede parcialmente o ADR-077**: retoma o desenvolvimento ativo do módulo, mas mantém o gate de ativação por organização até o fim da Fase C.

---

## Contexto

### O que o inventário mostrou (antes de escrever código)

O PRD assume greenfield, mas o módulo já existe (~2.300 linhas): `ProspectService`, `ProspectDiscoveryService`, `ProspectView`, rotas `/api/prospect` e 11 tabelas `prospect_*` em `db.ts`. Cobertura atual frente ao MVP do PRD:

| Bloco do PRD | Estado no código |
|---|---|
| Fontes com proveniência (`prospect_sources`) | ✅ `prospect_data_sources` (com `terms_profile`, `retention_policy`) |
| Leads/empresas (`prospect_leads`) | ✅ `prospect_accounts` + `prospect_contacts` (account-cêntrico, dedup, opt-out) |
| Score explicável (`prospect_scores`) | ✅ `prospect_score_snapshots` (5 dimensões + `explanation_json`, determinístico) |
| Campanhas + aprovação | ✅ `prospect_campaigns` + `prospect_outreach` (`draft → pending_approval → approved → sent`) |
| Importação CSV + dedup | ✅ `importRecords` |
| Hipóteses de dor com evidência | ✅ `prospect_signals` + `prospect_hypotheses` (IA, aprovação humana) |
| Descoberta por região | ✅ OSM/Overpass + Google Places API oficial, scheduler noturno |
| Atribuição de receita | ✅ `recordOutcome` + `attributionSummary` |
| **Envio real + rastreio de resposta/reunião** | ❌ `sent` é marcado à mão; não há conceito de "respondeu" |
| **Experimentos A/B + decisão + memória** | ❌ Não existe nada do Research Engine |
| **Auditoria e RBAC nas rotas do prospect** | ❌ Zero `logAuthEvent`; qualquer `agent` aprova abordagem |
| **Dashboard + integração RIC** | ❌ Não existe |

### Restrições da plataforma que o PRD ignora

- **Não há RLS de banco** (SQLite/better-sqlite3): isolamento é `WHERE organization_id = ?` em código + testes (`test-tenant-isolation.ts`) + varredura do `SecurityAuditService`.
- **Não há ferramenta de migração**: schema evolui em `db.ts` com `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` idempotente.
- **Não há event bus interno** (webhooks de saída são stub); cada módulo registra seus eventos em tabela própria.
- **Gating de módulo já existe** (`ModuleService.isEnabled('prospect')` + planos) — uma flag `prospect_ai_enabled` paralela criaria duas fontes de verdade.
- **Ponto único de IA é `llm.ts`** (`chat()` com custo por org em `ai_usage_log`), não o `AIOrchestratorService` (que é o agente conversacional).

### Referências externas avaliadas

- **`gosom/google-maps-scraper`** — scraper Go + Playwright do Google Maps (36 campos, e-mails raspados de sites). Exige proxies rotativos, tem risco declarado de bloqueio e de violação de ToS, e coleta de e-mail em massa sem base legal clara (LGPD). O ZappFlow já resolve a mesma necessidade com OSM (dado público) + Google Places API oficial com chave do tenant (`terms_profile: licensed`).
- **`karpathy/autoresearch`** — agente que muta `train.py`, treina 5 min, mede `val_bpb`, decide keep/discard (~100 experimentos/noite). Funciona porque a métrica é barata, imediata e sem efeito colateral. Prospecção inverte tudo: métrica custa dinheiro/reputação, feedback em dias, ~1–2 experimentos/mês por tenant, restrição legal por mensagem. O valor transferível é o **método**, não o código.

## Decisão

### D1. Evoluir o modelo existente; não criar o modelo paralelo do PRD

As tabelas da seção 9 do PRD (`prospect_leads`, `prospect_scores`, …) **não serão criadas**. O modelo account-cêntrico atual permanece a fonte de verdade e recebe apenas adições: `prospect_message_variants`, `prospect_experiments`, `prospect_experiment_results`, `prospect_learning_memory` e `prospect_events` (padrão `id TEXT PRIMARY KEY`, `organization_id TEXT NOT NULL`, índice `idx_<tabela>_org...`).

### D2. Descoberta continua em fontes oficiais; scraper não entra no código

O `gosom/google-maps-scraper` **não é embutido nem vendido**. Aproveitamos dele apenas:

1. o **catálogo de campos** como guia de enriquecimento via Places API oficial — em particular o **texto das avaliações** (a API retorna até 5) vira `prospect_signal` de dor, alimentando as hipóteses;
2. um **preset de mapeamento de importação**: tenant que rodar a ferramenta por conta própria importa o CSV via `importRecords` com `provider: 'scraper_external'`, assumindo a responsabilidade de conformidade registrada na fonte.

### D3. Research Engine = método autoresearch adaptado, com três regras invioláveis

1. **Orçamento fixo pré-declarado** (análogo aos 5 min de wall clock): todo experimento nasce com `sample_size` e janela de tempo fixos e regra de parada definida a priori. O serviço bloqueia declarar vencedor antes do fim do orçamento — sem "espiar" resultado parcial.
2. **Uma variável por experimento**: varia a mensagem OU o canal OU o nicho, nunca mais de um — sem isso o aprendizado não tem atribuição causal.
3. **Champion/challenger com baseline preservada**: a variante vencedora vigente de um segmento é o champion permanente; experimentos novos a desafiam e só a substituem com vitória estatisticamente válida (teste de duas proporções com limiar explícito). **`inconclusive` é a decisão default** — amostras de 50×50 com taxas de resposta de 5–15% raramente são conclusivas, e memória com ruído é pior que memória vazia.

### D4. Memória de aprendizado estritamente por tenant

O `scope: global` da `prospect_learning_memory` do PRD **fica fora do MVP**. Agregação entre tenants cruza a fronteira de isolamento que é critério de aceite do próprio PRD; se um dia entrar, será anonimizada e com ADR próprio.

### D5. Sem flag nova, sem event bus

- Gating continua por `ModuleService` (`enabled_modules` + planos). O módulo permanece **opt-in por organização** (regra do ADR-077) até o fim da Fase C; GA/reativação de default é decisão futura, org a org.
- Eventos do PRD (`lead.created`, `message.sent`, `lead.replied`, `meeting.created`, `experiment.*`) são gravados em `prospect_events` — que também é a fonte das métricas de experimento. Bus/pub-sub é otimização futura.

### D6. Plano de implementação em fases (substitui as Fases 1–7 do PRD)

- **Fase A — Conformidade (primeiro PR de código):** `logAuthEvent` em toda mutação do prospect; `requireRole("owner","admin")` em aprovação/status/config (perfis do PRD mapeados: Supreme Admin → `requireMasterAdmin`, Admin/Gestor → `owner`/`admin`, Vendedor → `agent`); endpoints de opt-out/bloqueio integrados ao padrão LGPD (`contact_consents`); limite de tentativas de contato; `scripts/test-prospect-isolation.ts`.
- **Fase B — Fechar o ciclo de execução/medição:** outreach `approved` → envio real via `MessageProviderService` (WhatsApp/Instagram) e `GoogleOAuthService.gmailSend` (e-mail), emitindo `message.sent`; captura de resposta correlacionando mensagem de entrada (`webhookProcessor` + `phoneMatch`) ao `prospect_contact` → `lead.replied`; registro de reunião → `meeting.created`; conversão lead → contato CRM + ticket no Kanban (`tickets.stage`), sem estrutura nova de card.
- **Fase C — Research Engine:** tabelas de D1, alocação de leads a variantes, métricas a partir de `prospect_events`, decisão keep/discard/inconclusive conforme D3, análise via `chat()` com prompt versionado (prompt-base da seção 12 do PRD, com `model_version` gravado).
- **Fase D — Memória e recomendação:** `prospect_learning_memory` (D4), `suggest-hypotheses`/`recommend-next-action` evoluindo o `sdrCopilot`; telas Experimentos e Aprendizados.
- **Fase E — Dashboard e RIC:** dashboard no padrão `src/features/rie/`; push de nichos/mensagens vencedoras e receita potencial para o `RevenueIntelligenceService`.

A dependência é estrita: **sem a Fase B não existe métrica, e sem métrica o Research Engine (C) não tem o que decidir.** A ordem não é negociável.

## Consequências

**Positivas:**

- O investimento novo concentra-se no diferencial (medição + experimentação + memória) em vez de reconstruir os ~60% que já existem.
- Conformidade primeiro (Fase A) elimina os riscos hoje reais: módulo sem auditoria e com aprovação de envio aberta a qualquer papel.
- Zero risco jurídico novo: descoberta permanece em fontes oficiais/públicas; scraping fica fora do produto e da promessa comercial.
- O champion/challenger faz a melhoria compor entre campanhas — a promessa central do PRD — sem depender de volume de experimentação que o domínio não tem.

**Trade-offs aceitos:**

- Menos campos de descoberta do que um scraper entregaria (aceito: ToS + LGPD + infra).
- `inconclusive` como default significa que muitos experimentos não produzirão aprendizado — correto e comunicado na UI, ainda que comercialmente menos "mágico".
- Memória por tenant aprende mais devagar que memória global (aceito até haver ADR de agregação anonimizada).
- O nome-fantasia "AutoProspect Research Engine" é camada de produto; tecnicamente é o conjunto experimentos+decisão+memória dentro do módulo `prospect` — não nasce serviço separado.

## Testes

- `scripts/test-prospect-isolation.ts` (Fase A) — duas orgs, asserções de que contas, experimentos e aprendizados nunca vazam entre tenants (padrão de `test-tenant-isolation.ts`).
- Fase B: teste de correlação de resposta (mensagem de entrada → `lead.replied` no contato certo, nunca em outro tenant).
- Fase C: teste determinístico da regra de decisão (fixtures de resultados → keep/discard/inconclusive esperados, incluindo o caso "amostra insuficiente → inconclusive").
- Regressão: `test-rbac-audit` deve passar a cobrir os eventos de auditoria do prospect.
