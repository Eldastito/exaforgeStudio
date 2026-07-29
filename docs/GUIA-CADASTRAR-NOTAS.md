# Guia — Como cadastrar as notas de compra

Guia prático pra você (lojista/gestor) cadastrar as notas fiscais de compra (NF-e de entrada). Cadastrar é o que faz o app **saber quanto cada produto custou de verdade** — sem isso, o "lucro por loja" (aba Resultado) e a aba "Precificar" ficam usando *chute* em vez de dado real.

---

## Por que cadastrar

Duas coisas passam a funcionar direito assim que a primeira nota entra:

1. **Custo médio ponderado** (`avg_cost`) fica no produto. Cada nota nova recalcula:
   `novo custo = (estoque atual × custo atual + qtd da nota × custo unitário) ÷ (estoque atual + qtd da nota)`
2. **Ciclo de precificação** (ADR-083 E5→E6→E7):
   - **Resultado por loja** — em vez de estimar "faturamento × margem que o gestor chutou", passa a subtrair o **CMV real** (custo × unidades vendidas). Cada loja migra de fonte `estimate` para `real` (100% coberta) ou `blended` (parcial) automaticamente no próximo mês.
   - **Precificar** — a aba mostra `custo × preço atual × preço sugerido` com semáforo (`perda` / `magra` / `ok`) e permite aplicar o preço sugerido em lote.

**Se você nunca cadastrar nota**, o app continua rodando — só que o cálculo de lucro fica dependendo do campo "margem bruta média" que você informou em `Editar loja`, e a aba Precificar mostra os produtos como "sem custo" (não gera sugestão).

---

## Os dois caminhos

Ambos chegam ao **mesmo lugar**: a tela "revisar rascunho" do Catálogo. A diferença é como a nota entra.

| Caminho          | Quando usar                                   | Requer IA (custa token)? | Precisão |
|------------------|-----------------------------------------------|--------------------------|----------|
| **XML da NF-e**  | Sempre que o fornecedor mandar o XML          | Não                      | Perfeita |
| **Foto da nota** | Fornecedor só te deu o papel                  | Sim                      | Boa (revise) |

O XML é o caminho preferido — leitura direta, sem alucinação de IA, com validação de assinatura. A foto é o *fallback* pra quando só sobra o cupom no bolso.

---

## Caminho 1: XML da NF-e (recomendado)

### Onde clicar
Menu → **Catálogo** → botão **"Nota Fiscal"** no topo da tela. Abre o modal com dois botões: **"Enviar XML"** e **"Enviar Foto"**.

### Como conseguir o XML
- Peça pro fornecedor te mandar por e-mail o **arquivo `.xml`** (não o PDF/DANFE, o XML mesmo).
- Se ele mandar apenas a chave de acesso (44 dígitos), você pode baixar o XML no site da SEFAZ do estado.
- Se o fornecedor te enviou um `.zip` com vários XMLs, extraia antes.

### Como enviar
- Clique **"Enviar XML"** e selecione **um ou vários arquivos de uma vez** (limite: 20 XMLs por envio, 5 MB cada).
- O app lê cada arquivo, extrai fornecedor, chave da NF, itens (nome, quantidade, unidade, custo unitário, EAN) e valida a assinatura digital.
- Cada nota vira um **rascunho** que espera a sua revisão. O estoque **ainda não subiu** e nenhum produto novo foi criado.

### Anti-duplicidade (automático)
A chave de acesso de 44 dígitos é única. O app **rejeita duplicadas**:
- Dentro do próprio lote: *"NF-e repetida dentro do próprio lote."*
- Contra notas já importadas antes: *"Esta NF-e já foi importada e confirmada antes."*
- Contra notas ainda em revisão: *"…já tem uma importação pendente de revisão."*

Rejeições **não abortam o lote inteiro** — os XMLs válidos continuam.

### Assinatura digital
A assinatura da NF-e é verificada localmente (sem consultar a SEFAZ). O resultado vem no rascunho, mas **é informativo — não bloqueia a importação**. Se o fornecedor mandou um XML alterado, você ainda consegue importar, mas o rascunho carrega o aviso.

---

## Caminho 2: Foto (OCR + IA)

### Quando usar
Só quando o fornecedor **não te mandou o XML**. Exemplo: papel do balcão, cupom fiscal impresso, DANFE em PDF que você tirou foto do celular.

### Como enviar
- Menu → **Catálogo** → **"Nota Fiscal"** → **"Enviar Foto"**.
- **Uma foto por vez**. Formatos: PNG, JPG, WEBP. Até 20 MB.
- **HEIC/HEIF do iPhone é rejeitado** — o iPhone salva por padrão em HEIC. Vá em `Ajustes → Câmera → Formatos → Mais Compatível` pra salvar em JPG, ou converta antes.
- **PDF não é aceito** — se o fornecedor te mandou PDF, tire uma foto/print da tela.

### Dicas pra foto sair legível
- Luz boa, sem sombra em cima da nota.
- Enquadrar a nota inteira, sem cortar.
- Papel plano (não amassado).
- Se o texto sair borrado, o app devolve: *"Não foi possível identificar itens de compra nesta foto. Tente uma foto mais nítida da nota fiscal."*

### O que a IA extrai (limite: 60 itens por foto)
- Fornecedor, itens, quantidades, custos unitários. **Não extrai EAN** — a IA não lê códigos de barras da foto de forma confiável. Se você quer casar EAN pra reposição precisa, use o XML.

---

## Passo comum: revisar o rascunho antes de confirmar

Depois de qualquer um dos dois caminhos, você vê a tela de revisão. **Cada item** da nota vira uma linha com três escolhas:

- **Criar** — cria um produto novo no catálogo (padrão quando o EAN/nome não bate com nada).
- **Repor** *(nome do produto existente)* — o app já sugere o melhor casamento; você troca se estiver errado. Aumenta o estoque do produto escolhido.
- **Pular** — não faz nada com essa linha (útil pra frete, taxa, embalagem que às vezes vem como "item" na nota).

Cada linha também mostra o **preço de venda sugerido** — calculado por `custo unitário × (1 + markup padrão da sua loja)` com arredondamento psicológico (termina em `,99`). O markup padrão vem de **Loja Virtual → Configurações → Markup padrão** (default 40%). Você pode editar o preço linha a linha antes de confirmar.

**Nada mexe no estoque até você clicar "Confirmar"**. Se fechar o modal sem confirmar, o rascunho fica salvo com status *pendente* — pode voltar depois.

Quando você confirma, aparece o toast: *"Nota fiscal processada: X produto(s) novo(s), Y reposto(s)."*

---

## O que muda depois de confirmar

1. **`inventory_items.avg_cost` recalcula** pelo custo médio ponderado.
2. **Estoque em mãos aumenta** pela quantidade da nota.
3. **Aba Precificar** — o produto sai de "sem custo" (cinza) e passa a ter sugestão real. Se você já estava vendendo abaixo do custo, aparece o badge vermelho **"perda"**.
4. **Aba Resultado por loja** — no próximo cálculo, a loja migra de `estimate` para `blended` ou `real` conforme a cobertura de vendas com produto que tem custo cadastrado.

Você não precisa recarregar nada — abrir a aba de novo já traz os números novos.

---

## Limitações conhecidas (leia antes)

Documentadas honestamente pra você não ficar procurando o que não existe:

1. **Cadastro de nota NÃO amarra a Pedido de Compra nem a "Recebimento".**
   Os fluxos `purchase_orders` (`Comprador IA`) e `goods_receipts` (conferência de recebimento com quebra/falta/avaria) existem no app, mas hoje **não conversam** com `invoice-scan`. Se você usa o Comprador IA e quer registrar "chegou, conferi, está tudo ok" além do custo de aquisição, faça os dois passos separados (por enquanto).

2. **Custo médio é ORG-WIDE, não por loja.**
   Se você tem duas lojas comprando o mesmo produto por preços diferentes, o `avg_cost` mistura tudo — fica a média ponderada da organização. O CMV real da Fatia 2 usa esse custo pra todas as lojas (é uma aproximação boa, mas não é "custo dessa loja"; o app avisa isso na aba Resultado).

3. **`retail_store_inventory` (estoque por loja) NÃO sobe.**
   A entrada por nota alimenta o inventário "matriz" da organização (`inventory_items`). O saldo por loja da rede continua vindo do ERP/PDV. Isso é intencional — a nota entra na sede, não numa loja específica.

4. **Foto não extrai EAN.** Pra casar produto por código de barras (reposição precisa), sempre prefira o XML.

---

## Erros comuns e o que fazer

| Mensagem                                                                  | O que aconteceu                          | Como resolver                                              |
|---------------------------------------------------------------------------|------------------------------------------|------------------------------------------------------------|
| *"Não foi possível ler este arquivo como XML."*                           | Arquivo não é XML válido                 | Confirmar com o fornecedor que enviou o XML da NF-e mesmo. |
| *"Este XML não parece ser uma NF-e (a tag `<infNFe>` não foi encontrada)."* | XML é de outra coisa (CT-e, MDF-e)     | Pedir o XML da NF-e de venda ao seu CNPJ.                  |
| *"Nenhum item de mercadoria neste XML."*                                  | NF-e é só de serviço/frete/imposto       | Ignorar — não há o que dar entrada em estoque.             |
| *"NF-e repetida dentro do próprio lote."*                                 | Você enviou o mesmo XML duas vezes       | Remover a duplicata do envio.                              |
| *"Esta NF-e já foi importada e confirmada antes."*                        | A nota já entrou no seu estoque          | Não fazer nada — está tudo certo, a duplicidade foi evitada. |
| *"…já tem uma importação pendente de revisão."*                            | Rascunho aberto esperando confirmação    | Abrir o rascunho pendente e finalizar.                     |
| *"Não foi possível identificar itens de compra nesta foto."*              | Foto ilegível / IA não achou tabela      | Tirar foto melhor, ou pedir o XML.                         |
| *"O formato HEIC/HEIF do iPhone não é aceito…"*                            | Foto direto do iPhone salva em HEIC      | Configurar câmera pra JPG, ou converter.                    |

---

## Rate limit e outros números úteis

- **20 uploads por minuto por organização** (proteção contra loop acidental).
- XML: até **20 arquivos por envio**, **5 MB cada**, **200 itens por nota**.
- Foto: **1 arquivo por vez**, **20 MB**, **60 itens por foto**.
- Rascunho pendente **não expira** — fica esperando você revisar.

---

## Fluxo em uma frase

**Catálogo → Nota Fiscal → (XML preferencial ou Foto) → Revisar rascunho → Confirmar** → o custo entra no `avg_cost`, o estoque sobe, e no próximo mês a aba Resultado por loja mostra o CMV real em vez do chute.
