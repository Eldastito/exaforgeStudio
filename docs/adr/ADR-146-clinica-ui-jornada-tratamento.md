# ADR-146 — Módulo Clínica: UI da Jornada de Tratamento (Fase 1 do go-live)

**Status:** Proposto — Fatia 1 (esta ADR + inventário do frontend + fatiamento). Aguardando início da Fatia 2.

**Data:** 2026-08-01

**Origem:** ADR-145 fechou o backend da Jornada de Tratamento (15 fatias, F34–F48, 100% em produção). O cliente da clínica multiespecialidade **ainda não consegue operar em produção** porque toda a Fase 5 (IA operacional), a Fase 4 (guias), a Fase 3 (grupo) e as Fases 2/1 (episódio + ciclos + especialidades) foram entregues como endpoints REST sem nenhuma superfície visual — a única view clínica hoje (`src/features/ClinicAgendaView.tsx`, 3.363 linhas) enxerga só o modelo pré-145 (agenda avulsa + `clinic_professionals.specialty` texto livre + autorizações antigas). Este ADR desenha o frontend que fecha esse gap.

**Relacionadas:** ADR-145 (backend Jornada — 15 fatias fechadas), ADR-080 (Clínica base — 33 fatias, contém `ClinicAgendaView.tsx` original), ADR-081 (Conectores TISS — futura evolução da guia), ADR-136 (Decision-Action Ledger — `business_signals` que a UI consome).

---

## Contexto

### O gap real hoje (2026-08-01)

Rodei uma auditoria no frontend antes de escrever este ADR (`grep` por endpoints novos em `src/`):

```
care-episodes         → 0 refs
schedule-sessions     → 0 refs
treatment-cycles      → 0 refs
clinical_guides       → 0 refs
guides/draft          → 0 refs
renewal-tasks         → 0 refs
```

`ClinicAgendaView.tsx` — a **única** view clínica — hoje contém ~30 componentes internos (`AppointmentCard`, `ProfessionalsPanel`, `RoomsPanel`, `AuthorizationsTab`, `AuthCard`, `NewAppointmentModal`, `NewAuthorizationModal`, `ConnectionTab`, `ReadinessPanel`, `OperatorsPanel`, `ProceduresPanel`, `PortalControl`, `OperatorCredentials`, …). É o "big ball" que o próprio ADR-145 §Riscos previu ("refactor inevitável — extração incremental por componente, não big-bang").

### O que muda pra recepção quando isto sair

Sem UI, a recepção continua fazendo o de sempre: cadastro texto livre da especialidade no cadastro do profissional, `force=true` implícito na agenda pra montar grupo, "apagar paciente" pra fingir alta, refazer autorização a cada renovação. **A ADR-145 removeu essas gambiarras do backend, mas ao mesmo tempo tornou o sistema inoperável pela UI atual.** Este ADR é o que devolve o poder de uso do que já está em produção.

### Cinco superfícies novas que precisam existir

Mapeadas 1:1 com as 5 fases da ADR-145 (mesmo domínio, mesma linguagem, mesma auditoria — só que agora com botão):

| # | Superfície                                    | Consome (backend ADR-145) | Substitui gambiarra atual |
|---|-----------------------------------------------|---------------------------|---------------------------|
| 1 | **Especialidades + vínculos N:N**             | Fase 1 (F35)              | Cadastro texto livre em `clinic_professionals.specialty` |
| 2 | **Episódios de cuidado + alta com PIN**       | Fase 2 (F36–F40)          | "Apagar paciente" pra fingir alta |
| 3 | **Ciclos + fila de renovação**                | Fase 2 (F38) + Fase 5 (F47) | Nova autorização a cada renovação, sem trilha |
| 4 | **Sessões em grupo + availability da IA**     | Fase 3 (F41–F43) + Fase 5 (F47) | `force=true` implícito na agenda |
| 5 | **Guias polimorfas + rascunho da IA + envio** | Fase 4 (F44–F46) + Fase 5 (F48) | Não existia — recepção emitia à mão fora do sistema |

---

## Decisão

### D1 — Extração por componente, nunca big-bang

`ClinicAgendaView.tsx` NÃO é reescrito. Cada nova superfície entra como:

1. Um novo diretório `src/features/clinic/<superficie>/` com componentes próprios (view + modais + subcomponentes).
2. Um novo entry `tabs.push({ id, label, render: () => <Superficie/> })` em `ClinicAgendaView.tsx` (a estrutura de abas já existe — `AuthorizationsTab`, `ConnectionTab`, `ProfessionalsPanel`, `RoomsPanel`, `OperatorsPanel`, `ProceduresPanel` são todas invocadas assim).

Isso mantém `ClinicAgendaView.tsx` como **shell de navegação** que vai encolhendo à medida que subcomponentes migram — sem risco de quebrar a agenda que hoje funciona pra ~40 recepcionistas.

### D2 — Reusar os padrões visuais já cristalizados no ADR-080

Os componentes de referência no `ClinicAgendaView.tsx` (linhas 767–1738) já definiram o "sotaque" do módulo Clínica: painel dividido (lista à esquerda + editor à direita), badges com paleta `zinc/emerald/amber/rose`, modal via portal, form controlado com `useState` local, chamada REST direta com `fetch('/api/clinic/...', { credentials: 'include' })`. Novas superfícies replicam esse padrão — não introduzem biblioteca de forms, state manager, nem design system novo.

### D3 — PIN modal reusável (única exceção D2)

`discharge`, `reopen`, `issueGuide` — os 3 fluxos com PIN — compartilham UX (modal com lockout de 5×15min do backend F28). Vira 1 componente `<PinConfirmModal onConfirm={pin => ...} />` em `src/features/clinic/shared/PinConfirmModal.tsx`. Reusa `verifyPin` do backend; o modal só coleta e passa o PIN adiante, sem estado próprio.

### D4 — IA operacional é sugestão, nunca ação automática

Segue RN-014 do ADR-145 na UI:

- **Availability** (F47) — 3 cards de horário do MESMO profissional. Usuário clica pra pré-preencher o modal de novo agendamento. Nunca cria appointment sozinho.
- **Renewal signals** (F47) — badge no sidebar com `count(business_signals WHERE domain='clinic' AND signal_type LIKE 'cycle_%')`. Abrir mostra lista com botão "Renovar ciclo" (abre modal com formulário — humano confirma). Nunca renova sozinho.
- **Guide draft** (F48) — botão "Preencher com IA" no formulário de guia. Campos com `missing:true` do backend viram inputs vazios com label `⚠️ preencher manualmente — <motivo>`. Recepção nunca envia guia sem revisar.

### D5 — Aditivo ao roteamento; sem breaking

Nenhuma rota antiga muda. Nenhum componente antigo é removido. Feature flag por org (`clinic_ui_jornada_enabled` — default 0 até o cliente novo entrar em produção; default 1 depois da Fatia 6 estabilizada).

---

## Riscos

- **Bundle size** — `ClinicAgendaView.tsx` já é 3.363 linhas + jsPDF. Cada nova superfície adiciona ~200-400 linhas + dependências. **Mitigação:** lazy-load por aba (`React.lazy(() => import('./clinic/<superficie>'))`) — carrega só quando o usuário clica na aba.
- **Duplicação com backend** — tentador re-implementar validações no cliente. **Mitigação:** validação client-side é UX (feedback imediato); a validação de verdade permanece no service Node. Se contradizer, o service ganha.
- **Testes E2E** — Playwright não é obrigatório por fatia (backend cobre invariante). **Mitigação:** 1 fatia final de smoke test E2E cobrindo o happy path das 5 superfícies (Fatia 8, opcional — só entra se der tempo).
- **Regressão de estilo** — copiar/colar sem seguir D2 vira "cada superfície um design". **Mitigação:** revisar cada PR contra o `ProfessionalsPanel` como referência canônica.

---

## Fatias planejadas (8 fatias, ~5-8 dias)

Numeração continua a série do ADR-145 (F49 já foi Scheduler pass). **Este ADR é Fatia 50.**

| Fatia | Escopo                                                                                                | Consome                          | Status  |
|-------|-------------------------------------------------------------------------------------------------------|----------------------------------|---------|
| 50    | ADR-146 aceita + inventário do frontend + shell de navegação (aba stub por superfície)                | —                                | Esta PR |
| 51    | `<SpecialtiesPanel/>` — CRUD especialidades + vínculos N:N com profissional + botão "backfill legado" | F35 (`/clinic/specialties/*`)   | Pending |
| 52    | `<CareEpisodePanel/>` — abrir episódio + lista + transfer/hold/resume; alta/reopen via `PinConfirmModal` | F36 + F39 + F40 (`/clinic/care-episodes/*`) | Pending |
| 53    | `<TreatmentCyclePanel/>` — ciclo atual + usage derivada + fila de renovação + badge no sidebar         | F38 + F47 (`/clinic/care-episodes/:id/cycles`, `/clinic/renewal-tasks`) | Pending |
| 54    | `<ScheduleSessionModal/>` — sessão em grupo + participantes + `AvailabilitySuggestions` (F47)          | F41–F43 + F47 (`/clinic/schedule-sessions/*`) | Pending |
| 55    | `<GuideForm/>` polimorfo (3 tipos) + `<GuideDraftButton/>` + emissão com PIN + PDF preview + envio HMAC | F44–F46 + F48 (`/clinic/guides/*`) | Pending |
| 56    | `<JourneyMetricsHeader/>` + badge no sidebar dos sinais do `business_signals` (domain=clinic)           | F40 + F47                        | Pending |
| 57    | Smoke test Playwright E2E do happy path (criar episódio → agendar → completar → renovar → emitir guia) | todas                            | Pending |

Depois da Fatia 57, o **item #1 do meu ranking de "pra produção"** (ver conversa 2026-08-01) fica riscado. Sobra só o setup por-tenant (backfill + módulo on + config) e o runbook operacional (itens 3–7 daquele ranking).

---

## Guardrails da UI (não regredir)

1. **Nunca inventa dados que o backend marcou `missing:true`** — sempre input vazio + label de alerta.
2. **Nunca chama PIN endpoint sem passar por `PinConfirmModal`** — o lockout do backend depende do fluxo controlado.
3. **Nunca lista participantes de sessão de grupo no portal do paciente** — o backend já isola (F43); o front respeita e não tenta pedir a lista completa.
4. **Nunca renova ciclo ou dá alta sem 2 confirmações** — modal + PIN.
5. **Isolamento visual multi-tenant** — nenhum componente novo mistura dados de outra org (a rota já filtra; o front não tenta cache global).

---

## Convenções (novas nesta ADR)

- Diretório: `src/features/clinic/<superficie-kebab>/index.tsx` como entrada, subcomponentes no mesmo dir.
- Estilo: mesmo Tailwind + paleta do `ClinicAgendaView.tsx`.
- Fetch: `fetch('/api/clinic/...', { credentials: 'include' })` — sem cliente HTTP novo.
- Estado: `useState` + `useEffect`. Nada de Redux/Zustand.
- Toast: reusa o padrão já em uso (checar como `ProfessionalsPanel` avisa erro — copiar).
- PT-BR em labels; JSDoc PT-BR no header do arquivo, apontando pra fatia/ADR responsável.
