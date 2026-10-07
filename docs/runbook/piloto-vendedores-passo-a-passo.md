# Piloto TOULON — passo a passo de treinamento e suporte dos VENDEDORES (celular)

**Para quem:** o supervisor/gerente que vai treinar e dar suporte aos vendedores no piloto. **Complementa** o `fase2-piloto-toulon.md` (que é do dono). Vendedor usa o **celular**.

> **Aviso honesto:** este roteiro foi escrito a partir do que o sistema faz por dentro, **não** a partir de uso real no celular. O que o vendedor vê depende do perfil dele. Por isso o **Passo 0 é obrigatório**: antes de treinar ninguém, entre você mesmo com um usuário vendedor de teste e anote o que aparece. Onde eu não tenho certeza, está marcado **[CONFERIR]**.

## Passo 0 — Calibrar (15 min, faça sozinho antes)
1. No computador, como dono/admin: **Empresa → Equipe e permissões → Convidar Usuário**. Crie `vendedor.teste` com o perfil **Vendedor**.
2. No celular, entre com esse usuário. Anote **cada item de menu que aparece** e tire print.
   - O perfil Vendedor padrão libera: **Vendas (escrever) · Catálogo (só ver) · Atendimento (escrever) · Contatos (escrever)**. O resto fica escondido de propósito. **[CONFERIR]** se FalaTu e "Hoje" aparecem para ele; se não aparecem, **corte os itens de FalaTu do treinamento** (Parte 2, item 3).
3. Confirme que o vendedor **não** vê: Empresa, valores em R$ das lojas, metas da rede. Se vir, **pare e me avise** (é falha de permissão, não de treinamento).
4. Dono: ligue **Menu simplificado (piloto)** e **Medir o uso do menu (piloto)** (Configurações → Módulos). Avise a equipe da medição (conta telas abertas, nunca o conteúdo).

## Parte 1 — Instalar e entrar (5 min por vendedor)
1. Abra o endereço do ZapFlow no navegador do celular (Chrome no Android, Safari no iPhone).
2. Entre com o **e-mail e senha** que o dono criou. Se esquecer a senha: use "esqueci a senha" na tela de entrada.
3. **Colocar na tela inicial** para abrir como app: Android → menu ⋮ → "Adicionar à tela inicial"; iPhone → botão compartilhar → "Adicionar à Tela de Início". **[CONFERIR]** o nome do botão na versão do aparelho.
4. Teste: feche e abra pelo ícone. Se pedir login toda vez, anote o aparelho e o navegador (vai para a ficha de ocorrência).

## Parte 2 — O que o vendedor faz no dia (roteiro de 20 min, em loja)
Faça com cada vendedor, **com o celular na mão dele**, não explicando de longe.
1. **Onde estou?** Mostre o menu: o vendedor só usa o que aparece pra ele. "O que não aparece não é pra você ver."
2. **Clientes (Contatos):** buscar um cliente pelo nome; abrir; **cadastrar um cliente novo** (nome + celular). Pergunta de checagem: *"Como você acha a Maria Silva?"*
3. **FalaTu — só se apareceu no Passo 0 [CONFERIR]:** falar ou escrever o que precisa fazer. Frases que o sistema entende (teste todas com ele):
   - "anota ligar pro João amanhã"
   - "cadastra o cliente Maria Souza"
   - "marca reunião com Maria Souza amanhã às 10h" (o cliente precisa já existir)
   - Uma frase com duas coisas: "cadastra o cliente Paulo e marca reunião com ele amanhã às 10h" → o sistema mostra a lista; **tocar em "Preparar"** uma vez. O cadastro pode ficar **aguardando aprovação**; depois de aprovado, tocar em **"Tentar agora…"**.
   - Números de dinheiro das lojas **não** aparecem pro vendedor — isso é esperado.
4. **Atendimento:** abrir uma conversa, responder, marcar como resolvida. **[CONFERIR]** se o vendedor atende ou só o atendimento digital.
5. **Tarefas dele:** conferir se o gerente passou alguma tarefa (ex.: "Plano 14 dias" ou "Objetivo +X%"). Abrir, fazer, marcar como concluída.
6. **Fechamento:** o que ele **não** faz (se é do gerente) — deixe claro quem faz.

**Critério de "treinado":** o vendedor fez sozinho, sem ajuda, os itens 2 e 5 (e o 3, se aplicável) **duas vezes seguidas**.

## Parte 3 — Suporte: o que fazer quando algo dá errado
| O que o vendedor diz | Causa provável | O que fazer |
| --- | --- | --- |
| "Não achei o cliente" ao marcar reunião | O cliente ainda não foi cadastrado ou o cadastro está **aguardando aprovação** | Aprovar o cadastro (gerente) → "Tentar agora" na mesma mensagem (vale por 2 h) |
| "Não aparece a tela X" | Perfil Vendedor não libera essa tela (esperado) | Confirmar com o gerente se deveria ver; **não** mudar perfil sem decisão do dono |
| "Não vejo os números da loja" | Esperado: dinheiro é só do gestor | Nada a fazer |
| Tela em branco / "Carregando…" sem fim | Internet fraca ou sessão vencida | Puxar para atualizar; sair e entrar de novo; se persistir, ficha de ocorrência |
| Pede login toda hora | Navegador limpando dados / modo anônimo | Usar o ícone na tela inicial; não usar aba anônima; anotar aparelho |
| Tarefa duplicada ou que ele não esperava | Tarefa criada pelo gerente a partir de objetivo/plano | Conferir com o gerente quem criou (aparece na tarefa) |
| Não recebe aviso/mensagem | Aviso depende de consentimento do cliente e de flags da empresa | Não prometer; anotar e me enviar |

## Parte 4 — Ficha de ocorrência (copie e preencha para cada problema)
- Data e hora aproximada: ____
- Quem (nome do vendedor) e **aparelho/navegador**: ____
- O que tentou fazer (1 frase): ____
- O que apareceu (copiar a mensagem **exata**): ____
- **Print** da tela (anexar): ____
- Conseguiu contornar? Como: ____
- Gravidade: ☐ trava o trabalho ☐ atrapalha ☐ só incomoda

**Regra de ouro de suporte:** problema que **mostra número errado de dinheiro, mostra dado de outra loja ou deixa o vendedor ver o que não devia** = gravidade máxima, **avise o dono na hora** e me mande o print.

## Parte 5 — Rotina do piloto (2 semanas)
- **Dia 1:** Passo 0 + treinamento (Parte 1–2) com todos.
- **Diário (2 min, o supervisor):** perguntar a 2 vendedores "o que travou hoje?" e preencher fichas.
- **Fim da semana 1:** juntar as fichas; me mandar os prints e as frases exatas das mensagens de erro.
- **Fim da semana 2:** dono lê o painel (Empresa → "Como a equipe está usando o menu") e decide conforme a tabela do `fase2-piloto-toulon.md` (seção 4). **Painel mede aberturas, não se ajudou** — decida junto com o que os vendedores falaram.

## O que este piloto NÃO valida
Previsão, radar de exceções e plano de 14 dias **não têm tela** (só API); campanha preditiva não existe; mensagens automáticas a clientes do PDV dependem do consentimento (ainda sem dados). Não prometa essas coisas aos vendedores.
