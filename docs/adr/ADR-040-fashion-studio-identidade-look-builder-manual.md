# ADR-040 — Fashion AI Studio: identidade fiel do rosto no try-on + Look Builder manual

**Status:** Implementado e testado (17 verificações novas em `test:fashion-custom-look`, suíte fashion completa sem quebras, `build` limpo). A **qualidade visual** da preservação de identidade só se confirma em produção com foto real — ver "Verificação pendente", abaixo.
**Origem:** feedback do usuário sobre o provador em produção (duas observações). Nenhuma migration nova.

## Contexto — o que o usuário reportou

1. **A pessoa gerada não era a pessoa da foto.** Ao usar "Ver em mim", o rosto/identidade saíam diferentes — o provador gerava *outra* pessoa vestindo as peças, não o próprio cliente. Isso derruba o valor central do provador.
2. **Só dava para provar looks prontos da consultora.** Não havia como o cliente **escolher as peças** que quisesse e vê-las juntas em si. O botão era "Ver em mim" (por look da IA); faltava "escolher mais de uma peça e compor um look meu".

## Decisão 1 — `input_fidelity: "high"` preserva o rosto

O provedor padrão (`openai_edit`, `gpt-image-1` via `images.edit`, ADR-037) roda por padrão com `input_fidelity="low"`: o modelo **reimagina** a pessoa e o rosto muda. O parâmetro `input_fidelity: "high"` existe exatamente para **preservar rosto e detalhes finos** da imagem de entrada — é a alavanca técnica que faz o provador manter a **mesma pessoa**.

Mudanças:

- **`llm.ts` / `editImagesB64`**: aceita `opts` opcionais (`inputFidelity`, `quality`, `size`) repassados ao `images.edit`. Opcionais de propósito — não afetam o `editProductImageB64` do catálogo, que não tem rosto a preservar.
- **`FashionTryOnService` (provedor `openai_edit`)**: gera com `input_fidelity="high"`, `quality="high"` e saída em **retrato `1024x1536`** (corpo inteiro nítido). O `SAFETY_PROMPT` foi reforçado para pedir explicitamente "a MESMA pessoa da primeira foto — sem embelezar, afinar, emagrecer ou rejuvenescer" (o texto pede identidade; o parâmetro garante a preservação técnica). O prompt continua **fixo no código** (anti-injection, 19.2).
- **Invalidação da idempotência**: a chave do provedor mudou de `openai_edit` → `openai_edit_hifi_v1`. Como ela entra no `input_hash` (ADR-037), as prévias **antigas ruins** (rosto trocado) deixam de ser reaproveitadas — o próximo "Ver em mim" **gera de novo**, já com alta fidelidade. A chave do *mapa* de provedores (o default de `FASHION_TRYON_PROVIDER`) segue `openai_edit`; só a chave da *instância* (a do hash) mudou.

Custo/latência sobem com `input_fidelity="high"` — é o preço justo do provador (é literalmente o ponto dele). A arquitetura plugável da ADR-037 segue valendo: se a qualidade ainda não bastar, trocar por um serviço dedicado de virtual try-on continua sendo registrar outra implementação da interface.

## Decisão 2 — Look Builder manual (escolher peças e ver em mim)

Novo caminho, ao lado da consultora por ocasião: o cliente **escolhe as peças** que quer e as vê juntas em si.

- **`FashionLookService.createCustomLook(orgId, customerId, productIds[])`**: monta um look a partir dos IDs escolhidos com a **mesma rede de segurança** da recomendação por IA (19.3) — só IDs do **catálogo elegível** (FAS-0) entram; ID injetado/de outra organização/esgotado é descartado; sem duplicata; no máximo 5 peças. O look nasce com `source = 'customer_selected'` e segue **exatamente o mesmo pipeline** de try-on, carrinho, salvar e compartilhar (nada downstream muda; a atribuição pedido↔look do FAS-4 continua valendo).
- **Rota**: `POST /api/public/fashion/looks/custom` (`{ productIds }`), com rate limit próprio.
- **UI (`FashionStudio.tsx`)**: novo passo **"Escolher peças e ver em mim"** na tela de foto aprovada — grade do catálogo elegível (reaproveita o endpoint `…/fashion/eligible` do FAS-0) com **seleção múltipla** (até 5) e o botão **"Ver as peças selecionadas em mim (N)"**. O look composto cai na mesma tela de looks, onde o botão de geração passa a se chamar **"Ver as peças selecionadas em mim"** (em vez de "Ver em mim") quando o look é `customer_selected`.

## Verificação pendente

- **Identidade em produção**: confirmar com uma foto real que o rosto agora é preservado. Se ainda insatisfatório, os próximos passos (sem trocar arquitetura) são elevar mais o prompt/qualidade ou plugar um provedor de try-on dedicado.
- Nenhuma mudança de esquema; sem impacto em lojas com o módulo desligado (rotas seguem 404).

## Consequências

- O provador passa a manter a pessoa certa e a permitir composição livre de peças — as duas lacunas reportadas.
- Uma geração de alta fidelidade custa mais tokens/tempo por prévia; o limite diário de créditos (FAS-0/FAS-3) segue protegendo o custo.
- Prévias antigas (baixa fidelidade) não são mais servidas pela idempotência — o primeiro "Ver em mim" após o deploy regenera.
