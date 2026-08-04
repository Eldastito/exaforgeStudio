# ADR-153 — Status de execução

Log operacional das fatias do plano. Cada sessão adiciona 1 entrada.

---

## Fase 0 — Auditoria + PRD + Análise + Plano

### Sessão 2026-08-04 (Fase 0)

- **Fase:** 0 (só documentação — nenhum código produtivo).
- **Itens executados:**
  1. Reset da branch pra `origin/main` (pós-merge #770 — F4d.1 do ADR-152).
  2. 4 agentes Explore em paralelo mapearam o codebase por domínio: (a) entitlement/plan/module/vertical/RBAC; (b) subscription/checkout/Asaas/billing; (c) signals/decision-actions/usage/recomendação; (d) onboarding/quick-start/blueprint (que não existe).
  3. Consolidação dos 4 relatórios em documentos operacionais.
  4. Escrita do PRD verbatim (§1–§37) + ADR-153 (decisão + guardrails) + Análise Arquitetural (divergências PRD × código + ponderações técnicas) + Plano de Implementação (28 fatias em 8 fases) + Decisões Pendentes (10 pontos) + Matriz de Cobertura.
- **Arquivos criados:**
  - `docs/prd/PRD-VERTICAL-ENTITLEMENTS-ASSINATURAS.md` (PRD do dono, verbatim).
  - `docs/adr/ADR-153-vertical-entitlements-assinaturas-upgrade.md` (decisão + 7 guardrails).
  - `docs/vertical-entitlements/ANALISE-ARQUITETURAL.md` (5 seções — sumário do que existe, divergências, ponderações, convergência, riscos).
  - `docs/vertical-entitlements/PLANO-DE-IMPLEMENTACAO.md` (28 fatias em 8 fases + dependências).
  - `docs/vertical-entitlements/DECISOES-E-PENDENCIAS.md` (10 decisões do dono do produto agrupadas em 4 seções).
  - `docs/vertical-entitlements/STATUS-DE-EXECUCAO.md` (este documento).
  - `docs/vertical-entitlements/MATRIZ-DE-COBERTURA-DO-PRD.md` (item-by-item de §7 a §36 do PRD com status atual).
- **Arquivos alterados em `src/**`:** nenhum (Fase 0 = só documentação, conforme §32 do PRD e padrão do repo).
- **Testes executados:** nenhum (Fase 0 não altera código executável).
- **Resultado:** Fase 0 completa — 7 documentos persistidos no repo. Todo o encanamento pra Fase 1 mapeado. Divergências entre PRD e código enumeradas em `ANALISE-ARQUITETURAL.md §2`. 10 decisões pendentes do dono documentadas — Decisões #1 (Comigo) e #2 (ToS) bloqueiam duro; #4 (nomes de Blueprint) e #5 (bundle Clínica) bloqueiam F3; #3 (HMAC) é fatia adjacente à F5.
- **Pendências criadas:** as 10 decisões do §DECISOES-E-PENDENCIAS.md. Cada uma linkada com as fatias bloqueadas.
- **Próximo passo:** aguardar aprovação do dono nas Decisões #1, #2, #3, #4, #5, #9 (as com prioridade Alta/Máxima) antes de iniciar F1. **Alternativa mínima:** aprovar #1 (Comigo persistente) + começar F1.1 (EntitlementService aditivo puro) — F1 inteira não depende de nenhuma outra decisão porque é infraestrutura de leitura.

---

## Sessão AAAA-MM-DD (template para próxima)

- **Fase:** …
- **Itens executados:** …
- **Arquivos criados:** …
- **Arquivos alterados:** …
- **Testes executados:** … (comando + resultado)
- **Resultado:** …
- **Pendências criadas:** …
- **Próximo passo:** …

---

## Como marcar item como concluído

Um item **NÃO** é `[x]` só por ter código. Precisa (do PRD §22):

- Implementação backend + persistência + validação + autorização + auditoria.
- Interface (quando aplicável) + estados vazios + loading + tratamento de erro.
- Teste automatizado verde na CI.
- Documentação atualizada.
- Feature flag + migração + rollback documentado.
- **Linha correspondente na `MATRIZ-DE-COBERTURA-DO-PRD.md` marcada `[x]` com evidência.**
- Evidência (script, comando, screenshot ou commit hash) registrada aqui neste STATUS.
