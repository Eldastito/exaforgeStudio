# ADR-022 — Smart Inventory Fase 2: cadastro via XML de NF-e

**Status:** Implementado e testado de ponta a ponta (a extração aqui é parsing de XML determinístico, não uma chamada de IA — diferente das ADRs anteriores, não há ressalva de "não testado com API real": o caminho inteiro foi exercitado por testes automáticos, sem nenhuma dependência externa).
**Origem:** continuação natural da Fase 1 (ADR-021), confirmada explicitamente pelo usuário entre as opções de próxima implementação do Smart Inventory.

## Por que XML depois da foto

A Fase 1 lê a nota fiscal por FOTO — funciona, mas depende de OCR/visão de IA acertar letra miúda, papel térmico desbotado, ângulo da foto etc. O XML da NF-e é o MESMO documento fiscal, só que como **dado estruturado e assinado digitalmente** pela Sefaz — não tem "confiança de leitura" porque não há leitura nenhuma envolvida, só parsing. Quem tem acesso ao XML (a maioria dos ERPs/emissores de nota permite baixar) ganha um caminho mais rápido e 100% confiável; quem só tem a nota em papel continua usando a foto da Fase 1. As duas convivem.

## Decisão de arquitetura: reaproveitar o pipeline da Fase 1 inteiro, trocar só a extração

A Fase 1 já tinha exatamente a forma certa para isso: um endpoint de extração que devolve `{ draftId, imageUrl, supplierName, items, confidenceScore }`, uma tabela de rascunho (`invoice_scan_drafts`) e um endpoint de confirmação que processa item por item (`create`/`restock`/`skip`) chamando `InventoryService.recordMovement`. Nada disso muda para o XML — **zero alteração de schema, zero alteração no endpoint de confirmação**. A única coisa nova é um segundo endpoint de extração, `POST /api/products/invoice-scan/xml`, que devolve o MESMO formato de resposta a partir de um parser de XML em vez de uma chamada de visão. O frontend nem precisa saber qual das duas origens gerou o rascunho — a tela de revisão é idêntica.

Isso é o inverso do que foi recusado na ADR-020 (não split prematuro em serviços formais): aqui SIM existem dois consumidores reais e concretos da mesma "forma" de dado (extração de nota fiscal → itens de compra) — exatamente o critério que a ADR-020 disse que justificaria abstrair. A abstração que emergiu foi orgânica: o endpoint de confirmação já era genérico o bastante para não precisar mudar nada.

## O que é novo

### `src/server/nfeParser.ts` — `parseNFeXml()`

Parser puro (sem I/O, sem banco, sem rede) usando `fast-xml-parser` (`removeNSPrefix: true`, já que schemas de NF-e variam o prefixo de namespace por emissor/Sefaz — `nfe:xNome`, `ns2:det`, etc., todos tratados igual). Aceita tanto o XML "autorizado" (`nfeProc > NFe > infNFe`, formato que a Sefaz devolve depois de processar) quanto a NFe assinada isolada (`NFe > infNFe`). Extrai `emit.xNome` (fornecedor) e, de cada `det.prod`: `xProd` (nome), `qCom` (quantidade), `uCom` (unidade), `vUnCom` (custo unitário) — ignora frete/impostos/desconto porque essas informações vivem em outras seções da NF-e (`transp`, `ICMSTot`), nunca em `det.prod`, então nem é preciso filtrar nada manualmente. Normaliza o caso clássico de bug em parser de XML: quando há um único `<det>`, o parser devolve OBJETO em vez de array — tratado explicitamente. Se a tag `<infNFe>` não existir em lugar nenhum da árvore, rejeita com erro claro em vez de devolver uma lista vazia silenciosa (evita "a nota não tinha nada" quando na verdade o arquivo enviado nem era uma NF-e).

### `POST /api/products/invoice-scan/xml` (novo endpoint)

Multipart, campo `file`, aceita `.xml` até 5MB (nota fiscal é texto puro, não precisa do limite de 20MB usado para foto). **Não passa pela IA** — não chama `isAIConfigured()`, então uma organização sem chave de IA configurada ainda consegue importar por XML, só não consegue usar a foto. `confidence_score` é sempre 100 (dado estruturado não tem "grau de certeza de leitura" como uma foto tem). Grava o rascunho em `invoice_scan_drafts` com `image_url = ''` (sem foto para mostrar) — o frontend já esconde a miniatura quando `imageUrl` está vazio. Limite de 200 itens por importação (uma NF-e consolidada pode ter centenas de linhas); se truncar, o frontend avisa explicitamente para importar o restante em outro lote — sem truncamento silencioso.

### Frontend (`CatalogView.tsx`)

O modal "Nota Fiscal" ganha uma segunda opção — "Importar XML de NF-e" — ao lado do upload de foto já existente. `applyInvoiceScanResult()` foi extraída como a lógica compartilhada entre os dois handlers (`handleInvoiceUpload` para foto, `handleInvoiceXmlUpload` para XML), porque a resposta das duas rotas tem exatamente o mesmo formato — a tela de revisão (tabela de itens, seleção criar/repor/ignorar, preço de venda) não muda em nada entre as duas origens.

## Não incluído nesta rodada (deliberado)

- **Validação de assinatura digital do XML** — o parser lê os dados de conteúdo (`infNFe`), mas não verifica a assinatura criptográfica (`Signature`) nem consulta a Sefaz para confirmar que a nota é autêntica/não foi cancelada. Isso é adequado para o caso de uso (o comerciante importando a PRÓPRIA compra, já confiando no arquivo que baixou do fornecedor/ERP), mas não serviria para um cenário de validação fiscal formal.
- **Múltiplos arquivos de uma vez (lote de XMLs)** — cada importação é um XML por vez, mesmo padrão de "uma nota por vez" da Fase 1 com foto. Poderia ser естendido depois se o volume justificar.
- **Deduplicação por chave de acesso da NF-e** — nada impede hoje importar o mesmo XML duas vezes (cada importação gera um novo rascunho); a chave de acesso (`Id="NFe..."` em `infNFe`) já está disponível no XML e poderia, no futuro, impedir reimportação acidental da mesma nota.

## Validação

**O que foi testado**, via `npm run test:nfe-parser` (21 verificações novas, teste puro sem banco/rede na maior parte) + suíte de regressão completa (15 scripts agora, 288 verificações totais, sem nenhuma quebra):
- Envelope "autorizado" (`nfeProc > NFe > infNFe`) e NFe isolada (`NFe > infNFe`) — ambos os formatos reais de XML de NF-e são lidos corretamente.
- Nota com item único: o parser NÃO quebra no bug clássico de "det vira objeto em vez de array" quando há só uma linha.
- Nota com múltiplos itens: nome, quantidade, unidade e custo unitário de cada item lidos corretamente.
- Namespace com prefixo (`nfe:xNome`, `nfe:det`, etc.) — lido igual a XML sem prefixo.
- XML que não é NF-e nenhuma é rejeitado com um erro claro (não retorna uma lista de itens vazia como se a nota estivesse ok mas sem produtos).
- Item sem nome é descartado; item válido ao lado continua presente.
- Fluxo completo: um rascunho criado a partir do XML (`confidence_score=100`, `image_url=''`) confirma pelo MESMO endpoint da Fase 1, cria produto com a quantidade/custo corretos e registra a movimentação de estoque com `origin='invoice_scan'` — comprovando que zero lógica de estoque foi duplicada entre as duas origens (foto e XML).
- `npm run lint` e `npm run build` passam sem erros nos arquivos tocados.

Diferente das ADRs de visão computacional (019/020/021), aqui não há chamada de IA para ressalvar — o parsing de XML é determinístico e foi coberto integralmente por testes automáticos com XMLs reais no formato NF-e.
