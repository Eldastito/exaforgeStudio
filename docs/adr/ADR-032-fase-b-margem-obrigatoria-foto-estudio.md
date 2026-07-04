# ADR-032 — Fase B do cadastro por WhatsApp: margem obrigatória, recusa registrada, reposição por reconhecimento e foto de catálogo por IA

**Status:** Implementado e testado (39 verificações novas, suíte completa sem quebras — 34 scripts, `lint`/`build` limpos).
**Origem:** pedido explícito do usuário como ajuste de comportamento sobre a ADR-031, com 4 decisões confirmadas em conversa (ver "Decisões" abaixo).

## Contexto

A ADR-031 entregou o cadastro de produto/nota fiscal por foto no WhatsApp. O usuário pediu três endurecimentos de regra sobre esse fluxo — nunca publicar sem margem decidida, tratar recusa explicitamente, e reconhecer quando a foto é de um produto já cadastrado (reposição) — e uma esteira nova: transformar a foto crua em foto de catálogo profissional via IA, coordenada pelo orquestrador com cache para não gastar IA à toa.

## Decisões confirmadas com o usuário

1. **Escopo da regra de margem — só IA/WhatsApp.** O painel web continua como hoje (sem campo de margem obrigatório); a trava vale só para o fluxo conversacional novo.
2. **Preço de venda direto conta como válido.** Se o lojista informa o preço final sem citar custo/margem, isso é decisão de quem manda no negócio — publica normalmente. `margin_percent` fica `NULL` nesse caso (não é um erro, é informação que simplesmente não foi calculada).
3. **Auditoria proativa só quando o gestor já está conversando.** Nenhuma mensagem é disparada só para lembrar de preços pendentes — o aviso só aparece grudado numa resposta que já ia sair (foto processada ou pergunta pendente respondida), com rate-limit de 24h por organização.
4. **Foto de catálogo por IA é opt-in por loja**, com toggle em Configurações da Loja — cada geração é uma chamada de IA extra, nem toda loja quer o custo/estilo por padrão.

## O que muda no Fluxo 1 (foto de produto avulso)

- **Reconhecimento de catálogo ANTES de perguntar**: a foto extraída passa por `findBestProductMatch` (limiar 0.75, igual à reposição automática do Fluxo 2 — aqui também não há humano conferindo antes de decidir). Produto já cadastrado → vira **reposição**: pergunta só a quantidade, reaproveita preço/margem já praticados e **sempre avisa o dono** qual preço está sendo reaproveitado (nunca silencioso). Produto genuinamente novo → segue perguntando custo/margem/quantidade como antes, agora explicando na primeira pergunta por que o preço importa ("sem ele o produto fica só no controle de estoque").
- **Recusa explícita** (`DECLINE_PATTERN`: "não quero informar", "não sei", "pula esse"...) é distinguida de uma resposta que simplesmente não trouxe nenhum valor por acaso — só conta como recusa quando o texto claramente nega fornecer o dado. Ao recusar: o produto entra no estoque (quantidade controlada normalmente) mas **nunca é publicado** (`storefront_visible=0`, `price=NULL`), e `pricing_declined_at` marca o momento para a auditoria — sem re-perguntar na mesma hora, mas listado no aviso proativo até alguém completar.

## O que muda no Fluxo 2 (nota fiscal)

- Mesma recusa explícita por item: quantidade/custo (dados reais da nota) entram no estoque normalmente; só o preço de venda fica pendente, produto criado sem vitrine.
- `margin_percent` agora é persistido também aqui (calculado a partir do preço informado vs. o custo real da nota, quando o lojista não disse a margem diretamente).
- Primeira pergunta de preço de um lote também explica a importância, uma vez só (não repete a cada item, para não ficar repetitivo).

## Foto de catálogo profissional (IA do Estúdio)

A pesquisa antes de implementar mostrou duas limitações reais que mudaram o desenho literal do pedido:

- **Não existe hoje edição de imagem preservando o produto real** — só geração do zero (`generateImageB64`, Imagen/`gpt-image-1`), usada pelo "Estúdio de Criação" para artes de campanha. Gerar do zero arriscaria criar um produto genérico diferente do que está de fato em estoque. Solução: nova função `editProductImageB64()` usa o endpoint de **edição** da OpenAI (`images.edit`, `gpt-image-1`) — a foto original é preservada como entrada, só o prompt de estilo (fundo/iluminação/identidade visual) é aplicado por cima.
- **RAG hoje é só texto/embedding** (`knowledge_chunks.embedding` são embeddings de texto da OpenAI) — não existe mecanismo de guardar/buscar imagem. Em vez de inventar uma busca por similaridade de imagem do zero, a foto de estúdio é amarrada diretamente ao **registro do produto** (`products_services.studio_image_url`): o mesmo produto reconhecido por match (mecanismo que já existe) reaproveita a foto já gerada sem gastar IA de novo — o mesmo efeito prático de "consultar antes de gastar recurso" que o usuário pediu, só que apoiado no dado que já existe (produto), não num RAG de imagem que teria que ser construído do zero.
- **Identidade visual**: usa `brand_profiles` (paleta/tom/estilo, se a loja já rodou "Identidade da marca" no Estúdio de Criação) como fonte primária; cai para `storefront_settings.accent_color` quando não configurado; e para um estilo genérico "clean de e-commerce" se nada existir.
- **Quem decide gerar vs. reaproveitar é `StudioCatalogPhotoService`**, chamado pela IA Orquestradora (`WhatsAppInventoryIntake`) — exatamente o "consultar antes de delegar" pedido: checa o toggle da loja, depois se o produto já tem `studio_image_url`; só chama a IA de edição quando as duas coisas permitem.
- **Nunca bloqueia o cadastro**: qualquer falha (sem chave de IA, moderação, rede) cai de volta na foto crua enviada pelo lojista — a foto de estúdio é sempre um "nice to have" opcional em cima do fluxo que já funciona.
- **Fora de escopo**: a foto de estúdio não se aplica a itens de nota fiscal (não existe uma foto por item — a nota inteira é uma imagem só, mostrar o documento como foto de produto ficaria errado).

## Validação

`npm run test:whatsapp-inventory-fase-b` (39 verificações) + suíte completa (34 scripts, zero quebras) + `lint`/`build` limpos:
- Margem persistida quando calculável; preço direto sem margem ainda publica (regra confirmada); recusa nunca publica mas ainda registra estoque real; nota fiscal com recusa preserva custo/quantidade reais.
- Reposição por reconhecimento de catálogo soma estoque sem alterar preço/margem.
- Auditoria lista exatamente os produtos sem preço, nunca os já precificados.
- `DECLINE_PATTERN` distingue recusa real de mensagem com dado (preço/margem/quantidade) real.
- Foto de estúdio: desligada por padrão, nunca chama IA quando desligada; ligada e sem foto ainda tenta gerar e falha graciosamente sem quebrar o fluxo (sandbox sem `OPENAI_API_KEY`, mesma limitação da ADR-030); já com foto salva, reaproveita sem chamar IA de novo.
- Aviso proativo: vazio sem produtos incompletos, aparece uma vez, respeita rate-limit de 24h, libera de novo depois da janela.
