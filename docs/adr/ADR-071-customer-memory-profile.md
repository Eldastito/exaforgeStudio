# ADR-071 — CustomerMemory + CustomerProfile — memória de relacionamento

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Um SaaS de atendimento que "esquece" o cliente a cada conversa é indistinguível de qualquer bot genérico de mercado. O `CustomerProfileService` já existia como base de CRM (temperatura, lead score, LTV) mas nasceu sem ADR; o `CustomerMemoryService` foi adicionado depois para dar à IA memória durável de conversas passadas (nome do pet, filho, aniversário, preferências) e reconhecer quem volta após um tempo parado. Juntos, são o diferencial competitivo — este documento fecha a lacuna.

---

## Contexto

O prompt da IA de atendimento (`AIOrchestratorService.ts:165` e `:172`) precisa de dois blocos de contexto de cliente injetados a cada resposta:

- **`profileLine()`** — uma linha densa de CRM: temperatura do lead (frio/morno/quente), lead score 0-100 com faixa, contagem de compras, ticket médio, dias desde a última compra, tags e sinais da IA comercial (probabilidade de compra, estágio de funil, objeção, dor, próximo passo). Recalculada em cada `touchContact` e em cada `recomputePurchaseStats` disparado por `OrdersService`/`PaymentService` (`OrdersService.ts:105,148`, `PaymentService.ts:391`, `webhookProcessor.ts:222,445,641`).
- **`memoryText()`** — bloco livre em português com dois campos por contato: `memory_facts` (fatos durÁveis extraídos por IA no fim da conversa) e `memory_summary` (resumo curto da última conversa). Além disso, se o cliente volta após N dias parado (`returningDays()`, chamado em `webhookProcessor.ts:212`), injeta uma instrução explícita para abrir com saudação calorosa de retorno.

Sem esses blocos a IA trata cada cliente como estranho. Com eles, o atendimento parece continuidade — que é o que muda a percepção de "bot" para "atende bem".

Temperatura e lead score são heurísticas transparentes e determinísticas (sem ML): recência de contato, recência de compra, frequência, LTV em faixas, e estágio do ticket aberto. Escolhidas para ser auditáveis pelo dono do negócio, não caixa-preta.

## Decisão

**`CustomerProfileService` (determinístico, sempre ligado):**

1. **Estado no `contacts`:** colunas `lead_temperature`, `lead_score`, `lead_score_updated_at`, `purchase_count`, `total_spent`, `avg_ticket`, `last_purchase_at`, `last_contact_at`. Recalculadas por `touchContact()`, `recomputePurchaseStats()` e `recomputeScore()` — cada mensagem recebida e cada pedido faturado dispara reavaliação.
2. **Temperatura por regras fixas:** quente se comprou nos últimos 30d **ou** interagiu ≤ 1d; morno se interagiu ≤ 7d **ou** já comprou; senão frio.
3. **Score 0-100 aditivo:** engajamento (≤25) + é comprador × frequência (≤35) + LTV em faixas (≤15) + recência de compra (≤15) + estágio do ticket aberto (≤20). Faixas: `alto ≥ 70`, `medio ≥ 40`, `baixo` abaixo.
4. **`profileLine()`** monta a linha injetada no prompt — inclui só o que faz sentido (não exibe "0 compras" como métrica ruim; troca por "ainda sem compras").

**`CustomerMemoryService` (opcional, LGPD-first):**

5. **Consentimento por org:** `organization_settings.ai_memory_enabled`, `returning_greeting_enabled`, `returning_greeting_min_days` (default 7d). Desligar zera `memoryText()` sem tocar no que está guardado.
6. **Extração ao fim da conversa:** `extractAndMerge()` é chamado pelo `Scheduler.ts:210` quando o ticket entra em idle. Manda o histórico + memória atual para o LLM com prompt estrito (fatos durÁveis, sem pagamentos, sem suposições, máximo 10 bullets) e resposta em JSON `{facts, summary}`.
7. **Merge, não append:** a memória atual é enviada junto para que o modelo consolide, atualize e deduplique — evita crescimento monotônico.
8. **Best-effort:** falha de LLM (`chat` lançou, JSON inválido, resposta vazia) apenas marca `memory_updated_at` para não reprocessar a mesma conversa; nunca quebra o fluxo do atendimento.
9. **Saudação de retorno:** `returningDays()` recebe o `last_contact_at` **anterior** ao `touchContact` desta mensagem, verifica se é ticket novo e se passou do `greetMinDays`. Se sim, `memoryText()` injeta instrução explícita ("abra com saudação, use UM detalhe da memória, NUNCA invente").
10. **Direito ao esquecimento:** `clear()` (`routes/contacts.ts:97`) apaga `memory_facts`, `memory_summary` e `memory_updated_at` do contato.

## Consequências

**Positivas:**
- IA de atendimento passa a "lembrar" com naturalidade — puxa o nome do pet, o filho, a preferência mencionada semanas atrás. É o que os testes de usuário identificam como "não parece bot".
- CRM sempre atualizado sem cron: cada interação relevante recalcula temperatura e score na hora, então segmentação e reativação leem estado fresco.
- Score determinístico e auditável — dono do negócio consegue explicar por que um lead está em 82 sem precisar entender ML.
- Retorno após ausência vira gancho conversacional em vez de reset de contexto.
- Memória e saudação são desligÁveis por org e apagÁveis por contato — conformidade LGPD sem retrabalho.

**Trade-offs aceitos:**
- **Extração pode alucinar fato falso.** O prompt pede "só o que o cliente disse", mas LLM sob temperatura 0.2 ainda inventa esporadicamente. Não há confidence score por bullet nem verificação cruzada contra o histórico — se um fato falso entra, só sai por revisão manual do operador ou `clear()`. Aceitável enquanto o bloco de memória é apresentado como "de conversas anteriores" e a IA é instruída a "NUNCA inventar detalhes que não estejam na memória" (ver `memoryText`).
- **Sem TTL automático.** Fatos ficam para sempre até alguém apagar. Um "aniversário em março" capturado hoje continuará no prompt daqui a 3 anos, mesmo que o cliente tenha corrigido depois. Rever se aparecer reclamação de "IA usando info velha".
- **Sem versionamento nem histórico de temperatura** — `recomputeTemperature` sobrescreve (já apontado no ADR-065). Não dá para reconstruir a trajetória do lead.
- **Score é heurística, não preditivo.** Faixas escolhidas por intuição de produto, não calibradas contra conversão real. Serve para priorizar atendimento, não para prever receita.
- **Custo de LLM na extração** — cada conversa que fecha faz uma chamada extra ao modelo. Silencioso no volume atual, revisitar se número de tickets/dia crescer 10×.
- **`profileLine()` cresce com o tempo** — sinais da IA comercial (ADR paralelo) já adicionam 5 campos. Sem limite, o prompt pode inflar. Aceitável enquanto o modelo suportar contexto largo.

## Testes

**Cobertura direta hoje: nenhuma.** Não existe `scripts/test-customer-memory-service.ts` nem `scripts/test-customer-profile-service.ts`. O comportamento é validado indiretamente pelos testes de webhook e de scheduler que exercitam `touchContact`, `recomputeScore` e `extractAndMerge` no caminho real.

**Lacunas honestas** que deveriam virar testes dedicados:

- **Profile:** faixas de temperatura nos limites (compra há exatamente 30d, contato há exatamente 7d); score determinístico dado um contato fixo; `recomputePurchaseStats` ignorando status não-faturados; `profileLine` degradando bem para contato sem nome/sem tags/sem sinais de IA.
- **Memory:** `returningDays` com `prevContactAt` nulo (primeiro contato = não é retorno), com `isNewConversation=false` (mesmo ticket = não é retorno), e nos limites do `greetMinDays`; `memoryText` vazio quando `ai_memory_enabled=false` mesmo com dados guardados; `extractAndMerge` com `chat` retornando JSON inválido (não pode explodir); `clear` idempotente.
- **Integração:** confirmar que `AIOrchestratorService` de fato injeta ambos os blocos no prompt final e que a ordem/rótulo esperados pelo modelo estão preservados.

Enquanto esses testes não existem, mudanças em qualquer heurística de score/temperatura ou no prompt de extração exigem inspeção manual dos 8 pontos de chamada listados no `grep -rn 'CustomerMemoryService\.\|CustomerProfileService\.' src/server`.
