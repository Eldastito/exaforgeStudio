# Runbook — Homologação da Fase 1 (TOULON)

> **PRD Fase 1 · F1.8.** O que entrou, em que ordem ligar, o que conferir com dado real em cada passo e como
> voltar atrás. Doc de operação — não é código. Teste de regressão: `npm run test:fase1-homologacao`.
> Mapa das entregas × código: `docs/prd/ANALISE-PRD-FASE1-vs-CODEBASE.md`.

## 0. A regra de ouro

**Nada muda na TOULON sem ligar.** Uma org recém-criada tem tudo desligado ou no comportamento de sempre
(provado em `test:fase1-homologacao`). Ligue **uma coisa por vez**, confira, e só então a próxima. Tudo que
nomeia pessoas ou mostra dinheiro é **owner/admin**.

## 1. O que já está valendo sem ligar nada (só leitura/linguagem)

| Entrega | Onde olhar | O que conferir |
| --- | --- | --- |
| **F1.0** estados honestos (`—`, "não calculado", "estimativa") | telas que usam `formatBRL`/`Metric` | dado ausente aparece `—`, nunca `R$ 0,00`; total com parcela faltando não é total |
| **F1.2** leitor de código (EAN/ref/SKU) | `/floor/scan` (Chão de loja) | bipar EAN e referência do catálogo Alterdata resolve sem cadastro; código ambíguo pede escolha |
| **F1.7a** linguagem empresarial | Central de Saúde, Insights, Retail Ops, resumo da manhã | sem "stockout"/"Sinal 'x' no domínio y"; botão diz a ação ("Investigar divergência"), nunca "Agir"; "Saudável" não aparece com assunto aberto |
| **F1.1c** cartão "são a mesma pessoa?" | topo de **Retail Ops → Vendedores** e da **Corrida** | aparece só com nome parecido; some ao responder. **Nada é unido sem o toque do dono** |
| **F1.7b** perguntas simples do gestor | Diretor IA / Fala Tu | "Quanto falta pra Grande Rio bater a meta?", "quanto vendemos em dinheiro hoje?", "quem está 2 meses sem bater meta?", "qual vendedor vendeu mais esta semana?", "tenho divergência de estoque?", "posso comprar R$ 180 mil?" respondem com o número do sistema; sem dado = "aguardando"/"não sei", nunca R$ 0. "Por que caiu?" continua no panorama (por desenho) |
| **F1.3** diagnóstico do estoque negativo | **Retail Ops → Estoque negativo** | "N ocorrências em M lojas · K causas"; causa não provada = "causa não identificada" |

## 2. Roteiro de ativação (na ordem; cada passo tem conferência e reversão)

### Passo 1 — Sanear vendedores (antes de qualquer meta por pessoa)
1. Abrir **Vendedores**: responder o cartão. Casos do Bruno: **Lohan** (mesma pessoa), **Eduardo → Eduardo Lázaro**
   ("cobrindo férias" no Carioca, com as datas), **Vinícius Romão × Nascimento** ("pessoas diferentes").
   **Kleyton/Cleiton:** o cartão não pega grafia diferente — só unir depois que o Bruno confirmar (`POST /sellers/:id/merge`).
2. Conferir: o ranking/corrida soma as duas linhas da mesma pessoa; matrícula sem vínculo segue "Vendedor não identificado".
- **Reverter:** `POST /sellers/:sellerId/unmerge` (nada foi apagado).

### Passo 2 — Fonte da venda e cota
1. Confirmar `retail_official_sale_source = 'folha'` na TOULON (venda oficial = folha do fechamento; o caixa é só parcial).
2. Conferir que as **cotas diárias por loja** estão cadastradas (`retail_store_quotas`). Sem cota o bloco da manhã não aparece
   e o acumulado da semana/mês sai **parcial**.

### Passo 3 — Resumo da manhã com cota por loja (F1.6a)
- Liga em **Central de Saúde → "Receber este resumo no WhatsApp toda manhã"** (`PUT /api/health-center/tutor`).
- Conferir na prévia (`GET /api/health-center/tutor`): bloco **"Cota de hoje por loja"** (ex.: Carioca R$ 1.000, Grande Rio R$ 2.500),
  loja sem cota listada em "Sem cota cadastrada", **Rede só com total** quando toda loja tem cota.
- **Reverter:** desligar o mesmo botão.

### Passo 4 — Parcial das 16h (F1.6b)
- `PUT /api/retailops/afternoon-brief/enabled {"enabled":true}`; prévia em `GET /api/retailops/afternoon-brief`.
- **Conferir com dado real (risco principal):** a Alterdata publica a venda do dia **antes** do fechamento? `sale_time` e
  `payments_json.dinheiro` vêm preenchidos? Se não, a parcial sai `—` (honesto), não erra — mas não serve ao Bruno.
  O texto rotula "caixa (PDV) — parcial, não é o fechamento" e avisa dados desatualizados (>90 min sem sync).

### Passo 5 — Fechamento da noite, no horário de cada loja (F1.6c/F1.6d)
1. **Definir o horário de cada loja** (uma vez): em **Lojas → editar a loja → "Resumo de fechamento no WhatsApp às"**.
   TOULON (lojas de shopping): **Avenida Brasil = 19:30** (fecha às 19h) · **as demais = 22:30** (fecham às 22h — é o padrão da rede, pode deixar vazio).
   Sem preencher, a Avenida Brasil cairia no resumo das 22:30 junto com as outras (não quebra nada, só chega mais tarde).
2. Ligar: `PUT /api/retailops/night-brief/enabled {"enabled":true}`; prévia em `GET /api/retailops/day-brief`.
3. Como sai: **19:30 só a Avenida Brasil** (sem "Rede") · **22:30 as demais + o bloco "Rede"** (o último horário do dia fecha a rede toda).
   Domingo a Avenida Brasil não abre (`closed_weekdays`) — sai do dia e não trava o total da rede. O passe roda a cada 5 min;
   se o servidor estiver fora do ar, ainda envia até 3h depois do horário.
4. Conferir: por loja venda (folha), cota, atingimento, dinheiro, semana (seg–dom) e mês; loja sem fechamento = "aguardando";
   dia sem fechamento = acumulado **parcial**. Confirme com o Bruno se 30 min depois do fechamento é suficiente pra folha chegar.
5. **Sem mensagem dupla:** com o fechamento por loja ligado, o "Fim do dia" genérico do Tutor **deixa de sair** (manhã e meio-dia continuam).
- **Reverter:** `PUT .../night-brief/enabled {"enabled":false}` — o "Fim do dia" do Tutor volta sozinho.

### Passo 6 — Metas por pessoa (F1.5) — só depois do Passo 1
1. Lançar **ausências** (férias/afastamento): `POST /sellers/:sellerId/absences` — sem isso o mês de férias conta como "meta não batida".
2. Conferir `GET /seller-goal-streaks` (quem está 1/2/3+ meses abaixo). Só depois ligar o alerta: `PUT /seller-goal-streaks/alerts`.
   O alerta nomeia pessoas e só sai com identidade resolvida.
- **Reverter:** `PUT .../seller-goal-streaks/alerts {"enabled":false}`.

### Passo 7 — Política de comissão (F1.4a)
- Regra nova entra como **proposta** (`POST /commission/policies/proposals`), nunca vira pagamento sozinha: só `active/confirmed`
  alimenta a comissão. Confirmar = gesto humano (`/confirm`). Avenida Brasil "só o 1º": plano da loja com `weeklySecondPercent: 0`.
- **Importar de um texto (F1.4b):** no modal **Configurar a corrida** → "Importar regras de um texto": cole o texto, a IA sugere, a tela mostra *campo · de → para · trecho do texto*; só **"Confirmar política"** (gesto do dono) faz valer. A IA descarta o que não está escrito no texto ou está fora de limites, nunca ativa nada sozinha e, se estiver fora do ar, não cria nada. `networkChampions` (ranking da rede) não é interpretado.
- **Reverter:** `/archive` da proposta.

### Passo 8 — Estratégia de reposição (F1.3)
- `PUT /api/retailops/stock/replenishment-strategy {"strategy":"collection_sellout"}` (ou pela aba **Estoque negativo**).
- **Antes:** ver quantas peças da TOULON já têm meta de estoque — elas continuam sugerindo recompra (a meta É a exceção).
  Transferência entre lojas **não** é afetada.
- **Reverter:** voltar para `continuous_replenishment`.

## 3. Decisões e riscos em aberto (não escondidos)

1. ~~Duas mensagens de fim de dia~~ — **resolvido (F1.6d):** fechamento por loja ligado substitui o "Fim do dia" do Tutor.
2. **Horários 19:30 / 22:30** foram definidos pelo horário de fechamento das lojas (19h / 22h) — confirmar com o Bruno se 30 min bastam pra a folha chegar.
3. **Alterdata intradia** (Passo 4): sem venda intradia/forma de pagamento a parcial das 16h e o "dinheiro" ficam vazios.
4. **Fechamento com valor 0** é tratado como "aguardando" (loja fechada de verdade aparece assim).
5. **`dailyInforme` (Informe Diário antigo)** ainda mostra `0` quando não há fechamento — contradiz a regra nova; não alterado.
6. **Recebimento** (`RetailScanService.lookupByEan`) ainda não usa o leitor novo (F1.2) — só o Chão de loja usa.
7. **Kleyton/Cleiton** e **matrículas desconhecidas**: aguardam o Bruno.
8. Nada disto foi validado em navegador com dado real da TOULON; os testes usam dado de teste.

## 4. Como provar que nada quebrou

```
npm run test:fase1-homologacao        # regra de ouro + cenário do Bruno + fiação de produção
npm run test:retail-day-brief test:seller-duplicates test:retail-replenishment-strategy test:signal-language
```
**Reversão geral:** cada fatia é um PR isolado e os dados são só `ALTER`/`CREATE` aditivos — reverter o código não perde dado.
As chaves acima desligam o comportamento por organização sem deploy.
