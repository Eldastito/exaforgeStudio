# Integração ZappFlow ↔ Alterdata/ModaUp — o que pedir (linguagem simples)

Guia para o Emerson (produto) explicar/encaminhar à **TI da TOULON** e à
**Alterdata**. O ZappFlow já está pronto do lado do software; falta só o acesso.

---

## Em uma frase
O ZappFlow quer **ler** do sistema da TOULON (ModaUp/Alterdata) os **produtos,
o estoque e os preços**, para não ter digitação dupla. Para isso a Alterdata dá
um "cadeado" (o **Guardian**) que libera o acesso, e precisamos de **3 coisas**.

---

## 1) O "usuário" — NÃO é o login das lojas
> Que usuário são esses? Os das lojas da TOULON?

**Não.** Não é o login das vendedoras nem o do caixa. É um **usuário do sistema
de retaguarda** (o ModaUp/Alterdata, o "back office" onde a TOULON cadastra
produto, preço, etc.), com **acesso total**.

O Guardian da Alterdata usa **e-mail = login** e **senha** desse usuário para
liberar a leitura. Como o ZappFlow guarda essa senha (de forma **criptografada**)
para renovar o acesso sozinho, a recomendação é:

> **Criar um usuário NOVO, dedicado só à integração** (ex.:
> `integracao@toulon...`), com acesso total de leitura — em vez de usar o login
> pessoal de alguém. Assim, se um dia precisar cortar o acesso, desativa só esse
> usuário, sem afetar ninguém.

**Quem faz:** a **TI da TOULON** (ou quem administra o ModaUp), porque só quem
tem acesso de administrador no sistema consegue criar usuário e dar as permissões.

---

## 2) "Homologação" — o que é
> Ainda não entendi o que é homologação.

**Homologação = ambiente de teste.** É uma cópia do sistema, separada do que roda
na loja de verdade (a "produção"). A gente **testa a integração ali primeiro**:
se algo der errado, não mexe no estoque/preço real das lojas. Quando estiver
100%, a gente aponta para produção.

Para testar em homologação, a **Alterdata** precisa informar:
- os **endereços (URLs) de homologação** das APIs (ex.: onde ficam os serviços de
  produto, estoque e preço no ambiente de teste);
- a **rede** da TOULON (o código da cadeia no sistema) e a(s) **filial(is)** que
  vamos começar (sugestão: **1 loja** primeiro);
- o **número da tabela de preço** que vale para as lojas (o ModaUp trabalha com
  "tabelas de preço" numeradas).

---

## 3) Mensagem pronta para enviar à Alterdata
> Copie e cole:

> Olá! Estamos integrando o **ZappFlow** ao **ModaUp** da TOULON, começando com
> **leitura** de produto, estoque e preço (Supply/Price), em **homologação**,
> **1 filial**. Já validamos o fluxo do **Guardian**
> (`POST guardian.apimodaup.com.br/connect/token`, client_credentials,
> client_id = e-mail / client_secret = senha, com os scopes dos módulos).
> Para começar, precisamos de vocês:
> 1. **URLs de homologação** dos módulos (Supply, Price) — o padrão do subdomínio
>    por módulo (ex.: `...-supply.apimodaup.com.br`, `...-price.apimodaup.com.br`).
> 2. **Rede** (código da cadeia) e **filial** de teste da TOULON.
> 3. **Número da tabela de preço** da rede a usar.
> 4. Confirmação de que dá para usar um **usuário de retaguarda dedicado, só de
>    leitura**, para a integração.
> 5. Confirmação de que o endpoint `.../{Recurso}/versao/{versao}` devolve, junto,
>    a **nova versão** (para o controle incremental).

## 4) Mensagem pronta para a TI da TOULON
> Copie e cole:

> Preciso que vocês **criem no ModaUp/retaguarda um usuário dedicado à integração
> com o ZappFlow** (ex.: `integracao@toulon...`), com **acesso total de leitura**
> aos módulos de produto, estoque e preço. Me passem o **e-mail e a senha** desse
> usuário — o ZappFlow guarda de forma criptografada e usa só para ler os dados.
> Esse usuário **não é** o login das lojas; é um usuário de sistema.

---

## O que acontece quando tudo isso chegar (eu, Emerson, faço no ZappFlow)
Em **Integrações › ERP Alterdata / ModaUp**:
1. Colar **Client ID (e-mail)** e **Client Secret (senha)** do usuário dedicado;
   preencher **rede**, **filial** e **tabela de preço** → **Salvar**.
2. Clicar **"Testar conexão"** → tem que aparecer "Conexão OK".
3. Marcar **Integração ativa**.
4. Clicar **"Sincronizar agora"** → produtos, variantes, estoque e preços da
   TOULON entram no ZappFlow. Depois disso, atualiza sozinho de tempos em tempos.

---

## Resumo de "quem faz o quê"
| # | O quê | Quem |
|---|---|---|
| 1 | Criar usuário dedicado (retaguarda, acesso total leitura) | **TI da TOULON** |
| 2 | URLs de homologação + rede/filial + tabela de preço | **Alterdata** |
| 3 | Colar credenciais → Testar → Ativar → Sincronizar | **Emerson (ZappFlow)** |

Do lado do **software, está tudo pronto** (token, produto, estoque, preço) — falta
só liberar o acesso (itens 1 e 2).
