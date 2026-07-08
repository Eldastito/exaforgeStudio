# ADR-059 — PlanService — enforcement de plano e billing

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit. Enforcement de plano é o que separa Starter de Pro de Business — sem isso, todo mundo usa tudo grátis. Retrofit documenta o que já está em `src/server/PlanService.ts` e é consumido por `AIOrchestratorService`, `StudioService`, `ModuleService` e as rotas `/api/plans/*`.

---

## Contexto

Cada plano em `plans.features` (JSON) declara limites: `ai_monthly_limit`, `contacts_limit`, `channels_limit`, `users_limit`, `studio_images_monthly`, `studio_videos_monthly`, `modules[]`. A org tem em `organization_settings`: `plan_id`, `billing_status` (`trialing | active | past_due | suspended | blocked | cancelled`) e `status` (bloqueio administrativo).

Sem enforcement, o Starter usaria a IA como se fosse Business — a diferença entre planos vira decorativa. Ao mesmo tempo, cortar sem aviso queima confiança: o cliente que atrasou 3 dias e teve o bot mudo é o cliente que cancela. O enforcement precisa ser **gentil** — transfere para humano com mensagem educada quando gasta o limite, avisa cedo (80%/90%/100%) via `getUsageAlerts`.

## Decisão

**Regras do PlanService:**

1. **`aiAllowed(orgId)`** retorna `{ allowed, reason }`. Consultado em `AIOrchestratorService.ts:134` antes de cada resposta gerada.
2. **`studioAllowed(orgId, kind)`** idem para Estúdio (imagens/vídeos), com contagem própria em `studio_creations` filtrando `status != 'error'`. Fallback via env `STUDIO_DEFAULT_IMAGES` / `STUDIO_DEFAULT_VIDEOS` (100/10) para não travar durante configuração de planos novos.
3. **Bloqueios em camadas separadas** e nessa ordem:
   - `org.status ∈ {blocked, cancelled}` → `reason: 'org_blocked'` (bloqueio administrativo).
   - `billing_status ∈ {blocked, cancelled, suspended}` → `reason: 'billing_blocked'` (inadimplência).
   - `ai_this_month >= plan.features.ai_monthly_limit` → `reason: 'monthly_limit'`.
   - Estúdio adiciona `plan_no_studio` quando `limit <= 0`.
4. **`past_due` NÃO bloqueia** — é sinal amarelo, notificado mas não corta o atendimento. Só `suspended`/`blocked`/`cancelled` cortam.
5. **Contagem mensal** via `datetime('now','start of month')` do SQLite — **UTC**, não horário BR.
6. **`modulesForPlan`** retorna `null` (plano sem `modules[]` = sem restrição) vs `[]` (plano lista vazia = tudo bloqueado). Semântica preservada por `ModuleService.isEnabled`.

## Consequências

**Positivas:**
- Upgrade path óbvio: `reason: 'monthly_limit'` vira CTA "faça upgrade" no cliente.
- Mensagens polidas — a IA transfere para humano no lugar de responder "erro".
- Alertas 80/90/100% em `getUsageAlerts` avisam antes de bater no teto.
- Separação `status` × `billing_status` permite bloqueio administrativo (fraude, TOS) independente de inadimplência.

**Trade-offs aceitos:**
- **Reset mensal em UTC** — cliente no fuso BR (UTC-3) tem o contador zerado às 21h locais do último dia do mês; quem gera muito conteúdo no fim de mês pode se surpreender com "sobrou/faltou" um dia. Aceito por simplicidade (SQLite `start of month` só suporta UTC); mitigado pelos alertas antecipados.
- **Sem atomicidade em picos** — `aiAllowed` faz `SELECT COUNT(*)` e depois a rota registra o log. Duas requests simultâneas exatamente no limite podem ambas passar (limite estoura em 1). Aceitável: o próximo request bloqueia e o overage de 1-2 unidades é irrelevante versus o custo de lock distribuído.
- **`getUsage` engole erro e devolve 0** — se a tabela `ai_interactions_log` sumir por bug de migration, o enforcement libera tudo. Aceito porque migrations são versionadas e o cenário de "tabela ausente em produção" é catastrófico independente disso.

## Testes

`scripts/test-plan-gating-autofill-alerts.ts` — **relevantes ao PlanService**:
- **Módulos por plano** (1.1–1.13): Starter/Business/Cortesia/sem-plano — `modulesForPlan` retorna `null` para plano sem `modules[]`; Starter não vê `radar`, Business sim.
- **Alertas de uso** (3.1–3.5): warning em 85%, critical em 95%, exceeded em 100%+ para `ai_monthly_limit`; org sem plano não gera alertas.

**Não coberto ainda** (gap conhecido): teste direto de `aiAllowed`/`studioAllowed` para os `reason` codes (`org_blocked`, `billing_blocked`, `monthly_limit`). Consumo end-to-end passa por `AIOrchestratorService` e é validado indireto via smoke de atendimento.
