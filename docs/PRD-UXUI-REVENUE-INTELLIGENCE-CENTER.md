# PRD UX/UI + Design System — Revenue Intelligence Center (RIC)

> Documento **implementável**: descreve a interface do RIC com detalhe suficiente
> para codar direto, sem inventar. Complementa o `PRD-REVENUE-INTELLIGENCE-CENTER.md`
> (que diz **o que** o RIC faz). Este diz **como a tela é construída**.
>
> **Princípio-mãe:** o RIC não é "mais um dashboard". É a **cabine de comando
> financeira** da empresa. Ao abrir, o gestor sente que entrou num centro de
> controle onde cada indicador é dinheiro — em risco, recuperado ou em oportunidade.
> Mas a sofisticação visual **nunca** atropela a honestidade do número.

---

## 0. Reconciliação com o PRD funcional (decisões que travam o design)

O design abaixo segue o **escopo congelado**. Três pontos que aparecem em
rascunhos antigos foram corrigidos aqui de propósito:

1. **Sem IPA/IPC/IPO/IPF.** A tela mostra **IQR (mestre) + 3 drivers nomeados —
   Atendimento, Comercial, Operacional — + IRR/RRI**. É o que o backend emite
   (`GET /api/analytics/revenue-intelligence`). Nada de 4 siglas novas.
2. **Dinheiro = "potencial em risco", nunca número "duro" como certeza.** Todo
   valor de perda carrega o rótulo *"potencial em risco"* + tooltip com a premissa
   (`money.ticket.source`, `money.formula`). O simulador exibe sempre o
   `guardrail` e marca cada premissa como `history` ou `assumption`.
3. **Sem janela retroativa de 90 dias.** Gráficos de tendência são **ao vivo /
   desde a conexão** (o trial acumula pra frente). Rotular "desde a conexão".

---

## 1. Identidade visual — equilíbrio (novo command-center × app atual)

O ZappFlow já é **dark + indigo + Inter**. O RIC **evolui** essa base para um
clima de cabine de comando, sem virar um corpo estranho. Regra: **reusa os
tokens do app; adiciona uma camada premium só onde gera "uau".**

### 1.1 Design tokens (extensão de `src/index.css`)

```css
@theme {
  /* --- Superfícies do RIC (mais profundas que o app, p/ sensação de "comando") --- */
  --color-ric-bg:        #0b1020;  /* fundo da tela RIC (entre o #0f172a atual e o #111633 proposto) */
  --color-ric-surface:   #111833;  /* card base */
  --color-ric-surface-2: #16203f;  /* card elevado / hover */
  --color-ric-border:    #243152;  /* borda sutil */
  --color-ric-grid:      #1b2440;  /* linhas de gráfico */

  /* --- Marca (mantém o indigo do app como primário) --- */
  --color-ric-primary:   #4f46e5;  /* ação primária — já é o primary do app */
  --color-ric-primary-2: #6366f1;  /* hover / ring */

  /* --- IA (acento NOVO e distintivo: ciano) --- */
  --color-ric-ai:        #29d3ff;  /* tudo do Diretor IA: borda do painel, ícone, glow */
  --color-ric-ai-soft:   rgba(41, 211, 255, 0.10);

  /* --- Semântica de dinheiro (variantes command-center, derivadas das do app) --- */
  --color-ric-recovered: #36e39a;  /* RRI — receita recuperada (verde vivo) */
  --color-ric-recoverable:#ffb648; /* IRR — recuperável (âmbar) */
  --color-ric-risk:      #ff8a4c;  /* potencial em risco (laranja) */
  --color-ric-critical:  #ff5b5b;  /* crítico */

  /* --- Raio: equilíbrio entre 8px atual e 24px proposto --- */
  --radius-ric-card: 16px;   /* cards (rounded-2xl) */
  --radius-ric-hero: 20px;   /* blocos hero / painel IA */
}
```

> **Tipografia:** Inter (já no app) para corpo e UI. **Sora** opcional **só** para
> os números-herói (IQR, R$ grandes) — peso 700, tracking apertado. Se Sora não
> for carregada, cai em Inter 800 (degrade gracioso, sem bloquear).

### 1.2 Cores semânticas — significado fixo (não reusar fora disso)

| Token | Cor | Significa |
|---|---|---|
| `ric-recovered` | verde `#36e39a` | dinheiro que **já voltou** (RRI) — a prova de ROI |
| `ric-recoverable` | âmbar `#ffb648` | dinheiro **recuperável** (IRR) |
| `ric-risk` | laranja `#ff8a4c` | **potencial em risco** (perda estimada) |
| `ric-critical` | vermelho `#ff5b5b` | ação crítica / IQR baixo |
| `ric-ai` | ciano `#29d3ff` | **voz da IA** — exclusivo do Diretor Executivo |

IQR usa escala por faixa: ≥80 verde · 60–79 âmbar · <60 vermelho.

---

## 2. Onde o RIC vive (navegação)

- Novo item de menu **"Revenue Intelligence"** no topo do Workspace (`Sidebar.tsx`),
  ícone `Gauge` ou `Radar` (lucide), `viewMode === 'rie'`.
- Gating: as rotas `/api/analytics/*` são **core** (não bloqueadas). O item de
  menu fica sob o módulo `diretor` (o Diretor IA é a interface, conforme o PRD) —
  `{mod('diretor') && <NavItem .../>}`. Sem novo módulo no backend.
- Para o owner, o RIC é candidato a **landing padrão** pós-login (decisão de
  implementação; default atual é `kanban`). MVP: não mexer no default, só adicionar
  o item. Tornar landing fica como toggle posterior.

---

## 3. Layout da Home do RIC

Grid de 12 colunas, `max-w-[1400px]`, `gap-5`, fundo `ric-bg`, padding `p-6`.
Ordem de leitura = ordem de prioridade (dinheiro primeiro, depois o "porquê",
depois "o que fazer").

```
┌─────────────────────────────────────────────────────────────────────────┐
│ HEADER: "Revenue Intelligence" · seletor de período · [Exportar PDF]      │
├─────────────────────────────────────────────────────────────────────────┤
│ FAIXA DE DINHEIRO (4 KPI cards, 12 cols → 4×3)                            │
│  [Em risco]  [Recuperável]  [Recuperado RRI]  [ROI / Ticket-base]         │
├──────────────────────────────────────────┬──────────────────────────────┤
│ IQR + 3 DRIVERS (8 cols)                  │ DIRETOR IA — painel fixo (4)  │
│  ┌ IQR gauge ┐ ┌ Atend ┐┌ Com ┐┌ Op ┐    │  voz ciano, recomendação +    │
│                                           │  [Recuperar Agora]            │
├──────────────────────────────────────────┴──────────────────────────────┤
│ TOP 5 AÇÕES PRIORITÁRIAS (8 cols)         │ FONTES DA PERDA (4 cols)      │
│  lista priorizada, cada uma com R$ e CTA  │  barras por fonte             │
├──────────────────────────────────────────┴──────────────────────────────┤
│ TENDÊNCIA "desde a conexão" (8 cols)      │ SIMULADOR rápido (4 cols)     │
│  área/linha: risco vs recuperado          │  2 alavancas, premissas       │
└─────────────────────────────────────────────────────────────────────────┘
```

Mobile (`<lg`): tudo empilha em 1 coluna; o painel do Diretor IA vai logo abaixo
da faixa de dinheiro (continua sendo o 2º bloco mais importante).

---

## 4. Componentes — inventário + binding ao backend

Todos em `src/features/rie/` (novo diretório). Cada um consome endpoints **já
existentes**. Nenhuma chamada nova de backend é necessária para o MVP visual.

### 4.1 `MoneyKpiCard`
- **Props:** `label, value (R$), tone, sublabel, trend?, info?`
- **Binding:** `snapshot.money.estimatedLoss / .recoverable / .recovered`.
- 4º card: **Ticket-base** (`money.ticket.value` + selo `source`) — honesto, em
  vez de ROI inflado. ROI fica fora do MVP (precisa custo da assinatura).
- **Regra de honestidade:** card "Em risco" sempre traz o chip *"potencial em
  risco"* e um `info` (tooltip) com `money.formula` + premissa do ticket.
- **Microanimação:** count-up de 0→valor em 600ms (ease-out) no mount; quando o
  valor muda (refresh/socket), pulso suave + delta `+R$ X` que sobe e some.

### 4.2 `IqrGauge`
- **Binding:** `snapshot.iqr.score`, `snapshot.iqr.weakestDriver`, `.narrative`.
- Semicírculo 0–100, cor por faixa, número-herói (Sora). Abaixo: `narrative`
  ("IQR caiu porque Atendimento…"). Arco anima do 0 ao score em 800ms.

### 4.3 `DriverCard` (×3)
- **Binding:** `snapshot.drivers.{atendimento|comercial|operacional}` → `score`
  + `breakdown`.
- Card com score, barra, e os 2-3 itens do `breakdown` que mais derrubam o score
  ("1ª resposta 320s", "3 orçamentos parados"). Clique → **drilldown** (4.7).
- Borda esquerda colorida por tom do score.

### 4.4 `DirectorPanel` (painel fixo da IA — não é chat escondido)
- **Binding:** `GET /api/executive/briefing` (recomendação) + `POST
  /api/executive/ask` (campo de pergunta inline opcional).
- Visual: superfície `ric-surface-2`, **borda e glow ciano** (`ric-ai`), avatar/ícone
  `BrainCircuit` ciano, texto da recomendação em destaque, CTA primário
  **[Recuperar Agora]** que leva à ação correspondente (ex.: abre Campanhas/Cadências
  com o segmento dormente, ou rola até Top 5 Ações).
- Estado "pensando": shimmer ciano. O painel **atualiza** quando uma ação é
  recuperada (sensação de "sistema vivo").
- Reusa a lógica da `ExecutiveView` atual, reembalada como painel (não tela cheia).

### 4.5 `TopActionsList` (Top 5 ações prioritárias)
- **Binding (MVP):** derivado client-side do snapshot — ordena `lossSources` por
  `amount` desc + drivers fracos, gera até 5 linhas. (Fase 2: endpoint dedicado.)
- Cada linha: rótulo, R$ potencial, e CTA contextual ("Reativar 12 inativos",
  "Cobrar 3 PIX pendentes"). Tom da fonte (risco/recuperável).

### 4.6 `LossSourcesBars`
- **Binding:** `snapshot.lossSources[]` → label, count, prob, amount.
- Barras horizontais ordenadas por `amount`. Cada barra mostra `count × prob%`
  ao hover (transparência da fórmula).

### 4.7 `DriverDrilldown` (drawer/modal)
- Abre ao clicar num `DriverCard`. Mostra o `breakdown` completo (todos os itens
  com score parcial) + link "ver no relatório completo". Sem novo endpoint.

### 4.8 `SimulatorWidget`
- **Binding:** `POST /api/analytics/revenue-intelligence/simulate`.
- 2 abas (alavancas): **Tempo de resposta** (slider de segundos) e **Follow-up**
  (slider de % de cobertura). Mostra `delta.extraRevenue` em destaque.
- **Guardrail visível:** banner com `result.guardrail`; cada premissa de
  `assumptions[]` vira um campo editável com selo **"histórico"** (verde) ou
  **"premissa"** (âmbar) conforme `source`; editar → re-`POST` → recálculo.
- Nunca mostra número fechado como certeza — sempre "estimativa".

### 4.9 `TrendChart`
- **Binding (MVP):** `snapshot` atual (ponto único "agora") + acumulação
  client-side por sessão, rotulado **"desde a conexão"**. (Fase 2: série
  persistida.) Recharts (já no projeto). Área risco (laranja) vs recuperado (verde).

### 4.10 `ExportAuditButton`
- **Binding:** `POST /api/analytics/revenue-intelligence/audit-pdf` (`{ period,
  includePlan: true }`) → baixa o PDF. Estado de loading enquanto gera (o plano
  30/60/90 chama LLM, pode levar alguns segundos).

### 4.11 `ConfigDrawer` (calibrar a fórmula)
- **Binding:** `GET/POST /api/analytics/revenue-intelligence/config`.
- Sliders/inputs para probabilidades, janelas, pesos do IQR, ticket override.
  Reforça a mensagem: "estes números são seus, ajuste-os".

---

## 5. Estados (obrigatórios em todo card)

1. **Loading:** skeleton shimmer na cor da superfície (não spinner solto).
2. **Sem dado (empty):** mensagem honesta + CTA ("Sem orçamentos ainda — conecte
   o WhatsApp e comece a medir"). Nunca mostrar R$ 0 sem contexto.
3. **Erro:** card com borda `ric-critical` + "Não consegui carregar · tentar de
   novo".
4. **Premissa vs histórico:** selo sempre visível onde o número vem de premissa.

---

## 6. Animações & microinterações (a sensação de "vivo")

- **Count-up** nos números-herói no mount (600–800ms, ease-out).
- **Arco do IQR** anima 0→score.
- **Recuperação:** quando RRI sobe, `+R$ X ✓ Recuperado` sobe e dissolve; o card
  recuperado pulsa verde; o `DirectorPanel` re-renderiza a recomendação.
- **Hover** nos cards: leve elevação (`ric-surface → ric-surface-2`) + sombra.
- Usar `motion` (já é dependência). Respeitar `prefers-reduced-motion`.

---

## 7. Responsividade & acessibilidade

- Breakpoints Tailwind padrão. `<lg` empilha; `<sm` reduz números-herói.
- Contraste mínimo AA sobre `ric-bg` (verificar laranja/âmbar — usar texto escuro
  sobre chips claros se necessário).
- Toda cor semântica acompanha **texto/ícone** (não depender só de cor — daltônicos).
- Foco visível (ring `ric-primary-2`), navegação por teclado nos CTAs e no simulador.

---

## 8. Mapa endpoint → componente (referência rápida)

| Endpoint | Componente(s) |
|---|---|
| `GET /revenue-intelligence?period=` | MoneyKpiCard, IqrGauge, DriverCard, LossSourcesBars, TopActionsList, TrendChart |
| `GET/POST /revenue-intelligence/config` | ConfigDrawer |
| `POST /revenue-intelligence/simulate` | SimulatorWidget |
| `POST /revenue-intelligence/audit-pdf` | ExportAuditButton |
| `GET /revenue-intelligence/audit` | (opcional: pré-visualização das 10 seções) |
| `GET /executive/briefing`, `POST /executive/ask` | DirectorPanel |

---

## 9. Roadmap de implementação (PRs de front, na ordem)

1. **Tokens + shell:** estende `index.css`, cria `RevenueIntelligenceView`, nav item,
   grid vazio com skeletons.
2. **Faixa de dinheiro + IQR + drivers:** MoneyKpiCard, IqrGauge, DriverCard +
   binding ao snapshot. (Já é o "uau" principal.)
3. **Diretor IA painel + Top 5 ações + fontes da perda.**
4. **Simulador + Config drawer + Export PDF.**
5. **Tendência + drilldown + microanimações de recuperação.**

Cada PR é navegável e testável isoladamente. O backend de todos já existe.

---

## 10. Disciplina

Este documento **fecha o escopo visual do MVP do RIC**. Novas ideias visuais
(ROI calculado, tendência persistida de 90 dias, ranking/gamificação, tema claro)
vão para "Fase 2" — não entram no MVP. O objetivo do MVP é: abrir o RIC e, em 5
segundos, **ver onde está o dinheiro** — com credibilidade, não com fogos de artifício.
