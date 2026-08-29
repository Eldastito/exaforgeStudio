# PRD-ZF-ALTERDATA-GOLIVE-01
## Integração Alterdata/ModaUp segura para produção

**Status:** Proposto
**Prioridade:** P0 — bloqueador de go-live
**Repositório:** `Eldastito/exaforgeStudio`
**Base analisada:** `main`, commit `76bbdb5e37ea66a9fffbba28e6d145f07bf39eca`
**Responsável técnico:** IA Dev / Engenharia ZapFlow
**Vertical inicial:** Toulon – Moda/Varejo

---

## Resumo executivo

Os dez links OpenAPI fornecidos pela Alterdata cobrem as APIs necessárias
ao núcleo varejista, mas **não** concedem acesso nem fazem todas as
funcionalidades do ZapFlow serem alimentadas automaticamente; produção
exige entregas separadas de ZapFlow, Alterdata e Toulon.

### Os dez links resolvem o problema?

| Pergunta | Resposta |
|---|---|
| Os links comprovam que as APIs existem? | **Sim.** |
| Eles contêm as rotas necessárias para catálogo, estoque, preços, vendas e clientes? | **Sim.** |
| Eles concedem acesso aos dados? | **Não.** Falta credencial e token Guardian. |
| Eles garantem que os dados da Toulon estão disponíveis e corretos? | **Não.** Isso só é validado com chamadas autenticadas. |
| Eles colocam o ZapFlow em produção? | **Não.** São apenas uma dependência externa. |
| Eles alimentam todas as funcionalidades do ZapFlow? | **Não.** Atualmente o código consome quatro módulos. |
| Eles são suficientes para o núcleo varejista da Toulon? | **Potencialmente sim**, depois das correções do ZapFlow, credenciais, códigos e homologação. |

**Conclusão:** os dez links fornecem documentação e endereços suficientes.
Para o go-live varejista, o ZapFlow precisa efetivamente acessar e
consumir Guardian, Supply, Price e Sales. CRM é condicional. Os outros
módulos não bloqueiam a entrada em produção porque ainda não existem
conectores que os utilizem.

---

## Glossário — o que significam os termos usados

| Termo | Significado real |
|---|---|
| **Consumido pelo sincronizador** | O código do ZapFlow chama a API, recebe os dados, transforma e grava nas tabelas do ZapFlow. |
| **Não consumido atualmente** | A API existe, mas nenhum job do ZapFlow chama esse módulo. O link sozinho não alimenta nada. |
| **Registrado, mas não sincronizado** | O ZapFlow conhece o nome/subdomínio do módulo, mas não possui rotina completa de importação. |
| **Futuro** | Pode ser integrado posteriormente, mas não faz parte do go-live atual. |
| **Rota confirmada** | O Swagger declara que a rota existe. Não significa que a credencial possui acesso nem que haverá dados. |
| **Escopo Guardian precisa ser confirmado** | O token precisa possuir uma permissão específica. Para Financial, o nome dessa permissão não está configurado no ZapFlow. |
| **Dependência externa** | Algo que o ZapFlow não pode produzir sozinho: API, credencial, permissão, códigos e dados do ERP. |
| **Dependência interna** | Código, infraestrutura, mapeamento, monitoramento, segurança e interface que são responsabilidade do ZapFlow. |

---

## Módulos que realmente alimentam o ZapFlow

### Guardian — autenticação

Não está entre os dez links, mas é uma dependência obrigatória.

```text
POST https://guardian.apimodaup.com.br/connect/token
```

Fornece o token Bearer necessário para acessar as APIs. Sem usuário,
senha, scopes e token funcionando, os dez links são somente documentação.

### Supply — obrigatório

Alimenta:
- catálogo de produtos;
- referências;
- variantes;
- cor e tamanho;
- códigos de barras;
- estoque por filial;
- capital em estoque;
- produtos sem giro;
- disponibilidade na vitrine.

Situação: implementado no [`AlterdataSyncRunner`](https://github.com/Eldastito/exaforgeStudio/blob/main/src/server/AlterdataSyncRunner.ts).

### Price — obrigatório para produção comercial

Alimenta:
- preço por SKU/variante;
- tabela de preço;
- preço da vitrine;
- análise de margem;
- precificação das peças.

Sem Price, alguns produtos podem ficar com preço-base, preço incorreto
ou `R$ 0,00`.

### Sales — obrigatório para entregar a vertical Toulon completa

Alimenta:
- fechamento de caixa;
- vendas por loja;
- divergências;
- VendaMalote;
- ranking de vendedores;
- comissão;
- peças vendidas;
- formas de pagamento;
- parcelas, taxas e recebíveis de cartão;
- faturamento para Diretor IA, caixa e DRE.

A ponte para o financeiro já existe no [`RetailRevenueBridgeService`](https://github.com/Eldastito/exaforgeStudio/blob/main/src/server/RetailRevenueBridgeService.ts),
mas é opt-in. Portanto, mesmo com Sales funcionando, o ZapFlow precisa
ativar e validar essa ponte.

### CRM — condicional

Alimenta uma base separada de clientes do PDV:
- nome, CPF, telefone, e-mail, nascimento, última compra, filial.

**Importante:** esses clientes não entram automaticamente no CRM
principal, Inbox ou campanhas. O código guarda os dados em
`retail_pdv_customers`, separado dos contatos do WhatsApp.

Para usar CRM, são necessários:
- autorização da Toulon;
- base legal LGPD;
- finalidade definida;
- retenção;
- controle de acesso;
- habilitação do `pdvCustomerImport`.

### Módulos que não alimentam o ZapFlow atualmente

| Módulo | Situação |
|---|---|
| Human Resources | Nenhum sincronizador/mapeador atual |
| Financial | Registrado, mas sem consumo e sem scope Guardian confirmado |
| Logistic | Nenhum sincronizador/mapeador atual |
| Purchase | Nenhum sincronizador/mapeador atual |
| Tributary | Nenhum sincronizador/mapeador atual |
| eCommerce | Subdomínio conhecido, mas não sincronizado pelo runner |
| Receber | Existe no mapa interno, mas não foi fornecido entre os dez links |

Esses módulos só serão úteis quando o ZapFlow tiver:
1. endpoint selecionado;
2. contrato dos campos;
3. mapper;
4. tabela de destino;
5. job incremental;
6. monitoramento;
7. testes;
8. interface para apresentar o dado.

### Conclusão de cobertura

- Para o **núcleo da vertical Toulon**: Guardian + Supply + Price + Sales resolvem a fonte dos dados.
- Para **clientes e recompra**: acrescentar CRM com LGPD.
- Para **automatizar RH, compras, logística, fiscal e financeiro diretamente pelo ERP**: os links existem, mas o ZapFlow ainda precisa construir essas integrações.
- Portanto, se a promessa for "todas as funcionalidades do ZapFlow alimentadas automaticamente pela Alterdata", a resposta hoje é **não**.

---

## Separação das responsabilidades

Existem três partes, não apenas duas. Ignorar a responsabilidade da
Toulon faria tarefas importantes ficarem sem dono.

### Responsabilidade do ZapFlow

Nós precisamos entregar:
- aplicação hospedada e estável;
- conector Guardian;
- criptografia de credenciais;
- URLs separadas por ambiente;
- token separado por ambiente;
- cursor separado por ambiente;
- sincronização incremental;
- retry e backoff;
- mapeadores;
- idempotência;
- isolamento entre organizações;
- monitoramento;
- erros visíveis;
- status por módulo;
- gate que impeça produção incompleta;
- ponte da receita do varejo para Financeiro/Diretor IA;
- interface de homologação;
- LGPD no uso dos clientes;
- testes, backup, rollback;
- documentação e treinamento.

Não é responsabilidade da Alterdata corrigir interface, mapeadores ou
falhas de monitoramento do ZapFlow.

### Responsabilidade da Alterdata

Precisamos cobrar:
- confirmação de quais URLs são homologação e produção;
- URLs de produção, se forem diferentes;
- processo para gerar usuário/credencial;
- scopes do Guardian;
- permissão somente leitura;
- confirmação dos módulos licenciados;
- disponibilidade das rotas;
- contrato estável dos payloads;
- exemplos reais anonimizados;
- paginação;
- cursor incremental;
- tratamento de exclusões/cancelamentos;
- limites de requisição;
- whitelist de IP, se houver;
- SLA e canal de suporte;
- aviso prévio de mudanças;
- confirmação do campo real do vendedor;
- explicação do Financial versus Receber;
- scope exato do módulo Financial.

A Alterdata não precisa desenvolver as funcionalidades do ZapFlow;
precisa fornecer acesso confiável e documentado aos dados corretos.

### Responsabilidade da Toulon

A Toulon precisa:
- autorizar formalmente a integração;
- criar ou autorizar o usuário de retaguarda;
- fornecer rede, filiais e tabela de preço;
- informar quais lojas entrarão no piloto;
- manter cadastros do ERP corretos;
- validar os números importados;
- esclarecer vendedor versus caixa compartilhado;
- autorizar o uso de dados pessoais;
- aprovar a política LGPD;
- dar o aceite da homologação.

---

## Solicitação formal à Alterdata

> Validamos os dez contratos OpenAPI da Toulon Grande Rio. Para concluir
> a homologação e preparar a entrada em produção do ZapFlow, precisamos:
>
> 1. Confirmar se os dez subdomínios fornecidos são de homologação ou produção.
> 2. Fornecer os subdomínios de produção, caso sejam diferentes.
> 3. Informar o procedimento para provisionar um usuário dedicado, somente leitura.
> 4. Confirmar os scopes Guardian necessários para Supply, Price, Sales e CRM.
> 5. Informar o scope do módulo Financial.
> 6. Confirmar quais módulos estão licenciados para a Toulon Grande Rio.
> 7. Confirmar rede, filiais e tabela de preço, ou indicar onde a Toulon obtém esses códigos.
> 8. Confirmar o contrato do cursor `/versao/{version}`, incluindo versão inicial, avanço, exclusões e correções retroativas.
> 9. Informar paginação, limite de chamadas, rate limit e eventual whitelist de IP.
> 10. Enviar payloads anonimizados de Referencia, CodigoDeBarras, Saldo, Preco, DataCaixa, VendaMalote, Comissão e ClienteMalote.
> 11. Confirmar qual campo identifica o vendedor real e se `CAI_USUARIO` pode representar login/caixa compartilhado.
> 12. Informar SLA, canal de suporte e política de mudanças das APIs.
> 13. Esclarecer se Financial substitui o módulo Receber ou se existe outro subdomínio.

---

## 1. Problema

O conector atual possui integração funcional com Supply, Price, Sales e
CRM, porém apresenta riscos incompatíveis com produção:

1. O campo `environment` não determina as URLs.
2. Credenciais e token não são separados por ambiente.
3. Cursores não possuem ambiente.
4. Um cursor de homologação pode ser reutilizado em produção.
5. Price, Sales e CRM capturam erros silenciosamente.
6. Uma execução pode ser apresentada como concluída mesmo com módulos quebrados.
7. Não existe status formal por módulo/recurso.
8. O probe valida HTTP, mas não garante contrato e qualidade dos dados.
9. A interface pode ativar sincronização sem gate completo.
10. O readiness global bloqueia praticamente apenas pela OpenAI.
11. Documentos históricos contradizem o código atual.
12. Módulos registrados podem parecer integrados mesmo sem sincronizador.

## 2. Objetivo

Criar um fluxo de integração que:
- separe completamente homologação e produção;
- nunca misture token, credencial ou cursor;
- classifique módulos como obrigatórios, condicionais ou não suportados;
- registre sucesso ou falha de cada recurso;
- impeça "falso sucesso";
- apresente de quem é cada pendência;
- só permita go-live após critérios técnicos e operacionais;
- mantenha compatibilidade com o conector atual;
- possibilite rollback sem perda de dados.

## 3. Não objetivos desta fase

Não implementar sincronização completa de:
- Human Resources;
- Financial;
- Logistic;
- Purchase;
- Tributary;
- eCommerce;
- Receber.

Esses módulos deverão aparecer como **"API disponível — integração
ZapFlow ainda não implementada"**, nunca como prontos.

## 4. Matriz de módulos da Toulon

| Módulo | Política padrão | Condição |
|---|---|---|
| Guardian | Obrigatório | Sempre |
| Supply | Obrigatório | Sempre |
| Price | Obrigatório | Vertical varejo com catálogo/preço |
| Sales | Obrigatório | Toulon utiliza fechamento, comissão, ranking e Diretor IA |
| CRM | Condicional | Obrigatório somente com `pdvCustomerImport=true` |
| Outros | Não suportados | Não entram no gate do go-live atual |

## 5. Requisitos funcionais

### RF-01 — Perfis separados por ambiente

Criar perfis independentes:
- `homolog`;
- `prod`.

Cada perfil deve possuir:
- `base_pattern`;
- URLs específicas por módulo;
- credencial cifrada;
- token cifrado;
- validade do token;
- scopes;
- rede;
- filiais;
- tabela de preço;
- status de validação;
- data da última validação;
- responsável pela aprovação.

O seletor de ambiente não pode ser meramente visual.

### RF-02 — Isolamento de token

O token deve pertencer a:
```text
organization_id + environment + credential_profile
```

Proibições:
- token de homologação em produção;
- token compartilhado entre organizações;
- token retornado pela API;
- token em logs;
- reutilização após mudança de credencial.

Ao trocar credenciais:
- invalidar o token anterior;
- exigir novo teste Guardian;
- auditar a alteração.

### RF-03 — Isolamento dos cursores

Alterar a chave dos cursores para:
```text
organization_id + environment + module + resource + filial
```

Cenário obrigatório de teste:
1. Homologação avança Referencia para versão 9.000.
2. Produção inicia.
3. Produção obrigatoriamente começa no cursor definido para produção, nunca em 9.000.

### RF-04 — Promoção controlada

Criar operação explícita:
```text
Promover perfil para produção
```

Antes da promoção:
- perfil de produção configurado;
- credencial de produção testada;
- módulos obrigatórios verdes;
- URLs confirmadas como produção;
- backup concluído;
- cursores de produção vazios ou aprovados;
- nenhuma sincronização em andamento;
- aceite registrado.

Não fazer promoção automática ao trocar um select.

### RF-05 — Política por módulo

Criar configuração:
```text
required | conditional | optional | unsupported | disabled
```

Para Toulon:
- Supply: `required`;
- Price: `required`;
- Sales: `required`;
- CRM: `conditional`;
- demais: `unsupported`.

Módulo `unsupported` não pode receber selo verde.

### RF-06 — Ledger das execuções

Criar tabelas aditivas:

#### `alterdata_sync_runs`
- `id`;
- `organization_id`;
- `environment`;
- `trigger`: manual, scheduler, resync;
- `status`;
- `started_at`;
- `finished_at`;
- `required_failures`;
- `optional_failures`;
- `correlation_id`;
- `initiated_by`.

#### `alterdata_sync_run_resources`
- `run_id`;
- `module`;
- `resource`;
- `filial`;
- `required`;
- `status`;
- `http_status`;
- `cursor_before`;
- `cursor_after`;
- `pages`;
- `received`;
- `imported`;
- `skipped`;
- `mapping_errors`;
- `error_code`;
- `error_message_sanitized`;
- `started_at`;
- `finished_at`.

### RF-07 — Estados da sincronização

Estados da execução:
```text
queued
running
success
partial_failure
failed
cancelled
```

Regras:
- `success`: todos os recursos obrigatórios concluídos.
- `partial_failure`: obrigatórios concluíram, mas algum opcional falhou.
- `failed`: ao menos um obrigatório falhou.
- `cancelled`: cancelamento controlado.
- Zero registros com HTTP 200 não é falha técnica, mas deve ser analisado pelo gate de suficiência dos dados.

### RF-08 — Remover erros silenciosos

Todos os atuais `catch {}` relacionados à Alterdata devem:
- preservar a tolerância quando o módulo for opcional;
- registrar a falha no ledger;
- anexar `correlation_id`;
- atualizar o resumo;
- mostrar a falha na interface;
- emitir sinal operacional.

Nunca transformar exceção em `{ imported: 0 }` sem indicar erro.

### RF-09 — Probe contratual

"Testar módulos" deve validar:
1. emissão do token;
2. autorização;
3. DNS/TLS;
4. HTTP;
5. rota correta;
6. formato do payload;
7. campos mínimos;
8. paginação;
9. cursor;
10. rede;
11. filial;
12. tabela de preço;
13. capacidade do mapper;
14. dados pessoais quando CRM estiver habilitado.

Resultados possíveis:
```text
ready
empty_but_valid
auth_failed
forbidden
not_found
server_error
contract_mismatch
mapping_failed
store_not_mapped
product_not_mapped
rate_limited
unreachable
```

O probe não deve persistir dados de negócio.

### RF-10 — Gate de go-live Alterdata

Criar:
```text
GET /api/integrations/alterdata/readiness
```

Resposta:
- status geral;
- ambiente;
- módulos obrigatórios;
- recursos;
- pendência;
- responsável: ZapFlow, Alterdata ou Toulon;
- ação recomendada;
- evidência;
- última validação.

Bloqueadores:
- credencial ausente;
- token inválido;
- ambiente não confirmado;
- Supply falhando;
- Price falhando;
- Sales falhando;
- rede/filial/tabela ausentes;
- cursor misturado;
- loja sem mapeamento;
- backup ausente antes da primeira produção;
- CRM ligado sem autorização LGPD.

### RF-11 — Interface de Integrações

A tela deve apresentar:
- perfil Homologação;
- perfil Produção;
- status Guardian;
- status por módulo;
- status por recurso;
- última execução;
- último sucesso;
- última falha;
- cursor;
- registros recebidos/importados;
- pendências atribuídas;
- botão "Validar homologação";
- botão "Preparar produção";
- botão "Promover para produção";
- botão "Sincronizar agora".

A ativação automática deve permanecer bloqueada enquanto o readiness
não estiver verde.

### RF-12 — Mensagens honestas

Não mostrar:
```text
Sincronização concluída
```
quando houver falha parcial.

Mostrar:
```text
Sincronização parcial: catálogo e estoque atualizados; vendas falharam com HTTP 500.
Responsável provável: Alterdata.
Correlation ID: ...
```

### RF-13 — Suficiência e qualidade dos dados

Gates mínimos do piloto:
- filiais reconhecidas: 100%;
- vendas associadas à filial: 100%;
- estoque associado ao produto: ≥99,5%;
- preços associados ao produto/variante: ≥99,5%;
- produtos ativos sem preço válido: dentro do limite aprovado;
- diferença de faturamento ZapFlow versus ERP: ≤ tolerância aprovada;
- código de vendedor único por loja com volume elevado: gerar risco;
- cancelamentos e devoluções validados;
- cursor avança sem duplicação;
- reexecução idempotente.

### RF-14 — Price path

O contrato validado usa:
```text
/api/v1/Preco/versao/{rede}/{table}/{version}
```

Não realizar repetidamente chamadas a formatos inválidos.
Implementar detecção contratual uma vez e armazenar o formato validado
no perfil.

### RF-15 — Financeiro e Diretor IA

Para Toulon:
- exigir decisão explícita sobre `retail_revenue_bridge`;
- quando ativado, validar fechamento → `cash_events`;
- provar idempotência;
- provar que Diretor IA, DRE e snapshot exibem receita;
- apresentar origem do dado: Alterdata Sales → fechamento → ledger.

### RF-16 — CRM e LGPD

Antes de `pdvCustomerImport=true`:
- registrar autorização;
- finalidade;
- base legal;
- data;
- responsável;
- retenção;
- perfil de acesso.

Não copiar automaticamente clientes para campanhas ou Inbox.

### RF-17 — Responsabilidade visível

Cada erro deve receber uma classificação:
- `ZAPFLOW_CODE`;
- `ZAPFLOW_INFRA`;
- `ALTERDATA_AUTH`;
- `ALTERDATA_API`;
- `ALTERDATA_DATA_CONTRACT`;
- `TOULON_CONFIGURATION`;
- `TOULON_MASTER_DATA`;
- `LGPD_APPROVAL`.

## 6. APIs internas propostas

```text
GET  /api/integrations/alterdata/profiles
PUT  /api/integrations/alterdata/profiles/:environment
POST /api/integrations/alterdata/profiles/:environment/test-token
POST /api/integrations/alterdata/profiles/:environment/probe
GET  /api/integrations/alterdata/readiness
POST /api/integrations/alterdata/promote
POST /api/integrations/alterdata/sync
GET  /api/integrations/alterdata/runs
GET  /api/integrations/alterdata/runs/:runId
```

Manter as rotas antigas como fachada compatível durante a migração.

## 7. Readiness global do ZapFlow

Não incluir disponibilidade da Alterdata no `/api/health/live`, porque
uma queda da Alterdata não deve derrubar o ZapFlow.

Separar:
- `/api/health/live`: processo vivo;
- `/api/health/ready`: aplicação central pronta;
- `/api/admin/production-readiness`: infraestrutura completa;
- `/api/integrations/alterdata/readiness`: prontidão da integração por organização.

Transformar em bloqueadores reais de produção:
- `ENCRYPTION_KEY` forte e estável;
- `JWT_SECRET` forte;
- banco e volume graváveis;
- migrações concluídas;
- `APP_URL` HTTPS;
- CORS restrito;
- OpenAI;
- backup recente;
- backup externo;
- Evolution, quando WhatsApp fizer parte do plano;
- Asaas, quando houver cobrança;
- integração obrigatória da vertical.

Referência da fragilidade atual: [`ProductionReadinessService`](https://github.com/Eldastito/exaforgeStudio/blob/main/src/server/ProductionReadinessService.ts).

## 8. Segurança

- Nenhum segredo em resposta, log ou erro.
- Criptografia por `ENCRYPTION_KEY`.
- Rotação de credenciais.
- Auditoria de leitura e alteração.
- RBAC owner/admin.
- Escopo mínimo do Guardian.
- Proteção contra SSRF nas URLs configuráveis.
- Permitir somente HTTPS e hosts aprovados.
- Rate limiting das rotas de teste/sync.
- Isolamento por `organization_id`.
- Sanitização dos snippets retornados pela Alterdata.
- Não registrar PII em mensagens de erro.

## 9. Testes obrigatórios

### Unitários
- resolução de URL por ambiente;
- token por ambiente;
- cursor por ambiente;
- classificação de erros;
- cálculo do status geral;
- política required/optional;
- sanitização.

### Integração
- Guardian 200/401/403;
- Supply 200/404/500;
- Price com rota oficial;
- Sales parcial;
- CRM desligado/ligado;
- retry 429 e 5xx;
- expiração do token;
- paginação;
- avanço do cursor;
- payload incompatível.

### Cenários críticos
1. Homologação com cursor alto → produção começa separada.
2. Supply falha → run `failed`.
3. Sales falha → Toulon não recebe status verde.
4. CRM falha desligado → não bloqueia.
5. CRM ligado sem LGPD → bloqueia.
6. Preço retorna 200 sem produto → contract/data warning.
7. Filial inexistente → responsabilidade Toulon.
8. Endpoint 500 → responsabilidade Alterdata.
9. Mapper lança exceção → responsabilidade ZapFlow.
10. Dois tenants nunca compartilham credencial, token, cursor ou dados.
11. Segredos nunca aparecem na UI.
12. Receita chega ao Diretor IA sem duplicação.

### E2E
- salvar homologação;
- testar conexão;
- testar módulos;
- sincronizar uma loja;
- validar números;
- configurar produção;
- promover;
- ativar scheduler;
- simular falha parcial;
- executar rollback.

## 10. Plano de implementação por PR

### PR 1 — ADR e esquema aditivo
- ADR de ambientes;
- tabelas de perfil;
- ledger de execuções;
- política de módulos;
- migração compatível.

### PR 2 — Token e cursor por ambiente
- resolver de URLs;
- credenciais;
- tokens;
- cursores;
- testes de isolamento.

### PR 3 — Resultado por recurso
- retirar falhas silenciosas;
- status por recurso;
- correlation ID;
- summary V2.

### PR 4 — Probe contratual e readiness
- validação de campos;
- classificação de responsabilidades;
- gate da Toulon.

### PR 5 — Interface
- perfis;
- status;
- erros;
- promoção;
- bloqueio de ativação.

### PR 6 — Production Readiness global
- separar liveness/readiness;
- ampliar bloqueadores;
- não acoplar disponibilidade da Alterdata ao processo global.

### PR 7 — Financeiro, Diretor IA e LGPD
- validar revenue bridge;
- autorização CRM;
- evidência de origem.

### PR 8 — Testes, documentação e runbook
- testes completos;
- atualizar documentos contraditórios;
- roteiro de homologação;
- rollback;
- checklist Alterdata/Toulon.

## 11. Estratégia de rollout

1. Implementar atrás de `alterdata_readiness_v2`.
2. Migrar configuração existente para perfil `homolog`.
3. Não ativar produção automaticamente.
4. Rodar CI.
5. Subir em staging.
6. Validar uma filial.
7. Validar segunda loja.
8. Observar durante sete dias.
9. Criar perfil de produção.
10. Fazer backup.
11. Promover.
12. Ativar scheduler.
13. Expandir gradualmente.

## 12. Rollback

- desligar `alterdata_readiness_v2`;
- manter tabelas novas inertes;
- preservar perfis e ledger;
- manter rotas antigas;
- parar scheduler;
- não apagar cursores automaticamente;
- restaurar backup se dados de homologação contaminarem produção;
- revogar credencial de produção se necessário.

## 13. Definition of Done

O trabalho só estará concluído quando:
- homologação e produção forem isoladas;
- tokens forem isolados;
- cursores forem isolados;
- nenhum erro de módulo for silencioso;
- Supply, Price e Sales estiverem verdes;
- CRM estiver condicionado à LGPD;
- a UI impedir ativação prematura;
- o readiness indicar o responsável por cada pendência;
- dados de duas lojas forem validados;
- reconciliação financeira estiver comprovada;
- Diretor IA receber receita real;
- backup e rollback forem testados;
- CI estiver verde;
- nenhuma vulnerabilidade P0/P1 estiver aberta;
- Toulon fornecer aceite formal;
- Alterdata confirmar produção, scopes e suporte.

## Prioridades imediatas

1. Corrigir cursor, token e URL por ambiente.
2. Remover falso sucesso das sincronizações.
3. Criar status por módulo e gate da Toulon.
4. Solicitar formalmente as informações à Alterdata.
5. Homologar uma filial.
6. Só depois preparar produção.
