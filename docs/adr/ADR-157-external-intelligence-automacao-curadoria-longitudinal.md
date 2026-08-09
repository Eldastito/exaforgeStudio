# ADR-157 — External Intelligence: automação da pesquisa, curadoria por IA e base longitudinal (evolução da ADR-156)

- **Status:** **Proposto** (2026-08-09) — aguardando aprovação do dono antes do código. Evolui a ADR-156 (External Intelligence de vertical compartilhada) do modelo **manual** (o admin cola) para um modelo **automático curado** (o ZapFlow pesquisa, um agente cura e publica sozinho), preservando **todos** os guardrails de anonimização/isolamento da ADR-156.
- **Data:** 2026-08-09
- **Origem:** PRD "ZapFlow Decision Intelligence Fabric 2.0" (External Intelligence / Agent-Reach — a parte de **descoberta automática** que a ADR-156 deixou como extensão futura). Decisões do dono (2026-08-09): (1) **curador publica sozinho** (fluxo 100% automático, o agente é o gate); (2) **usar a IA que já roda no repo** (`chat()`/`llm.js`) como provider, sem integrar vendor de busca; (3) o admin master define **teto de gasto, nichos e intervalo**; (4) guardar as pesquisas relevantes numa **base de consulta** e comparar novo × base (cresceu / retraiu / novidade).
- **Relacionadas:** **ADR-156** (esta ADR a evolui e supersede o guardrail DI-4.5 "nunca roda pesquisa sozinho" **apenas** para o caminho automático), ADR-079 D4 (agregação anonimizada — segue satisfeita: a camada compartilhada continua org-agnóstica), ADR-074 (Scheduler), ADR-130/154 (governança e metering de IA — `PlanService.aiAllowed`, `ai_monthly_limit_cents`), ADR-135 (Snapshot/Evidence), ADR-136 (Signals), ADR-152 (Runtime). CLAUDE.md convenções nº 1 (isolamento), nº 4 (RN-004 derivado), nº 7 (best-effort), nº 10 (opt-in), nº 12 (BusinessSignal).

---

## Contexto

A ADR-156 entregou a External Intelligence compartilhada com um provider **manual** (DI-4.4): o admin master **cola** a pesquisa de cada nicho e o ZapFlow anonimiza, dedup e distribui read-only para as contas daquela vertical. Foi a escolha mais segura para destravar a ADR-079 D4 sem rede externa.

O passo natural — já previsto na ADR-156 ("a interface `ExternalResearchProvider` fica pronta para um provider real no futuro") — é **automatizar**: o ZapFlow já sabe (a) qual é o nicho de cada conta, (b) o que fazer com a pesquisa (contextualizar + alimentar Evidence Package + `business_signals`) e (c) para quem entregar (as contas opt-in da vertical). O que falta é **produzir** a pesquisa sem depender do admin colar toda semana, com **qualidade controlada** e **memória evolutiva**.

Três necessidades concretas do dono:

1. **Rodar sozinho** — o Scheduler produz a pesquisa por nicho na cadência definida, sem intervenção manual.
2. **Curadoria antes de publicar** — um agente de IA revisa/condensa/valida a pesquisa por nicho antes de ir ao ar (é o **gate de qualidade** que substitui a curadoria humana do modelo manual).
3. **Base longitudinal** — guardar as versões relevantes por nicho para virar **ponto de partida**: a cada nova pesquisa, comparar com a base e destacar **onde cresceu, onde retraiu, o que é novo** — memória de mercado, não só um retrato do momento.

**O que NÃO muda (herdado da ADR-156, inegociável):** a camada `vertical_intelligence` continua **compartilhada, sem `organization_id`, sem PII**; o filtro de anonimização (`sanitizeForShared`) roda **antes** de qualquer escrita no compartilhado; a query deriva **só** de `(vertical, topic, region, timeframe)`; o tenant continua **read-only** (`ResearchBrokerService`, nunca chama provider); o consumo por decisão segue **L3+ + opt-in**.

---

## Decisões

### D1 — Pesquisa automática no Scheduler (supersede o "nunca roda sozinho" da ADR-156 DI-4.5, só para o caminho automático)

Um novo passe do Scheduler (ADR-074) — `VerticalIntelligenceResearchService.maybeSweep()` — roda a pesquisa dos nichos **registrados para automação**, respeitando **intervalo** (por nicho) + **orçamento de plataforma** (ADR-156 D6) + **toggle**. Espelha o padrão já usado por `VerticalIntelligenceReminderService` (dedup por `last_run` em `platform_settings`, best-effort, gasto de plataforma sem `organization_id`).

- O **lembrete semanal** da DI-4.5 continua existindo como **fallback** para nichos **não** automatizados (ou com automação desligada): se o admin optou por manter um nicho manual, o lembrete avisa quando vence. Automação e lembrete são **mutuamente exclusivos por nicho** — um nicho automatizado não gera lembrete de "re-colar".
- A ADR-156 permanece verdadeira para o caminho manual; esta ADR **adiciona** o caminho automático e o marca claramente como supersessão **localizada** do guardrail "scheduler nunca dispara pesquisa".

### D2 — Provider = a IA que já roda no repo (`chat()`/`llm.js`), atrás da interface existente

Decisão do dono (2026-08-09): **não** integrar vendor de busca (Tavily/Brave/SerpAPI) nesta etapa. Em vez disso, um novo `LlmResearchProvider implements ExternalResearchProvider` embrulha o primitivo `chat()` (`llm.js`) — o mesmo que o `AIOrchestratorService` usa — para **sintetizar** o panorama do nicho a partir da capacidade do próprio modelo.

- **Seleção por env (padrão já existente, ADR-156 D4):** `getResearchProvider()` resolve `EXTERNAL_RESEARCH_PROVIDER`. O **default continua `stub`** (determinístico, zero rede, zero chave) — então **CI e ambientes sem chave de IA seguem verdes** sem tocar em nada. O `LlmResearchProvider` só é selecionado quando a env aponta pra ele **e** há chave de IA configurada.
- **Custo real → orçamento de plataforma (ADR-156 D6):** o `LlmResearchProvider` retorna `costCents` estimado da chamada; `runResearch` já registra em `research_usage_log` e **recusa antes de chamar** se o teto mensal estourou (`budget_exceeded`). O metering de IA da ADR-154 (`ai_monthly_limit_cents`, `PlanService.aiAllowed`) continua valendo como segundo teto — a pesquisa de plataforma respeita ambos.
- **A query continua derivada só de `(vertical, topic, region, timeframe)`** (RN-156-2) — o prompt do provider é montado **só** da taxonomia do nicho, nunca de dado de tenant.

### D3 — Agente curador; publicação autônoma (o curador é o gate)

Decisão do dono (2026-08-09): **o curador publica sozinho** (sem OK humano por publicação). Entre "buscar" e "publicar" entra uma etapa de curadoria por IA — `ResearchCuratorService.curate(vertical, raw, base)` — que:

1. **Condensa e estrutura** o resultado bruto do provider num pacote canônico (`summary`, `drivers[]`, `sources[]`, `confidence`).
2. **Compara com a base longitudinal** (D4) e anexa o **delta** (`changes: { grew[], shrank[], new[], gone[] }`).
3. **Valida qualidade** — rejeita/rebaixa pacote vazio, incoerente, sem fontes, ou com `confidence` abaixo do piso; um pacote reprovado **não publica** (fica registrado como tentativa, não sobrescreve a base boa anterior).

- **Ordem de segurança fixa:** `provider → curador → sanitizeForShared (anonimização, RN-156-3) → upsert`. A anonimização roda **depois** da curadoria e **antes** da escrita — o curador nunca pode reintroduzir PII que passe pro compartilhado.
- **Determinismo em CI:** sem chave de IA, o curador cai num **modo determinístico** (pass-through estruturado + delta por diff textual), igual ao stub do provider — os testes de fatia rodam offline (padrão de todo o DI).
- Autonomia é **advisória para a decisão do lojista**, não para a operação: o pacote publicado alimenta Evidence Package + `business_signals` (ADR-156 D7); nenhum gate de RBAC/autonomia do lojista muda (RN-156 preservada).

### D4 — Base longitudinal + motor de delta (a "memória de mercado")

Hoje `vertical_intelligence` faz **upsert por fingerprint** — sobrescreve e perde histórico. Esta ADR adiciona uma camada de **histórico versionado**, **também compartilhada e sem `organization_id`**:

- **`vertical_intelligence_history`** (COMPARTILHADA, sem org) — uma linha por **versão publicada** de um nicho: `fingerprint`, `vertical`, `topic`, `version` (incremental por fingerprint), `content_json`, `sources_json`, `confidence`, `delta_json` (o que mudou vs versão anterior), `provider`, `generated_at`. Append-only (nunca `DELETE` — convenção nº 9 espírito). Retenção configurável (ex.: manter as N últimas versões por nicho + a mais recente sempre).
- **`vertical_intelligence`** segue sendo a **"cabeça"** (versão fresca corrente) que o broker lê — sem mudança no contrato de leitura do tenant.
- **Motor de delta** (`ResearchCuratorService`, determinístico): compara `drivers[]`/tópicos/confidence entre a nova pesquisa e a última versão da base e produz `{ grew, shrank, new, gone }`. O delta vira: (a) campo `delta_json` no histórico, (b) parte do `content` publicado (o lojista vê "o que mudou no mercado desde a última leitura"), (c) opcionalmente um `business_signals` (domain `external`) quando a mudança é material (convenção nº 12) — sem menu/alerta novo.
- **Ponto de partida para a IA:** o `DecisionEngine`/Evidence Package passa a citar não só o retrato atual, mas a **tendência** ("demanda de inverno **cresceu** vs a leitura anterior") — mais sinal para a mesma decisão, ainda **read-only** e **L3+**.

### D5 — Configuração do admin master: teto, nichos e intervalo (as 3 alavancas pedidas)

Tudo em **`platform_settings`** (KV, sem org — é plataforma, ADR-156 D6), configurável no painel `NicheIntelligenceView` (DI-UI-1):

- **Teto de gasto** — já existe (`research_monthly_budget_cents`, ADR-156 D6). Reusado, sem tabela nova.
- **Nichos automatizados** — um registro por nicho `(vertical, topic, region?, timeframe?)` marcado para automação, com seu próprio `enabled` + `intervalDays` + `lastRunAt`. Guardado em `platform_settings` (JSON) ou numa tabela leve `vertical_intelligence_schedule` (compartilhada, sem org) — a definir na fatia; preferência por tabela leve para query de "quem está vencido".
- **Intervalo entre pesquisas** — por nicho (`intervalDays`, default 7), com um teto global de segurança para não estourar orçamento. O passe D1 só roda um nicho quando `now - lastRunAt >= intervalDays`.

### D6 — Custo e frugalidade (dois tetos + só nichos com consumidores)

- **Só pesquisa nichos que têm contas consumindo** (opt-in `external_intelligence_enabled`) — mesmo filtro do `VerticalIntelligenceReminderService.consumingVerticals()`. Nicho sem consumidor não gera custo (frugalidade, PRD §43).
- **Dois tetos:** orçamento de pesquisa de plataforma (ADR-156 D6) **e** o metering de IA (ADR-154). O passe recusa antes de chamar se qualquer um estourar.
- **1 pesquisa por nicho, N contextualizações** — o modelo econômico da ADR-156 é preservado: a automação não multiplica custo por loja, só por nicho × cadência.

### D7 — Sem novo menu; reusa Evidence + Signals + o painel master existente

Nenhuma tela nova para o lojista (PRD §31). O admin master ganha, no `NicheIntelligenceView` que já existe, os controles de automação (liga/desliga por nicho, intervalo) e a visão do histórico/delta. O lojista continua consumindo read-only, agora com a **tendência** anexada. Toda entrega segue por Evidence Package + `business_signals` (ADR-156 D7).

### D8 — Fatiamento (cada fatia = 1 PR draft → CI verde → merge)

- **DI-5.1 — `LlmResearchProvider` + custo real.** Provider atrás da interface existente, embrulhando `chat()`; `costCents` estimado; seleção por env; **stub segue default** (CI verde offline). Testes: provider selecionável por env; query derivada só da taxonomia; custo registrado no `research_usage_log`; `budget_exceeded` bloqueia antes de chamar; sem `organization_id`/PII no que persiste.
- **DI-5.2 — Base longitudinal + motor de delta.** `vertical_intelligence_history` (compartilhada, sem org) + versionamento no `persistShared` + `ResearchCuratorService` (determinístico) computando `{ grew, shrank, new, gone }`. Testes: versão incrementa; delta correto (cresceu/retraiu/novo/saiu); histórico nunca tem org/PII; retenção mantém a fresca.
- **DI-5.3 — Curadoria + publicação autônoma.** `ResearchCuratorService.curate` liga provider → curador → anonimização → upsert; modo determinístico sem chave de IA; rejeição de pacote ruim não sobrescreve base boa. Testes: pacote reprovado não publica; anonimização roda depois da curadoria; ordem de segurança; determinismo offline.
- **DI-5.4 — Agenda de nichos + passe automático.** Registro de nichos automatizados (`enabled`/`intervalDays`/`lastRunAt`) + `VerticalIntelligenceResearchService.maybeSweep()` no Scheduler; mútua exclusão com o lembrete DI-4.5 por nicho; só nichos com consumidores; respeita os dois tetos. Testes: só roda nicho vencido; pula sem consumidor; pula sem orçamento; lembrete não dispara para nicho automatizado.
- **DI-5.5 — UI de automação + tendência.** Controles no `NicheIntelligenceView` (liga automação por nicho, intervalo) + visão do histórico/delta; card de tendência no consumo (Evidence/Executive). Sem menu novo.

---

## Consequências

**Positivas:** a External Intelligence deixa de depender do admin colar toda semana — o ZapFlow produz, cura e publica sozinho, na cadência que o admin definir, dentro do teto. A base longitudinal transforma retratos isolados em **memória de mercado** (tendência real: cresceu/retraiu/novo), dando mais sinal para a mesma decisão — sem custo por loja, só por nicho × cadência. Reusa 100% da infra da ADR-156 (anonimização, budget, broker read-only, painel master) e da ADR-154 (metering de IA).

**Trade-offs / riscos aceitos:**
- **Publicação autônoma** (sem OK humano por publicação) troca uma revisão manual por um **gate de IA** — mitigado por: curador que rejeita pacote ruim (não sobrescreve base boa), piso de `confidence`, e a base longitudinal permitir auditar/reverter para uma versão anterior. O admin pode desligar a automação de um nicho a qualquer momento (volta ao manual/lembrete).
- **Qualidade da pesquisa depende do modelo** (sem fontes web dedicadas nesta etapa, por decisão do dono) — mitigado por: `sources[]` quando o modelo as fornecer, `confidence` explícita, e a porta aberta (interface) para plugar um provider web-search real depois **sem** refazer nada (só nova impl atrás de `ExternalResearchProvider`).
- **Custo de IA real** — controlado por dois tetos (orçamento de plataforma + metering ADR-154) e por só pesquisar nichos com consumidores.
- **Determinismo em CI** — preservado: sem chave de IA, provider e curador caem em modo determinístico; os testes de fatia rodam offline como todo o DI.

**Escopo:** evolui a ADR-156; **supersede localmente** o guardrail DI-4.5 "o scheduler nunca roda pesquisa sozinho" **apenas** para nichos marcados para automação. O caminho manual (colar) e o lembrete semanal continuam válidos para nichos não automatizados. O isolamento de dado privado e o contrato de anonimização da ADR-156 permanecem **intactos**.

## Testes (por fatia, padrão `scripts/test-*.ts`, tmpDir isolado)

- Provider LLM selecionável por env; **stub segue default** (sem env/chave → CI offline verde).
- Query do provider deriva **só** de `(vertical, topic, region, timeframe)` — nunca de dado de tenant.
- Custo real registrado; `budget_exceeded` bloqueia **antes** da chamada.
- `vertical_intelligence_history`: versão incrementa por fingerprint; **nunca** tem `organization_id`/PII; retenção mantém a fresca.
- Delta: cresceu/retraiu/novo/saiu computado corretamente entre versões.
- Curador: pacote reprovado **não** publica nem sobrescreve base boa; anonimização roda **depois** da curadoria; determinismo offline.
- Passe automático: só roda nicho vencido (`intervalDays`); pula nicho sem consumidor; pula sem orçamento; nicho automatizado **não** gera lembrete DI-4.5.
- Consumo do tenant segue **read-only** e **L3+** (broker nunca chama provider) — inalterado.

## Guardrails (RN — no header dos services + testados; herdam e estendem RN-156)

- **RN-157-1** (herda RN-156-1/2/3) — camada compartilhada (`vertical_intelligence` **e** `vertical_intelligence_history`) carrega **zero** dado por-org/pessoal; query deriva só da taxonomia do nicho; `sanitizeForShared` roda **antes** de qualquer escrita no compartilhado, **depois** da curadoria.
- **RN-157-2** — pesquisa automática só para nichos **com consumidores opt-in**, **vencidos** pelo `intervalDays`, e **dentro** dos dois tetos (orçamento de plataforma + metering de IA). Nunca por demanda de tenant.
- **RN-157-3** — o curador é o gate: pacote reprovado (vazio/incoerente/sem fonte/confidence abaixo do piso) **não** publica e **não** sobrescreve a última versão boa.
- **RN-157-4** — automação e lembrete DI-4.5 são **mutuamente exclusivos por nicho**; desligar a automação devolve o nicho ao manual + lembrete.
- **RN-157-5** — determinístico primeiro: sem chave de IA, provider e curador operam em modo determinístico (CI offline); o **stub segue o default** do registry.
- **RN-157-6** — provider abstrato (ADR-156 D4): trocar `LlmResearchProvider` por um web-search real depois **não** toca broker, curador, base, budget nem UI.
- **RN-157-7** — tenant permanece **read-only** e consome só em **L3+** (broker nunca chama provider) — inalterado pela ADR-156.
