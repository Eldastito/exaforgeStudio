# ADR-109 — UI: abas de Divergência, Estoque negativo e Equipe (Operação da Rede)

**Status:** Implementado (Bloco C). **Origem:** pedidos TOULON (áudio) que tinham
backend + testes mas **nenhuma tela**.

## Contexto

A `RetailOpsView` (ADR-083/084) só expunha **Fechamento** e **Comissão**. Três
capacidades já existentes no backend não tinham superfície:
- **Conferência de divergência** (`RetailReconciliationService`, import CSV do PDV);
- **Estoque negativo** (`RetailInventoryService.listNegative`);
- **Responsáveis por loja** (`RetailResponsibleService`, ADR-108) — sem UI, só via API.

## Decisão

Três abas novas na `RetailOpsView`, consumindo a API já testada:

1. **Divergência** — seletor de mês, cards de resumo (conferidos / divergentes /
   divergência total / total do sistema), tabela informado × sistema × diferença,
   filtro "só divergentes" e **import do CSV** do PDV
   (`POST /reconciliation/import`, `FormData`).
2. **Estoque negativo** — lista de itens com saldo < 0 por loja
   (`GET /stock/negative`); estado vazio celebra "nenhum negativo".
3. **Equipe & cobrança** — seleciona a loja, lista/adiciona/remove **responsáveis**
   (nome, WhatsApp, tipos que cobra: fechamento/malote/escala; vazio = todos),
   fechando o ciclo do Bloco B (ADR-108) que só tinha API.

Frontend puro — sem novo backend. O menu "Operação da Rede" segue gated pelo
add-on `retail`.

## Consequências

**Positivas:** o gestor da TOULON opera divergência, estoque negativo e a equipe
de cobrança pela tela, sem depender de chamadas de API manuais; os responsáveis
criados no Bloco B agora são cadastráveis. **Trade-offs:** a divergência depende
do import CSV até a integração viva da Alterdata (token pendente, ADR-105); a aba
de estoque é read-only (ajuste de saldo continua na API/entrada de estoque).

## Testes

Sem novo teste automatizado (frontend; o backend é coberto por
`test:retail-reconciliation`, `test:retail-stock`, `test:retail-responsibles`).
Build (`vite`+`esbuild`) e typecheck (`tsc --noEmit`) limpos.
