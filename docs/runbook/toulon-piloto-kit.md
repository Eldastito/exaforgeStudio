# Kit operacional do piloto TOULON — homologação (preencher)

> Companheiro de execução do runbook `docs/runbook/toulon-piloto-homologacao.md`
> (o **como/por quê**). Aqui ficam os **formulários a preencher** durante o piloto:
> respostas de homologação, checklist por loja, log de 7 dias, evidências, DoD e
> aceite. Copie os blocos marcados **[TEMPLATE — copiar por loja]** para cada loja.
>
> Convenção: `[ ]` a fazer · `[x]` feito · `PASS`/`FAIL`/`N/A` no resultado ·
> "evidência" = link do screenshot/planilha/print no índice §6.

---

## 1. Estado do rollout (visão geral)

Ordem: **Avenida Brasil (baseline) → 2ª loja com vendedores mapeados → todas → 7 dias → aceite**.
Não expandir antes de **2 lojas** aprovadas.

| # | Loja | Código filial Alterdata | Estágio | Homologação | Data | Responsável |
|---|------|------------------------|---------|-------------|------|-------------|
| 1 | Avenida Brasil | `____` | baseline | ☐ pendente / ☐ em homolog. / ☐ **aprovada** | `__/__` | `______` |
| 2 | `____________` | `____` | 2ª loja | ☐ pendente / ☐ em homolog. / ☐ **aprovada** | `__/__` | `______` |
| 3 | `____________` | `____` | expansão | ☐ pendente / ☐ em homolog. / ☐ aprovada | `__/__` | `______` |
| … | | | | | | |

---

## 2. Respostas de homologação (§17 do PDR) — confirmar com a TOULON

Não bloqueiam as correções já entregues, mas são necessárias para o aceite.

| # | Pergunta | Resposta da TOULON | Quem | Data |
|---|----------|--------------------|------|------|
| 1 | Tarifa "fixa" do POS: por transação, mensal por terminal, ou outra? | `__________` | `____` | `__/__` |
| 2 | Vale só crédito, também débito, varia por parcela/bandeira? | `__________` | `____` | `__/__` |
| 3 | Nome correto do adquirente citado no áudio? | `__________` | `____` | `__/__` |
| 4 | Dispositivo, navegador e horário em que as boletas aparentaram zerar? | `__________` | `____` | `__/__` |
| 5 | Todas as lojas e seus códigos de filial Alterdata? | `__________` | `____` | `__/__` |
| 6 | Cadastro mestre de vendedores na Alterdata ou só `CAI_USUARIO`? | `__________` | `____` | `__/__` |
| 7 | O mesmo vendedor atua em mais de uma loja? (presumido: sim) | `__________` | `____` | `__/__` |
| 8 | Quais filiais usam código individual e quais caixa/login compartilhado? | `__________` | `____` | `__/__` |
| 9 | O "PF" citado era P.A, peças, valor ou outro indicador? | `__________` | `____` | `__/__` |
| 10 | Quem não conseguia salvar tinha papel owner/admin e escopo de todas as lojas? | `__________` | `____` | `__/__` |

**Bloqueiam a tarifa POS (§3A):** respostas 1 e 2 — sem elas, não confirmar a fórmula da tarifa.

---

## 3. Pré-requisitos por loja (conferir antes de iniciar)

**[TEMPLATE — copiar por loja]** — Loja: `______________`

- [ ] **Fuso** conferido (`organization_settings.timezone`; TOULON = `America/Sao_Paulo`).
- [ ] **Vendedores × loja** mapeados na tela *Vendedores da loja* — sem pendências de nome não resolvidas (ou justificadas como caixa compartilhado).
- [ ] **Tarifas POS** cadastradas (crédito/débito) conforme respostas §2.1–2.2.
- [ ] **Escopo do usuário** homologador = owner/admin com acesso à loja.
- [ ] **Código de filial** bate com o `filial` que chega no PDV (Alterdata).

---

## 4. Checklist de homologação por loja (roteiro §5)

**[TEMPLATE — copiar por loja]** — Loja: `______________` · Data: `__/__/____` · Responsável: `__________`

| # | Item (sintoma do relato) | Resultado | Evidência | Observação |
|---|--------------------------|-----------|-----------|------------|
| 1 | **Boletas após 21h** — passar das 21h (Rio), recarregar: contagem idêntica; duplo-clique não duplica | PASS/FAIL | `____` | |
| 2 | **Resultado por loja/rede** — abre; erro/timeout mostra mensagem + "Tentar de novo" (nunca "nenhuma loja"); 403 = sem permissão; p95 ≤ 2 s | PASS/FAIL | `____` | p95: `___` s |
| 3 | **Precificar** — aplicar em lote mostra confirmados + retry dos que falharam (sem sucesso otimista) | PASS/FAIL | `____` | |
| 4 | **Mais vendidos** — abre; item sem match aparece em âmbar com o código do ERP | PASS/FAIL | `____` | |
| 5 | **Salvar config financeira** — sucesso confirmado; 2º admin recebe 409, não sobrescreve | PASS/FAIL | `____` | |
| 6 | **Vendedores da loja** — cobertura correta; dar nome reflete na comissão; compartilhado sinalizado | PASS/FAIL | `____` | |
| 7 | **Comissão** — bate com a fonte; matrícula sem nome = pendência visível | PASS/FAIL | `____` | |
| 8 | **Cota total da loja** — mesmo número na corrida e no fechamento; divergência exibida | PASS/FAIL | `____` | |
| 9 | **Tarifas POS** — custo esperado usa a tarifa detalhada, sem dupla contagem | PASS/FAIL | `____` | |
| 10 | **Chip de conectividade** — queda do tempo real diz "reconectando" (não "caiu"); diagnóstico abre | PASS/FAIL | `____` | |

**Veredito da loja:** ☐ aprovada ☐ reprovada (ver observações) — assinatura: `__________`

---

## 5. Log de monitoramento de 7 dias (após 2 lojas aprovadas)

**[TEMPLATE — copiar por semana]** — Início: `__/__` · Loja(s): `__________`

| Dia | p95 Resultado por loja | Boletas ok no reload | Cache invalidou pós-fechamento | Chip = realtime (não "servidor caiu") | Incidentes / correlationId | Ação |
|-----|------------------------|----------------------|-------------------------------|---------------------------------------|----------------------------|------|
| 1 | `___` s | ☐ | ☐ | ☐ | `____` | `____` |
| 2 | `___` s | ☐ | ☐ | ☐ | `____` | `____` |
| 3 | `___` s | ☐ | ☐ | ☐ | `____` | `____` |
| 4 | `___` s | ☐ | ☐ | ☐ | `____` | `____` |
| 5 | `___` s | ☐ | ☐ | ☐ | `____` | `____` |
| 6 | `___` s | ☐ | ☐ | ☐ | `____` | `____` |
| 7 | `___` s | ☐ | ☐ | ☐ | `____` | `____` |

**Gate:** p95 ≤ 2 s em todos os dias; zero perda de boleta; nenhum falso alarme de servidor.
Rodar `npm run loadtest:retail-analytics` (volume ≥ TOULON) no ambiente-alvo e anexar o resultado (§6).

---

## 6. Índice de evidências (anexar ao PR/aceite)

| ID | Tipo | Loja | Descrição | Link |
|----|------|------|-----------|------|
| E1 | screenshot mobile | `____` | ranking do fechamento sem sobreposição | `____` |
| E2 | screenshot desktop | `____` | Resultado por loja com número / erro honesto | `____` |
| E3 | métrica antes/depois | `____` | tempo de carga Resultado (antes × depois) | `____` |
| E4 | resultado de suíte | — | saída de `npm run loadtest:retail-analytics` | `____` |
| E5 | print | `____` | boletas antes/depois do reload (mesma contagem) | `____` |
| … | | | | |

---

## 7. Definition of Done (§18) — sign-off

Marcar quando comprovado (evidência no §6). Sem todos, não há aceite.

- [ ] Critérios de aceite P0 e P1 passam.
- [ ] Mesma contagem de boletas antes e depois do reload.
- [ ] Nenhum `.catch(() => {})` em persistência financeira obrigatória.
- [ ] Nenhum toast de sucesso sem resposta confirmada.
- [ ] Todas as lojas com cobertura de vendedores documentada.
- [ ] Matrículas pendentes e códigos compartilhados visíveis.
- [ ] Escala, fechamento, corrida e comissão usam o mesmo vendedor canônico.
- [ ] Tarifa POS com fórmula, origem, vigência e sem dupla contagem.
- [ ] Resultado/Precificar/Mais vendidos distinguem erro de ausência de dados.
- [ ] Performance atende ao gate (p95 ≤ 2 s) no ambiente-alvo.
- [ ] RLS/RBAC e escopo de lojas com testes negativos.
- [ ] Feature flags e rollback documentados (runbook §2 + §10).
- [ ] Screenshots mobile/desktop + métricas antes/depois + suítes anexados.
- [ ] TOULON concluiu o roteiro em ≥ 2 lojas antes da expansão.

Responsável pelo sign-off técnico: `__________` · Data: `__/__/____`

---

## 8. Aceite formal da TOULON

> A TOULON confirma que homologou o piloto em ≥ 2 lojas, os gates de 7 dias se
> mantiveram e a Definition of Done está completa. Autoriza a expansão às demais.

- Lojas homologadas: `__________________________`
- Ressalvas / pendências aceitas: `__________________________`
- Nome / cargo: `__________________________`
- Assinatura / data: `__________________________`

---

## 9. Referência rápida — kill-switches (voltar atrás sem deploy)

Se uma correção regredir numa org durante o piloto (Fase 6B):

| Sintoma | Flag para desligar | Efeito |
|---------|--------------------|--------|
| Data comercial errada / boletas no dia trocado | `business_date` | volta ao dia UTC (comportamento pré-1A) |
| Números das analíticas suspeitos | `resolved_products` | volta a resolver por LIKE-prefix (lento, caminho antigo) |

```
# ler estado (owner/admin)
GET  /api/retailops/feature-flags
# desligar / religar
PUT  /api/retailops/feature-flags/business_date       { "enabled": false }
PUT  /api/retailops/feature-flags/resolved_products   { "enabled": true  }
```

Desligar é **por organização** e invalida o cache analítico. A equivalência
numérica ligado × desligado está provada em `test:retail-feature-flags` — o
switch é rede de segurança, não muda o resultado esperado. Reversão de fatia
inteira (não coberta por flag): §10 do runbook (revert do PR).
