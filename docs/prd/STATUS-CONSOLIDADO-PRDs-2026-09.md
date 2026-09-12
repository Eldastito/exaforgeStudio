# Status consolidado dos PRDs — 2026-09-12

Registro do estado de atendimento dos dois PRDs trabalhados nesta frente, contra as
solicitações originais. Honestidade dura: um item só é **✅ Atendido** quando está em
produção e verificado; itens preservados-mas-não-testados são marcados como tal.

Legenda: ✅ Atendido (produção) · 🟢 Já existia (não precisou código) · ⚠️ Parcial ·
⛔ Bloqueado (depende de terceiro/você) · ❌ Não feito · 🚫 Fora de escopo (não é código).

---

## PRD 1 — Evolução de Marca e Comunicação do ZapFlow (8 PRDs)

Fontes: `docs/prd/PRD-BRAND-EVOLUTION-8prds.md`, `docs/prd/ANALISE-PRD-BRAND-EVOLUTION-vs-CODEBASE.md`.

| PRD | Solicitação | Status | Evidência |
| --- | --- | --- | --- |
| Fase 0 | Auditoria PRD × codebase | ✅ | `ANALISE-PRD-BRAND-EVOLUTION-vs-CODEBASE.md` (PR #1614) |
| 01 | Brand Core institucional (essência/promessa/mecanismo/…) | ✅ | `BrandCoreService.ts`, painel em `AdminMasterView` (PR #1615/#1616) |
| 02 | Message House (identidade verbal) | ✅ | `BrandMessaging` em `BrandCoreService`, UI Message House (PR #1619/#1620) |
| 03 | Nova arquitetura de comunicação comercial | ⚠️ Parcial | landing reenquadrada (PR #1622) — detalhes abaixo |
| 04 | IDO — Índice de Dependência Operacional | ✅ | `OperationalDependencyService.ts` + `IdoCard` (PR #1617/#1618) |
| 05 | Universal Closed Loop / Outcome Assurance | 🟢 | já em produção — ADR-165 (`OutcomeAssuranceService`/Value Ledger) |
| 06 | Invisible UX & Zero-Training | 🟢 | já em produção — ADR-163 (`UxPresentationService` etc.) |
| 07 | Comunicação por vertical | ✅ | `BrandVerticalProfileService.ts` + painel (PR #1620/#1621) |
| 08 | Brand DNA 2.0 | 🟢 | já em produção — ADR-168 (`BrandDnaService`, versionamento) |

### PRD 03 — detalhamento (o único parcial)

Entregue: **fatia 1** — hero da dependência ("Quanto da sua empresa ainda depende de
você?"), bloco-problema (5 perguntas + conclusão) antes das funcionalidades, CTA
"Descubra sua dependência operacional" (PR #1622). Coerente com Brand Core (01) e IDO (04).

Checklist do PRD 03 — estado real:

- [x] Jornada comercial reorganizada (hero → problema → transformação antes de features)
- [x] Hero atualizado
- [x] CTA de diagnóstico criado (rótulo; **destino = fluxo de contato/WhatsApp**, não um IDO público)
- [x] Bloco problema implementado
- [x] Transformação apresentada antes das funcionalidades
- [ ] Provas incluídas — parcial (seções de segurança/FAQ pré-existentes; sem novos casos)
- [ ] **Responsividade validada** — ❌ **não testada em dispositivo** (CSS responsivo escrito, mas não validado)
- [ ] **Android validado** — ❌ não testado
- [ ] **iPhone/iOS validado** — ❌ não testado
- [ ] **Desktop validado** — ❌ não testado em execução (só `build`/`tsc`)
- [ ] **SEO preservado** — ⚠️ não alterado, mas **não verificado**
- [ ] **Analytics preservado** — ⚠️ não alterado, mas **não verificado**
- [x] Funções existentes preservadas (CTA/`marketingConfig` intactos; front puro)
- [ ] Testes concluídos — parcial (`tsc`+`build`; landing sem teste unitário no repo)

🚫 Fora do repo (não é código, decisão do dono): apresentação comercial, apresentação
institucional, propostas, materiais de onboarding, textos comerciais.

**Ponto honesto:** a CTA soa como diagnóstico interativo mas leva ao contato — não foi
inventado um IDO público/anônimo (seria scope-invention + superfície de abuso).

### Veredito PRD 1
Núcleo de **engenharia atendido**. PRD 03 **não está completo** — faltam validações de
device/SEO/analytics (nunca executadas) e o material comercial fora do repo. 05/06/08 já
existiam; reconstruir seria duplicação.

---

## PRD 2 — PRD-ZF-UNIFIED-GAP-CLOSURE-03

Fonte: `docs/prd/AUDIT-ZF-UNIFIED-GAP-CLOSURE-03.md`.

| Item | Solicitação | Status | Evidência |
| --- | --- | --- | --- |
| F0 | Gate/auditoria | ✅ | `AUDIT-ZF-UNIFIED-GAP-CLOSURE-03.md` |
| F1.1 | Choke-point de efeito externo (default 0→1 + Edge) | ⛔ | flags `*_via_executor_enabled` seguem DEFAULT 0 — **bloqueado**: exige relatório de produção `GET /api/admin/external-effect-shadow/all` + rollout faseado |
| F1.2 | Scheduling Kernel | ✅ | reclassificado — extraído `intervalsOverlap` (`schedulingOverlap.ts`) |
| F1.3 | SignalReactionPolicy | ✅ | reclassificado NOT_NEEDED (dois consumidores ortogonais) |
| F1.4 | Financial Event Identity | ✅ | reclassificado ALREADY_DONE (`cash_events` chave canônica) + invariantes (PR-12) |
| F1.5 | Entitlement fallback | ⛔ | `FALLBACK_HIDDEN_BY_VERTICAL` ainda presente — bloqueado no mesmo dado de produção |
| F2.1–2.4 | Verdade financeira (DRE/fontes/qualidade) | ✅ | verificado — receita varejo já entra no DRE; dupla contagem detectada |
| F3.1–3.19 | Financial Recovery OS | ✅ | 7 PRs em produção (Debt Map, IRF, Priority Matrix, Scenario Engine, Recovery Plan, escalonamento, golden path + runbook) |
| F4 (provenance) | Procedência plugada no Prospect | ✅ | `prospectProvenance.ts` alinhado ao PRD 9 (PR #1623) |
| F4 (vertical packs) | Packs de ICP por nicho | ✅ | `prospectVerticalPacks.ts` (PR #1624) |
| F4 (entity-resolution) | Merge além de dedupe | ❌ | não feito — risco de mexer no dedupe (decisão: não iniciar sem apetite explícito) |
| F5 | Sales Coach | ❌ | Onda 4 (greenfield) — exige decisão de escopo |
| F6 | Vendedor IA assistido | ❌ | Onda 4 (greenfield) — exige decisão de escopo |
| F7 | Independência operacional (owner bandwidth) | ❌ | Onda 4 — não feito |
| F8 | Hardening/golden paths/runbooks | ✅ (parcial p/ F3) | runbook `docs/runbook/financial-recovery-operacao.md` |

### Veredito PRD 2
Ondas 1–3 e F3 **atendidas**; F4 **atendido em 2 de 3 gaps** (falta entity-resolution).
Os itens de **maior impacto de negócio (F1.1, F1.5)** **não** foram atendidos — estão
**bloqueados esperando o relatório de produção**. Onda 4 (F5–F7) não iniciada por decisão.

---

## Resumo executivo

- **Nenhum dos dois PRDs está 100%.**
- **PRD Marca:** engenharia essencialmente completa; PRD 03 incompleto (validações de
  device/SEO/analytics não executadas + material comercial fora do repo).
- **GAP-CLOSURE:** grosso entregue; **F1.1 e F1.5 são os maiores itens em aberto**, ambos
  travados no relatório de produção que só você pode extrair.
- **Próximo item de maior valor real:** rodar `GET /api/admin/external-effect-shadow/all`
  em produção → destrava F1.1 (e parte da F1.5).

_Este documento é um registro de status doc-only; não altera comportamento._
