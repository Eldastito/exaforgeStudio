# SIDEBAR-UX-AUDIT — classificação dos menus atuais (Fase 0)

Cada item da `Sidebar.tsx` (~38 tenant-facing + 6 master) classificado em **MANTER / ESCONDER /
AUTOMATIZAR / CONVERSAR / FUNDIR / DEPRECAR**. Regra dura (PRD §52/§80): **classificação é HIPÓTESE de
produto** — nada sai do 1º nível sem telemetria provando substituição, e **nada é apagado**. Cada item
gated por módulo/plano/vertical; a coluna "Gate" registra a condição atual.

Legenda das ações:
- **MANTER** — essencial e usado; fica no 1º nível.
- **ESCONDER** — necessário, mas não precisa do 1º nível → vai pra "Explorar" (2º nível).
- **AUTOMATIZAR** — a ação humana pode desaparecer (vira missão/rotina).
- **CONVERSAR** — acessível prioritariamente pelo Fala Tu.
- **FUNDIR** — duas experiências equivalentes viram uma.
- **DEPRECAR** — só quando telemetria comprovar substituição (nunca nesta fase).

---

## Tenant-facing

| Item (label) | viewMode | Gate | Hipótese de ação | Observação |
| --- | --- | --- | --- | --- |
| Central de Saúde | saude | `saude_negocio` | **MANTER** | Estado do negócio; alimenta "Hoje" |
| Insights | insights | — | **FUNDIR → Hoje** | Insights por exceção vivem melhor em "Hoje"/Fala Tu |
| Atendimento | kanban | — | **MANTER** | Operação diária de conversa |
| Revenue Intelligence | rie | `rie` | **CONVERSAR** | Pergunta ao Fala Tu ("como vão minhas vendas?") |
| Estúdio de Criação | studio | `estudio` | **MANTER** | Ferramenta criativa ativa |
| Beauty AI | beauty | `estudio`+beleza | **MANTER** | Vertical-específico |
| Tarefas | tarefas | `execucao` | **FUNDIR → Missões** | Tarefa é sub-unidade de missão (§25) |
| Prospect AI | prospect | `prospect` | **MANTER** | Motor B2B ativo |
| Radar B2B | radar_b2b | `prospect` | **ESCONDER** | Sub-tela de prospect |
| Diretor IA | diretor | `diretor` | **CONVERSAR** | Decisão via Fala Tu (§27) |
| Agenda | agenda | `agenda` | **MANTER** | Operação central |
| Agenda Clínica | clinica | `clinica` | **MANTER** | Vertical |
| Reservas | reservas | `reservas` | **MANTER** | Vertical |
| Assinaturas | assinaturas | `assinaturas` | **MANTER** | Receita recorrente |
| Comigo | comigo | `copiloto` | **MANTER** | Balcão/PDV |
| Catálogo | catalog | `catalogo` | **MANTER** | Base de produtos |
| Vendas | vendas | `vendas` | **MANTER** | Operação central |
| Operação da Rede | retailops | `retail` | **MANTER** | Multi-loja |
| Atendimento de Loja | retailfloor | `retail_floor` | **MANTER** | Chão de loja |
| Compras | compras | `compras` | **MANTER** | Suprimento |
| Orçamentos | orcamentos | `orcamentos` | **MANTER** | Pré-venda |
| Eventos & Grupos | eventos | `eventos` | **MANTER** | Vertical |
| Loja Virtual | storefront | `loja` | **MANTER** | Canal de venda |
| Campanhas | campanhas | `campanhas` | **AUTOMATIZAR** | Missão cria/dispara campanha (§4/§33) |
| Cadências | cadencias | `cadencias` | **AUTOMATIZAR** | Missão escolhe cadência |
| Vision VMS | vision | `vms` | **ESCONDER** | Uso especializado |
| Radar de Execução IA | radar | `radar` | **ESCONDER** | Vira capacidade invisível (§26); achados em "Hoje" |
| Canais e I.A. | channels | — | **MANTER** | Configuração de canal |
| Áreas de Atend. | areas | `areas` | **MANTER** | Roteamento |
| Contatos | contacts | — | **MANTER** | Base de clientes |
| Integrações | integrations | `integracoes` | **ESCONDER** | Setup, baixa frequência |
| Dashboard | dashboard | — | **FUNDIR → Hoje/Resultados** | Métricas por exceção, não permanentes (§22) |
| Caixa | caixa | `financeiro` | **MANTER** | Financeiro |
| Relatórios | reports | — | **CONVERSAR** | Resumo pelo Fala Tu (§28); detalhe em 2º nível |
| Consultora Jurídica | juridico | — | **CONVERSAR** | Pergunta pontual |
| Manifesto da Marca | manifesto | — | **ESCONDER** | Setup, baixa frequência |
| Escuta Ativa | escuta | — | **ESCONDER** | Baixa frequência |
| Configurações | settings | — | **AUTOMATIZAR** | observar→inferir→sugerir (§29, `InferredSettingsService`) |

## Master (fora do escopo de simplificação do usuário comum — MANTER todos)
Admin Master · Consumo de IA · Inteligência de Nicho · Prontidão de Produção · Radar Consultor ·
Radar Saúde → **MANTER** (público Master Admin; não contam pra simplificação do usuário comum).

## FalaTu
FalaTu (viewMode `falatu`, gate `falatuEnabled`) → **MANTER/PROMOVER** — vira interface universal (§30).

---

## Síntese

- **1º nível hoje:** ~38 itens tenant-facing (a maioria module-gated, então o usuário típico vê um
  subconjunto — a Fase 0 precisa da telemetria pra saber quantos CADA perfil realmente vê).
- **Candidatos a sair do 1º nível (ESCONDER/FUNDIR/CONVERSAR/AUTOMATIZAR):** ~14 — Insights, Tarefas,
  Radar B2B, Diretor IA, Vision, Radar Execução, Integrações, Dashboard, Relatórios, Jurídica,
  Manifesto, Escuta, Campanhas, Cadências, Configurações, Revenue Intelligence.
- **Hipótese de Sidebar-alvo (§24, a VALIDAR por A/B, não implementar cega):**
  `Hoje · Fala Tu · Missões · Resultados · Empresa ──── Explorar` (todo o resto vive em "Explorar").
- **Regra §83:** nenhum item novo (inclusive "Missões") entra sem passar as 7 condições + A/B (§74).
  **Regra §80:** tudo continua acessível via "Explorar"/Fala Tu até a telemetria provar substituição.
  **Nada é deletado nesta iniciativa.**
