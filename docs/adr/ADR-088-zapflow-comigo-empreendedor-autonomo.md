# ADR-088 — ZappFlow Comigo: PDV + tutor para o empreendedor autônomo

- **Status:** Proposto (design aprovado na conversa; implementação por fatias, sem código ainda)
- **Data:** 2026-07
- **Contexto de origem:** o ZappFlow foi desenhado para negócios **com estrutura** (TOULON: 7 lojas, funcionários, PDV legado Alterdata). O empreendedor **autônomo** (marmiteira, manicure, cabeleireira, chaveiro, pipoqueira, galeto de fim de semana, barraca de feira/praia, foodtruck) é **outra espécie**: começa do zero, sem funcionário para delegar, sem sistema legado para conciliar, muitas vezes sem CNPJ, com pouco letramento digital, celular como único aparelho e nenhuma paciência (nem caixa) para "implantar um sistema". Aqui o ZappFlow **não organiza uma estrutura — ele É a estrutura.**
- **Relacionadas:** ADR-084 (composição de capacidades por vertical/arquétipo — reusa o motor `RetailDiagnosticService.recommend`), ADR-085 (Impact Ledger — vira o paywall e o termômetro de saúde), ADR-082 (Continuity Layer — venda offline na feira/praia), storefront (`Storefront.tsx` — base do PDV/loja), ADR-086 (scan/pré-estoque — parentesco com cadastro/estoque).

## Contexto

Para essa pessoa, o discurso atual do ZappFlow ("Central de Execução e Inteligência Operacional") **assusta**. Ela não fala "operação", "pipeline", "governança"; fala *"meu corre"*, *"minhas clientes"*, *"quanto sobrou hoje"*. O produto precisa ser uma coisa só:

> **Um sócio dentro do celular que cuida da parte chata — e, com o tempo, ensina a pessoa a virar gestora do próprio negócio.**

O nome do produto é **ZappFlow Comigo** (sub-marca, porta de entrada própria, tom de tutor que caminha junto — distinta da porta enterprise/varejo).

### Norte do produto (north star)
Revelar, gentilmente, **um número que essa pessoa nunca teve** — *"quanto eu ganho de verdade em cada unidade / cada hora minha"* — e depois **melhorá-lo**. Toda função existe a serviço disso.

### Não é um app — são 3 superfícies sobre 1 espinha
| Superfície | Quem usa | O que é |
|---|---|---|
| **🧑‍🍳 Balcão** (operador) | o empreendedor | PDV **por toque**: clica na foto do produto/serviço, define quantidade, cobra (Pix) ou recebe em dinheiro. Cadastro de produtos **por áudio**. Fila de pedidos em background; na tela só o "pedido da vez" + contador. |
| **📱 Mesa/Cliente** (autoatendimento) | o cliente final | Lê o QR → cardápio → pede → **paga** → o pedido só então cai na fila do Balcão. Sem atendente. |
| **🧠 Comigo** (tutor) | o empreendedor | roda por trás das duas: custo, preço, ponto de equilíbrio, ticket médio, sazonalidade, saúde do negócio, oportunidades. |

O **arquétipo** (ver D1) liga/desliga a Mesa: o chaveiro e a marmiteira por encomenda usam só Balcão + Comigo; o galeto/foodtruck/feira ligam a Mesa/QR.

## Decisões

### D1 — O produto se molda por **arquétipo**, não por segmento (reusa o motor do ADR-084)
O onboarding são 3 perguntas em linguagem de gente (no app/WhatsApp), que resolvem **dois eixos**:
1. *"O que você faz?"* (pipoca, unha, cabelo, marmita, chave, galeto…)
2. *"Atende com hora marcada ou é chegou-e-comprou?"* → **agenda × balcão**
3. *"Fica num ponto ou se move?"* → **fixo × móvel**

O motor liga só os pilares certos. Reaproveita `RetailDiagnosticService.recommend/apply` (mesmo padrão da TOULON), agora com preset de arquétipos autônomos.

### D2 — Cadastro por **áudio**; venda por **toque** (não é PDV conversacional)
Áudio é para **cadastrar** ("bolo de pote P, R$8; galeto inteiro, R$45; peso, tamanho, quantidade") — porque digitar é o atrito. A **venda** é toque na imagem do produto no webapp. O cadastro flui automaticamente para a loja virtual (uma base só).

### D3 — Pagamento **Pix sem maquininha**, em degraus (não construir sobre leitura de notificação)
- **MVP:** Pix **estático** (chave copia-e-cola / QR fixo) + o operador toca **"recebi"**. Zero integração, funciona no dia 1.
- **Fatia seguinte:** Pix **dinâmico via PSP com webhook** (ex.: Mercado Pago/Efí/Asaas/Cora): QR com `txid` único → o PSP confirma **automaticamente** → o pedido libera para a fila sozinho. Concilia por `txid`.
- **Rejeitado como base:** ler a notificação do banco. Um **PWA não consegue** (exige app nativo Android com Notification Listener); é frágil (cada banco muda o texto), dá falso positivo e é risco de segurança. No máximo, plano B futuro com um app-companheiro nativo.

### D4 — **Pagar antes de produzir** (fluxo pay-first) + fila do Balcão
O pedido da Mesa/QR **só entra na fila do Balcão quando está pago**. Isso elimina calote/fiado esquecido, funde "pedir + pagar" numa etapa e remove o atrito do atendente. Pedidos agrupam-se por **sessão do cliente** (o apelido que ele informa, sem login): dá para **adicionar itens** à sessão ("junto ou depois?") e marcar **consumo local × viagem** (tem efeito em embalagem/preço/fiscal).

### D5 — Sugestão **zero-token por padrão**, LLM só na ponta
- **Zero token (maioria):** *"Mais pedidos", "Sugestão da casa", "Quem pediu isso também levou…"* — é **ranking/co-ocorrência** (market-basket) pré-computado, não IA generativa. Também é motor de **upsell** grátis.
- **Com token (só quando precisa):** quando o cliente **escreve um desejo** ("algo leve", "sou vegetariano"), aí chama o LLM, alimentado pela **RAG do cardápio**. Mesma filosofia frugal do scan-first (ADR-086).

### D6 — Motor de **rendimento/precificação** com calibração pelo real (o coração)
Uma **ficha técnica viva** que unifica três estruturas de custo, mudando só o denominador:
| Tipo | Custo unitário nasce de | Exemplo |
|---|---|---|
| **Revenda** | custo de compra ÷ 1 | água/bala do ambulante |
| **Fabricação** | (insumos + gás + óleo + sal + embalagem) ÷ **rendimento** | pipoca, marmita, galeto |
| **Serviço** | insumo rateado por atendimento **+ o tempo** | manicure, cabelo, chaveiro |

Regras do motor:
- **O tempo é o insumo esquecido do serviço** — e o mais caro. O motor pergunta *"quanto vale sua hora?"* e mostra se o preço cobre o tempo, não só o insumo.
- **Custos indiretos que a pessoa esquece:** gás, energia, embalagem, transporte/combustível, **a taxa do Pix/PSP**, aluguel da cadeira. Lista de "custos que você esquece".
- **Loop estimativa → realidade (IP defensável):** a ficha começa como chute (1kg de milho = 40 saquinhos). A cada fechamento, a **realidade** entra (fez 35, 3 queimaram) e o motor **recalibra rendimento e custo reais**. Em semanas, o preço deixa de ser palpite e passa a ser o histórico da pessoa. Registra **merma/perda** como dado que ensina.
- **Trabalha com chute, melhora com o real:** nunca travar em "não sei quanto gastei de gás" — assume um padrão e refina depois.
- **Guarda-corpo:** nunca sugerir preço que espante o cliente; ensinar sem humilhar.

### D7 — **Saúde do negócio**: termômetro, não gráfico (dia/semana/mês)
Um **sinal único** — *subindo / estável / caindo* — com toggle **dia / semana / mês**, alimentado só pelo que o Balcão já registra (zero input extra):
- **Comparar com o mesmo período** (sábado × sábado passado), não com o anterior imediato — obrigatório para negócio sazonal, senão o termômetro mente.
- **Pesar lucro, não faturamento** — é possível vender mais e ganhar menos; o termômetro sobe quando **sobra mais dinheiro**.
- **Uma frase + uma ação:** *"Seu mês cresceu 12% em vendas, mas o lucro caiu — o milho subiu, reajuste o saquinho G."* Nunca só o número.
- Deriva **ticket médio** (vendas ÷ pedidos) e **ponto de equilíbrio** (custos fixos ÷ margem média → *"você precisa de R$420 ou 22 galetos pra empatar hoje"*), ligados ao contador da fila como **barra de meta ao vivo** ("12 de 22 pra empatar o dia").
- Reaproveita a infra de snapshot/trend do Impact Ledger (ADR-085: `snapshotDaily`/`getTrend`).

### D8 — Monetização: **grátis até provar valor; Impact Ledger como paywall**
- Começa **de graça** (agenda, Balcão, caixa).
- O **paywall é o próprio ganho provado**: quando o Comigo já mostrou que fez a pessoa ganhar/economizar R$X ("esse mês você recuperou R$240 de clientes que iam furar"), oferece o plano pago (faixa R$19–29/mês) ou **boosts** (post automático, Pix dinâmico, catálogo). **Só paga depois de sentir o dinheiro entrar.**
- Onboarding e suporte **zero-toque** pelo próprio app (não há venda consultiva "agendar diagnóstico" — isso é para a TOULON). Distribuição viral: cada catálogo/QR que a pessoa manda é propaganda.

### D9 — **PWA** no MVP
Webapp instalável (PWA) cobre quase tudo, instala rápido e evita fricção de loja de app. Só a confirmação por notificação de banco e alguns recursos exigiriam nativo — reavaliar app nativo Android **só se** um recurso concreto puser necessidade. Venda **offline** (feira/praia) via Continuity Layer (ADR-082), sincronizando depois.

### D10 — Faseamento **pedagógico** (o app cresce com a pessoa)
Não jogar custo + margem + ficha técnica no primeiro dia. A progressão desbloqueia por maturidade: **registrar venda → "quanto sobrou" → "quanto custa" → "quanto cobrar" → metas/saúde**. A pessoa vira gestora aos poucos.

## Escopo do MVP (primeiro corte)

**Entra:** D1 (arquétipos) · D2 (cadastro áudio + venda toque) · D3 nível 1 (Pix estático + "recebi") · D6 nível revenda+fabricação · D7 termômetro básico + ticket médio + ponto de equilíbrio · D8 (grátis + paywall Impact Ledger) · D9 (PWA + offline) · D10.

**Fatia 2:** Mesa/QR autoatendimento (D4) · Pix dinâmico com webhook PSP (D3 nível 2) · sugestão com LLM+RAG (D5 nível 2) · serviço-com-tempo no motor de preço (D6 serviço).

**Futuro (graduação):** orientar formalização **MEI + nota fiscal** — é o caminho natural de "graduação" (paralelo ao supervisor→nativo do varejo, ADR-084 D5) e endereça justamente o buraco fiscal que o ZappFlow tem hoje.

## Consequências

**Positivas:** greenfield puro (sem legado a conciliar), nativo de celular; reaproveita muito do que já existe (storefront, diagnóstico/arquétipos, Impact Ledger, Continuity, RAG frugal); fosso competitivo real (os cardápios-QR do mercado — Goomer, Anota AI, MenuDino — não têm o tutor/precificação/saúde por baixo); um app só serve chaveiro, marmiteira e foodtruck.

**Trade-offs / riscos:** unit economics de ticket baixo só fecham com **escala + toque zero** (um cliente que exige suporte humano dá prejuízo); churn/sazonalidade alta (a barraca some no inverno) — o produto precisa aguentar **pausar/voltar** sem atrito; letramento digital exige **áudio/foto/voz como requisito**, não opção; a porta de entrada de hoje (landing enterprise) espanta esse público — o Comigo precisa de **porta própria**.

## Guardas
- **Isolamento por `organization_id`** e auditoria em toda escrita (cada autônomo é um tenant).
- **LGPD:** o dado de faturamento é sensível e é o negócio da pessoa — transparência e confiança são parte do produto.
- **Frugalidade de token:** IA generativa só onde é insubstituível (D5); ranking/co-ocorrência é consulta, não IA.
- **Não construir sobre leitura de notificação de banco** (D3); Pix confiável = PSP com webhook.
- **Guarda-corpo do tutor:** nunca sugerir preço que quebre a pessoa nem espante o cliente; ensinar sem humilhar (D6).
