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
2. **Horários 19:30 / 22:30** (30 min após o fechamento das lojas, 19h / 22h) — **confirmado pelo dono em 30/09/2026: 30 min bastam pra a folha chegar.**
3. **Alterdata intradia** (Passo 4) — **o dono confirmou em 30/09/2026 que a Alterdata publica a venda do dia antes do fechamento.** É confirmação verbal, não conferida em dado: no 1º dia real, abrir `GET /api/retailops/afternoon-brief` e conferir "Vendido" e "Dinheiro" preenchidos. Se vierem vazios, a mensagem mostra "—" (nunca inventa número) e o Passo 4 não serve ao Bruno até resolver.
4. **Fechamento com valor 0** é tratado como "aguardando" (loja fechada de verdade aparece assim). **Desde a homologação de 30/09/2026 isso vale também no Insights, no Informe diário e no ranking Top/Bottom** (antes mostravam "Grande Rio R$ 0,00 −100%" e "Bateu R$ 0,00").
5. ~~`dailyInforme` mostra `0` sem fechamento~~ — **corrigido** (`test:unknown-not-zero`): loja sem fechamento = "aguardando", resultado do total só entre lojas que já fecharam, texto compartilhável diz "Aguardando fechamento". Também corrigidos na mesma entrega: "Cota do dia R$ 0,00" sem cota → "—"; desvio inflado (cota da rede contra venda de 2 lojas); loja no Top 3 e no Bottom 3 ao mesmo tempo; "Situação: Saudável" com assunto aberto; "Fim do dia" genérico com "Vendas R$ 0,00 · Nada em aberto"; comissão sem regra mostrando R$ 0,00 (agora "não foi calculada").
6. **Recebimento** (`RetailScanService.lookupByEan`) ainda não usa o leitor novo (F1.2) — só o Chão de loja usa.
7. **Kleyton/Cleiton** e **matrículas desconhecidas**: **decisão do dono em 30/09/2026 — ficam com o Bruno/equipe resolver.** Enquanto isso seguem como "Vendedor não identificado"; nada é unido sem resposta (cartão "são a mesma pessoa?" ou `POST /sellers/:id/merge`).
8. Nada disto foi validado em navegador com dado real da TOULON; os testes usam dado de teste.

## 4. Como provar que nada quebrou

```
npm run test:fase1-homologacao        # regra de ouro + cenário do Bruno + fiação de produção
npm run test:retail-day-brief test:seller-duplicates test:retail-replenishment-strategy test:signal-language
```
**Reversão geral:** cada fatia é um PR isolado e os dados são só `ALTER`/`CREATE` aditivos — reverter o código não perde dado.
As chaves acima desligam o comportamento por organização sem deploy.

## 5. Checklist do primeiro dia real (TOULON)

> Vale para as lojas de shopping. Ligue **uma chave por vez** e confira antes de passar à próxima.
> Este dia só homologa se alguém **compara com a folha** — "o Bruno não reclamou" não é validação.

### Véspera (sem o Bruno)
- [ ] **Lojas → Avenida Brasil → editar:** "Resumo de fechamento no WhatsApp às" = **19:30**. As demais ficam vazias (= 22:30).
- [ ] **Cotas** de cada loja cadastradas para o dia (`retail_store_quotas`). Sem cota o bloco da manhã não aparece.
- [ ] `retail_official_sale_source = 'folha'`.
- [ ] Cartão "são a mesma pessoa?" respondido (Lohan, Eduardo → Eduardo Lázaro com cobertura de férias, Vinícius Romão ≠ Nascimento). Kleyton/Cleiton ficam com o Bruno e seguem "não identificado".
- [ ] Telefone do Bruno cadastrado para receber o WhatsApp.
- [ ] **Não ligar neste dia** o alerta de metas por vendedor (Passo 6) nem a estratégia de reposição (Passo 8).

### Manhã
- [ ] Ligar **Central de Saúde → "Receber este resumo no WhatsApp toda manhã"**; conferir a prévia em `GET /api/health-center/tutor`.
- [ ] "Cota de hoje por loja" com o valor certo de cada loja; loja sem cota em "Sem cota cadastrada"; Rede só com total se toda loja tem cota.
- [ ] Bruno recebeu no WhatsApp e confirma que as cotas batem.

### Antes das 16h — maior risco do dia
- [ ] Abrir `GET /api/retailops/afternoon-brief`: **"Vendido" e "Dinheiro" preenchidos** por loja? Se vierem `—`, a Alterdata não publica a venda antes do fechamento → **não ligar** a parcial.
- [ ] Se preenchidos, comparar 2–3 lojas com o caixa que o Bruno enxerga.
- [ ] Só então: `PUT /api/retailops/afternoon-brief/enabled {"enabled":true}`.
- [ ] Após as 16h: texto diz "caixa (PDV) — parcial, não é o fechamento"; o aviso de dado desatualizado (>90 min sem sync) não apareceu por engano.

### Antes de ligar o fechamento
- [ ] `GET /api/retailops/day-brief` comparado, valor por valor, com a folha de uma loja: venda (folha), cota, atingimento, dinheiro, semana (seg–dom) e mês.
- [ ] Loja sem fechamento = "aguardando"; dia sem fechamento = acumulado "parcial".
- [ ] Ligar: `PUT /api/retailops/night-brief/enabled {"enabled":true}`.

### 19:30 — Avenida Brasil
- [ ] Chegou **só a Avenida Brasil**, sem bloco "Rede".
- [ ] A folha já tinha chegado. Se veio "aguardando", anotar a hora real em que a folha chega.
- [ ] Números conferem com o que o Bruno vê.

### 22:30 — demais lojas + Rede
- [ ] Chegaram as demais lojas + bloco **"Rede"**; o total da Rede fecha com a soma das lojas.
- [ ] Nenhuma loja com `R$ 0,00` no lugar de "aguardando".
- [ ] **Não** chegou o "Fim do dia" genérico do Tutor (a mensagem dupla); manhã e meio-dia do Tutor seguem normais.

### Critério de aceite (com o Bruno, no dia seguinte)
- [ ] Números das 19:30 e 22:30 bateram com a folha dele.
- [ ] A parcial das 16h trouxe "Vendido" e "Dinheiro" — ou foi decidido que ela não serve.
- [ ] Nenhuma mensagem duplicada.
- [ ] 30 min após o fechamento foram suficientes para a folha chegar.
- [ ] O Bruno disse com as próprias palavras que serve.

### Se algo vier errado
| Sintoma | O que fazer |
| --- | --- |
| Parcial com `—` | Desligar (`afternoon-brief/enabled false`). Nada quebra, só não serve ainda. |
| Fechamento diverge da folha | Desligar (`night-brief/enabled false`; o "Fim do dia" do Tutor volta sozinho). Registrar dia, loja, valor da mensagem e valor da folha. |
| Avenida Brasil chegou às 22:30 | O horário 19:30 não foi salvo na loja. |
| Loja "aguardando" com folha já enviada | Registrar loja e hora em que a folha chegou. |
| Mensagem dupla de fim de dia | Não deveria acontecer — reportar. |

### Pontos cegos
- Este dia só exercita um caso. **Domingo** a Avenida Brasil não abre (`closed_weekdays`) e ninguém conferiu o total da Rede nesse cenário — olhar no primeiro domingo.
