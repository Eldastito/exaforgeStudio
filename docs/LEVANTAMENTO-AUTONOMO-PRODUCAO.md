# Levantamento — Vertical Autônomo em produção (ZappFlow Comigo / Copiloto)

> Documento de levantamento (não é ADR, não é spec de implementação). Fotografa o
> que **existe hoje no código**, o que **falta**, e lista **todas as funcionalidades
> que o empreendedor autônomo precisa** no seu negócio, com análise de reuso e
> faseamento sugerido. Base para decidir escopo antes de abrir os PRs de produção.
>
> Fontes: ADR-088 (ZappFlow Comigo), ADR-091 (grade de planos), ADR-092
> (distribuição por vertical), ADR-082 (Continuity/offline), ADR-085 (Impact
> Ledger), `src/server/plansGrade.ts`, `src/server/verticals.ts`,
> `src/server/ModuleService.ts`.

---

## 0. TL;DR (o achado que muda tudo)

**O "Autônomo" hoje é só um PLANO com o encanamento comercial pronto — o PRODUTO que
entrega valor ao autônomo NÃO existe em código.**

- O plano **Autônomo** (R$247/R$197) está implementado: billing (ASAAS mockado),
  limites, migração de grade, gating de módulos, trial, somente-leitura. ✅
- Esse plano promete um módulo chamado **`copiloto`** ("precificação, quanto vale
  minha hora"). Mas `copiloto`:
  - **não está** em `OPTIONAL_MODULES` (`verticals.ts`),
  - **não tem** rótulo/descrição em `ModuleService.MODULE_META`,
  - **não tem** view, rota, serviço nem tabela.
  - É literalmente **uma string na lista de módulos do plano** (`plansGrade.ts:16`),
    sem nada por trás.
- O ADR-088 (ZappFlow Comigo) — a visão rica do produto do autônomo (Balcão PDV por
  toque, Mesa/QR, tutor de precificação, termômetro de saúde) — está marcado como
  **"Proposto… sem código ainda"**. Confirmado: **0% implementado.**

**Conclusão:** "colocar a vertical autônomo em produção" = **construir o produto do
autônomo do zero** (ADR-088), reaproveitando peças existentes. Não é ligar uma flag.

---

## 1. Decisão conceitual a resolver ANTES de codar

Há uma ambiguidade de vocabulário que precisa ser fechada, porque muda a arquitetura:

| Visão | O que diz | Onde está |
|---|---|---|
| **"Autônomo é PLANO, não vertical"** | Um autônomo pode ser de qualquer vertical (serviços, moda, food, saúde). O plano recorta o teto; a vertical é a wishlist. | ADR-091, ADR-092 §3 (implementado) |
| **"ZappFlow Comigo é um PRODUTO próprio"** | Porta de entrada própria, sub-marca, 3 superfícies (Balcão/Mesa/Comigo), onboarding por arquétipo — "não organiza a estrutura, ele É a estrutura". | ADR-088 (não implementado) |

As duas **não se contradizem** se lidas assim: o **plano Autônomo** é o teto comercial;
o **`copiloto`/Comigo** é o **módulo-produto** que dá corpo a esse plano. O que falta é
justamente esse módulo. **Recomendação:** tratar como **módulo `copiloto` (marca
"Comigo")** ligado no plano Autônomo, e não como uma 8ª vertical — mantém coerência com
ADR-092 e evita duplicar presets. As "verticais" do autônomo (marmita, unha, chaveiro,
foodtruck) viram **arquétipos** dentro do módulo (ADR-088 D1), não novas `VerticalKey`.

**Decisão que preciso de você:** confirmamos `copiloto`/Comigo como **módulo** (recomendado)
ou você quer mesmo uma **vertical** separada? O resto do levantamento assume módulo.

---

## 2. Estado atual — o que já dá pra reaproveitar

Boa notícia: muita fundação existe. O produto do autônomo é mais **montagem + orquestração**
do que engine nova.

| Peça existente | Onde | Serve ao autônomo para |
|---|---|---|
| Atendimento IA multicanal (WhatsApp/IG) | core | Captação e atendimento (o "chegou-e-comprou") |
| Agenda + lembretes (Google Calendar) | módulo `agenda` | Hora marcada (unha, cabelo, terapia) e anti-no-show |
| Catálogo de produtos/serviços | módulo `catalogo` | Base única de itens (flui pro cardápio/loja) |
| Loja/Storefront + carrinho | `src/storefront/` | Base do cardápio-QR e do checkout |
| Pagamento PIX manual + Stone/Pagar.me (link) | `PaymentService` | Pix estático "recebi" (nível 1) e cartão (link) |
| Transcrição de áudio (Whisper) | `llm.ts` / import por IA | Cadastro por áudio e pedido por áudio |
| Extração por IA (PDF/imagem) | `SmartImportService` | Cadastro rápido de itens por foto |
| Snapshot/trend diário | Impact Ledger (ADR-085), `RetailImpactService` | Base do termômetro de saúde e do paywall "valor provado" |
| Camada offline/sync | Continuity (ADR-082), `ContinuityService`/`EdgeSyncService` | Venda na feira/praia sem sinal |
| Motor de diagnóstico/arquétipo | `RetailDiagnosticService.recommend/apply` | Onboarding por 3 perguntas (reusar p/ arquétipos autônomos) |
| PWA (parcial) | `public/site.webmanifest` | Instalável no celular (falta service worker/offline shell) |
| Billing/plano/limites/somente-leitura | ADR-091 (Blocos A–D) | Grátis→pago, boosts, paywall |
| Isolamento multi-tenant + LGPD | core | Cada autônomo é um tenant; dado de faturamento é sensível |

---

## 3. Lista COMPLETA de funcionalidades que o autônomo precisa

Organizada por jornada. Legenda de estado: ✅ existe · 🟡 parcial (reusar+adaptar) ·
🔴 não existe (construir). Cada linha aponta o reuso.

### A. Onboarding & identidade do negócio
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| A1 | Onboarding por **arquétipo** (3 perguntas: o que faz? hora marcada×balcão? fixo×móvel?) que liga só os pilares certos | 🔴 | Reusa `RetailDiagnosticService`; falta preset de arquétipos autônomos (ADR-088 D1) |
| A2 | Porta de entrada própria (sub-marca "Comigo", tom de tutor) | 🔴 | Landing atual é enterprise e "assusta" (ADR-088) |
| A3 | PWA instalável no celular + atalho | 🟡 | Tem `site.webmanifest`; falta service worker/instalação guiada |
| A4 | Pausar/voltar o negócio sem atrito (sazonalidade: barraca some no inverno) | 🔴 | Precisa estado "pausado" que não cobra nem apaga dado |

### B. Cadastro de itens (baixo atrito é requisito, não luxo)
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| B1 | Cadastro **por áudio** ("bolo de pote P, R$8; galeto inteiro R$45") | 🔴 | Whisper existe; falta o parser áudio→produto (ADR-088 D2) |
| B2 | Cadastro por **foto** (IA extrai nome/preço) | 🟡 | `SmartImportService` existe; ligar num fluxo de 1 item |
| B3 | Base única: item cadastrado vira cardápio + loja + PDV ao mesmo tempo | 🟡 | Catálogo↔Storefront já compartilham; validar p/ o autônomo |

### C. Balcão — venda por toque (o operador)
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| C1 | **PDV por toque**: clica na foto → quantidade → cobra | 🔴 | Storefront é vitrine, não PDV de balcão; construir tela minimalista |
| C2 | Fila de pedidos em background + "pedido da vez" + contador | 🔴 | Novo (ADR-088 §"Balcão") |
| C3 | **Sessão do cliente** por apelido (sem login), adicionar itens depois | 🔴 | Novo (ADR-088 D4) |
| C4 | Marcar **consumo local × viagem** (afeta embalagem/preço/fiscal) | 🔴 | Novo |
| C5 | Venda **offline** na feira/praia + sync ao voltar sinal | 🟡 | Continuity/EdgeSync existe; ligar no fluxo de venda |

### D. Mesa/QR — autoatendimento (o cliente final)
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| D1 | QR na mesa → cardápio → pede | 🟡 | Storefront serve de base; falta modo "mesa/QR" |
| D2 | **Pagar antes** (pay-first): pedido só cai na fila do Balcão quando pago | 🔴 | Novo (ADR-088 D4) — elimina calote/fiado |
| D3 | Sem atendente / sem login | 🔴 | Novo |

### E. Pagamento
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| E1 | **Pix estático** (chave/QR fixo) + operador toca "recebi" | 🟡 | `pix_manual` existe; adaptar UX do Balcão (ADR-088 D3 nível 1) |
| E2 | **Pix dinâmico via PSP** (txid único, webhook confirma, libera fila sozinho) | 🟡 | Base Stone/Pagar.me + webhook existe; falta Pix dinâmico c/ conciliação por `txid` (ADR-088 D3 nível 2) |
| E3 | Cartão (link de pagamento) | ✅ | Stone/Pagar.me link (ADR-100 Fase 1) |
| E4 | Taxa do Pix/PSP entra no custo (não é esquecida) | 🔴 | Depende do motor de precificação (F) |

### F. Copiloto de precificação — **o coração do produto** (ADR-088 D6)
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| F1 | **Ficha técnica viva** unificando revenda / fabricação / serviço | 🔴 | Novo — o motor central; nada equivalente hoje |
| F2 | **"Quanto vale sua hora?"** — tempo como insumo do serviço | 🔴 | Novo |
| F3 | Lista de **custos que você esquece** (gás, energia, embalagem, transporte, taxa Pix, aluguel da cadeira) | 🔴 | Novo |
| F4 | **Loop estimativa→realidade**: recalibra rendimento e custo real a cada fechamento; registra merma/perda | 🔴 | Novo — o "IP defensável" |
| F5 | Sugestão de preço com **guarda-corpo** (não espantar cliente, ensinar sem humilhar) | 🔴 | Novo; usa LLM só na ponta |
| F6 | Trabalha com **chute** e melhora com o real (nunca trava por "não sei quanto gastei") | 🔴 | Novo |

### G. Saúde do negócio — termômetro (ADR-088 D7)
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| G1 | **Sinal único** subindo/estável/caindo com toggle dia/semana/mês | 🟡 | Reusa snapshot/trend do Impact Ledger; falta a leitura "termômetro" |
| G2 | **Comparar mesmo período** (sábado×sábado passado) — obrigatório p/ sazonal | 🔴 | Novo |
| G3 | Pesar **lucro, não faturamento** (sobe quando sobra mais dinheiro) | 🔴 | Depende do motor de custo (F) |
| G4 | **Ticket médio** (vendas÷pedidos) | 🟡 | Relatórios já derivam; expor no formato do autônomo |
| G5 | **Ponto de equilíbrio** + barra de meta ao vivo ("12 de 22 pra empatar o dia") | 🔴 | Novo; liga no contador da fila |
| G6 | **Uma frase + uma ação** ("o milho subiu, reajuste o saquinho G") | 🔴 | Novo; LLM na ponta |

### H. Sugestão / upsell
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| H1 | "Mais pedidos / sugestão da casa / quem pediu isso também levou" — **zero-token** (market-basket) | 🔴 | Novo; ranking/co-ocorrência pré-computado (ADR-088 D5) |
| H2 | Desejo escrito pelo cliente ("algo leve", "sou vegetariano") → **LLM + RAG do cardápio** | 🟡 | RAG existe; ligar no fluxo Mesa/QR |

### I. Monetização & graduação (ADR-088 D8/D10)
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| I1 | Começa **grátis** (agenda, Balcão, caixa) | 🟡 | Billing existe; falta o tier/trial "grátis até provar valor" do Comigo |
| I2 | **Paywall = ganho provado** ("esse mês você recuperou R$240") | 🟡 | Impact Ledger/PerformanceFee existe; falta a narrativa do autônomo |
| I3 | **Boosts** avulsos (post automático, Pix dinâmico, catálogo) | 🔴 | Add-ons existem no motor; falta empacotar p/ autônomo |
| I4 | Onboarding/suporte **zero-toque** (sem venda consultiva) | 🔴 | Novo fluxo self-service |
| I5 | Faseamento **pedagógico** (registrar venda → quanto sobrou → quanto custa → quanto cobrar → metas) | 🔴 | Novo; desbloqueio por maturidade |
| I6 | **Graduação MEI + nota fiscal** (formalização) | 🔴 | Não existe (buraco fiscal atual); futuro |

### J. Transversais (obrigatórios pra produção)
| # | Funcionalidade | Estado | Reuso / gap |
|---|---|---|---|
| J1 | Isolamento por `organization_id` + auditoria em toda escrita | ✅ | Core |
| J2 | LGPD (faturamento é dado sensível do negócio) | ✅ | Core + consentimento por vertical |
| J3 | Frugalidade de token (IA generativa só onde é insubstituível) | 🟡 | Princípio; aplicar em H/G/F |
| J4 | Acessibilidade de baixo letramento (áudio/foto/voz como requisito) | 🟡 | Peças existem; padronizar |

---

## 4. Onde está o esforço real (resumo do gap)

- **Pronto/reusável (✅/🟡):** todo o comercial (plano, billing, limites, somente-leitura),
  atendimento IA, agenda, catálogo, storefront-base, PIX manual + cartão, Whisper,
  SmartImport, Impact Ledger (snapshot/trend), Continuity offline, PWA parcial.
- **Construir do zero (🔴) — o núcleo de valor:**
  1. **Motor de precificação / ficha técnica viva** (F) — o coração; nada equivalente.
  2. **Balcão PDV por toque + fila + sessão do cliente** (C) — storefront é vitrine, não PDV.
  3. **Mesa/QR pay-first** (D).
  4. **Termômetro de saúde + ponto de equilíbrio + meta ao vivo** (G).
  5. **Onboarding por arquétipo + porta própria "Comigo"** (A).
  6. **Sugestão zero-token (market-basket)** (H1).

O `copiloto` precisa virar módulo de verdade: entrar em `OPTIONAL_MODULES`, ganhar
`MODULE_META`, view, rotas e serviço(s).

---

## 5. Faseamento sugerido (espelha o MVP do ADR-088 §"Escopo")

**Fatia 1 — MVP "sócio no celular" (destrava o produto):**
A1 arquétipos · B1/B2 cadastro áudio+foto · C1 Balcão por toque · E1 Pix estático "recebi" ·
F1/F3/F4 motor revenda+fabricação com calibração pelo real · G1/G4/G5 termômetro básico +
ticket médio + ponto de equilíbrio · I1/I2 grátis + paywall Impact Ledger · A3 PWA + C5 offline.

**Fatia 2 — autoatendimento e serviço:**
D1/D2/D3 Mesa/QR pay-first · E2 Pix dinâmico com webhook (conciliação por `txid`) ·
H2 sugestão LLM+RAG · F2 serviço-com-tempo ("quanto vale sua hora").

**Fatia 3 — graduação:**
I6 formalização MEI + nota fiscal · I5 progressão pedagógica completa · I3 boosts.

---

## 6. Pendências NÃO-código para produção (bloqueadores externos)

Herdadas do ADR-091 e específicas do autônomo:
- **Chave sandbox ASAAS** (billing real; hoje mockado).
- **Revisão jurídica** (política de cobrança/cancelamento, somente-leitura, LGPD do dado de faturamento).
- **PSP com Pix dinâmico + webhook** contratado (Mercado Pago/Efí/Asaas/Cora) para E2 — **não** construir sobre leitura de notificação de banco (ADR-088 D3, rejeitado).
- **Unit economics:** ticket baixo só fecha com escala + toque zero — um autônomo que exige suporte humano dá prejuízo (ADR-088 riscos).

---

## 7. Próximo passo

1. Você confirma o enquadramento do §1 (**`copiloto`/Comigo como módulo**, arquétipos em vez de vertical).
2. Fechamos o **escopo da Fatia 1** (proponho começar pelo par **Balcão PDV (C1)** + **motor de precificação (F1/F3/F4)**, que é o menor caminho até o "número que a pessoa nunca teve").
3. Abro um ADR de implementação da Fatia 1 e os PRs focados, um por vez (método do backlog TOULON).
