# ADR-155 — Marketing Playbooks → IA de Produto do ZappFlow (Trilha B)

- **Status:** RASCUNHO — levantamento + plano fatiado. **Nenhuma fatia implementada.** ⏸️ **PAUSADO em 2026-08-08** (marcador "paramos aqui" — ver seção *Histórico*). Retomada aguarda decisão do dono da plataforma sobre qual fase priorizar.
- **Data:** 2026-08-08
- **Origem:** análise do repositório público `coreyhaines31/marketingskills` (licença MIT, v2.10.0 — ~49 *Agent Skills* de marketing em markdown, padrão agentskills.io, do Corey Haines) a pedido do dono da plataforma ("analise esse repositório e identifique como ele pode ajudar o nosso projeto"). A análise separou o valor em **3 trilhas**; este ADR executa a **Trilha B** (maior alavancagem) e documenta A e C como anexos.
- **Relacionadas:**
  - **ADR-152** (ZappFlow Execution Runtime) — os pilotos **Cobrança** (F4b.*) e **Recuperação Comercial** (F4c.*) são exatamente os módulos onde a IA **redige e sequencia** mensagens ao cliente; é a superfície que este ADR melhora.
  - **ADR-136** (Decision-Action Ledger / `business_signals`) — o detector de risco de churn publica **sinal dedupável**, nunca tabela própria de "alertas" (convenção nº 12).
  - **ADR-153** (Vertical Entitlements + Pricing + Upgrade Inteligente) — os playbooks de `pricing`/`offers`/`paywalls` informam a copy de recomendação de upgrade e a estrutura de plano; a Fase 5 (save offers) liga no downgrade path.
  - **ADR-154** (FalaTu Standalone + reembolso) — o `churn-prevention` (cancel flow + save offers) é o roteiro pra evoluir o cancelamento/reembolso self-service (hoje "hard cancel + refund") pra reter antes de devolver.
  - **ADR-130** (Governança de IA) — toda copy gerada por IA neste ADR continua passando pelos guardrails de governança; benchmark gringo não entra sem tradução.
  - **ADR-151** (FalaTu núcleo) — a memória/RAG (F5) é o molde do "doc de contexto canônico" da Trilha C.

## Contexto

O `marketingskills` é **conteúdo, não código plugável** — playbooks em markdown (`skills/<nome>/SKILL.md`) + tabelas de referência + templates de mensagem. Uma foundation skill (`product-marketing`) gera um `.agents/product-marketing.md` que **todas as outras leem antes de agir** (contexto único do negócio). Tem um diretório `tools/` com ~51 CLIs Node, mas de SaaS gringo (Stripe, Klaviyo, customer.io, Twilio, PostHog, GA4) — **não** do stack ZappFlow (Asaas/Evolution/WhatsApp/SQLite). Vira plugin do Claude Code via `/plugin`. Viés forte: inglês, SaaS PLG/B2B americano; benchmarks, canais e compliance precisam de tradução pra **Brasil / WhatsApp / LGPD**.

A análise separou o valor em três trilhas:

- **Trilha A — usar as skills pra *vender* o ZappFlow** (GTM meta): instalar o plugin dá ao time frameworks de `cro`/`copywriting`/`pricing`/`launch`/`cold-email`. Ganho real, baixo esforço, mas é sobre *vender o produto*, não construí-lo. → **Anexo A**.
- **Trilha B — minerar os playbooks pra melhorar a IA do *produto*** (este ADR): os playbooks batem quase 1:1 com os módulos que já redigem/sequenciam mensagens ao cliente (Cobrança, Recuperação, FalaTu enforcement/refund, upgrade recs). É onde o overlap com o código **já existente** é maior.
- **Trilha C — adotar o *padrão* `product-marketing.md`**: um doc de contexto canônico do negócio que todo redator de IA lê antes de compor. Pequeno habilitador que multiplica A e B. → **Anexo C**.

**Por que a Trilha B é a de maior alavancagem:** o ZappFlow já tem os *canais* (Runtime dispara WhatsApp, FalaTu responde), já tem a *governança* (ADR-130) e já tem o *ledger de decisão* (ADR-136). O que os playbooks entregam é o **conteúdo destilável** — cadência, timing, psicologia de mensagem, modelo de health-score — que hoje está implícito/ad-hoc nos prompts. Não é reescrever módulo: é **afiar prompt e template** com framework validado, de forma aditiva e medível.

### Mapa de overlap (playbook → módulo ZappFlow)

| Skill | Casa com | O que se extrai |
| --- | --- | --- |
| `churn-prevention` (dunning cadence) | Cobrança F4b.3 (cadência multi-tentativa + resend PIX) | Tabela Dia 0/3/7/10, escalada de tom, copy "não culpar", **soft vs hard decline** → retry diferenciado (PIX vs boleto) |
| `churn-prevention` (health score 0–100) | `business_signals` (ADR-136) + PlanFitDetector (ADR-153 F7) | Modelo de risco com pesos + sinais líderes → **novo detector publicando sinal** |
| `churn-prevention` (cancel + save offers) | FalaTu cancel/refund (ADR-154 F2.2 E) + downgrade (ADR-153) | Ladder desconto/pausa/downgrade **antes** do reembolso |
| `sms` + `emails` (lifecycle sequences) | Cadências WhatsApp (Cobrança / Recuperação / briefing) | Timing e estrutura de sequência → templates de prompt (canal WA tem regras próprias — o framework transfere, o canal não) |
| `copywriting` / `copy-editing` / `marketing-psychology` | Prompts que geram copy de saída | Frameworks pra endurecer os system prompts dos redatores |
| `pricing` / `offers` / `paywalls` | ADR-153 (upgrade recs + checkout FalaTu) | Packaging + padrões de paywall pra copy de recomendação |
| `referrals` | — (módulo inexistente) | Spec pronta pra um módulo de indicação/afiliado (Fase 6, opcional) |
| `analytics` / `ab-testing` | métricas + Runtime | Rigor pra A/B testar as próprias cadências |

## Decisão de arquitetura

**6 fases, ordenadas por dependência.** Cada fase se fatia em 1..N PRs draft → CI verde → merge → próxima (fluxo padrão do repo). Nada reescreve módulo: tudo é **aditivo** (novo template, novo detector, novo campo de flag) e **medível** (A/B via `business_signals`, nunca "achismo"). A Fase 1 é o habilitador (Trilha C); as demais consomem.

### Fase 1 — Base de playbooks versionada + doc de contexto canônico (habilitador / Trilha C)

Nada de novo em runtime. Cria a **fonte da verdade de copy** que as fases seguintes consomem:

- **`docs/playbooks/*.md`** — os frameworks relevantes (dunning cadence, save-offer ladder, health-score weights, sequence timing) **destilados e traduzidos pra PT-BR/WhatsApp/LGPD**, com atribuição ao `marketingskills` (MIT). NÃO é cópia literal — é adaptação ao contexto brasileiro (PIX/boleto, tom, opt-out LGPD, regras de template do WhatsApp).
- **Doc de contexto canônico por org** — formaliza o padrão `product-marketing.md`: um bloco de contexto de negócio (tom de voz, proposta de valor, restrições) que os redatores de IA (Cobrança/Recuperação/FalaTu) leem **antes** de compor. Reusa a superfície de memória do FalaTu (ADR-151 F5 / ADR-154 F5) — não inventa tabela nova; é um registro por org em `organization_settings` (`brand_voice_context TEXT`, opt-in).

**Fatias:** F1.1 destilar os 4 playbooks-núcleo em `docs/playbooks/` (PT-BR); F1.2 `brand_voice_context` + injeção no prompt dos redatores (flag `brand_voice_enabled` default off).

### Fase 2 — Tune-up da cadência + copy de Cobrança

Aplica `churn-prevention` (dunning) + `sms`/`emails` (timing) na Cobrança (ADR-152 F4b.3), que já tem cadência multi-tentativa. **Aditivo:** ajusta os templates/timings existentes e liga A/B.

- Cadência calibrada pela tabela do playbook (Dia 0/3/7/10 → traduzida pra realidade PIX/boleto), tom escalando sem culpar.
- **Soft vs hard decline**: falha de PIX (recuperável) e boleto vencido (precisa nova via) ganham estratégia de retry diferente — hoje é uniforme.
- **A/B via `business_signals`**: variante de copy marcada no sinal de envio; medição usa a régua de `revenue_recovered` real que já existe (ADR-152 F4b/4c).

**Guardrail:** nenhuma mudança de canal — WhatsApp mantém regras de template/opt-in próprias. Copy nova passa por ADR-130.

**Fatias:** F2.1 calibrar cadência/copy + flag de variante; F2.2 retry diferenciado soft/hard decline; F2.3 medição A/B no `business_signals`.

### Fase 3 — Tune-up da copy de Recuperação Comercial

Mesma mecânica da Fase 2 aplicada ao piloto Recuperação (ADR-152 F4c.*), usando `marketing-psychology` + `copywriting`. Reusa o opt-out LGPD (F4c.2) e o approval humano da cadência (F4c.3) — **nada se automatiza sem os gates que já existem**.

**Fatias:** F3.1 destilar frameworks de copy nos templates de recuperação; F3.2 A/B + medição.

### Fase 4 — `ChurnRiskDetector` → `business_signals`

Porta o **health-score 0–100** do `churn-prevention` (pesos + sinais líderes) pra um detector novo que **publica sinal** (`churn_risk_high`) no `business_signals` com `dedupe_key` — nunca tabela própria (convenção nº 12).

- Score **derivado por query** sobre sinais que já existem (pagamentos atrasados, silêncio no canal, uso caindo) — **nunca contador mutável** (RN-004).
- Explicabilidade rica (por que o score subiu), no molde do PlanFitDetector (ADR-153 F7.2).
- O sinal alimenta a operação (aba Operações do ExecutiveView, ADR-152 F3.2) e pode disparar cadência de retenção (Fase 5).

**Guardrail:** o detector **sugere**, humano decide — mesma régua RN-014 dos detectores existentes. Não cancela, não dá desconto sozinho.

**Fatias:** F4.1 `ChurnRiskDetectorService` + score derivado + sinal; F4.2 explicabilidade + card na aba Operações.

### Fase 5 — Save offers no cancel/refund do FalaTu

Evolui o cancelamento self-service do FalaTu (ADR-154 F2.2 E — hoje "hard cancel + reembolso") com o **cancel flow do `churn-prevention`**: antes de estornar, oferecer o **ladder** (pausa / downgrade / desconto por motivo), mapeando oferta→motivo. Liga no downgrade path da ADR-153.

- Fluxo: cliente pede cancelamento → captura motivo → oferece a save offer correspondente (pausar 1 mês / cair pro tier menor / cupom) → só vai pro reembolso se recusar.
- **Guardrails duros (money-critical, herdados da ADR-154 RN-E):** a garantia de 7 dias (CDC Art. 49) **nunca** é bloqueada por uma save offer — dentro da janela, o reembolso é direito e o botão continua acessível. Save offer é oferta, não fricção; a recusa leva ao reembolso no mesmo fluxo.
- Idempotência e "estorna antes de cancelar" da ADR-154 permanecem intocados.

**Fatias:** F5.1 captura de motivo + mapa oferta→motivo; F5.2 ladder pausa/downgrade/desconto ligando no entitlement (ADR-153); F5.3 medição de retenção (quantos aceitaram vs reembolsaram).

### Fase 6 — Módulo Referrals (opcional, net-new)

O `referrals` skill é spec pronta pra um módulo de indicação/afiliado que o ZappFlow **não tem**. Fora do caminho crítico da Trilha B (que é *melhorar o existente*); fica documentado como oportunidade, fatiado só se o dono priorizar.

## Guardrails RN-155 (duros, testados por fase)

A incorporação dos playbooks **nunca**:

1. **Importa benchmark/afirmação gringa sem tradução** — todo número, canal ou compliance vira Brasil/WhatsApp/LGPD antes de virar código (ex.: "email drip" → sequência WhatsApp com regras de template; "<2% B2B churn" → baseline medido no próprio dado).
2. **Automatiza outbound sem os gates que já existem** — opt-out LGPD (F4c.2), approval humano (F4c.3), opt-in de briefing (ADR-151 F6). Copy nova ≠ canal novo sem consentimento.
3. **Cria tabela própria de "alertas"** — risco de churn é `business_signal` com `dedupe_key` (convenção nº 12).
4. **Usa contador mutável** — score de churn e saldo de retenção são **derivados por query** (RN-004).
5. **Bloqueia a garantia de 7 dias com save offer** — dentro da janela o reembolso é direito (CDC Art. 49 / ADR-154 RN-E); oferta é opcional, recusa vai direto ao estorno.
6. **Gera copy fora da governança** — todo texto que a IA compõe passa por ADR-130; A/B é medido, não "achado".
7. **Copia conteúdo MIT literal** — os playbooks são **adaptados** ao contexto ZappFlow com atribuição em `docs/playbooks/`, não colados.

## Retrocompatibilidade

100% aditivo. Nenhuma cadência existente muda sem flag de variante (`brand_voice_enabled`, flags de A/B — todas default off). Detector de churn é observador puro (só publica sinal). Save offers são um passo **opcional** antes de um fluxo de reembolso que continua funcionando exatamente como na ADR-154. Nenhuma coluna renomeada; aditivos no fim do `db.ts` (convenção nº 2).

## Riscos & mitigações

- **Risco: "marketing gringo" descolado da realidade BR.** → Mitigação: Fase 1 traduz *antes* de qualquer runtime; nada entra sem passar por PT-BR/WhatsApp/LGPD.
- **Risco: over-automação de outbound irritar cliente.** → Mitigação: RN-155 §2 amarra tudo nos gates de consentimento existentes; A/B mede reação, não só conversão.
- **Risco: save offer virar dark pattern na garantia.** → Mitigação: RN-155 §5 (reembolso é direito na janela) + teste.
- **Risco: dependência de update externo se instalar o plugin vivo (Trilha A).** → Mitigação: Trilha B **não** depende do plugin em runtime — os playbooks viram `docs/` internos, versionados no próprio repo.

---

## Anexo A — Trilha A (GTM, paralelo, fora do escopo de fatias deste ADR)

Instalar o `marketingskills` como plugin do Claude Code (`/plugin`) dá ao time frameworks de `cro`, `copywriting`, `pricing`, `landing`/`seo`, `cold-email`, `launch`, `sales-enablement` sob demanda — pra **vender** o ZappFlow. Baixo esforço; saída em inglês/PLG a localizar. É win de go-to-market, não toca o produto — por isso fica como anexo, não como fase.

## Anexo C — Trilha C (padrão `product-marketing.md`)

Absorvida como **Fase 1** deste ADR (doc de contexto canônico por org). Registrada aqui como origem conceitual: a ideia de "um contexto de negócio que todo redator de IA lê antes de compor" vem da foundation skill do repo.

## Licença & atribuição

`coreyhaines31/marketingskills` é **MIT** — adaptação de conteúdo para os prompts/docs do ZappFlow é permitida. Todo `docs/playbooks/*.md` derivado credita a origem no header. Os CLIs `tools/` (SaaS gringo) **não** são reusados — servem só como referência de formato.

## Histórico

- **2026-08-08** — ADR criado (levantamento + plano fatiado da Trilha B). **⏸️ Trabalho pausado aqui a pedido do dono da plataforma** para priorizar a análise e instalação da ferramenta `code-review-graph` (`tirth8205/code-review-graph`) no projeto. Nenhuma fatia deste ADR foi iniciada. Retomar por F1.1 quando repriorizado.
