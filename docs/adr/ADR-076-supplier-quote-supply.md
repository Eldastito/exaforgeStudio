# ADR-076 — SupplierQuoteService — cotação com fornecedores (Compras)

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. O módulo de Compras é o lado espelho da venda: sem controle de fornecedor, a margem some no meio do caminho. O `SupplierQuoteService` nasceu para fechar o loop entre a `purchase_requisition` (Fase 1) e o `products_services` (custo real), mas entrou em produção sem ADR. Este documento formaliza o desenho.

---

## Contexto

Depois que um humano aprova uma `purchase_requisition`, o operador precisa cotar os mesmos itens com **vários fornecedores em paralelo**, comparar preço + prazo + disponibilidade e escolher um vencedor. O modelo real é bagunçado:

- Fornecedores locais respondem por WhatsApp em **texto livre** ("aquele café tá 42, entrego terça, e o filtro só semana que vem"). Não dá pra exigir formulário.
- Fornecedores da rede ZappFlow (outra org no mesmo cluster) preferem preencher na UI própria — não faz sentido mandar mensagem pra si mesmo.
- A comparação precisa ser por **item**, não só pelo total: fornecedor A pode ganhar no café e perder no filtro; o operador quer partir a compra.
- O custo unitário fechado precisa realimentar `products_services.cost_price` para as margens de venda voltarem a fazer sentido — sem isso, o ADR-02x (precificação) fica cego.

Antes do serviço, cada operador mantinha planilha própria de fornecedor, e a categoria (`supplier_categories`) não era usada em lugar nenhum — spam de cotação pra fornecedor errado era rotina.

## Decisão

**Schema em três tabelas** (`purchase_quotes` + `purchase_quote_items` + reaproveita `contacts.is_supplier=1` como cadastro do fornecedor local, e `organization_settings.business_name` como cadastro do fornecedor da rede via `network_org_id`).

**Workflow explícito de status** — `draft` (raramente usado, pré-envio) → `sent` (mensagem/registro criado) → `answered` (LLM parseou resposta OU fornecedor da rede submeteu) → `accepted` / `rejected` (mutuamente exclusivos por `requisition_id`).

**Roteamento por categoria em `eligibleSuppliers`:** cruza `products_services.category` dos itens da requisição com `contacts.supplier_categories` (CSV lowercase). Fornecedor **sem** categoria definida é catch-all — a decisão consciente foi errar por excesso de convite, não por silêncio.

**Dois canais no mesmo `sendQuotes`:**
1. **Local (WhatsApp):** `MessageProviderService.sendMessage` com template humano montado em `buildQuoteMessage` (primeiro nome + emoji + lista de itens). Cria `purchase_quotes` com `status='sent'` e `supplier_contact_id`.
2. **Rede ZappFlow:** cria `purchase_quotes` com `network_org_id` (sem `supplier_contact_id`) e pré-popula `purchase_quote_items` vazios para o fornecedor preencher na UI "Pedidos da Rede". Emite `network_quote_received` na room da org fornecedora via socket.

**Parse do texto livre em `parseSupplierReply`:** LLM com `json:true` + `temperature:0`, prompt fechado listando `product_service_id` de cada item pedido para o modelo só escolher (não inventar SKU). Quantidade da linha = `min(pedido, disponível)` — protege contra fornecedor que só tem metade mas cobra pelo total.

**Ordenação do comparativo** em `listByRequisition`: `total_amount ASC NULLS LAST` — cotações ainda não respondidas caem no fim, cotação mais barata sobe. Prazo (`delivery_days`) aparece na UI ao lado, mas o ranking é **por preço**; a ponderação preço × prazo é decisão humana, não algoritmo (ver trade-off).

**`accept` em transação:** marca vencedora, rejeita todas as demais da mesma requisição em `('sent','answered')`, promove a requisição para `status='ordered'`. Idempotente pela cláusula `id != ?`.

**Isolamento da inbox da rede** (`incomingForNetwork`): o fornecedor vê `buyer_name` e `buyer_city` mas **não** vê `requisition_id` como link clicável — só como referência. Evita vazar volume de compra entre orgs da rede.

## Consequências

**Positivas:**
- Um único fluxo cobre fornecedor de esquina (WhatsApp) e fornecedor da rede (UI) — o operador não precisa saber qual é qual.
- Parse por LLM elimina o formulário Google Forms que ninguém preenche; fornecedor responde do jeito dele.
- Ranking por preço com prazo visível dá autonomia ao humano sem esconder trade-off.
- Categorias filtram spam de cotação — fornecedor de bebida não recebe mais pedido de detergente.
- `network_org_id` + `supplier_contact_id` mutuamente exclusivos deixam o schema honesto: cada cotação tem exatamente uma origem.

**Trade-offs aceitos:**
- **Sem chat de ida-e-volta com fornecedor** — a cotação é uma única mensagem + uma única resposta parseada. Se o fornecedor mandar contra-proposta ("posso fazer 40 se levar 20un"), o LLM parseia o preço mas perde a nuance da condição; o operador precisa ler a conversa original.
- **Sem histórico de reputação de fornecedor** — não guardamos "cotação prometida X, entregou Y", "atrasou N dias", "cancelou depois de aceito". A UI só mostra cotações da requisição atual. O primeiro sinal de fornecedor ruim vem da memória do operador, não do sistema.
- **Sem OCR de proposta em PDF** — fornecedor grande manda planilha/PDF anexo por WhatsApp; hoje o LLM só lê o texto da mensagem, o anexo é ignorado. Operador precisa transcrever manualmente ou pedir para o fornecedor colar o texto.
- **Ponderação preço × prazo é humana** — não temos score do tipo "melhor cotação = preço × (1 + delivery_days/7)". Duas cotações com R$100 vs R$95+3 dias de atraso ficam ranqueadas pelo preço; o operador decide. Certo enquanto o volume for baixo; revisitar quando passar de ~10 cotações/requisição.
- **`eligibleSuppliers` catch-all** para fornecedor sem categoria significa que, enquanto o cadastro estiver ralo, todo mundo recebe tudo — dor conhecida de bootstrap.
- **Custo real não realimenta `products_services.cost_price`** automaticamente no `accept`. A margem só fecha se alguém rodar o ajuste manual — falha silenciosa que já mordeu uma vez.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-supplier-quote-service.ts`. O que exercita o serviço é uso manual em staging (envio real via canal Evolution para número de teste) e o teste adjacente do webhook (`webhookProcessor.ts:263`) que roteia resposta livre de fornecedor.

**Lacunas honestas** que devem virar `scripts/test-supplier-quote-service.ts`:
- `eligibleSuppliers` com categoria casada, categoria não casada, e fornecedor sem categoria (catch-all).
- `sendQuotes` idempotência: rodar duas vezes na mesma requisição não deve duplicar quotes (hoje **duplica** — não há guarda).
- `parseSupplierReply` com JSON malformado, `product_service_id` inventado pelo LLM, `available_qty < suggested_qty` (partição), `available_qty=0`.
- `accept` com requisição já com vencedor (deve ser no-op ou erro claro, não sobrescrever).
- `submitNetworkAnswer` cross-org: org B tentando responder cotação da org A deve devolver `false` — verificar o filtro `network_org_id = ?`.
- `pendingForSupplier` com janela expirada (`withinHours`) — hoje `168h` fixo; testar borda.

Enquanto esses testes não existirem, qualquer mudança aqui exige revisão das 3 rotas consumidoras (`routes/procurement.ts:75,87,96,140,149`) e do gatilho no `webhookProcessor.ts:261-263`.
