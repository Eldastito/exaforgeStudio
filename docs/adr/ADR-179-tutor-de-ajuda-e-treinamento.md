# ADR-179 — Tutor de Ajuda & Treinamento (suporte grounded in-app)

**Status:** PROPOSTO — plano F0–F6. Aditivo/reversível sobre ADR-163 (Invisible UX /
Zero-Training) e ADR-151/160 (Fala Tu). NÃO cria bot paralelo, NÃO responde a
partir dos ADRs crus.

## 1. Contexto & problema

O suporte e o treinamento hoje dependem de a pessoa perguntar a alguém ou vasculhar
a plataforma. A documentação existe (ADRs, runbooks, log de features), mas é
**voltada para desenvolvedor** — jargão técnico, decisões de arquitetura. Apontar
uma IA para os ADRs faria ela responder com passos errados e linguagem que o
lojista não entende.

O dono quer **simplificar suporte e treinamento**: o usuário pergunta "como faço X?"
e a IA responde **com base na documentação do ZapFlow**, de forma simples.

## 2. O que JÁ existe (reusar, não reconstruir)

| Peça | Onde | Papel na ajuda |
| --- | --- | --- |
| `ZeroTrainingHelpService.answer` | `src/server/ZeroTrainingHelpService.ts` | Cérebro: classifica intenção (ensinar/mostrar/fazer/navegar), responde dos engines reais, LLM só de fallback, grounded/honesto (RN-UX-1) |
| `POST /api/ux/help { text }` | `src/server/routes/ux.ts:80` | Superfície de pergunta→resposta já montada |
| `FalaTuMemoryEmbeddingsService` + `vectorSimilarity` | `src/server/FalaTuMemoryEmbeddingsService.ts` | Infra de embeddings/RAG (retrieval) |
| Fala Tu (voz/WhatsApp/app/`ftk_`) | `FalaTu*Service`, `/api/falatu-ingest` | Canais de acesso (voz via Whisper, WhatsApp, Siri/NFC/Share) |
| `AdaptiveOnboardingService` / `FalaTuHomeService` | idem | Onboarding + "Hoje" por exceção (treinamento contextual) |
| Curadoria com revisão humana | `labor_law_entries` (ADR-178) | Molde: base curada, cada entrada exige `reviewed_by`, nunca publica cru |

**Conclusão:** ~80% do motor existe. O que falta é (a) uma **base de ajuda do
USUÁRIO** (artigos curtos destilados da doc técnica), (b) **retrieval grounded com
citação** ligado ao `ZeroTrainingHelpService`, e (c) a **superfície "orb"** no app.

## 3. Decisão

Um **Tutor de Ajuda** que é o **Fala Tu respondendo dúvida** (RN-UX-1 — não é
assistente separado), aterrado numa **base de ajuda curada**:

1. **Base de ajuda do usuário** — tabela nova `help_articles` (GLOBAL curada +
   opcional por-vertical), cada artigo no padrão **"O que é · Pra que serve · Como
   faço (passos) · Erros comuns"**, com `reviewed_by` obrigatório (molde ADR-178).
   NÃO indexa ADRs crus.
2. **Bootstrap semi-automático** — a IA destila cada ADR/feature num RASCUNHO de
   artigo do usuário; humano revisa e publica (`reviewed_by`). Rascunho nunca vai
   ao ar sozinho.
3. **Retrieval grounded** — o `ZeroTrainingHelpService.answer` ganha um passo: quando
   a dúvida é "como/o que" e os engines não bastam, busca os artigos por similaridade
   (embeddings) e responde **só do conteúdo recuperado, com a citação do artigo**.
   Sem cobertura → **"ainda não tenho isso documentado — quer abrir um chamado?"** e
   **registra a lacuna** (RN-HELP-1).
4. **Superfície "orb"** — botão flutuante "Precisa de ajuda?" que abre o chat; usa
   `POST /api/ux/help`. **Funciona sem `falatu_enabled`** (ajuda é universal) e fica
   mais rico (voz/WhatsApp) quando o Fala Tu está ligado.
5. **Contextual** — o orb sabe a tela atual (moduleKey) → prioriza artigos daquele
   módulo e sugere os relevantes (reusa `NavigationManifestService`).
6. **Acionável** — "me mostra onde" faz deep-link à tela; "faça X" cai no caminho
   GOVERNADO existente (nunca executa sem confirmação).
7. **Guiado por lacuna** — perguntas sem resposta viram a fila de novos artigos
   (padrão `ResearchNeedService`): a base cresce puxada pela dúvida real, e o operador
   vê onde as pessoas travam.

## 4. Guardrails (RN-HELP)

- **RN-HELP-1 — Grounded, nunca inventa.** Responde só do artigo recuperado (ou dos
  engines determinísticos). Sem cobertura → admite e registra a lacuna. Alucinação
  num tutor de suporte é o pior resultado — quebra confiança.
- **RN-HELP-2 — Citação sempre.** Toda resposta de base traz o artigo-fonte.
- **RN-HELP-3 — Curadoria humana.** Artigo só ao ar com `reviewed_by` (bootstrap gera
  rascunho, humano publica).
- **RN-HELP-4 — Não é bot paralelo.** É o Fala Tu (ZeroTrainingHelpService) — sem 2º
  motor/superfície de chat (RN-UX-1/§184).
- **RN-HELP-5 — Não indexa doc técnica crua.** ADRs/runbooks são fonte do RASCUNHO,
  nunca o que o usuário lê.
- **RN-HELP-6 — LGPD.** Dúvida de ajuda não manda dado privado do tenant ao LLM;
  telemetria minimizada e opt-in (reusa `ux_telemetry_events`, ADR-163 F10).
- **RN-HELP-7 — RBAC/plano.** Só sugere/aponta o que o perfil e o plano do usuário
  alcançam (reusa Navigation/Entitlement).
- **RN-HELP-8 — Determinístico antes de LLM.** Engines e artigo curado primeiro; LLM
  só reescreve o conteúdo recuperado, nunca cria fato novo.

## 5. Modelo de dados (aditivo)

- `help_articles` (GLOBAL, curada): `id, vertical (NULL=todas), module_key, title,
  what, purpose, steps_json, common_errors_json, keywords, reviewed_by, source_ref,
  status (draft|published|archived), created_at, updated_at`.
- Embeddings dos artigos: reusa a infra de `FalaTuMemoryEmbeddingsService` (ou uma
  tabela irmã `help_article_embeddings`), sem 2º pipeline.
- `help_gap_log`: pergunta sem resposta (texto normalizado, module_key, contagem) →
  fila de conteúdo. Minimizado (sem PII).

## 6. Superfícies / rotas

- ESTENDE `POST /api/ux/help` (resposta ganha `article` citado + `gapLogged`).
- `GET /api/ux/help/suggestions?module=` — artigos relevantes da tela (contextual).
- Master: `GET/POST /api/admin/help-articles*` — curadoria (publicar rascunho, listar,
  arquivar), molde `LaborLawCurationPanel`.
- Frontend: componente `HelpOrb` (botão flutuante + chat), montado no shell.

## 7. Plano por fatias (fatia = 1 PR)

- **F0** — este ADR (doc-only).
- **F1 (Fase 1 do pedido)** — `HelpKnowledgeService` + tabela `help_articles` +
  retrieval grounded no `ZeroTrainingHelpService.answer` (artigo citado; sem cobertura
  → honesto + `help_gap_log`) + **orb no app** consumindo `/api/ux/help` + base curada
  semente dos ~5 módulos mais usados (Central de Saúde, Diretor IA, Vendas,
  Atendimento, Estoque). `test:help-knowledge`.
- **F2** — bootstrap semi-automático (destila ADR→rascunho de artigo) + painel de
  curadoria no Admin Master (publicar com `reviewed_by`).
- **F3** — contextual (tela→artigos) + deep-link "me mostra onde" + 👍/👎 por resposta.
- **F4** — guiado por lacuna: `help_gap_log` vira fila de conteúdo + métricas (o que
  perguntam, onde travam, taxa de resposta).
- **F5** — treinamento além do Q&A: tours contextuais (AdaptiveOnboarding) + GIFs
  curtos por feature + digest "aprenda 1 coisa" pelo Fala Tu.
- **F6** — hardening: `test:help-hardening` codifica os RN-HELP; runbook
  `docs/runbook/ajuda-operacao.md`.

## 8. Fora de escopo (§42)

2º motor de chat/ajuda · indexar ADRs crus pro usuário · responder sem citação ·
publicar artigo sem revisão · substituir o Fala Tu · treinar modelo com dado de
tenant. A ajuda por voz/WhatsApp exige `falatu_enabled`; o orb no app não.
