# Análise — códigos de vendedor "sem nome" (origem, causa, reincidência e plano)

Data: 2026-10-31 · Escopo: Operação da Rede (varejo moda / TOULON) · Tipo: pesquisa de código + docs (sem acesso ao banco de produção)

> **O que é fato (lido no código) × o que é indício (prints da TOULON) está marcado.** Nada aqui foi confirmado com dado real de produção; a seção 8 lista o que falta provar e como.

## 1. Resumo

O código "sem nome" **não é um defeito do sync nem um vendedor duplicado criado por engano**. Ele nasce de uma **lacuna de desenho**: o ZappFlow recebe da Alterdata só o **código** do vendedor em cada venda, **nunca o cadastro de vendedores** (nome, ativo, admissão/desligamento). Todo código novo, portanto, aparece como "Vendedor não identificado" até uma pessoa dar nome — e o próprio ZappFlow tem **três caminhos que criam pessoas com matrícula própria** (que não é a do PDV), o que gera a segunda metade do problema: a mesma pessoa com **dois códigos** e a venda contada **duas vezes**.

## 2. Como o código nasce (cadeia ponta a ponta)

1. **ERP (ModaUp/Alterdata):** cada vendedor é um usuário do caixa (`CAI_USUARIO`, relação com a tabela `VENDEDORES` por `VEN_CODIGO = CAI_CODIGO`). O código tem 8 dígitos e começa com o código da loja **no momento do cadastro** (ex.: `1083` + `0005`). Ao mudar de código, a loja **mantém** as matrículas antigas (confirmado pelo dono: 1005 → 1006 → 1084, vendedores mantiveram a matrícula).
2. **Sync (`AlterdataSyncRunner.ts:503`):** o `VendaMalote` traz, por venda, `caixa.usuario` → gravado em `retail_pdv_sales.vendedor_codigo`. `caixa.matricula` é o **operador do caixa** (outra coisa). **Só o código chega; nenhum nome.**
3. **Nome do vendedor:** a única rota que traria nome é `Venda/ComissaoVendasPorPeriodo` (`metaVendedorRealizado[]`), mas ela **volta vazia quando o ERP não tem metas por vendedor cadastradas** (docs/integrations/alterdata-homologacao-contrato.md, Q2). Na TOULON, o relatório de códigos acusa "o ERP ainda não trouxe nomes".
4. **Resultado:** `RetailSellerIdentityService.unidentified()` (`:270`) lista todo código presente em `retail_pdv_sales` sem pessoa em `retail_sellers` — **derivado na hora, sem tabela**. Não há evento "código novo apareceu".

## 3. Onde o código é consumido (o que quebra quando não tem nome)

`retail_pdv_sales.vendedor_codigo` → `RetailCommissionService.salesBySellerStore` (`:408`, funde 4 fontes: ZappFlow, manual, ERP, PDV) → **corrida/apuração de comissão**, **Metas por vendedor**, **ranking**, assessor executivo, cockpit "Hoje" (`RetailExceptionSignalService.unidentifiedCount`, `:59`) e a **Escala**. Sem nome: a comissão vira "pendência", a linha aparece como "Vendedor não identificado — matrícula X" e a meta fica "sem cota".

## 4. Causas raiz (fato — lido no código)

- **C1 — Não existe cadastro-mestre de vendedores vindo da Alterdata.** Só o código atravessa a integração. É a causa-mãe: enquanto for assim, todo código novo nasce sem nome.
- **C2 — O ZappFlow inventa matrículas (família de causas do "dois códigos"):**
  - `RetailSellerDirectoryService.nextMatricula` (`:209`) sugere a **"próxima matrícula"** = maior código numérico visto na loja + 1, e o modal "Cadastrar vendedor" **auto-preenche** com ela ("Sugerida automaticamente no padrão da rede"). É um **palpite** no espaço de códigos da Alterdata: pode **não ser** o código real da pessoa — e pode até **coincidir com o código de outra pessoa**.
  - `RetailFloorService.createSeller` (`:202`) cria a pessoa com placeholder **`LV-xxxxxx`** quando o lojista não informa a matrícula (Atendimento de Loja). Não há passo que ligue depois o `LV-` ao código real que aparecer no PDV.
  - `PUT /sellers/:matricula` (`routes/retailops.ts:1466`, usado pelo cartão "Vendedores a identificar" ao digitar o nome) faz **upsert pelo código com o nome digitado**: se a pessoa já existe sob outra matrícula, **cria uma segunda pessoa** (sem aviso de nome parecido nesse caminho).
- **C3 — Duas chaves de identidade que só se encontram por ação humana.** O **PDV** identifica por **código**; o **fechamento manual do gerente** (`RetailOpsService.syncRankingToSellerSales`, `:686`) identifica por **nome digitado** e só resolve a matrícula quando o nome bate com UMA pessoa cadastrada (`resolveMatriculaByName`, `:738`: nome completo único **ou primeiro nome único em toda a rede**). Nome ambíguo ou grafia diferente → a linha manual fica **sem matrícula** e vira uma "pessoa" à parte.
- **C4 — Fontes somadas, não reconciliadas.** `salesBySellerStore` soma PDV + manual quando a loja está com a fonte padrão; só **avisa** (`doubleSourced`, `:508`) com um "⚠ dobrado" pequeno. A loja só deixa de somar se alguém marcar `seller_source = 'manual'` (decisão explícita). Loja nova nasce no padrão (PDV **e** manual somam).
- **C5 — Ruído que esconde o que importa.** `unidentified()` não tem filtro de recência: códigos parados há meses (19 → 12 dos 19 parados na TOULON) contam para sempre no aviso do "Hoje" e na lista, misturados com os 7 que vendem agora. O aviso é um **número agregado**, sem loja, sem sugestão e sem "um toque".
- **C6 — Histórico de lojas que mudaram de código** (1005 → 1006 → 1084): vendas antigas ficam sob um código sem loja ativa; não é a causa dos "sem nome", mas confunde o diagnóstico (tratado na prévia/troca da filial, PRs #1927/#1928).

## 5. Por que volta a acontecer (reincidência)

Toda **loja nova** (BANGU) ou **contratação** repete a sequência: (1) a Alterdata cria o usuário → código novo; (2) o gerente cadastra a pessoa no ZappFlow com matrícula **sugerida/placeholder**; (3) o PDV passa a vender pelo código real; (4) o ZappFlow vê um código sem nome e uma pessoa sem vendas; (5) o gerente lança o manual por nome → soma dupla. Nada nas etapas 1–5 conversa com a anterior.

## 6. O que já existe de proteção e por que não basta

Existem: vendedores a identificar (lista), "são a mesma pessoa?" (nome parecido, `RetailSellerDuplicateService`), identidade com apelidos/fusão reversível (`RetailSellerIdentityService`), `seller_source='manual'`, selo "só 1 vendedor", relatório de códigos e as **ferramentas novas** (#1925 seletor "já cadastrado?", #1926 seletor no cadastro, #1929 sugestão pelo lançamento manual diário). **São todas corretivas**: agem **depois** que o código (ou a duplicata) existe. Nenhuma **impede** a criação do palpite (C2), **avisa no nascimento** do código (C5) nem **traz o cadastro da Alterdata** (C1).

## 7. Indícios do caso BANGU (prints — NÃO são prova)

- Registro: Marcus `10830002`, Nathiele `10830003`, Vinícius N. `10830004` — **sequenciais**, exatamente o que `nextMatricula` produz; no PDV vendem `10830001`, `10830005`, `10830006` (nenhum registrado).
- `10830005` bate com o manual do Marcus em 24 de 27 dias e folga nos mesmos dias → **provável código real do Marcus**; o `10830002` registrado teria **zero venda no PDV**.
- Nathiele e Vinícius N.: PDV e manual juntos (`⚠ dobrado`): 12.990,80 + 13.170,60 = 26.161,40 (o que a tela mostra) contra ~12,3 mil na planilha da cliente.
- Folha manual da BANGU com data **25/10** e "Segunda", mas o comprovante da Clover é de **26/10** (25/10/2026 é domingo): data digitada errada (nada na tela impede).

## 8. O que NÃO está provado (como provar)

1. **Matrículas fantasma:** quantos vendedores cadastrados têm matrícula **sem nenhuma venda no PDV** (últimos 90 dias) mas com lançamento manual — e qual código sem nome é o provável par. → diagnóstico read-only (proposto, ainda não construído).
2. **Origem do `10830002`** (palpite do ZappFlow × código real × cadastro antigo): a trilha de auditoria (`RETAIL_*_SELLER_*`) diz quem criou e quando.
3. **Se a Alterdata expõe uma lista de vendedores** (código, nome, ativo, admissão/desligamento): os specs recebidos não mostram; falta perguntar (HumanResources / Sales).

## 9. Plano (fatias aditivas, em ordem)

- **P1 — Parar de inventar código.** Cadastrar vendedor deixa de auto-preencher `nextMatricula`: escolhe-se o código real entre os **códigos sem nome daquela loja** (com vendas, última venda e "parece ser X"), ou marca-se "ainda não vendeu no PDV" (pessoa sem código, sem placeholder oculto). Mesmo guarda de "nome parecido" no caminho de digitar nome do cartão (fecha C2).
- **P2 — Avisar no nascimento.** Primeiro dia de venda de um código novo numa loja → sinal para o **gerente daquela loja** ("novo código vendendo na BANGU — quem é?") com as sugestões e um toque; aviso agregado do "Hoje" passa a contar só código **vendendo** (parados ficam num "arquivo", reversível). Fecha C5.
- **P3 — Ligação segura do que nasceu antes do código:** pessoa "sem código" + primeiro código novo da loja que bate pelo padrão diário → **propõe** o vínculo (nunca liga sozinho).
- **P4 — Fechamento manual por seleção:** o nome do vendedor na folha vira escolha dentre a equipe da loja (digitação livre só como "outro"). Fecha C3. Data da folha avisa quando destoa do comprovante/dia da semana.
- **P5 — Fonte dos vendedores na criação da loja:** passo obrigatório (PDV ou manual) com explicação; aviso de soma dupla passa a ter ação direta (links já existentes). Fecha C4.
- **P6 — Alterdata:** pedir a lista de vendedores; quando houver endpoint, sync do cadastro-mestre (nome + ativo + datas) → "sem nome" some na origem e desligados são sinalizados. Fecha C1.

Ordem sugerida: **diagnóstico (seção 8) → P1 + P2 (param a reincidência) → P4/P5 → P3 → P6 (depende de terceiro)**. Nenhuma fatia altera cálculo de venda/comissão sozinha; P5 e a escolha de fonte continuam decisões explícitas do dono.

## 10. Perguntas para a Alterdata/ModaUp

1. Existe endpoint (Sales, HumanResources ou outro) que liste **VENDEDORES** (`VEN_CODIGO`, nome, ativo, data de admissão/desligamento, filial)?
2. `CAI_USUARIO` é sempre igual a `VEN_CODIGO`? O código muda quando a loja muda de código (1005 → 1006 → 1084) ou quando o vendedor é transferido?
3. Quando um vendedor é transferido temporariamente para outra loja, o ERP cria um código novo ou reaproveita o original?
4. É possível que o `VendaMalote` traga o **nome** do vendedor junto do código?
