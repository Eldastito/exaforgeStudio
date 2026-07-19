# Backlog de campo — piloto TOULON

Lista de dúvidas e ajustes levantados quando o ZappFlow entrou em campo com
a TOULON (varejo de moda masculina). Rodamos um item por vez: primeiro
**entender** o que existe, depois **decidir** se ajusta, remove ou implementa.

**Ordem de trabalho:** cada item começa com `[ ] status: aguardando`,
vira `[~] em análise` quando começamos e `[x] fechado` quando resolvido.

---

## 0. Ajuste imediato de UX na tela de Módulos

- **Contexto:** o backend aplica o preset da vertical corretamente
  (`ModuleService.applyVertical`). O visual da tela é que polui: mostra
  todos os 21 módulos, mesmo os que a vertical não recomenda, apenas com
  toggles diferentes.
- **Definido:** o dono da assinatura pode ligar/desligar qualquer módulo
  — ninguém decide isso por ele. O ajuste é **UX**, não escopo.

**Status:** `[ ] aguardando definição de UX final`

---

## 1. Planos, valores e módulos

- Como ficou definido? Quais são os planos ativos, valores, e que módulos
  cada um libera?
- Isso é vendido? Aparece pra o cliente?

**Status:** `[ ] preciso das respostas antes de decidir`

## 2. Distribuição por vertical

- Cada vertical tem suas funcionalidades — como ficou o mapeamento
  vertical → módulos hoje?
- É consistente com o que uma loja de varejo espera?

**Status:** `[ ] preciso das respostas`

## 3. Informações a atualizar/remover

- **Configurações › Planos disponíveis** — está no lugar certo? Faz
  sentido o dono da loja ver isso?
- **Quick-Start** — precisa aparecer pro dono? Ou é ferramenta interna?
- **LGPD** — o dono precisa acessar isso via UI, ou basta a plataforma
  gerar consentimento granular conforme a vertical?

**Status:** `[ ] preciso das respostas`

## 4. Relatórios de vendas — impressão + personalização por vertical

- Não seria importante o dono poder **imprimir** os relatórios?
- Os relatórios deveriam ser **personalizados pela vertical** (ex.:
  varejo mostra ticket médio, ranking de peças; hotelaria mostra
  ocupação, RevPAR)?

**Status:** `[ ] revisitar`

## 5. Hierarquia dentro da conta (RBAC granular)

- Hoje o dono tem acesso completo. Depois dele, todo mundo é igual?
- O dono deveria poder definir **perfis com escopo por módulo**?
  Ex.: **vendedor** (só ver vendas + criar pedidos), **estoquista**
  (só ver estoque + editar quantidades, nunca preço), **gerente** (tudo
  menos financeiro).
- Também: **níveis de operação** por perfil (só ler, ler+escrever, sem
  editar/excluir).

**Status:** `[ ] preciso das respostas`

## 6. Loja virtual — dados do cliente ao acessar

- Cliente já entra na loja **vindo do WhatsApp** — IA já tem nome +
  telefone.
- E-mail pode ser pedido na conversa quando fizer sentido (confirmação
  de pedido, NF-e).
- **Faz sentido pedir esses dados de novo no cadastro da loja?** Ou
  reaproveita o que já tem?

**Status:** `[ ] preciso das respostas`

## 7. Integração Alterdata (Toulon)

- Recebi os links da API da Alterdata.
- Verificar viabilidade antes de conectar (auth, escopo, campos
  disponíveis, latência).

**Status:** `[ ] aguardando janela para análise`

## 8. Backup — rotinas + destino Google Drive + gatilhos

- Ativar backup no **Google Drive do dono** (que já está conectado ao
  ZappFlow para outras integrações — Calendar/Gmail).
- **Gatilhos:**
  - Programado (intervalo de horas/dias configurável).
  - Antes de operações destrutivas (queda de luz, restart não
    planejado, restore).
- Este é o item **MUITO IMPORTANTE**.

**Status:** `[ ] alta prioridade, aguardando escopo`

## 9. Canais / IA / Instagram + limpeza do Diagnóstico Meta

- Automação de resposta no Direct do Instagram — testar
- **Diagnóstico Webhooks Meta:** adicionar botão de **deletar por
  linha** OU rotina de expurgo automático (ex.: manter só últimos 7
  dias / expurgar no backup semanal).
- Sem isso, a lista cresce infinita e vira ruído.

**Status:** `[ ] aguardando escopo de expurgo`

## 10. Loja virtual — ajustes para moda

- Personalizações específicas para o segmento **moda**.
- Detalhar depois.

**Status:** `[ ] parking lot`

## 11. Compras / Fornecedores + pedido por áudio

- Aba "Ser fornecedor": **faltam campos de contato**, não tem botão
  salvar (auto-save?), como limpa pra novo registro?
- Automatizar o contato com fornecedores cadastrados (email/WhatsApp),
  já pensando em **retroalimentação** e **compra coletiva**.
- **Falta aba** "Pedido de compra" onde o dono grava lista via áudio no
  Zap ("compra 20 camisas polo brancas"), IA salva.

**Status:** `[ ] preciso das respostas + escopo`

## 12. Vendas — API de gateway + relatórios com filtro

- Precisamos de API para conectar com meios de pagamento das lojas?
- Relatório de vendas com **filtros** (data, produto, vendedor, canal).

**Status:** `[ ] preciso das respostas`

## 13. Catálogo — provador com avatares custom

- Ao invés do cliente da loja subir foto, permitir escolher entre
  **avatares pré-cadastrados** da loja para provar as peças.
- Fluxo: EU crio os avatares (masculinos, tipos de corpo) → subo pra
  ZappFlow → ficam disponíveis pra vertical **varejo/moda**.

**Status:** `[ ] escopo para depois`

## 14. Import — permitir PDF além de CSV

- Identificar todas as telas com botão "Importar CSV".
- Adicionar opção "Importar PDF" (IA extrai dados estruturados).

**Status:** `[ ] mapear inventário de telas`

## 15. Tarefas — registro por áudio pelo Zapp (gestor)

- Dono/gerente autorizado no modo Zapp manda áudio ("agenda tarefa X
  pra Fulano até sexta") → IA cria a tarefa.
- Orquestrador cobra o responsável por WhatsApp + notificação in-app.
- Editar/confirmar/excluir também via áudio.

**Status:** `[ ] escopo para depois`

## 16. Estúdio de criação — refinar

- Passar depois. Placeholder para não esquecer.

**Status:** `[ ] parking lot`

---

## Método de trabalho

1. Escolho **um item** por vez.
2. Se for pergunta → respondo com o que **existe** hoje (código +
   comportamento) + a decisão que preciso pra evoluir.
3. Se for implementação já decidida → planejamos escopo, faço PR
   focado só nele.
4. Só fecho o item quando você validar.
5. Só depois vamos pro próximo.

Nunca ataco 2 itens em paralelo, pra não perder foco.

**Próximo item:** #1 — planos, valores e módulos.
