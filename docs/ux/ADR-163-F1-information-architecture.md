# ADR-163 F1 — UX Information Architecture (nav-alvo × Sidebar atual)

**Fatia:** PRD 6 / ADR-163 — F1 (Information Architecture). **Natureza:** documento de design.
**Regra inviolável desta fatia:** **mapear, não remover.** Nenhum módulo, rota ou entrada de menu é eliminado aqui — F1 só define o **destino** de cada item na nav por NECESSIDADE. A remoção de redundâncias é a **F12**, e só depois que a telemetria (F10) provar substituição (§107/§112, RN-UX-5).

> Complementa a **F2** (`NavigationManifestService.forUser`), que já deriva a nav-alvo em runtime de `EntitlementService.overview` + RBAC. Este doc é o **racional humano** por trás daquele manifesto: por que cada superfície existe e onde cada um dos ~40 itens do `src/features/Sidebar.tsx` atual pousa.

---

## 1. O problema de IA (hoje)

`src/features/Sidebar.tsx` (178 linhas) lista **~40 entradas** num único bloco "Workspace" em JSX inline, cada uma gated por `mod('...')`/`canAccessModule('...')`. É uma lista por MÓDULO (o que o sistema tem), não por NECESSIDADE (o que o usuário precisa agora). O usuário precisa **saber onde a funcionalidade mora** — exatamente o que o PRD 6 quer inverter (§6-7, §96).

## 2. A nav-alvo (por necessidade)

Seis superfícies. As cinco primeiras são **1º nível** (o que o usuário precisa); os módulos viram **2º nível "Explorar"** (o que o sistema oferece) — nunca sumindo, só descendo um nível.

| Superfície | Pergunta que responde | Entregue por |
| --- | --- | --- |
| **Hoje** | "O que precisa de mim agora?" | `FalaTuHomeService.home` (F3) — exceção + resolvido-desde-ontem + metas |
| **Fala Tu** | "Deixa eu só falar/pedir." | Fala Tu (captura multimodal) |
| **Executando** | "O que o ZapFlow está fazendo?" | `ExecutionResultsService.executing` (F8) |
| **Resultados** | "O que isso produziu?" | `ExecutionResultsService.results` (F8) — Impact Ledger + metas |
| **Empresa** | "Ajustar objetivos/autonomia/equipe/config." | (gestor) config estratégica + operacional |
| **Explorar** (2º nível) | "Abrir um módulo específico." | `NavigationManifestService.explore` (F2) — só módulos `active`+visíveis |

## 3. Mapa: cada item do Sidebar atual → destino (nada removido)

**Legenda de destino:** 🏠 Hoje · 🎙️ Fala Tu · ⚙️ Executando · 📊 Resultados · 🏢 Empresa · 🧭 Explorar (2º nível) · 👑 Plano Master (fora da nav do lojista).

| Item atual (Sidebar) | Gate | Destino | Racional |
| --- | --- | --- | --- |
| Central de Saúde (`saude`) | `saude_negocio` | 🏠 Hoje | Atenção/saúde do negócio é o "hoje por exceção". |
| Insights (`insights`) | — | 🏠 Hoje | Sinais que pedem atenção convergem no Hoje. |
| Escuta Ativa (`escuta`) | — | 🏠 Hoje | Percepção externa → atenção. |
| Diretor IA (`diretor`) | `diretor` | 📊 Resultados | Panorama executivo é leitura de resultado. |
| Revenue Intelligence (`rie`) | `rie` | 📊 Resultados | Métrica/receita. |
| Dashboard (`dashboard`) | — | 📊 Resultados | Visão agregada. |
| Relatórios (`reports`) | — | 📊 Resultados | Exportações/leitura. |
| Caixa (`caixa`) | `financeiro` | 📊 Resultados (gestor) | Financeiro consolidado; role-gated (§73). |
| Tarefas (`tarefas`) | `execucao` | ⚙️ Executando | Trabalho em andamento. |
| Atendimento (`kanban`) | — | ⚙️ Executando | Casos em curso. |
| Radar de Execução IA (`radar`) | `radar` | ⚙️ Executando | Processos monitorados. |
| Operação da Rede (`retailops`) | `retail` | ⚙️ Executando | Operação em curso. |
| Atendimento de Loja (`retailfloor`) | `retail_floor` | ⚙️ Executando | Operação de chão de loja. |
| Cadências (`cadencias`) | `cadencias` | ⚙️ Executando + 🧭 | Automação rodando; config no módulo. |
| Campanhas (`campanhas`) | `campanhas` | ⚙️ Executando + 🧭 | Disparo em execução; criação no módulo. |
| FalaTu (`falatu`) | flag | 🎙️ Fala Tu | A porta de captura. |
| Canais e I.A. (`channels`) | — | 🏢 Empresa | Configuração de canais/integração. |
| Áreas de Atend. (`areas`) | `areas` | 🏢 Empresa | Estrutura de atendimento. |
| Contatos (`contacts`) | — | 🏢 Empresa | Cadastro base. |
| Integrações (`integrations`) | `integracoes` | 🏢 Empresa | Conexões. |
| Manifesto da Marca (`manifesto`) | — | 🏢 Empresa | Config estratégica. |
| Consultora Jurídica (`juridico`) | — | 🏢 Empresa | Apoio/consulta. |
| Configurações (`settings`) | — | 🏢 Empresa | Ajustes da conta. |
| Agenda (`agenda`) | `agenda` | 🧭 Explorar | Módulo vertical. |
| Agenda Clínica (`clinica`) | `clinica` | 🧭 Explorar | Módulo vertical. |
| Reservas (`reservas`) | `reservas` | 🧭 Explorar | Módulo vertical. |
| Assinaturas (`assinaturas`) | `assinaturas` | 🧭 Explorar | Módulo vertical. |
| Comigo (`comigo`) | `copiloto` | 🧭 Explorar | Módulo vertical. |
| Catálogo (`catalog`) | `catalogo` | 🧭 Explorar | Módulo vertical. |
| Vendas (`vendas`) | `vendas` | 🧭 Explorar | Módulo vertical. |
| Compras (`compras`) | `compras` | 🧭 Explorar | Módulo vertical. |
| Orçamentos (`orcamentos`) | `orcamentos` | 🧭 Explorar | Módulo vertical. |
| Eventos & Grupos (`eventos`) | `eventos` | 🧭 Explorar | Módulo vertical. |
| Loja Virtual (`storefront`) | `loja` | 🧭 Explorar | Módulo vertical. |
| Estúdio de Criação (`studio`) | `estudio` | 🧭 Explorar | Módulo vertical. |
| Prospect AI (`prospect`) | `prospect` | 🧭 Explorar | Módulo vertical. |
| Radar B2B (`radar_b2b`) | `prospect` | 🧭 Explorar | Módulo vertical. |
| Vision VMS (`vision`) | `vms` | 🧭 Explorar | Módulo vertical. |
| Admin Master (`admin`) | master | 👑 Plano Master | Fora da nav do lojista. |
| Consumo de IA (`ai_usage`) | master | 👑 Plano Master | Fronteira de custo (§50) — Admin. |
| Inteligência de Nicho (`niche_intel`) | master | 👑 Plano Master | ADR-156 — Admin. |
| Prontidão de Produção (`production_readiness`) | master | 👑 Plano Master | Operação — Admin. |
| Radar — Consultor / Saúde (`radar_consultant`/`radar_health`) | master | 👑 Plano Master | Operação — Admin. |

**Cobertura:** todos os ~40 itens têm destino. **Zero** removido. As entradas 👑 saem da nav do lojista mas seguem no plano master (já é assim hoje via gate master).

## 4. Invariantes de IA (o que a nav-alvo NÃO faz)

- **Não remove rota** (§94/RN-UX-5). `viewMode` legado continua válido; F2 só reordena a apresentação. A remoção é a F12, guiada pela telemetria da F10.
- **Não vira catálogo de cadeados** (§56/D3). "Explorar" lista só o que está `active` e visível; fora-de-plano é oferta situacional (F9), não item apagado.
- **Não infla o 1º nível.** Cinco superfícies fixas; todo o resto desce pra "Explorar". Um item novo precisa provar por que não cabe numa superfície existente (§8).
- **Respeita RBAC/entitlement** (CA14). O destino nunca burla permissão: "Empresa" só pro gestor; itens sensíveis herdam o gate atual.

## 5. Próximo passo (fora desta fatia)

- **Frontend (F2 já entregou o backend):** `Sidebar.tsx` passa a renderizar `GET /api/entitlements/navigation-manifest` sob a flag `simplified_navigation_enabled` — legado intacto quando desligada.
- **F12 (depois da telemetria):** só quando `ux_telemetry_events` (F10) mostrar que a superfície nova substituiu a entrada antiga é que a redundância é aposentada (§112).
