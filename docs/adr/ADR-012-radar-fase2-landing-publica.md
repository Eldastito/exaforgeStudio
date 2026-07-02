# ADR-012 — Radar Fase 2: diagnóstico rápido público (landing sem login)

**Status:** Implementado — backend completo e testado, frontend funcional testado em navegador real (fluxo ponta a ponta, viewport mobile).
**Origem:** próxima fase natural do roadmap do Radar (ADR-009/010/011), com a pendência de escopo ("destino do lead") resolvida por decisão do usuário: `ProspectService`.

## Decisão de escopo confirmada: destino do lead

`ProspectService` (pipeline B2B de prospecção), não `tickets`/Kanban de atendimento — como recomendado desde a ADR-009. Um lead do Radar é um contato pré-venda outbound, não uma conversa de canal.

## A pergunta que a Fase 1 tinha deixado sem resposta: para qual organização vai o lead?

`prospect_accounts`/`prospect_contacts` são tabelas **por organização** (multi-tenant). Um visitante da landing pública ainda não tem organização — é justamente isso que a torna "pública". Então qual organização recebe esses leads?

Resposta: **a própria ZappFlow, como sua própria cliente do produto** (uso interno do funil de vendas, "eat your own dog food"). Isso é configurado via `RADAR_LEADS_ORGANIZATION_ID` — **não** um valor hardcoded ou inventado. Sem essa env configurada, o diagnóstico funciona normalmente e os dados do lead ficam 100% capturados em `radar_sessions` (nome, empresa, e-mail, telefone, segmento — nada se perde); só não são empurrados automaticamente para nenhum CRM, porque inventar uma organização de destino arriscaria vazar um lead de marketing para o tenant errado. **Ação necessária do usuário:** criar (ou apontar para) a organização ZappFlow dentro do próprio produto e configurar `RADAR_LEADS_ORGANIZATION_ID` com o `organization_id` dela.

## Arquitetura

### Motor de score compartilhado — refatoração antes de construir

Antes de tocar em qualquer coisa nova, extraí `RadarScoringEngine.ts` de dentro de `RadarService.ts`: a fórmula de score/priorização agora mora num lugar só, chamada tanto pelo fluxo autenticado (`RadarService`, que valida posse por `organization_id` antes de delegar) quanto pelo fluxo público (`RadarPublicService`, que valida por token antes de delegar). Sem essa extração, a Fase 2 teria duas cópias da mesma fórmula — exatamente o tipo de duplicação que este projeto tem evitado desde a ADR-011 (`logAuthEvent` copiado em 10 arquivos). A suíte de testes da Fase 1 (`test:radar-isolation`, 18/18) e da Velocidade (`test:conversion-velocity`, 23/23) foram rodadas de novo após a extração — mesmo resultado, comportamento preservado.

### `RadarPublicService.ts` — autorização por token, nunca por organização

Sessão pública: `radar_sessions.organization_id IS NULL` (mesma exceção documentada desde a ADR-009). Token opaco de 32 bytes (`crypto.randomBytes`), só o hash SHA-256 fica no banco (`public_token_hash`) — mesmo padrão de `org_invitations`, que já era o modelo de referência apontado na ADR-009. Expira em 30 dias (PRD §15.5). Todo método do serviço resolve a sessão pelo token primeiro; nenhum aceita um ID de sessão direto (evita enumeração).

Template: sempre o único template global (`organization_id IS NULL`, semeado no boot) — um visitante anônimo nunca escolhe template, evita expor essa superfície a quem ainda não é cliente.

Status terminal da sessão pública é `'completed'`, não `'awaiting_review'` (usado no fluxo com consultor) — não há revisão humana no caminho crítico do diagnóstico rápido; é autoatendimento com resultado instantâneo, por definição do próprio produto.

### Criação de lead — regras, todas testadas

Só cria o registro em `ProspectService` quando **todas** as condições abaixo são verdadeiras:
1. `RADAR_LEADS_ORGANIZATION_ID` configurada e apontando para uma organização que existe de fato.
2. Consentimento `contato_comercial` concedido explicitamente (checkbox separado do consentimento obrigatório de "analisar minhas respostas").
3. E-mail ou telefone presentes.

Qualquer uma faltando: sessão completa normalmente, resultado é mostrado, só o lead não é criado — nunca lança erro, nunca trava o fluxo do visitante.

### `ProspectService.importRecords` ganhou um `provider` opcional

Antes, todo registro importado (por qualquer chamador) era gravado com `source='csv_import'` **hardcoded** na query — não parametrizado. Um lead do Radar marcado como `csv_import` seria dado de procedência errada. Adicionado `provider` opcional (default `'csv_import'`, preserva 100% o comportamento do único call site existente — `routes/prospect.ts`), o Radar passa `provider: 'radar_ia'`. Testado que o default não regrediu (`test:radar-public`, verificação dedicada).

### Rotas públicas — mesmo padrão de `storefrontPublicRoutes`

`src/server/routes/radarPublic.ts`, montada em `/api/public/radar` **antes** do bloco `protectedApi` em `server.ts` (nunca exige JWT, mesmo comentário/motivo já usado para a vitrine). Kill-switch próprio (`PUBLIC_RADAR_ENABLED`, PRD §17), independente do módulo `radar` que já protege as rotas autenticadas.

Anti-abuso: honeypot (campo `website` escondido via CSS, só bot preenche — responde 201 fingido sem criar nada) + rate limit em memória por IP (10 criações/hora — o endpoint mais caro de se abusar). O limitador é uma cópia pequena e autocontida do padrão já usado em `server.ts` para webhooks (não exportado de lá, então replicado — poucas linhas, sem risco de tocar em código que já funciona).

### Frontend — sem router, mesmo padrão do Storefront/LandingPage

`react-router-dom` está no `package.json` mas **não é usado em lugar nenhum do projeto** (confirmado por grep antes de decidir) — o app inteiro roteia por checagem manual de `window.location.pathname` em `main.tsx`. Segui o mesmo padrão: `pathname.startsWith('/radar-ia')` monta `RadarPublicWizard`, sem introduzir uma dependência nova de roteamento que o resto do app não usa. URL de sessão: `/radar-ia/s/:token[/resultado]`, atualizada via `history.pushState` (sem reload), token lido do path manualmente — mesma técnica de `Storefront.tsx: readUrl()`.

Quatro passos num componente só (`intro` → `onboarding` → `questions` → `result`), Tailwind + `lucide-react`, mesmas variáveis CSS de marca (`--color-zf-teal`/`--color-zf-amber`) já usadas em `LandingPage.tsx` — visualmente consistente com as outras páginas públicas do produto, sem inventar um segundo design system.

## Validação real (não só testes de unidade)

Além dos testes automatizados, o fluxo foi executado de ponta a ponta num Chromium headless real (viewport 420×900, simulando celular — PRD exige "visitante consegue concluir no celular"): landing → onboarding preenchido → 18 perguntas respondidas uma a uma → resultado com score, 7 pilares e recomendação. Testado nos dois extremos da escala (todas respostas no mínimo → score 0/"Inerte"; todas no máximo, via teste de backend → score 100/"Inteligente") e a retomada por link direto (abrir a URL de resultado numa aba/navegador novo, sem estado local, funciona). Zero erros de console além de um 404 de `favicon.ico` pré-existente no site inteiro, sem relação com o Radar.

## Testes

`scripts/test-radar-public.ts` (`npm run test:radar-public`), 24 verificações: validação de campos obrigatórios, honeypot, token por hash (nunca por ID), expiração, determinismo do score (mesmo motor da Fase 1), as 3 condições de criação de lead (cada uma isolada), organização de destino inexistente tratada sem lançar exceção, e a regressão do `provider` default em `ProspectService.importRecords`. Suíte completa do projeto: **7 scripts, 113 verificações, todas passando**, sem alterar comportamento de nenhuma anterior.

## Não incluído nesta rodada (deliberado)

- **Entrega por e-mail/WhatsApp do resultado.** O envio transacional hoje depende de o TENANT ter conectado seu próprio Gmail/WhatsApp (`GoogleOAuthService`) — não existe infraestrutura de e-mail/WhatsApp própria da ZappFlow para sua própria landing de marketing. Fabricar credenciais/config para isso seria inventar infraestrutura que não existe. O link de resultado já é standalone e reutilizável (bookmarkable), então a landing funciona sem essa peça — entrega ativa fica para quando a ZappFlow tiver seu próprio canal de saída configurado.
- **Botão "solicitar diagnóstico executivo" com fluxo próprio.** O CTA final da Fase 2 é um link de WhatsApp simples; o endpoint `request-consultation` do PRD (§14.1) não foi construído — teria exigido decidir mais uma vez para qual organização essa solicitação vai, mesma questão do lead, sem urgência adicional além do link direto já resolver o objetivo comercial imediato.
- **Painel do consultor / diagnóstico executivo multi-respondente** — Fase 3, natureza diferente (autenticado, dentro do produto).
- **UI de administração do módulo** (toggle em Configurações, visualização de leads capturados) — mesma lacuna já registrada nas ADRs anteriores.
