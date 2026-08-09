# ADR-159 — Choke-point único de execução externa + hardening de governança e Autonomy Contract (evolui ADR-136/152; RBAC ADR-138)

- **Status:** **PROPOSTA** — Onda 0 do programa ZEI (trilha paralela à ADR-158). Nenhuma fatia implementada ainda; este documento fixa o desenho antes do código.
- **Data:** 2026-08-09
- **Origem:** `PRD 0 — ZapFlow Execution Intelligence` (§16-19, §29-32, §49) + `ZAPFLOW — ESTADO FINAL ESPERADO` (§16-19, §52, §64-66); auditoria em `docs/prd/ANALISE-ESTADO-FINAL-vs-REPO.md` §4-5.
- **Relacionadas:** ADR-136 (Decision & Action Ledger, `agent_policies`), ADR-152 (Runtime, CommandExecutor), ADR-138 (RBAC financeiro), ADR-130 (Governança de IA), ADR-056 (LGPD). CLAUDE.md convenções nº 1, nº 7, nº 8, nº 10.

---

## Contexto

O programa vai **subir a autonomia** da IA (rumo ao Nível 4 — executar dentro de política). O Estado Final §16 é explícito: **"quanto maior a autonomia, maior deve ser o controle."** A auditoria encontrou buracos concretos na base de governança que precisam fechar **antes** de ampliar execução autônoma:

1. **Não há choke-point único de execução externa.** Existem ≥3 caminhos para efeito externo: `CommandExecutor.execute` (governado), `CollectionCadenceService` (envia cobrança fora do runner) e handlers chamando `MessageProvider`/`Asaas` direto. Efeito externo que não passa por um ponto governado é risco não-auditado.
2. **RBAC granular é opt-in** — só age com `role_profile_id` atribuído; o parque legado passa sem gating (privilege-por-omissão).
3. **Bug no two-step approval** — `routes/actions.ts` conta `DISTINCT COALESCE(approver_user_id,'?')`: aprovadores sem id colapsam num só, permitindo burlar a exigência de 2 pessoas. Além disso a rota usa `req.user.role` legado, não o RBAC granular.
4. **Policy só tem teto único** (`max_auto_amount`); faltam **bandas valor→papel** (desconto/compra/reembolso) e o estado **"escalonar"**.
5. **Progressive autonomy inexiste** — nada realimenta `agent_policies` por evidência.
6. **Sem `correlationId`, sem step-up MFA em ação crítica, sem detecção de anomalia.** (O correlationId é entregue na ADR-158 F1.)

Evolui o que existe (`agent_policies`, `ApprovalPolicyService`, `CommandExecutorService`) para um **modelo único de governança** — sem engine paralelo (PRD 0 §6, §54).

---

## Decisões (propostas, a fatiar)

### D1 — Choke-point único de execução externa

Todo efeito externo (mensagem, cobrança, escrita em sistema de terceiro) passa **obrigatoriamente** por `CommandExecutor.execute` (guardas G1-G3 + policy + idempotência + `action_execution_log`). `CollectionCadenceService` e handlers que hoje chamam providers direto são reencaminhados para o executor. Meta: **um** ponto de auditoria/idempotência/rate-limit, carregando o `correlationId` (ADR-158) em cada tentativa.

### D2 — Correção dos riscos de aprovação (prioridade de segurança)

- Two-step passa a exigir **2 aprovadores com `user_id` não-nulo e distintos** (rejeita aprovação sem identidade); nunca colapsar via `COALESCE`.
- Aprovação valida **RBAC granular** (perfil/permissão de módulo), não `users.role` legado.

### D3 — RBAC deixa de ser silenciosamente opt-in

Caminho de migração para **default-deny** em ações sensíveis quando não há perfil resolvido (em vez de passar livre). Faseado e observável para não quebrar orgs legadas (feature flag + relatório de impacto antes de virar a chave).

### D4 — Políticas contextuais com bandas valor→papel + estado "escalonar"

`agent_policies` ganha faixas parametrizadas (ex.: desconto 0-5% automático / 5-10% gerente / >10% proprietário; compra até R$2k automática / R$2k-5k gerente / >R$5k diretor). Os **4 estados** do Autonomy Contract passam a existir de fato: **permitido / requer aprovação / bloqueado / escalonar**. Ações financeiras/destrutivas: **default deny** (PRD 0 §49).

### D5 — Progressive autonomy por evidência

`DecisionMetrics` + `action_outcomes` alimentam uma **proposta** de elevação de autonomia ("aprovou 97% em 90 dias, 0 reversões → liberar execução automática até R$500?"). A IA **nunca** eleva a própria autonomia silenciosamente (PRD 0 §42) — só **propõe**; o humano confirma; a mudança é auditada.

### D6 — Step-up MFA + detecção de anomalia (posterior)

MFA (TOTP já existe) exigido em ações críticas/financeiras acima de limiar; detector de comportamento anômalo publica em `business_signals` (convenção nº 12), sem tabela própria.

---

## Guardrails (RN-159)

- **RN-159-1** — Default-deny para ação financeira/destrutiva sem policy resolvida.
- **RN-159-2** — Nenhuma elevação de autonomia automática/silenciosa (só proposta governada).
- **RN-159-3** — Todo efeito externo auditado no `action_execution_log`, com `correlationId`; nenhuma baixa silenciosa (convenção nº 7/nº 8).
- **RN-159-4** — Sem engine de governança paralelo: estende `agent_policies`/`ApprovalPolicyService`/`CommandExecutor`.

## Fatias sugeridas (ordem)

| Fatia | Escopo | Prioridade |
| --- | --- | --- |
| F1 | D2 — correção do two-step + aprovação via RBAC granular | **alta (segurança)** |
| F2 | D1 — choke-point único (reencaminhar CollectionCadence + handlers) | alta |
| F3 | D4 — bandas valor→papel + estado "escalonar" | média |
| F4 | D3 — RBAC default-deny faseado | média |
| F5 | D5 — progressive autonomy (proposta por evidência) | média |
| F6 | D6 — step-up MFA + detecção de anomalia | posterior |

> Nota: a F1 (correção do two-step) é um risco de segurança concreto e independente do resto — pode ser destacada e priorizada isoladamente.
