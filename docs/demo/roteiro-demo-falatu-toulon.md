# Roteiro de Demonstração — Fala Tu (piloto TOULON)

> **Regra de ouro pra falar pro cliente:** *"Você fala. A IA entende. Você confere. Só então acontece."*
> Nada é criado sem o **"Confere"** — é o princípio central e testado do produto (RN-151).

O Fala Tu é o **"segundo cérebro" por voz** do ZapFlow: a pessoa **fala, digita ou fotografa**; a IA
transcreve e entende a intenção (tarefa / compromisso / lista de compras / anotação) e **sugere** a ação;
o humano **confirma** e só então vira registro de verdade — já ligado ao domínio canônico do ZapFlow
(tarefas, agenda, requisição de compra).

---

## Preparação (antes do cliente chegar)

- [ ] **Fala Tu ligado** para a organização de teste da TOULON (Admin Master → coluna **FalaTu** → **Ligado**).
      ⚠️ Ligar na organização EXATA em que o testador vai entrar (a TOULON tem várias lojas/CNPJs — Nova
      Iguaçu, Avenida Brasil, Carioca, Grande Rio, TOULON, TOULON Rio). O flag é por organização.
- [ ] Testador entra com usuário **dono (owner)** ou **gerente** — perfis que já enxergam o módulo `falatu`.
      (Vendedor/caixa/estoquista **não** veem por padrão; se o testador for um desses, liberar o módulo
      `falatu` no perfil dele.)
- [ ] Abrir a aba **Fala Tu** no **celular** (é mobile-first — o efeito da voz é o destaque).
- [ ] Opcional: cadastrar dois contatos "Carlos" para demonstrar a desambiguação.
- [ ] Manter **WhatsApp e briefing proativo DESLIGADOS** no primeiro teste (o app sozinho já mostra tudo;
      são opt-ins separados).
- [ ] Conta com plano que tenha cota de IA (cada captura consome IA).

---

## Cena 1 — Tarefa por voz (o "aha" inicial)

- **Fale** (botão do microfone): *"Anota: ligar pro fornecedor de sacolas amanhã de manhã."*
- **Veja:** card no **Inbox** — intenção **Tarefa**, texto transcrito, prazo "amanhã".
- **Aperte "Confere".** → vira tarefa de verdade na aba **Tarefas**.
- **Fale pro cliente:** *"Repara que ele não inventou o horário — eu não falei a hora, então ele deixou
  em aberto. Ele nunca chuta."*

## Cena 2 — Compromisso na agenda

- **Fale:** *"Reunião com a fornecedora terça-feira às 10 da manhã."*
- **Veja:** card com intenção **Compromisso**. Ao confirmar, se **vincular um contato real**, entra na
  **Agenda**; sem contato/horário, fica lembrete pessoal.
- **Valor:** *"A agenda da empresa e o meu lembrete pessoal são coisas diferentes — ele respeita isso."*

## Cena 3 — Lista de compras → requisição (o coração pro varejo)

- **Fale:** *"Lista de compra: 20 camisas P, 15 camisas M, 10 calças jeans 40, e caixa de sacolas."*
- **Veja:** intenção **Lista**. Ao confirmar, ele **casa os itens com o catálogo de produtos** e cria
  uma **requisição de compra em rascunho** (aba Listas).
- **Fale pro cliente:** *"Ele já reconheceu os produtos do seu catálogo. Vira um pedido em rascunho —
  você aprova depois; ele nunca compra sozinho."*

## Cena 4 — Conferência de nota fiscal (fecha o ciclo do varejo)

- Na lista criada, toque em **"Conferir compra (foto da nota)"** e **fotografe uma nota fiscal**.
- **Veja:** ele lê a nota e mostra **planejado × comprado** lado a lado; você marca o que chegou.
- **Fale:** *"Foto da nota. Ele confere o que você planejou contra o que realmente veio — sem digitar."*

## Cena 5 — Desambiguação ativa ("qual Carlos?")

- **Fale:** *"Anota: cobrar o Carlos do pagamento."* (com 2 "Carlos" no cadastro)
- **Veja:** ele **pergunta "qual Carlos?"** com as opções; você escolhe.
- **Fale:** *"Ele não adivinha quem é. Pergunta. É o oposto de uma IA que erra e faz besteira."*

## Cena 6 — Briefing diário (a proatividade)

- Na aba **Briefing**, mostre o resumo de "hoje" (pendências + compromissos).
- **Explique:** *"De manhã isso chega automático — aqui, no WhatsApp, no e-mail ou como notificação.
  Você abre o dia sabendo o que importa."* (Deixe claro que o envio automático é opt-in.)

---

## Fechamento (a frase de venda)

> *"O ZapFlow já é o cérebro do negócio. O Fala Tu é a **boca e o ouvido** dele: você fala do jeito que
> pensa, no corre da loja, e vira ação organizada — sempre com você no controle do 'Confere'."*

---

## Canais alternativos de captura (mencionar, não precisa demonstrar todos)

- **WhatsApp da equipe:** manda áudio/texto começando com **"anota…"**; confirma com **"confere"**,
  descarta com **"descarta"**; responde desambiguação com **"é 1"/"é 0"**.
- **Plugues externos** (aba Plugues): token pessoal para **Atalho da Siri, Share Target do Android,
  adesivo NFC no balcão, Zapier/n8n/ERP** — write-only (só enche o inbox, nunca lê nem confirma).
- **Envio de documento**: foto/PDF de nota ou comprovante.

## O que é opt-in (deixar claro pro cliente)

- Módulo inteiro é **opt-in por organização** (flag `falatu_enabled`).
- **WhatsApp** exige conectar o número; **envio proativo por WhatsApp** é opt-in separado.
- **Memória inteligente (RAG), alertas proativos e protocolos** são flags separadas, desligadas por padrão.
- **Nada é executado sem a pessoa confirmar** — requisição de compra nasce em rascunho; aprovações
  delegam ao motor canônico de decisão.

---

_Referências no código: `FalaTuService` (ciclo Fala→Faz→Confere), rotas `/api/falatu/*`, `FalaTuView.tsx`
(UI mobile-first), ADR-151 (captura multimodal) e ADR-160 (pontes p/ tarefa/agenda/compra)._
