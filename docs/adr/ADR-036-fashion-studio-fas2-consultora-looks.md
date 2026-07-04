# ADR-036 — Fashion AI Studio, FAS-2: consultora por ocasião e Look Builder

**Status:** Implementado e testado (36 verificações novas, suíte completa sem quebras — 35 scripts, `lint`/`build` limpos). A composição por IA exige a chave de produção; o compositor determinístico de contingência e TODA a camada de validação são cobertos pelo teste.
**Origem:** PRD-E-006, terceira entrega (FAS-2). Nenhuma migration nova — as tabelas nasceram na fundação (FAS-0), exatamente como planejado.

## O que o FAS-2 entrega

A cliente com foto aprovada (FAS-1) agora responde o questionário de ocasião e recebe **até 3 looks completos**, montados só com peças do catálogo elegível, cada um com explicação, total e botão de salvar. A prévia "em você" (try-on) é a próxima fase.

### 1. Questionário (seção 7 do PRD)

As 6 perguntas obrigatórias em uma tela compacta: ocasião (texto livre), dia/noite, estilo (chips), cores a evitar, peças a evitar, orçamento máximo do look. As respostas viram **preferências explícitas editáveis** (`fashion_preferences`, `source='explicit'`) — nunca "verdades permanentes" (7.4): um novo questionário substitui as anteriores do mesmo tipo (histórico preservado como inativo), e a cliente lista e apaga preferências pelos endpoints de perfil (11.4). Responder o questionário registra o consentimento de `personalization` (ato explícito de fornecer preferências), revogável como os demais.

### 2. Motor de recomendação com validação anti-injection (regra 19.3)

A IA (via `chat()` já existente) recebe o catálogo **elegível** (FAS-0: ativo, visível, com preço/imagem/estoque) como lista de `id | nome | categoria | preço` e as respostas declaradas, com instruções rígidas: só IDs da lista, nunca inventar características, nunca comentar corpo/aparência, nunca "perfeito/ideal para seu corpo", explicação cita só o que a cliente declarou + dados reais do item.

**Tudo que a IA devolve é revalidado server-side** (`validateAILooks`, testado com payload adversarial):
- ID fora do catálogo elegível → descartado (anti prompt-injection via descrições de produto);
- mais de 3 looks → cortados (RF-017: nunca 9 combinações);
- item duplicado no mesmo look → removido; papel desconhecido → vira `main`;
- look que estoura o orçamento declarado → descartado;
- item cujo **nome** contém cor/peça evitada (texto normalizado, sem acento) → descartado — a IA já é instruída a evitar; isto é a rede de segurança determinística.

### 3. Compositor de contingência (sem IA)

`fallbackCompose`: agrupa o catálogo permitido por categoria e monta até 3 looks simples dentro do orçamento, com explicação de template citando a ocasião. A curadoria de qualidade vem da IA; o fallback garante que o provador **nunca quebra** por indisponibilidade dela — mesmo princípio da foto de estúdio (ADR-032).

### 4. Persistência e API

`fashion_look_requests` (ocasião + respostas) → `fashion_looks` (explicação, status `candidate`→`selected` ao salvar) → `fashion_look_items` (IDs do catálogo real + `price_snapshot` — **o checkout revalida preço/estoque no FAS-4**, o snapshot é só para exibição/explicação). Rotas novas em `/api/public/fashion`: `POST /look-requests`, `GET /look-requests/:id`, `POST /looks/:id/save` (RF-018), `GET/DELETE /profile/preferences`. Rate limit de 20 composições/h por cliente (o limite de 3/dia do FAS-0 é para GERAÇÃO de imagem, FAS-3 — compor look é mais barato). Ownership em tudo: outro cliente/organização não salva, não reabre, não apaga nada.

### 5. UI

`FashionStudio.tsx` ganha os passos `quiz` (as 6 perguntas) e `looks` (cards comparáveis com itens/imagem/preço/total, explicação e "Salvar este look" — RF-019), com aviso de que a prévia na foto chega na próxima etapa.

## Fora desta fase

- FAS-3: try-on (provedor plugável + jobs + créditos do limite diário).
- FAS-4: carrinho do look completo transacional + link via WhatsApp.
- FAS-5: memória de estilo completa (sinais observados: looks salvos/recusados, compras).

## Validação

`npm run test:fashion-looks` (36 verificações) + suíte completa (35 scripts, zero quebras) + `lint`/`build` limpos. Destaques: payload adversarial da IA (ID injetado, 5 looks, duplicatas, papel inválido, estouro de orçamento — tudo neutralizado); fallback respeita elegibilidade/orçamento/palavras evitadas; produto esgotado e produto de outra organização nunca aparecem; preferências substituem/apagam corretamente; ownership de looks e preferências.
