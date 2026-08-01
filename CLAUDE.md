# ExaforgeStudio — Contexto pra sessões Claude Code

Repositório monolítico (frontend React + backend Node/Express + SQLite via `better-sqlite3`) que roda 15+ módulos verticais isolados por `organization_id`.

## Como o trabalho é organizado

- **ADRs** em `docs/adr/ADR-XXX-*.md` — cada módulo grande tem um ADR próprio. Toda decisão arquitetural relevante vive lá (nunca no código nem em wiki externa).
- **Fatias** — unidade de PR. Cada ADR é fatiado em N incrementos numerados (Fatia 1..N). Cada fatia = 1 PR draft → CI verde → merge → next fatia. Testes por fatia em `scripts/test-*.ts` (rodam via `npm run test:<nome>`), matrix em `.github/workflows/ci.yml`.
- **Serviços** em `src/server/*Service.ts` — 1 arquivo por domínio, `static` methods, `orgId` sempre 1º arg (tenant isolation obrigatório).
- **Rotas** em `src/server/routes/*.ts` — Express, com `AuthRequest` + `requireRole` + `actor(req)`.
- **DB** em `src/server/db.ts` — CREATE-then-ALTER estrito (aditivos no fim; nunca reorderar). Colunas opt-in em `organization_settings`.

## Módulos em produção (por ADR)

| ADR | Módulo | Status |
| --- | --- | --- |
| ADR-080 | Clínica base (agenda + prontuário + docs + LGPD + PIN + snapshot + retenção + relatório mensal) | 33 fatias — em produção |
| **ADR-145** | **Clínica: Jornada de Tratamento multiespecialidade** | **FECHADO — 15 fatias (34–48) em produção** |
| ADR-144 | Escola — conector família + resumo diário | em produção |
| ADR-136 | Decision-Action Ledger (`business_signals`) | em produção — usado por Retail, Escola, Clínica (F47) |
| ADR-132 | Sinais finos | em produção |
| ADR-081 | Conectores TISS (roadmap TISS XML/WS) | roadmap — molde documentado; aditivo à ADR-145 |

## ADR-145 — CLÍNICA JORNADA DE TRATAMENTO (fechado 2026-08-01)

Cliente: clínica multiespecialidade com salas compartilhadas, terapia em grupo, ciclos renováveis de 10 sessões, alta pelo médico, guia emitida pela recepção. Antes da ADR-145 o cliente operava com gambiarras (`force=true` pra grupo, "esquecer" paciente pra fingir alta, recadastrar pra outra especialidade). Depois da ADR-145 tudo é primeira classe.

**5 fases entregues em 15 fatias / 15 PRs / 0 breaking changes:**

- **Fase 1 — Fundação normalizada** (F35–F36): `clinic_specialties` + N:N `clinic_professional_specialties` + `clinic_care_episodes` longitudinal com unique parcial (1 episódio ativo por paciente/especialidade).
- **Fase 2 — Ciclos + PIN** (F37–F40): aditivos em `appointments` (care_episode_id, treatment_cycle_id, specialty_id, schedule_session_id); `clinic_treatment_cycles` renováveis com **saldo derivado por query (RN-004, nunca contador mutável)**; alta com PIN do médico (RN-007, reusa Fase 28); métricas + fila operacional.
- **Fase 3 — Grupo primeira classe** (F41–F43): `clinic_schedule_sessions`; RN-006 (5 pacientes em grupo = 1 ocupação do profissional, não 5); portal do paciente sem vazar outros participantes (RN-013 §3).
- **Fase 4 — Guia da recepção** (F44–F46): `clinical_guides` polimorfo (3 tipos: TISS + encaminhamento + pedido médico) com numeração série própria + snapshot canônico Fase 29 + PDF por tipo + envio HMAC + LGPD + integração bidirecional guide↔cycle (RN-005 §8: ciclo pending_authorization até guia emitida).
- **Fase 5 — IA operacional** (F47–F48): `ClinicScheduleSessionService.availability` (sugere 3 horários do MESMO profissional); `ClinicRenewalTaskService` publica sinais no `business_signals`; `ClinicGuideService.draft` pré-preenche rascunho de guia com o que existe e marca `missing:true` no que falta.

**Guardrails RN-014 duros** (documentados no header dos services + testados):

A IA operacional **nunca**:
- Sugere outro profissional (RN-003 profissional fixo).
- Renova ciclo (recepção decide + humano confirma).
- Dá alta (RN-007, alta é do médico com PIN).
- Emite guia sem PIN (F44/46).
- Inventa TUSS, carteirinha, `authorizationNumber` ou `validUntil` (F48).
- Herda `referralReason` de encaminhamento anterior (motivo é sempre novo).
- Fabrica lista de itens em pedido médico (F48).

**Retrocompatibilidade 100%** — appointments legados sem episódio/ciclo/sessão continuam operando como consulta avulsa. Migração puramente aditiva.

**Números:** 6 tabelas novas + 6 aditivos + 7 services novos + ~35 rotas + 13 scripts de teste (todos PASS 100% na CI matrix).

## Convenções críticas (não regredir)

1. **Isolamento multi-tenant** — TODA query filtra `organization_id`. Toda função service recebe `orgId` como 1º arg. Cross-tenant é bug de segurança.
2. **CREATE-then-ALTER estrito em `db.ts`** — bug histórico das Fases L/T/U. Nunca reorderar; sempre append no fim.
3. **Snapshot canônico + `computeDocumentHash`** — docs emitidos (prescrição/atestado/recibo/guia) congelam snapshot (Fase 29); renomear paciente/negócio depois NÃO altera doc. Hash recursivo canonicaliza JSON.
4. **HMAC signed URLs** — segredo derivado `sha256(JWT_SECRET:{scope}_v1)`, TTL 15min, `timingSafeEqual`, basename-only, `X-Content-Type-Options: nosniff`. Padrão Fases K/18/33/45.
5. **PIN com lockout** — `verifyPin` reusa `timingSafeEqual` + 5 tentativas / 15min. Fase 28.
6. **LGPD** — `dados_sensiveis` (Art.11) pra leitura clínica + `comunicacoes` (Art.7) pra envio. `maskIdentifier` em audit metadata (Fase 32).
7. **Best-effort services** (deliveries, notifications) — nunca throw pro caller; dedup via unique index + try/catch `SQLITE_CONSTRAINT_UNIQUE`.
8. **Race conditions** — transação atômica com SELECT COUNT dentro da tx antes do INSERT (padrão AC-012 da Fatia 41).
9. **Retenção CFM 20 anos** — nunca `DELETE`. Cancelamento é UPDATE status='cancelled' (preserva histórico).
10. **Feature flags opt-in** — `organization_settings.{modulo}_{feature}_enabled INTEGER DEFAULT 0`.
11. **Import dinâmico** pra quebrar ciclos entre services: `import("./X.js").then(m => m.X.method(...))`.
12. **BusinessSignal** (ADR-136) — quando um detector precisa alertar a operação, publica em `business_signals` com `dedupe_key` — nunca cria tabela própria de "alertas".

## Fluxo padrão de uma fatia

1. Ler ADR do módulo (`docs/adr/ADR-XXX.md`).
2. Implementar service em `src/server/`. Comentários em PT-BR no header explicando decisões e regras (RN-xxx).
3. Rota em `src/server/routes/`. `AuthRequest`, `requireRole` quando aplicável, `actor(req)` no audit.
4. Teste em `scripts/test-<nome>.ts` — sempre com `tmpDir` isolado, `check(name, ok)` helper, cobre happy path + edge cases + audit + isolamento multi-tenant.
5. Wiring: `package.json` scripts, `.github/workflows/ci.yml` matrix, atualizar seção "Status" do ADR marcando fatia como MERGED.
6. `git commit` com corpo detalhado (a auditoria de features roda no `git log`), push, PR draft.
7. Subscribe PR + esperar CI verde + merge.
8. Reset --hard origin/main + próxima fatia.

## O que evitar

- Comentários que só descrevem o `WHAT` do código — só documente `WHY` não óbvio (invariante, workaround, restrição regulatória).
- Contador mutável no lugar de query derivada. Se surgir necessidade, reveja se é mesmo derivável (RN-004 sempre foi).
- Backward-compat "shims" quando dá pra só editar o código. Aditivo em DB é diferente — é obrigatório (compat com dados existentes).
- Colocar validação em ambos service + rota. Rota valida forma (schema); service valida invariante de negócio.
- Reusar `store_id` como `id`. Sempre `randomUUID()`.
