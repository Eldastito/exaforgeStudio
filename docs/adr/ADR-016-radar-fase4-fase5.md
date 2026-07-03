# ADR-016 — Radar Fase 4/5: relatório em PDF com narrativa por IA, ponte com Tarefas, lembrete de reavaliação

**Status:** Implementado e testado ponta a ponta em navegador real.
**Origem:** perguntado diretamente se as Fases 4/5 (que eu tinha classificado como bloqueadas em relatos anteriores) davam para fazer agora.

## Correção de uma afirmação anterior

Numa resposta anterior eu disse que Fase 4/5 dependiam de "revisão jurídica" e "infraestrutura de e-mail/WhatsApp própria da ZappFlow" — isso estava certo só para uma fatia específica (entrega proativa do relatório a um **prospect** externo, que usaria o canal da própria ZappFlow, cenário da Fase 2/landing pública). Não se aplicava ao grosso da Fase 4/5, que entrega o relatório a alguém **dentro do próprio tenant**, usando (se um dia for enviado por WhatsApp/e-mail) o canal que o próprio cliente já configura para operar o negócio dele — a funcionalidade central do produto. Levantei o código antes de decidir, e a maior parte era construível sem nenhuma dependência externa.

## Escopo desta rodada — decisões tomadas sem esperar confirmação (tool de pergunta falhou de novo)

Como da vez anterior nesta sessão, o `AskUserQuestion` falhou (erro de stream). Segui com as opções que eu mesmo tinha marcado como recomendadas:

1. **Tarefas a partir de recomendações: só com botão explícito**, nunca automático ao aprovar — mesma regra do produto inteiro de nunca deixar IA/sistema agir sozinho sem controle humano.
2. **PDF: só sob demanda** (botão "Gerar relatório"), não gerado automaticamente ao concluir/aprovar — tem custo de chamada de IA e nem toda sessão precisa de relatório formal.
3. **Sem envio automático por WhatsApp/e-mail nesta rodada** — só download do PDF. Fica pra quando fizer sentido testar com tráfego real de canal.

## O que foi construído

### Narrativa por IA (`RadarNarrativeService.ts`)

Reaproveita `chat()` de `src/server/llm.ts` — a MESMA camada de IA já usada pelo resto do produto, com `isAIConfigured()` como gate (sem `OPENAI_API_KEY`, devolve `null` e o relatório sai igual, só sem essa seção; nunca lança erro, nunca quebra o fluxo). Prompt rígido: a IA recebe o JSON já calculado (score, pilares, recomendação principal) e é instruída a **só narrar em prosa**, nunca inventar/alterar número — mesma regra não-negociável do PRD do módulo (§3) que já regia todo o resto do Radar (nenhuma IA generativa decide score/prioridade/risco).

### PDF (`ReportPdfService.generateRadarReport`)

Estende o serviço existente (usado hoje só para o PDF de gestor) com um novo método — não dava pra reaproveitar o método antigo porque a lib é `pdfkit` (texto desenhado programaticamente, não HTML virando PDF), então o layout do Radar (score, barra por pilar, recomendações, narrativa opcional) precisou ser desenhado do zero, mas seguindo exatamente o mesmo padrão visual/técnico do relatório de gestor já em produção.

### Ponte com Tarefas (`RadarService.createTasksFromRecommendations`)

Cada recomendação de prioridade `alta` da sessão vira uma Tarefa via `TaskService.create` (que ganhou `"radar"` na lista de `source` aceitos). **Idempotente**: usa `ref_label = "radar:<sessionId>:<recommendationId>"` como chave — clicar duas vezes no botão não duplica.

### Lembrete de reavaliação (`RadarService.reassessmentReminderPass`, plugado em `Scheduler.tick()`)

Sessão concluída há 90+ dias gera **uma notificação in-app** (não WhatsApp/e-mail — decisão 3 acima). Usa o `dedupeKey` que `NotificationService.push` já suporta (janela de ~1 ano) para nunca duplicar o mesmo aviso a cada hora que o Scheduler roda — sem precisar de coluna nova pra rastrear "já avisei".

### Frontend (`RadarView.tsx`)

Seção "Ações" na tela de resultado (só para owner/admin): "Gerar relatório (PDF)" e, quando existe pelo menos uma recomendação `alta`, "Criar tarefas das recomendações de prioridade alta".

## Validação real

**19 verificações novas** (`scripts/test-radar-report-tasks.ts`) cobrindo: relatório funciona SEM `OPENAI_API_KEY` configurada (o cenário real de CI/testes automatizados), rejeita sessão sem score, ponte com Tarefas é idempotente e isolada por organização, sessão sem recomendação `alta` não quebra (só cria 0), lembrete de reavaliação respeita a janela de 90 dias e não duplica. Suíte completa do projeto: **10 scripts, 169 verificações, todas passando**, nenhuma alterada por este PR.

Ao montar o teste ponta a ponta descobri (e documentei no próprio teste) que respostas uniformes (tudo "4" ou tudo "0") **nunca** produzem recomendação `alta` no motor real — o cálculo de `businessImpact` (quanto pior o pilar-alvo, maior a oportunidade) briga com os termos de prontidão/alinhamento/governança (que querem os OUTROS pilares altos), então só um pilar fraco cercado de pilares fortes atinge o limiar de 70 pontos. Usei esse padrão (pilar "receita" fraco, resto forte, com comentário para bater a confiança ≥0,70) tanto no teste automatizado quanto no fluxo real de navegador, e confirmei visualmente: score 80, "Receita e atendimento" em 0, as demais em 100, três recomendações em banda `alta`, PDF gerado e baixável de verdade via HTTP (`Content-Type: application/pdf` confirmado), 5 tarefas criadas com `source='radar'` (confirmado via API, não só na tela).

## Não incluído nesta rodada (deliberado)

- **Envio automático por WhatsApp/e-mail do relatório** — decisão 3 acima. A infraestrutura de canal por organização (`MessageProviderService`, `GoogleOAuthService`) já existe e funcionaria tecnicamente para o tenant que já tem canal conectado, mas construir esse fluxo (com fallback claro para quem não tem canal) fica para quando fizer sentido testar com tráfego real.
- **PDF/tarefas automáticos ao concluir/aprovar** — decisões 1 e 2 acima.
- **`radar_processes`/`execution_gap_index`** (matriz impacto/recorrência/urgência/prontidão) e **convite de respondente por link próprio** continuam fora de escopo pelos mesmos motivos já registrados na ADR-015.
