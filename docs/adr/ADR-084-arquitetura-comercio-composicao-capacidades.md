# ADR-084 — Arquitetura de Comércio: Espinha Dorsal Universal + Composição de Capacidades

- **Status:** Proposto (decisão para ponderação; implementação em fases posteriores, cada uma em seu próprio ADR/PR)
- **Data:** 2026-07
- **Contexto de origem:** discussão estratégica pós-ADR-083. Alvos de validação em produção citados pelo dono: **TOULON** (moda / rede multiloja), **clínica de psicologia**, **farmácia**, **minimercado com hortifrúti**, **restaurante** (dependente de operação offline) e **escola**, além de **prestador de serviço**.
- **Relacionadas:** ADR-083 (Retail Ops / TOULON), ADR-080 (Módulo Clínica — vertical aditiva gated), ADR-082 (Continuity Layer / Edge — operação offline), ADR-076 (cotação de compra/fornecedor), ADR-019/020 (Smart Inventory — entrada por foto/XML com revisão humana). Consome `verticals.ts`, `ModuleService`, `OnboardingTemplateService`.

## Contexto

O Quick-Start atual **funde dois conceitos diferentes** num só: o **núcleo universal do comércio** (vender e repor mercadoria) e a **operação de uma rede de lojas** (o que foi construído para a TOULON). Verificado no código:

- A vertical `varejo` **habilita automaticamente** o módulo `retail`, embora o próprio código descreva `retail` como "add-on para redes de lojas" (`verticals.ts`).
- O pack `varejo` do Quick-Start **liga por padrão** todas as automações `retail_*` (fechamento diário, malote, escala, cotas, alerta de estoque negativo, comissão, fechamento mensal) — `OnboardingTemplateService`.

Consequência: uma **loja individual** que escolhe "Varejo" recebe estrutura de **rede multiloja** que não faz sentido para ela.

**Duas perguntas distintas estão sendo tratadas como uma só:**
1. A empresa **atua no varejo/comércio**? (define o núcleo e as capacidades de venda/estoque)
2. A empresa **opera uma rede de lojas a ser supervisionada**? (define o Retail Network Ops)

### O que o núcleo JÁ entrega (verificado no repositório)
- Catálogo com **variantes** (`product_variants`: sku, size, color, variant_type), **custo médio** (`avg_cost` em `InventoryService`), **movimentações** (`stock_movements`), pedidos (`orders`/`order_items`), histórico de preço.
- **Entrada de mercadoria** por **foto de nota e XML de NF-e** com revisão humana (`nfeParser.ts`, `nfeSignature.ts`, `WhatsAppInventoryIntake`, `InventoryIntakeService`).
- **Cotação de compra / fornecedor** (`purchase_quotes`, `purchase_requisitions` — ADR-076).

### O que o núcleo NÃO entrega hoje (é obra, não configuração)
- **Fornecedor como entidade-mestre** (há cotação de compra, não cadastro de fornecedor) e **devolução/troca** como processo (só conversa/FAQ).
- **Venda por peso/medida**, **lote/validade**, **número de série/IMEI**, **produção por receita/ficha técnica** (baixa por ingrediente), **dimensão de loja no estoque nativo** (o core é por organização).

### Posicionamento de produto (decisão do dono)
O ZappFlow é o **gestor de dados** que ajuda o empresário a **sair da operação e focar na gestão/decisão** — a ferramenta que o ajuda a **não fechar**. Deve atuar **tanto como sistema nativo** (fonte da verdade) **quanto como supervisor/conciliador** de quem já tem ERP/PDV. Muitos clientes **querem resultado antes de migrar** — então o caminho supervisor→nativo precisa ser suportado, não forçado.

### Risco estrutural confirmado (estoque duplo)
O Retail Ops mantém `retail_store_inventory` **paralelo** ao estoque do núcleo e **permite negativo** — proposital para a TOULON (PDV externo, camada de detecção). Para um varejista que use o ZappFlow **como sistema principal**, manter dois ledgers seria **fonte de divergência**.

## Decisões

### D1. Espinha dorsal universal + **composição de capacidades** (não hierarquia rígida de nichos)
O ZappFlow **não** terá um produto por nicho, **nem** uma árvore rígida `Varejo → Roupas/Padaria/…`. Terá **uma espinha dorsal de comércio** e **capacidades componíveis** ativadas conforme a realidade da empresa. Um mesmo negócio (ex.: padaria) pode compor várias capacidades ao mesmo tempo (varejo de balcão + produção por receita + venda por peso + delivery).

### D2. Separar **"Comércio Base"** de **"Retail Network Ops (Multiloja)"** — `retail` deixa de ser preset automático
`retail` (renomeado no discurso para **Retail Network Ops**) passa a ser **capacidade opt-in**, ativada quando a resposta à pergunta 2 ("opera uma rede a supervisionar?") for sim. A vertical `varejo`/`comércio` **não liga mais `retail` por padrão**, e o pack base **não liga mais as automações `retail_*`** para todo mundo.
- **Guarda de compatibilidade (grandfather):** contas **já existentes** com `retail` ligado (TOULON e afins) **são preservadas** — a mudança altera apenas o *default de novas contas*. Nenhuma org perde módulo/automação num deploy.

### D3. Onboarding por **diagnóstico → prévia → confirmação** (nunca aplicar em silêncio)
A ativação deixa de ser "aplica o pack inteiro escondido". Fluxo-alvo: `Nova empresa → vertical Comércio → diagnóstico curto (≈7 perguntas) → motor compõe capacidades → prévia do que será ativado → responsável confirma → aplica → checklist de implantação`. O Quick-Start continua **idempotente**.

### D4. **Modo de estoque / fonte da verdade** como configuração de primeira classe
Decidido **no onboarding**, no nível da **organização** e podendo ser refinado **por loja**. Três modos:
- **Nativo** — a fonte da verdade é o ZappFlow. O saldo vive no **estoque do núcleo**; o Retail Network Ops, se presente, **lê** o núcleo para painéis/alertas e **não mantém um ledger paralelo**.
- **Supervisionado (externo)** — a fonte da verdade é o ERP/PDV externo (modelo TOULON). O núcleo **não é usado** para aquela loja; `retail_store_inventory` é uma **sombra** alimentada por importação, que **pode ficar negativa** para expor divergência. É detecção/supervisão.
- **Híbrido** — escolha **por loja**: umas nativas, outras supervisionadas; ou saldo nativo + conciliação externa de vendas.

**Invariante que elimina o estoque duplo:** *para cada (loja, produto) existe exatamente **um** ledger autoritativo.* Os dois nunca escrevem de forma autoritativa ao mesmo tempo — o **modo** decide quem manda. Nativo ⇒ núcleo é autoritativo, camada de loja é só leitura. Supervisionado ⇒ sombra é autoritativa, núcleo não é usado para aquela loja.

### D5. Caminho de **graduação supervisor → nativo**
Quando um cliente que começou **supervisionado** quiser o ZappFlow como sistema principal, há uma **promoção**: semear o estoque do núcleo a partir do último **snapshot conciliado** da sombra, virar o modo para **nativo** e, a partir daí, o núcleo passa a ser autoritativo. Isso concretiza o "resultado antes, migração depois".

### D6. Capacidades como **flags componíveis**; presets = combinações; nicho = só campos/regras
As perguntas do diagnóstico ativam **capacidades**, não "nichos":
- unidade de venda (unidade | peso | medida | fatia | kit | serviço);
- variantes (tamanho/cor/modelo);
- lote/validade; número de série;
- fabricação/preparo (produção por receita);
- produto + serviço juntos;
- uma ou várias lojas; PDV/ERP externo;
- canais (WhatsApp, balcão, e-commerce, delivery, mesa).

**Packs especializados** (ex.: *Varejo unitário*, *Perecíveis/peso*, *Produção/receitas*, *Serviço com peças*, *Retail Network Ops*) são apenas **combinações nomeadas** dessas capacidades. **Particularidades do segmento** (moda: coleção/grade/estação; autopeças: veículo/ano/aplicação; eletrônicos: serial/IMEI/garantia; padaria: validade/lote/produção; restaurante: receita/adicionais/mesa) são **campos e regras extras** por cima da capacidade — não código novo de produto.

### D7. Sequenciamento: **corte cirúrgico primeiro, motor depois** (sem retrabalho)
1. **Fatia 1 (barata, já):** D2 — desacoplar Retail Network Ops de Comércio Base, parar o auto-ligar, com a guarda de grandfather (D2). Corrige a inconsistência real para **todo novo cadastro** imediatamente.
2. **Fatia 2 (norte):** D3 + D4 + D6 — diagnóstico, modo de estoque e motor de composição.
3. **Fatia 3+:** capacidades net-new priorizadas pelos alvos (peso/validade para farmácia e minimercado; produção/receita para restaurante/padaria; etc.).

Não há retrabalho porque a Fatia 1 **é a fundação** que a Fatia 2 alavanca (o motor liga/desliga exatamente as capacidades que o corte tornou opt-in).

### D8. Fronteira **vertical × capacidade**
Regra: *vende + repõe mercadoria* ⇒ **capacidade de comércio**; *produz/serve/atende com agenda própria* ⇒ **vertical própria que reusa a espinha**. No código isso já existe: **clínica** (`saude`), **restaurante/hotelaria** (`food`/`hospitalidade`), **escola** (`educacao`) e **serviços** (`servicos`) são verticais próprias — todas podem herdar capacidades do núcleo de comércio (estoque, compras, pagamentos) sem virar "varejo".

## Mapa dos alvos de validação → capacidades (resposta do dono)

| Alvo | Vertical | Modo de estoque provável | Capacidades que **força** construir |
|---|---|---|---|
| TOULON (moda, rede) | comércio | supervisionado (PDV externo) | multiloja, variantes/grade, metas/comissão, fechamento, conciliação externa *(já em grande parte pronto — ADR-083)* |
| Clínica de psicologia | saúde (`clinica`) | nativo (sem estoque relevante) | agenda/prontuário *(ADR-080, pronto)*; comércio quase não se aplica |
| Farmácia | comércio | nativo ou híbrido | **lote/validade**, número de série (controlados), ruptura |
| Minimercado c/ hortifrúti | comércio | nativo | **venda por peso**, **validade/perdas**, ruptura |
| Restaurante | food/hospitalidade | nativo | **produção por receita** (baixa por ingrediente), mesa/comanda, **offline** *(Continuity/Edge — ADR-082, pronto)* |
| Escola | educação | nativo | mensalidade/assinatura, agenda/turmas *(vertical própria)* |
| Prestador de serviço | serviços | nativo | ordem de serviço, orçamento, peças aplicadas, garantia |

Leitura: **farmácia + minimercado** são os melhores pilotos para provar a capacidade **perecível (peso/validade/lote)**; **restaurante** prova **produção por receita + offline**; a TOULON já prova **multiloja/supervisão**.

## Consequências

**Positivas**
- Um só ZappFlow para todos, sem produto por nicho; a adaptação da TOULON vira um **pack reutilizável de multiloja**, não a definição inteira do "Varejo".
- O risco de estoque duplo é resolvido por **decisão explícita de fonte da verdade** (D4), não por acaso.
- A Fatia 1 corrige a inconsistência **hoje**, com risco baixo (grandfather).

**Trade-offs / riscos**
- Capacidades net-new (peso, validade/lote, série, produção por receita, fornecedor-mestre, devolução/troca, dimensão de loja no estoque nativo) **são obra** — precisam de priorização por alvo, não entram todas de uma vez.
- O diagnóstico + prévia aumentam a **régua de qualidade do onboarding** — coerente com vender como "produto de produção", não MVP.
- Multiloja **nativo** exige `store_id` no estoque do núcleo (hoje por organização) — decisão de esquema a ser detalhada em ADR de implementação.

## O que este ADR **não** decide (fica para ADRs de implementação)
- Esquema exato de `store_id` no estoque nativo (multiloja nativo).
- Modelagem de fornecedor-mestre, devolução/troca, peso, lote/validade, série, ficha técnica/receita.
- As 7 perguntas exatas do diagnóstico e o mapeamento pergunta→capacidade.
- Nomenclatura final ("Comércio Base", "Retail Network Ops") na UI.

## Guardas
- **Grandfather:** nenhuma organização existente perde módulo ou automação no deploy da Fatia 1.
- **Invariante de estoque (D4):** um único ledger autoritativo por (loja, produto); testes devem provar que nativo e supervisionado nunca escrevem juntos.
- **Aprovação humana preservada:** premiação/comissão e fechamento divergente continuam exigindo aprovação humana (ADR-083 D4/D7).
- **Isolamento por `organization_id`** e auditoria (`logAuthEvent`) em toda capacidade nova.
