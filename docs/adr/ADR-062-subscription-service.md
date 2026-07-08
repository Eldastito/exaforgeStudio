# ADR-062 — SubscriptionService — mensalidade do cliente do lojista

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Academia, escola de idiomas, clube de assinatura, condomínio, coworking — modelos recorrentes B2C cabem no ZappFlow como assinaturas do CLIENTE do lojista. O serviço nasceu para atender esses verticais e ficou sem ADR; este documento fecha a lacuna e, sobretudo, cristaliza a diferença conceitual com `PlanService` (ADR-059).

---

## Contexto

**Não confundir com `PlanService` (ADR-059).** São dois eixos ortogonais de recorrência no ZappFlow:

- `PlanService` / `plans` → **plano do LOJISTA no SaaS**. É o quanto a organização paga à ExaForge (Starter/Pro/Enterprise), gating de features, limites de MAU. Cobrado pela ExaForge.
- `SubscriptionService` / `subscription_plans` + `subscriptions` + `subscription_invoices` → **mensalidade que o CLIENTE FINAL paga ao lojista**. É produto do lojista (matrícula da academia, mensalidade da escola, clube de vinhos). Cobrado pela org via PIX.

Um lojista Pro (plano ExaForge) pode ter 800 assinaturas ativas de clientes finais (mensalidade do lojista). São coisas distintas em tabelas, código, cobrança e ADR.

O que o serviço precisa cobrir:
- CRUD de `subscription_plans` (nome, valor, `interval` ∈ `monthly|weekly|yearly`, `interval_count`).
- Ciclo de vida da `subscriptions`: `active` → `past_due` (fatura vencida) → volta pra `active` quando paga, `paused` (cliente pediu pausa), `cancelled` (encerrada).
- Faturas (`subscription_invoices`) geradas ciclo a ciclo pelo Scheduler (Fase 2B-2), com `status` ∈ `pending|paid|overdue` e `charge_ref` para não reenviar PIX.
- Ganchos para a IA responder o cliente com dados reais (sem alucinar valor) e para o cliente **executar** ações via WhatsApp (assinar, pagar, cancelar, pausar).
- Portal de autoatendimento assinado por HMAC (24h) enviado por link no WhatsApp, para o cliente ver faturas sem login.

## Decisão

**Regras invioláveis do `SubscriptionService`:**

1. **Isolamento por `organization_id` em toda query.** Sem exceção — inclusive nas rotas do portal público, que só chegam ao serviço depois de validar o token HMAC. O `orgId` do token é a fonte da verdade, nunca vem do corpo da requisição.
2. **Relógio da assinatura em `next_charge_at`.** É o Scheduler que decide "hoje toca fatura" comparando `next_charge_at <= now`. `generateInvoice` cria a fatura do período **e** avança `next_charge_at` para `period_end` — atomicamente na mesma rota, evitando dupla cobrança se o Scheduler rodar duas vezes no mesmo minuto. Reforço adicional: dedup por `(subscription_id, status='pending', period_start)`.
3. **`invoice.status` é a única fonte de verdade da inadimplência.** `pending` (recém-gerada, PIX podendo já ter sido enviado — `charge_ref`), `paid` (pago, reativa `subscription.status` se estava `past_due`), `overdue` (o Scheduler marca X dias após `due_date` e coloca a assinatura em `past_due`). Não temos `failed` — PIX não "falha", só não é pago.
4. **Integração com IA (`AIOrchestratorService.ts:267-296`)** — o orquestrador injeta no prompt:
   - Se há assinatura ativa: valor, próxima cobrança, fatura em aberto (se houver) com vencimento. A IA **responde** "quanto devo?"/"estou em dia?" com esses dados e NÃO inventa valor.
   - Sinais de ação que só a IA seta e o backend executa: `send_subscription_pix` (dispara PIX da `openInvoiceForContact`), `subscribe_customer` (nome exato do plano — `subscribe` + `generateInvoice`), `cancel_subscription` (`setStatus 'cancelled'`), `pause_subscription` (`setStatus 'paused'`). Ver `webhookProcessor.ts:743-799`.
5. **Troca de plano com proration linear em dias** (`changePlan`): crédito = `amount * (dias_restantes / duração_do_ciclo)`, subtraído da próxima fatura pendente. Simples e explicável ao cliente; não é aritmética financeira sofisticada.
6. **Portal HMAC-SHA256** — payload `orgId:contactId:expiresAt` assinado com `JWT_SECRET`, base64url + 32 hex chars de assinatura, validação com `timingSafeEqual`. Link enviado por WhatsApp com validade de 24h. Sem sessão, sem cookie, sem login.

## Consequências

**Positivas:**
- Um único serviço cobre academia, escola, clube, condomínio — verticais recorrentes entram no ZappFlow sem código novo.
- IA para de mentir sobre valor de mensalidade (era o pior UX possível): agora fala o que tem no banco ou não fala.
- Cliente resolve mensalidade dentro do WhatsApp — pagar, cancelar, pausar, ver faturas via link do portal — sem virar chamado pro lojista.
- Scheduler + `next_charge_at` desacoplam completamente a geração de fatura da cobrança (`setInvoiceCharged`) e do pagamento (`markInvoicePaid`) — cada etapa é idempotente e observável.

**Trade-offs aceitos:**
- **Sem retry automático do PIX.** Se o envio da mensagem com o PIX falhar, `charge_ref` não é setado e o Scheduler tenta de novo no próximo ciclo — mas não há back-off por hora. Cliente pode ficar até 24h sem receber o PIX de novo. Aceitável para PIX (o cliente pode pedir na hora).
- **Sem dunning multicanal.** Só WhatsApp. Sem SMS/e-mail de aviso de vencimento, sem escalonamento pra cobrança humana. O status `past_due` fica no banco esperando alguém olhar o painel; não há job que reenvia cobrança X dias após `overdue`.
- **Sem cartão recorrente.** Só PIX manual, gerado por fatura. Charge-back involuntário por cartão vencido não existe porque cartão não existe; taxa de churn por esquecimento existe e é do lojista gerenciar.
- **Cancelamento sem penalidade nem fidelidade.** `setStatus 'cancelled'` é imediato, não há multa proporcional, não há retenção obrigatória. Trade-off explícito: o produto do lojista precisa reter pelo valor, não pelo contrato.
- **Proration só na troca de plano, não no cancelamento.** Cliente que cancela no meio do ciclo com fatura já paga não recebe crédito. Documentado como comportamento, não bug.
- **Portal HMAC sem revogação.** Um token de 24h vazado é válido por 24h — não há tabela de tokens revogados. Mitigação: janela curta e escopo estreito (só leitura de faturas + marcar como pago manualmente).

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-subscription-service.ts` nem `scripts/test-subscription-*.ts`. O que existe adjacente:

- `scripts/test-invoice-scan.ts` — exercita o scan de faturas de vendas (comprovantes anexados no WhatsApp), não toca em `subscription_invoices`. Nome parecido, escopo diferente.
- `scripts/test-plan-gating-autofill-alerts.ts` — testa gating do `PlanService` (ADR-059, plano do LOJISTA no SaaS). Confirma que os dois eixos existem e são testados separadamente; não cobre este serviço.

**Lacunas honestas** que devem virar `scripts/test-subscription-service.ts`:
- Ciclo completo: criar plano → `subscribe` → `generateInvoice` avança `next_charge_at` e não duplica no mesmo período → `markInvoicePaid` reativa `past_due` → `markOverdue` marca inadimplência corretamente.
- `addInterval` para `monthly` em final de mês (31/jan → 28/fev), `weekly × interval_count > 1`, `yearly` em bissexto.
- `changePlan` com proration: ciclo no meio, crédito bate com `(dias_restantes / total) * amount`; fatura pendente é ajustada, não duplicada.
- Portal HMAC: token válido decodifica, token expirado retorna `null`, assinatura adulterada retorna `null`, `timingSafeEqual` protege contra timing attack.
- Isolamento por `organization_id`: chamar qualquer método com `orgId` errado nunca vaza dado da outra org.
- Integração IA: dado um contato com fatura em aberto, o texto injetado contém valor real; sem fatura, contém "está em dia"; sem assinatura, lista planos ativos.

Enquanto esses testes não existirem, qualquer mudança neste serviço exige revisão manual das 5 rotas consumidoras (`AIOrchestratorService`, `webhookProcessor`, `Scheduler`, `PaymentService`, `routes/subscriptions` + `routes/subscriptionPublic`).
