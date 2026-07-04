# ADR-039 — Fashion AI Studio, FAS-5: memória de estilo (encerra o PRD-E-006)

**Status:** Implementado e testado (22 verificações novas, suíte completa sem quebras — 38 scripts, `lint`/`build` limpos). Com esta entrega, **todas as 6 fases do PRD-E-006 estão implementadas** (FAS-0 a FAS-5, ADRs 034–039).
**Origem:** PRD-E-006, sexta e última entrega.

## O que o FAS-5 entrega

A consultora passa a lembrar — com aceite e controle total da cliente (seção 11 do PRD).

### 1. Feedback explícito de look (11.2)

Botões "👍 Gostei / 👎 Não gostei / 🚫 Não usaria" em cada card de look. O feedback grava as **categorias** das peças (nunca inferência de atributo — 11.3 respeitada por construção: só categoria de produto, dado do catálogo). Um feedback por look: mudar de ideia substitui o anterior (histórico preservado inativo). Recusado com aviso claro quando a personalização está desligada — sem aceite, nada é gravado.

### 2. Sinais observados alimentando as recomendações

`styleMemorySummary`: categorias **curtidas** e **recusadas** (do feedback) + categorias **compradas** — estas vêm da atribuição pedido↔look do FAS-4, encadeada `orders.fashion_look_id → fashion_looks → fashion_look_requests → customer_id` (a memória é estritamente da cliente; testado que outra cliente não herda nada). Uso em duas camadas:
- **IA**: o resumo entra no prompt como contexto explícito ("histórico com aceite da cliente... orientação sutil, priorize o que ela declarou HOJE") — a explicação continua citando só o que a cliente declarou.
- **Determinístico (fallback)**: categoria marcada "não usaria" sai do conjunto elegível — **a menos que a exclusão zere as opções** (melhor sugerir algo do que nada; caso real encontrado pelo teste quando o look recusado continha todas as categorias da loja).

### 3. Toggle de personalização (11.4)

Desligar **para de salvar e de usar** a memória — o questionário continua funcionando com as respostas da sessão, mas nada é persistido e o histórico não entra no prompt/fallback. **Não apaga nada** (apagar é o controle separado que já existe desde o FAS-1: apagar preferência a preferência, ou apagar tudo). Desligar revoga o consentimento `personalization`; religar o reconcede e volta a usar o que já existia.

### 4. Cliente recorrente (J-004)

Abrir o questionário com preferências salvas **pré-preenche** estilo, cores/peças evitadas e orçamento (a ocasião fica sempre em branco — é o contexto de hoje). O passo "Minhas preferências" no modal lista tudo que está salvo (incluindo os feedbacks de look, legíveis), com exclusão individual e o toggle de personalização.

## O que fica documentado como futuro (seção 12 do PRD, fora de escopo por decisão do próprio PRD)

Armário inteligente, consultora de acessórios, Visual Harmony Assistant (sem nota de beleza — restrição permanente) e atendimento híbrido. Também: "recomendações recorrentes opcionais" além do pré-preenchimento (ex.: aviso proativo por WhatsApp) — tocaria a IA de atendimento e merece a mesma cautela da ADR-029.

## Estado final do Fashion AI Studio (PRD-E-006 completo)

| Fase | Entrega | ADR |
|---|---|---|
| FAS-0 | Fundação: flag/kill switch, schema, catálogo elegível, telemetria | 034 |
| FAS-1 | Conta→lead, consentimento, foto guiada, storage privado assinado, retenção | 035 |
| FAS-2 | Questionário, consultora por ocasião, Look Builder anti-injection | 036 |
| FAS-3 | Try-on plugável, créditos diários, jobs assíncronos, resultado privado | 037 |
| FAS-4 | Carrinho do look, atribuição pedido↔look, link compartilhável | 038 |
| FAS-5 | Memória de estilo com feedback, compras e controle total da cliente | 039 |

Pendências conhecidas para produção (não são código): validar a **qualidade visual** do try-on com foto/peças reais da TOULON (ADR candidata A — trocar de provedor é plugável) e acompanhar as métricas de baseline por loja (seção 2.1 do PRD) via `fashion_events`.

## Validação

`npm run test:fashion-memory` (22 verificações) + suíte completa (38 scripts, zero quebras) + `lint`/`build` limpos. Destaques: feedback com substituição e ownership; memória por cliente (compras via cadeia de atribuição); exclusão determinística com a válvula de escape "nunca zerar o catálogo"; toggle desliga salvar+usar sem apagar, revoga/reconcede consentimento, e religar volta a funcionar.
