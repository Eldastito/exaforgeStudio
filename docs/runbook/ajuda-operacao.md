# Runbook — Tutor de Ajuda & Treinamento (ADR-179)

Camada de suporte/treinamento in-app. É o **Fala Tu respondendo dúvida**
(RN-UX-1), aterrado numa **base de ajuda curada do usuário** — NÃO é um 2º motor
de chat nem responde a partir dos ADRs crus. Aditivo/reversível sobre ADR-163
(Invisible UX) e ADR-151/160 (Fala Tu).

## Mapa dos serviços

| Peça | Onde | Papel |
| --- | --- | --- |
| `HelpKnowledgeService` | `src/server/HelpKnowledgeService.ts` | Base curada + recuperação grounded (determinística) + curadoria + métricas/lacunas + feedback |
| `ZeroTrainingHelpService` | `src/server/ZeroTrainingHelpService.ts` | Cérebro: classifica intenção, responde dos engines, consulta a base curada, instrumenta métricas |
| `HelpOrb` | `src/features/HelpOrb.tsx` | Orb flutuante "Precisa de ajuda?" — chat + sugestões da tela + deep-link + 👍/👎 |
| `HelpCurationPanel` | `src/features/AdminMasterView.tsx` | Painel master: bootstrap, revisão, publicar/arquivar, fila de lacunas cross-org |

## Modelo de dados (tudo aditivo)

- `help_articles` — **GLOBAL** curada (`vertical` NULL = todas), padrão "O que é ·
  Pra que serve · Como faço · Erros comuns", `reviewed_by` obrigatório, `status`
  draft|published|archived. Só `published` é recuperável.
- `help_gap_log` — **por-org**, minimizado: pergunta sem cobertura (query
  normalizada, sem PII), `hits` incrementa. Fila de conteúdo.
- `help_ask_stats` — **por-org**, agregado `asks`/`answered` por módulo (sem texto).
  Base da taxa de resposta.
- `help_feedback` — **por-org**, agregado `up`/`down` por artigo+módulo (sem texto).
  Base da satisfação. `article_id=''` = resposta sem artigo (sinal de lacuna).
- `help_articles.media_url` (F5, aditivo) — URL CURADA opcional de GIF/vídeo curto
  que ilustra a feature. NULL por padrão (sem mídia inventada).

## Rotas

**Usuário (universal — não exige `falatu_enabled`):**
- `POST /api/ux/help { text, moduleKey? }` — pergunta → resposta grounded
  (`article` citado + `gapLogged`).
- `GET /api/ux/help/suggestions?module=` — artigos relevantes da tela atual.
- `POST /api/ux/help/feedback { articleId?, moduleKey?, helpful }` — 👍/👎.
- `GET /api/ux/help/tour?module=` — tour contextual (passos do artigo da tela).
- `GET /api/ux/help/learn-one` — dica "aprenda 1 coisa" (read-only, não publica).

**Gestor (owner/admin):**
- `GET /api/ux/help/gaps?limit=` — fila de lacunas da org.
- `GET /api/ux/help/metrics` — taxa de resposta, satisfação, onde travam.

**Master Admin (`requireMasterAdmin`):**
- `GET /api/admin/help-articles?status=all|draft|published|archived`
- `POST /api/admin/help-articles` — cria rascunho / atualiza (patch).
- `POST /api/admin/help-articles/bootstrap { moduleKey, sourceRef?, sourceText?, useLlm? }`
  — destila rascunho (determinístico; LLM só com `useLlm`+`sourceText`+IA configurada).
- `POST /api/admin/help-articles/:id/publish { reviewedBy }` — publica (RN-HELP-3).
- `POST /api/admin/help-articles/:id/archive` — arquiva.
- `GET /api/admin/help-gaps?limit=` — fila GLOBAL de lacunas (cross-org).

## Fluxo (o ciclo que se fecha)

1. Usuário abre o orb → vê **sugestões da tela** (contextual).
2. Pergunta → `ZeroTrainingHelpService.answer` responde dos engines +
   **artigo curado citado**; sem cobertura → admite e **registra a lacuna**.
3. 👍/👎 mede satisfação; "Abrir tela →" navega por deep-link.
4. Master vê a **fila de lacunas** (o que perguntam e a base não cobre) →
   **gera rascunho** (bootstrap) → revisa → **publica com "revisado por"**.
5. Métricas (`/help/metrics`) mostram cobertura + satisfação subindo.

## Como adicionar/curar conteúdo

1. Admin Master → painel **"Curadoria da base de ajuda"**.
2. Olhe **"Dúvidas sem resposta"** (fila cross-org) para priorizar.
3. **Gerar rascunho** do módulo → edite o texto (linguagem do lojista, não de dev).
4. **Publicar** informando quem revisou. Só então o orb usa o artigo.
5. Para retirar: **Arquivar** (sai da recuperação; histórico preservado).

## Guardrails (RN-HELP) — codificados em `test:help-hardening`

- **RN-HELP-1** grounded/nunca inventa; sem cobertura → admite + registra lacuna.
- **RN-HELP-2** citação sempre (toda resposta de base traz o artigo-fonte).
- **RN-HELP-3** curadoria humana: só `published` com `reviewed_by`; bootstrap
  gera rascunho, nunca publica sozinho.
- **RN-HELP-4** não é bot paralelo — é o Fala Tu (`ZeroTrainingHelpService`).
- **RN-HELP-5** não indexa doc técnica crua; ADR/runbook são fonte do RASCUNHO.
- **RN-HELP-6** LGPD: lacuna guarda query normalizada sem PII (telefone/CPF/email
  descartados); `ask_stats`/`feedback` sem texto.
- **RN-HELP-7** RBAC/plano/vertical: recorte por vertical; gaps/metrics só gestor.
- **RN-HELP-8** determinístico antes de LLM: recuperação e bootstrap rodam sem
  chave de IA; a LLM (F7) só **reescreve** o recuperado e **reranqueia** entre
  artigos reais, nunca cria fato novo. Sem IA → idêntico ao determinístico.

## Camada LLM grounded (F7)

`POST /api/ux/help` → `ZeroTrainingHelpService.answerAsync`. Fluxo: determinístico
primeiro; **se houver IA** (`HelpKnowledgeService.aiAvailable`):
1. Achou artigo por palavra → `groundedAnswer` reescreve a resposta natural **só do
   artigo** (mantém a citação). Se a IA julgar que o artigo não responde → `NAO_COBERTO`.
2. Palavra falhou, ou o artigo do passo 1 deu `NAO_COBERTO` → `semanticPick`
   reranqueia entre os artigos **publicados reais** (retorna só id da lista — nunca
   inventa) e responde grounded.
3. Nenhum artigo responde → admite e registra a lacuna (não força resposta errada).

Sem chave de IA (`OPENAI_API_KEY`) o comportamento é idêntico ao determinístico
(0-regressão). Custo: 1–2 chamadas curtas de chat por dúvida quando a IA está ligada.
A LLM recebe só a pergunta + o texto do artigo curado (conteúdo GLOBAL, não-PII).
Se a base não cobre o tema (ex.: "cadastrar vendedores" sem artigo), a resposta certa
é **curar um artigo** — a fila de lacunas captura exatamente isso.

## Testes

`test:help-knowledge` (base + retrieval) · `test:help-curation` (draft→publish→
archive + bootstrap) · `test:help-gaps` (fila + métricas) · `test:help-context`
(sugestões + feedback) · `test:help-training` (tour + mídia + "aprenda 1 coisa")
· `test:help-hardening` (RN-HELP + fiação de produção).

## Treinamento (F5)

- **Tour da tela:** o orb oferece "Fazer o tour desta tela" quando há artigo
  publicado do módulo — os passos viram um walkthrough. Derivado do conteúdo
  curado; sem artigo/passos, não aparece.
- **Mídia (GIF/vídeo):** no painel de curadoria, cada artigo tem um campo de URL
  de mídia (opcional). Salvar em branco remove. A mídia aparece no orb/tour. Nunca
  é inventada — só o que o curador colar.
- **"Aprenda 1 coisa":** o Scheduler publica UMA dica semanal (`passLearningDigest`,
  gate de 7 dias) no `business_signals` (`domain='help'`, `signal_type='learn_one'`),
  que flui pro Fala Tu/atenção. Avança pelo conteúdo publicado; esgotado → não
  publica (não inventa). O orb também mostra a dica atual no topo.

## Troubleshooting

- **Orb não responde / "não consegui responder agora":** a rota `/api/ux/help`
  falhou (rede/sessão). O orb degrada com aviso, não quebra a tela.
- **Sempre "ainda não tenho isso documentado":** a base não cobre o tema → veja a
  fila de lacunas e publique um artigo. Verifique também se o artigo está
  `published` (rascunho não é recuperável) e se a `vertical` bate com a da org.
- **Sugestão não aparece na tela:** o `viewMode` da tela não mapeia para um
  `module_key` com artigo publicado (mapa em `HelpOrb.VIEW_TO_MODULE`). Sem
  cobertura, o orb não empurra nada (comportamento correto).
- **"Abrir tela →" não aparece:** a resposta não aponta módulo/superfície mapeado
  em `HelpOrb.MODULE_TO_VIEW`, ou o alvo está fora do plano/perfil.
- **Taxa de resposta/satisfação `null`:** ainda não há perguntas/votos — `null`≠0
  (não inventa taxa). Aparece assim que houver dado.
