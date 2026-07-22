# ADR-115 — IA de Consultoria Jurídica (consultora do lojista, global)

- **Status:** Implementada (fundação + Fatia 2 + Fatia 3). Fundação: Q&A ancorado no CDC, disclaimer obrigatório, grounding estrito, rota `/api/legal`, UI "Consultora Jurídica". Fatia 2: ganchos proativos por situação (`forSituation`), `GET /api/legal/situation/:key`, componente `LegalTip` na cobrança de fiado (Caderneta do Comigo). Fatia 3: base ampliada (súmulas do STJ 130/359/385/532 + orientações de PROCON e chargeback), citação por fonte (`refLabel`/`normKey`), novas situações `reclamacao_procon` e `chargeback`, e histórico de consultas por tema (`history` + `GET /api/legal/history` + seção na UI). `test:legal-advisor` 39/39. Manutenção: base versionada (`CDC_VERSION`); atualizar quando a lei/súmula mudar.
- **Data:** 2026-07
- **Origem:** pedido de campo — "uma IA que recebe o **Código de Defesa do Consumidor** e, com base nas leis e regras, orienta o lojista sobre como proceder — uma **consultora jurídica** para evitar que o lojista se prejudique. Implementação **nível global**, para todas as verticais."
- **Relacionadas:** RAG existente (`/api/rag`, base de conhecimento), `llm.ts` (LLM frugal), ADR-112/113 (cobrança de fiado — o art. 42 do CDC entra aqui), LGPD (já tratada na plataforma; a consultoria jurídica é complementar, focada em relação de consumo).

## Contexto

O lojista pequeno não tem advogado à mão e se **prejudica** em situações corriqueiras de consumo: devolução/troca, **arrependimento em 7 dias** (art. 49), garantia legal/vício do produto (art. 18/26), reclamação no PROCON, chargeback, e **cobrança de dívida** (art. 42 — não pode expor nem constranger o devedor). Sem orientação, ele ou cede demais (prejuízo) ou age errado (risco de processo/PROCON). Falta uma **consultora jurídica embutida** que, ancorada no **CDC**, diga *"como proceder"* de forma protetiva.

Isso é **global**: vale para varejo, moda, food, serviços, saúde, hotelaria — toda vertical vende para consumidor e está sob o CDC. Não é add-on de vertical; é capacidade da plataforma.

## Decisões

### D1 — RAG sobre base legal versionada (CDC como semente)
Ingerir o **Código de Defesa do Consumidor** como base de conhecimento (RAG) versionada e citável. Começa pelo CDC (escopo pedido); a estrutura permite ampliar depois (ex.: normas do PROCON, súmulas) sem redesenho. A resposta é **grounded** na base: se não há amparo na base, a IA diz que não sabe — **nunca inventa lei**.

### D2 — `LegalAdvisorService`: orienta, cita e protege
Responde à dúvida do lojista com três partes fixas:
1. **Como proceder** — orientação prática e **protetiva** ("o que fazer para não se prejudicar").
2. **Base legal** — o(s) artigo(s) do CDC que sustentam a orientação (citação, para o lojista conferir).
3. **Aviso** — orientação **não substitui advogado**; em caso complexo/litígio, procurar um profissional. O disclaimer é **obrigatório** em toda resposta.

Tom: conservador e a favor do lojista, mas **sem orientar a ilegalidade** (não sugere prática que gere risco — ex.: reter produto indevidamente, negativar de forma abusiva). Protege o lojista **dentro da lei**.

### D3 — Global, com frugalidade de token
Disponível em **todas as verticais** (capacidade de plataforma; gating por plano a definir na grade, mas o conceito é global). Frugal (ADR-088 D5): **RAG primeiro** (recupera os artigos), **LLM só para sintetizar** a orientação a partir dos trechos — não é chamada de IA a cada tela.

### D4 — Proativa por situação (fatia 2)
Além do modo pergunta-resposta, ganchos que oferecem a orientação **no momento certo**:
- Pedido de **devolução/troca** → art. 18/49.
- **Cobrança de fiado** (ADR-112/113) → art. 42 (cobrança sem constrangimento) — conecta com a **cobrança cortês** já desenhada.
- **Chargeback / reclamação PROCON** → como responder.
A IA **sugere** a conduta; o lojista decide (ADR-091 §6).

## Modelo de dados / implementação
- Base de conhecimento jurídica (reusa a infra de RAG): documento(s) do CDC segmentado por artigo, com `source='cdc'` e versão.
- `LegalAdvisorService.ask(orgId, question, context?)` → `{ orientacao, artigos: [{ numero, texto, trecho }], disclaimer }`.
- Rota `/api/legal/ask` + UI (chat/Q&A "Consultora Jurídica"), com o disclaimer sempre visível. Auditoria das consultas (sem PII sensível desnecessária), isolamento por `organization_id`.

## Escopo (faseamento)
- **PR (fundação):** ingestão do CDC na base RAG + `LegalAdvisorService.ask` (orientação + artigos citados + disclaimer obrigatório) + rota `/api/legal` + UI de consulta + `test:legal-advisor` (grounding: responde com artigo quando há base; recusa/《não sei》quando não há; disclaimer sempre presente).
- **Fatia 2:** ganchos proativos (devolução, cobrança de fiado, chargeback).
- **Fatia 3:** ampliar a base legal (PROCON, súmulas) + histórico de consultas por tema.

## Consequências
**Positivas:** protege o lojista de erros caros em relação de consumo; reusa RAG + LLM já existentes; **global** (um cérebro jurídico para todas as verticais); conecta com a cobrança de fiado (art. 42) reforçando a "cobrança sem constranger" já desenhada.

**Trade-offs / riscos:** **responsabilidade** — não pode ser lida como parecer de advogado; por isso o **disclaimer obrigatório** e o grounding estrito (sem alucinar lei); a base precisa de **manutenção** quando a lei muda (versão da base); orientação protetiva não pode virar incentivo a prática abusiva (guarda-corpo do tom).

## Guardas
- **Grounded no CDC** — nunca inventa lei; sem amparo na base, diz que não sabe.
- **Disclaimer obrigatório** — orientação, não substitui advogado.
- **Protege o lojista dentro da lei** — nunca orienta prática abusiva/ilegal.
- IA **sugere**, o lojista decide (ADR-091 §6). Isolamento por `organization_id`; frugalidade de token (RAG-first).

## Testes
`test:legal-advisor` — responde com artigo do CDC quando há base; retorna 《não encontrei amparo》 quando a pergunta foge da base (não alucina); disclaimer presente em toda resposta; isolamento por org.
