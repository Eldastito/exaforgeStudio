# ADR-130 — Governança de IA (a camada que decide o go-live)

- **Status:** Implementada (política consolidada + guardrail de viés + auditoria de decisão + teste)
- **Data:** 2026-07
- **Origem:** provocação de campo (Isabela Inolet): "IA agêntica não é projeto de tecnologia, é projeto de governança que usa tecnologia." A camada de **infraestrutura agêntica** (conformidade, LGPD, **auditoria de decisão**, "o que acontece quando o agente erra", **controle de viés**) não pode ficar na borda — é ela que decide se o agente vai a produção.
- **Relacionadas:** LGPD (`LgpdService`), auditoria (`ai_interactions_log`, `auth_audit_logs`), ADR-091 §6 (IA sugere, humano decide), ADR-113 (lista negra sugerida), ADR-114/125/126 (Impact Ledger e recomendações auditáveis), ADR-095 (RBAC), Radar de Manipulação (ADR-050).

## Contexto

O ZappFlow já tratava governança como camada **central** (não opcional): auditoria em toda mutação, aprovação humana em ação sensível, isolamento multi-tenant testado, kill-switch por billing. O que faltava era **tornar explícito e testável o controle de viés** e **consolidar** os controles numa política única — para que a governança não fique "na borda do diagrama".

## Decisões

### D1 — Política de Governança de IA como fonte única
`AiGovernanceService.policy()` publica os **princípios** e os **controles vigentes** por área (LGPD, auditoria de decisão, erro do agente, viés/dignidade, isolamento/escala, ética). Exposta em `GET /api/ai-governance` para a UI/onboarding mostrar — governança visível, não escondida.

### D2 — Sugestão que AFETA PESSOA nunca executa sozinha (guardrail de viés)
Sugestões de IA que afetam pessoas ficam num **registro explícito** (`PEOPLE_AFFECTING`): lista negra de fiado, limite de crédito, segmentação de prospecção. Para cada uma:
- a IA **apenas sugere**; **aplicar** exige **ator humano + motivo** (`guardApplied` lança `human_decision_required` se faltar);
- a base legítima é **comportamento/critério de negócio** (ex.: dias em atraso), **nunca característica pessoal**;
- a decisão é **auditada** em `ai_decisions` (kind, sujeito, decisão, quem sugeriu, ator, motivo).

Fluxos ligados:
- **Lista negra do fiado** — o dono informa o motivo (registrado); a sugestão da IA (`blacklistSuggested`) é marcada como `suggested_by=ai`, mas só o humano aplica.
- **Limite de crédito do fiado** (`fiado_limit`) — definir o limite afeta a pessoa; a IA sugere (orientativo), o dono define o valor com **motivo registrado**, baseado no histórico de pagamento (não em perfil).
- **Suspensão total de vendas** (`fiado_block_all`) — cortar TODAS as vendas (inclusive à vista) é a medida mais severa (mais forte que a lista negra); exige **humano + motivo**, é auditada e reversível.
- **Aprovação de prospecção antes do 1º contato** — aprovar uma abordagem (`ProspectService.setOutreachStatus → "approved"`) é a decisão que autoriza o **primeiro contato** com uma pessoa. O alvo e a mensagem são sugeridos pela IA (`suggested_by=ai`); aprovar exige **humano + motivo** (o guardrail barra antes de qualquer mutação) e a decisão é auditada em `ai_decisions`.

### D2b — Trilha de reabilitação (o último item do checklist de fairness)
"A pessoa afetada pode ser revista/reabilitada?" deixa de ser só uma pergunta: `rehabilitationDue(orgId, dias)` lista, de forma determinística, as restrições ainda **ativas** (lista negra, suspensão total) cuja última decisão é `applied` sem reversão posterior e que já duram mais de N dias (padrão 30). O painel de Governança mostra essas revisões pendentes — um lembrete para o dono revisar bloqueios antigos e reabilitar quem já pode voltar. Limite de crédito **não** entra (ajustar valor não é um bloqueio a ser revisto).

### D3 — Auditoria de decisão de ponta a ponta
Além do `ai_interactions_log` (prompt/resposta/**confiança**/**needs_human**) e do `auth_audit_logs`, `ai_decisions` fecha o rastro do que a IA sugeriu × o que o humano decidiu × por quê. Junto com o Impact Ledger (esperado × realizado), cobre "o que acontece quando o agente erra": nada sensível anda sem decisão humana registrada.

### D4 — Frugal e multi-tenant
Determinístico (zero-token); isolado por `organization_id`. O guardrail é uma verificação barata no boundary das ações sensíveis.

## Consequências
**Positivas:** transforma controles ad hoc numa camada explícita e testável; o controle de viés deixa de ser implícito; a governança fica visível (política publicável) e auditável (decisões registradas com motivo); alinha o produto à tese "governança primeiro".

**Trade-offs:** aplicar uma decisão que afeta pessoa passa a exigir motivo (pequena fricção deliberada — é o ponto); o registro `PEOPLE_AFFECTING` precisa crescer conforme novas sugestões que afetam pessoas surgirem (é o lugar certo para isso).

## Guardas
- IA sugere, humano decide; sensível **nunca** executa sozinho (ADR-091 §6).
- Decisão que afeta pessoa: **humano + motivo obrigatórios**, base = comportamento, **auditada**.
- Determinístico, isolado por `organization_id`.

## Testes
`test:ai-governance` — guardrail lança `human_decision_required` ao aplicar sugestão que afeta pessoa sem humano/motivo; permite com humano+motivo; `dismissed` e tipos que não afetam pessoa não travam; a decisão é auditada em `ai_decisions` com o motivo; a política lista os controles e o checklist de fairness; isolamento por org.
