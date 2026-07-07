# ADR-046 — Radar de Oportunidades Disfarçadas + Journal de Frustrações (Tier 2, Carlos Domingos)

**Status:** Implementado.

**Origem:** Carlos Domingos ("A Bíblia do Marketing Digital", cap. sobre problemas) escreve: *"problema é sinal, não fim"*. PME vive tratando ocorrência como incêndio e apagando — e perdendo a informação que a ocorrência carrega. Duas oportunidades passavam batido:

1. **Sinais que a IA vê mas o dono não** — cliente reclama por WhatsApp, pesquisa CSAT vem baixa, pedido cancela, cliente some depois de X dias. Cada um é uma OPORTUNIDADE disfarçada de problema.
2. **Frustrações do próprio dono** — dono no dia-a-dia fala "hoje ninguém pagou o pix", "cliente sumiu", "essa semana caiu vendas". Esses insights se perdem: dono resolve o incêndio, não escreve nada, e depois esquece o padrão.

---

## Decisão

Dois serviços paralelos, cada um com sua tabela, sua rota, sua UI de digestão semanal.

### 1. Radar de Oportunidades Disfarçadas

`OpportunityRadarService` roda de forma **passiva** — não bloqueia nenhum fluxo — via passe do Scheduler (diário). Tabela `opportunity_events`.

Detectores:
- **`complaint_detected`** — mensagem inbound com termos-gatilho (reclamação, atraso, pedido errado, decepção).
- **`csat_low`** — pesquisa CSAT respondida com nota ≤ 3.
- **`order_cancelled_unnusual`** — cancelamento em contato que era frequente.
- **`customer_ghosting`** — contato ativo por >X mensagens sumiu por >Y dias.
- **`repeat_pain`** — mesmo cliente disparou dois eventos negativos em 7 dias.

Cada evento vira uma linha com `severity` e uma sugestão em texto (âncora no Manifesto). Digest semanal via rota `GET /api/opportunity-radar/weekly` retorna top oportunidades ordenadas por gravidade × recência.

**Hook cruzado (importante):** o Radar de Oportunidades dispara automaticamente o Radar de Recuperação Disney (ADR-047) para o subset de eventos que merecem playbook de recuperação. Sinergia intencional — Domingos ("problema é sinal") + Disney (recuperação = momento memorável).

### 2. Journal de Frustrações

`FrustrationJournalService`. Tabela `frustration_journal`. UI dedicada (`EscutaAtivaView`) com input livre: dono anota o que deu errado hoje, IA categoriza automaticamente (`estoque`, `pagamento`, `atendimento`, `entrega`, `time`, `outro`) e sugere próximo passo. Digest semanal agrega por categoria e destaca a que mais aparece — o padrão vem à tona sem esforço de reflexão.

## Consequências

**Positivas:**
- Duas fontes de "sinal" que antes se perdiam viram fluxo estruturado.
- Digest semanal = uma reunião consigo mesmo no domingo à noite.
- Padrão emerge sem exigir disciplina de escrita analítica do dono.

**Negativas / mitigadas:**
- **Detecção heurística pode falsar** (falso positivo em `complaint_detected`). Mitigado por marcar cada evento como "sugestão" — o dono descarta o que não faz sentido. E as categorias do Journal usam LLM (não regex), com fallback determinístico.
- **Volume de eventos pode overwhelm** — mitigado por severity + top-N no digest (não é lista corrida).

## Testes

`scripts/test-tier2-escuta-ativa.ts` — **26 verificações**: detecção de reclamação por keyword, isolamento entre orgs, CSAT baixo dispara evento, dedupe por contato+tipo em janela, digest agrega top-3 por severidade × recência, frustration.categorize funciona com LLM e com fallback determinístico.
