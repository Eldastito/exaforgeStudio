# ADR-049 — Notas de Reconhecimento (James Hunter, "O Monge e o Executivo")

**Status:** Implementado.

**Origem:** Hunter escreve que **liderar é servir**, e que servir começa por **reconhecer o esforço do outro** em voz alta. Dono de PME vive apagando incêndio: reconhecer fica no fim da lista, sempre. Mas o que se sabe:

- Cliente com nota máxima no CSAT que NÃO recebe agradecimento pessoal se sente número.
- Cliente que voltou depois de um problema é o mais valioso do funil — e recompensá-lo com silêncio é o mesmo que dizer "não me importei que voltou".
- Reconhecimento **automatizado 100% mata o valor** — se o cliente sabe que foi bot, o gesto perde peso. Precisa vir do dono.

Faltava um sistema que puxasse da memória do dono os momentos que merecem reconhecimento, e deixasse ELE decidir enviar.

---

## Decisão

`RecognitionNotesService` + tabela `recognition_notes`. **A IA SUGERE. O dono SEMPRE decide.**

**Triggers detectados:**
- `csat_high` — CSAT nota máxima (5).
- `loyal_repurchase` — recompra > N-ésima (para PR futuro conectar em SalesService).
- `high_ticket_order` — pedido acima da média (para PR futuro).
- `recovered_customer` — cliente do Radar de Recuperação Disney (ADR-047) que virou `resolved_positive`.
- `kind_message` — mensagem carinhosa do cliente (para PR futuro com classifier).

**Hooks já ativos:**
1. `SatisfactionService.record(orgId, surveyId, 5, ...)` → dispara `csat_high` para o contato. Score < 5 NÃO dispara.
2. `RecoveryRadarService.updateStatus(id, 'resolved_positive', ...)` → dispara `recovered_customer` para o contato do evento.

Ambos são **fire-and-forget** dentro de try/catch — nunca quebram o caminho crítico do serviço original.

**Mensagem sugerida** monta a partir de template curto (pt-BR, primeira pessoa, nome do cliente) + tom do Manifesto (ADR-045). Cai em `próximo e cordial` se o Manifesto está vazio. Deliberadamente curta — reconhecimento longo soa falso.

**Dedupe em janela de 30 dias por (org, target_type, target_id, trigger_type):** reconhecer 3 vezes seguidas o mesmo cliente por CSAT alto perde significado.

**Estados:** `suggested` → `sent` / `dismissed`. O dono revê, ajusta, clica em "Enviei" (marca `sent`) ou "Dispensar" (marca `dismissed`).

**UI:** card gradient rosa em `RecognitionInbox` na Home do dashboard. Cada linha expande com a mensagem completa e três botões: Copiar / Enviei / Dispensar. Some do dashboard quando não há sugestões (dashboard limpo).

**Métrica** (rota `GET /api/recognition`): `pending`, `sentPct` (só quando resolvidos ≥ 3, evita percentual enganoso), `byTrigger`.

## Consequências

**Positivas:**
- Cultura de reconhecimento vira **rotina do dono sem exigir disciplina** — a IA é memória, o dono é voz.
- Cliente que teve momento notável recebe atenção pessoal — retenção emocional.
- Recuperação bem-sucedida vira ciclo virtuoso: cliente reclamou → dono resolveu → dono agradeceu → cliente lembra.

**Negativas / mitigadas:**
- **Volume de sugestões pode viciar em ignorar** ("outra nota, dispenso"). Mitigado com dedupe 30 dias + card só aparece se há suggested.
- **Mensagem template pode soar falsa se enviada sem edição**. Mitigado com marca "RASCUNHO. Ajuste antes de enviar" no rodapé de toda mensagem sugerida.

## Testes

`scripts/test-tier2-recognition.ts` — **37 verificações**: detect + dedupe 30d + trigger diferente cria nota nova, isolamento entre orgs, list ordena suggested primeiro, `markSent`/`dismiss` + idempotência, metrics agrega, hook CSAT dispara em score=5 e NÃO em <5, hook Recovery dispara em `resolved_positive` e NÃO em `escalated_human`, Manifesto injetado no tom da mensagem, guards de input inválido.
