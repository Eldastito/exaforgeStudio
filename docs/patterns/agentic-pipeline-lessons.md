# Aprendizados transferíveis — pipelines agênticas (estudo do img2threejs)

- **Data:** 2026-08-08
- **Fonte estudada:** [`img2threejs/img2threejs`](https://github.com/img2threejs/img2threejs) (v1.4.4, Apache-2.0). Uma *skill* agêntica (roda sob Claude Code/Codex/OpenCode) que reconstrói um objeto de **uma imagem** como modelo three.js procedural só-código, com pipeline de 5 estágios, gates de qualidade e loop de auto-correção.
- **O que NÃO transferimos:** o domínio (3D / CS2). O valor pra nós é 100% **arquitetura de agente** — como fazer uma IA produzir trabalho verificável sem queimar token nem alucinar.
- **Relacionadas (ZappFlow):** ADR-136 (business_signals), ADR-152 (Execution Runtime), ADR-153 (Entitlements + PlanFit), ADR-154 (AI metering + RAG), ADR-155 (Marketing playbooks → IA de produto), convenções nº 4/7/8/12 e RN-004/RN-014.

> **Nota de escopo:** este doc é *referência de padrões*, não um ADR. Não decide obra; cataloga técnicas comprovadas em produção alheia e onde cada uma encaixa no nosso código. Virar fatia é decisão de produto por ADR.

---

## O princípio-mestre

O repo inteiro gira em torno de uma frase, repetida em `SKILL.md`, `CLAUDE.md` e no grimoire:

> **"Scripts enforce structure and package evidence; they never score visuals. The model only judges what needs perception."**

Traduzindo pro nosso contexto: **a lógica determinística (query/regra, zero-token) tem poder de veto; o LLM é lubrificante — só entra onde uma regra não consegue decidir, e nunca aprova por cima de um veto determinístico.** Isso já é o espírito da nossa RN-014 ("IA sugere, humano/regra decide"). O img2threejs mostra como levar isso a sério em cada camada.

---

## Os padrões

Cada padrão: **o que é lá** · **por que importa** · **onde encaixa no ZappFlow** · **ação**. Os arquivos-âncora citados são do clone estudado (`img2threejs/`), pra quem quiser ler a implementação.

### 1. Estado derivado de um log append-only (nunca contador mutável)

- **Lá:** o "pass atual" da pipeline **nunca é armazenado** — é recomputado do `reviewHistory` a cada chamada (`forge/stage3_build/orchestrate_passes.py`). Um `state.json` externo é a autoridade do checklist; "conversation context is disposable".
- **Por quê:** elimina drift entre estado e histórico. A verdade é o log; tudo mais é projeção.
- **ZappFlow:** é **literalmente a nossa RN-004** (saldo derivado por query, nunca contador) + `business_signals` (ADR-136), `ai_usage_ledger` (ADR-154), `upgrade_recommendations` (ADR-153). **Validação externa da escolha que já fizemos.**
- **Ação:** estender o padrão ao **estado de execução do Runtime** (ADR-152) — derivar o estágio de um ticket/cadência dos `outcomes` registrados, não de flag mutável.

### 2. LLM-as-judge subordinado a gates determinísticos

- **Lá:** o VLM (`forge/stage4_review/vlm_gate.py`) **nunca é consultado sobre falha de hard-gate**; usa **voting multi-amostra** (mediana; spread alto → "incerto", nunca cara-ou-coroa), **calibração** monotônica post-hoc, e **cross-check** contra a medição geométrica determinística. Pode resgatar um quase-reject perto do limiar; nunca aprova por cima da matemática. O sampler é injetável → a camada é testável sem gastar token.
- **Por quê:** um modelo perguntado sobre algo já quebrado responde "looks fine" com confiança — e erra. Diversidade de amostra + cross-check com sinal duro corta isso.
- **ZappFlow:** intent classifier da Cobrança (Fatia 4b.2), reply routers (4b.2/4c.2), ConfirmationEngine (ADR-152), VLM de visão do FalaTu.
- **Ação:** onde o LLM decide algo arriscado (aprovar envio, classificar intent de pagamento): **cross-check contra um sinal determinístico** e, em decisão sensível, **voting multi-amostra**. Regra dura: modelo não sobrepõe regra. Manter o "juiz" com sampler injetável pra testar sem token.

### 3. Self-correction com terminação garantida

- **Lá:** `forge/stage4_review/correction_loop.py` — política de parada em **ordem de prioridade estrita** (primeiro match vence): `hard-gate → refine-code`, `success`, `repeated-defect → refine-spec`, `oscillation → refine-spec`, `plateau → request-input`, e um **teto não-burlável** (`len(history) ≥ max_iter → request-input`). Mais um circuit-breaker por budget de token. Dois limites compostos (por-passe e total).
- **Por quê:** garante terminação. Nunca queima token em loop infinito; escala pra humano quando trava.
- **ZappFlow:** cadências multi-tentativa (4b.3/4c.3), backoff do JobQueue, Scheduler timeout, RuntimeExceptionsService (ADR-152 F3.1).
- **Ação:** formalizar a **política de parada** das cadências/retries com os mesmos estados terminais (`repeated-defect/oscillation/plateau/hard-ceiling → escala pra humano`). Casa com o approval humano que já temos.

### 4. Knowledge base processual consultável just-in-time (o "grimoire")

- **Lá:** `grimoire/` é conhecimento **organizado por estágio do fluxo** (intake/build/review/…), **carregado sob demanda** no ponto exato da decisão. O `SKILL.md` não contém o conhecimento — contém **ponteiros imperativos**: *"MUST read `grimoire/review/gates_reference.md` before any `continue` decision"*. Cada arquivo é contrato de decisão, não referência passiva, e acumula **lições pós-mortem como regras** ("as duas regras que custaram um pass errado pra aprender").
- **Por quê:** *progressive disclosure* — o agente lê a rubrica **certa** antes de agir, em vez de carregar tudo. Barato em token e mais preciso.
- **ZappFlow:** **é exatamente a Fase 1 da ADR-155** (docs/playbooks/ + doc de contexto canônico que o redator lê antes de compor) e o RAG do FalaTu (ADR-154 F5). Nosso conhecimento hoje vive em CLAUDE.md + ADRs (bom), mas é lido "tudo de uma vez".
- **Ação:** ao implementar a ADR-155 F1, adotar o formato grimoire: **injetar a rubrica certa just-in-time** no prompt do redator (Cobrança/Recuperação/FalaTu), não o dump inteiro. Acumular falhas conhecidas como regras.

### 5. Saída com proveniência e confiança embutidas (anti-alucinação)

- **Lá:** o vocabulário controlado (`docs/specs/vocabulary/*.jsonl`) exige por registro: `observation_status ∈ {observed, inferred, unverified}`, `confidence` 0–1, `source_refs` (localização exata na fonte), `assumptions`. Medições ficam como **texto-fonte**, "rather than invented numbers". Uma linha inválida **nunca é reparada em silêncio** — levanta erro com path:linha. O agente é **proibido de codificar certeza que não tem**: baixa a `confidence` e marca o status.
- **Por quê:** anti-alucinação de primeira classe. A incerteza vira dado explícito, auditável, em vez de sumir.
- **ZappFlow:** explicabilidade rica dos detectores (PlanFit ADR-153 F7.2; ChurnRisk da ADR-155 F4); anti-alucinação dos redatores de copy.
- **Ação:** todo detector/redator emite `confidence` + `status` + `source_ref` do sinal que embasou a decisão, e **fail-closed** (nunca "reparo silencioso" de dado inválido).

### 6. Orçamento de token por estágio + gates como mecanismo de economia

- **Lá:** `docs/TOKEN_COST.md` tem um modelo de custo **por estágio** e identifica o **loop de review como custo dominante** (escala linear com ciclos). A lição: "a maior alavanca de custo é o número de ciclos de review; uma spec bem-formada de cara vale mais que qualquer micro-otimização". Os **gates SÃO a economia** — bloquear uma spec rasa **antes** de gerar código evita um ciclo inteiro (~10k–20k tokens).
- **Por quê:** fail-fast determinístico antes do trabalho caro de modelo.
- **ZappFlow:** `ai_usage_ledger` + cotas (ADR-154) já **medem** custo; falta o padrão "gate barato antes do LLM".
- **Ação:** rodar checagens **determinísticas** (dedupe via `dedupe_key`, elegibilidade, opt-out LGPD) **antes** de chamar o LLM pra redigir. Documentar um custo-por-pipeline (Cobrança, Recuperação, briefing) ligado à cota da ADR-154.

### 7. Schemas + enums de estado fechados como contrato entre estágios

- **Lá:** o `render-profile.v2.schema.json` (JSON Schema draft 2020-12) usa `const`/enums pra fixar invariantes não-negociáveis, é **validado uma vez e hasheado no manifest** (vira evidência auditável). Handoffs entre estágios são JSON atômico versionado (`schemaVersion`) com **estados fechados** (`proceed | request-input | fallback | rejected | unsupported`) e um campo `extensions` pra forward-compat. Um "layer contract" tabelado define, por estágio, o que ele *owns / must emit / must not decide alone*.
- **Por quê:** superfície de decisão **finita e auditável**. Nada de string informal escorrendo entre estágios.
- **ZappFlow:** handoffs do Runtime (intent → route → action → outcome, ADR-152).
- **Ação:** tornar os handoffs do Runtime JSON versionado com estados terminais fechados + `extensions`, validados por schema.

### 8. Verificação fail-closed por evidência real (nunca fabricar sucesso)

- **Lá:** o "render bridge" (`forge/stage4_review/render_bridge.py` + `scripts/capture_threejs_playwright.py`) mede pixels do **runtime real** (browser via Playwright/MCP). Falta de contrato/hash/erro de console **para o processo** em vez de substituir por uma imagem fabricada. O `CLAUDE.md` deles: *"nunca reportar conclusão sem ler os outputs frescos; um screenshot legível é pré-requisito duro"*. O enforcement é **no momento da escrita**: um gate reprova **levantando erro ao gravar** `action=continue` sem evidência (`append_review.py`), não em checagem posterior.
- **Por quê:** o outcome só conta com prova real, não com o retorno otimista de uma chamada.
- **ZappFlow:** medição de `revenue_recovered` real quando ticket→ganho (4c.4); cultura de teste-por-fatia.
- **Ação:** no Runtime, o outcome de uma ação só é creditado com **evidência real** (webhook/gateway confirmando), não com o `200 OK` da chamada de saída. Enforcement no ponto de escrita do outcome.

### 9. RAG lexical local (BM25) por perfil, com proveniência

- **Lá:** `forge/_shared/spec_search.py` — **BM25 puro** (stdlib, sem embeddings, sem rede), busca **por perfil/coleção** (`spec_search_profiles.json`), tokenizer configurável e reprodutível, **cache por fingerprint da fonte** (reconstrói se stale/corrupt), e resultados que **rastreiam de volta à localização exata na fonte**. Regra: "evidência local é um **estágio do pipeline**, não uma memória opcional".
- **Por quê:** busca determinística, auditável e barata — sem custo/latência de embeddings quando não valem a pena.
- **ZappFlow:** o RAG do FalaTu (ADR-154 F5) é vetorial. BM25 é alternativa/**camada complementar** barata pra busca por termo exato e desambiguação ("qual Carlos?").
- **Ação:** considerar BM25 como fallback/complemento no RAG do FalaTu, especialmente pra match exato de entidade — com proveniência no resultado.

### 10. Dois detalhes de engenharia que valem copiar

- **Cache com hash do código na chave** (`forge/_shared/artifact_cache.py`): `cache_key = sha256(input) + sha256(código-do-extrator)`. **Invalida sozinho quando o algoritmo muda** — nada de "version string" manual pra esquecer de bumpar. Aplicável a qualquer cache nosso (ex.: snapshots, module_cache).
- **Gate só vira bloqueante depois de calibrado** (`forge/stage4_review/calibrate_eye.py`): roda em *report-only* sobre um corpus rotulado (good/bad) e só autoriza flipar pra hard-gate quando prova separação limpa. Aplicável antes de tornar qualquer detector nosso (ChurnRisk, PlanFit) um gate que **bloqueia** em vez de só **sinalizar**.

---

## Prioridade de adoção

Os três de maior alavancagem imediata, porque tocam trabalho vivo e reforçam convenções que já temos:

1. **Grimoire / progressive-disclosure (padrão 4)** → dá substância concreta à **Fase 1 da ADR-155**, agora com modelo de referência provado.
2. **LLM-judge subordinado + terminação garantida (padrões 2 e 3)** → endurece **ConfirmationEngine e cadências** do Runtime (ADR-152) contra alucinação e loop de custo.
3. **Proveniência/confiança na saída dos detectores (padrão 5)** → melhora explicabilidade e corta alucinação em PlanFit/ChurnRisk sem obra grande.

Os padrões 1, 6, 8 são **confirmação/extensão** de coisas que já fazemos certo (RA-004, ledger de custo, verificação por evidência real) — úteis como argumento de que estamos no caminho e como checklist ao abrir novas fatias.

## Referências

- Repo estudado: https://github.com/img2threejs/img2threejs (Apache-2.0).
- Arquivos-âncora citados (no repo deles): `SKILL.md`, `CLAUDE.md`, `grimoire/` (esp. `review/gates_reference.md`, `intake/quality_contract.md`), `forge/stage3_build/orchestrate_passes.py`, `forge/stage4_review/{correction_loop,divine_eye,vlm_gate,render_bridge,append_review,calibrate_eye}.py`, `forge/_shared/{spec_search,artifact_cache,feature_acceptance_policy}.py`, `docs/specs/render-profile.v2.schema.json`, `docs/specs/vocabulary/*.jsonl`, `docs/TOKEN_COST.md`.
- Nossos correlatos: ADR-136, ADR-152, ADR-153, ADR-154, ADR-155; convenções nº 4/7/8/12; RN-004, RN-014.
