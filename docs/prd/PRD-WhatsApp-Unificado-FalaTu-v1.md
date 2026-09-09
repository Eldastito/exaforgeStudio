# PRD — ZapFlow: Fala Tu unificado, WhatsApp compartilhado e conexão autônoma com Evolution GO

**Versão:** 1.0 · **Data:** 09/09/2026 · **Destinatário:** IA desenvolvedora do ZapFlow.

**Objetivo:** permitir que o assinante conecte seu WhatsApp dentro do ZapFlow, escolha quais funcionalidades usam o número, atenda clientes pelo CRM e consulte/execute operações autorizadas do negócio pelo mesmo canal, inclusive recebendo arquivos PDF, XLSX e DOCX. Consolidar os caminhos repetidos sem perder recursos, dados, histórico, permissões ou compatibilidade.

**Estado deste documento:** especificação para implementação. Nenhuma fase está declarada implementada, testada em produção ou liberada por este PRD.

**Base técnica:** repositório `Eldastito/exaforgeStudio`, branch `main`, commit auditado `836283828df743043772ae479678f2f6a0875d42`. A IA deve comparar com o HEAD disponível antes de editar. Não reintroduzir funcionalidades já corrigidas depois desse commit.

## 1. Instrução principal para a IA desenvolvedora

Você deve implementar este PRD em entregas pequenas, verificáveis e reversíveis. Antes de cada alteração, identifique o caminho atual, seus consumidores, contratos, dados e testes. Reutilize os serviços existentes. Implemente uma responsabilidade em um único lugar e faça as interfaces delegarem a esse lugar.

Não interprete “unificação” como exclusão imediata do Fala Tu, do atendimento, do Controller ou do Coordenador. O Fala Tu será a interface de gestão para dono/equipe; os motores especializados permanecem internos. O atendimento de clientes continua sendo atendimento e deve preservar o CRM. As interfaces deixam de exigir que o usuário compreenda os nomes dos motores.

“Não quebrar” significa preservar contratos e comportamentos legítimos, demonstrados por testes e reconciliação. Comportamentos inseguros ou incorretos, como encaminhar mensagem para empresa errada, devem ser corrigidos; documente o comportamento anterior e a mudança. Não prometa ausência absoluta de falhas sem evidência.

O pedido atual autoriza a elaboração deste PRD. Este documento não é autorização para a IA destinatária enviar mensagens reais, apagar instâncias, publicar em produção, mudar preços ou acessar dados sem as permissões do ambiente em que será executado.

## 2. Resultado esperado e critérios de produto

O dono conecta ou importa seu número uma vez no ZapFlow. Habilitar uma funcionalidade apenas cria/altera uma autorização de uso da conexão: não cria nova instância nem pede outro QR. Reconexão pode ser necessária se a sessão for revogada ou cair; não prometer pareamento eterno.

Um cliente escreve para o número comercial e é atendido no CRM. O dono escreve, de um telefone previamente vinculado e verificado, para esse mesmo número comercial e consulta informações internas permitidas. Ao pedir “mande isso em Excel”, recebe arquivo com os mesmos dados, filtros e período da resposta anterior. Uma conversa interna não vira lead nem aparece para atendentes sem permissão.

Metas de aceite:

- Nenhum acesso ao Evolution Manager pelo assinante no fluxo normal de conexão e reconexão.
- Nenhum QR adicional ao habilitar/desabilitar um uso de canal conectado.
- Nenhuma concessão implícita de acesso interno por texto, nome de perfil, palavra “zap” ou posse do número comercial.
- Nenhum efeito duplicado em cenários de webhook repetido, clique duplo, concorrência e retomada após reinício cobertos pelos testes.
- Nenhum contato, ticket, tarefa, compromisso, arquivo ou aprovação legítimos perdidos na migração.
- Identificação de falha, pendência e sucesso baseada em evidência, por canal e organização.
- Uma interface de gestão com funções especializadas reutilizadas, sem exigir escolha entre Fala Tu, Controller, Diretor e Coordenador.

## 3. Decisões de escopo

### 3.1 Incluído

1. Auditoria incremental do HEAD e mapa de responsabilidades.
2. Conexão, importação autorizada, QR, estado, reconexão preservadora e diagnóstico por canal.
3. Seleção do número e ativação de WhatsApp por finalidade/funcionalidade.
4. Modo compartilhado entre atendimento e gestão, com identidade e contexto separados.
5. Consolidação de consultas, tarefas, compromissos, compras e confirmações já existentes.
6. Solicitação, geração, localização e entrega de arquivos autorizados.
7. Continuidade de execução, idempotência, observabilidade, migração e regressão.
8. Preservação do Fala Tu Solo e dos modelos de conexão exclusivamente interno/cliente.

### 3.2 Não incluído

- Reescrever o sistema inteiro, trocar banco, provedor de IA ou infraestrutura sem necessidade demonstrada.
- Criar novo ERP, novo CRM, novo financeiro, novo gerenciador de tarefas ou novo módulo de WhatsApp paralelo.
- Mudar preços, planos, franquias, módulos contratados ou remover produto Solo.
- Habilitar automaticamente campanhas, cobrança ou envio clínico porque o número foi conectado.
- Prometer geração irrestrita de “qualquer arquivo”. O contrato inicial é PDF, XLSX e DOCX; formatos adicionais exigem gerador registrado.
- Gerar arquivos binários `.doc` ou `.xls` antigos. Interpretar pedido “Word”/“Excel” como DOCX/XLSX e informar o formato.
- Encaminhar informações financeiras para grupos. Grupos e mensagens próprias ficam fora do novo modo misto inicial.
- Criar uma integração direta de SQL livre a partir do WhatsApp.

### 3.3 Pressupostos explícitos

O cenário principal usa número comercial pareado e telefone pessoal do dono como remetente. Se o produto exigir comandos enviados pelo próprio número pareado, tratar como extensão separada; nunca simplesmente remover o filtro `fromMe`. Não bloquear o restante deste PRD por essa decisão.

A versão e o contrato exatos da Evolution GO instalada não foram validados na análise. Sua verificação é obrigatória na fase 0. O domínio informado é `https://evolutiongo.tesseractauto.com.br`; `/manager/instances` é interface administrativa, não base de API a ser concatenada às rotas.

## 4. Diagnóstico confirmado e componentes a reaproveitar

| Componente observado | O que existe | Diretriz |
|---|---|---|
| `src/server/MessageProviderService.ts` | Transporte compartilhado de texto/documento | Ampliar contexto de envio e suporte a MIME, mantendo compatibilidade dos chamadores |
| `src/server/MessageDeliveryService.ts` e `botOutbound.ts` | Fila de entrega e saída do bot | Ampliar o caminho existente; não construir fila paralela |
| `src/server/EvolutionService.ts` | Criação/reuso, token de instância e obtenção de QR | Consolidar provisionamento após corrigir recuperação destrutiva e validar contrato |
| `server.ts`, rotas `/api/evolution/*` | Pareamento legado e configuração global | Transformar em adaptadores compatíveis para o serviço consolidado |
| `src/server/FalaTuSoloWhatsAppService.ts` | Provisionamento dedicado para organização Solo | Preservar isolamento, gatilhos e contrato Solo; reutilizar fundação sem impor Solo à suíte |
| `src/features/ChannelsPanel.tsx` | Interface de canais e seleção interno/cliente | Evoluir a tela existente para números e usos |
| `src/server/webhookProcessor.ts` | Atendimento, interceptadores e desvio interno | Resolver identidade/contexto antes de criar contato/ticket; preservar demais canais |
| `src/server/AIOrchestratorService.ts` | Atendimento e gestão parcial por `authorized_managers` | Migrar a gestão para entrada comum, mantendo aliases e atendimento |
| `src/server/FalaTuAskService.ts` | Consultas determinísticas; delegação ao Diretor; operações governadas na interface web | Reutilizar consultas e revisar paridade com WhatsApp |
| `src/server/FalaTuWhatsAppService.ts` | Captura/pergunta com gatilhos no canal interno | Adaptador do canal para a mesma execução da interface web |
| `src/server/GestorCommandService.ts` | Comandos financeiros e aprovações | Preservar semântica, autorização e serviços de domínio |
| `src/server/CoordenadorService.ts` | Operações sobre tarefas e ajuda | Preservar motor de tarefas, absorvendo seleção de interface |
| `src/server/FalaTuService.ts` | Inbox, notas, memória, tarefas/eventos/listas e vínculos opcionais com módulos principais | Preservar captura e notas; consolidar registros operacionais vinculados |
| `src/server/FalaTuReportService.ts` | Resumo executivo em PDF/XLSX com projeção de contexto | Reutilizar; ampliar relatórios por contratos explícitos |
| `src/server/ArtifactService.ts` | Arquivos privados, metadados e URLs assinadas | Reutilizar com classificação/permissão consistentes |
| `ContextEngineService` e `ContextProjectionService` | Contexto e recorte de acesso | Aplicar a toda leitura interna, inclusive perguntas abertas e arquivos |
| `webhookSecurity.ts` e `routes/integrations.ts` | Validação, antirrepetição e URL com segredo | Reutilizar sem desligar proteção; individualizar diagnóstico |

### 4.1 Achados que esta entrega deve resolver

- Gestor autorizado pode falar pelo canal de atendimento, mas esse caminho difere do Controller/Fala Tu interno. Não alegar que hoje não existe nenhum compartilhamento.
- O Fala Tu reutiliza o Diretor para perguntas abertas. Não criar outro Diretor para “unificar”.
- O caminho web do Fala Tu usa `converse`; o caminho WhatsApp analisado chama `answer` para perguntas. Paridade não pode ser presumida.
- A seleção atual de `kind` admite interno ou cliente, sem matriz geral por funcionalidade.
- Há consumidores que escolhem o primeiro canal, alguns filtrando apenas `status != disabled`.
- A saída Evolution prioriza credencial global em detrimento da credencial do canal.
- O pareamento legado tem eventos/parser/rotas distintos do serviço mais recente e pode indicar conexão sem comprovação.
- O processamento de mensagens usa identificadores diferentes daqueles aceitos nos eventos de conexão GO.
- Há vínculo legado com `default_org`, configuração em memória e diagnóstico global.
- A URL configurada no pareamento pode divergir da URL protegida já oferecida nas integrações.
- A recuperação do serviço pode deletar/recriar instância por falta de QR sem comprovar que esse reset é apropriado.
- PDF/XLSX existem no gerador Fala Tu; não foi encontrada entrega conversacional geral de XLSX/DOCX pelo WhatsApp. Registrar MIME DOCX não equivale a gerar DOCX.
- Tarefas/eventos/listas do Fala Tu têm estruturas próprias e vínculos opcionais. Não apagar dados nem pressupor sincronização completa.

Todos os achados precisam ser marcados na fase 0 como “confirmado no HEAD”, “já corrigido” ou “não reproduzido”, com evidência. Não alterar um trecho apenas porque este PRD cita uma versão anterior.

## 5. Responsabilidades após a consolidação

| Responsabilidade | Interface para o usuário | Implementação a preservar/consolidar |
|---|---|---|
| Conversar com clientes | Atendimento/CRM | Atendimento IA, mensagens, tickets e encaminhamento humano |
| Conversar com o negócio | Fala Tu | Entrada comum e contexto autorizado |
| Consultas exatas | Fala Tu | Consultas tipadas existentes, com escopo por empresa/unidade/período |
| Análise do negócio | Fala Tu | Diretor IA sobre dados permitidos |
| Operações financeiras | Fala Tu e telas financeiras atuais | Controller e serviços financeiros existentes |
| Criar/concluir tarefas | Fala Tu e módulo de tarefas | Serviço principal de tarefas |
| Notas e captura a conferir | Fala Tu | Inbox, memória e conferência existentes |
| Arquivos | Conversa e telas atuais | Geradores e repositório de artefatos existentes |
| Sessão WhatsApp | Configurações/Canais | Canal + adaptador Evolution |

Não retirar painéis especializados que entreguem valor próprio. Consolidar apenas entradas equivalentes de conversa e execução. Na suíte, não mostrar dois chats que prometem a mesma gestão sem diferença clara. Aliases de comandos antigos continuam funcionando durante a migração. Não alterar a marca, navegação ou modelo comercial do Solo como consequência técnica.

## 6. Regras obrigatórias de desenvolvimento

**INV-01 — Isolamento:** toda resolução de canal, usuário, dado, aprovação, artefato e execução deve validar a organização; unidade/loja e papel continuam limitando acesso.

**INV-02 — Uma ação, um efeito:** entrada repetida não cria outro registro operacional, não aprova duas vezes e não gera disparo duplicado silencioso.

**INV-03 — Fonte principal:** uma tarefa/compromisso/requisição operacional usa o domínio principal. Conversa, memória e captura guardam referências, não outra cópia editável concorrente do estado.

**INV-04 — Confirmação preservada:** manter cada operação com sua regra atual de confirmação/aprovação. Consultas não exigem aprovação desnecessária; escritas e envios a terceiros seguem regras específicas. Não transformar toda ação simples em burocracia, nem remover confirmação de finanças/campanhas.

**INV-05 — Contratos compatíveis:** não remover rota, mudar formato de resposta ou assinatura pública sem adaptador, mapa de consumidores e teste de migração.

**INV-06 — Conexão independente do uso:** habilitar/desabilitar função não desconecta, apaga ou troca a sessão do número.

**INV-07 — Estado verdadeiro:** token existente, QR exibido e HTTP 2xx não equivalem a sessão conectada, mensagem entregue ou tarefa executada.

**INV-08 — Sem perda:** preservar IDs, histórico, relações, autoria, datas, anexos, aprovações e trilha de auditoria.

**INV-09 — Credenciais protegidas:** segredos administrativos nunca chegam ao navegador, QR/logs públicos, resposta do bot ou contexto da IA.

**INV-10 — Desativação real:** a autorização de uso deve ser verificada na entrada, na criação do envio e na execução posterior da fila.

**INV-11 — Autorização antes da IA:** usuário sem direito não deve ter dados proibidos carregados no prompt; recusar na resposta depois de expor os dados ao modelo é insuficiente.

**INV-12 — Reversão preservadora:** desligar o novo caminho não deve voltar a um fluxo conhecido de exposição entre empresas nem reexecutar efeitos já aplicados.

## 7. RF-01 — Conexão autônoma pelo assinante

### Jornada obrigatória

1. Usuário com permissão de gerenciar canais abre a tela existente e escolhe “Conectar WhatsApp”.
2. Backend resolve empresa e servidor permitido a partir da sessão autenticada. Nunca aceitar `organization_id` arbitrário do corpo/header como autoridade.
3. Mostrar apenas conexões daquela empresa e instâncias previamente atribuídas a ela. Não expor inventário global da Evolution para assinantes.
4. Oferecer “Adicionar número” ou “Usar conexão existente”. Nome técnico da instância é gerado pelo sistema, estável e sem colisão; não exigir digitação do usuário.
5. Persistir intenção de provisionamento e vínculo da organização antes da chamada externa. Usar chave de idempotência e exclusão mútua por operação; clique duplo e duas abas não criam duas instâncias.
6. Reutilizar sessão existente se válida. Se necessário, mostrar QR dentro do ZapFlow; retorno da tela/refresh mantém o mesmo provisionamento.
7. Atualizar o progresso por evento ou consulta de estado, escopados à organização/canal.
8. Mostrar o número confirmado pelo provedor, estado e próximos passos. Não inferir telefone a partir do nome da instância.
9. Exibir seleção dos usos. Recursos não contratados ou sem permissão não podem ser habilitados.

### Regras complementares

- A chave administrativa da Evolution é configuração de infraestrutura/operador. Assinante nunca copia API key, webhook ou endpoint no fluxo normal.
- Importação da ExaForge ou outra instância antiga exige comprovar atribuição à empresa. Digitar um nome de instância existente não autoriza apropriação.
- Se já estiver atribuída a outra organização, negar importação comum e registrar conflito. Transferência de titularidade é procedimento separado, auditado, não fallback.
- Caso a versão suporte pareamento por código, pode ser oferecido como alternativa ao QR após validação de contrato. O aceite inicial não depende desse recurso.
- Em celular, explicar como autorizar em “Dispositivos conectados”; evitar fluxo que dependa de escanear um QR exibido na própria tela sem alternativa viável.
- Testar interface em Chrome Android e Safari iOS, incluindo retorno após alternar para WhatsApp, expiração do QR e retomar conexão pendente.

**Aceite CA-01:** um assinante elegível conecta número novo ou reutiliza sua instância pelo ZapFlow, sem acesso ao Manager, sem exposição de segredos e sem duplicar a sessão.

## 8. RF-02 — Contrato Evolution e estados da conexão

Criar ou adaptar um único adaptador de provedor sobre os serviços existentes. Descobrir a versão por metadados confiáveis ou configuração do operador. Registrar perfil de capacidades e contrato validado: criar/listar/consultar estado, conectar, QR, enviar texto, enviar documento e eventos.

Não tentar variantes destrutivas por adivinhação. Não usar uma chamada de envio real como detecção de endpoint. Separar credencial administrativa de credencial de operação; algumas versões exigem token de instância, outras usam chave global com ID remoto. Selecionar conforme o contrato comprovado, sem sobrescrever automaticamente a configuração de todos os clientes.

Normalizar envelopes GO e variantes já suportadas: `instanceId`, `instanceName`, `instance`, evento, message ID, remetente, chat, `fromMe`, indicador de grupo e mídia. A fonte preferida é ID remoto + servidor; nome só como alias validado. Não usar apenas nome como identificador global entre servidores diferentes.

Estados lógicos propostos, mapeados aos estados atuais por adaptador:

| Dimensão | Estados mínimos | Regra |
|---|---|---|
| Sessão | Não configurada, provisionando, aguardando pareamento, conectada, desconectada, erro | “Conectada” requer evidência do provedor |
| Webhook | Não verificado, saudável, rejeitado, degradado | Não inferir saúde da mera criação de URL |
| Administração | Ativo, pausado | Pausar uso local não é logout remoto |
| Operação | Pronto, pendente de validação, indisponível | Derivado das dimensões e capacidades necessárias |

Persistir timestamps e último erro normalizado. Eventos fora de ordem não podem fazer `LoggedOut` antigo sobrescrever conexão nova sem verificação. QR ausente em sessão conectada significa que pareamento não é necessário, não autorização para reset.

Autocorreção permitida: consultar estado, atualizar assinatura de webhook de forma compatível, repetir chamadas seguras com limites e reconectar preservando sessão. Excluir/recriar instância ou invalidar sessão não é autocorreção silenciosa. Oferecer reset apenas a operador autorizado, com impacto concreto e confirmação explícita no produto.

**Aceite CA-02:** sessão ativa não é apagada por ausência de QR; falha de webhook não é exibida como integração plenamente saudável; todos os eventos afetam exclusivamente o canal correto.

## 9. RF-03 — Usos por funcionalidade e seleção do número

Separar “qual conexão existe” de “quem pode usá-la”. Estender `channels`; criar relacionamento de usos somente se não houver equivalente no HEAD. Nome sugerido: `channel_feature_bindings`.

Campos lógicos mínimos: organização, canal, chave de finalidade, unidade opcional, habilitação de entrada/saída, modo de execução, prioridade, fallback autorizado, versão da política e auditoria de alteração. Tipos e nomes finais devem respeitar o schema existente.

Na funcionalidade, apresentar “Usar WhatsApp” e “Número”: desligado, padrão autorizado ou número específico. Na tela do canal, apresentar a mesma configuração agrupada por área. Ambas editam a mesma fonte de verdade.

Precedência: regra explícita da unidade/finalidade → regra explícita da organização/finalidade → padrão da finalidade autorizado. O canal original da conversa deve ser preservado nas respostas se continuar permitido. Não escolher outro número por conveniência; fallback só existe quando configurado expressamente.

Rejeitar canal de outra organização, provedor incapaz, canal indisponível para aquele efeito e finalidade desativada. Identificador de usuário do Instagram não deve ser interpretado como telefone em fallback WhatsApp.

Criar resolvedor único, com nome conforme convenções do projeto, que receba organização, finalidade, contexto, unidade e destino e devolva decisão e motivo. Substituir progressivamente os SQLs de “primeiro canal”. Desligar `ai_enabled` não substitui essa política.

Migração não habilita tudo. Preservar usos comprovadamente existentes em perfil de compatibilidade, registrar origem e mostrar conflitos; novos usos ficam desligados até configuração. Registros legados sem finalidade não podem contornar bloqueio: classificar pelo produtor conhecido ou manter pendentes para revisão quando ambíguos.

**Aceite CA-03:** desligar campanhas bloqueia campanha direta e enfileirada sem afetar atendimento, gestão e agenda. Alterar uso não provoca QR, logout ou criação de instância.

## 10. RF-04 — Identidade, autorização e modo compartilhado

Criar uma resolução comum de identidade aproveitando usuários/perfis existentes. Conciliar `authorized_managers`, `users.phone` e vínculos relacionados; não converter todo gestor legado em administrador. Telefone é endereço do canal, não substitui o usuário e seu perfil.

No cadastro novo, vincular telefone ao usuário autenticado por prova de posse. Armazenar normalização, verificação, organização e status. Mudança de telefone exige reverificação e revogação do vínculo anterior. Convites ou mecanismos existentes equivalentes devem ser reutilizados. Migração de vínculos legados registra nível de confiança e não aumenta privilégio; vínculos ambíguos ficam pendentes.

A identificação vinda do webhook só é confiável após validação de origem e resolução da instância. Preservar informações do provedor para lidar com identificadores alternativos, formatos brasileiros e grupos; não tratar qualquer JID como telefone removendo sufixos sem validação.

### Ordem de processamento no modo misto

1. Validar origem, normalizar evento e resolver uma única organização/canal.
2. Aplicar controles de repetição e persistência de entrada conforme RF-08.
3. Classificar mensagem própria, grupo ou individual. Mensagem própria não aciona o bot; grupo não recebe gestão interna neste escopo. Preservar usos de grupo já existentes em seus caminhos, sem ativar o novo modo misto neles.
4. Resolver o remetente e seu acesso atual, sem carregar dados de negócio ainda.
5. Recuperar contexto ativo da conversa, suas pendências e funcionalidades habilitadas.
6. Quando houver contexto interno autorizado e intenção compatível, encaminhar à entrada interna comum; quando for contexto de cliente, usar atendimento.
7. Se o remetente tiver os dois papéis e não houver contexto claro, pedir escolha simples entre atendimento e gestão. Não inferir acesso por linguagem natural nem impor toda conversa de funcionário como gestão.
8. Só criar/atualizar contato, ticket e eventos de CRM quando a mensagem pertencer ao atendimento. Auditoria interna usa seus registros próprios.

As superfícies do produto podem mostrar “Atendimento”, “Gestão” e “Ambos” como usos derivados. Não depender apenas de acrescentar `kind='mixed'` a um enum. Consumidores antigos devem continuar recebendo o contrato esperado até sua migração.

Financeiro, relatórios, documentos e operações exigem as permissões do domínio, e não apenas acesso ao Fala Tu. Perguntas abertas delegadas ao Diretor também devem receber contexto filtrado por usuário. Se o serviço aceitar apenas `orgId` e pergunta, ampliar seu contrato com compatibilidade ou usar fachada segura; não confiar somente em regex para detectar pergunta financeira.

Bloquear acesso interno deve produzir resposta sem expor nomes de arquivos, números, existência de clientes ou detalhes da estrutura. Revogação de acesso vale também para jobs aguardando execução e para novos links de arquivos.

**Aceite CA-04:** cliente desconhecido não obtém dados internos com “zap”, “pergunta”, “sou o dono” ou instruções para ignorar permissões; dono autorizado consulta o negócio pelo número comercial sem criar ticket de atendimento.

## 11. RF-05 — Uma entrada de gestão, com serviços compartilhados

Definir contrato interno comum para pedidos de gestão. Reaproveitar os envelopes, correlações, comandos e execução existentes; novos nomes aqui são conceituais, não ordem para criar outro framework.

Entrada mínima: organização, usuário resolvido, canal de origem, finalidade, conversa, correlação, message ID, texto/mídia, unidade, data comercial e referência de contexto. Dados do usuário/organização são derivados no servidor.

Saída mínima: tipo de resultado, texto, referências de evidência, pendência de confirmação se houver, ação/artefato relacionado e estado de execução. Estados devem distinguir resposta, proposta, aprovação pendente, execução, conclusão e falha.

### Fluxos a consolidar

| Fluxo | Fazer | Não fazer |
|---|---|---|
| Perguntas exatas | Reutilizar queries de vendas, caixa, escala e demais serviços | Pedir à IA que invente SQL ou calcular valores financeiros apenas no texto |
| Perguntas abertas | Delegar ao motor executivo com projeção por usuário | Criar segundo motor ou fornecer panorama integral a perfil restrito |
| Tarefas | Usar serviço de tarefas e permissões existentes | Criar tarefa independente no Fala Tu e outra no quadro sem vínculo canônico |
| Compromissos | Distinguir nota pessoal de agendamento operacional; exigir dados necessários | Inventar data, contato, duração ou responsável |
| Compras | Reutilizar requisições e aprovações existentes | Fazer nova cadeia de compra em paralelo |
| Captura/memória | Preservar inbox e desambiguação antes de materializar | Remover notas e listas pessoais por serem “redundância” |
| Finanças | Reutilizar comandos governados existentes | Reduzir revisão/consentimento para facilitar WhatsApp |
| Arquivos | Usar RF-07 e artefatos canônicos | Criar outro armazenamento público para agilizar envio |

Web, app Solo e WhatsApp devem ter adaptadores leves sobre a mesma regra de negócio. Paridade significa a mesma decisão de permissão/ação e o mesmo estado, não layout idêntico. Recursos não disponíveis em um canal devem ser informados, sem promessa falsa.

Preservar aliases antigos: “zap…”, “anota…”, “pergunta…”, “tarefas”, “concluir N”, “confere” e demais comandos existentes confirmados na fase 0. No modo interno autenticado, linguagem natural pode funcionar sem prefixos; não exigir prefixos que só existem para contornar competição entre serviços.

**Aceite CA-05:** uma mesma solicitação enviada pela interface web ou WhatsApp passa pelas mesmas permissões e serviço principal; resposta ou confirmação não depende de qual motor o usuário sabe nomear.

## 12. RF-06 — Contexto, confirmação e prevenção de colisões

Reaproveitar armazenamento de conversas/threads e mecanismos de confirmação. Contexto deve ser persistido por organização + canal + conversa/remetente + usuário quando interno. Não usar apenas uma variável global ou memória de processo para decidir qual ação “SIM” aprova.

Pendência mínima: ID, finalidade, ação, objeto, parâmetros, solicitante, aprovador elegível, canal/conversa de origem, criação, expiração, versão e estado. Aprovação deve reler dados no servidor e validar elegibilidade atual. Permitir confirmação em outra interface autenticada quando houver vínculo inequívoco, com auditoria.

Regras:

- “SIM”, “confirma” ou número isolado só resolve pendência inequívoca e vigente naquele contexto.
- Havendo confirmação de consulta, cobrança e ação interna plausíveis, perguntar qual antes de produzir efeito.
- “Me manda isso em Excel” referencia o último resultado autorizado apropriado; se houver dois assuntos, perguntar qual.
- Ações já executadas retornam o resultado existente; não reaplicam efeito.
- Expiração não equivale a aprovação e não deixa contexto preso eternamente.
- Troca de modo atendimento/gestão não transporta dados internos para o contexto público.
- Erro do handler interno não deve fazer a mesma mensagem cair automaticamente no atendimento com contexto parcial.

**Aceite CA-06:** reenvio de aprovação, resposta ambígua, duas pendências e reinício do servidor não produzem confirmação da ação errada.

## 13. RF-07 — Informações e arquivos pela conversa

### 13.1 Separar consulta, geração, localização e entrega

Essas quatro ações devem ser compostas com componentes existentes, mantendo estados e permissões próprios:

1. Interpretar a intenção e resolver tipo de relatório/arquivo, período, filtros, unidade e formato.
2. Validar acesso antes de consultar, localizar ou gerar. Não listar títulos de documentos proibidos.
3. Consultar serviços autorizados e formar resultado estruturado com fonte, momento da consulta e indicação de ausência de dados.
4. Gerar arquivo pelo gerador apropriado, ou localizar versão existente autorizada.
5. Registrar/reutilizar artefato privado com autoria, classificação, MIME, tamanho, hash, versão dos dados e correlação.
6. Enviar ao remetente autorizado pela mesma conexão permitida; entrega a terceiro exige seleção e autorização explícitas.
7. Atualizar status. Se o provedor aceitou, exibir enviado/aceito; entregue apenas quando houver recibo confiável.

### 13.2 Catálogo inicial obrigatório

| Pedido | Fonte a reutilizar | Saída |
|---|---|---|
| Resumo executivo | `FalaTuReportService`, contexto/projeção existentes | PDF e XLSX atuais; DOCX com mesmas permissões |
| Vendas por dia/período e loja | Consultas e serviços de fechamento/vendas existentes | PDF, XLSX e DOCX; sem inventar dados ausentes |
| Contas a pagar/receber | Serviços financeiros existentes e escopo do usuário | PDF, XLSX e DOCX com filtros explícitos |
| Tarefas por responsável/prazo | Serviço principal de tarefas | PDF, XLSX e DOCX conforme autorização |
| Arquivo já disponível | `ArtifactService` e repositórios já autorizados | Arquivo original ou conversão expressamente suportada |

Na fase 0, validar os nomes dos serviços de domínio. Se não houver consulta equivalente pronta para um relatório, implementar a consulta no domínio correto, não dentro do webhook ou gerador de documento.

Pedidos fora do catálogo devem apresentar opções suportadas ou encaminhamento dentro do sistema. “Qualquer arquivo” não é critério testável e não autoriza inventar um documento empresarial, contrato ou informação.

### 13.3 Regras de formato e consistência

- PDF: reaproveitar gerador existente; tabelas legíveis, paginação sem corte, identificação de período/unidade e dados ausentes.
- XLSX: reutilizar `XlsxService`; valores financeiros como células numéricas, datas consistentes e tratamento de textos que possam ser interpretados como fórmulas. Fórmulas intencionais devem ser geradas por código, não por conteúdo livre.
- DOCX: localizar gerador existente no HEAD; se ausente, adicionar renderer ao serviço de relatórios/artefatos, com biblioteca adequada ao runtime. MIME/extensão corretos e arquivo editável real. Não renomear PDF/HTML para `.docx`.
- Consulta seguida de exportação deve usar o mesmo recorte e snapshot quando a referência é “isso”. Se atualização de dados for solicitada ou necessária, sinalizar nova data/hora de referência.
- Imprimir fonte e instante da consulta nos relatórios; deixar claro dado indisponível, período sem fechamento e eventual integração desatualizada. Zero não substitui dado ausente.
- A geração pesada é job durável. A resposta inicial informa que está preparando; se falhar, comunicar falha e opção de retomada sem cobrar/gerar novamente por duplicidade.

### 13.4 Entrega segura

Ampliar envio de documento para receber MIME, nome e artefato de forma tipada. Não fixar `application/pdf` para XLSX/DOCX. Manter adaptação compatível de chamadores de PDF existentes.

O arquivo permanece privado. Quando o provedor precisar baixar por URL, gerar URL absoluta assinada de curta duração baseada em origem confiável do aplicativo; o retorno relativo de `ArtifactService` precisa ser resolvido corretamente. Renovar link expirado na tentativa de envio somente após revalidar autorização. Não expor path interno, token ou URL permanente pública.

Consultar limites de tamanho/tipos no contrato do provedor instalado. Se o anexo não for suportado, devolver link seguro quando permitido, identificando que é link; não declarar “arquivo anexado”. Para arquivos sensíveis, classificar no momento da criação; não confiar em uma classificação padrão genérica. A assinatura de URL não substitui autorização para emitir o link.

Permissões devem ser revistas no início da geração e antes da entrega. Dados financeiros precisam de classificação e filtro por usuário também na lista de artefatos. Se o usuário pedir envio a outro número, exigir identificação inequívoca do destinatário e direito de compartilhar aquele conteúdo.

**Aceite CA-07:** usuário pede vendas por loja, recebe resposta e solicita PDF/XLSX/DOCX; cada arquivo abre no aplicativo correspondente, mantém valores/período e chega pelo WhatsApp ou fallback seguro declarado. Usuário sem permissão não recebe conteúdo nem link.

## 14. RF-08 — Entrada durável, envio e falhas parciais

Reaproveitar filas e antirrepetição existentes. A recepção deve validar origem/instância antes de registrar deduplicação. Se a entrada for processada em background, persistir antes de responder aceite ao provedor. Não confirmar recebimento durável quando a persistência falhou.

Escopo de deduplicação inclui servidor/provedor, instância, ID do evento/mensagem e tipo relevante; message ID isolado não deve descartar evento legítimo de outra instância. Eventos sem ID confiável precisam de estratégia documentada, sem descartar mensagens diferentes por terem texto igual.

Um claim feito antes de falha parcial não pode causar perda definitiva. Persistir estados de processamento e separar “recebido” de “efeito concluído”. Retentativas de comandos devem se apoiar nos IDs de ação e resultados existentes. Não assumir garantia universal de exactly-once da rede externa.

Nos envios, centralizar organização, finalidade, canal, destinatário, tipo de conteúdo, artefato, correlação e chave idempotente. Revalidar política/permissão no momento de executar. Diferenciar falha permanente, indisponibilidade transitória e resultado desconhecido após timeout. Em resultado desconhecido, reconciliar quando possível antes de repetir; documentar a limitação quando o provedor não fornecer idempotência/consulta.

Reutilizar controles de consentimento, horários, frequência, quota e aprovações. Acrescentar finalidade permite distinguir resposta solicitada, alerta interno, marketing e cobrança; não simplesmente aplicar uma regra de marketing a todo tráfego nem usar “interno” para burlar guardas. Os produtores devem informar sua finalidade e não escolher arbitrariamente uma finalidade privilegiada.

Uma conexão indisponível pausa os envios aplicáveis com motivo visível. Não escolher outra empresa, número pessoal ou canal social. Quando restaurar, revalidar prazo/contexto antes de enviar confirmação antiga, cobrança paga ou lembrete vencido.

**Aceite CA-08:** entrada repetida, job interrompido e timeout de envio têm resultado recuperável e auditável, sem sucesso falso ou repetição silenciosa de efeito.

## 15. RF-09 — Migração de dados e retirada de redundância

Executar migração progressiva, por organização, com modo de simulação e relatório. Não executar normalização de todas as empresas em um job sem limites e checkpoints.

### 15.1 Inventário e plano por registro

Mapear tarefas, compromissos e listas Fala Tu; referências `bridged_*`; objetos principais; vínculos de criador/responsável; anexos; estados e pendências. Classificar:

| Situação | Tratamento |
|---|---|
| Vínculo principal válido e coerente | Reutilizar o objeto e o ID; Fala Tu passa a projetar o estado principal |
| Vínculo válido, mas estados diferentes | Aplicar política determinística apoiada na trilha e domínio; conflito sem evidência vai para revisão |
| Registro operacional sem vínculo | Migrar idempotentemente quando houver dados suficientes e permissão de módulo; preservar origem |
| Nota/evento pessoal sem equivalente operacional | Preservar no Fala Tu; não forçar contato/agendamento de cliente |
| Vínculo quebrado/registro faltante | Registrar conflito; não recriar silenciosamente uma operação histórica |
| Dois possíveis objetos principais | Não deduplicar apenas por título, valor ou proximidade de data; exigir evidência de origem/identidade |

Não migrar nota pessoal para tarefa visível à equipe sem política explícita. Não disparar notificações, webhook, cobrança ou sincronização externa durante backfill; usar modo de migração que preserve auditoria e evite efeitos colaterais.

### 15.2 Evolução de schema

Seguir expandir → preencher → reconciliar → trocar leitura/escrita → observar → descontinuar. Colunas e tabelas novas só se não houver equivalente. Criar restrições de unicidade após resolver conflitos existentes. Considerar o banco e mecanismo de migração reais do projeto; não impor infraestrutura diferente.

Manter mapa de IDs antigo/principal, versão da migração, checkpoint, conflitos, contagens e resultados. Reexecutar lote não cria novos objetos. Interrupção de processo deve retomar sem perder mapeamento.

Evitar escrita independente em dois modelos. Quando compatibilidade exigir projeção antiga, torná-la derivada ou sincronizada por um único caminho idempotente, com proprietário claro do estado. Ações como concluir/reabrir tarefa no quadro e no Fala Tu precisam convergir.

### 15.3 Descontinuação

Remover implementação redundante somente quando: consumidores migrados, equivalência funcional comprovada, dados reconciliados, rollback exercitado e nenhuma dependência ativa conhecida. Manter aliases e adaptadores legados durante pelo menos um ciclo completo de entrega/observação definido no rollout. Não marcar fim da fase se ainda houver escritor paralelo não justificado.

Não apagar tabelas e rotas por “limpeza” neste primeiro rollout. Remoção física é entrega posterior, com inventário de dependências atualizado. É permitido retirar seletor/interface duplicados quando o destino funcional estiver disponível e histórico/acesso preservados.

**Aceite CA-09:** conjunto de dados com vínculos válidos, ausentes, conflitantes e pessoais é migrado duas vezes sem perda, promoção de acesso ou duplicação; estados continuam coerentes entre interfaces.

## 16. RF-10 — Diagnóstico, auditoria e operação

Saúde deve ser por organização/canal, com sessão, webhook, entrada recente, envio recente, erros, fila e última verificação. Não diagnosticar “desconectado” apenas por ausência de tráfego. Estado desconhecido deve ser declarado.

Eventos de UI por socket/polling devem ser isolados à organização e canal. Um QR ou evento de conexão não pode atualizar cartões de todas as empresas. Segredos, QR, tokens de pareamento e conteúdo financeiro não aparecem em logs comuns.

Reutilizar auditoria e correlação: registrar vínculo/importação, mudança de uso, identificação/negação interna, consulta e seus filtros sem conteúdo excessivo, geração/entrega, confirmação, migração e reset explícito. Auditar quem pediu e quem recebeu arquivo, preservando minimização e retenção existentes.

Métricas mínimas: duração/falha de conexão por etapa, rejeição de webhook, resolução ambígua, idade de fila, aceite/entrega quando disponível, acesso negado, duplicidade suprimida, conflitos de migração, falhas de arquivo e consumo IA por ação. Preservar regras comerciais de visibilidade de consumo e valores já existentes.

**Aceite CA-10:** operador identifica qual canal e etapa falharam sem consultar token ou conteúdo confidencial; usuário vê mensagem prática e ação de recuperação compatível.

## 17. Contratos técnicos e modelo mínimo

Os nomes abaixo são propostas. Antes de criar, buscar equivalente no projeto. Não executar DDL ou criar endpoints apenas copiando esta tabela.

### 17.1 Dados necessários

| Conceito | Onde encaixar | Campos/restrições relevantes |
|---|---|---|
| Conexão | `channels` e metadados tipados ou extensão equivalente | Organização, servidor, provedor, versão, ID remoto, aliases, telefone verificado, estados, referência segura da credencial |
| Atribuição da instância | Extensão da conexão/registro de provisionamento | Uma instância remota por servidor atribuída a uma organização; transferência explícita |
| Provisionamento | Job/operação durável existente | ID, idempotência, etapa, canal, erro, resultado e checkpoint; evitar corrida de criação |
| Uso por finalidade | Relacionamento proposto ou equivalente existente | Escopo organização/unidade, canal, finalidade, entrada/saída, versão da política e fallback |
| Identidade de WhatsApp | Usuário e vínculo normalizado | Telefone/ID remoto, usuário, empresa, verificado em, revogado em; ambiguidades não concedem acesso |
| Contexto interno | Threads/envelopes existentes | Usuário, canal/conversa, modo, último resultado autorizado e pendências com prazo |
| Pedido de arquivo | Job + artefato | Relatório, formato, filtros, snapshot, solicitante, destino, classificação, status e correlação |
| Mapa de migração | Mecanismo de reconciliação existente | Fonte, ID antigo, ID principal, resultado, versão, conflito e checkpoint |

Credencial não deve ser tratada como criptografada só porque a coluna se chama `token_encrypted`. Verificar a proteção real e usar o mecanismo de segredos/criptografia existente. Migração de criptografia deve ser compatível e não inutilizar tokens atuais.

### 17.2 APIs a adaptar ou acrescentar

| Operação lógica | Contrato esperado | Compatibilidade |
|---|---|---|
| Listar canais | Apenas da organização autenticada, sem segredos, com saúde e usos permitidos | Evoluir `GET /api/channels`; não quebrar consumidor antigo |
| Iniciar conexão/importação | Organização derivada da sessão; canal/atribuição autorizada; idempotência | Envolver o `EvolutionService`; manter adaptador para rotas legadas |
| Consultar operação/QR | Operação/canal pertencentes à empresa, conteúdo temporário não cacheável | Não expor token remoto junto ao QR |
| Reconectar | Estado consultado e sessão preservada | Não fazer DELETE remoto como fallback |
| Alterar usos | Finalidades válidas, permissão e versão da política | Revalidar concorrência; rejeitar alteração com versão antiga |
| Consulta/ação interna | Entrada comum com identidade obtida pelo adaptador | Web/WhatsApp/Solo delegam à mesma regra |
| Gerar/localizar arquivo | Formato suportado, filtros, referência autorizada | Reutilizar `/api/falatu/reports/summary` e endpoints de artefatos quando aplicável |
| Pausar uso/desconectar/remover | Operações distintas com impacto explícito | Pausar não invalida a sessão; remoção com dependências não é silenciosa |

Para novas APIs, seguir convenções HTTP do projeto: erro de autenticação/autorização sem detalhe sensível; conflito de atribuição/versão como conflito; operação longa aceita com ID consultável; indisponibilidade externa distinguível de configuração inválida. Não devolver sucesso genérico quando a operação está apenas aguardando.

Preservar ordenação de middlewares e rotas de webhook no `server.ts`. O webhook externo não usa o JWT do assinante, mas exige autenticidade do provedor/configuração. Rotas de administração de conexão exigem usuário autenticado e permissão específica. Nunca tornar `/api/evolution/*` público para fazer o QR “funcionar”.

### 17.3 Regras de concorrência

Idempotência do provisionamento deve ser persistida; nome determinístico sozinho não elimina corrida. Um timeout após criação exige reconciliação antes de nova criação. Webhook recebido enquanto o provisionamento termina deve encontrar vínculo pendente previamente registrado. Atualização de estado e vínculo deve ser condicional à versão/operação vigente.

Paginar e limitar operações de backfill, listagem e fila. Não bloquear o processo Express esperando geração pesada. Chamada ao provedor tem timeout e tratamento de resposta inválida. Mensagens novas durante rollout têm um único dono de execução: o modo de comparação paralela só pode produzir decisões observáveis, nunca efeitos em duplicidade.

## 18. Mapa de impactos: onde a IA pode alterar e onde deve ter cuidado

| Área | Alteração permitida | Risco principal | Proteção obrigatória |
|---|---|---|---|
| UI de canais | Formulário, lista, QR, usos e diagnóstico | Perder suporte a canais existentes ou exibir segredo | Testes dos estados e regressão Instagram/Cloud |
| Rota legada de conexão | Delegar ao serviço consolidado | Mudar contrato esperado pela tela ou atribuir empresa errada | Adaptador e testes de consumidores |
| Credenciais | Resolução por contrato/instância | Token inválido para todos os canais | Piloto por canal e fixtures de contratos |
| Webhook | Normalização, identidade e entrada durável | Roteamento errado, perda, duplicidade | Fixtures GO/legado, multiempresa e falhas parciais |
| `webhookProcessor` | Separar interno antes do CRM | Remover atendimento/agenda/cobrança existente | Testes de precedência e resposta única |
| `MessageProviderService` | Contexto/finalidade/MIME | Quebrar todos os produtores e Instagram | Assinatura compatível e revisão de chamadas |
| Scheduler e automações | Usar resolvedor/entrega comum | Enviar pelo número errado ou parar avisos legítimos | Migração por produtor e cobertura de guardas |
| Fala Tu e tarefas | Delegar ao domínio principal | Perder notas ou duplicar tarefa | Backfill idempotente e reconciliação |
| Aprovações | Contextualizar e unificar adaptadores | Aprovar efeito indevido ou executar duas vezes | Aprovação vinculada, expiração e permissão atual |
| Relatórios/artefatos | Novos formatos e entrega | Exposição de dados ou arquivo inválido | Projeção, classificação, assinatura e abertura real |
| Banco/schema | Extensões e mapeamentos | Perda de histórico, bloqueio do banco | Backup restaurável, lote, checkpoint e sem DROP inicial |
| Solo/assinaturas | Reutilizar conexão comum mantendo contratos | Quebrar produto independente e cobrança | Regressão Solo e nenhuma mudança comercial |

**Não modificar incidentalmente:** regras de impostos/pagamentos, comissão do varejo, integrações Alterdata, conteúdo clínico, cálculos de saldo, contratos de plano, limites de IA, OAuth, identidades de outras redes e permissões não relacionadas. Se um defeito nesses pontos bloquear o escopo, registrar impacto e fazer correção isolada com testes próprios; não aproveitar o PR para refatoração geral.

## 19. Fases obrigatórias e ordem de execução

As fases são partes do mesmo PRD. Cada uma tem gate próprio; concluir uma não significa concluir o PRD inteiro. Usar PRs pequenos por responsabilidade. Não misturar migração, novo roteamento e remoção de legado em um único PR sem possibilidade de reversão.

### Fase 0 — Revalidar e congelar a linha de base

- **F0.1:** ler instruções locais e comparar HEAD com o commit auditado; atualizar lista de achados sem repetir correções existentes.
- **F0.2:** mapear todos os produtores/consumidores de WhatsApp, arquivos, aprovação, identidade e vínculos Fala Tu; distinguir integração automática de atalho `wa.me`.
- **F0.3:** confirmar contrato da Evolution instalada por Swagger/documentação/configuração autorizada; preparar fixtures sanitizadas de eventos/respostas.
- **F0.4:** registrar testes atuais, falhas preexistentes, schema, flags, APIs, rollback e dados de teste. Fazer simulação inicial da migração.

**Gate G0:** inventário rastreável e baseline revisáveis. Sem acesso à Evolution real, continuar código e testes por contrato, registrando validação real pendente; não inventar teste de produção.

### Fase 1 — Corrigir fundação da conexão

- **F1.1:** centralizar configuração/credenciais e normalização de ID/eventos no adaptador.
- **F1.2:** corrigir vínculo de organização, URL protegida, assinatura de eventos e estados comprovados.
- **F1.3:** remover reset destrutivo automático do caminho novo; tornar provisionamento idempotente e recuperável.
- **F1.4:** integrar rotas legadas e Solo ao serviço compatível, mantendo contratos e isolamento.

**Gate G1:** CA-02 e CA-10 demonstrados em testes; nenhuma sessão ativa apagada; nenhuma atribuição global indevida; regressões de conexão existentes passam.

### Fase 2 — Conexão autônoma e configuração dos usos

- **F2.1:** implementar importação autorizada, criação, QR e retomada dentro da UI existente.
- **F2.2:** implementar fonte única de usos, resolvedor, controles no backend e estado por canal.
- **F2.3:** migrar preferências existentes sem habilitação indiscriminada; apresentar conflitos e padrões herdados.
- **F2.4:** validar UX móvel e atualização de políticas com bloqueio de envios pendentes.

**Gate G2:** CA-01 e CA-03; usuário conecta sem Manager; configurar uso não altera sessão. Modo misto ainda não é habilitado para toda a base.

### Fase 3 — Identidade e conversa interna unificadas

- **F3.1:** conciliar identificação, prova de posse e permissões de usuário; revisar caminho aberto do Diretor.
- **F3.2:** unificar entrada web/WhatsApp e contextos com serviços existentes; preservar aliases.
- **F3.3:** implementar modo misto com roteamento anterior ao CRM e uma única resposta por entrada.
- **F3.4:** vincular confirmações, expiração e contexto; cobrir negação, papéis duplos e mensagens próprias.

**Gate G3:** CA-04, CA-05 e CA-06; dados internos não chegam a cliente nem à caixa de atendimento. Falha de autorização bloqueia rollout.

### Fase 4 — Consolidar registros operacionais do Fala Tu

- **F4.1:** gerar relatório por registro e resolver vínculos/conflitos com a política da RF-09.
- **F4.2:** implementar lote idempotente/checkpoint e modo sem notificações/efeitos externos.
- **F4.3:** transferir leitura/escrita operacional ao domínio principal, preservando notas e objetos pessoais.
- **F4.4:** demonstrar sincronismo de conclusão/reabertura, ausência de duplicidade e reversão de leitura/compatibilidade.

**Gate G4:** CA-09; contagens e vínculos reconciliados; pendências justificadas ficam isoladas e não autorizam apagar dados. Escritores paralelos não justificados impedem conclusão.

### Fase 5 — Solicitar e receber arquivos pela conversa

- **F5.1:** implementar catálogo e referência do último resultado/filtros com autorização.
- **F5.2:** reutilizar PDF/XLSX e adicionar DOCX real se ainda não existir gerador equivalente.
- **F5.3:** conectar geração/localização à fila de entrega de documentos com MIME e URL assinada corretos.
- **F5.4:** validar abertura, dados, classificação, permissão revogada, tamanho e fallback declarado.

**Gate G5:** CA-07; todos os formatos obrigatórios comprovados com arquivos reais gerados em teste; não marcar Word concluído com extensão reconhecida apenas.

### Fase 6 — Integrar os demais usos e validar falhas

- **F6.1:** migrar consumidores remanescentes do inventário para seleção por finalidade, sem alterar regras de domínio.
- **F6.2:** consolidar entrega e deduplicação, com tratamento de timeout/falha parcial e política na execução.
- **F6.3:** verificar guardas de marketing, cobrança, agenda, clínica, escola, varejo, prospecção e demais produtores mapeados.
- **F6.4:** validar saúde, métricas, auditoria, regressões de outros canais e teste de carga representativo do piloto.

**Gate G6:** CA-08 e CA-10; inventário sem produtor automático capaz de ignorar uso desativado; falhas permanentes/transitórias/indeterminadas distinguíveis.

### Fase 7 — Piloto, observação e descontinuação controlada

- **F7.1:** simular restauração/rollback, selecionar empresa/números de teste autorizados e registrar configuração inicial.
- **F7.2:** habilitar piloto por organização/canal e observar ciclo real que cubra atendimento, gestão, automação agendada e arquivos.
- **F7.3:** corrigir regressões e reconciliar migração/filas; ampliar somente com gates cumpridos.
- **F7.4:** retirar interfaces e implementações duplicadas elegíveis, preservando compatibilidade/histórico e documentando pendências de remoção física.

**Gate G7:** todos os aceites demonstrados, piloto aprovado conforme processo do projeto, rollback exercitado e nenhuma falha crítica aberta. Sem acesso ao piloto, entregar “implementado/testado localmente; validação real pendente”, nunca “pronto em produção”.

## 20. Plano de testes orientado a riscos

### 20.1 Reutilizar testes existentes

Os comandos abaixo constam no `package.json` auditado. Confirmar no HEAD. Executar os pertinentes a cada fase; não repetir a suíte inteira a cada mudança cosmética. Não alterar teste para esconder regressão; mudança legítima de contrato exige justificativa.

| Área | Comandos existentes úteis |
|---|---|
| Compilação/tipos | `npm run lint` (no commit analisado executa `tsc --noEmit`); `npm run build` |
| WhatsApp/Fala Tu | `npm run test:falatu-whatsapp`; `npm run test:falatu-ask-whatsapp`; `npm run test:falatu-solo-whatsapp`; `npm run test:falatu-trigger-only` |
| Gestão/contexto | `npm run test:gestor-command`; `npm run test:falatu-ask`; `npm run test:falatu-context-projection`; `npm run test:context-security`; `npm run test:security-money-gating` |
| Captura/migração | `npm run test:falatu`; `npm run test:falatu-capture-dedup`; `npm run test:falatu-bridge-recon`; `npm run test:falatu-porta`; `npm run test:falatu-porta-events`; `npm run test:falatu-porta-lists` |
| Aprovações | `npm run test:falatu-approval`; `npm run test:falatu-approve-whatsapp`; `npm run test:two-step-approval-security` |
| Arquivos | `npm run test:falatu-report`; `npm run test:falatu-file-intake`; `npm run test:security-media-signing` |
| Webhook/entrega | `npm run test:security-webhook`; `npm run test:delivery-receipts`; `npm run test:channel-health`; `npm run test:security-tenant` |
| Outros canais | `npm run test:instagram-send`; `npm run test:social-channel-contract`; `npm run test:quote-email-channel` |
| Produtores sensíveis | `npm run test:collection-family-choke-point`; `npm run test:collection-cadence-choke-point`; `npm run test:clinic-monthly-report-delivery` |
| Preservação Solo | `npm run test:falatu-entitlement`; `npm run test:falatu-enforcement`; `npm run test:falatu-plans` |

Não é necessário executar estes testes para redigir o PRD. A IA implementadora deve registrar execução real, ambiente, comando e resultado; falhas preexistentes separadas de regressões novas.

### 20.2 Novos cenários obrigatórios

| ID | Cenário | Resultado verificável |
|---|---|---|
| T01 | Duplo clique/duas abas ao conectar | Uma operação efetiva, uma instância e um canal |
| T02 | Timeout após criação remota | Reconsulta/reconciliação sem nova instância |
| T03 | Instância já conectada sem QR | Sessão preservada, estado correto, nenhum DELETE |
| T04 | Tentativa de importar instância de outra empresa | Negada, sem exposição de credenciais |
| T05 | Duas empresas e nomes semelhantes; servidores diferentes | Entrada/saída sempre na atribuição correta |
| T06 | GO por instanceId/instanceName e legado por instance | Normalização correta; identificador desconhecido não vai ao default |
| T07 | Segredo inválido e provedor fora do ar | Rejeição/indisponibilidade distintas, sem verde falso |
| T08 | QR expirado e retorno do celular | Nova tentativa preserva vínculo e sessão apropriada |
| T09 | Desativar campanha já enfileirada | Campanha bloqueada; resposta de atendimento continua |
| T10 | Alterar número/fallback por finalidade | Somente regra autorizada é aplicada; sem cross-channel indevido |
| T11 | Cliente usa prefixo de gestor ou prompt malicioso | Nenhum dado interno carregado/exposto |
| T12 | Colaborador pergunta finanças de forma indireta | Contexto continua filtrado, inclusive no Diretor |
| T13 | Dono consulta por canal comercial | Resposta interna sem ticket/lead comercial |
| T14 | Pessoa com papel interno e cliente | Contexto/mode definidos sem promoção automática |
| T15 | Duas pendências e “SIM” | Clarificação, nenhum efeito arbitrário |
| T16 | Confirmação repetida/expirada após reinício | Mesmo resultado anterior ou expiração, sem novo efeito |
| T17 | Mesma ação por web e WhatsApp | Mesma regra, autorização e estado |
| T18 | Migração executada duas vezes e interrompida | Sem duplicatas, checkpoints retomáveis |
| T19 | Tarefa com estado divergente e nota pessoal | Conflito tratado; nota não se torna pública |
| T20 | Concluir/reabrir pela outra interface | Estado principal consistente |
| T21 | “Isso em Excel/Word/PDF” após consulta | Dados e filtros preservados, arquivos válidos |
| T22 | Arquivo de outra empresa/permissão revogada | Sem conteúdo, título restrito ou link |
| T23 | Link expirado e envio retomado | Revalidação antes de novo link; sem URL permanente |
| T24 | Texto de planilha semelhante a fórmula | Tratado como dado, não fórmula externa acidental |
| T25 | Mensagem repetida e falha depois de persistir | Processamento retomável, efeito não duplicado |
| T26 | Timeout com resultado de envio desconhecido | Reconciliação/estado indeterminado, sem sucesso falso |
| T27 | Mensagem própria e grupo | Sem ciclo do bot e sem nova gestão interna em grupo |
| T28 | Instagram/Cloud/Solo após mudança central | Contratos preservados e guardas mantidas |
| T29 | Socket/status/QR de outra organização | Nenhum vazamento para UI de outro tenant |
| T30 | Rollback com jobs pendentes e efeitos já executados | Sem perda de jobs, replay de efeito ou retorno inseguro |

Fixtures devem usar dados sintéticos ou sanitizados. Testes de rede real precisam de ambiente/número/destinatário de teste autorizados. Não usar contatos de clientes como teste automático.

## 21. Rollout, reversão e critérios de interrupção

Preferir controle por organização/canal e flags existentes. Se forem necessárias flags novas, mantê-las poucas, explícitas e com data/critério de retirada: conexão consolidada, roteamento interno, leitura canônica e arquivos conversacionais. Não criar dezenas de estados combinatórios impossíveis de testar.

Ordem: staging com fixtures → dados de migração representativos → número de teste autorizado → empresa piloto → ampliação gradual. Em modo de comparação, o caminho novo não envia mensagens nem executa ações.

Registrar no início do piloto: baseline de falhas, volume, tempo de resposta, configuração de canal, flags, filas e contagens de dados. Definir janela de observação que cubra automações diárias relevantes e critérios objetivos de latência/capacidade a partir dessa baseline; não inventar SLA como se já fosse garantido pelo fornecedor.

Interromper ampliação e isolar a função afetada em caso de: acesso entre empresas; exposição interna ao CRM público; exclusão/repareamento inesperado; duplicação de efeito financeiro; perda de tarefa/arquivo; aumento de falha sem explicação; migração não reconciliada. Continuar trabalho local no restante que não depende da falha.

Rollback deve preferir desligar o novo roteamento e restaurar adaptadores/leituras compatíveis, mantendo migrações aditivas e mapeamentos. Não restaurar banco antigo cegamente sobre dados novos de produção. Restaurar backup é ação de recuperação separada, com reconciliação dos eventos após o backup. Tokens/sessões não são revertidos por simples troca de código; documentar alterações remotas e como preservá-las.

Não reverter para código conhecido de resolução incorreta de tenant. Nesse caso, manter recebimento durável e pausar processamento afetado até correção. Histórico, IDs de efeito, política atual e filas devem sobreviver ao rollback.

## 22. Checklist obrigatório ao final de TODA entrega da IA

Entregar este quadro atualizado mesmo quando a entrega for parcial, diagnóstico ou correção. Nunca escrever somente “feito”, “100%” ou “todos os testes passaram”. Não marcar implementação como validação de produção.

Estados permitidos: `NÃO INICIADO`, `EM ANDAMENTO`, `IMPLEMENTADO`, `VALIDADO`, `BLOQUEADO`, `NÃO APLICÁVEL — JUSTIFICADO`. IMPLEMENTADO exige código; VALIDADO exige evidência dos testes/gate pertinentes. Bloqueado exige causa concreta e próximo passo, não uma promessa genérica.

### 22.1 Quadro acumulado — estado inicial

| Fase | Itens | Estado | Evidência | Pendência para o gate |
|---|---|---|---|---|
| F0 | F0.1–F0.4 | NÃO INICIADO | PRD é especificação | Revalidar HEAD/contrato e baseline |
| F1 | F1.1–F1.4 | NÃO INICIADO | — | G1 |
| F2 | F2.1–F2.4 | NÃO INICIADO | — | G2 |
| F3 | F3.1–F3.4 | NÃO INICIADO | — | G3 |
| F4 | F4.1–F4.4 | NÃO INICIADO | — | G4 |
| F5 | F5.1–F5.4 | NÃO INICIADO | — | G5 |
| F6 | F6.1–F6.4 | NÃO INICIADO | — | G6 |
| F7 | F7.1–F7.4 | NÃO INICIADO | — | G7 |

Os 32 itens acima precisam aparecer individualmente no checklist de acompanhamento mantido pela IA no repositório, com critérios e links de evidência. O quadro resumido não substitui os itens individuais.

### 22.2 Modelo de prestação de contas

```text
ENTREGA: <identificador e fase>
HEAD de entrada: <SHA real>
Commit/PR entregue: <SHA/link real; ou “sem commit”>

Resultado para o usuário:
<comportamento concreto que passou a funcionar>

Itens desta entrega:
| ID | Estado anterior | Estado atual | Arquivos/PR | Teste/evidência | Pendência |

Checklist acumulado:
<todos os F0.1–F7.4; preservar itens concluídos e pendências anteriores>

Reuso e redundância:
- Serviço reutilizado:
- Caminho repetido consolidado:
- Adaptador legado preservado e condição de retirada:
- Novo componente, se houver, e por que nenhum existente atendia:

Dados e migração:
- Simulação/aplicação, ambiente e lote:
- Registros lidos / vinculados / migrados / conflitantes:
- Segunda execução e resultado:
- Efeitos externos disparados durante migração: <esperado zero>

Validação:
| Comando/cenário | Ambiente | Resultado real | Evidência |
Falhas preexistentes:
Regressões novas:
Testes não executados e motivo:

Gates/invariantes afetados:
<CA, G e INV pertinentes, com evidência>

Ativação:
- Flags/configurações alteradas:
- Piloto/produção: <não iniciado, em teste ou validado, com evidência>
- Reversão disponível e como foi exercitada:

Riscos e bloqueios restantes:
Próxima entrega prioritária:
```

Se exibir percentual, informar denominador e peso. Não equiparar um item cosmético a isolamento multiempresa; preferir itens/gates concluídos. Nunca atualizar o checklist apagando um item que ficou difícil de implementar.

### 22.3 Checklist individual inicial — copiar para o acompanhamento

Marcar checkbox somente quando o item estiver VALIDADO, com evidência no quadro de prestação de contas. Até lá, indicar o estado intermediário em texto. Todos começam pendentes.

- [ ] F0.1 — HEAD e achados revalidados; correções já existentes reconhecidas.
- [ ] F0.2 — Produtores, consumidores, identidades e vínculos mapeados.
- [ ] F0.3 — Contrato Evolution e fixtures sanitizadas registrados.
- [ ] F0.4 — Baseline, simulação de migração e plano de reversão registrados.
- [ ] F1.1 — Configuração, credenciais e normalização centralizadas.
- [ ] F1.2 — Empresa, webhook protegido e estados corretos.
- [ ] F1.3 — Provisionamento idempotente; sessão protegida contra reset automático.
- [ ] F1.4 — Rotas legadas e Solo compatíveis com a fundação comum.
- [ ] F2.1 — Importação/criação/QR/retomada disponíveis na UI existente.
- [ ] F2.2 — Usos por funcionalidade e resolvedor aplicados no backend.
- [ ] F2.3 — Preferências migradas sem habilitação indiscriminada.
- [ ] F2.4 — Fluxo móvel e bloqueio de pendências ao desligar validados.
- [ ] F3.1 — Identidade e permissão unificadas, incluindo perguntas abertas.
- [ ] F3.2 — Entrada comum web/WhatsApp com aliases preservados.
- [ ] F3.3 — Modo misto sem vazamento de conversa interna para CRM.
- [ ] F3.4 — Confirmações, expiração e papéis ambíguos tratados.
- [ ] F4.1 — Relatório de vínculos e conflitos por registro disponível.
- [ ] F4.2 — Migração idempotente retomável sem efeitos externos.
- [ ] F4.3 — Registros operacionais principais preservados; notas pessoais mantidas.
- [ ] F4.4 — Conclusão/reabertura e reversão coerentes entre interfaces.
- [ ] F5.1 — Catálogo, contexto e autorização de arquivos implementados.
- [ ] F5.2 — PDF/XLSX reutilizados e DOCX real gerado.
- [ ] F5.3 — MIME, fila, artefato e entrega segura integrados.
- [ ] F5.4 — Arquivos abertos e dados/permissões/fallback verificados.
- [ ] F6.1 — Consumidores remanescentes usam seleção por finalidade.
- [ ] F6.2 — Falhas parciais, deduplicação e políticas de fila validadas.
- [ ] F6.3 — Guardas das verticais e automações preservadas.
- [ ] F6.4 — Saúde, métricas, outros canais e capacidade do piloto verificados.
- [ ] F7.1 — Rollback exercitado e piloto autorizado preparado.
- [ ] F7.2 — Ciclo representativo do piloto executado e observado.
- [ ] F7.3 — Regressões corrigidas e reconciliação concluída antes de ampliar.
- [ ] F7.4 — Redundâncias elegíveis retiradas; compatibilidade e histórico preservados.

## 23. Definition of Done do PRD completo

- [ ] CA-01 a CA-10 comprovados e G0 a G7 satisfeitos.
- [ ] Atendimento existente preservado com contexto interno separado.
- [ ] Assinante conecta/importa/reconecta pelo ZapFlow sem Manager no fluxo normal.
- [ ] Uma instância não é criada por funcionalidade e nenhum uso habilitado exige novo pareamento.
- [ ] Todos os produtores automáticos mapeados respeitam seleção/desativação de finalidade.
- [ ] Consultas abertas e arquivos usam as mesmas permissões de dados do usuário.
- [ ] Fala Tu, tarefas e agenda operacional compartilham fontes principais sem perda de notas pessoais.
- [ ] PDF, XLSX e DOCX solicitados na conversa são válidos, consistentes e entregues com segurança.
- [ ] Filas, confirmações e migrações sobrevivem a repetição/reinício sem efeitos duplicados nos cenários cobertos.
- [ ] Regressões de WhatsApp Cloud, Instagram e Fala Tu Solo verificadas conforme impacto.
- [ ] Logs e diagnóstico não expõem tokens, QR de outras empresas ou documentos restritos.
- [ ] Rollback preservador testado; nenhum reset remoto silencioso permanece no novo fluxo.
- [ ] Checklist acumulado, decisões, testes, migração e instruções de operação atualizados.
- [ ] Toda limitação residual consta no resultado; não existe aprovação de produção fictícia.

## 24. Inventário inicial para rastrear consumidores

A auditoria identificou 36 grupos de integração programática. São agrupamentos funcionais, não 36 módulos ou instâncias. A fase 0 deve transformar essa lista em mapa de produtores/chamadores do HEAD e acrescentar os que surgiram depois. Transporte, fila e webhook são infraestrutura compartilhada, não grupos extras.

| ID | Grupo | Ponto inicial de busca em `src/server/` |
|---|---|---|
| U01 | Atendimento IA/humano e CRM | `webhookProcessor.ts`, `routes/messages.ts`, `botOutbound.ts` |
| U02 | Cadências de atendimento | `CadenceService.ts` |
| U03 | Campanhas | `CampaignService.ts` |
| U04 | Prospecção | `ProspectExecutionService.ts` |
| U05 | Recuperação comercial | `SalesRecoveryPlaybook.ts`, `SalesRecoveryReplyService.ts` |
| U06 | Carrinho abandonado | `Scheduler.ts` |
| U07 | Recompra | `Scheduler.ts` |
| U08 | Satisfação/pós-venda | `SatisfactionService.ts`, `Scheduler.ts`, `webhookProcessor.ts` |
| U09 | Avaliação de beleza | `BeautyReviewInviteCommandHandler.ts` |
| U10 | Pedidos e pagamentos | `PaymentService.ts`, `webhookProcessor.ts`, `Scheduler.ts` |
| U11 | Assinaturas/mensalidades | `SubscriptionService.ts`, `Scheduler.ts` |
| U12 | Cobrança, promessa e PIX | Família `Collection*Service.ts` e `CollectionPlaybook.ts` |
| U13 | Orçamentos | `QuoteService.ts` |
| U14 | Cotação a fornecedores | `SupplierQuoteService.ts` |
| U15 | Agendamento geral | `AppointmentService.ts`, `Scheduler.ts`, `webhookProcessor.ts` |
| U16 | Reservas/eventos | `ReservationService.ts`, `EventInquiryService.ts`, `webhookProcessor.ts` |
| U17 | Confirmação clínica | `ClinicReminderService.ts`, `ClinicReminderReplyService.ts` |
| U18 | Vagas clínicas | `ClinicVacancyService.ts` |
| U19 | Documentos clínicos | `ClinicDocumentDeliveryService.ts` |
| U20 | Guias clínicas | `ClinicGuideDeliveryService.ts` |
| U21 | Adendo clínico | `ClinicAddendumNoticeService.ts` |
| U22 | Seguimento clínico | `ClinicFollowUpNoticeService.ts` |
| U23 | Relatório clínico mensal | `ClinicMonthlyReportDeliveryService.ts` |
| U24 | Coordenador/tarefas | `CoordenadorService.ts`, `TaskAudioService.ts`, `TaskReminderService.ts` |
| U25 | Gestão/Controller/Diretor | `GestorCommandService.ts`, `ExecutiveAdvisorService.ts`, `AIOrchestratorService.ts` |
| U26 | Fala Tu conversacional | `FalaTuWhatsAppService.ts`, `RuntimeCommandHandlers.ts` |
| U27 | Briefing Fala Tu | `FalaTuBriefingDigestService.ts` |
| U28 | Tutor do negócio | `BusinessTutorService.ts` |
| U29 | Fechamento de varejo | `RetailWhatsAppIntakeService.ts`, `Scheduler.ts` |
| U30 | Resumo de operação da loja | `RetailFloorDigestService.ts` |
| U31 | Comunicação escolar | `routes/escola.ts`, digests e avisos associados |
| U32 | Radar de Execução IA | `RadarService.ts` |
| U33 | Estoque por foto | `WhatsAppInventoryIntake.ts` |
| U34 | Compras por voz/texto | `AIOrchestratorService.ts` |
| U35 | Indicação | `ReferralService.ts`, `webhookProcessor.ts` |
| U36 | Boas-vindas de cadastro administrativo | `routes/admin.ts` |

Preservar também os cinco atalhos identificados: confirmação Comigo, cobrança de fiado Comigo, compra da vitrine, compartilhamento Fashion Studio e encaminhamento Instagram. Eles abrem `wa.me` e não exigem conexão Evolution. Não transformá-los silenciosamente em envio automático nem bloquear seu funcionamento só porque o número não está pareado.

Para cada U01–U36, a IA deve registrar: produtor, handler de resposta, serviço de domínio, resolver de canal atual, finalidade futura, guardas, fila, teste e estado de migração. O grupo U26 inclui a ação genérica de envio usada por automações; verificar produtores indiretos, não apenas chamadas literais ao provedor.

## 25. Fontes e limites de evidência

Os links abaixo fixam a versão auditada. Eles sustentam o diagnóstico; o desenho, IDs RF/CA/F/T e nomes sugeridos deste PRD são requisitos novos.

- [Repositório e commit](https://github.com/Eldastito/exaforgeStudio/tree/836283828df743043772ae479678f2f6a0875d42)
- [Entrada e roteamento](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/webhookProcessor.ts)
- [Gestão no orquestrador atual](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/AIOrchestratorService.ts)
- [Perguntas e conversação Fala Tu](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/FalaTuAskService.ts)
- [Adaptador WhatsApp Fala Tu](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/FalaTuWhatsAppService.ts)
- [Captura e vínculos operacionais](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/FalaTuService.ts)
- [Conexão Evolution](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/EvolutionService.ts)
- [Rotas legadas e eventos](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/server.ts)
- [Transporte de mensagens](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/MessageProviderService.ts)
- [Relatórios PDF/XLSX existentes](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/FalaTuReportService.ts)
- [Artefatos e controle de acesso](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/src/server/ArtifactService.ts)
- [ADR-116 de multi-instância, ainda marcado como planejado no commit](https://github.com/Eldastito/exaforgeStudio/blob/836283828df743043772ae479678f2f6a0875d42/docs/adr/ADR-116-multi-instancia-whatsapp-onboarding.md)
- [Documentação pública Evolution GO — webhooks](https://docs.evolutionfoundation.com.br/evolution-go/webhooks)
- [Documentação pública Evolution GO — conexão](https://docs.evolutionfoundation.com.br/evolution-go/connect-to-instance)

O Swagger da instalação efetiva prevalece sobre suposições de compatibilidade entre versões. Não foram validados credenciais, tráfego, dados de clientes ou geração/entrega real na Evolution do usuário nesta elaboração. O trabalho entregue é este PRD; o checklist de implementação começa em NÃO INICIADO.
