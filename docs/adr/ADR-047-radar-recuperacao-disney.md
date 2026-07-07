# ADR-047 — Radar de Recuperação Disney (Tier 2)

**Status:** Implementado.

**Origem:** *"O Jeito Disney de Encantar os Clientes"* ensina que **quando algo dá errado, a RECUPERAÇÃO se torna o momento memorável — não a falha**. A maioria das PMEs vive o oposto: cliente reclama, dono/atendente resolve na correria, não documenta, não mede taxa de recuperação. O cliente que voltou some da conta; o que não voltou vira "chato". Faltava um sistema que:

1. **Registra** cada problem event (cancelamento, PIX vencido, reclamação, atraso) para poder medir.
2. **Sugere um playbook** em 4 passos Disney para o dono/atendente atuar com padrão de marca (empatia + responsabilidade + solução + algo pessoal).
3. **Mede** taxa de recuperação (`resolved_positive / total encerrados`) — a métrica que grandes têm e a maioria de PMEs não.

---

## Decisão

`RecoveryRadarService` + tabela `recovery_events`.

**Entrada única** via `detect(input)` — chamado por rotas, Scheduler ou pelo Radar de Oportunidades (ADR-046) para `complaint_detected`. Idempotente: se já existe evento ATIVO (`triggered` ou `playbook_sent`) para o mesmo contato+trigger nos últimos 7 dias, atualiza contexto e devolve o existente — não duplica.

**Triggers suportados:**
- `order_cancelled` — pedido cancelado
- `pix_expired` — PIX venceu sem pagamento
- `complaint_detected` — reclamação detectada (via Opportunity Radar)
- `delay_detected` — cliente mencionou demora
- `delivery_delayed` — entrega atrasou

**Playbook Disney (4 passos):**
1. **Reconhecer** com empatia — "vi aqui que…"
2. **Assumir** responsabilidade — "quero entender o que aconteceu do meu lado…"
3. **Resolver** com opção real — "posso gerar novo pedido/PIX/prazo…"
4. **Cuidado pessoal** — NÃO desconto genérico. Prioridade no próximo atendimento, marcar contato, algo pessoal.

O playbook é **template + tom do Manifesto (Tier 1)** quando disponível. Se o Manifesto está vazio, usa "próximo e cordial" como fallback.

**Sempre RASCUNHO.** A execução (enviar mensagem, aplicar mimo) fica com o humano — recuperação genérica automática é PIOR do que problema não recuperado. O radar só sugere e rastreia.

**Estados:** `triggered` → `playbook_sent` → `resolved_positive` / `resolved_neutral` / `escalated_human` / `dismissed`.

**Métrica principal (rota `GET /api/recovery/metrics`):**
- `recoveryRate = resolved_positive / (resolved_positive + resolved_neutral + escalated_human)` no período.
- Se denominador < 5, retorna `null` — evita percentual enganoso com amostra pequena.

**Hook cruzado:** quando um `recovery_event` vira `resolved_positive`, dispara `RecognitionNotesService.detect()` com trigger `recovered_customer` (ADR-049). O cliente que voltou depois de um problema MERECE uma nota curta do dono.

## Consequências

**Positivas:**
- Recuperação vira **processo consciente e mensurável**, não improviso.
- Padrão Disney trazido pra PME com efort quase-zero (o dono edita rascunho, envia).
- Taxa de recuperação — a métrica antes invisível — vira card no dashboard.

**Negativas / mitigadas:**
- Playbook template pode soar frio se não editado. Mitigado: SEMPRE marcado "RASCUNHO. Ajuste antes de enviar." + tom do Manifesto injetado.
- Sobrecarga se muitos eventos abertos. Mitigado: `list()` ordena por status (triggered primeiro) e por criação DESC, limit 100.

## Testes

`scripts/test-tier2-recovery-radar.ts` — **30 verificações**: detect cria evento + gera playbook em 4 passos, dedupe 7 dias por contato+trigger, playbook usa nome do contato e tom do Manifesto, `updateStatus` com transições e persistência de `resolved_at`, métrica `recoveryRate` retorna `null` quando amostra insuficiente, isolamento entre orgs, hook Opportunity → Recovery para reclamações individuais.
