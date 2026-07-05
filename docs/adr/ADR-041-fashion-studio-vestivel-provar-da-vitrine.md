# ADR-041 — Fashion AI Studio: só roupa/acessório no provador + "Provar" direto da vitrine

**Status:** Implementado e testado (22 verificações novas em `test:fashion-wearable`, suíte fashion completa sem quebras, `build` limpo). A classificação por IA e o fluxo vitrine→provador se confirmam em produção.
**Origem:** feedback do usuário sobre o provador em produção (fluxo ideal focado em venda + experiência). Migration: 2 colunas novas em `products_services` (aditivas, seguras).

## Contexto — o que o usuário pediu

1. **"A IA não pode nunca carregar no provador algo que não seja roupa ou acessório."** A loja pode vender qualquer coisa (caneca, eletrônico, decoração) — mas o provador virtual só faz sentido com o que se veste.
2. **Selecionar peças na vitrine e levá-las ao provador**: o cliente marca várias peças navegando na loja; ao abrir o Provador Virtual, elas já estão lá. Dentro do provador, **botão de excluir item**.
3. Dentro das sugestões da consultora (até 3 looks), escolher **um** para vestir no avatar — já existia ("Ver em mim" por look); registrado como confirmação de produto.
4. Ideia futura (não implementada agora, por decisão do usuário): vestir automaticamente os 3 looks sugeridos para comparação lado a lado.

## Decisão 1 — classificação VESTÍVEL em camadas (colunas `fashion_wearable` / `fashion_wearable_source`)

Um produto só entra no provador se `fashion_wearable = 1`. A classificação é em camadas, cada uma gravada uma única vez:

1. **Heurística por palavras** (grátis, síncrona): listas PT-BR de termos vestíveis (vestido, calça, tênis, bolsa, colar...) e não-vestíveis (caneca, fone, perfume...), casadas por prefixo sobre nome+categoria normalizados (`normalizeProductName`). Conflito ou nenhum termo → não decide.
2. **IA** (`ensureWearableClassified`, uma chamada `chat` barata por lote de pendentes): decide o que a heurística não decidiu. Saída validada — só grava sobre os IDs perguntados. Chamada nos pontos de entrada assíncronos do provador (rota `eligible`, consultora, look manual).
3. **Override manual do lojista** (`fashion_wearable_source = 'manual'`, via PATCH de produto no painel): vence nos dois sentidos (incluir um kit, excluir uma roupa) e **nunca** é sobrescrito pelas camadas automáticas.

**Regra conservadora**: item ainda não classificado (ambíguo sem IA disponível) fica **FORA** do provador — nunca arriscar vestir uma caneca. O chokepoint é `eligibleItems` (FAS-0): consultora, look manual, fallback e try-on ficam protegidos de uma vez.

## Decisão 2 — "Provar" na vitrine → provador pré-carregado + excluir item

- **Card do produto**: peça vestível elegível ganha o botão "Provar" (ícone de camisa, abaixo do coração). Marca/desmarca; máximo 5 (limite do look); persistido por loja (`fashion_picks_<slug>` no localStorage).
- **Botão flutuante do Provador** mostra o contador de peças marcadas.
- **Ao abrir o Provador** com foto aprovada e peças marcadas → cai direto no builder com elas pré-selecionadas (filtradas contra o catálogo elegível atual). Sem conta/foto, o fluxo normal (cadastro → consentimento → foto) acontece primeiro e as marcações esperam.
- **Excluir item dentro do provador**: fileira de chips das peças selecionadas, cada uma com o X — remover tira da seleção **e** da marcação da vitrine (não volta sozinho). Compor o look limpa as marcações (o look passa a carregar as peças).
- O Storefront agora faz **uma** consulta ao catálogo elegível e passa o resultado ao FashionStudio (`enabledHint`) — sem probe duplicado nem telemetria dobrada.

## Fora desta entrega (backlog combinado)

- **Vestir os 3 looks sugeridos automaticamente** para comparação ("qual ficou melhor") — o usuário definiu como um segundo momento; consome 3 créditos de uma vez e merece UX própria (comparador lado a lado).
- Toggle visual "aparece no provador" no painel do lojista (o backend do override manual já aceita `fashion_wearable` no PATCH de produto; falta só o controle na tela de catálogo).
- Value Realization Dashboard (item 7 do PRD-E-006) — aguardando a confirmação do provador em produção.

## Consequências

- O provador nunca mistura não-vestíveis — nem na grade de escolha, nem nos looks da IA, nem no try-on.
- Lojas 100% de moda não mudam nada (heurística resolve quase tudo de graça; IA cobre o resto na primeira visita).
- Produto com nome/categoria muito genéricos e sem IA configurada fica fora do provador até o lojista marcá-lo — comportamento documentado e corrigível no painel.
