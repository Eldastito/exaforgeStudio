# ADR-091 — Nova grade de planos, módulos, cobrança e performance fee

**Status:** Aprovado (aguardando implementação).

**Origem:** Item #1 do `docs/BACKLOG-CAMPO-TOULON.md`. A grade seed antiga (Starter R$99 / Pro R$299 / Business R$799) foi desenhada quando o produto era menor. Hoje, com IA cara + módulos maduros + piloto TOULON em campo, a grade precisa ser redesenhada com um tier **Autônomo** de entrada, novos preços que cobrem custo real de IA, e um modelo de receita **híbrido** (assinatura + módulos + consumo excedente + **2% do ganho incremental**).

Este ADR consolida a decisão comercial. Não implementa. Serve de referência para o Bloco A (migração de banco + tela) e Bloco B (ASAAS).

---

## Contexto

Comparado com o produto de 6 meses atrás, o ZappFlow hoje entrega:

- Atendimento IA multicanal (WhatsApp Cloud, Evolution, Instagram)
- Loja virtual + PDV
- Diretor IA (conselheiro de gestão)
- Radar de Execução IA
- Compras/Supply, Reservas, Assinaturas, Orçamentos
- Estúdio de Criação
- Fashion (avatar/look/tryon)
- Vision VMS (câmeras)
- Módulos Clínica, Retail Ops, Continuidade Offline

O custo variável real (IA + storage + infra) é significativo. Preços antigos não cobrem o cliente médio de forma sustentável — muito menos o cliente intensivo.

Adicionalmente, o piloto TOULON demonstrou a necessidade de:

- Um plano de **entrada** pra profissional individual (Autônomo)
- Diferenciação **por vertical** (varejo/hotelaria/saúde/moda)
- **Painel de valor gerado** — condição para justificar performance fee
- Gateway real de cobrança (ASAAS) — não existe hoje

## Decisão

### 1. Grade de planos

| Plano | Mensal | Anual (equiv./mês) | Público |
|---|---:|---:|---|
| **Autônomo** | R$ 247 | R$ 197 | Profissional individual (coach, personal, salão, bolo caseiro) |
| **Start** | R$ 597 | R$ 497 | Micro/pequena empresa (2-5 pessoas, 1 loja) |
| **Growth** | R$ 1.797 | R$ 1.497 | Empresa em crescimento (5-15 pessoas, multi-canal) |
| **Scale** | R$ 4.797 | R$ 3.997 | Operação estruturada, multi-unidade, rede |
| **Enterprise** | a partir de R$ 8.000 | sob contrato | Redes complexas, contrato negociado |

**Plano anual:** compromisso real de 12 meses. Cobrança parcelada no cartão (12x). Se cancelar antes, meses usados são recalculados pelo preço mensal cheio (sem desconto). Redação exata da política precisa passar por advogado antes de subir em produção — Código Civil art. 413 e CDC podem reduzir penalidades desproporcionais.

### 2. Módulos por plano

Regra: cada tier **herda** o de baixo e adiciona.

| Módulo | Autônomo | Start | Growth | Scale | Enterprise |
|---|:-:|:-:|:-:|:-:|:-:|
| **Core** (atendimento, contatos, relatórios, config) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Catálogo | ✅ | ✅ | ✅ | ✅ | ✅ |
| Agenda | ✅ | ✅ | ✅ | ✅ | ✅ |
| Vendas | ✅ | ✅ | ✅ | ✅ | ✅ |
| Pagamentos | ✅ | ✅ | ✅ | ✅ | ✅ |
| Integrações | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Loja / PDV** | ✅ PDV | ✅ Vitrine | ✅ Vitrine | ✅ Vitrine | ✅ Vitrine |
| Autônomo Copiloto (precificação, "quanto vale minha hora") | ✅ | — | — | — | — |
| Campanhas | — | ✅ | ✅ | ✅ | ✅ |
| Áreas de atendimento | — | ✅ | ✅ | ✅ | ✅ |
| Diretor IA (light) | — | ✅ | — | — | — |
| Cadências | — | — | ✅ | ✅ | ✅ |
| Assinaturas (mensalidade do cliente) | — | — | ✅ | ✅ | ✅ |
| Orçamentos | — | — | ✅ | ✅ | ✅ |
| **Reservas** (opcional por vertical) | — | — | opt-in | opt-in | opt-in |
| Estúdio de Criação | — | — | ✅ | ✅ | ✅ |
| Diretor IA (completo) | — | — | ✅ | ✅ | ✅ |
| Compras (Supply) | — | — | — | ✅ | ✅ |
| Eventos & Grupos | — | — | — | ✅ | ✅ |
| Radar de Execução IA | — | — | — | ✅ | ✅ |
| Retail Ops (multi-loja) | — | — | — | ✅ | ✅ |
| Painel de Valor Gerado | — | — | — | ✅ | ✅ |
| Vision VMS (hardware câmera) | — | — | — | — | opt-in |
| Clínica (fluxo saúde) | — | — | — | — | opt-in |
| Prospect AI | — | — | — | — | opt-in (quando maduro) |

**Reservas** entra opt-in por vertical: Growth de hotelaria/saúde/serviços recebe ligado; Growth de varejo/food não.

**Loja no Autônomo vira PDV:** tela minimalista de fechamento de pedido (produto + qty + preço + cliente já capturado do WhatsApp + link PIX ou "pago em dinheiro"). Sem vitrine pública. Ao migrar pra Start, ativa modo vitrine automaticamente.

### 3. Limites por plano

| Recurso | Autônomo | Start | Growth | Scale | Enterprise |
|---|---:|---:|---:|---:|---:|
| Usuários | 1 | 2 | 5 | 20 | custom |
| Canais WhatsApp/IG | 1 | 1 | 3 | 10 | custom |
| Contatos | 1.000 | 3.000 | 10.000 | 50.000 | custom |
| **Ações de IA/mês** | 500 | 3.000 | 10.000 | 30.000 | custom |
| Trial | 30 dias | 30 dias | 30 dias | 30 dias | negociado |

**"Ação de IA"** = cada chamada ao modelo de linguagem (LLM). Conta 1 por: resposta ao cliente no WhatsApp/Instagram, transcrição de áudio (Whisper), classificação de foto (visão), extração de produto de foto, análise de PDF, resposta do Diretor IA, follow-up automático.

Ao estourar o limite, o atendimento IA transfere para humano com mensagem educada. A plataforma continua operando; só o "IA respondendo sozinha" é pausado. Cliente pode comprar excedente (ver §4).

### 4. Consumo excedente (IA)

Pay-as-you-go, sem forçar upgrade. Preço escalona com o tamanho do pacote:

| Plano | Pacote extra | Preço |
|---|---|---:|
| Autônomo | +2.000 ações | R$ 200 |
| Start | +5.000 ações | R$ 400 |
| Growth | +15.000 ações | R$ 1.000 |
| Scale | +50.000 ações | R$ 2.500 |
| Enterprise | negociado | negociado |

Cliente compra pacote extra manualmente OU liga "recompra automática ao atingir 90%" (opt-in).

### 5. Add-ons — precificação anti-canibalização

**Regra de ouro:** 2 add-ons no mesmo tier devem custar mais que a assinatura do tier acima. Isso força o cliente a questionar "por que não migrar?".

**Autônomo — sem add-ons.** Se precisa de algo além, sobe pra Start. Simplifica onboarding.

**Start pode comprar (add-ons ≥ R$ 700/mês):**

| Add-on | Preço | Combo Start + 1 | vs Growth |
|---|---:|---:|---|
| Reservas | R$ 800 | R$ 1.397 | R$ 1.797 (borderline) |
| Assinaturas | R$ 800 | R$ 1.397 | R$ 1.797 |
| Orçamentos | R$ 800 | R$ 1.397 | R$ 1.797 |
| Estúdio de Criação | R$ 900 | R$ 1.497 | R$ 1.797 |
| Diretor IA completo (upgrade do light) | R$ 700 | R$ 1.297 | R$ 1.797 |
| Cadências | R$ 800 | R$ 1.397 | R$ 1.797 |

Start + 2 add-ons ≥ R$ 2.100, acima do Growth R$ 1.797 → **migrar é obviamente melhor.**

**Growth pode comprar (add-ons ≥ R$ 1.500/mês):**

| Add-on | Preço |
|---|---:|
| Compras (Supply) | R$ 1.500 |
| Eventos & Grupos | R$ 1.500 |
| Radar de Execução IA | R$ 1.800 |
| Retail Ops (multi-loja) | R$ 2.000 |

Growth + 2 add-ons ≥ R$ 4.797, empatando ou passando Scale → **migrar é melhor.**

**Scale pode comprar add-ons de Enterprise:**

| Add-on | Preço |
|---|---:|
| Vision VMS | R$ 3.500 + setup hardware |
| Clínica | R$ 3.000 |
| Prospect AI (quando maduro) | R$ 3.500 |

Scale + 1 add-on ≥ R$ 8.297, entra no piso do Enterprise → **negocia contrato.**

### 6. Performance fee (2% do ganho incremental)

Modelo híbrido de receita:

```
Receita mensal = assinatura base + add-ons + consumo excedente + unidades adicionais + 2% do ganho incremental
```

**Regras invioláveis:**

- Cobra **APENAS sobre ganho incremental comprovado**, nunca sobre faturamento total.
- Fórmula: `Margem de Contribuição Ajustada (mês atual) − Linha de Base` = ganho incremental. Taxa = 2% × ganho.
- **Modo beta obrigatório nos primeiros 6 meses** do cliente: painel MOSTRA o cálculo, mas NÃO cobra. Cliente contesta e ajusta. Cobrança só ativa depois de calibrar.
- **Opt-in explícito** por período: cliente aceita ativar cobrança de performance com 1 clique + confirmação. Pode desativar a qualquer momento (aviso de 30 dias).
- **Gatilho de ativação recomendado:** margem de contribuição incremental ≥ 15% da linha de base, sustentada por 3 meses consecutivos.
- **NUNCA cobrar por recomendação da IA.** Se a IA recomenda um módulo/upgrade, é APENAS recomendação — cobrança do módulo é feita pelo preço tabelado, sem "success fee" oculto.
- Painel de valor gerado (Scale+): decomposição por driver (receita recuperada por follow-up, economia por reposição inteligente, etc.). Cliente pode contestar linha por linha.

**Linha de base:** 3 meses no varejo/serviços; 6 meses em negócios sazonais. Ajustar sazonalidade, inflação, campanhas externas.

### 7. Migração dos clientes atuais (D)

**Sem grandfathering.** Como nenhum cliente paga hoje (piloto TOULON está em "cortesia" até fim do trial), a decisão foi:

- Todos os clientes atuais são migrados automaticamente pra grade nova no dia do deploy.
- Mapeamento:
  - Antigo **Starter (R$ 99)** → **Autônomo (R$ 247)**
  - Antigo **Pro (R$ 299)** → **Growth (R$ 1.797)**
  - Antigo **Business (R$ 799)** → **Scale (R$ 4.797)**
- **Trial:** cada cliente ganha 30 dias contados a partir da data de criação da conta (não da data do deploy). Quem já ultrapassou 30 dias vai pra "cortesia" ou tem que confirmar assinatura no ASAAS.
- Aviso: banner in-app + email + WhatsApp (para o dono cadastrado) informando a nova grade, com link pro comparativo.
- **Após 30 dias do trial:** conta cai em modo somente-leitura até assinar (não bloqueia — cliente vê os dados, mas IA para de responder e nenhum novo pedido é criado).

### 8. Cobrança — gateway ASAAS

**Escolha:** ASAAS.

Motivo: PIX + boleto + cartão em uma API, taxa competitiva, integração já familiar. Alternativas descartadas: Mercado Pago (foco em marketplace), Stripe (não é ideal pra PIX brasileiro).

**Integração a construir (Bloco B):**

- Serviço `AsaasService` (createCustomer, createSubscription, cancelSubscription, listInvoices, syncStatus)
- Webhook `/api/webhooks/asaas` para receber `PAYMENT_CONFIRMED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`
- Reflexo no `PlanService`: `billing_status` = suspended/blocked/active baseado em eventos ASAAS
- Página `Configurações → Assinatura` com histórico, faturas, cancelamento
- Fluxo de checkout no fim do trial

**Réguas de inadimplência:**

| Dia | Ação |
|---|---|
| D-5 | Lembrete preventivo |
| D-1 | Lembrete de vencimento |
| D+1 | Aviso de atraso (WhatsApp + email) |
| D+3 | Segundo aviso |
| D+5 | Proposta de regularização (parcelamento, prorrogação) |
| D+7 | Restrição de recursos não essenciais (relatórios pesados, campanhas) |
| D+10 | Suspensão de automações (IA para de responder) |
| D+15 | **Modo somente-leitura** (bloqueio operacional; cliente ainda vê dados) |
| D+30 | Cancelamento contratual + preservação dos dados por 30 dias (LGPD) |

**IA calcula RISCO de inadimplência**, mas NÃO bloqueia por previsão. Só bloqueio real após confirmação de não-pagamento + comunicações da régua acima.

## Consequências

**Positivas:**

- Grade cobre o custo real de IA e escala com o tamanho do cliente
- Autônomo abre porta pra base grande (autônomos são a maior parcela do mercado brasileiro)
- Anti-canibalização faz o cliente escolher upgrade em vez de "montar" o plano
- Modo beta do performance fee constrói confiança antes de cobrar
- Cancelamento com modo somente-leitura preserva o dado do cliente (LGPD-friendly) sem perder capacidade de cobrança
- ASAAS resolve PIX + boleto + cartão de uma vez

**Trade-offs aceitos:**

- **Sem grandfathering** = risco de churn de clientes antigos, mas hoje o risco é zero (ninguém paga). Assumido.
- **Performance fee em beta 6 meses** = você renuncia a receita variável no início pra construir confiança. Aceitável, cobra mais barato depois de calibrar.
- **Modo somente-leitura** exige pouca lógica no código, mas ainda não existe — precisa implementar no `PlanService` (já tem `billing_status`, falta o efeito no menu + IA).
- **ASAAS webhook + reconciliação** é código sensível — precisa teste automatizado forte antes de subir em produção (senão paga fatura errada ou desativa cliente pagante).
- **Reservas opt-in por vertical** exige lógica de vertical no `applyVertical` que não é 100% consistente hoje — precisa refino.
- **Preço da hora do advogado** (redação da política de cancelamento, LGPD do bloqueio, contrato) fica fora do escopo do código, mas é bloqueador antes de subir em produção real.

## Roadmap de implementação

Este ADR aprova a decisão. Não implementa. Divisão sugerida:

### Bloco A — Base de planos + módulos + tela (2-3 dias)

1. Migração do `plans` seed em `db.ts` (starter/pro/business → autônomo/start/growth/scale/enterprise)
2. Novo `ai_monthly_limit` por plano, `contacts_limit`, `channels_limit`, `users_limit`, `trial_days=30`
3. Migração das orgs atuais (mapeamento §7)
4. `verticals.ts` e `ModuleService`: ajuste do preset por vertical + suporte a `pdv_mode` na Loja
5. Tela `Configurações → Módulos` (item #0 do backlog): mostra só recomendados pra vertical + colapsa outros
6. Tela `Configurações → Plano atual` (nova): mostra plano, uso, limite, comparativo
7. Migração idempotente (rodar 2× sem quebrar nada)
8. Teste E2E do mapeamento

### Bloco B — ASAAS + cobrança + inadimplência (3-5 dias)

1. `AsaasService` com métodos essenciais
2. Webhook `/api/webhooks/asaas` com assinatura verificada
3. `PlanService.billing_status` atualizado por evento ASAAS
4. Página `Configurações → Assinatura` com faturas, cancelamento, upgrade
5. Régua de inadimplência (Scheduler pass diário)
6. Modo somente-leitura no `ModuleService.isEnabled` (bloqueia por billing_status)
7. Testes ASAAS mock

### Bloco C — Performance fee (beta) + painel de valor (5-7 dias)

1. Serviço `PerformanceFeeService` (baseline, cálculo mensal, atribuição por driver)
2. Painel de Valor Gerado (Scale+)
3. Modo beta: mostra, não cobra
4. Consentimento de ativação de cobrança (checkbox + revogável)
5. Reconciliação com ASAAS (cobra taxa como fatura adicional)

### Bloco D — Consumo excedente + add-ons (2-3 dias)

1. Compra manual de pacote extra de IA (fatura avulsa via ASAAS)
2. Auto-recompra ao atingir 90% (opt-in)
3. Add-ons: contratação/cancelamento pela UI, cobrança na fatura mensal

**Total estimado:** 12-18 dias úteis de implementação (todos os 4 blocos).

Bloco A é pré-requisito de todos. Bloco B é pré-requisito de C e D.

## Testes

Cada Bloco terá seu script de teste:

- `test:plans-migration` — mapeamento de plano antigo → novo
- `test:asaas-webhook` — assinatura, dedup, reflexo em billing_status
- `test:performance-fee` — cálculo do ganho incremental, atribuição por driver
- `test:consumption-topup` — compra de pacote extra reflete em ai_monthly_limit

## Aprovação humana

Este ADR requer aprovação explícita do dono (Emerson) antes de eu começar o Bloco A. Alterações no modelo comercial afetam contrato, relacionamento com cliente e faturamento — não são reversíveis com um simples `git revert`.

Ao confirmar, o backlog `docs/BACKLOG-CAMPO-TOULON.md` item #1 é marcado como `[~] em implementação` e o Bloco A vira PR.
