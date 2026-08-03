# PRD — ZappFlow Execution Runtime

> **Fonte imutável.** Este documento é o PRD original fornecido pelo dono do
> produto. **Não editar aqui.** Ajustes, ponderações, escopo revisado,
> renomeações, decisões e alternativas vivem em
> `docs/execution-runtime/DECISOES-E-PENDENCIAS.md` (que **cita este PRD**).
> A rastreabilidade item‑a‑item vive em
> `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`.

---

Transformação do ZappFlow de Copiloto Avançado em Sistema de Trabalho Pronto
Produto: ZappFlow
Repositório principal: https://github.com/Eldastito/exaforgeStudio
Tipo de documento: Product Requirements Document — PRD técnico e funcional
Prioridade: Estratégica / Crítica
Status inicial: Proposta para análise técnica obrigatória
Responsável pela execução: IA Dev
Objetivo principal: transformar o ZappFlow em uma plataforma capaz de assumir processos empresariais de ponta a ponta, executar o trabalho dentro das regras da organização e entregar ao gestor resultados, exceções e decisões relevantes.

## 1. Instrução obrigatória para a IA Dev
Antes de alterar qualquer arquivo, criar tabelas, escrever código, abrir branch ou iniciar uma implementação, a IA Dev deverá cumprir integralmente esta sequência:
1. Ler este PRD por completo.
2. Analisar o repositório atual.
3. Identificar tudo que já existe e pode ser reutilizado.
4. Comparar a arquitetura proposta com a arquitetura real.
5. Apontar riscos, inconsistências, duplicidades e decisões questionáveis.
6. Registrar suas ponderações técnicas.
7. Propor ajustes ao PRD quando houver justificativa objetiva.
8. Criar um plano de implementação dividido em fases pequenas, testáveis e reversíveis.
9. Salvar permanentemente este PRD e o plano dentro do repositório.
10. Somente depois iniciar a execução.

A IA Dev não deve interpretar este PRD como uma ordem para implementar cegamente a solução descrita. Ela deverá primeiro responder:
- A arquitetura proposta é compatível com o codebase?
- Já existe algum Runtime, Action Service, Scheduler, Job Queue, Policy Engine, Outcome Ledger ou estrutura semelhante?
- Quais componentes podem ser estendidos em vez de duplicados?
- Quais partes do PRD criariam complexidade desnecessária?
- Quais riscos técnicos, operacionais, financeiros, jurídicos ou de segurança precisam ser tratados?
- Qual é a menor arquitetura capaz de entregar o objetivo?
- Qual é a ordem de implementação com menor risco?
- Quais integrações impedem a automação ponta a ponta?

A análise crítica deverá ser registrada antes do primeiro código de produção.

## 2. Regra de persistência e continuidade
Este PRD não pode existir apenas no contexto temporário da conversa da IA Dev. A IA Dev deverá salvar o documento no repositório em um caminho semelhante a:
`docs/prd/PRD-ZAPPFLOW-EXECUTION-RUNTIME.md`

Também deverá criar e manter os seguintes documentos:
- `docs/execution-runtime/ANALISE-ARQUITETURAL.md`
- `docs/execution-runtime/PLANO-DE-IMPLEMENTACAO.md`
- `docs/execution-runtime/STATUS-DE-EXECUCAO.md`
- `docs/execution-runtime/DECISOES-E-PENDENCIAS.md`
- `docs/execution-runtime/MATRIZ-DE-COBERTURA-DO-PRD.md`

Caso o repositório utilize ADRs, o projeto deverá ganhar um ADR próprio, por exemplo:
`docs/adr/ADR-XXX-zappflow-execution-runtime.md`
A numeração real deverá seguir o padrão existente.

### 2.1 Objetivo de cada documento
- **ANALISE-ARQUITETURAL.md** — componentes existentes, reutilizáveis, duplicidades evitadas, pontos incompatíveis, riscos, dívida técnica, decisões recomendadas, alterações propostas ao PRD, justificativas.
- **PLANO-DE-IMPLEMENTACAO.md** — fases, dependências, arquivos afetados, migrações, APIs, serviços, UI, testes, critérios de aceite, rollback, feature flags, riscos de regressão.
- **STATUS-DE-EXECUCAO.md** — memória permanente da IA Dev. Cada item com `[ ]` não iniciado, `[~]` em andamento, `[x]` concluído, `[!]` bloqueado, `[-]` removido após decisão. Cada atualização registra data, fase, item, arquivos alterados, testes executados, resultado, pendências, próximo passo.
- **DECISOES-E-PENDENCIAS.md** — decisões arquiteturais, mudanças de escopo, bloqueios externos, credenciais/manuais ausentes, integrações indisponíveis, riscos aceitos, decisões que dependem do dono do produto.
- **MATRIZ-DE-COBERTURA-DO-PRD.md** — cada requisito ligado a fase, serviço, rota, interface, teste, status, evidência de implementação. Nenhum requisito concluído apenas por ter código escrito.

## 3. Regra de foco e não abandono
A IA Dev deverá tratar este PRD como programa de implementação contínua. Não encerrar após: criar só tabelas; só backend; só interfaces; PoC; só a primeira fase; deixar serviços como stubs sem registrar bloqueio; recomendações sem execução; ações sem confirmação de resultado; automações sem medição; conclusão com testes parciais.

A execução só será concluída quando: (a) todos os itens do escopo obrigatório estiverem implementados; ou (b) os itens não implementados estiverem formalmente classificados como bloqueados, removidos ou adiados, com justificativa aprovada e registrada.

Ao fim de cada sessão, atualizar `STATUS-DE-EXECUCAO.md` com o ponto exato onde parou. A próxima sessão começa pela leitura dos documentos persistidos — sem depender de memória de conversa.

## 4. Contexto estratégico
O ZappFlow já possui capacidades importantes de CRM, atendimento, WhatsApp, cadências, financeiro, cobrança, assinaturas, PIX, automações, agendamento, Retail Ops, fechamento, conciliação, comissões, estoque, compras, Revenue Intelligence, Pareto, Business Signals, Diretor IA, Plano de Ação, Scheduler, filas, integrações e medição de impacto.

Boa parte do comportamento atual ainda segue: **Detectar → interpretar → recomendar → aguardar o gestor executar** (copiloto avançado).

O objetivo deste PRD é evoluir para: **Detectar → decidir dentro das regras → planejar → executar → acompanhar → reagir → confirmar → concluir → medir → comprovar**.

A transformação principal não está em adicionar mais IA — está em atribuir ao ZappFlow responsabilidade operacional pelo estado final do processo.

## 5. Visão do produto
### 5.1 Visão futura
Assumir processos operacionais completos, executá-los dentro das políticas definidas pela empresa e entregar ao gestor: resultados, exceções, riscos, decisões relevantes, evidências, impacto comprovado.

### 5.2 Posicionamento desejado
O ZappFlow não apenas mostra o que precisa ser feito. Ele faz, acompanha e comprova o resultado.

### 5.3 Princípio operacional
O usuário define objetivos, limites, políticas e exceções. O ZappFlow executa o trabalho permitido e solicita intervenção humana apenas quando necessário.

## 6. Problema a resolver
Falta uma camada transversal capaz de responder de forma consistente: o que precisa ser feito, por quê, qual processo está sendo executado, quem/qual agente executa, qual ferramenta, se a ação é permitida, qual o limite de autonomia, se há risco, prazo, definição de sucesso, como confirmar, o que acontece se falhar, quando repetir, quando escalar, quem decide a exceção, qual impacto, qual evidência.

## 7. Objetivos
### 7.1 Objetivo principal
Criar o **ZappFlow Execution Runtime** — camada universal de execução que transforma sinais, recomendações, eventos e decisões em processos acompanhados até a conclusão.

### 7.2 Objetivos específicos
Padronizar ações executáveis em todos os módulos; criar máquina de estados universal; definir agentes, conectores e executores; implementar políticas de autonomia; criar playbooks de processos completos; implementar filas, tentativas e tratamento de falhas; confirmar resultados por evidências externas; medir impacto real; separar ações automáticas, supervisionadas e exceções; reduzir dependência do gestor em tarefas determinísticas; transformar módulos existentes em operações gerenciadas; criar uma Central de Operações Autônomas; implementar inicialmente três processos ponta a ponta.

## 8. Não objetivos iniciais
Nesta primeira versão não automatizar integralmente: contratação e demissão; decisões jurídicas complexas; decisões clínicas; diagnósticos médicos; concessão relevante de crédito; pagamentos elevados sem aprovação; negociações estratégicas; compras de alto valor; avaliações subjetivas de pessoas; comunicações de alto risco reputacional; ações irreversíveis sem mecanismo de autorização.

## 9. Conceito de trabalho pronto
Um processo é **Gerenciado pelo ZappFlow** quando possuir: evento claro de início; objetivo final mensurável; entradas identificadas; regras de decisão; ações executáveis; executor disponível; permissões definidas; prazo/SLA; política de repetição; tratamento de falhas; condição objetiva de sucesso; confirmação externa; escalação de exceções; evidência auditável; medição de impacto; responsabilidade definida quando a automação não concluir.

Se apenas recomenda, ou envia sem acompanhar, ou executa sem confirmar — **não é trabalho pronto**.

## 10. Arquitetura conceitual
```
Fontes de dados e eventos
        ↓
Detectores e Business Signals
        ↓
Motor de decisão e priorização
        ↓
Process Definition / Playbook
        ↓
Policy Engine
        ↓
Execution Plan
        ↓
Execution Runtime
        ↓
Agents / Connectors / Human Tasks
        ↓
Confirmation Engine
        ↓
Outcome Ledger
        ↓
Aprendizado e otimização
```

## 11. Componentes obrigatórios

### 11.1 Process Definition
Definição persistida com: id, organization_id, process_type, name, description, version, trigger_type, objective, status, autonomy_level, sla_definition, entry_conditions, success_conditions, failure_conditions, escalation_policy, created_at, updated_at. Suporta versionamento, ativação/desativação, configuração por organização, parâmetros por vertical, políticas específicas, níveis de autonomia.

### 11.2 Process Instance
Cada execução gera instância com: id, organization_id, process_definition_id, process_type, subject_type, subject_id, status, priority, risk_level, expected_value, started_at, deadline_at, completed_at, failed_at, current_step, context_json, result_json, created_by, created_at, updated_at.

Exemplo: "Recuperar a fatura 4587" — não apenas "Enviar mensagem da fatura 4587".

### 11.3 Action Contract
Contrato universal para toda ação executável: id, organization_id, process_instance_id, action_type, subject_type, subject_id, objective, executor_type, executor_id, status, risk_level, approval_policy, approval_status, scheduled_at, started_at, completed_at, deadline_at, attempt_count, max_attempts, success_condition, fallback_action, input_json, output_json, error_json, evidence_json, created_at, updated_at.

Exemplo:
```json
{
  "action_type": "send_payment_reminder",
  "process": "accounts_receivable_recovery",
  "subject_type": "invoice",
  "subject_id": "invoice_4587",
  "objective": "receive_overdue_payment",
  "expected_value": 4200,
  "risk_level": "low",
  "executor": "whatsapp_agent",
  "deadline": "2026-08-03T17:00:00-03:00",
  "approval_policy": "automatic",
  "success_condition": "invoice_paid",
  "fallback": "escalate_to_financial_manager"
}
```

### 11.4 Máquina de estados
Cobrir no mínimo: detected, planned, awaiting_approval, authorized, queued, executing, waiting_external_response, retry_scheduled, escalated, completed, failed, cancelled, measured. Transições inválidas bloqueadas; toda transição relevante gera auditoria (timestamp, ator, origem, motivo, evidência).

### 11.5 Executor Registry
Registro de executores. Tipos iniciais: WhatsApp Agent, CRM Agent, Financial Agent, Retail Agent, Calendar Agent, Procurement Agent, Email Agent, ERP Connector, Scheduler, Human Operator.

Cada executor declara: executor_type, supported_actions, required_inputs, permission_scope, timeout, retry_policy, confirmation_method, reversibility, risk_classification, health_status.

### 11.6 Policy Engine
Decide se uma ação pode ser executada automaticamente; ser preparada e submetida; exigir aprovação; ser bloqueada; ser encaminhada a humano. Políticas consideram: organização, processo, ação, usuário, cliente, valor financeiro, horário, canal, risco, segmento, recorrência, sensibilidade, histórico, reversibilidade.

Exemplo: cobranças até R$ 5.000 automáticas; desconto ≤5% automático; 5–10% aprovação obrigatória; >10% bloqueado; cliente estratégico com abordagem firme exige aprovação.

### 11.7 Níveis de autonomia
- **Nível 0 — Observar** (detectar e registrar)
- **Nível 1 — Recomendar**
- **Nível 2 — Preparar** (ação, mensagem, documento)
- **Nível 3 — Executar com aprovação**
- **Nível 4 — Executar automaticamente** (determinísticas dentro de políticas)
- **Nível 5 — Gerenciar o processo** (escolher, executar, acompanhar, repetir, corrigir, escalar)

Cada organização configura o nível permitido por processo.

### 11.8 Playbook Engine
Executa processos completos compostos por etapas. Cada etapa suporta: condição de entrada, ação, executor, condição de sucesso, timeout, repetição, fallback, escalonamento, próxima etapa, evidência esperada.

Decisão de formato (código tipado, JSON persistido, DSL, híbrido) deve priorizar: auditabilidade, testabilidade, segurança, simplicidade, versionamento, facilidade de rollback.

### 11.9 Retry, timeout e compensação
Toda ação externa deve possuir: timeout, número máximo de tentativas, backoff, classificação de erro, idempotência, política de repetição, dead-letter, mecanismo de compensação quando aplicável. Casos: mensagem não entregue, API indisponível, token expirado, pagamento não localizado, resposta não recebida, integração sem credencial, duplicidade, conflito de estado, ação parcialmente concluída.

### 11.10 Confirmation Engine
Uma operação **não** é concluída apenas porque a ação foi disparada.

| Processo | Confirmação |
| --- | --- |
| Cobrança | Pagamento identificado |
| Conciliação | Pagamento vinculado à fatura |
| Recuperação comercial | Resposta, reunião, ganho ou perda |
| Fechamento | Valores recebidos e conferidos |
| Agendamento | Evento confirmado |
| Cotação | Resposta do fornecedor recebida |
| Reposição | Estoque atualizado |
| Documento | Documento recebido e validado |

Confirmação pode vir de: evento interno, webhook, polling, leitura de banco, resposta em canal, API externa, ação humana validada.

### 11.11 Outcome Ledger
Registrar: organization_id, process_instance_id, process_type, expected_value, realized_value, attribution_type, attribution_confidence, time_saved_minutes, cost_avoided, revenue_recovered, loss_prevented, human_interventions, actions_executed, status, measurement_window, evidence_json, measured_at.

Distinguir: valor comprovado, valor estimado, valor potencial, correlação, atribuição direta. Valores de categorias diferentes não devem ser somados de forma enganosa.

### 11.12 Exception Center
Central de exceções (só o que exige intervenção). Categorias: aprovação, decisão, dado faltante, integração falhou, conflito de política, risco elevado, divergência, cliente sensível, ação irreversível, SLA em risco. Cada exceção explica: o que aconteceu, qual processo, impacto, evidências, opções, recomendação, prazo, consequência de não decidir.

## 12. Interface — Operações Autônomas
Área central (nome sugerido; validar com Design System).

### 12.1 Blocos principais
- **Em execução** (ex.: "42 cobranças em acompanhamento; 18 oportunidades em recuperação; 7 fechamentos aguardando confirmação externa")
- **Concluído hoje** (ex.: "R$ 12.400 recebidos; R$ 8.700 recuperados; seis lojas conciliadas; 14 horas operacionais absorvidas")
- **Exceções** (ex.: "cliente pediu desconto acima da política; divergência sem causa; integração indisponível; documento ausente; fornecedor sem estoque")
- **Indicadores** (processos iniciados, concluídos, taxa de conclusão, conclusão sem intervenção, SLA cumprido, tempo médio, valor realizado, falhas, tentativas, exceções, horas economizadas)

### 12.2 Transparência
Cada processo permite abrir: linha do tempo, decisões, políticas aplicadas, mensagens, executores, tentativas, erros, evidências, resultado, impacto.

## 13. Processo prioritário 1 — Cobrança e recuperação financeira autônoma
### 13.1 Objetivo
Assumir o acompanhamento da proximidade do vencimento até: pagamento, negociação autorizada, contestação, encaminhamento humano, baixa por política, encerramento.

### 13.2 Fluxo
Detectar vencimento → classificar cliente → escolher cadência → enviar lembrete → entregar PIX → interpretar resposta → registrar promessa → negociar dentro da política → acompanhar prazo → localizar pagamento → conciliar → concluir ou escalar → medir valor recuperado.

### 13.3 Capacidades necessárias
Detecção de vencimentos; segmentação; cadência adaptativa; envio de mensagens; geração/envio de PIX; interpretação de intenção; promessa de pagamento; reagendamento; pausa; contestação; negociação dentro de limites; confirmação de pagamento; conciliação; atribuição de recuperação; exceções.

### 13.4 Intenções mínimas
"Vou pagar amanhã." · "Manda o PIX." · "Já paguei." · "Não reconheço." · "Posso parcelar?" · "Posso pagar metade?" · "Fale com o financeiro." · "Não quero mais o serviço." · "Estou sem condições." · "Me chama depois."

### 13.5 Condição de conclusão
Pagamento confirmado; acordo formalizado; contestação encaminhada; decisão humana; encerramento previsto em política.

### 13.6 SLA sugerido
Acompanhar até pagamento, acordo, contestação ou encaminhamento de exceção.

### 13.7 Critérios de aceite
Cobrança gera instância; cadência executada pelo Runtime; respostas alteram o fluxo; promessa agenda nova verificação; PIX enviado corretamente; pagamento encerra a cobrança; ações idempotentes; tentativas auditadas; exceções chegam ao gestor; valor recuperado medido; testes cobrem positivo e negativo.

## 14. Processo prioritário 2 — Recuperação automática de oportunidades comerciais
### 14.1 Objetivo
Nenhuma oportunidade qualificada fica esquecida ou sem próxima ação.

### 14.2 Fluxo
Identificar oportunidade parada → calcular prioridade → classificar contexto → escolher cadência → distribuir responsável → enviar contato → acompanhar resposta → interpretar intenção → atualizar CRM → reagendar → marcar reunião → escalar objeção → registrar ganho/perda → atribuir receita recuperada.

### 14.3 Transformação do botão "Recuperar agora"
Antes: mostra oportunidades elegíveis; valor total; potencial recuperável; casos automáticos; casos que exigem humano; canais; cadências; riscos; políticas. Após autorização: cria processos; cria cadências; define responsáveis; envia mensagens; acompanha respostas; atualiza CRM; cria tarefas; agenda compromissos; interrompe quando necessário; mede receita.

### 14.4 Condições de conclusão
Ganho; perda; reunião marcada; proposta reativada; desqualificação; encaminhamento humano; cadência encerrada por política.

### 14.5 SLA sugerido
Nenhuma oportunidade qualificada mais de 24 horas sem próxima ação válida.

### 14.6 Critérios de aceite
Oportunidades paradas detectadas; prioridade explicável; cadência criada; responsável definido; mensagens enviadas; respostas interpretadas; CRM atualizado; reuniões agendadas; nova tentativa programada; objeções escaladas; receita com evidência; opt-out e limites respeitados; testes cobrem o fluxo completo.

## 15. Processo prioritário 3 — Fechamento e conciliação diária de lojas
### 15.1 Objetivo
Entregar diariamente: fechadas, conferidas, conciliadas, integradas ao financeiro, com comissões calculadas, ou com exceções claramente identificadas.

### 15.2 Fluxo
Abrir operação → acompanhar vendas e boletas → solicitar fechamento → receber dados → extrair e estruturar → comparar folha, PDV e adquirente → identificar divergências → solicitar correção → confirmar valores → atualizar financeiro → calcular comissão → aprovar casos regulares → escalar exceções → entregar consolidado.

### 15.3 Fontes
PDV; Alterdata; Sicredi; adquirentes; OCR; foto; WhatsApp; formulário; boletas; conciliação bancária.

### 15.4 Aprovação automática por política
```
Se:
- fechamento recebido;
- PDV sincronizado;
- diferença abaixo da tolerância;
- adquirente conciliado;
- nenhuma venda sem correspondência relevante;
- nenhuma alteração manual sensível;
- documentação completa;
Então:
- aprovar automaticamente;
- lançar no financeiro;
- calcular comissão;
- concluir.
```

### 15.5 Condição de conclusão
Fechamento conciliado; concluído com divergência assumida; ou exceção atribuída com responsável e prazo.

### 15.6 SLA sugerido
Até 9h, todas as lojas do dia anterior conciliadas ou com divergências atribuídas.

### 15.7 Critérios de aceite
Fechamento cria processo; múltiplas fontes suportadas; dados comparados; tolerâncias configuráveis; regulares concluídos automaticamente; risco escalado; comissão gerada; financeiro atualizado; Sicredi manual e API futura usam o mesmo contrato; evidências auditadas; testes cobrem divergências e idempotência.

## 16. Requisitos de segurança e governança
Isolamento multi-tenant; RBAC; políticas por organização; auditoria; idempotência; proteção contra duplicidade; criptografia; proteção de credenciais; LGPD; opt-out; horário permitido; limites financeiros; aprovação de ações sensíveis; menor privilégio; logs sem exposição indevida; rastreabilidade de decisões da IA; separação entre fato, estimativa e inferência.

Nenhuma IA deve inventar: pagamento, valor, resposta, autorização, conciliação, conclusão, receita recuperada, evidência.

## 17. Requisitos de observabilidade
Métricas para: quantidade de processos; por estado; duração; SLA; taxa de falha; retries; tempo em espera; integrações indisponíveis; executor com erro; intervenção humana; conclusão automática; valor esperado; realizado; discrepâncias; processos presos; dead letters.

Alertas para: processo sem evolução; SLA ameaçado; repetição esgotada; executor indisponível; credencial expirada; webhook não recebido; crescimento anormal de falhas; duplicidade; inconsistência de estado.

## 18. Requisitos de testes
### 18.1 Unitários
Transições de estado; políticas; elegibilidade; retries; timeouts; confirmação; cálculo de impacto; classificação de risco.

### 18.2 Integração
Runtime com WhatsApp; CRM; financeiro; Retail Ops; Scheduler; integrações externas.

### 18.3 Ponta a ponta
- **Cobrança:** Fatura vence → mensagem → resposta → PIX → pagamento → conciliação → outcome.
- **Recuperação comercial:** Oportunidade parada → cadência → resposta → reunião → CRM → atribuição.
- **Fechamento:** Dados recebidos → PDV → adquirente → conciliação → comissão → financeiro.

### 18.4 Falha
API indisponível; duplicidade; timeout; resposta inválida; credencial ausente; pagamento não localizado; webhook repetido; ação executada parcialmente; mudança manual concorrente; perda de conexão; reinício do processo; fila reprocessada.

### 18.5 Isolamento
Nenhuma organização pode visualizar/executar/medir/aprovar/alterar processos de outra.

## 19. Migração e compatibilidade
Aditiva e controlada por feature flags: `execution_runtime_enabled`, `autonomous_collections_enabled`, `commercial_recovery_runtime_enabled`, `retail_closing_runtime_enabled`, `autonomous_operations_ui_enabled`.

Orgs existentes não mudam de comportamento automaticamente. Modo inicial: **shadow** (cria planos, simula decisões, não executa, compara com o que o usuário fez, mede confiança, identifica gaps) → **assisted** → **approved_execution** → **autonomous**.

## 20. Roadmap obrigatório
- **Fase 0 — Análise crítica.** Análise arquitetural; inventário do codebase; mapeamento de serviços; riscos; decisões; plano; matriz do PRD; ADR. Nenhum código funcional antes.
- **Fase 1 — Fundação do Runtime.** Process Definition; Instance; Action Contract; estados; Executor Registry; Policy Engine; auditoria; APIs; testes.
- **Fase 2 — Execução e confiabilidade.** Fila; retries; timeout; idempotência; fallback; escalonamento; Confirmation Engine; observabilidade; testes de falha.
- **Fase 3 — Outcome Ledger.** Esperado; realizado; evidências; atribuição; tempo economizado; integração com Impact Ledger existente; transparência entre estimado e comprovado.
- **Fase 4 — Cobrança autônoma.** Processo; cadência adaptativa; interpretação; PIX; promessa; conciliação; exceções; medição.
- **Fase 5 — Recuperação comercial.** Detecção; priorização; cadência; distribuição; CRM; agenda; atribuição; métricas.
- **Fase 6 — Fechamento gerenciado.** Processo; múltiplas fontes; conciliação; políticas; aprovação automática; comissão; financeiro; exceções.
- **Fase 7 — Operações Autônomas.** Painel; execução; concluídos; exceções; resultados; timelines; métricas.
- **Fase 8 — Shadow mode e rollout.** Simulação; comparação; coleta; ativação gradual; rollback; documentação operacional.

## 21. Critérios globais de aceite
Runtime reutilizado pelos três processos; não existem três motores paralelos independentes; processos persistidos; estados auditados; ações com executores; políticas aplicadas; aprovações respeitadas; ações automáticas configuráveis; falhas tratadas; tentativas idempotentes; resultados confirmados; evidências armazenadas; impacto medido; exceções apresentadas; UI mostra resultados e não apenas tarefas; orgs existentes protegidas por flags; testes completos verdes; documentação atualizada; matriz de cobertura integralmente preenchida; todos os itens deste PRD com status formal.

## 22. Definition of Done por item
Não concluído apenas por código. Requer (quando aplicável): implementação backend; persistência; validação; autorização; auditoria; interface; estados vazios; loading; tratamento de erro; teste; documentação; feature flag; migração; rollback; evidência no status; item correspondente na matriz de cobertura.

## 23. Orientação para ponderações da IA Dev
Ser crítica; contestar o PRD quando: houver duplicação; existir solução mais simples; o modelo gerar acoplamento; um requisito ameaçar segurança; uma automação não puder ser confirmada; uma integração não oferecer escrita; o custo superar o benefício; o escopo estiver grande demais; uma fase precisar ser dividida; uma ação não puder ser idempotente; uma métrica não permitir atribuição; uma ação exigir julgamento humano. Rejeições exigem alternativa que preserve o resultado.

## 24. Perguntas obrigatórias da Fase 0
A análise responde: qual serviço atual mais se aproxima do Runtime; se o Action Service existente pode ser estendido; se o JobQueueService é suficiente; se o Scheduler suporta processos duradouros; como o Plano de Ação se conecta ao Runtime; como o Business Signals dispara processos; como o Impact Ledger se conecta ao Outcome Ledger; quais ações já são idempotentes; quais integrações suportam escrita; quais só leem; quais processos já possuem confirmação; quais terminam no envio; onde estão as políticas atuais; como preservar RBAC; como implementar rollback; como evitar loops automáticos; como impedir mensagens repetidas; como interromper processos manualmente; como lidar com mudanças concorrentes; quais riscos jurídicos/LGPD; qual é o MVP real do Runtime; qual processo é o primeiro piloto; qual vertical recebe o primeiro rollout; quais itens dependem de credenciais externas; quais podem ser implementados agora.

## 25. Resultado esperado
Ao término, o ZappFlow diz: "Detectei o problema, apliquei as regras, executei o processo, acompanhei o resultado, tratei as tentativas, encaminhei as exceções e registrei o impacto." O gestor passa a definir políticas, aprovar riscos, decidir exceções, acompanhar resultados, melhorar a operação — o ZappFlow assume o trabalho determinístico, repetitivo e mensurável.

## 26. Mensagem final para a IA Dev
Este projeto não é a criação de mais um módulo. É mudança estrutural. Antes de programar: analisar, criticar, comparar, registrar, planejar. Durante: preservar foco, atualizar documentos, implementar em fases, testar, não duplicar, não inventar, não abandonar requisitos silenciosamente. Ao concluir cada fase: atualizar status, matriz, testes, bloqueios, próximo passo. O trabalho só termina quando o ZappFlow deixar de apenas dizer o que precisa ser feito e passar a executar, concluir e comprovar o resultado dentro dos processos definidos neste PRD.

**O primeiro passo da IA Dev é a Fase 0 — análise crítica do codebase, sem iniciar implementação antes de salvar os documentos de continuidade no repositório.**
