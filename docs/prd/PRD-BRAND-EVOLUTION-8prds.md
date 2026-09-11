**Resumo:** sim — separar é a decisão correta; eu dividiria em **8 PRDs sequenciais**, porque misturar posicionamento, comunicação, métricas, UX e inteligência de marca em um único PRD aumentaria muito o risco de retrabalho, duplicação e implementação errada.

O próprio documento reforça que existe uma sequência lógica: **Essência → Posicionamento → Identidade → Comunicação** e que comunicação eficiente depende do alinhamento das etapas anteriores.  Portanto, implementar tudo junto seria contradizer justamente o princípio que estamos tentando aplicar ao ZapFlow.

# Plano mestre — Evolução de Marca e Comunicação do ZapFlow

A sequência que recomendo é:

| Ordem | PRD                                    | Objetivo principal                                  | Dependência      |
| ----- | -------------------------------------- | --------------------------------------------------- | ---------------- |
| 01    | Brand Core ZapFlow                     | Definir quem o ZapFlow é                            | Nenhuma          |
| 02    | Arquitetura Verbal                     | Definir como o ZapFlow fala                         | PRD 01           |
| 03    | Arquitetura de Comunicação Comercial   | Reorganizar site, apresentações e vendas            | PRD 01–02        |
| 04    | Diagnóstico de Dependência Operacional | Transformar a dor central em ferramenta             | PRD 01           |
| 05    | Motor de Demonstração de Valor         | Provar economicamente o valor gerado                | PRD 04           |
| 06    | Comunicação dentro do Produto          | Fazer o próprio ZapFlow comunicar a promessa        | PRD 01–05        |
| 07    | Framework de Comunicação por Vertical  | Adaptar a promessa sem fragmentar a marca           | PRD 01–06        |
| 08    | Brand Intelligence                     | Levar essa inteligência para os clientes do ZapFlow | Todos anteriores |

**Não recomendo executar fora dessa ordem.**

---

# PRD 01 — BRAND CORE ZAPFLOW

## Objetivo

Criar a fonte oficial de verdade sobre a marca ZapFlow.

Este PRD responde:

> **Quem somos, qual problema combatemos, para quem existimos e qual transformação prometemos?**

A essência deve permanecer válida mesmo que produtos, integrações, modelos de IA ou funcionalidades sejam alterados. O documento define justamente a essência como a parte intocável da marca durante transformações e expansão. 

## Hipótese estratégica inicial

**Essência**

> Fazer empresas funcionarem melhor e dependerem menos do empresário para tudo.

**Problema central**

> Dependência operacional.

Dependência:

* do proprietário;
* de funcionários-chave;
* da memória;
* de WhatsApp;
* de planilhas;
* de processos informais;
* de acompanhamento manual.

**Categoria candidata**

> Sistema Operacional Inteligente para Empresas.

**Promessa candidata**

> Sua empresa funcionando, mesmo quando você não está olhando.

Essas definições devem ser tratadas inicialmente como **propostas estratégicas versionadas**, não como strings espalhadas pelo código.

## Implementação

Criar estrutura central:

```text
BrandCore
 ├── essence
 ├── purpose
 ├── positioning
 ├── category
 ├── promise
 ├── enemy
 ├── transformation
 ├── targetAudience
 ├── brandAttributes
 ├── differentiators
 ├── functionalBenefits
 ├── emotionalBenefits
 ├── proofPoints
 ├── approvedClaims
 └── version
```

Deve existir apenas **uma fonte oficial de Brand Core**.

Nenhum módulo deve criar outra implementação paralela.

## Administração

Admin Master deve poder:

* visualizar;
* editar;
* versionar;
* publicar;
* restaurar versão anterior.

Alteração nunca deve sobrescrever silenciosamente a versão publicada.

## Critérios de aceite

O sistema deve conseguir responder de forma consistente:

> O que é o ZapFlow?

> Para quem existe?

> Qual problema resolve?

> Qual transformação entrega?

> Qual seu principal diferencial?

E essas respostas devem vir da mesma fonte.

### Checklist obrigatório — entrega PRD 01

* [ ] Brand Core central criado
* [ ] Essência cadastrada
* [ ] Posicionamento cadastrado
* [ ] Categoria cadastrada
* [ ] Promessa cadastrada
* [ ] Problema/inimigo definido
* [ ] Benefícios funcionais cadastrados
* [ ] Benefícios emocionais cadastrados
* [ ] Diferenciais cadastrados
* [ ] Versionamento funcionando
* [ ] Rollback disponível
* [ ] Nenhuma estrutura duplicada criada
* [ ] Testes existentes continuam passando
* [ ] IA Dev registrou arquivos modificados
* [ ] IA Dev registrou migrations realizadas
* [ ] IA Dev registrou pendências encontradas

---

# PRD 02 — IDENTIDADE VERBAL E ARQUITETURA DE MENSAGENS

Somente iniciar após o PRD 01.

## Objetivo

Fazer todos os pontos de comunicação descreverem o ZapFlow da mesma maneira.

Hoje uma das maiores ameaças é o mesmo produto aparecer como:

* CRM;
* automação;
* IA;
* chatbot;
* sistema de gestão;
* Diretor IA;
* plataforma operacional.

Tudo pode ser tecnicamente verdade.

Mas não pode haver várias identidades disputando a posição principal.

## Arquitetura

Criar:

```text
BrandMessaging
 ├── masterMessage
 ├── elevatorPitch
 ├── tagline
 ├── shortDescription
 ├── mediumDescription
 ├── longDescription
 ├── functionalMessages
 ├── emotionalMessages
 ├── objectionResponses
 ├── vocabulary
 ├── discouragedTerms
 ├── prohibitedClaims
 └── toneOfVoice
```

## Hierarquia obrigatória

### Nível 1 — transformação

> Empresa menos dependente e mais inteligente.

### Nível 2 — mecanismo

> Observa → Entende → Organiza → Age → Acompanha → Aprende.

### Nível 3 — benefícios

Controle, previsibilidade, execução, produtividade, receita e tempo.

### Nível 4 — funcionalidades

CRM, agenda, WhatsApp, financeiro, Estúdio, IA etc.

**Nunca inverter automaticamente essa hierarquia.**

## Regra fundamental

Funcionalidade não deve virar proposta central de valor.

Por exemplo:

❌ “CRM com inteligência artificial.”

✅ “O ZapFlow identifica oportunidades que pararam e ajuda sua equipe a agir.”

## Critérios de aceite

Qualquer módulo gerador de conteúdo deve conseguir requisitar:

```text
getBrandMessaging(context)
```

em vez de hardcodar posicionamento.

### Checklist PRD 02

* [ ] Message House implementada
* [ ] Tom de voz registrado
* [ ] Vocabulário recomendado criado
* [ ] Expressões desaconselhadas criadas
* [ ] Claims proibidos implementados
* [ ] Pitch curto implementado
* [ ] Pitch médio implementado
* [ ] Pitch completo implementado
* [ ] Hierarquia transformação→função preservada
* [ ] Integração com Brand Core concluída
* [ ] Zero duplicação
* [ ] Testes de regressão executados
* [ ] Arquivos alterados documentados
* [ ] Pendências documentadas

---

# PRD 03 — NOVA ARQUITETURA DE COMUNICAÇÃO COMERCIAL

Somente depois de PRD 01 e 02.

## Objetivo

Parar de vender o ZapFlow começando por funcionalidades.

A comunicação passará a seguir:

**Dor → consequência → transformação → mecanismo → evidência → produto.**

## Home sugerida

### Hero

> **Quanto da sua empresa ainda depende de você?**

Subheadline:

> O ZapFlow ajuda sua empresa a observar, organizar e executar o que hoje depende do dono, da memória e de processos manuais.

CTA:

> Descubra sua dependência operacional

## Bloco seguinte

Perguntas:

> Quem percebe que uma venda parou?

> Quem lembra que um cliente precisa receber retorno?

> Quem identifica uma cobrança vencida?

> Quem percebe que um processo não aconteceu?

> Quem sabe o que está preso na cabeça de um funcionário-chave?

Conclusão:

> Se a resposta geralmente é “eu”, sua operação ainda depende demais de você.

## Estrutura

```text
Problema
↓
Impacto
↓
Diagnóstico
↓
Transformação
↓
Como o ZapFlow trabalha
↓
Casos
↓
Valor gerado
↓
Funcionalidades
↓
Verticais
↓
CTA
```

## Escopo

Atualizar progressivamente:

* landing page;
* apresentação comercial;
* apresentação institucional;
* propostas;
* materiais de onboarding;
* textos comerciais.

Não alterar tudo em uma única implantação.

Usar feature flags quando aplicável.

## Critérios

Nenhuma página principal deve começar listando módulos.

O documento sustenta que percepção de valor depende da coerência entre essência, posicionamento, identidade e comunicação. 

### Checklist PRD 03

* [ ] Jornada comercial reorganizada
* [ ] Hero atualizado
* [ ] CTA de diagnóstico criado
* [ ] Bloco problema implementado
* [ ] Transformação apresentada antes das funcionalidades
* [ ] Provas incluídas
* [ ] Responsividade validada
* [ ] Android validado
* [ ] iPhone/iOS validado
* [ ] Desktop validado
* [ ] SEO preservado
* [ ] Analytics preservado
* [ ] Funções existentes preservadas
* [ ] Testes concluídos

---

# PRD 04 — ÍNDICE DE DEPENDÊNCIA OPERACIONAL — IDO

Este é potencialmente um grande diferencial comercial.

## Objetivo

Transformar a dor central da marca em um diagnóstico mensurável.

### IDO

**Índice de Dependência Operacional**

Medirá aproximadamente:

```text
Dependência do proprietário
Dependência de funcionário-chave
Dependência de conhecimento informal
Dependência de intervenção humana
Dependência de memória
Maturidade de processos
Automação
Visibilidade operacional
Continuidade
```

## Perguntas

Exemplo:

> Se você se afastasse da empresa durante 15 dias, quais operações teriam dificuldade para continuar normalmente?

> Existe algum funcionário cuja ausência poderia comprometer significativamente a operação?

> Quais informações importantes existem apenas na cabeça das pessoas?

> Quantas tarefas precisam ser lembradas manualmente?

> Quantos processos dependem de WhatsApp ou comunicação informal?

## Resultado

Exemplo:

```text
IDO Geral: 78/100

Dependência do dono: 86%
Dependência de pessoas-chave: 73%
Processos formalizados: 31%
Automação: 24%
Visibilidade: 42%
```

## Importante

Não apresentar números arbitrários como ciência.

A metodologia precisa possuir:

* fórmula documentada;
* pesos;
* versão;
* justificativa;
* intervalo;
* histórico.

## Evolução

Mostrar:

```text
ANTES DO ZAPFLOW       78
HOJE                   59
META                    35
```

### Checklist PRD 04

* [ ] Questionário implementado
* [ ] Fórmula documentada
* [ ] Pesos configuráveis
* [ ] IDO geral calculado
* [ ] Subíndices calculados
* [ ] Histórico implementado
* [ ] Comparação temporal implementada
* [ ] Recomendações geradas
* [ ] Não apresenta precisão falsa
* [ ] LGPD considerada
* [ ] Multiempresa respeitado
* [ ] RLS validado
* [ ] Testes concluídos

---

# PRD 05 — MOTOR DE DEMONSTRAÇÃO DE VALOR

Aqui conectamos comunicação à realidade.

O documento usa casos e resultados para sustentar sua promessa, em vez de permanecer apenas no discurso. 

## Objetivo

Mostrar continuamente:

> **O que o ZapFlow fez pela empresa?**

Não apenas:

> O que o ZapFlow consegue fazer?

## Value Ledger

Criar um ledger central de eventos de valor:

```text
ValueEvent
 ├── tenantId
 ├── category
 ├── source
 ├── description
 ├── monetaryValue
 ├── timeSaved
 ├── confidence
 ├── evidence
 ├── timestamp
 └── metadata
```

Categorias:

* receita recuperada;
* venda gerada;
* cobrança recuperada;
* cliente recuperado;
* tarefa automatizada;
* tempo economizado;
* falha evitada;
* oportunidade recuperada;
* desperdício reduzido.

## Dashboard

Exemplo:

> **ZapFlow gerou R$ 18.430 em valor este mês**

Abaixo:

R$ 7.200 recuperados em cobranças.

R$ 6.500 em oportunidades comerciais.

31 horas economizadas.

19 clientes recuperados.

8 falhas detectadas.

## Regra crítica

**Nunca inventar valor financeiro.**

Toda informação precisa indicar sua natureza:

* medido;
* calculado;
* estimado;
* atribuído;
* não mensurável.

### Checklist PRD 05

* [ ] Value Ledger implementado
* [ ] Fontes de evidência registradas
* [ ] Classificação medido/estimado funcionando
* [ ] RIC integrado, se já existente
* [ ] Sem duplicação de métricas existentes
* [ ] Dashboard entregue
* [ ] Histórico entregue
* [ ] Filtros funcionando
* [ ] Multiempresa validado
* [ ] Auditoria validada
* [ ] Não há claims financeiros sem evidência
* [ ] Testes concluídos

---

# PRD 06 — BRAND EXPERIENCE DENTRO DO PRODUTO

O documento destaca que cada ponto de contato é uma oportunidade de fortalecer a marca. 

## Objetivo

Fazer o próprio ZapFlow demonstrar sua proposta.

Não adianta publicidade inteligente e produto burocrático.

## Pontos analisados

* login;
* onboarding;
* dashboard;
* Fala Tu;
* notificações;
* relatórios;
* cobranças;
* alertas;
* e-mails;
* WhatsApp;
* Empty States;
* mensagens de erro;
* conclusões de tarefas.

## Exemplo

Em vez de:

> “Nenhum registro encontrado.”

Usar contexto quando apropriado:

> “Ainda não encontrei oportunidades paradas aqui.”

E, se puder agir:

> “Posso procurar oportunidades sem movimentação nos últimos 7 dias.”

O produto demonstra iniciativa.

## Regra crítica

Não transformar tudo em texto “fofo”.

Clareza operacional vem antes de personalidade.

### Checklist PRD 06

* [ ] Principais pontos de contato auditados
* [ ] Microcopy revisada
* [ ] Brand Core integrado
* [ ] Fala Tu integrado
* [ ] Notificações integradas
* [ ] Relatórios integrados
* [ ] Mensagens de erro preservam clareza
* [ ] Acessibilidade preservada
* [ ] UX não degradada
* [ ] Nenhuma automação existente quebrada
* [ ] Testes concluídos

---

# PRD 07 — ARQUITETURA DE COMUNICAÇÃO POR VERTICAL

## Objetivo

Permitir que cada vertical fale a língua do cliente sem criar vários ZapFlows diferentes.

## Estrutura

A essência permanece.

O problema assume diferentes manifestações.

### Moda

> Menos dependência do dono para entender o que está acontecendo nas lojas.

### Pet Shop

> Sua operação acompanhada mesmo quando você está cuidando de outras prioridades.

### Clínicas

> Menos administração manual. Mais atenção ao paciente.

### Advocacia

> Informações, clientes e atividades importantes sem depender apenas da memória da equipe.

## Modelo

```text
VerticalBrandProfile
 ├── vertical
 ├── pains
 ├── desiredOutcomes
 ├── terminology
 ├── commonObjections
 ├── relevantCapabilities
 ├── proofPoints
 └── messagingExamples
```

## Regra

Uma vertical **não pode redefinir a essência da marca**.

Pode adaptar:

* dor;
* exemplo;
* benefício;
* linguagem;
* feature prioritária.

### Checklist PRD 07

* [ ] Modelo de vertical criado
* [ ] Moda configurada
* [ ] Pet configurado
* [ ] Clínicas configuradas
* [ ] Advocacia configurada
* [ ] Herança do Brand Core implementada
* [ ] Não existem identidades conflitantes
* [ ] Componentes reutilizados
* [ ] Conteúdo testado
* [ ] Testes concluídos

---

# PRD 08 — BRAND INTELLIGENCE PARA CLIENTES

Este seria o último porque depende dos aprendizados anteriores.

E pode se tornar um produto muito relevante.

## Objetivo

Permitir que o ZapFlow não apenas tenha uma marca coerente, mas **ajude seus clientes a manterem suas próprias marcas coerentes**.

## Nova camada

### Brand Intelligence Engine

Cada empresa poderia cadastrar:

* essência;
* propósito;
* posicionamento;
* público;
* ICP;
* diferenciais;
* proposta de valor;
* personalidade;
* tom;
* vocabulário;
* identidade;
* produtos;
* benefícios;
* concorrentes;
* exemplos aprovados.

O documento recomenda justamente analisar elementos como segmentação, régua de produtos, diferenciais, proposta de valor, cliente ideal, ocasião de consumo, atributos, benefícios e concorrência. 

## Aplicação

Esse contexto alimentaria:

* Estúdio;
* geração de imagens;
* geração de vídeos;
* redes sociais;
* campanhas;
* Fala Tu;
* Atendente IA;
* propostas;
* e-mail marketing;
* WhatsApp;
* landing pages.

## Brand Guardian

Antes de publicar:

```text
Prompt
↓
Conteúdo gerado
↓
Brand Guardian
↓
Verificação de coerência
↓
Risco
↓
Aprovação/correção
```

Avaliar:

* tom;
* promessa;
* público;
* vocabulário;
* identidade;
* posicionamento;
* claims;
* diferenças em relação à concorrência.

### Exemplo

Usuário pede:

> “Faça uma propaganda dizendo que somos os mais baratos do mercado.”

Mas a marca cadastrada possui posicionamento premium.

O Brand Guardian alerta:

> “Esta mensagem entra em conflito com o posicionamento premium cadastrado.”

Não necessariamente bloqueia.

**Explica e oferece alternativa.**

## Evitar duplicação

Antes de implementar, IA Dev deverá localizar funcionalidades existentes relacionadas a:

* Brand Kit;
* RAG;
* Estúdio;
* geração de conteúdo;
* system prompts;
* tenant context;
* conhecimento da empresa;
* Guardian;
* templates;
* Style Guides.

A implementação deverá **estender** esses recursos.

Nunca criar um segundo RAG ou segundo motor de contexto de marca.

### Checklist PRD 08

* [ ] Brand Intelligence criado
* [ ] Integração ao conhecimento existente
* [ ] Brand Guardian implementado
* [ ] Estúdio integrado
* [ ] Conteúdo integrado
* [ ] Social integrado
* [ ] Atendente integrado
* [ ] Fala Tu integrado
* [ ] Conflitos de marca detectados
* [ ] Alternativas sugeridas
* [ ] Sem criação de RAG duplicado
* [ ] Multiempresa isolado
* [ ] Permissões implementadas
* [ ] Auditoria implementada
* [ ] Custos de IA monitorados
* [ ] Testes concluídos

---

# Regra obrigatória para os 8 PRDs

Eu acrescentaria no cabeçalho de **todos eles** a seguinte instrução permanente para a IA Dev:

> **Antes de implementar qualquer funcionalidade descrita neste PRD, analise o código atual e identifique funcionalidades, componentes, serviços, tabelas, APIs, agentes, prompts e fluxos que já resolvam total ou parcialmente a necessidade. Não crie implementação paralela quando for possível reutilizar, estender, refatorar ou otimizar o que já existe. Preserve retrocompatibilidade, regras de negócio, RLS, RBAC, multi-tenant, auditoria e integrações existentes. Toda alteração estrutural deve possuir estratégia de migração e rollback. Nenhuma funcionalidade atualmente funcionando poderá ser removida ou alterada silenciosamente.**

E uma segunda regra:

> **Ao final de cada PRD, a IA Dev deverá atualizar o checklist do próprio PRD com ✅ concluído, ⚠️ parcial, ❌ não realizado ou 🚫 bloqueado, anexando evidência técnica para cada item relevante.**

## A ordem que eu executaria

**01 Brand Core → 02 Linguagem → 03 Comunicação → 04 IDO → 05 Valor → 06 Experiência no produto → 07 Verticais → 08 Brand Intelligence.**

Há uma razão importante para colocar **Brand Intelligence somente no final**: se ensinarmos o ZapFlow a administrar a marca dos clientes antes de sabermos administrar perfeitamente a própria marca, estaremos automatizando um método ainda não validado.

E eu adicionaria um **Gate de aprovação entre cada PRD**: a IA Dev termina o PRD, entrega checklist + evidências + impacto + pendências; somente depois parte para o próximo. Assim você consegue interromper, corrigir ou redirecionar o projeto sem descobrir oito PRDs depois que uma premissa estava errada.


**Resumo:** sim — abaixo está o **PRD 01 completo e executável**, já estruturado para você copiar e entregar à IA Dev começar a analisar o codebase, codificar e atualizar o ZapFlow sem antecipar os próximos PRDs.

# PRD 01 — BRAND CORE ZAPFLOW

**Especificação Técnica Executável para IA Dev**

**Versão:** 1.0
**Prioridade:** P0 — Fundação
**Ordem no roadmap:** 01 de 08
**Dependências anteriores:** nenhuma
**Bloqueia:** PRD 02 a PRD 08
**Status:** pronto para discovery técnico + implementação
**Produto:** ZapFlow
**Repositório:** `Eldastito/exaforgeStudio`

---

# 1. INSTRUÇÃO EXECUTIVA OBRIGATÓRIA PARA A IA DEV

Antes de escrever qualquer código deste PRD:

> **Analise o codebase atual do ZapFlow e identifique tudo que já exista e resolva total ou parcialmente as necessidades descritas neste documento. É proibido criar uma implementação paralela quando for possível reutilizar, estender, refatorar ou otimizar estruturas existentes.**

A análise inicial deverá procurar especialmente:

* configurações da empresa/plataforma;
* tenant settings;
* company profiles;
* Brand Kit;
* Style Guide;
* configurações do Estúdio;
* base de conhecimento;
* RAG;
* system prompts;
* context builders;
* agentes IA;
* Admin Master;
* configurações globais;
* RBAC;
* RLS;
* audit log;
* feature flags;
* versionamento de configurações;
* Supabase/functions, se aplicável;
* serviços compartilhados;
* hooks;
* APIs;
* schemas e migrations relacionadas.

### Regra absoluta

Não criar:

* segundo Brand Kit;
* segunda estrutura de conhecimento;
* segundo sistema de configuração;
* segundo sistema de auditoria;
* segundo RAG;
* segundo mecanismo de versionamento;
* segundo perfil de empresa;

se houver estrutura adequada que possa ser ampliada.

---

# 2. PROBLEMA QUE ESTE PRD RESOLVE

O ZapFlow possui uma grande quantidade de funcionalidades e diferentes formas possíveis de descrevê-las.

Hoje o produto pode ser entendido como:

* CRM;
* automação;
* plataforma de IA;
* sistema de gestão;
* central operacional;
* chatbot;
* copiloto;
* Diretor IA;
* sistema omnichannel;
* sistema para verticais;
* entre outras definições.

Todas podem conter parte da verdade.

O problema é que **não existe ainda uma fonte estrutural única e versionada dizendo quem o ZapFlow é, para quem existe, qual problema central combate e qual transformação promete**.

Isso cria risco de inconsistência em:

* site;
* apresentações;
* agentes;
* Estúdio;
* conteúdo;
* propostas;
* campanhas;
* verticais;
* onboarding;
* Fala Tu;
* Atendente IA;
* Diretor IA.

O documento *Miopia de Marca* estabelece que essência, posicionamento e identidade precisam estar claros antes da comunicação consistente. 

Também define essência como aquilo que deve permanecer intocável durante transformações e expansão. 

Este PRD cria essa fundação.

---

# 3. OBJETIVO

Criar no ZapFlow uma **Fonte Única de Verdade da Marca ZapFlow**, chamada neste PRD de:

# Brand Core

O Brand Core deverá armazenar, versionar e disponibilizar o posicionamento estratégico oficial da própria plataforma.

Ele será a fundação para os PRDs seguintes.

### Este PRD NÃO deverá ainda:

alterar automaticamente site, campanhas, agentes ou textos existentes.

Primeiro criaremos a fundação.

Depois os consumidores serão migrados progressivamente.

---

# 4. PRINCÍPIO DE ARQUITETURA

O sistema deverá seguir:

```text
                     BRAND CORE
                         │
             Fonte única de verdade
                         │
        ┌────────────────┼────────────────┐
        │                │                │
      API/Service     Admin UI         Histórico
        │
        │
        └────── futuros consumidores ────────
                         │
              PRD 02 → PRD 08
```

Não deverá existir:

```text
Site → texto próprio
Estúdio → posicionamento próprio
Fala Tu → posicionamento próprio
Atendente → posicionamento próprio
Vertical → posicionamento próprio
```

O objetivo futuro será:

```text
                 Brand Core
                     ↓
              Brand Context
                     ↓
       consumidores autorizados
```

Mas esta integração completa ocorrerá progressivamente.

---

# 5. RESULTADO ESPERADO DO PRD 01

Após a implementação:

1. Admin Master consegue acessar o Brand Core.
2. Existe uma versão publicada.
3. Alterações acontecem primeiro em draft.
4. Draft não afeta produção.
5. Admin consegue comparar draft e versão publicada.
6. Admin consegue publicar nova versão.
7. Histórico permanece intacto.
8. Uma versão antiga pode ser restaurada como novo draft.
9. Toda alteração relevante é auditada.
10. Existe um serviço único de leitura do Brand Core.
11. Nenhum módulo precisa conhecer diretamente a tabela utilizada.
12. O sistema fica preparado para os próximos PRDs.

---

# 6. FASE 0 — AUDITORIA OBRIGATÓRIA DO CODEBASE

## Não codificar antes de concluir esta etapa.

A IA Dev deverá apresentar uma tabela:

| Área                | Encontrado no código? | Recurso existente      | Decisão                   |
| ------------------- | --------------------- | ---------------------- | ------------------------- |
| Configuração global | Sim/Não               | arquivo/tabela/service | Reutilizar/Estender/Criar |
| Company profile     |                       |                        |                           |
| Tenant settings     |                       |                        |                           |
| Brand Kit           |                       |                        |                           |
| Estúdio             |                       |                        |                           |
| RAG                 |                       |                        |                           |
| Knowledge Base      |                       |                        |                           |
| System prompts      |                       |                        |                           |
| Context builder     |                       |                        |                           |
| Admin Master        |                       |                        |                           |
| RBAC                |                       |                        |                           |
| RLS                 |                       |                        |                           |
| Audit log           |                       |                        |                           |
| Versionamento       |                       |                        |                           |
| Feature flags       |                       |                        |                           |

## Entrega obrigatória da Fase 0

A IA Dev deverá declarar explicitamente:

### A. O que será reutilizado

### B. O que será estendido

### C. O que precisará ser criado

### D. O que parece duplicado atualmente

### E. O que NÃO será alterado

### F. Riscos encontrados

Somente depois disso deve começar a implementação.

---

# 7. DECISÃO IMPORTANTE: BRAND CORE DO ZAPFLOW ≠ BRAND DOS CLIENTES

Este PRD trata exclusivamente da:

> **marca institucional ZapFlow.**

Não confundir com futura capacidade dos clientes cadastrarem suas marcas.

Portanto:

```text
PLATFORM BRAND
ZapFlow
```

é diferente de:

```text
TENANT BRAND
TOULON
Clínica X
Pet Shop Y
Escritório Z
```

Brand Intelligence dos clientes será tratado posteriormente no PRD 08.

### Regra

Não criar agora uma arquitetura gigantesca de gestão de marcas de clientes tentando antecipar o PRD 08.

Preparar para extensão futura, mas implementar somente o necessário neste PRD.

---

# 8. MODELO CONCEITUAL DO BRAND CORE

Independentemente da implementação física escolhida, o domínio deverá conseguir representar:

```typescript
BrandCore {
  id
  version
  status

  essence
  purpose

  category
  positioning
  promise

  coreProblem
  enemy

  targetAudience

  transformation

  mechanism

  brandAttributes

  functionalBenefits
  emotionalBenefits

  differentiators

  proofPoints
  approvedClaims
  restrictedClaims

  createdBy
  createdAt

  updatedBy
  updatedAt

  publishedBy
  publishedAt

  sourceVersion
}
```

### Atenção

Isto é um **modelo conceitual**, não uma ordem para criar obrigatoriamente uma tabela com esses campos.

Se o ZapFlow já possui estrutura adequada baseada em:

* JSONB;
* configuration store;
* versioned documents;
* settings;
* metadata;

ela deverá ser preferida quando tecnicamente melhor.

---

# 9. CONTEÚDO DO BRAND CORE

## 9.1 Essence

Pergunta:

> Por que o ZapFlow existe independentemente das tecnologias que utiliza?

Draft inicial:

> **Fazer empresas funcionarem melhor e dependerem menos do empresário para tudo.**

---

# 10. PURPOSE

Draft inicial:

> Ajudar empresas a transformar conhecimento, informação e intenção em execução organizada e inteligente.

Este campo deverá ser editável.

Não hardcodar essa frase no frontend.

---

# 11. CATEGORY

Draft:

> **Sistema Operacional Inteligente para Empresas**

### Importante

Tratar como hipótese estratégica inicialmente aprovada para cadastramento, mas editável.

A IA Dev **não tem autorização para reinterpretar ou mudar o posicionamento durante a implementação**.

---

# 12. POSITIONING

Draft:

> O ZapFlow conecta inteligência, operação e execução para ajudar empresas a funcionar de forma mais organizada, previsível e menos dependente do proprietário ou de pessoas-chave.

---

# 13. PROMISE

Draft:

> **Sua empresa funcionando, mesmo quando você não está olhando.**

---

# 14. CORE PROBLEM

Problema principal:

# Dependência Operacional

O sistema deverá permitir registrar suas manifestações:

```text
dependência do proprietário
dependência de funcionários-chave
dependência da memória
dependência de processos manuais
dependência de planilhas
dependência de WhatsApp
dependência de conhecimento informal
dependência de acompanhamento humano
dependência de cobrança manual
```

---

# 15. ENEMY

Não confundir “enemy” com concorrente.

O inimigo conceitual da marca será algo como:

> caos operacional, dependência excessiva e informação que não vira execução.

Campo editável.

---

# 16. TARGET AUDIENCE

A estrutura precisa comportar mais de um segmento.

Exemplo:

```json
{
  "primary": [
    "PMEs",
    "empresários",
    "gestores",
    "autônomos com operação crescente"
  ]
}
```

Não utilizar isso ainda para construir segmentação complexa.

Isso será aprofundado posteriormente.

---

# 17. TRANSFORMAÇÃO

Estruturar claramente:

```text
BEFORE
↓
AFTER
```

### Antes

```text
Informação espalhada
↓
Pessoas precisam lembrar
↓
Gestor precisa cobrar
↓
Problemas são descobertos tarde
↓
Empresário apaga incêndios
```

### Depois

```text
Informação conectada
↓
Sistema identifica contexto
↓
Organiza a necessidade
↓
Aciona a execução
↓
Acompanha
↓
Aprende
```

---

# 18. MECANISMO DA MARCA

Cadastrar inicialmente:

# OBSERVA → ENTENDE → ORGANIZA → AGE → ACOMPANHA → APRENDE

Representação recomendada:

```typescript
mechanism: {
  steps: [
    {
      key: "observe",
      label: "Observa",
      order: 1
    },
    {
      key: "understand",
      label: "Entende",
      order: 2
    },
    {
      key: "organize",
      label: "Organiza",
      order: 3
    },
    {
      key: "act",
      label: "Age",
      order: 4
    },
    {
      key: "follow",
      label: "Acompanha",
      order: 5
    },
    {
      key: "learn",
      label: "Aprende",
      order: 6
    }
  ]
}
```

Não hardcodar ordem na UI se puder ser armazenada.

---

# 19. BENEFÍCIOS FUNCIONAIS

Draft inicial:

```text
mais organização
mais controle
mais execução
mais previsibilidade
redução de tarefas esquecidas
redução da dependência de pessoas
mais automação
melhor acompanhamento
melhor aproveitamento das informações
recuperação de oportunidades
economia de tempo
```

---

# 20. BENEFÍCIOS EMOCIONAIS

Draft:

```text
tranquilidade
controle
segurança operacional
clareza
confiança para delegar
menos sensação de apagar incêndios
```

---

# 21. DIFERENCIAIS

Não confundir diferencial com feature.

Exemplos iniciais:

### 1. Inteligência integrada à execução

Não apenas responde.

Pode transformar contexto em ação dentro da operação.

### 2. Conhecimento contínuo da empresa

O objetivo é compreender contexto empresarial progressivamente.

### 3. Visão transversal

Comercial, operação, atendimento, gestão e demais áreas podem trabalhar conectadas.

### 4. Humanização

Automação não deve significar relacionamento mecânico.

### 5. Ação contextual

IA deve considerar:

```text
empresa
usuário
cliente
processo
histórico
permissão
situação
```

### Regra

A IA Dev não deve transformar esses itens em claims públicos neste PRD.

Estamos estruturando dados.

---

# 22. PROOF POINTS

O Brand Core precisa estar preparado para guardar evidências futuras.

Exemplo conceitual:

```typescript
ProofPoint {
  id
  type
  title
  description
  metric?
  value?
  source?
  verified
}
```

Tipos:

```text
case
metric
testimonial
integration
product_capability
customer_result
```

---

# 23. APPROVED CLAIMS

Exemplo:

```text
ZapFlow conecta inteligência e operação.

ZapFlow ajuda empresas a automatizarem atividades operacionais.

ZapFlow ajuda gestores a acompanhar o que acontece na empresa.
```

Inicialmente estes claims poderão permanecer vazios até revisão.

---

# 24. RESTRICTED CLAIMS

Extremamente importante.

Exemplos:

```text
"Elimina todos os erros."
"Substitui completamente funcionários."
"Funciona sozinho em qualquer empresa."
"Garante aumento de faturamento."
"Garante redução de X%."
"É o melhor sistema do Brasil."
```

Claims quantitativos precisam de evidência.

Essa estrutura será utilizada futuramente pelo Brand Guardian.

---

# 25. STATUS E VERSIONAMENTO

Estados mínimos:

```text
DRAFT
PUBLISHED
ARCHIVED
```

## Regra

Deverá existir:

**somente uma versão publicada ativa.**

---

# 26. IMUTABILIDADE

Versão publicada não poderá ser editada diretamente.

Fluxo:

```text
Published v1
↓
Create Draft
↓
Draft v2
↓
editar
↓
review
↓
publish
↓
Published v2
```

A `Published v1` permanece no histórico.

---

# 27. ROLLBACK

Não implementar:

```text
Restaurar versão 3
↓
sobrescrever versão atual
```

Implementar:

```text
Seleciona versão antiga
↓
Criar novo Draft usando aquela versão
↓
Admin revisa
↓
Publica
↓
nova versão é criada
```

Exemplo:

```text
V1 published
V2 published
V3 published

restaurar V1

→ cria V4 draft baseado em V1
→ usuário revisa
→ publica V4
```

Preservando todo histórico.

---

# 28. CONCORRÊNCIA DE EDIÇÃO

Prevenir cenário:

```text
Admin A abre Draft
Admin B abre Draft

B salva
A salva versão antiga por cima
```

Utilizar mecanismo compatível com arquitetura atual:

* optimistic locking;
* version number;
* updated_at validation;
* ETag;
* ou equivalente.

Se houver conflito:

> “Esta versão foi atualizada por outro usuário. Recarregue para revisar as alterações.”

Nunca sobrescrever silenciosamente.

---

# 29. CONTRATO DE LEITURA

Criar ou ampliar serviço central equivalente a:

```typescript
getPublishedBrandCore()
```

Retorno:

```typescript
{
  version,
  essence,
  purpose,
  category,
  positioning,
  promise,
  coreProblem,
  enemy,
  targetAudience,
  transformation,
  mechanism,
  brandAttributes,
  functionalBenefits,
  emotionalBenefits,
  differentiators,
  proofPoints,
  approvedClaims,
  restrictedClaims
}
```

---

# 30. BRAND CONTEXT RESOLVER

Preparar interface estável equivalente a:

```typescript
getBrandCoreContext()
```

Esse resolver será utilizado futuramente por:

```text
Estúdio
Fala Tu
Atendente IA
Diretor IA
Conteúdo
Social
Campanhas
Propostas
Landing pages
Verticais
```

### Neste PRD:

não migrar automaticamente todos esses consumidores.

O resolver apenas precisa estar disponível.

---

# 31. REGRA DE ACESSO AO DADO

Consumidores futuros NÃO deverão fazer:

```typescript
db.brand_core.select(...)
```

diretamente.

Deverão utilizar:

```typescript
BrandCoreService
```

ou equivalente existente.

Isso permite mudar armazenamento futuramente sem quebrar consumidores.

---

# 32. API / SERVICE CONTRACT

A implementação exata deverá respeitar a arquitetura atual.

Operações necessárias:

```typescript
getPublishedBrandCore()

getDraftBrandCore()

getBrandCoreVersion(id)

listBrandCoreVersions()

createDraftFromPublished()

updateDraft()

validateDraft()

publishDraft()

createDraftFromVersion()
```

Opcional:

```typescript
compareVersions()
```

Se comparação puder ser feita com baixo custo.

---

# 33. ADMIN UI

Criar ou integrar ao Admin Master.

Não criar uma segunda aplicação administrativa.

Menu sugerido:

```text
Admin Master
   ↓
Marca ZapFlow
   ↓
Brand Core
```

---

# 34. TELA PRINCIPAL

Mostrar:

```text
BRAND CORE ZAPFLOW

Versão publicada: V3
Status: PUBLICADA
Publicada em:
Publicada por:

[Editar como novo Draft]
[Histórico]
```

Se existir draft:

```text
Draft V4
Última atualização
Responsável

[Continuar edição]
[Comparar]
[Descartar draft]
```

---

# 35. SEÇÕES DA EDIÇÃO

### 1. Essência

* Essence
* Purpose

### 2. Posicionamento

* Category
* Positioning
* Promise

### 3. Problema

* Core Problem
* Enemy

### 4. Público

* Target Audience

### 5. Transformação

* Before
* After

### 6. Mecanismo

* steps

### 7. Benefícios

* functional
* emotional

### 8. Diferenciais

### 9. Provas

### 10. Claims

* approved
* restricted

---

# 36. VALIDAÇÃO DA PUBLICAÇÃO

Antes de `Publish`, validar obrigatoriamente:

```text
essence
purpose
category
positioning
promise
coreProblem
transformation
mechanism
```

Se incompleto:

```text
Brand Core não pode ser publicado.

Campos obrigatórios pendentes:
- Promise
- Transformation After
```

---

# 37. PREVIEW

Antes da publicação, apresentar:

```text
Você está prestes a publicar:

Brand Core V4
```

Mostrar resumo das mudanças.

Ideal:

```text
Promise
ANTES:
...

DEPOIS:
...
```

---

# 38. CONFIRMAÇÃO DE PUBLICAÇÃO

Exigir confirmação explícita.

Exemplo:

> Publicar esta versão fará com que ela se torne a versão oficial do Brand Core do ZapFlow. A versão atual permanecerá disponível no histórico.

Botões:

```text
Cancelar
Publicar V4
```

---

# 39. AUDITORIA

Todos os eventos devem gerar registro.

Eventos mínimos:

```text
brand_core.draft_created
brand_core.draft_updated
brand_core.draft_deleted
brand_core.version_published
brand_core.version_restored_to_draft
```

Registrar:

```text
actor
timestamp
version
previousVersion
action
correlationId
```

Quando apropriado:

```text
changedFields
```

Não registrar conteúdo sensível desnecessariamente.

---

# 40. RBAC

Somente papel autorizado de administração máxima poderá:

```text
criar draft
editar
publicar
restaurar
descartar
```

Outros perfis administrativos podem eventualmente possuir `read`.

A IA Dev deverá **reutilizar o RBAC existente**.

Não criar papel isolado apenas para este recurso se o modelo atual comportar permissão granular.

---

# 41. RLS / SEGURANÇA

Se o projeto utiliza RLS:

A proteção deverá existir no banco.

Não confiar apenas em:

```typescript
if (user.role === "admin")
```

no frontend.

Teste obrigatório:

usuário de tenant não consegue consultar nem alterar Brand Core administrativo da plataforma por chamada direta à API/banco.

---

# 42. MULTI-TENANT

O Brand Core deste PRD pertence ao:

```text
PLATFORM SCOPE
```

e não a um tenant comercial.

Evitar:

```text
tenant A possui Brand Core ZapFlow
tenant B possui outro
```

A marca institucional deve ser única.

O Brand Core dos clientes será arquitetura futura.

---

# 43. SEED INICIAL

A migration/seed poderá criar:

```text
Brand Core V1
STATUS = DRAFT
```

com os valores estratégicos propostos neste PRD.

### Muito importante

**Não publicar automaticamente.**

O Admin Master deverá revisar e publicar manualmente.

---

# 44. FALLBACK

Enquanto nenhuma versão estiver publicada:

```typescript
getPublishedBrandCore()
```

não deve derrubar aplicação.

Retorno esperado deve seguir padrão da arquitetura existente.

Por exemplo:

```typescript
{
  status: "not_configured"
}
```

ou `null` tipado.

### Proibido

Inventar Brand Core automaticamente.

---

# 45. FEATURE FLAG

Se o ZapFlow já possui mecanismo de feature flags:

usar flag equivalente a:

```text
brand_core_admin
```

para liberação progressiva.

Se **não existir** infraestrutura de feature flag:

não construir um sistema inteiro de feature flags somente para este PRD.

Utilizar controle de rota/permissão existente.

---

# 46. MIGRATION STRATEGY

A implementação deve ser predominantemente:

# ADDITIVE

Evitar:

```text
DROP TABLE
RENAME destrutivo
remoção de coluna
breaking API
mudança de contrato existente
```

Se qualquer alteração destrutiva for realmente necessária:

IA Dev deve parar e justificar antes de executar.

---

# 47. COMPATIBILIDADE

Este PRD não deve alterar o funcionamento atual de:

* CRM;
* WhatsApp;
* Agenda;
* Estúdio;
* campanhas;
* vertical Moda;
* Pet;
* clínicas;
* financeiro;
* cobrança;
* Fala Tu;
* agentes;
* integrações;
* Alterdata;
* Evolution;
* demais módulos.

A existência do Brand Core não pode exigir que módulos atuais já passem a consumi-lo.

---

# 48. PERFORMANCE

Brand Core será dado de baixa frequência de alteração e alta frequência futura de leitura.

Arquitetura deve estar preparada para eventual:

```text
cache
```

mas não introduzir complexidade desnecessária neste momento.

Se já houver cache/config cache:

utilizar.

Se não houver:

não criar Redis exclusivamente para Brand Core.

---

# 49. OBSERVABILIDADE

Registrar:

```text
falhas de leitura
falhas de publicação
validation failures
conflict failures
permission denied
```

Criar métricas somente se a infraestrutura existente já suportar.

Não construir nova plataforma de observabilidade neste PRD.

---

# 50. TESTES UNITÁRIOS OBRIGATÓRIOS

Cobrir:

```text
schema validation
required fields
draft creation
draft update
published immutability
publication
single published version
history
restore-to-draft
optimistic concurrency
fallback
```

---

# 51. TESTES DE INTEGRAÇÃO

Testar:

```text
Admin → create draft
Admin → edit
Admin → publish
Admin → read published
Admin → create draft from old version
Admin → publish restored version
```

---

# 52. TESTES DE SEGURANÇA

Obrigatórios:

### Caso 1

Tenant user tenta editar Brand Core.

Resultado:

```text
403 / permission denied
```

### Caso 2

Tenant user tenta consultar endpoint administrativo.

Resultado:

```text
negado
```

### Caso 3

Admin autorizado.

Resultado:

```text
permitido
```

---

# 53. TESTE DE CONCORRÊNCIA

Cenário:

```text
Admin A abre Draft V2 revision 5.

Admin B modifica V2 → revision 6.

Admin A tenta salvar revision 5.
```

Resultado:

```text
CONFLICT
```

e não sobrescrever atualização de B.

---

# 54. TESTES FRONTEND

Validar:

* carregamento;
* loading;
* erro;
* estado vazio;
* formulário;
* autosave, se utilizado;
* salvamento manual;
* validações;
* comparação;
* publicação;
* histórico;
* restauração;
* permissão;
* responsividade.

---

# 55. RESPONSIVIDADE

Admin UI deve ser funcional em:

```text
Desktop
Tablet
Android
iPhone/iOS
```

Não é necessário otimizar edição complexa para telas extremamente pequenas além do razoável, mas nenhuma informação pode ficar inacessível.

---

# 56. ACESSIBILIDADE

Preservar:

* labels;
* foco;
* navegação por teclado;
* contraste;
* botões identificáveis;
* mensagens de erro associadas ao campo;
* sem depender somente de cor para status.

---

# 57. O QUE NÃO FAZER NESTE PRD

## NÃO implementar ainda:

### PRD 02

nova identidade verbal completa.

### PRD 03

reescrever site inteiro.

### PRD 04

IDO.

### PRD 05

Value Ledger/RIC expandido.

### PRD 06

reescrever microcopy do produto.

### PRD 07

templates completos das verticais.

### PRD 08

Brand Intelligence dos clientes.

Também NÃO:

* alterar automaticamente prompts existentes;
* substituir RAG;
* criar novo Estúdio;
* criar novo agente;
* criar Brand Guardian;
* mudar sidebar sem necessidade;
* mudar identidade visual;
* alterar logo;
* modificar pricing;
* modificar planos.

---

# 58. ORDEM DE EXECUÇÃO TÉCNICA

A IA Dev deverá trabalhar nesta ordem:

## T0 — Discovery técnico

Mapear codebase.

**Sem código.**

---

## T1 — Reuse Map

Apresentar:

```text
REUTILIZAR
ESTENDER
CRIAR
NÃO TOCAR
```

---

## T2 — Architectural Decision

Definir:

* armazenamento;
* domínio;
* versionamento;
* service;
* acesso;
* permissions;
* audit;
* UI integration.

Registrar decisão resumidamente.

---

## T3 — Schema / Migration

Implementar apenas após T0–T2.

---

## T4 — Domain / Service

Criar ou estender:

```text
BrandCoreService
```

ou nomenclatura equivalente existente.

---

## T5 — API / Server Actions

Implementar operações necessárias.

---

## T6 — Admin UI

Criar gestão do Brand Core dentro da administração existente.

---

## T7 — Seed

Criar V1 como:

```text
DRAFT
```

---

## T8 — Security

RBAC + RLS.

---

## T9 — Audit

Registrar ações.

---

## T10 — Tests

Unitário + integração + segurança + regressão.

---

## T11 — Documentação

Documentar arquitetura.

---

## T12 — Relatório final

Somente depois declarar PRD concluído.

---

# 59. CRITÉRIOS DE ACEITE

O PRD será aceito apenas se todos os seguintes itens forem verdadeiros.

### CA01

Admin Master consegue abrir Brand Core.

### CA02

Consegue visualizar versão publicada.

### CA03

Consegue criar draft.

### CA04

Consegue editar draft.

### CA05

Draft não altera produção.

### CA06

Versão publicada é imutável.

### CA07

Só pode existir uma versão publicada ativa.

### CA08

Consegue publicar draft válido.

### CA09

Publicação incompleta é bloqueada.

### CA10

Histórico é preservado.

### CA11

É possível recuperar versão antiga como novo draft.

### CA12

Rollback não apaga histórico.

### CA13

Alterações são auditadas.

### CA14

Usuário sem permissão não consegue modificar.

### CA15

Tenant user não acessa administração do Brand Core.

### CA16

Existe um serviço único de leitura.

### CA17

Nenhum consumidor precisa ler tabela diretamente.

### CA18

Nenhuma funcionalidade atual foi quebrada.

### CA19

Nenhuma implementação paralela desnecessária foi criada.

### CA20

Testes existentes continuam passando.

---

# 60. DEFINITION OF DONE

Não considerar este PRD concluído porque “a tela apareceu”.

Somente considerar concluído quando houver:

```text
Discovery
+
Reuse Map
+
Decisão arquitetural
+
Schema
+
Migration
+
Backend
+
Admin UI
+
RBAC
+
RLS
+
Audit
+
Versionamento
+
Testes
+
Documentação
+
Evidências
+
Regressão aprovada
```

---

# 61. RELATÓRIO OBRIGATÓRIO DA IA DEV

Ao finalizar, apresentar exatamente estas seções:

## 1. RESUMO DA ENTREGA

O que foi implementado.

## 2. ANÁLISE DO CODEBASE

O que já existia.

## 3. REUTILIZAÇÕES

O que foi reaproveitado.

## 4. ALTERAÇÕES

O que foi modificado.

## 5. NOVOS COMPONENTES

O que realmente precisou ser criado.

## 6. BANCO

Migrations e alterações.

## 7. SEGURANÇA

RBAC/RLS alterados.

## 8. APIs/SERVICES

Novos ou modificados.

## 9. FRONTEND

Telas/componentes.

## 10. TESTES

Listar:

```text
teste
resultado
```

## 11. REGRESSÕES

Declarar resultado.

## 12. PENDÊNCIAS

Tudo que ficou incompleto.

## 13. RISCOS

Riscos identificados.

## 14. ARQUIVOS MODIFICADOS

Listar caminho de cada arquivo.

## 15. EVIDÊNCIAS

Quando aplicável:

* prints;
* logs;
* testes;
* resultados.

---

# 62. CHECKLIST OBRIGATÓRIO DE ENTREGA

A IA Dev deverá copiar este checklist no relatório final e marcar:

**✅ concluído**
**⚠️ parcial**
**❌ não realizado**
**🚫 bloqueado**

```text
[ ] Auditoria do codebase realizada
[ ] Reuse Map entregue
[ ] Duplicações existentes identificadas
[ ] Decisão arquitetural documentada

[ ] Brand Core implementado
[ ] Estrutura reutiliza recursos existentes quando possível
[ ] Essence implementada
[ ] Purpose implementado
[ ] Category implementada
[ ] Positioning implementado
[ ] Promise implementada
[ ] Core Problem implementado
[ ] Enemy implementado
[ ] Target Audience implementado
[ ] Transformation implementada
[ ] Mechanism implementado
[ ] Functional Benefits implementados
[ ] Emotional Benefits implementados
[ ] Differentiators implementados
[ ] Proof Points implementados
[ ] Approved Claims implementados
[ ] Restricted Claims implementados

[ ] Draft implementado
[ ] Publish implementado
[ ] Published immutable
[ ] Histórico implementado
[ ] Restore-to-Draft implementado
[ ] Controle de concorrência implementado

[ ] Serviço central de leitura implementado
[ ] Brand Context Resolver disponível
[ ] Consumidores não precisam acessar tabela diretamente

[ ] Admin UI implementada
[ ] Preview implementado
[ ] Confirmação de publicação implementada
[ ] Histórico acessível

[ ] RBAC validado
[ ] RLS validado
[ ] Tenant isolation validado
[ ] Audit Log implementado

[ ] Seed V1 criado como DRAFT
[ ] Nenhuma publicação automática realizada

[ ] Testes unitários executados
[ ] Testes de integração executados
[ ] Testes de segurança executados
[ ] Teste de concorrência executado
[ ] Testes frontend executados
[ ] Regressão executada

[ ] Desktop validado
[ ] Tablet validado
[ ] Android validado
[ ] iPhone/iOS validado

[ ] Documentação atualizada
[ ] Arquivos modificados listados
[ ] Migrations listadas
[ ] APIs listadas
[ ] Pendências listadas
[ ] Riscos listados
[ ] Evidências anexadas

[ ] Nenhuma funcionalidade existente removida
[ ] Nenhuma implementação paralela desnecessária criada
[ ] Nenhum PRD futuro foi antecipado indevidamente
```

---

# 63. GATE PARA O PRD 02

**NÃO iniciar o PRD 02 automaticamente.**

Após finalizar o PRD 01:

```text
IA Dev entrega
↓
Checklist
↓
Evidências
↓
Usuário valida
↓
Correções, se necessárias
↓
PRD 01 aprovado
↓
SOMENTE ENTÃO
↓
PRD 02
```

O PRD 02 deverá consumir a arquitetura criada aqui e não recriá-la.

---

# 64. REGRA FINAL À IA DEV

> **Não interprete este PRD como autorização para reescrever o ZapFlow. O objetivo é introduzir a fundação de Brand Core da maneira menos invasiva possível, reutilizando a arquitetura existente. Faça alterações incrementais, reversíveis e testáveis. Não remova funcionalidades, não duplique recursos e não antecipe funcionalidades dos PRDs seguintes. Em qualquer situação onde a implementação proposta entre em conflito com arquitetura já madura do sistema, preserve a arquitetura existente e documente a adaptação realizada.**

---

## Minha orientação para você

**Este, sim, eu considero um PRD detalhado que já pode ser entregue para a IA Dev começar.**

Mas existe uma diferença importante: **a primeira ação dela deve ser analisar o repositório, não começar criando tabela.** Esse ponto é deliberado. Como ainda não validamos tecnicamente se o ZapFlow já possui algum `brand profile`, configuração global, mecanismo de versionamento ou estrutura reaproveitável, mandar criar banco imediatamente seria justamente abrir caminho para duplicação.

Depois que a IA Dev concluir este PRD e te devolver o **Reuse Map + checklist + arquivos alterados + evidências**, me envie a resposta dela. A partir dessa implementação real, eu consigo construir o **PRD 02 — Identidade Verbal e Arquitetura de Mensagens** já encaixado no que efetivamente foi criado no PRD 01, em vez de trabalharmos sobre suposições.
