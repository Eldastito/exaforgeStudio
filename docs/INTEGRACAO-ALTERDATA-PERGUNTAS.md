# Integração ZappFlow ↔ Alterdata (ModaUp) — perguntas formais

Documento para **encaminhar à Alterdata** antes de iniciar a construção do
conector. Baseado na análise do spec do módulo **Sales** (`APISalesModule`,
OpenAPI 3.0.1, 214 rotas). O objetivo do piloto TOULON é começar com
**sincronização de leitura**, em **homologação**, de 1 módulo, e expandir.

> Sem as respostas de **A (autenticação)** e **B (homologação)** não é possível
> começar a integração com segurança. As demais calibram escopo e arquitetura.

---

## A. Autenticação & credenciais  ⭐ bloqueante
1. As operações exigem `Authorization` (Bearer), mas **não há endpoint de
   login/token no spec**. Como o token é **emitido**? (endpoint, client_id/secret,
   OAuth2 client_credentials, chave fixa?)
2. Qual a **validade** do token e como é a **renovação/refresh**?
3. A credencial é **única** para todos os módulos ou **uma por módulo**
   (12 microserviços = 12 credenciais)?
4. Há **escopos/roles** por credencial (ex.: só leitura)?
5. Como é feito o **provisionamento** da credencial para um cliente específico
   (a TOULON) — e quem autoriza?

## B. Ambientes  ⭐ bloqueante
6. Existe **ambiente de homologação/sandbox** separado de produção? Quais as
   **base URLs** de cada módulo em homologação?
7. Há **dados de teste** em homologação, ou precisamos popular?
8. Quais as **base URLs de produção** confirmadas dos 12 módulos?

## C. Escopo & permissões
9. Para o piloto queremos **somente leitura**. É possível emitir credencial
   **read-only**?
10. Quais módulos a TOULON tem **licenciados/ativos** (nem todo cliente tem os 12)?
11. Há restrição de **filiais** que a credencial enxerga (a API é multi-filial)?

## D. Sincronização & performance
12. Confirmamos o padrão **delta por versão** (`GET .../versao/{version}`):
    ele retorna **tudo que mudou desde a versão informada**? Como obtemos a
    **versão atual** para inicializar o cursor?
13. Quais recursos têm esse endpoint de versão? (vimos em Vendas, Pagamentos,
    Caixa, Recebimento…) — e os que **não** têm, como sincronizamos
    incrementalmente?
14. Há **webhooks/eventos push**, ou a sincronização é **sempre polling**?
15. **Rate limits** (req/min por credencial)? Há penalização por exceder?
16. **Paginação** é por **header** (`pagina`, `itensPorPagina`)? Qual o
    **máximo de itens por página**?
17. **Latência/janela** recomendada de polling (a cada X minutos)?

## E. Modelo de dados (essencial para moda)
18. Onde estão o **cadastro de produto** e a **grade completa**
    (cor/tamanho/**código de barras EAN**/coleção)? (não está no módulo Sales —
    presumimos `ecommerce`/`price`/`supply`.)
19. Qual a **chave** de um produto entre módulos (SKU? `CodigoProduto`?) para
    casarmos com o catálogo do ZappFlow?
20. Onde está o **cadastro de cliente** (CPF, contato) para casar com os
    Contatos/CRM do ZappFlow?
21. Formato de **datas/fuso** e **moeda** nos payloads?

## F. LGPD & contrato
22. Qual a **base legal** e o instrumento contratual para a TOULON (controladora)
    autorizar o compartilhamento dos dados dela (clientes, vendas) com o ZappFlow
    (operador) via API?
23. Há **DPA / cláusula de tratamento de dados** entre Alterdata ↔ ZappFlow, ou
    o vínculo é só TOULON ↔ cada parte?
24. Requisitos de **retenção/expurgo** que devemos respeitar sobre os dados
    sincronizados?

## G. Suporte, versionamento & SLA
25. Há **canal de suporte técnico** da API (e-mail/portal) e **SLA**?
26. Vimos rotas **v1 (176) e v2 (35)**. A v1 tem **data de descontinuação**?
    Devemos priorizar v2 onde existir?
27. Há **changelog/aviso de breaking changes** da API?
28. Podem nos enviar os **specs OpenAPI dos demais módulos** que priorizamos:
    **`ecommerce`, `price`, `supply`, `crm`** (e, depois, `financial`/`receber`)?

---

## Resumo da nossa leitura técnica (módulo Sales) — para validação
- **Auth:** Bearer no header `Authorization` (223/230 operações). Sem endpoint
  de emissão no spec → item A.
- **Sync:** sem webhook; **delta por versão** via `/versao/{version}` (bom para
  polling incremental eficiente).
- **CRUD completo** (POST/PUT/PATCH/DELETE) — leitura e escrita possíveis.
- **Multi-filial**, paginação por header, **v1 + v2**.
- **Cobertura Sales:** vendas + comissão, pagamentos/cartão/recebimento, caixa
  (abrir/fechar), trocas, notas fiscais (XML/DANFE), pré-venda (DAV), frete.
- **Fora do Sales (precisamos dos outros specs):** catálogo, grade, preço,
  estoque, cliente.

## Como pretendemos faseá-la (para alinhamento)
1. **Fase 1 — leitura em homologação:** sync de **Vendas** (delta por versão) →
   dashboards do ZappFlow refletem as vendas reais, sem digitação.
2. **Fase 2:** **produto + estoque + preço** (`ecommerce`/`supply`/`price`) →
   alimenta a vitrine e o atendimento por IA.
3. **Fase 3:** **cliente/CRM** e **pagamentos/conciliação**.
4. **Escrita** (criar venda/pré-venda a partir da loja) só depois de validado.
