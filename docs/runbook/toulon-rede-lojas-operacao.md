# Runbook — Rede de Lojas (TOULON): acesso do gerente por loja

Decisão de arquitetura + operação para o caso TOULON (rede com guarda-chuva +
lojas). Doc-of-record da decisão tomada em 2026-09 sobre como o gerente enxerga
"só a sua loja".

## Modelo REAL hoje (verificado no código)

- O import do PDV (Alterdata) grava numa **única conta** (a TOULON) com **todas as
  filiais juntas** (`alterdata_integration_settings` por-org, com `filiais_json`),
  cada cliente etiquetado por `filial`. Por isso os ~20 mil clientes do PDV vivem
  **dentro da TOULON**, com filtro de loja — não espalhados por contas de loja.
- A consolidação do grupo (`GroupConsolidationService`, fan-out) puxa hoje só
  **vendas/fechamentos/comissão** — não puxa contatos/CRM.

Ou seja: o sistema opera no modelo **"uma conta TOULON com as lojas como etiqueta
interna (`retail_stores` / `filial`)"**, e NÃO no modelo "cada loja é uma conta
que alimenta a TOULON". (O modelo mental de contas-por-loja existe no seletor de
operação do Grupo, mas não é por onde os dados de cliente entram.)

## Decisão: **Caminho A** — gerente entra na TOULON, travado na sua loja

Motivo (o que funciona pro cliente, sem risco):
- Entrega o resultado que o cliente quer (gerente vê só a sua loja; dono vê tudo)
  **com o dado que já existe**, **sem migração** e **sem risco**.
- O Caminho B (rotear import por conta de loja + migrar ~20 mil clientes +
  histórico + WhatsApp por conta + estender a consolidação) é re-arquitetura de
  semanas com risco alto de migração de dados de produção, para uma pureza que
  **não muda a experiência do cliente**.

## O que já está entregue (código merjado)

- **#1640** — papel `manager` normalizado para `admin` (o gerente passa a valer nos
  gates `requireRole`; a "função de gerente" fina vive no perfil RBAC "Gerente").
- **#1642** — `RetailStoreScopeService`: um **admin ATRIBUÍDO a uma loja fica
  restrito** a ela (dono nunca; sem atribuição segue irrestrito). Escopa PDV,
  estoque, reposição, seletor de lojas.
- **#1643** — **Contatos & CRM** escopado por loja de compra (política inclusiva:
  a loja do gerente + contatos sem loja atribuída; esconde só quem comprou em
  outra loja).
- **#1638** — módulos add-on/verticais no editor de Perfis de Acesso.

## Como ATIVAR (operacional — do dono, no app)

Para cada gerente ver **só a sua loja**, dentro da conta TOULON:

1. O gerente é um **usuário da conta TOULON** (não de uma conta separada) com
   papel `admin` + perfil "Gerente".
2. **Settings → Usuários → atribuir a loja do gerente** (trava de loja,
   `user_stores`). É a atribuição que ativa o escopo dos #1642/#1643.
3. O `código` da loja (`retail_stores.code`) precisa bater com a `filial` dos
   clientes do PDV (senão o filtro do PDV vem vazio).

Sem atribuição, o gerente (admin) vê tudo — default 0-regressão.

## Item ABERTO: ATENDIMENTO (WhatsApp / Kanban) por loja

O que o cliente pediu: "o cliente que chega pelo WhatsApp da loja pertence ao CRM
da loja". Hoje isso **não é escopável de forma limpa**:
- `channels` não tem `store_id`; `tickets` não têm loja; não existe binding
  canal→loja. `retail_stores.whatsapp_identifier` é WhatsApp de SAÍDA (avisos),
  não o canal de entrada do cliente.

Escopar o ATENDIMENTO por loja é uma **fatia própria** (mexe no inbox central —
superfície crítica; fazer às cegas quebra o que funciona). Plano proposto quando
priorizado (opt-in, 0-regressão por default):
1. Binding **canal→loja** (coluna/tabela nova; o dono liga cada número de WhatsApp
   a uma loja em Canais e IA).
2. Escopo dos tickets por esse binding, espelhando o #1643 (inclusivo: a loja do
   gerente + canais sem binding; no-op quando não há binding ou usuário
   irrestrito).
3. UI de binding + teste de regressão.

**Pré-condição a confirmar antes de construir:** os números de WhatsApp das lojas
estão conectados NA conta TOULON (um número por loja) ou em contas separadas? Se
em contas separadas, o ATENDIMENTO já está isolado por conta e nada é preciso.

## Fatias diferidas (só se o cliente quiser o modelo por-conta-de-loja — Caminho B)

- Rotear o import do PDV para cada conta de loja.
- Conectar o WhatsApp por conta de loja.
- Migrar os clientes/histórico da TOULON para as contas de loja.
- Estender `GroupConsolidationService` para puxar contatos/CRM (fan-out).
