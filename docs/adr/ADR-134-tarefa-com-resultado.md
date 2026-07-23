# ADR-134 — Tarefa com resultado medido + evidência

- **Status:** Fatia 1 implementada (resultado antes→depois + evidência na tarefa).
- **Data:** 2026-07
- **Origem:** auditoria de veracidade da apresentação "ZappFlow Sobrevivência". A promessa "de tarefa concluída para problema resolvido" (problema → tarefa → responsável → prazo → **evidência** → **resultado medido**, ex.: "divergência reduzida de R$ 3.200 para R$ 420") era **parcial**: a tarefa (`TaskService`) tinha responsável e prazo, mas **não** carregava resultado medido nem evidência; o esperado×realizado vivia separado no Impact Ledger (`CashActionService`). Esta ADR une as pontas na própria tarefa.
- **Relacionadas:** `TaskService`, ADR-125 (Impact Ledger — esperado×realizado no eixo caixa), ADR-088 D5 (frugal), `uploads` (foto → URL pública).

## Decisões

### D1 — Resultado medido na tarefa (antes → depois)
`tasks` ganha `result_label`, `result_baseline` (o número do problema no início) e `result_final` (o número ao concluir). `TaskService.create` aceita `resultLabel` + `resultBaseline`; a tarefa nasce ligada ao problema. `hydrate` devolve um bloco `result` com `{ label, baseline, final, delta }` (delta = baseline − final = a redução).

### D2 — Evidência anexada
`tasks.evidence_url` guarda a foto/relatório que comprova a execução. O upload reusa `POST /api/uploads/image` (→ URL em `/media`). Sem storage novo.

### D3 — Concluir REGISTRANDO o resultado
`TaskService.recordResult(orgId, id, { resultFinal, evidenceUrl })` marca a tarefa como `feito`, grava o número final e a evidência, e registra em `task_updates` a narrativa "antes → depois (redução de X) · com evidência". Rota `POST /api/tasks/:id/result`. Na UI (`TasksView`), "Concluir" abre um modal que pede o valor final (quando há métrica) e permite **anexar a foto**; o card mostra "baseline → final (−delta)" e o link da evidência.

### D4 — Compatível e opcional
Tarefas sem métrica seguem funcionando (o bloco `result` fica nulo); concluir só com evidência (sem número) é permitido. Determinístico, isolado por `organization_id`.

## Consequências
**Positivas:** a tarefa deixa de ser só "feito/não feito" e passa a provar **resultado** (número antes→depois) com **evidência** — exatamente o que a apresentação mostra. Fecha a última das quatro frentes da auditoria.

**Trade-offs / escopo:** Fatia 1 mede um número único (baseline→final) por tarefa e anexa uma evidência. Ligar automaticamente esse resultado ao Impact Ledger do caixa e múltiplas evidências ficam como evolução futura.

## Testes
`test:task-result` — a tarefa guarda o resultado a medir + valor inicial; antes de concluir, final/delta ficam vazios; `recordResult` marca feito, grava final e delta (3200 → 420 = 2780) e a evidência; o `task_update` narra antes→depois com evidência; tarefa sem métrica não cria o bloco; concluir só com evidência funciona; isolamento por org (não conclui tarefa de outra org).
