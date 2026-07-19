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

**Estado atual do código (Claude, jul/26):**
- 3 planos seed: Starter R$99 / Pro R$299 / Business R$799
- **ASAAS NÃO está configurado.** Aparece só como menção em ADR-088. Zero
  integração real. Se for cobrar, precisa implementar gateway do zero.
- Trial hoje: 14 dias em todos os planos.
- Distribuição de módulos por plano: ver tabela na resposta do Claude
  (Starter 9 mods, Pro +8 = 17 mods, Business +2 = 19 mods).

**Decisões consolidadas na conversa Claude + ChatGPT + Emerson (jul/26):**
- **Vamos redesenhar** os planos. Grade candidata do ChatGPT:
  Autônomo R$247 / Start R$597 / Growth R$1.797 / Scale R$4.797 /
  Enterprise a partir de R$8k.
- **Trial:** 30 dias em Autônomo/Start, 21 dias em Growth+ (Claude
  recomenda; 14 dias é curto pra ver valor de ZappFlow).
- **Modelo de receita híbrido:** assinatura base + módulos + consumo
  excedente + unidades + **2% do ganho incremental comprovado**
  (opt-in, painel transparente, cálculo contestável).
- **Performance fee — modo beta (primeiros 6 meses):** calcula e mostra
  no painel, MAS NÃO cobra. Cliente vê e contesta. Só ativa cobrança
  depois de calibrar atribuição. Meta inicial: 15% de margem incremental
  em 3 meses consecutivos.
- **Comissão comercial:** NÃO desenha 30% pra equipe que não existe.
  Se contratar SDR/closer no futuro, aí sim escalonado 30/20/10. Por
  enquanto: 10-15% de indicação por 12 meses pra quem TRAZ cliente
  ativamente (não recomendação passiva).
- **CAC/LTV:** meta LTV/CAC ≥ 4. Payback ≤ 5 meses. Não escalar antes
  disso.
- **Migração automática Autônomo → Start:** proibida. IA
  **recomenda** ao cliente com evidências (crescimento de pedidos,
  contatos, consumo IA), cliente decide. Migração compulsória só em
  violação objetiva (2º usuário, 2ª unidade).
- **Cancelamento inadimplência:** régua D-5 → D+15, com modo
  somente-leitura antes do bloqueio total. Preserva dados, mantém
  cobrança. Legal (LGPD art. 20 permite — execução de contrato ≠
  decisão automatizada nociva).

**Módulos por plano — a redefinir junto com os preços novos.**

**Cobrança:** implementar gateway (ASAAS ou Mercado Pago) é
pré-requisito. Se não cobrar em produção, roda como "cortesia interna"
até fechar TOULON piloto e ter os primeiros CAC/LTV medidos.

**Status:** `[x] decidido — ADR-091 aprovado, aguardando implementação
dos Blocos A/B/C/D`

Ver [`docs/adr/ADR-091-nova-grade-de-planos.md`](adr/ADR-091-nova-grade-de-planos.md)
para a decisão consolidada + roadmap de implementação.

## 2. Distribuição por vertical

- Cada vertical tem suas funcionalidades — como ficou o mapeamento
  vertical → módulos hoje?
- É consistente com o que uma loja de varejo espera?

**Decidido (ADR-092):**
- Modelo **vertical = wishlist, plano = teto**: preset da vertical é a
  lista completa que faz sentido pro negócio; o plano recorta o que o
  cliente vê. `applyVertical` liga a interseção.
- Nova vertical **moda** separada de varejo (Estúdio no preset).
- Presets revisados (varejo sem cadencias, servicos com reservas opt-in).
- Verticais futuras mapeadas (automotivo/pet/beleza/cafe) — dependem do
  Bloco A do ADR-091 (base do Autônomo) antes de virar preset próprio.
- Implementação vinculada ao Bloco A do ADR-091.

Ver [`docs/adr/ADR-092-distribuicao-por-vertical.md`](adr/ADR-092-distribuicao-por-vertical.md).

**Status:** `[x] decidido — aguardando implementação junto do Bloco A`

## 3. Informações a atualizar/remover

- **Configurações › Planos disponíveis** — está no lugar certo? Faz
  sentido o dono da loja ver isso?
- **Quick-Start** — precisa aparecer pro dono? Ou é ferramenta interna?
- **LGPD** — o dono precisa acessar isso via UI, ou basta a plataforma
  gerar consentimento granular conforme a vertical?

**Decidido (ADR-093):**
- **Quick-Start** sai das abas → vira card de onboarding no Dashboard
  que some após uso. Lógica de aplicação preservada.
- **Planos** ficam em "Cobrança e Plano", renomeados p/ grade nova +
  uso vs limite + checkout ASAAS. Cai no Bloco A.
- **LGPD** mantém a aba (obrigatório: lojista é controlador dos dados).
  Melhorias: pré-popular categorias por vertical + modo simples/avançado
  + linguagem menos jurídica.

Ver [`docs/adr/ADR-093-reorganizacao-configuracoes.md`](adr/ADR-093-reorganizacao-configuracoes.md).

**Status:** `[x] decidido — Planos no Bloco A; Quick-Start + LGPD em item
separado pós-Bloco A`

## 4. Relatórios de vendas — impressão + personalização por vertical

- Não seria importante o dono poder **imprimir** os relatórios?
- Os relatórios deveriam ser **personalizados pela vertical** (ex.:
  varejo mostra ticket médio, ranking de peças; hotelaria mostra
  ocupação, RevPAR)?

**Decidido (ADR-094):** PDF com marca da loja (backend, reusa
ReportPdfService), cards personalizados por vertical (varejo/moda →
peça mais vendida + giro; hotelaria → ocupação/RevPAR; saúde → no-show/
retorno; serviços → ticket por serviço), filtros (período/vendedor/
produto/canal). Consolidado com a parte de relatórios do item #12.

Ver [`docs/adr/ADR-094-relatorios-vendas-pdf-vertical-filtros.md`](adr/ADR-094-relatorios-vendas-pdf-vertical-filtros.md).

**Status:** `[x] decidido — aguardando implementação (item independente)`

## 5. Hierarquia dentro da conta (RBAC granular)

- Hoje o dono tem acesso completo. Depois dele, todo mundo é igual?
- O dono deveria poder definir **perfis com escopo por módulo**?
  Ex.: **vendedor** (só ver vendas + criar pedidos), **estoquista**
  (só ver estoque + editar quantidades, nunca preço), **gerente** (tudo
  menos financeiro).
- Também: **níveis de operação** por perfil (só ler, ler+escrever, sem
  editar/excluir).

**Decidido (ADR-095):**
- Nível simplificado: 1 dropdown por módulo com 4 opções (Sem acesso /
  Ver / Operar / Total). "Operar" = criar+editar sem excluir (resolve o
  "grava e lê nunca exclui").
- 6 perfis-template (Dono/Gerente/Vendedor/Estoquista/Financeiro/
  Atendente) + **dono cria perfis customizados do zero**.
- Enforcement: `role_profiles` + `role_permissions`, middleware
  `requirePermission(module, action)` substituindo `requireRole`.
- Prioridade: entra no piloto (TOULON tem equipe), mas em bloco próprio
  pós-Bloco A (é refactor grande, ~4-6 dias).

Ver [`docs/adr/ADR-095-rbac-granular-perfis-customizaveis.md`](adr/ADR-095-rbac-granular-perfis-customizaveis.md).

**Status:** `[x] decidido — bloco próprio pós-Bloco A`

## 6. Loja virtual — dados do cliente ao acessar

- Cliente já entra na loja **vindo do WhatsApp** — IA já tem nome +
  telefone.
- E-mail pode ser pedido na conversa quando fizer sentido (confirmação
  de pedido, NF-e).
- **Faz sentido pedir esses dados de novo no cadastro da loja?** Ou
  reaproveita o que já tem?

**Decidido (ADR-096):**
- Checkout **invisível** pra quem vem do WhatsApp (token `?c=`): só
  "Confirmar pedido" com itens + total, sem formulário.
- E-mail vem da **conversa da IA** (customer_email já capturado, grátis),
  nunca obrigatório na loja.
- **Sem NF-e eletrônica no piloto** — TOULON usa a impressora fiscal dela
  (cupom fiscal). Checkout não pede CPF/CNPJ/endereço. Campo "CPF na
  nota" opcional.
- Fashion Studio mantém cadastro (LGPD do provador), pré-preenchendo do
  contato.

Ver [`docs/adr/ADR-096-loja-checkout-sem-atrito.md`](adr/ADR-096-loja-checkout-sem-atrito.md).

**Status:** `[x] decidido — aguardando implementação (item independente)`

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

**Decidido (ADR-097):**
- Backup **programado diário** de madrugada (~3h), opt-in por org,
  destino **Drive do dono** + espelho, **retenção últimos 30**.
- **Redundância da plataforma** (pilar do Emerson): toda org ativa tem
  cópia **no mínimo semanal na NOSSA infra** (S3/off-site), independente
  do opt-in e da conta Google do cliente. Drive do dono não substitui a
  cópia operacional do operador. Dois destinos, dois donos.
- **Restore** de volta ao banco (multi-tenant seguro, só tabelas do
  tenant) com **backup-guard** automático antes de sobrescrever.
- Gatilhos: backup no boot se vencido (mitiga queda de luz), no `SIGTERM`
  (shutdown gracioso) e antes de restore (backup-guard).
- Pré-requisito operacional: habilitar S3 (ou off-site nosso) — sem isso
  a "redundância" cai no disco local e não é redundância real.

Ver [`docs/adr/ADR-097-backup-automatico-redundancia-restore.md`](adr/ADR-097-backup-automatico-redundancia-restore.md).

**Status:** `[x] decidido — aguardando implementação (item independente,
alta prioridade)`

## 9. Canais / IA / Instagram + limpeza do Diagnóstico Meta

- Automação de resposta no Direct do Instagram — testar
- **Diagnóstico Webhooks Meta:** adicionar botão de **deletar por
  linha** OU rotina de expurgo automático (ex.: manter só últimos 7
  dias / expurgar no backup semanal).
- Sem isso, a lista cresce infinita e vira ruído.

**Decidido (ADR-098):**
- **Instagram DM:** o bug do host (`graph.facebook.com` → `graph.instagram.com`)
  já foi corrigido; adicionar **teste de regressão** (trava o caminho) +
  **checklist de teste de campo** (a entrega real depende de config Meta).
- **Diagnóstico Meta:** a auto-purga (500 hits / 48h) já existe. Adicionar
  **deletar por linha + "Limpar tudo"** mantendo a auto-purga.
- **Privacidade (achado novo):** o console vazava payload (com PII de lead)
  entre tenants — restringir a visão a **Master Admin apenas**.

Ver [`docs/adr/ADR-098-instagram-dm-e-diagnostico-meta.md`](adr/ADR-098-instagram-dm-e-diagnostico-meta.md).

**Status:** `[x] decidido — aguardando implementação (item pequeno e
independente)`

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

**Decidido (ADR-099):**
- **Aba "Ser fornecedor":** adicionar campos de contato (WhatsApp +
  e-mail) + botão Salvar com feedback + texto de clareza (é o perfil da
  rede; fornecedores de quem compro ficam em Contatos). O "novo registro"
  era mismatch de modelo mental, não bug.
- **Cotação automática:** já existe por WhatsApp; adicionar **e-mail**
  como canal paralelo. **Compra coletiva + retroalimentação** aprovadas
  como direção, mas em **bloco próprio depois** (feature de rede madura).
- **Pedido por áudio:** gestor manda áudio no Zap → transcreve (Whisper
  já existe) → IA extrai itens → cria **pedido manual** (draft) →
  confirma. Destrava também o "criar pedido manual" (hoje só automático).

Ver [`docs/adr/ADR-099-compras-fornecedores-contato-e-pedido-por-audio.md`](adr/ADR-099-compras-fornecedores-contato-e-pedido-por-audio.md).

**Status:** `[x] decidido — bloco imediato (contato+e-mail+áudio) +
bloco futuro (compra coletiva/retroalimentação)`

## 12. Vendas — API de gateway + relatórios com filtro

- Precisamos de API para conectar com meios de pagamento das lojas?
- Relatório de vendas com **filtros** (data, produto, vendedor, canal).

**Parcial:** a parte de **relatório com filtros** foi consolidada no
item #4 (ADR-094) — decidida e aguardando implementação.

**Decidido (ADR-100) — parte de pagamento:**
- Adquirente do piloto = **Stone (via Pagar.me)**. Já existe base plugável
  (`PaymentService`: `pix_manual` + `mercadopago`); Stone entra como mais
  um provider.
- **Fase 1 (imediata):** cartão na loja virtual via **Link de Pagamento**
  Pagar.me (cartão+PIX+boleto hospedado, webhook confirma, PCI mínimo) —
  destrava venda com cartão.
- **Fase 2 (opcional):** checkout transparente (cartão dentro da loja).
- **Fase 3:** maquininha presencial via **Connect Pagar.me** — conciliação
  primeiro (canal PDV nos relatórios), acionar a maquininha depois
  (integração certificada + comercial Stone).

Ver [`docs/adr/ADR-100-pagamento-lojista-stone-pagarme.md`](adr/ADR-100-pagamento-lojista-stone-pagarme.md).

**Status:** `[x] decidido — relatórios (ADR-094) + pagamento Stone/Pagar.me
(ADR-100), aguardando implementação faseada`

## 13. Catálogo — provador com avatares custom

- Ao invés do cliente da loja subir foto, permitir escolher entre
  **avatares pré-cadastrados** da loja para provar as peças.
- Fluxo: EU crio os avatares (masculinos, tipos de corpo) → subo pra
  ZappFlow → ficam disponíveis pra vertical **varejo/moda**.

**Status:** `[ ] escopo para depois`

## 14. Import — permitir PDF além de CSV

- Identificar todas as telas com botão "Importar CSV".
- Adicionar opção "Importar PDF" (IA extrai dados estruturados).

**Decidido (ADR-101):**
- Inventário: 3 telas importam CSV hoje — **Catálogo (produtos),
  Prospecção (contas), Reservas (recursos)**. (Contatos/Vendas/Agenda só
  exportam.)
- Extração por IA **já existe** (`extractPdfText`, `analyzePdfForChat`,
  GPT-4o multimodal) — falta só ligar num botão de import.
- Adicionar "Importar PDF/imagem" nas **3 telas de uma vez**, mecanismo
  reusável (`SmartImportService`), **preview obrigatório** (IA extrai →
  revisa → salva, reusando o backend do CSV), aceitando **PDF + imagem**.

Ver [`docs/adr/ADR-101-importar-pdf-imagem-por-ia.md`](adr/ADR-101-importar-pdf-imagem-por-ia.md).

**Status:** `[x] decidido — aguardando implementação (item independente)`

## 15. Tarefas — registro por áudio pelo Zapp (gestor)

- Dono/gerente autorizado no modo Zapp manda áudio ("agenda tarefa X
  pra Fulano até sexta") → IA cria a tarefa.
- Orquestrador cobra o responsável por WhatsApp + notificação in-app.
- Editar/confirmar/excluir também via áudio.

**Status:** `[ ] escopo para depois`

## 16. Estúdio de criação — refinar

- Passar depois. Placeholder para não esquecer.

**Status:** `[ ] parking lot`

## 17. Skills externas: 2ª opinião (OpenAI) + geração de mídia (Gemini)

- **2ª opinião OpenAI:** skill que quando invocada envia contexto atual
  pra OpenAI API e traz "opinião B" pra discutir em plural aqui. Não é
  ChatGPT me auditando em tempo real (impossível hoje), é consultor
  invocável sob demanda.
- **Geração Gemini (imagem/vídeo):** skill que expõe Gemini pra criar
  arte direto na conversa. Gemini já roda no ZappFlow (Fashion TryOn),
  reusa a chave.
- Requer: `OPENAI_API_KEY` (já configurada) e `GEMINI_API_KEY` (já).

**Status:** `[ ] fazer só depois de fechar backlog crítico do TOULON
(sem prioridade urgente)`

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
