# ADR-153 — Decisões pendentes do dono do produto

**Autor:** Claude (IA Dev). **Data:** 2026-08-04.

Cada decisão abaixo BLOQUEIA uma ou mais fatias do plano (`PLANO-DE-IMPLEMENTACAO.md`). Formato: contexto → opções → recomendação → impacto de decidir.

---

## §A — Grade de planos

### Decisão #1 — Comigo persistente vs Add-on ✅ **APROVADA 2026-08-04: Opção A (persistente)** | ✅ **IMPLEMENTADA em F2.1 (PR #TBD)**

**Contexto (PRD §8.1):** hoje `copiloto` só está em `AUTONOMO` (`plansGrade.ts:16`). Upgrade Autônomo→Start remove o balcão da peixaria/chaveiro sem aviso. É o risco de maior impacto no PRD.

**Opções:**

- **A — Comigo persistente em todos os planos.** Adiciona `copiloto` em START/GROWTH/SCALE/ENTERPRISE. Comercialmente "produto base do ZappFlow."
- **B — Comigo vira add-on obrigatório (grandfathering).** Quem tinha Autônomo com Comigo ativo mantém como add-on gratuito ao migrar. Novos planos sem Comigo cobram add-on separado (R$X/mês).

**Análise:** Opção A é menos código, sem UI de contratação, sem risco de erro. Opção B é comercialmente mais flexível se um dia quisermos monetizar Comigo separadamente (hoje é grátis, mas cobre 30-40% do valor percebido).

**Recomendação:** **Opção A.** Se um dia quiser cobrar por Comigo, modelo add-on já existe pra outras coisas (`AddonService`), migração posterior é possível. Prioridade agora = eliminar risco de perda no upgrade.

**Bloqueia:** F2.1.

---

### Decisão #2 — Terms of Service versionado

**Contexto (PRD §27):** hoje não existe `terms_accepted_at` em `organization_settings`. Nenhuma trilha de aceite. Vender assinatura recorrente sem contrato aceito = risco jurídico + LGPD.

**Opções:**

- **A — Contratar assessoria jurídica agora, publicar v1 do ToS, integrar no signup + checkout com hash+versão.**
- **B — Postergar; assumir risco calculado; usar termos genéricos do site institucional (não versionados) por enquanto.**
- **C — Adotar template público (ex.: consulta contratual de tech), personalizar e usar como v1 até jurídico revisar.**

**Recomendação:** **A.** Sem contrato aceito, cada disputa comercial é indefensável. F5.1 (Terms) é bloqueio duro no PLANO — sem essa decisão, F5 inteira não avança.

**Impacto:** define timeline de F5. Se A demora >30 dias, considerar C como bridge.

**Bloqueia:** F5.1 → F5.2 → F5.3 → toda F6.

---

### Decisão #3 — HMAC assinado no webhook Asaas

**Contexto (Análise §5):** hoje `AsaasService.handleWebhook` autentica por token estático no header (`asaas-access-token`). Constant-time comparison, mas não é assinatura HMAC. Asaas Sandbox suporta, produção também.

**Opções:**

- **A — Migrar pra HMAC agora (F5.2 na mesma fatia).** Adiciona ~30min de código; substitui `safeEqual(token)` por `verifyHmac(rawBody, signature, secret)`.
- **B — Manter token estático + rotação trimestral do `ASAAS_WEBHOOK_TOKEN`.**

**Recomendação:** **A.** É baixo custo pra fechar o risco.

**Bloqueia:** F5.2 (pode entrar como fatia adjacente).

---

## §B — Blueprint

### Decisão #4 — Nome dos primeiros 5 Blueprints (SKUs) ✅ **APROVADA + IMPLEMENTADA em F3.2 (nomes do PRD aceitos verbatim)**

**Contexto (PRD §9.1/§10):** blueprints são o SKU comercial vendido. Nome vira label no marketing, no checkout, no site. **Uma vez publicado, é imutável** — mudar depois exige v2 + migração.

**Sugeridos pelo PRD:**
- `moda_loja_unica_v1` → label comercial "ZappFlow Moda"
- `moda_rede_lojas_v1` → "ZappFlow Moda Rede"
- `clinica_multiespecialidades_v1` → "ZappFlow Clínica"
- `chaveiro_autonomo_v1` → "ZappFlow Chaveiro"
- `peixaria_balcao_peso_v1` → "ZappFlow Peixaria"

**Opções:**
- **A — Aceitar os nomes do PRD verbatim.**
- **B — Redefinir com marketing (nomes mais quentes: "Balcão Pro" pro Chaveiro, "Clínica Multi" pra Clínica).**
- **C — Começar com 2 (TOULON + peixaria) e evoluir.**

**Recomendação:** **A + começar com 2 (chaveiro + peixaria) pra validar o mecanismo, adicionar os outros conforme rollout.** Chaveiro e peixaria já têm orgs de referência (`seed-reference-autonomos.ts`) — validam Fase 3 sem inventar dados.

**Bloqueia:** F3.2, F8.2, F8.3.

---

### Decisão #5 — Blueprint da Clínica: bundle `Growth + Clínica` ou plano dedicado? ✅ **APROVADA + IMPLEMENTADA em F2.2 (bundle catálogo)**

**Contexto (PRD §10.3):** módulo `clinica` só existe no plano Enterprise hoje (`plansGrade.ts:20`). Uma clínica média não paga Enterprise. PRD sugere bundle `Growth ou Scale + add-on Clínica`.

**Opções:**

- **A — Bundle: `defaultPlan='growth'` + add-on `clinica` incluído. Add-on tem preço R$0 dentro do bundle, R$Y avulso.**
- **B — Novo plano `clinica_pro` (R$X/mês) que inclui `clinica` + limites customizados.**
- **C — Manter Enterprise-only e vender Enterprise pra Clínica.**

**Recomendação:** **A.** Bundle já é modelo comum (Netflix + Netflix Games, iCloud+, etc.), reusa `AddonService`, expressível no `SubscriptionOrchestratorService` sem inventar `plan` novo.

**Bloqueia:** F2.2, F3.2 (blueprint Clínica precisa do bundle definido).

---

### Decisão #6 — Master Admin pode migrar org de v1→v2 forçadamente?

**Contexto (Análise §3.3):** blueprint imutável significa `clinica_v2` (com `vms` adicionado nos optionals) precisa ser assign explícito. Master Admin decide?

**Opções:**

- **A — Master Admin migra sem consentimento (é atualização de "produto" — como release novo do iOS).**
- **B — Master Admin apenas propõe; dono do lojista aprova via clique na tela `Plano e Expansões`.**
- **C — Migração é sempre automática no login (dono descobre pelo release note).**

**Recomendação:** **B.** Quer que a mudança seja consentida (mesmo em release não-quebrante). Se for adição pura (só novos optional_modules, nenhuma remoção), o preview é auto-aceitável. Se envolver remoção/changed, o dono clica.

**Bloqueia:** F3.3.

---

## §C — Recomendação

### Decisão #7 — Frequência mínima entre recomendações

**Contexto (PRD §15):** "não exibir mais de uma vez por 30 dias para o mesmo plano."

**Refinamento necessário:**
- Recomendação Autônomo→Growth rejeitada → volta em 30 dias? Ou 60? Ou 90?
- Recomendação Autônomo→Start rejeitada, evidência muda pra Autônomo→Growth (limite outro) — conta como plano novo?
- Trial expirado (past_due): recomendar upgrade ou esperar dono estabilizar?

**Opções:**

- **A — Regra dura: 30d por `target_plan_id`. Trials expirados: NÃO recomendar até `billing_status='active'`.**
- **B — Regra adaptativa: se score cai <15 do último, silencia mais 30d; se score sobe >20, permite ofertar em 15d.**
- **C — Cooldown crescente: 1ª rejeição = 30d, 2ª = 90d, 3ª = 180d.**

**Recomendação:** **A + C combinadas.** Regra simples (A) + progressão dura em caso de N rejeições (C).

**Bloqueia:** F7.3.

---

### Decisão #8 — IA cita recomendação no Executive Chat espontaneamente ou só se dono pergunta?

**Contexto (PRD §12/§18.2):** limite entre "sugestão comercial legítima" e "pressão de venda."

**Opções:**

- **A — IA só menciona quando dono pergunta explicitamente ("como está minha operação?" ou "faz sentido eu pagar mais?"). Sinal `plan_near_limit_ai` fica no painel `Plano e Expansões`, invisível no chat livre.**
- **B — IA cita spontaneamente uma vez por sessão quando score ≥ 90.**
- **C — IA menciona sempre no início do briefing diário (§32 padrão FalaTu digest).**

**Recomendação:** **A.** Regra "IA recomenda, cliente decide" (§5.4) — spontaneous no chat livre soa pressão. O painel `Plano e Expansões` já é visível o suficiente.

**Bloqueia:** F7.5.

---

## §D — Operação

### Decisão #9 — Downgrade: dias de carência antes de virar read_only?

**Contexto (PRD §23):** downgrade entra no próximo ciclo. Módulos removidos viram `read_only`. Quantos dias o dono tem pra exportar dados antes do read_only virar hidden?

**Opções:**

- **A — Read_only permanente (nunca vira hidden). Dados sempre visíveis mesmo sem plano.**
- **B — 30 dias em read_only, depois hidden mas dados preservados no DB (dono pode reativar).**
- **C — Read_only + botão "Exportar dados" (CSV/JSON) durante 90 dias, depois anonymize + delete.**

**Recomendação:** **B com badge "Reative pra editar".** LGPD exige preservação de dados por período proporcional; 30 dias em read_only + hidden com preservação atende sem inflar UX indefinidamente.

**Bloqueia:** F4.3, F6.2.

---

### Decisão #10 — Signup: escolher Blueprint no onboarding ou depois?

**Contexto:** hoje `OnboardingView` (`src/features/OnboardingView.tsx`) pergunta vertical em passo 2. Com blueprints, isso vira "escolher produto".

**Opções:**

- **A — Signup passa a mostrar cards de Blueprint (não mais de vertical genérica). Dono escolhe SKU direto.**
- **B — Signup mantém vertical genérica (compatível); Blueprint é inferido depois pelo Master Admin ou por wizard pós-signup.**
- **C — Signup pergunta vertical + N perguntas (multi-loja? venda por peso? agendamento?) → sistema sugere Blueprint.**

**Recomendação:** **C.** Mais alinhado com "vender produto certo" — evita dono escolher Blueprint errado por não saber diferença.

**Bloqueia:** F3.2 (parcialmente — pode ser adiado pra F8.4).

---

## Resumo

| # | Bloqueia | Prioridade | Recomendação |
|---|---|---|---|
| 1 (Comigo) | F2.1 | ✅ **APROVADA + IMPLEMENTADA** | Opção A (persistente em todos os planos) — F2.1 |
| 2 (ToS) | F5.1 → F5-6 | Máxima | Opção A (jurídico) |
| 3 (HMAC) | F5.2 | Alta | Opção A (migrar) |
| 4 (Nomes Blueprint) | F3.2, F8.2-3 | ✅ **APROVADA + IMPLEMENTADA** | Opção A (nomes do PRD): moda_loja_unica, moda_rede_lojas, clinica_multiespecialidades, chaveiro_autonomo, peixaria_balcao_peso (todos v1) — F3.2 |
| 5 (Bundle Clínica) | F2.2, F3.2 | ✅ **APROVADA + IMPLEMENTADA (F2.2 catálogo)** | Opção A (bundle Growth+addon Clínica) — F3.2 amarra ao blueprint clinica_multi_v1 |
| 6 (Migração v1→v2) | F3.3 | Média | Opção B (proposta + aprovação) |
| 7 (Frequência) | F7.3 | Média | A + C combinadas |
| 8 (IA cita?) | F7.5 | Média | Opção A (só quando perguntado) |
| 9 (Read-only carência) | F4.3, F6.2 | Alta | Opção B (30d) |
| 10 (Signup Blueprint) | F3.2 opc | Baixa | Opção C (wizard) |

**Bloqueia F1 (base):** nenhuma. F1 pode começar imediatamente — só depende do dono aprovar iniciar o rollout.

**Bloqueia F5 completa:** #2 (ToS). Sem parecer jurídico, sem checkout comercial completo.

**Bloqueia F8 (vendas em escala):** todas.
