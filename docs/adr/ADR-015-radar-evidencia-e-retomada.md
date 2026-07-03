# ADR-015 — Radar: evidência anexada às respostas + correção da retomada de sessão

**Status:** Implementado e testado ponta a ponta em navegador real.
**Origem:** pedido para decidir, entre os itens pendentes do Radar (convite de respondente por link, matriz `radar_processes`/`execution_gap_index`, upload de evidência, Fase 4/5), qual era o melhor a implementar em seguida.

## Por que evidência, e não os outros três

- **Convite de respondente por link próprio** exigiria replicar o padrão de token público (`RadarPublicService`) para uma nova superfície de escrita sem autenticação — desenho e revisão de segurança à parte, sem urgência confirmada.
- **`radar_processes`/`execution_gap_index`** é uma matriz nova inteira (impacto/recorrência/urgência/prontidão) amarrada a uma interação do consultor que ninguém pediu ainda.
- **Fase 4/5** dependem de decisões fora do meu alcance (revisão jurídica para narrativa por IA, infraestrutura de e-mail/WhatsApp própria da ZappFlow).
- **Evidência** reaproveita infraestrutura que já existe (`StorageService`, ADR-011), não abre nenhuma rota sem autenticação nova, e fecha uma lacuna documentada desde a ADR-009: a escala de confiança do PRD (§7.4) tem 4 níveis — 0,60/0,75 (declarada, com/sem comentário) já implementados desde a Fase 1, e 0,90/1,00 (evidência anexada / baseline medido) "reservados para quando `radar_evidence` existir". Até este PR, nenhuma sessão do Radar — em nenhuma das 3 fases já entregues — conseguia passar de 0,75.

## Bug encontrado de caminho: `RadarService.getSession` nunca devolvia `answers`

Ao desenhar a UI de evidência (que precisa saber a qual resposta anexar o arquivo), percebi que `RadarService.getSession` — usado por `RadarView.tsx` toda vez que um diagnóstico é reaberto — nunca incluía as respostas já dadas no retorno. `RadarView.openSession` calcula a primeira pergunta sem resposta a partir desse array; sem ele, **qualquer sessão em andamento reabria sempre na pergunta 1**, mesmo com respostas já salvas (não perdia dado — `saveAnswer` é idempotente por pergunta — mas a experiência de retomar um diagnóstico estava quebrada). Corrigido junto: `getSession` agora devolve `answers` e `evidence`, e a suíte nova cobre isso explicitamente. Confirmado em navegador real: responder 3 de 18 perguntas, sair, reabrir — volta exatamente na pergunta 4.

## O que foi construído

- **`radar_evidence`** (tabela nova, `db.ts`): `answer_id`, `file_url`, `file_name`, `mime_type`, `uploaded_by`.
- **`RadarService.addEvidence`/`listEvidence`** (org-scoped): exige que a pergunta já tenha sido respondida (rejeita anexar evidência a pergunta ainda sem resposta — mensagem clara, não um erro genérico). Sobe `confidence_multiplier` da resposta para `max(atual, 0.90)` — **nunca regride** (uma resposta já em 0,75 por comentário não cai para 0,90 seco, fica em 0,90; duas evidências na mesma resposta não sobem além de 0,90, reservado para o nível 1,00 de baseline medido). Chama `calculateAndPersist` na hora — se a sessão já estava concluída (`awaiting_review`/`approved`), o `confidence_score` agregado e o score de pilar são recalculados imediatamente, não só na próxima vez que alguém abrir a sessão.
- **Upload** (`routes/radar.ts`, `POST /sessions/:id/evidence`, multipart): mesmo padrão de `routes/uploads.ts` (disco local em `MEDIA_DIR/radar-evidence/`, servido em `/media/radar-evidence/...`), mas aceita PNG/JPG/WEBP **ou PDF** (evidência costuma ser print de tela ou relatório exportado, não só imagem) — e espelha para S3 via `StorageService.mirrorToS3` quando configurado (`ReportPdfService` já era o modelo de referência para esse padrão).
- **Frontend (`RadarView.tsx`)**: campo de upload abaixo do comentário na tela de pergunta, com aviso "responda primeiro" quando a pergunta ainda não tem resposta salva. Isso expôs outro ajuste necessário: **antes**, a resposta só era salva no servidor ao clicar "Próxima" — não havia momento em que a pergunta ATUAL já tivesse uma resposta persistida para anexar evidência a ela. Corrigido: selecionar uma opção (ou "não sei") agora salva na hora (`saveCurrent`), e "Próxima" continua salvando de novo (é upsert) para capturar um comentário digitado depois de escolher a opção. Tela de resultado ganhou uma nota de confiança (`Confiança das respostas: NN%`) quando o dado existe.

## Validação real

Além de **16 verificações novas** (`scripts/test-radar-evidence.ts` — bugfix de retomada, exigência de resposta prévia, subida de confiança sem regressão, recálculo pós-conclusão, isolamento por organização, auditoria) e da suíte completa do projeto (**9 scripts, 150 verificações, todas passando**, nenhuma alterada por este PR), testei em Chromium real: responder a primeira pergunta, anexar um arquivo de verdade (upload multipart de ponta a ponta), ver a evidência listada, completar as 18 perguntas, ver a nota de confiança na tela de resultado, e — separadamente — confirmar o bugfix de retomada (responder 3 de 18, sair, reabrir a mesma sessão, cair exatamente na pergunta 4).

## Não incluído nesta rodada (deliberado)

- **Nível de confiança 1,00 ("baseline medido").** Continua reservado para quando um pilar for preenchido a partir de dado medido de verdade (ex.: `RevenueIntelligenceService`), não de evidência anexada manualmente — ideia já registrada desde a ADR-009, não implementada aqui.
- **Exclusão/gestão de evidência já anexada.** Só criação e listagem; remover um anexo enviado por engano fica para quando houver sinal de necessidade real.
- **Evidência por respondente** (`radar_respondents`/multi-respondente da ADR-014) usa o mesmo `answer_id`, então já funciona tecnicamente quando o respondente responder via login próprio — mas como o convite por link (resposta sem login) continua fora de escopo, isso na prática só é alcançável hoje pelo usuário autenticado que criou a sessão.
