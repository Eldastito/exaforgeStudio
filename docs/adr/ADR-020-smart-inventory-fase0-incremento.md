# ADR-020 — Smart Inventory Fase 0: incremento (rascunho persistido, auditoria, rate limit, EXIF/HEIC, faixas de confiança)

**Status:** Implementado e testado (checagens automáticas de dados/lógica + suíte de regressão completa; a chamada de visão da IA em si continua não exercitada de ponta a ponta neste sandbox — mesma ressalva da ADR-019).
**Origem:** depois de a ADR-019 ir para produção, o usuário trouxe uma especificação bem mais detalhada ("ZES-003") escrita para o mesmo recurso, com vários itens adicionais (HEIC, 20 MB, pré-processamento de imagem, split em 3 serviços formais OCR/Visão/Semântico, detecção de código de barras, tabelas `DraftProduct`/`ProductSuggestion`, rate limit, faixas de confiança, log estruturado, trilha de auditoria). Comparei item a item com o que já estava no ar e recomendei adotar 6 e recusar/adiar 3 — o usuário confirmou explicitamente a lista curada. Esta ADR documenta o que foi de fato implementado.

## Adotado

### 1. Rascunho persistido (`product_scan_drafts`) substitui a extração efêmera

Na ADR-019, `POST /smart-scan` devolvia a extração da IA sem gravar nada — se o usuário fechasse o modal, a chamada de IA (paga) se perdia sem deixar rastro. Agora toda extração vira uma linha em `product_scan_drafts` (`status='pending'`) imediatamente, antes de qualquer produto existir. Um novo endpoint dedicado, `POST /smart-scan/:draftId/confirm`, é o ÚNICO caminho que cria o produto de verdade — idempotente por design: um rascunho que já saiu de `pending` (`confirmed` ou `discarded`) rejeita nova confirmação com 400, então duplo clique/retry de rede nunca duplica o produto.

### 2. Trilha de auditoria (IA sugeriu vs. humano publicou)

Dois eventos novos em `auth_audit_logs` via `logAuthEvent` (mesmo helper único usado em todo o resto do sistema, ADR anterior de RBAC/auditoria): `PRODUCT_SCAN_EXTRACTED` (na criação do rascunho, com `confidenceScore`) e `PRODUCT_SCAN_CONFIRMED` (na confirmação, com `productId`, `confidenceScore` e `changedFields` — diff entre nome/categoria/descrição extraídos pela IA e o que o humano efetivamente salvou). Não bloqueia nada; é dado para auditoria e, no futuro, para medir a qualidade do prompt de extração.

### 3. Rate limit (20 scans/minuto por organização)

Cada scan é uma chamada de IA paga. Mesmo padrão já usado em `routes/radarPublic.ts`: bucket em memória por `organizationId`, janela de 60s, `429` quando excede. Não persiste em banco (reinicia com o processo, como o padrão existente) — não há necessidade de sobreviver a restart para essa proteção.

### 4. Remoção de EXIF + correção automática de rotação

Toda imagem passa por `sharp` antes de ser salva/enviada à IA: `.rotate()` sem argumento lê a orientação EXIF e já gira os pixels fisicamente (corrige fotos "de lado" tiradas com celular), e reencodar como JPEG novo remove metadados originais (localização, modelo do aparelho) sem precisar de uma etapa separada. Isso cobre, como efeito colateral "de graça", o item de correção de rotação do pré-processamento pedido — sem entrar no restante (perspectiva/contraste/nitidez), ver seção "Recusado" abaixo.

### 5. HEIC/HEIF — decisão informada, não silenciosa

O pedido original era "suportar HEIC" (formato padrão de câmera do iPhone). Antes de prometer isso, verifiquei empiricamente (`sharp.format.heif`) que o binário do `sharp` distribuído via npm só decodifica o perfil **AVIF** do HEIF (royalty-free) — não o **HEVC** que o iPhone realmente grava, que exige um decodificador licenciado não incluso. Decisão: **rejeitar explicitamente** uploads HEIC/HEIF no `fileFilter` do multer, com mensagem acionável ("No iPhone: Ajustes > Câmera > Formatos > 'Mais Compatível', ou escolha a foto já em JPG/PNG") em vez de fingir suporte e falhar silenciosamente ou gerar uma extração ruim sem explicar por quê. Limite de tamanho subiu de 10 MB (padrão anterior implícito) para os 20 MB pedidos na especificação.

### 6. Faixas de confiança refinadas (≥95 / 80–94 / <80)

`extractProductFromImage()` agora pede um `confidence` numérico de 0 a 100 (antes era categórico alto/médio/baixo, sem separação clara de comportamento). No frontend, `scanConfidenceTier()` mapeia o número para 3 faixas com UX diferente: **alta (≥95)** — banner verde, segue direto; **média (80–94)** — banner âmbar, "confira estes campos"; **baixa (<80)** — banner vermelho + checkbox obrigatório ("Revisei e confirmo os dados acima manualmente") que bloqueia o botão "Aprovar e Publicar" até ser marcado. `products.ts` faz `clamp(0,100)` no valor devolvido pela IA antes de gravar, então uma resposta malformada nunca produz um `confidence_score` fora do intervalo válido.

## Recusado / adiado (com justificativa)

- **Split formal em 3 serviços (OCR / Computer Vision / Motor Semântico)** — hoje existe UM consumidor (o endpoint de smart-scan). Extrair uma abstração de 3 camadas sem um segundo consumidor real é abstração prematura — mesmo critério já usado nesta base para o `RadarScoringEngine` (só foi extraído de `RadarService` quando surgiu o segundo consumidor de verdade). Se/quando nota fiscal ou XML de NF-e (fases futuras) precisarem reaproveitar só a parte de OCR, faz sentido extrair então.
- **Pré-processamento completo de imagem (correção de perspectiva, contraste, nitidez)** — sem evidência de que a extração atual esteja falhando por causa disso; a correção de rotação (item 4 acima) já veio de graça pela remoção de EXIF. Adicionar mais transformações sem um caso real de falha documentado é otimização especulativa.
- **Detecção de código de barras** — pedido novo de escopo, não uma melhoria sobre o que já existe; exigiria uma biblioteca dedicada (leitura de barcode não é algo que `sharp` ou o modelo de visão fazem hoje) e nenhum fluxo atual consome esse dado (não há EAN/GTIN em `products_services`). Fica como possível item de uma fase futura, não deste incremento.

## O que mudou de fato no código

- `sharp` adicionado como dependência real (não apenas dev).
- `db.ts`: nova tabela `product_scan_drafts` (com índice por `organization_id, status, created_at`).
- `llm.ts`: prompt de `extractProductFromImage()` pede `confidence` numérico (0–100) em vez de categórico, com critério explícito no próprio prompt para o modelo se autoavaliar.
- `routes/products.ts`: `POST /smart-scan` agora só cria rascunho (não mais produto direto); novo `POST /smart-scan/:draftId/confirm` cria o produto, anexa a imagem, marca o rascunho como confirmado e audita o diff; `fileFilter` do multer rejeita HEIC/HEIF com mensagem clara; limite subiu para 20 MB; rate limiter de 20/min por organização; todo upload passa por `sharp` (rotação EXIF + strip + resize 1600px + normalização para JPEG) antes de salvar/enviar à IA.
- `CatalogView.tsx`: fluxo de revisão agora chama `/smart-scan/:draftId/confirm` (não mais dois passos client-side de criar produto + anexar imagem); banner de confiança por faixa; checkbox obrigatório de revisão manual na faixa baixa, checado em `handleScanConfirm()` antes de permitir publicar.

## Validação

**O que foi testado**, via `npm run test:product-smart-scan` (37 verificações novas) + suíte de regressão completa (12 scripts pré-existentes, 201 verificações do Radar/RBAC/isolamento, sem nenhuma quebra):
- Schema de `product_scan_drafts` tem todas as colunas esperadas.
- Rascunho é gravado com `status='pending'` e `confidence_score` correto; auditoria `PRODUCT_SCAN_EXTRACTED` é gravada com o `confidenceScore`.
- Confirmação cross-org é rejeitada com 404 e não altera o rascunho de outra organização (isolamento).
- Confirmação legítima cria o produto com os valores finais definidos pelo humano (inclusive preço — a IA nunca sugere preço), marca o rascunho como `confirmed`, grava `confirmed_at` e `product_id`.
- Confirmar um rascunho já confirmado é idempotente: retorna 400 e não duplica o produto.
- Auditoria `PRODUCT_SCAN_CONFIRMED` grava o diff correto (`changedFields` inclui `name` quando o humano editou, não inclui `category` quando o humano manteve o valor sugerido pela IA).
- Auditoria `PRODUCT_CREATED` grava `source: "smart_scan"`.
- Rate limiter bloqueia exatamente a partir da 21ª chamada na mesma janela de 1 minuto, libera na janela seguinte, e é isolado por organização.
- Clamp de confiança (0–100) trata valores fora de faixa e não numéricos corretamente.
- `npm run lint` e `npm run build` passam sem erros nos arquivos tocados (os erros pré-existentes de `tsc --noEmit` em `ProspectView.tsx`/`VisionVmsView.tsx`/`rie/*` não têm relação com esta mudança e já existiam antes dela).

**O que NÃO foi testado**: assim como na ADR-019, a chamada de visão em si (`extractProductFromImage` batendo na API de verdade da OpenAI com uma foto real, incluindo o novo campo `confidence` numérico) não foi exercitada de ponta a ponta — este sandbox não tem `OPENAI_API_KEY`. A lógica de rascunho/confirmação/auditoria/rate-limit/confiança foi validada diretamente na camada de dados (mesmo padrão de `scripts/test-rbac-audit.ts`), simulando a mesma sequência de operações que os endpoints executam.
