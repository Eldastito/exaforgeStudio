# ADR-031 — Cadastro de estoque/vitrine direto no WhatsApp (a "IA do negócio")

**Status:** Implementado e testado (38 verificações novas, suíte completa sem quebras — 32 scripts, `lint`/`build` limpos). A extração por visão em si (classificação, nome/marca/peso, itens da nota) reaproveita `extractProductFromImage`/`extractInvoiceItems`, já validadas contra a API real na ADR-030 — este ADR cobre o que é novo: o canal, o roteamento e a máquina de perguntas.
**Origem:** pedido explícito do usuário, com decisões confirmadas em conversa (ver "Decisões" abaixo).

## Contexto

O Smart Inventory (ADR-019/020/021/022) já cadastra produto por foto e nota fiscal — mas só pelo **painel web**: o lojista tira a foto no celular, abre o navegador, faz upload, revisa e confirma. O pedido foi levar esse cadastro para dentro do **WhatsApp**, no fluxo natural de quem já fotografa o produto no estoque com o celular, e usar uma IA **separada da IA de atendimento ao cliente** — a "IA do negócio" — para conduzir a conversa.

## Decisão: reaproveitar o canal do gestor já existente

O sistema já tinha exatamente essa separação, só que para outro propósito: `AIOrchestratorService.findAuthorizedManager()` reconhece o número de WhatsApp do lojista/gestor (tabela `authorized_managers`) e roteia para o agente **`orchestrator_agent`** ("Zapp") em vez do `attendance_agent` que atende clientes — hoje usado para relatórios e criação de campanhas, com um mecanismo de "propor ação → gestor confirma → executa" (`pending_manager_actions`). Não foi criado nenhum canal/número novo: o cadastro por foto entra nesse mesmo canal do gestor, sem precisar do prefixo "zap" — a própria foto já é a intenção.

## Fluxo 1 — foto de produto avulso

1. Gestor manda a foto pelo WhatsApp.
2. `classifyInventoryPhoto()` (novo, `llm.ts`) decide barato se é produto ou nota fiscal; se não tiver certeza, pergunta.
3. `extractProductFromImage()` (já existente, ADR-019/030) extrai nome/marca/peso/categoria — **nunca preço**, mesma regra de sempre.
4. A conversa pergunta o que falta para publicar: quanto custou, que margem aplicar (ou o preço de venda direto), e a quantidade em estoque. As três perguntas saem juntas na primeira mensagem; o lojista pode responder tudo de uma vez ou aos poucos — `parseInventoryReply()` (novo) extrai só o que a mensagem realmente diz, sem nunca inventar um valor não informado.
5. Completo, publica: cria o produto, o estoque inicial e usa a PRÓPRIA foto enviada como imagem do produto — sempre com `storefront_visible=1` (o lojista já revisou tudo na conversa; não existe um segundo "publicar" separado do painel).
6. Grava em `product_price_history` o custo/margem/preço informados — **não é aprendizado de modelo** (sem treino/fine-tuning): é um registro estruturado que cresce a cada cadastro, disponível para uma futura sugestão de margem por categoria.

## Fluxo 2 — foto de nota fiscal

1. `extractInvoiceItems()` (já existente) extrai fornecedor + itens (nome, quantidade, custo — dado real da nota, não palpite).
2. Item que já existe no catálogo com match **bem forte** (limiar 0.75 — mais rígido que o 0.6 da tela de revisão do painel, porque aqui **não há humano conferindo antes**): repõe estoque sozinho, sem perguntar nada.
3. Item novo: como a nota já traz quantidade e custo, só falta o preço de venda — a conversa pergunta item por item (com uma sugestão calculada pela margem padrão da loja, `orgMarkup()`), publica assim que o preço vem.

## Por que dois limiares diferentes de match (0.6 vs 0.75)

A tela de revisão do painel (ADR-024) usa 0.6 como **pré-seleção** que um humano sempre confere antes de confirmar — o custo de errar é baixo (o humano corrige). Aqui não há revisão: um match errado repõe estoque no produto errado silenciosamente. Por isso o limiar sobe para 0.75 — só automatiza quando a confiança é bem alta; abaixo disso, o item vai para a fila de "novo produto" (mais seguro cadastrar duplicado do que reabastecer o item errado).

## Simplificações desta primeira versão

- **Nota fiscal com vários itens novos**: perguntados **um de cada vez**, não em lote. Simples e seguro de implementar corretamente; mais lento quando há muitos itens novos na mesma nota. Pode virar "pergunta tudo de uma vez" numa iteração futura se o volume justificar.
- **Classificação incerta**: se a IA não tiver certeza se a foto é produto ou nota, pergunta ao gestor antes de prosseguir — evita extrair com o prompt errado.
- **Sem exposição pública nova**: nenhuma rota HTTP nova; o cadastro só existe pela conversa autenticada por número de telefone (`authorized_managers`, já com controle de acesso próprio).
- **Meta/Instagram**: o webhook da Meta não processa imagem (limitação pré-existente, não coberta aqui) — o fluxo funciona no Evolution API, que é o canal em uso.

## Arquitetura

- `PendingManagerActions.ts` (novo): extraído do `AIOrchestratorService.ts` para evitar import circular — o CRUD genérico de "ação pendente do gestor" agora é compartilhado entre o fluxo de campanha (`create_campaign`) e o cadastro de estoque (`product_registration`/`invoice_registration`/`awaiting_photo_type`), sem duplicar lógica.
- `InventoryIntakeService.ts` (novo): funções de commit (criar produto, repor estoque, registrar histórico de preço) chamáveis fora do Express — espelham deliberadamente a lógica já testada das rotas HTTP em vez de refatorá-las (mexer no caminho já validado em produção teria mais risco do que duplicar ~15 linhas).
- `WhatsAppInventoryIntake.ts` (novo): a máquina de estado conversacional (classificar → extrair → perguntar → comitar), com o estado da conversa vivendo em `pending_manager_actions`.
- `AIOrchestratorService.processMessage()`: ganha `imageBase64`/`imageMime` opcionais; gestor+foto desvia para o fluxo novo ANTES de qualquer checagem de limite/plano/RAG; resposta a uma ação pendente que não seja `create_campaign` desvia para `WhatsAppInventoryIntake.handleReply` em vez do gate de sim/não de campanha.
- `server.ts`/`webhookProcessor.ts`: o base64 original da foto (já capturado hoje só para exibir miniatura e rodar `analyzeImageForChat` no atendimento) passa a ser repassado também ao orquestrador — usado apenas quando o remetente é um gestor autorizado.

## Validação

`npm run test:whatsapp-inventory-intake` (38 verificações) + suíte completa (32 scripts, zero quebras) + `lint`/`build` limpos:
- Commit de produto/item de nota: preço/margem/quantidade corretos, `storefront_visible=1`, foto vira imagem do produto, custo médio ponderado, auditoria.
- `resolveProductFields`: cálculo de preço por margem, preço direto, quantidade zero é válida, campos faltantes corretos.
- Limiar 0.75 rejeita um match que o 0.6 da revisão humana aceitaria (prova que os dois comportamentos são intencionalmente diferentes).
- Roteamento: gestor+foto entra no fluxo novo (falha com mensagem amigável neste sandbox sem `OPENAI_API_KEY` — mesma limitação da ADR-030); cliente comum+foto **não** entra nesse fluxo (regressão); ação pendente de campanha continua com o gate sim/não original (regressão); continuação de um cadastro pendente não cai no gate de campanha.

## O que fica para depois (não pedido nesta entrega)

O usuário também descreveu uma "vitrine ao vivo por cliente" — um link único por conversa do cliente final, mostrando só os itens que ele foi pedindo pelo WhatsApp, atualizado conforme a conversa avança. É um conceito novo do zero (hoje não existe carrinho acumulado por contato, só orçamento em snapshot) e fica para uma entrega separada.
