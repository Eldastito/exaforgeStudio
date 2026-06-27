# Manifesto do ZappFlow OS

> A "constituição" do produto. Todo PRD, decisão técnica e funcionalidade nova é
> avaliado contra este documento. Se algo o contradiz, o documento vence — ou o
> documento muda de forma deliberada e versionada.

## A frase que define tudo

> **O ZappFlow OS é o Sistema Operacional Empresarial Inteligente.**
> O **Diretor Executivo IA** é a interface. O **Orquestrador** é o cérebro.
> Os **agentes especialistas** são a equipe. Os **módulos e serviços** são a
> infraestrutura invisível que executa o trabalho.

Não vendemos um software. Vendemos **um novo modelo de gestão**: o empresário
conversa com um diretor que entende o negócio inteiro e diz o que fazer.

---

## As 5 perguntas (o núcleo do manifesto)

### 1. O que queremos construir nos próximos 10 anos?
Um **sistema operacional para empresas** onde a inteligência — não o menu — é o
produto. O dono não "abre módulos": ele **conversa com um diretor de IA** que
coordena especialistas para executar e decidir. O software vira o motor; a
decisão vira a entrega.

### 2. Que problema resolvemos para o empresário?
O empresário não quer um CRM nem um ERP. Ele quer respostas e ação:
*"Onde estou perdendo dinheiro?"*, *"Por que minhas vendas caíram?"*,
*"Quem devo contratar?"*, *"O que faço hoje?"*. Resolvemos a **distância entre o
dado e a decisão** — e entre a decisão e a execução.

### 3. Qual é a experiência ideal do usuário?
**Uma conversa, não um painel.** O usuário fala com **um** assistente (o Diretor
Executivo). Por baixo, o Orquestrador aciona quantos especialistas forem
necessários e devolve **uma resposta única e acionável**. Os módulos existem,
mas são invisíveis para quem usa.

### 4. Quais princípios de arquitetura nunca serão quebrados?
1. **A IA interpreta; nunca inventa.** Os números vêm sempre de serviços
   determinísticos. A IA transforma número em decisão — jamais cria o número.
   (Elimina alucinação. É a regra de ouro.)
2. **O Orquestrador é o centro, não os módulos.** Módulos são *capacidades*
   plugáveis; o valor está na coordenação entre eles.
3. **Isolamento por organização é sagrado.** Todo dado é escopado por tenant
   (multi-tenant, via token). Comprovado por teste automatizado.
4. **Contexto compartilhado, não "modelo que aprende".** A inteligência vem de
   dados + RAG compartilhados entre agentes — não de fine-tuning. Mais barato,
   seguro e auditável.
5. **Especialista por vertical sobre o mesmo núcleo.** Mesmo software, mesma IA,
   vocabulário e prioridades diferentes por setor (supermercado ≠ clínica).
6. **Opt-in e aditivo.** Nada liga sozinho; nada quebra quem já usa.

### 5. Como garantir que cada novo módulo fortaleça o ecossistema (em vez de fragmentá-lo)?
Todo módulo novo deve passar no **teste de 4 portas**:
1. **Conecta ao Orquestrador?** Expõe dados/ações que o Diretor Executivo possa
   consultar e cruzar — senão é só mais uma tela isolada.
2. **Alimenta o cérebro?** Gera dado estruturado que enriquece as respostas do
   Diretor.
3. **Tem fonte determinística?** Os números que produz são consultáveis (não
   dependem da IA para existir).
4. **Cabe numa vertical?** Faz sentido para um setor específico antes de ser
   genérico.
Se não passa nas 4, **não entra** (ou entra como Skill externa, ver abaixo).

---

## Vocabulário oficial (para alinhar a equipe)

- **Capacidade**: o que o cliente "compra" e percebe (ex.: "entender a empresa",
  "vender mais", "não deixar faltar estoque"). É a linguagem de marketing/UX.
- **Especialista (Agente)**: a IA com persona e contexto de um domínio
  (Sales, Finance, Supply…). Coordenado pelo Orquestrador.
- **Módulo/Serviço**: a unidade de engenharia e billing (o motor). Determinístico.
- **Skill**: capacidade **plugável** (como app no celular) — em especial as que
  dependem de terceiros (Pix, NFe, Google Ads, Instagram, Contabilidade). O
  sistema cresce instalando skills, sem virar Frankenstein.
- **Vertical**: o "sotaque" do Orquestrador para um setor (supermercado, clínica…).

---

## Posicionamento comercial

- **O produto é o Diretor Executivo IA.** Tudo o mais (CRM, agenda, financeiro,
  compras, marketing) é o **motor**, não a vitrine.
- Vendemos **"ZappFlow Executive — seu Diretor Executivo com IA"**, não
  "CRM + IA".
- **Ressalva de execução (cold-start):** o Diretor só impressiona com dados. Por
  isso o **onboarding tem que semear dados rápido** (Quick-Start por vertical +
  conectar WhatsApp/vendas no dia 1). O Diretor é a promessa; a ativação de dados
  é o que a torna real na primeira semana.

## Estratégia de mercado: especialista → generalista

Nascer **vertical**, expandir depois. Escolher **UMA** vertical, dominá-la
(vocabulário, métricas, fluxos, integrações), provar receita, e só então abrir a
próxima. Listar 6 verticais ao mesmo tempo contradiz este princípio.

> Decisão em aberto (a única que trava o resto): **qual vertical primeiro?**
> O produto já tem profundidade em **Hotelaria** (piloto completo). "Supermercado"
> é atraente, mas exige antes o conector ERP/PDV. A escolha define o próximo trimestre.

---

## Como este manifesto é usado

- Todo PRD começa citando quais das 5 respostas ele serve.
- Toda feature nova passa pelo **teste de 4 portas**.
- Mudou o manifesto? Versiona aqui, com data e motivo. Ele é vivo, mas deliberado.
