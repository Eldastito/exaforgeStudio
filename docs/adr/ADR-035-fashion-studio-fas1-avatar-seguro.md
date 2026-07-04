# ADR-035 — Fashion AI Studio, FAS-1: conta de cliente, consentimento e avatar seguro

**Status:** Implementado e testado (44 verificações novas, suíte completa sem quebras — 34 scripts, `lint`/`build` limpos). A chamada de visão da validação de foto é a única parte que exige a chave de IA de produção (mesma limitação registrada desde a ADR-030).
**Origem:** PRD-E-006, segunda entrega (FAS-1). Decisões de escopo do usuário registradas na ADR-034.

## O que o FAS-1 entrega

O caminho completo da foto guiada: criar conta → aceitar o termo → enviar a foto → validação automática → foto aprovada guardada em storage privado, pronta para as fases de look/geração (FAS-2/3).

### 1. Conta de cliente do provador (`storefront_customers` + `FashionCustomerService`)

- A vitrine continua **100% anônima** para navegar e comprar (decisão do usuário) — a conta só existe para o provador.
- **O cadastro vira lead no CRM**: canal sintético "Loja Virtual" (`provider='storefront'`) criado por organização, contato criado nele com nome/telefone/e-mail, notificação de novo lead para a equipe. Best-effort: falha no CRM nunca bloqueia o registro.
- **Gate de 18 anos** no registro (data de nascimento obrigatória; menor recebe a orientação de usar a conta do responsável — decisão do usuário; o tipo de consentimento `guardian_approval` já existe para o responsável declarar o acompanhamento). Cálculo de idade correto na borda do aniversário, testado.
- Contas são **por loja** (mesmo e-mail pode existir em lojas diferentes; login escopado pela organização).

### 2. Segurança de token — a decisão mais importante desta fase

O `requireAuth` do painel aceita qualquer JWT assinado com `JWT_SECRET` que contenha `organizationId` — e muitas rotas do painel autorizam só por esse campo. Se o token do cliente do provador (que qualquer pessoa obtém num cadastro público) usasse o mesmo segredo, **um cadastro de loja viraria acesso ao painel administrativo da organização**. Por isso o token do provador é assinado com um **segredo derivado** (`sha256(JWT_SECRET + sufixo)`): a verificação do painel falha por assinatura e vice-versa. Testado nos dois sentidos como check crítico.

### 3. Consentimento antes de tudo (RF-002/003/004)

- `fashion_consents` versionado (`policy_version`, data, tipo); upload **nem grava arquivo** sem consentimento `avatar_processing` ativo — checado no serviço, não só na rota.
- Revogar o consentimento **apaga os avatares na hora** (arquivo incluído).
- Exclusão total ("apagar minha foto, preferências e conta") anonimiza a conta, revoga consentimentos, apaga preferências/perfil e todos os arquivos — o token antigo deixa de valer imediatamente.

### 4. Storage privado com URL assinada

- Avatares vivem em `DATA_DIR/private_media` — diretório **não servido** pelo `express.static` (o `/media` público segue intocado para foto de produto, decisão da ADR-034).
- Único caminho de leitura: URL assinada (HMAC com segredo derivado próprio + expiração de 15 min), emitida apenas à dona pela rota autenticada. Verificação com `timingSafeEqual`, anti path-traversal (`path.basename`), `Cache-Control: private, no-store`.
- EXIF removido no re-encode via sharp (RF-010, mesma técnica da ADR-020).

### 5. Quarentena e validação da foto guiada (seções 6.2/6.3)

- Todo upload nasce `quarantined`; só vira `approved` após a validação.
- A IA de visão (`validateGuidedPhoto`) devolve **apenas flags booleanas objetivas** (uma pessoa, adulta, corpo inteiro, frontal, luz, braços, conteúdo seguro, sem documentos) — proibida de comentar corpo/aparência.
- O texto mostrado à cliente vem de um **catálogo fixo de mensagens** (`evaluatePhotoReport`, determinístico e testado) — nunca de texto livre da IA; conteúdo impróprio recebe mensagem neutra; flags ausentes reprovam por segurança (nunca aprova no vácuo). Sem chave de IA, o upload falha com mensagem amigável — **nunca aprova sem validar**.

### 6. Retenção (19.4)

`fashion_avatar_retention_days` por loja (padrão 30, clamp 1–365). Expiração preguiçosa no acesso + purga horária no `Scheduler` (mesmo padrão do `LgpdService.retentionPass`) — a purga apaga o **arquivo**, não só a linha.

### 7. UI guiada na vitrine (`FashionStudio.tsx`)

Botão flutuante "Provador Virtual" que só aparece quando a loja tem o módulo ligado (probe no endpoint do FAS-0 — 404 = não renderiza). Fluxo em passos: introdução (aviso de 18+ e privacidade) → conta (criar/entrar) → termo de uso da imagem (com a retenção real da loja) → guia da foto → envio → status (aprovada com prévia via URL assinada / recusada com os motivos legíveis) → trocar/apagar foto e apagar tudo. Sessão própria em `localStorage`, isolada por loja.

## Fora desta fase (próximas)

- FAS-2: questionário, consultora por ocasião, Look Builder (até 3 looks candidatos com explicação segura).
- FAS-3: provedor de try-on plugável + jobs assíncronos + créditos (o limite diário do FAS-0 passa a ser consumido aqui).
- FAS-4: carrinho do look completo + link seguro via WhatsApp.
- FAS-5: memória de estilo.

## Validação

`npm run test:fashion-avatar` (44 verificações) + suíte completa (34 scripts, zero quebras) + `lint`/`build` limpos. Destaques: gate de 18 anos na borda do aniversário; isolamento bidirecional de tokens (crítico); lead no CRM com vínculo; consentimento obrigatório e revogação destrutiva; catálogo de recusas legíveis; URL assinada (válida/expirada/adulterada/traversal); exclusão apaga o arquivo físico; purga por retenção; clamps de configuração.
