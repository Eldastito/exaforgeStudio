# Runbook — Operar o Customer Recovery & Reputation (PRD 5 / ADR-162)

> **Regra de ouro:** o Reclame AQUI é **um sensor externo**, não uma caixa de entrada nova. O caso de reclamação vive na espinha (`business_signals` + `correlation_id`), não numa tabela `reputation_cases`. Nada aqui abre motor/policy/alerta paralelo — tudo reusa o que já existe.

## 1. O que o módulo é (mapa mental)

Ciclo fechado, uma fatia por etapa (F1–F13), com hardening na F14:

```
detectar (F2) → identificar (F3) → classificar (F4) → investigar (F5) →
recomendar (F6) → aprovar/encaminhar (F7) → responder (F8) → resolver (F9) →
réplica/fechar (F10) → prevenir (F11) → aprender (F12) → medir (F13)
```

- **Percepção**: o conector puxa reclamações (F2) → viram `business_signal` `domain='reputation'`, `signalType='public_complaint'`, `basis='estimate'` (alegação, nunca fato automático — RN-CRR-2).
- **Contexto**: identidade multi-chave (F3) re-sujeita o sinal ao contato; conteúdo externo é **cercado** (`untrusted_external_data`, RN-CRR-1).
- **Decisão**: classificação/high-risk (F4) → investigação com grounding (F5) → recomendação governada (F6). Nada executa sem aprovação humana (RN-014).
- **Execução**: resposta pública (F8) e resolução material (F9) passam pelo choke-point (`CommandExecutorService.execute`, G1/G2/G3). O provider é tocado **só** pelo handler (D4).
- **Aprendizado**: prevenção de escalada (F11), root cause + baseline (F12), impacto/KPI (F13).

## 2. Habilitar por tenant (opt-in, reversível)

Todas as flags são `organization_settings.*`, default **OFF** (convenção #10):

| Flag | Liga |
| --- | --- |
| `reputation_engine_enabled` | guarda-chuva do módulo |
| `reclame_aqui_connector_enabled` | o conector Reclame AQUI |
| `radar_external_signals_enabled` | o contrato de ingestão externa (pré-requisito) |
| `reputation_prevention_enabled` | detector de escalada (F11) |
| `pattern_memory` | root cause & learning (F12) |

**Credenciais** do conector: `PUT /api/reputation/connector { provider, config:{baseUrl,token}, enabled }` — cifradas (`config_enc`), nunca em log. `GET` devolve status **redigido** (sem token).

## 3. Endpoints (todos owner/admin, isolados por org)

- `GET/PUT /api/reputation/connector` · `POST /api/reputation/sync` — conector + ingestão incremental (F2).
- `POST /api/reputation/cases/:signalId/resolve` — identidade + contexto + classificação (F3/F4).
- `POST /api/reputation/cases/:signalId/investigate` — causa provável + grounding (F5).
- `POST /api/reputation/cases/:signalId/recommend` — recovery playbook (F6).
- `GET /api/reputation/cases/:signalId/view` · `POST .../handoff` — central Fala Tu + handoff (F7).
- `POST /api/reputation/cases/:signalId/reply/draft` · `POST /api/reputation/actions/:actionId/publish` — resposta pública governada (F8).
- `POST /api/reputation/actions/:actionId/resolve` — resolução material (F9).
- `POST /api/reputation/cases/:signalId/sync-replies` · `POST .../close` — réplica + fechamento (F10).
- `GET /api/reputation/escalation-risk[/run]` — prevenção (F11).
- `GET /api/reputation/root-cause[/learn]` — root cause & learning (F12).
- `GET /api/reputation/impact` · `POST /api/reputation/actions/:actionId/impact` — KPI + atribuição (F13).
- **`GET /api/reputation/health`** — prontidão do módulo (F14): comece sempre por aqui.

## 4. Diagnóstico — comece sempre pela Saúde

`GET /api/reputation/health` devolve `status` (healthy/degraded/blocked) + `recommendations`. Gestão por exceção:

### Incidente: conector **auth_expired / unavailable** (status `blocked`)
Credencial venceu ou o provedor caiu. A ingestão **degrada explicitamente** (nunca fabrica) — o caso não é perdido, o cursor não avança. Reconfigure via `PUT /connector`; a publicação de resposta degrada pra `manual_required` (o operador publica fora de banda).

### Incidente: conector **stale** (parou de sincronizar)
`health.connectors[].stale=true` (sem sync há >24h ou nunca sincronizou). Rode `POST /api/reputation/sync`. O sync é incremental por cursor e idempotente (dedupe `external:<source>:<id>`) — re-rodar é seguro.

### Incidente: **rate-limit de resposta** atingido (status `blocked`)
`rateLimit.canReply=false` (≥30 respostas públicas em 24h). É um **backstop de runaway**, não gate de negócio. `POST .../publish` recusa com `rate_limited` até a janela abrir. Se for legítimo, investigue por que tantas respostas saíram; o teto (`MAX_REPLIES_PER_DAY`) protege a reputação da conta no provedor.

### Incidente: **backlog alto** de casos abertos
`backlog.openCases` grande → triar na Smart Inbox (F7). Casos high-risk (F4) sobem sozinhos (severidade `critical`); os demais entram por prioridade.

### Incidente: **réplica não fecha o caso**
`backlog.pendingReplyConfirmations` alto = respostas publicadas sem fechamento. Rode `POST .../sync-replies` (puxa a réplica do consumidor) e feche com `POST .../close { resolution }`. Réplica nova num caso fechado **reabre** o caso (§31).

## 5. Guardrails que NÃO se regridem (RN-CRR)

- **Dado externo é untrusted** (RN-CRR-1): sempre cercado; nunca instrução de sistema.
- **Alegação ≠ fato** (RN-CRR-2): reclamação é `estimate`; só vira fato com evidência interna (grounding, F5).
- **Grounding obrigatório** (RN-CRR-3/§25): resposta factual sem evidência **não publica** (`UNSUPPORTED_CLAIM`).
- **High-risk conservador** (RN-CRR-4): acidente/fraude/LGPD/jurídico/imprensa → escala, humano decide; IA não responde autônomo.
- **Identidade segura** (RN-CRR-5): ambiguidade encaminha, nunca casa o cliente errado.
- **Idempotência** (RN-CRR-6): nunca responde/reembolsa/reenvia em duplicata (executor + `external_ref`).
- **Não inventa dinheiro** (RN-CRR-7): valor protegido só com valor real + evidência + atribuição; FACT/ESTIMATE/INFLUENCED nunca somados.
- **Baseline antes de causa** (RN-CRR-8): correlação ≠ causa; padrão é evidência, **nunca** ranking punitivo de funcionário.
- **Multi-tenant** (RN-CRR-9): org A nunca vê/responde/correlaciona/usa credencial da org B.
- **Autonomia progressiva** (RN-CRR-10): read-only → recomendação → execução aprovada → autonomia limitada; auto-resposta é o último estágio, opt-in, com kill switch.

## 6. Rollout escalonado (§82-§87)

DEV → **Shadow** (o sistema diz "eu teria classificado/recomendado/escalado assim", sem efeito) → org interna → **1 cliente piloto** → **approved_execution** (humano aprova cada resposta — o default de hoje) → controlled rollout → autonomia limitada. Cada subida exige evidência de precisão/grounding/approval-rate/zero falha grave.

**Kill switches finos:** `reputation_engine_enabled` (módulo) · conector (`reputation_connectors.enabled`) · flags por etapa (prevenção/aprendizado). Desligar qualquer um é reversível e não perde histórico.

## 7. Checklist de go-live numa org

1. `reputation_engine_enabled` + `radar_external_signals_enabled` = 1.
2. `PUT /connector` com baseUrl+token; `reclame_aqui_connector_enabled` = 1.
3. `POST /sync` → confere ingestão em `business_signals` (`GET /health` → connectors connected, não stale).
4. Rodar em **shadow**: classificar/investigar/recomendar sem publicar; revisar amostras.
5. Ligar resposta em **approved_execution** (humano aprova cada `publish`). Grounding ativo.
6. `reputation_prevention_enabled` + `pattern_memory` quando o backlog estiver sob controle.
7. Monitorar `GET /health` (status/recommendations) e `GET /impact` (problemas resolvidos = North Star, §55).
