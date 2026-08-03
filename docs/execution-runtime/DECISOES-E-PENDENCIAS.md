# Decisões e Pendências — ZappFlow Execution Runtime

**PRD:** `docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`
**ADR:** `docs/adr/ADR-152-zappflow-execution-runtime.md`
**Companion:** `ANALISE-ARQUITETURAL.md`, `PLANO-DE-IMPLEMENTACAO.md`, `MATRIZ-DE-COBERTURA-DO-PRD.md`, `STATUS-DE-EXECUCAO.md`
**Data:** 2026-08-03

Registro persistente de: (a) decisões arquiteturais tomadas na Fase 0; (b) alterações de escopo em relação ao PRD; (c) bloqueios externos; (d) credenciais/manuais ausentes; (e) integrações indisponíveis; (f) riscos aceitos; (g) decisões que dependem do dono do produto.

**A IA Dev não altera decisão registrada aqui por conta própria** — mudança precisa de nova entrada com data e justificativa.

---

## A. Decisões arquiteturais tomadas na Fase 0

### D01 — Reusar ADR-136 (Decision & Action Ledger) em vez de duplicar
**Data:** 2026-08-03
**Contexto:** o PRD propõe `Action Contract + Policy Engine + Executor Registry + Outcome Ledger`. Todos existem sob outros nomes (ADR-136 Epic 2 completo).
**Decisão:** o Runtime **estende** `decision_actions`, `agent_policies`, `CommandExecutorService`, `action_outcomes`. Não cria tabelas paralelas com nomes do PRD.
**Justificativa:** duplicar exigiria migração de ~30 rotas consumidoras, alto risco de regressão, ganho zero. Nomenclatura é resolvida na `MATRIZ-DE-COBERTURA-DO-PRD.md`.
**Consequência:** Fases 1–4 do plano dependem dos serviços do ADR-136 estarem disponíveis (estão).
**Ref:** ADR-152 D1, ANALISE §2.4/§2.6/§2.7/§2.11, ANALISE §4.1.

### D02 — Gap central é o PROCESSO, não a AÇÃO
**Decisão:** duas tabelas novas — `process_definitions` (playbook versionado) + `process_instances` (FSM viva). `decision_actions.process_instance_id` amarra ação↔processo (nullable — ações avulsas legadas continuam funcionando).
**Justificativa:** o PRD é sobre orquestração multi‑etapa; a unidade atual é ação única. Sem processo, não há "recuperar a fatura 4587" — só ações soltas.
**Ref:** ADR-152 D2, ANALISE §2.3.

### D03 — Playbook em JSON tipado (Zod), não DSL própria
**Decisão:** `steps_json` como array de nós declarativos, condições em JSON‑Logic subset (biblioteca já compatível com nossa stack), validação Zod no boot da definição.
**Justificativa:** DSL própria custa alto (parser, linter, tooling, testes) e o ganho de expressividade não compensa. JSON+Zod é auditável, testável, versionável no git.
**Alternativas rejeitadas:** DSL própria (custo alto), TypeScript puro (bom, mas engessa versionamento cross‑org — quando uma org quer variar um passo, forkar código é pior que forkar JSON).
**Ref:** ADR-152 D3, PLANO Fase 1.

### D04 — Confirmation Engine é FINA, cola em cima do que já confirma
**Decisão:** peça `ConfirmationEngine` fina que amarra `(command_type, expected_confirmation) → subscriber` externo. Não substitui webhook Asaas, `resolveByDedupe`, ou `RetailFloorReconciliationService`.
**Justificativa:** todos os pontos de confirmação já existem — falta só a peça que fecha a `decision_action` quando o evento chega.
**Ref:** ADR-152 D4, ANALISE §2.10.

### D05 — Executores são handlers do `CommandExecutorService`, sem registry paralelo
**Decisão:** novos handlers (`WhatsAppSendCommandHandler`, `AsaasPixCommandHandler`, `AsaasChargeCommandHandler`, `AlterdataFetchCommandHandler`, `SchedulerActionCommandHandler`) irmãos dos 5 existentes. Cada um declara `timeoutSeconds`, `retryPolicy`, `confirmationMethod`, `reversibility`, `riskClassification`.
**Justificativa:** o registry `Map<command_type, Handler>` já existe e funciona — outro registry seria duplicação.
**Ref:** ADR-152 D5, ANALISE §2.6.

### D06 — Fila continua single‑process (`JobQueueService`), sem Redis/BullMQ
**Decisão:** manter `JobQueueService` (ADR-073) como fila do Runtime. Aditivos: backoff exponencial, classificação de erro, dead‑letter formal.
**Justificativa:** o repo é single‑process por design (`better-sqlite3`, sem coordenação distribuída). Trocar por fila distribuída é projeto separado.
**Risco aceito:** se o Runtime saturar (dezenas de milhares de processos ativos por instância), reavaliar em fatia futura.
**Ref:** ADR-152 D6, ANALISE §5 R2.

### D07 — Rollout em 4 modos: `shadow | assisted | approved_execution | autonomous`
**Decisão:** coluna aditiva `agent_policies.execution_mode`. Default de qualquer org existente: `assisted` (mantém o comportamento atual). Nenhuma promoção automática — sair de `shadow` exige concordância ≥95% com decisão humana por 2 semanas; sair de `approved_execution` para `autonomous` exige 30 dias sem incidente naquela org.
**Justificativa:** o teto atual `prepare` é decisão intencional (ADR-136 D9). Subir de forma progressiva com métrica objetiva reduz risco.
**Ref:** ADR-152 D7, PLANO.

### D08 — Central "Operações Autônomas" é aba no `ExecutiveView`, não tela nova
**Decisão:** aba paralela à "Plano de Ação" no `ExecutiveView`.
**Justificativa:** o layout do "Plano de Ação" (ADR-136 D8) já é o padrão; tela nova duplicaria contexto e navegação.
**Alternativa rejeitada:** rota `/operations` própria — mais overhead, menos coerência com a experiência atual do Diretor IA.
**Ref:** ADR-152 D8.

### D09 — Ordem dos pilotos por menor risco: Retail Closing → Cobrança → Recuperação Comercial
**Decisão:** F4a Retail Closing primeiro (75% pronto, política clara, escopo por loja, baixo risco financeiro); F4b Cobrança (dunning já existe, escala com política de valor); F4c Recuperação Comercial (LGPD/opt‑out mais delicados).
**Justificativa:** cada piloto vira `shadow → assisted → approved_execution` — começar pelo menos ambíguo maximiza aprendizado antes dos mais delicados.
**Ref:** ADR-152 D9, PLANO Fase 4.

### D10 — Retrocompatibilidade 100% via `execution_runtime_enabled=0` como default
**Decisão:** flag desligada em toda org existente. Aditivos em `decision_actions` são todos nullable. FSM só é aplicada dentro do `ProcessRuntimeService` (nada legado passa por ela).
**Justificativa:** nenhuma quebra no dia da entrega.
**Ref:** ADR-152 D10.

### D11 — Renomeação em massa NÃO acontece
**Decisão:** `decision_actions` continua chamando `decision_actions`. Nomes do PRD ("Action Contract", "Process Definition") são mapeados para os nomes reais na `MATRIZ-DE-COBERTURA-DO-PRD.md`.
**Justificativa:** custo altíssimo (30+ rotas, testes, UIs), benefício zero.

### D12 — Nível 5 de autonomia ("Gerenciar o processo") só depois de Nível 4 estabilizado
**Decisão:** MVP entrega até Nível 4 (`execute` governado). Nível 5 (Runtime escolhe entre ações do playbook sem parar em aprovação em ações classificadas como `automatic`) é fatia posterior.
**Justificativa:** cortar escopo para conseguir entrega real em prazo razoável.

## B. Escopo do PRD alterado ou removido

### E01 — Fases do PRD consolidadas de 8 para 4 (+3 pilotos)
Original: Fase 0, 1 (Fundação), 2 (Execução), 3 (Outcome Ledger), 4 (Cobrança), 5 (Recuperação), 6 (Fechamento), 7 (Operações UI), 8 (Shadow/Rollout).
Revisado: F0, F1 (Process Fabric), F2 (Execute+Confirmation), F3 (Outcomes+UI), F4a/b/c (3 pilotos). Shadow/rollout é **transversal** a cada piloto, não fase separada.
**Justificativa:** Fase 3 do PRD ("Outcome Ledger") já foi entregue pelo ADR-136 D6 — só precisamos aditivos.
**Ref:** PLANO §Índice, ADR-152 D1.

### E02 — DSL própria de playbook — REMOVIDA
Substituída por JSON+Zod (D03).

### E03 — Tela nova "Operações Autônomas" — REMOVIDA
Substituída por aba no `ExecutiveView` (D08).

### E04 — Renomeação em massa das tabelas — REMOVIDA
Não haverá (D11).

### E05 — Nível 5 de autonomia — ADIADO
Fora do MVP (D12). Pode entrar em fatia posterior por decisão do dono.

### E06 — "Aprendizado e otimização" (§10 do PRD, último bloco) — REMOVIDO deste escopo
`[-]` na `MATRIZ`. Justificativa: escopo do PRD já é grande; aprendizado é fatia dedicada (com data set, medição de impacto real vs previsto, ajuste de política). Fica na `MATRIZ` como REMOVIDO para futura decisão.

### E07 — "Email Agent" — REMOVIDO desta versão
`MATRIZ §11.5`. Justificativa: nenhum dos 3 pilotos precisa; adicionar depois se surgir uso.

## C. Bloqueios externos

### B01 — Sicredi (adquirente) — SEM integração ativa no repo
**Contexto:** PRD §15.3 lista Sicredi como fonte do fechamento retail. Não localizei integração.
**Impacto:** F4a roda sem Sicredi; conciliação usa PDV+Alterdata (que já é ADR-150). Se o cliente confiar em Sicredi como fonte primária, F4a fica incompleto até o conector.
**Ação:** confirmar com dono do produto se o piloto Retail pode começar sem Sicredi (recomendo SIM — Alterdata já é a fonte principal do dia a dia). Adicionar conector como fatia futura (F4a.1 opcional).
**Depende de:** dono do produto + credenciais Sicredi.

### B02 — Alterdata: escrita (write‑back) — não confirmada
**Contexto:** `AlterdataConnectorService` está mapeado para leitura (`AlterdataSyncRunner`, `AlterdataFetchCommandHandler`). Escrita (lançar no financeiro do Alterdata) precisa de contrato explícito com Alterdata.
**Impacto:** F4a "atualizar financeiro" pode acontecer no `FinancialLedgerService` local — se o cliente esperar que o Alterdata seja o sistema autoritativo, precisa integração de escrita.
**Ação:** confirmar com dono do produto + testar credenciais.
**Depende de:** decisão sobre fonte da verdade (local vs Alterdata).

### B03 — Revisão jurídica/LGPD para modo `autonomous` da Recuperação Comercial
**Contexto:** enviar mensagem proativa em massa a contatos exige revisão de opt‑out, base legal, direito de contestação.
**Impacto:** F4c só sai de `assisted` para `execute` após signoff jurídico.
**Ação:** dono do produto agenda revisão antes de F4c iniciar `approved_execution`.
**Depende de:** advogado / responsável LGPD.

### B04 — Design System — nome da aba "Operações"
**Contexto:** ADR-152 D8 usa "Operações" como nome de trabalho.
**Impacto:** F3 precisa do nome final antes do PR de UI.
**Ação:** dono do produto valida com Design.
**Depende de:** dono do produto.

## D. Credenciais / manuais ausentes

- **B01 Sicredi:** credenciais API não configuradas.
- **B02 Alterdata write:** contrato de escrita a validar.
- **Meta Ads / Instagram:** escrita já existe (`InstagramService`, ADR-098) — sem bloqueio.
- **Asaas:** credenciais existem (billing atual usa). Cobrança lojista→cliente pode precisar de subconta por org — verificar em F4b.
- **WhatsApp Business:** `MessageProviderService` já em produção — sem bloqueio.

## E. Riscos aceitos

Ver `ANALISE-ARQUITETURAL.md §5` para a matriz completa. Aceitos explicitamente:
- **R2** (JobQueueService single‑process) — aceito para o escopo. Reavaliar após F2.
- **R3** (LLM inventando conclusão) — mitigado por Confirmation Engine determinística; risco residual aceito.
- **R10** (LGPD em recuperação comercial) — piloto F4c permanece em `assisted` até revisão jurídica.

## F. Decisões que dependem do dono do produto

| # | Decisão pendente | Bloqueia | Prazo sugerido |
|---|---|---|---|
| 1 | Retail Closing pode começar sem Sicredi? | F4a start | Antes da F4a |
| 2 | Alterdata write‑back é escopo ou não? | F4a completude | Antes da F4a |
| 3 | Nome final da aba "Operações" | F3 UI | Antes da F3 UI |
| 4 | Agendar revisão LGPD para Recuperação Comercial | F4c `execute` | Antes de F4c sair de `assisted` |
| 5 | Confirmar ordem dos pilotos (Retail → Cobrança → Recuperação) | F4a start | Antes da F4a |
| 6 | Nível 5 de autonomia entra em roadmap ou fica fora? | Escopo futuro | Após F4a estável |
| 7 | Sicredi entra como fatia extra? | Escopo futuro | Após F4a estável |
| 8 | Escolha da org piloto (TOULON confirmada?) | F4a shadow start | Antes da F4a |
| 9 | Métricas de sucesso do shadow (≥95% concordância — aceita?) | Promoção shadow→assisted | Antes de qualquer piloto |
| 10 | Kill‑switch: quem tem autoridade pra virar `execution_runtime_enabled=0` em prod? | Operacional | Antes da F1 merge |

## G. Log de mudanças deste documento

- **2026-08-03** — criação (Fase 0), IA Dev.
