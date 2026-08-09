# Análise Comparativa — ZapFlow Execution Intelligence (Estado Final × `main`)

- **Documento:** análise de partida do programa ZEI (auditoria exigida pelo PRD 0 §60).
- **Data:** 2026-08-09
- **Entradas:** `ZAPFLOW — ESTADO FINAL ESPERADO` (visão norteadora) + `PRD 0 — ZapFlow Execution Intelligence` (documento-mãe de ~15 PRDs).
- **Método:** auditoria do `main` em 8 frentes (runtime, percepção, decisão/aprendizado, Fala Tu, impacto/custo, contexto, UX, segurança/autonomia), na lógica **REUTILIZAR / ESTENDER / CRIAR** (PRD 0 §54).
- **Relacionadas:** ADR-135, ADR-136, ADR-152, ADR-156/157 (base existente); **ADR-158** e **ADR-159** (propostas nascidas desta análise).

> Este documento é a "estrela-guia" operacional do programa. Cada PRD/fatia futura deve responder: **"qual parte do estado final estamos construindo, e o que já existe que devo estender em vez de duplicar?"**

---

## 1. Veredito

A auditoria do PRD 0 está **correta**: o ZapFlow **não deve ser reescrito**. A espinha dorsal do "ciclo universal" (perceber → decidir → governar → executar → confirmar → medir → aprender) **já existe e roda em produção**. O trabalho do programa é **conectar e desfragmentar** o que existe — não construir órgãos novos.

**A coluna vertebral que já existe:**

```
business_signals ─▶ ProcessRuntime/PlaybookEngine ─▶ DecisionAction ─▶ CommandExecutor(guardas+policy) ─▶ handlers externos ─▶ ConfirmationEngine ─▶ action_outcomes
    (perceber)            (planejar)                    (decidir)           (governar + executar)              (agir)            (confirmar)          (medir)
```

**Os três problemas estruturais** (e não a falta de capacidade):

1. **As duas pontas do ciclo estão fragmentadas em ilhas paralelas** — N tabelas de "sinal/alerta" na entrada, N contabilidades de "impacto/receita" na saída.
2. **O elo sinal→processo não é automático** — o start de um processo é manual (rota ou playbook de domínio); não há disparo genérico signal→instance.
3. **Não há `correlationId` atravessando o fluxo** — o "organismo único" é anatomicamente completo mas **sem sistema nervoso** conectando as partes (contradiz PRD 0 §50 e Estado Final §66).

Se os próximos PRDs adicionarem capacidade **antes** de consolidar, vão multiplicar exatamente a duplicação que o Estado Final §23/§57/§58 proíbe.

---

## 2. Matriz REUTILIZAR / ESTENDER / CRIAR

| Camada / PRD | REUTILIZAR (já existe) | ESTENDER | CRIAR (pouco) |
| --- | --- | --- | --- |
| **Runtime / Execução (PRD 4)** | ProcessRuntime (FSM 13 estados), PlaybookEngine, CommandExecutor (guardas G1-G3), ConfirmationEngine, JobQueue (backoff+dead-letter), RuntimeExceptions | Auto-disparo **sinal→instância**; motor de `priority`/`risk_level` (hoje campo estático) | — (não criar 2º engine) |
| **Percepção / Radar (PRD 2)** | `business_signals` (schema bom, dedupe), Scheduler (tick horário + fastPass 5min), ~15 publishers no contrato | Migrar detectores **fora do contrato**; `schema_version`, `subject_type`, `expires_at`, `correlation_id`; DetectorRegistry | Detectores de **compras**, **reputação**, **agenda (no-show/ociosidade)** |
| **Decision Intelligence (PRD 3/8)** | `DecisionEngine.analyze({mode})` (premortem/red-team/advocate ✅), ImpactPrioritization (L0–L4, Pareto), EvidencePackage, PatternMemory genérico (7 domínios) | Explainability num **tipo único**; fechar outcome real→PatternMemory automático | — |
| **Fala Tu (PRD 1/10)** | Captura texto/áudio/imagem(visão), RAG próprio, metering, Share/Siri/NFC, briefing→signals | **Reduzir a porta I/O** (§4.B); inbox por eixo de decisão | Artifact Delivery (PDF/XLSX); Operational Chat tipado |
| **Impact Ledger (PRD 7)** | `action_outcomes` (esperado×realizado, basis fact/estimate, evidence_json) — **já é o contrato-alvo** | Adaptadores Retail/Comigo/RIC emitindo nele; +4 categorias; custo-por-outcome | — (não criar 2ª contabilidade) |
| **Context Engine (PRD 3)** | BusinessSnapshotV2 (JSON por domínio), Manifesto, VerticalIntelligence (cache/TTL/versão) | Persistir/versionar/cachear o snapshot; convergir Context(string)+V2 | Modelo de **objetivos/metas** + distância à meta |
| **Autonomy Contract (PRD 5/6)** | `agent_policies` (autonomy_level, execution_mode, max_auto_amount), ApprovalPolicy, DecisionMetrics | **Bandas valor→papel**; estado "escalonar"; motor de **progressive autonomy** por evidência | — |
| **Invisible UX (PRD 9)** | HealthCenter ("Hoje" já forte), entitlements+RBAC escondem módulos | Colapsar Sidebar (~37 itens) nos 5 conceitos; promover Fala Tu | Tela **"Executando"** (não existe) |
| **Segurança (transversal)** | JWT, RBAC granular, TOTP, audit trail, EncryptionService, LGPD | Ver §5 — vários buracos a fechar | correlationId; step-up MFA |

**Conclusão:** o programa é **~80% ESTENDER/consolidar, ~15% CRIAR pequeno, ~0% reescrever.**

---

## 3. Duplicações a eliminar

**A. Percepção fragmentada (a pior).** `business_signals` é o contrato oficial (convenção nº 12), mas convivem **7 tabelas de "alerta" paralelas**: `opportunities` (OpportunityRadar), `recovery_events` (RecoveryRadar), `manipulation_alerts` (ManipulationRadar), `radar_*` (4 variantes de maturidade), `decision_risks`, `upgrade_recommendations`, `notifications`. Há **sobreposição semântica**: OpportunityRadar, RecoveryRadar e RetailOps **detectam os mesmos eventos** ("reclamação/atraso/cancelamento") em storages diferentes.
→ Migrar para `business_signals` (domains `opportunity`/`recovery`/`reputation`); tabelas antigas viram projeções ou são aposentadas.

**B. "Segundo cérebro" do Fala Tu (maior risco arquitetural).** `falatu_tasks/events/lists/entities` são **domínio paralelo** a `TaskService`/`AppointmentService`/`Coordenador`/`Gestor`. `FalaTuWhatsAppService` roda **antes e desvia** do Controller/Coordenador/Diretor IA no mesmo canal. RAG duplicado: `geminiRAG`+`knowledge_documents` vs `FalaTuMemoryEmbeddings`+`falatu_memory_embeddings`.
→ Fala Tu deve virar **porta (I/O)**, escrevendo nos services do ZapFlow, não em silos próprios (PRD 0 §4.2).

**C. Impacto em ≥6 contabilidades.** `action_outcomes` (genérico) vs `retail_impact_snapshots` vs Comigo (derived) vs RIC/`RevenueAudit` vs `sales_recovery_attributions` vs AB/Referral-via-signals. **Só SalesRecovery** escreve no ledger genérico. Ponto positivo: **nenhuma infla ROI** (categorias separadas — ADR-085 D4 respeitado).
→ Retail/Comigo/RIC passam a **emitir em `action_outcomes`** via adaptadores.

**D. Menores.** `RetailPatternMemoryService` (363 l.) **reimplementa** o motor genérico `PatternMemoryService` → colapsar num adapter `retail`. `BusinessContext`(string) vs `BusinessSnapshotV2`(JSON) — dois panoramas que o Advisor concatena. UI: **3 radares** (RadarView/B2B/Consultant), **2 chats-com-negócio** (FalaTuView vs ExecutiveView"Conversar"), **4 telas de "prioridades"** (HealthCenter/Insights/BigIdeaBar/Executive).

**E. Colisão de nome:** `MaestroService` (bridge legada task-only) vs "Maestro 2.0" (= `CommandExecutorService`) — renomear.

---

## 4. Alvos de refatoração (por alavancagem)

1. **Choke-point único de execução externa.** Hoje há **≥3 caminhos** para efeito externo: `CommandExecutor.execute` (governado), `CollectionCadenceService` (envia cobrança *fora* do runner) e handlers chamando `MessageProvider`/`Asaas` direto. → Todo efeito externo por **um** ponto governado. Sem isso, autonomia = risco não-auditado. *(ADR-159)*
2. **Unificar as pontas do ciclo** (§3.A + §3.C). *(ADR-158)*
3. **`correlationId` end-to-end** (signal→decision→policy→action→execution→outcome) — hoje **inexiste**; contradiz PRD §50. *(ADR-158 F1 — primeira fatia)*
4. **Snapshot de contexto persistido/versionado/cacheado** — hoje `BusinessSnapshotV2.build()` **recalcula stateless a cada chamada** (custo + latência).
5. **Fala Tu → porta I/O** (§3.B).

---

## 5. Riscos de segurança e governança (trilha paralela, não-negociável)

O programa **adiciona autonomia** sobre uma base com buracos concretos:

- 🔴 **RBAC é opt-in.** O enforcement granular só age se o usuário tem `role_profile_id`; **todo o parque legado passa sem gating** (privilege-por-omissão). Financeiro idem (flag `rbac_finance_enabled` default off).
- 🔴 **Bug no two-step approval.** `routes/actions.ts` conta aprovadores com `DISTINCT COALESCE(approver_user_id,'?')` — aprovadores sem id **colapsam num só**, permitindo burlar a exigência de 2 pessoas. E usa `req.user.role` **legado**, não o RBAC granular.
- 🟠 **Tenant isolation sem RLS**, dependente de disciplina manual por query; `SecurityAudit` já varre `organization_id IS NULL`. SQLite compartilhado (inclusive vision-cloud).
- 🟠 **MFA não é exigido em ações críticas/financeiras** (só no setup do próprio 2FA). Falta step-up auth.
- 🟠 **Sem detecção de comportamento anômalo**; rate limit em memória, não distribuído.
- 🟡 **Progressive autonomy inexiste**: nada realimenta `agent_policies` por evidência; `autonomous` nunca é semeado (trava LGPD — ok, mas Nível 4 ainda não é real). Bandas valor→papel não existem (só teto único `max_auto_amount`); estado "escalonar" não existe.

*(Endereçados na ADR-159.)*

---

## 6. Riscos de performance / custo de IA

- **Sem cache/dedupe de LLM e roteamento de modelo fixo.** `AIOrchestratorService` usa `CHAT_MODEL` fixo; **não há cascata determinístico→econômico→caro** que o PRD §55/§48 exige. Maior oportunidade de custo. (ADR-154 F1 em rascunho, não implementado.)
- **Custo-por-outcome impossível hoje:** `ai_usage_log` tem `module` (muitas vezes `'legacy'`), sem agente/função/processo/outcome_id.
- **Snapshot recalculado on-demand** (§4.4) — cache resolve custo e latência.
- **Scheduler é timer único** (sem cron externo, sem DetectorRegistry); `JobQueue` existe mas não orquestra detectores.

---

## 7. UX — rumo à Invisible UX

Gap é **navegação**, não capacidade. Sidebar é **lista plana de ~37 itens**; `App.tsx` é um `switch` gigante (sem router). Mapeando os 5 conceitos-alvo:

- **HOJE** ✅ já forte (`HealthCenter`, "máx 3 prioridades/dia") — falta **fundir** os 4 "inbox de prioridades".
- **FALA TU** ⚠️ existe mas **gated a Master/flag** — precisa virar entrada universal.
- **EXECUTANDO** ❌ **não existe** tela dedicada (o buraco real) — montar sobre ExecutiveView"Operações" + runtime.
- **RESULTADOS** ⚠️ disperso (Dashboard/Reports/RIE/Caixa) — consolidar.
- **EMPRESA** ⚠️ espalhado (Settings/Manifesto/Areas/Users/Permissions) — agrupar.

Base boa: `/api/entitlements/me` já derrama módulos+permissões e a UI **já esconde** por plano/RBAC.

---

## 8. Sequência recomendada

O PRD 0 sugere abrir por **PRD 1 (Fala Tu)**. **Esta análise recomenda o contrário:** atacar Fala Tu primeiro, com o "segundo cérebro" ativo e as pontas do ciclo fragmentadas, **amplifica a duplicação** antes de consolidá-la. A fundação certa é **conectar e desfragmentar a espinha existente** — 100% aditivo/reversível, e destrava todos os PRDs downstream (radar, autonomia, impacto e aprendizado **todos** dependem de `business_signals` + `action_outcomes` + correlação).

### Onda 0 — Consolidação da Espinha (antes da Onda A do PRD 0)

- **ADR-158 — Espinha Única:** contrato de sinal (migra detectores fora-do-contrato + `schema_version`/`subject_type`/`correlation_id`/`expires_at`) + outcome único (adaptadores Retail/Comigo/RIC → `action_outcomes`) + `correlationId` end-to-end.
- **ADR-159 — Choke-point de execução + hardening de governança:** todo efeito externo via CommandExecutor; corrige o bug do two-step e o RBAC opt-in; bandas valor→papel + estado "escalonar".
- **Depois, Onda A** do PRD 0 (Fala Tu como porta, Radar transversal, Context Engine, Autonomy Contract) sobre base limpa.

### Primeira fatia (menor de valor real) — **ADR-158 F1 (entregue)**

`correlation_id` + `schema_version` aditivos em `business_signals`/`decision_actions`/`action_outcomes`, com herança sinal→decisão→outcome e a primitiva de rastreabilidade (`ExecutionTraceService` + `GET /api/decision-intelligence/trace/:correlationId`). Puramente aditivo, reversível, sem migração de dado — destrava o §50. Teste: `npm run test:execution-trace`.

---

## 9. Princípio de trabalho (toda fatia)

Antes de criar qualquer componente, aplicar o PRD 0 §54: **já existe service/tabela/engine/policy/evento/executor/métrica equivalente? Se sim, ESTENDER — não duplicar.** E o §79 do Estado Final: **"isso deixa o ZapFlow mais inteligente ou apenas maior?"** — se só aumenta, não construir.
