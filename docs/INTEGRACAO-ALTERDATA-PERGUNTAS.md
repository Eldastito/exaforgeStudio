# Integração ZappFlow ↔ Alterdata (ModaUp) — perguntas (versão enxuta)

**Para encaminhar à Alterdata.** Já analisamos os specs OpenAPI dos módulos
(Supply, Price, CRM, Sales, eCommerce, Tributário, Receber, Logistic, Purchase),
então **o modelo de dados já está respondido** — sobraram só as pendências que
os specs **não** cobrem. Sem as respostas de **A** e **B** não é possível
iniciar a integração.

---

## A. Autenticação & credenciais  ⭐ bloqueante
As operações exigem `Authorization: Bearer`, mas **nenhum spec documenta como o
token é emitido** (não há endpoint de login/OAuth, nem `securityScheme`).
1. Como se **obtém** o token de acesso? (endpoint, client_id/secret, OAuth2
   client_credentials, chave fixa?)
2. Qual a **validade** e como é a **renovação/refresh**?
3. É **uma credencial única** para todos os módulos, ou **uma por módulo**
   (12 microserviços)?
4. Dá para emitir credencial com **escopo somente-leitura**?
5. Como é o **provisionamento** da credencial para a TOULON e quem autoriza?

## B. Ambientes & escopo  ⭐ bloqueante
6. Existe **homologação/sandbox** separado de produção? Quais as **base URLs**
   (por módulo) em homologação **e** em produção?
7. Podem emitir uma **credencial de teste** da TOULON em homologação?
8. Quais **módulos a TOULON tem licenciados/ativos**?

## C. rede / filial da TOULON
9. Os endpoints usam `rede` e `filial`. Qual é a **rede** e a(s) **filial(is)**
   da TOULON? (é **uma loja só** ou **várias**?)

## D. Confirmação do delta-sync (1 dúvida técnica)
10. Confirmam que os endpoints `GET .../versao/{version}` retornam, **junto com
    os dados, a nova "versão" atual** — para usarmos como cursor da próxima
    chamada incremental? E como obtemos a **versão inicial** (para o 1º backfill)?

## E. (opcional) Specs faltantes
11. Podem enviar os specs OpenAPI de **HumanResources** e **Financial**? (não são
    críticos ao piloto, mas completam o mapa.)

---

### Contexto que já resolvemos sozinhos (não precisam responder)
- **Modelo de dados de moda:** confirmado nos specs —
  `Referência → Grade (cor×tamanho) → CódigoDeBarras (EAN) → Saldo (estoque/filial)
  → TabelaPreço (preço/filial)`; cliente em CRM (`Cliente`, `ClienteVendaHistorico`).
- **Sincronização:** padrão `/versao/{version}` (delta) em todos os módulos; sem
  webhook (polling).
- **Paginação:** por header (`pagina`, `itensPorPagina`).

### Nosso plano (para alinhamento)
Começar em **homologação**, **somente leitura**, **1 filial**, pela **Fase 1**
(produto + estoque + preço — sem dados de cliente/PII). Cliente e vendas entram
na Fase 2, com a base legal LGPD fechada.
