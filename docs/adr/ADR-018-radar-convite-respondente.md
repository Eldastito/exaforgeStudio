# ADR-018 — Radar: convite de respondente por link próprio (sem login)

**Status:** Implementado e testado ponta a ponta em navegador real (convite criado, respondido sem login numa aba separada, retomada e conclusão confirmadas).
**Origem:** último dos dois itens pendentes do Radar. Escolhido em vez da matriz `radar_processes`/`execution_gap_index` por ser aditivo (não toca no motor de score já testado) e por estender infraestrutura que já existia — o padrão de token opaco do diagnóstico público (ADR-012) e a tabela `radar_respondents` (ADR-014, até aqui só cadastro/listagem).

## Modelo de segurança: mesmo padrão do diagnóstico público, aplicado a UM respondente de UMA sessão

`RadarRespondentService` resolve tudo por token — nunca por ID direto (evita enumeração), nunca por `organizationId`/JWT. Token opaco de 32 bytes (`crypto.randomBytes`), só o hash SHA-256 fica no banco (`radar_respondents.invite_token_hash`), expira em 30 dias — reaproveitando exatamente a mesma técnica de `radar_sessions.public_token_hash`, sem inventar um segundo padrão de convite no mesmo produto.

Diferença chave em relação ao diagnóstico público (Fase 2): ali a sessão inteira é anônima (`organization_id IS NULL`) até virar lead; aqui a sessão **já pertence a um tenant** — o convite dá acesso só à contribuição de UM respondente, nunca ao controle da sessão (não pode editar contato, recalcular, aprovar ou ver o resultado agregado — isso continua exclusivo de quem está autenticado como owner/admin da organização).

## Reaproveita o motor de gravação existente — não duplica lógica de confiança/score

`RadarRespondentService.saveAnswer` delega para `RadarService.saveAnswer` (o MESMO método que o dono autenticado da sessão usa), passando `respondentId`. `radar_answers.respondent_id` já existia desde a Fase 1 (o schema sempre soube que múltiplos respondentes eram possíveis), mas nunca tinha um caminho de escrita além do usuário autenticado que criou a sessão. Resultado: nenhuma segunda cópia da lógica de confiança (0,60/0,75) que pudesse divergir da já testada.

## Decisão de produto que não estava óbvia: como o score trata múltiplos respondentes

`RadarScoringEngine` (o motor de cálculo) **não filtra por `respondent_id`** — soma todas as respostas de uma pergunta, de qualquer respondente, na mesma média ponderada do pilar. Decisão consciente para esta rodada: é um **diagnóstico coletivo** (várias pessoas contribuindo pro mesmo número), não um segundo diagnóstico paralelo por pessoa. Testado explicitamente: um respondente respondendo tudo no máximo e outro tudo no mínimo, na mesma sessão, produz um score no meio (não 0, não 100) — comportamento documentado no teste automatizado, não um efeito colateral escondido. Segmentar a contribuição por seção/pilar por respondente é uma evolução possível, mas exigiria desenhar "quem responde o quê" — não implementado sem esse sinal.

## Bug de UX encontrado e corrigido no caminho: convite só era possível DEPOIS de concluir

`RespondentsSection` (o bloco "Respondentes" com o botão "Convidar") só existia dentro de `ResultView` — a tela que só aparece depois que a sessão já foi concluída (score calculado). Isso tornava impossível o caso de uso mais óbvio do recurso: convidar alguém pra ajudar a responder **antes** de terminar sozinho. Corrigido: `RespondentsSection` agora também aparece em `QuestionsView` (a tela de perguntas, sessão ainda em andamento), gated por `isManager` do mesmo jeito. Encontrado ao montar o teste end-to-end real (o fluxo natural de testar — responder 3 de 18 perguntas e então tentar convidar alguém — simplesmente não tinha onde clicar).

## Frontend

- `RadarView.tsx`: `RespondentsSection` agora mostra o link do convite (uma vez, com botão copiar) logo após criar, status de cada respondente (`Convidado`/`Respondendo`/`Concluído`/`Revogado`) e ação de revogar.
- `RadarRespondentWizard.tsx` (novo, `/radar-ia/respond/:token`): mesma linguagem visual do diagnóstico público (`RadarPublicWizard.tsx`), mas sem onboarding (respondente já identificado pelo token) e sem tela de resultado com score (o resultado agregado da organização é do painel autenticado, não deste visitante) — termina numa tela simples de agradecimento.
- `main.tsx`: `/radar-ia/respond/:token` precisa ser checado ANTES da checagem genérica de `/radar-ia/*` (que cobre o diagnóstico anônimo da Fase 2), senão cairia no wizard errado.

## Validação real

**22 verificações novas** (`scripts/test-radar-respondent.ts`): token resolve/expira/é revogado corretamente, resposta grava com `respondent_id` certo (sem sobrescrever a do dono da sessão), status do convite sobe `invited → active → completed`, sessão fora de `draft`/`in_progress` rejeita nova resposta de respondente (mesma guarda do dono), diagnóstico coletivo confirmado com médias reais, isolamento por organização. Suíte completa do projeto: **12 scripts, 220 verificações, todas passando**, nenhuma alterada por este PR.

Fluxo end-to-end real: convite criado e link copiado pelo dono da sessão (ainda em andamento, só 3 de 18 perguntas respondidas) → aba separada do navegador, **sem nenhum token/login** → convidado vê o nome da empresa, responde as 18 perguntas, chega na tela de agradecimento com o próprio primeiro nome → reabrir o mesmo link depois de concluído mostra a tela de agradecimento de novo (não reinicia o questionário) → dono da sessão reabre e vê o respondente como "Concluído".

## Não incluído nesta rodada (deliberado)

- **Atribuir perguntas/pilares específicos a cada respondente.** Todo respondente vê as MESMAS 18 perguntas do template — segmentar por seção exigiria desenhar "quem deveria responder o quê", sem esse sinal ainda.
- **Reenvio do link por WhatsApp/e-mail direto do convite.** O dono da sessão copia e envia manualmente por enquanto — a infraestrutura de envio (ADR-017) poderia ser reaproveitada aqui numa rodada futura.
- **Matriz `radar_processes`/`execution_gap_index`** continua fora de escopo, mesmos motivos já registrados.
