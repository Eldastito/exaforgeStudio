# Runbook — CEO Operating Layer (ADR-190)

Camada TRANSVERSAL de gestão executiva. **Composição** sobre o que já existe (ADR-135/136/152/
160/163/189) — **sem** motor/scheduler/policy/alerta paralelo. Responde ao North Star (§4): o dono
pergunta *"Como está minha empresa?"* e recebe **pilares + desvios + restrição + evidências**.

## Mapa dos serviços (todos read-only, determinísticos, isolados por org)

| Fatia | Serviço | Papel |
| --- | --- | --- |
| F1/F2 | `BusinessGoalService` (estendido) | Registro executivo de métricas (`describe`/`measure`/`executiveCatalog`/`metricsByPillar`). `measure` HONESTO: sem fonte → `value:null`+`unknown`. |
| F3 | `ExecutiveVisionService` | Visão declarada pelo dono (intenção humana; nunca inventa). 5 colunas em `organization_settings`. |
| F4 | `ExecutiveBusinessSnapshotService` | **Primitiva central**: 3 pilares (comercial/operações/financeiro) + indicadores + metas + exceções + prioridades + missões + visão. Compõe `BusinessSnapshotV2` + `BusinessSignalService.attention` + `ImpactPrioritizationService`. |
| F5 | `ExecutiveConstraintService` | Pilar em pior forma + restrição nº1 (HIPÓTESE, nunca causa provada). |
| F6 | `ExecutiveMissionBridgeService` | Sugere (nunca cria) missão pros desvios que ameaçam metas. |
| F7 | `ExecutiveFinanceService` | Financeiro rico (liquidez/recebíveis/rentabilidade/retiradas) — composição do `FinanceSnapshotAdapter`. |
| F8 | `ExecutiveAdvisorService.executiveBlock` | Injeta a Visão Executiva determinística no panorama do Diretor IA (IA narra, não calcula). |
| F9 | `FalaTuHomeService.executiveToday` | Leitura executiva no "Hoje" por exceção (invisible UX, sem menu). |

## Rotas (`/api/executive/*`, todas owner/admin — §73)

- `GET /vision` · `PUT /vision` — ler/gravar a visão.
- `GET /snapshot` — snapshot executivo (3 pilares).
- `GET /constraint` — pior pilar + restrição.
- `GET /mission-suggestions` — rascunhos de missão sugeridos.
- `GET /finance` — financeiro executivo.
- `GET /briefing` · `POST /ask` — Diretor IA (já existiam; agora consomem a Visão Executiva).

## Fluxo "Como está minha empresa?"

1. `snapshot` → 3 pilares com saúde (crítico/atenção/ok/`unknown`) + indicadores honestos.
2. `constraint` → o pilar em pior forma + a restrição nº1 (o desvio a resolver primeiro — HIPÓTESE).
3. `mission-suggestions` → se a restrição ameaça uma meta, um RASCUNHO de missão (o dono confirma).
4. `finance` → o detalhe financeiro (inadimplência, caixa, margem) role-gated.
5. Diretor IA (`briefing`/`ask`) NARRA tudo isso; o "Hoje" do Fala Tu mostra por exceção.

## Guardrails RN-CEO-01..15 (codificados em `test:ceo-hardening`)

1. **Composição não motor** — zero tabela nova de CEO; tudo compõe o existente.
2. **null ≠ zero** — sem fonte → `value:null`/`unavailable`, NUNCA 0.
3. **Fato ≠ hipótese** — a restrição sai `hypothesis`; o basis do desvio é o real.
4. **IA não calcula KPI** — os números vêm derivados; a IA só narra (§43).
5. **Executado ≠ resultado** — herdado da espinha (não se afirma resultado sem outcome).
6. **Sugerir ≠ criar** — o Mission Bridge nunca escreve missão; a visão nunca é inventada.
7. **Governança intacta** — nenhuma rota executa; propostas seguem RBAC/ApprovalPolicy.
8. **Isolamento** — toda leitura filtra `organization_id`.
9. **Dinheiro role-gated** — `includeMoney:false` redige BRL; rotas owner/admin.
10. **Sem fonte → unknown** — availability honesta por métrica.
11–15. Sem sinal/executor/mission/learning paralelo; Complexity Budget (§63: +0 motor, +0 tabela).

## Rollout / troubleshooting

- **Rollout**: a camada é aditiva e read-only — nasce ligada (sem flag), pois não muda nada (só
  LÊ e compõe). O único estado gravável é a visão (F3), opt-in pelo dono.
- **"Pilar sem dado" (`unknown`)**: é honesto — a org não tem fonte pra aqueles indicadores ainda.
  Não é bug; é a ausência de fonte sendo reportada como ausência (não como 0).
- **"Sem restrição"**: não há desvio aberto priorizável — negócio sem exceção crítica agora.
- **Dinheiro não aparece pra um usuário**: esperado se ele não tem visão completa do negócio (§73).
- **Adicionar um indicador executivo**: estender `BusinessGoalService.METRICS` com
  `pillar`/`basis`/`source`/`betterDirection`/`availability` — o snapshot o pega automaticamente.
