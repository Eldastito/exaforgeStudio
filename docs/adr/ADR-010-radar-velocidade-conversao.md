# ADR-010 — Índice de Velocidade de Conversão (IVC) no Radar

**Status:** Implementado — cálculo medido (para organizações já clientes do ZappFlow), sem UI ainda.
**Origem:** adendo externo "Auditoria de Velocidade de Conversão" (v1.1), avaliado contra a Fase 1 do Radar já em produção (ADR-009) e implementado como extensão aditiva.

## Contexto

O adendo propõe um novo produto de entrada — medir tempo de resposta, follow-up e conversão em risco por canal/horário — com uma fórmula própria (IVC), métricas de tempo (TTA/TFR/TTQ/TTH/TTS/TTFU), perfis de SLA configuráveis, uma "Auditoria de Cliente Oculto" e um módulo de abandono de carrinho.

Cruzando com o codebase real, boa parte disso **já existia sob outro nome**: `RevenueIntelligenceService`/`revenue_intelligence_config` já mede "resposta lenta" (`slow_response_seconds`, default 300s) e "orçamento parado" (`quote_stale_hours`) para calcular o IQR/Perda Estimada do Revenue Intelligence Center. Construir um segundo motor de "o que é resposta lenta" do zero teria criado dois limiares divergentes no mesmo produto — por isso a decisão abaixo é de **reaproveitar**, não duplicar.

## Decisões (tomadas sem confirmação prévia do usuário, a pedido explícito: "faça o que for melhor para o projeto")

| Decisão | Escolha | Razão |
|---|---|---|
| Escopo desta rodada | Só a **versão medida** (organizações já clientes ativos, dados reais de `tickets`/`messages`) | Reaproveita ~70% da infraestrutura já testada (`RevenueIntelligenceService`, `AppointmentService`). A versão *declarada* (15 perguntas novas do questionário, para prospects na Fase 2 pública) fica para quando a Fase 2 (landing pública) for decidida — não depende desta implementação. |
| Auditoria de Cliente Oculto | **Não implementada agora.** Documentada aqui como trabalho futuro. | Metodologia (contatar concorrente disfarçado de cliente) tem risco reputacional/jurídico mesmo com as salvaguardas do texto original — merece validação jurídica antes de virar produto padronizado, não é uma decisão técnica que eu deva tomar sozinho. |
| Módulo de abandono de carrinho | **Não implementado como funil de e-commerce separado.** | O modelo do ZappFlow é conversa-cêntrico (WhatsApp), não sessão de navegação/checkout. O conceito equivalente já existe: `quotes.status` (orçamento sem retorno) e a fonte "abandoned" do `RevenueIntelligenceService`. Duplicar como um funil de carrinho tradicional teria sido inventar um dado que o produto não coleta. |
| Onde o IVC vive no modelo de dados | **Índice paralelo ao score de maturidade, não um 8º pilar.** Nova tabela `radar_velocity_snapshots`, com `session_id` opcional (nullable). | O `maturity_score` do Radar (ADR-009) é autodeclarado via questionário e os 7 pesos já somam 100 — inserir uma métrica *medida* ali dentro misturaria duas naturezas de dado diferentes. Como índice paralelo, o IVC pode ser calculado avulso (produto de entrada leve, sem exigir uma sessão de diagnóstico) ou anexado a uma sessão quando o consultor quiser os dois números no mesmo relatório. |
| Limiar de SLA | **Reaproveita `revenue_intelligence_config.slow_response_seconds`** (já configurável por organização, default 300s) em vez de criar um novo campo de configuração. | Um único "o que é resposta lenta" por organização, usado tanto pelo RIC quanto pelo Radar — evita dois números divergentes no mesmo produto que alguém precisaria manter sincronizados manualmente. |
| Perfis de SLA por canal/segmento/prioridade (4 níveis do texto original) | **Não implementado nesta rodada.** Um limiar único por organização, por enquanto. | O texto propõe uma matriz de configuração grande (perfil × canal × horário × prioridade) para uma primeira versão. Reaproveitar um limiar que já existe entrega o essencial (medir e mostrar o SLA real) sem esse investimento de configuração — diferenciar por canal é extensão aditiva natural depois, sem retrabalho (o cálculo já é feito por ticket; agrupar por canal exigiria só somar `channel_id`, não redesenhar nada). |
| Horário comercial | **Reaproveita `AppointmentService.config(orgId)`** (`agenda_open_hour`/`agenda_close_hour`/`agenda_days`, já configurável em Configurações › Agenda) e a constante de fuso `TZ_OFFSET_MIN` (Brasília, UTC-3, sem horário de verão desde 2019). | A organização já configura seu horário de funcionamento para a Agenda — usar o mesmo dado para "fora do horário comercial" evita pedir a mesma informação duas vezes e mantém as duas telas consistentes se o horário mudar. |

## Resposta direta à pergunta "podemos incluir uma métrica de atendimento fora do horário de expediente?"

**Sim, e já está implementada.** É um dos 5 componentes do IVC (peso 15%) **e** também é exposta como número isolado no snapshot (`out_of_hours_messages_total`, `out_of_hours_covered_total`, `out_of_hours_coverage_rate`) — não fica escondida só dentro do score composto. Usa o horário comercial que a própria organização já configura na Agenda.

## O que foi implementado

### Schema (`src/server/db.ts`)
Uma tabela nova, aditiva: `radar_velocity_snapshots` — um snapshot por cálculo, com o score composto, a banda (`critica`/`reativa`/`em_organizacao`/`controlada`/`otimizada`, mesmos limiares 0-24/25-44/45-64/65-79/80-100 do score de maturidade) e o detalhamento de cada componente. `session_id` nullable permite calcular avulso ou anexar a uma `radar_sessions`.

### Motor (`src/server/ConversionVelocityService.ts`)
Determinístico e versionado (`SCORING_VERSION`), sem IA generativa. Calcula, a partir de `tickets`/`messages`/`ticket_stage_logs`/`contact_cadences`:

1. **Conformidade de SLA** (30%) — % de tickets cuja primeira resposta (bot ou agente) ficou dentro do limiar de `revenue_intelligence_config`. Ticket nunca respondido conta como violação.
2. **P90 do tempo de primeira resposta** (20%) — convertido em score via a mesma curva já usada em `RevenueIntelligenceService.driverAtendimento` (100 pontos até o limiar, 0 pontos a partir de 10x o limiar) — mesma régua nos dois lugares do produto.
3. **Cobertura fora do horário comercial** (15%) — % de mensagens recebidas fora do expediente configurado que tiveram resposta dentro do SLA.
4. **Conformidade de follow-up** (20%) — entre os tickets "em risco" (nunca respondidos ou respondidos fora do SLA), % que tiveram uma tentativa de recuperação: cadência ativa (`contact_cadences`) ou pelo menos uma segunda mensagem nossa.
5. **Rastreabilidade de conversão** (15%) — entre os tickets fechados no período, % que têm histórico de mudança de estágio registrado (`ticket_stage_logs`), não apenas "abriu e fechou" sem rastro.

Cada componente sem dado suficiente no período (ex.: nenhuma mensagem fora do horário) é **excluído e o peso redistribuído entre os demais** — nunca tratado como 0 nem como 100. Uma organização sem tickets no período recebe `ivc_score = null`, não um número inventado.

**Limite conhecido, documentado no código:** mede apenas o primeiro ciclo de contato→resposta de cada ticket (não cada troca de mensagem subsequente). Suficiente para "velocidade de entrada"; medir cada ciclo é extensão futura se necessário.

### API (`src/server/routes/radar.ts`)
`POST /api/radar/velocity/calculate` (owner/admin, corpo opcional `{ periodDays, sessionId }`), `GET /api/radar/velocity` (lista, mais recente primeiro, filtro opcional `?sessionId=`), `GET /api/radar/velocity/latest`. Mesmo módulo `radar` (opt-in) e mesmo kill-switch (`AI_EXECUTION_RADAR_ENABLED`) da Fase 1.

### Auditoria
Extraído o helper de log de `RadarService` para `src/server/radarAudit.ts` (usado agora pelos dois serviços) — evita duas cópias da mesma lógica de escrita em `auth_audit_logs` divergindo com o tempo. Evento novo: `radar_velocity_calculated`.

### Teste (`scripts/test-conversion-velocity.ts`, `npm run test:conversion-velocity`)
Cenário sintético com 8 tickets cobrindo cada combinação relevante (rápido/lento/nunca respondido, dentro/fora do horário, com/sem cadência, fechado com/sem rastro) e um resultado **calculado à mão antes de rodar** (IVC ≈ 27,5, banda "reativa") — o teste confirma que a implementação bate com a conta manual, não só que é internamente consistente. 23/23 verificações passam, incluindo isolamento cross-tenant, "sem dado nunca vira 0", determinismo e anexação a sessão (com rejeição explícita de sessão de outra organização). Os testes pré-existentes (`test:isolation`, `test:radar-isolation`) continuam passando sem alteração.

## Não implementado nesta rodada (deliberado)

- Perfis de SLA configuráveis por canal/horário/prioridade (hoje: um limiar por organização, reaproveitado do RIC).
- Auditoria de Cliente Oculto (checklist manual, sem automação) — pendente validação jurídica.
- Módulo de abandono de carrinho como funil de e-commerce dedicado — o equivalente conversa-cêntrico já existe via `quotes`/RIC.
- As 15 perguntas declaradas do bloco "Velocidade de Atendimento e Conversão" para o questionário do Radar — só fazem sentido junto da Fase 2 pública (prospect sem dado próprio ainda), que segue pendente de decisão (destino do lead: `ProspectService` vs. Kanban).
- UI: nenhuma tela nova: `SettingsView` ainda não tem toggle para o módulo `radar` (mesma limitação já registrada na ADR-009).
