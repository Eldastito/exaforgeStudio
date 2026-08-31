# Observações em aberto — ZapFlow Grupo (ADR-199)

Itens que **dependem de decisão de produto/comercial ou de dados de terceiros** — não são
bugs, são questões a resolver antes de "ligar" a flag `FEATURE_ORG_GROUPS` em produção
para clientes reais. Registrado a pedido (Emerson, 2026-08-31).

---

## 1. Modelo de cobrança / planos para grupo (COMERCIAL — pendente)

Hoje o ZapFlow cobra **1 cliente = 1 org = 1 assinatura**. Com grupo, **1 login = N orgs**,
e cada org é um tenant completo (WhatsApp + ERP + fiscal + plano próprios). A cobrança
precisa **medir N operações**, não uma. Precisamos definir COMO cobrar.

### Opções de modelo (a decidir com o comercial)
- **A) Por operação (recomendado):** cada org do grupo continua com seu próprio plano/
  assinatura (o que o §12 do PRD chama de "escala linear de custo"). O grupo é só a
  camada de login + consolidação. Vantagem: alinha receita ao custo real (cada op = 1
  instância Evolution + 1 conexão ERP + 1 perfil fiscal). Simples de justificar.
- **B) Tier de grupo (bundle):** um preço de "rede" que inclui N operações + a visão
  consolidada (F2) como valor agregado. Bom para vender redes (3+ franquias), mas precisa
  de um teto de operações por tier e de um add-on por operação extra.
- **C) Híbrido:** plano-base por operação + add-on "Consolidação de Grupo" cobrado uma vez
  no grupo (destrava o dashboard F2 e o provisionamento self-service da F1).

### Recomendação (DECIDIDA no desenho — números ficam com o comercial)
**NÃO é um produto novo — é o modelo atual (assinatura por operação) ajustado + 1 add-on
de grupo.** Grounding no código: os planos já são por-org (`organization_settings.plan_id`
+ `billing_status`; grade Autônomo R$247 · Start R$597 · Growth R$1.797 · Scale R$4.797 ·
Enterprise R$8.000 em `plansGrade.ts`), e bundles já são "plano + add-ons com desconto".
Reaproveita-se tudo isso. O grupo é camada de relacionamento/cobrança, não tenant novo.

Três peças (encaixam no que existe):
1. **Assinatura por operação (reuso 100%)** — cada CNPJ/loja mantém seu `plan_id`
   conforme o tamanho dela. Alinha receita ao custo real (cada CNPJ = 1 instância WhatsApp
   + 1 conexão ERP + 1 perfil fiscal — o custo escala por CNPJ, não por marca).
2. **Faixa de desconto por VOLUME ("rede/franquia")** — preço por operação cai conforme a
   contagem de CNPJs ativos no grupo. É AJUSTE de preço sobre o plano (mesma mecânica do
   desconto de bundle), não um SKU novo. Estrutura sugerida (percentuais = decisão do
   comercial): 1–2 ops preço cheio · 3–5 ops −X% · 6+ ops −Y%.
3. **Add-on "Grupo/Consolidação" (uma vez por grupo)** — monetiza o valor específico do
   grupo: login único + switch + provisionamento (F1) + dashboard consolidado (F2). Reusa
   o `AddonService`.
Opcional: **fatura consolidada** (somar as N assinaturas do grupo numa cobrança só) — é
read-model, não produto novo.

**Por que não um "tier de grupo" fechado (opção B):** engessa — cliente com 3 CNPJs pagaria
igual ao com 12, ou vira dezenas de tiers. O modelo por-operação + volume + add-on escala
sozinho com qualquer combinação de CNPJs/marcas.

### O que dá pra construir JÁ (sem o gateway real)
A **medição/prévia de fatura** do grupo: `GroupBillingService` (read-model determinístico)
que conta operações ativas por grupo → aplica a faixa de volume → soma os `plan_id` de cada
org (grade) + o add-on de grupo → devolve a prévia (por operação + total). Testável, sem
ASAAS. A COBRANÇA real (emitir no gateway) espera o ASAAS deixar de ser mockado.

### Bloqueio técnico (não ignorar — PRD §11)
O gateway **ASAAS está mockado** (não processa assinatura real — ver ADR-177). Enquanto
isso: **não vender o tier de grupo de forma automatizada**; cobrar contrato multi-operação
**manualmente**. Métrica de proteção: contar orgs ativas por grupo vs. operações
contratadas (evitar "1 login rodando N orgs sem cobrança"). A fatia de billing de grupo
(F3) permanece **bloqueada** até o gateway ser real.

### Ação
- [ ] Comercial define os NÚMEROS: % de desconto por faixa de volume + preço do add-on de grupo.
- [x] Modelo desenhado: por-operação + volume + add-on (não é produto novo).
- [ ] Construir `GroupBillingService` (prévia de fatura — determinístico, sem gateway).
- [ ] Cobrança real: depende do ASAAS deixar de ser mockado.

---

## 2. CNPJ por loja franqueada — cada loja é uma org (ARQUITETURA — CONFIRMADO)

**Confirmado pelo cliente (2026-08-31):** **cada loja é um CNPJ**, várias lojas por marca.
Ex.: Toulon → loja Carioca (CNPJ 1) · Avenida Brasil (CNPJ 2) · Grande Rio (CNPJ 3) · …;
Democrata → outra marca, outro(s) CNPJ(s). A hierarquia real é de **3 níveis**:

> **Grupo (dono/identidade) → Marca (Toulon/Democrata) → Operação/Loja (1 CNPJ = 1 org)**

O modelo do PRD tratava "marca = org". O correto é **operação (CNPJ) = org**; a marca é um
AGRUPAMENTO de operações dentro do grupo.

### Por que isso importa
A fronteira de tenant do ZapFlow (`organization_id`) é também a **fronteira fiscal** — cada
org tem seu perfil fiscal/ERP. O sistema tem DOIS conceitos de "loja":
- **org** (tenant) = 1 CNPJ = fiscal/ERP/WhatsApp/plano próprios.
- **`retail_stores`** (multi-loja DENTRO de uma org) = várias lojas sob **o MESMO CNPJ**
  (filiais), compartilhando catálogo/fiscal/estoque da org.

O modelo do PRD assumiu "Toulon" e "Democrata" como **2 orgs = 2 marcas**. Mas se cada
**loja** Toulon tem **CNPJ próprio**, então **cada loja franqueada é uma org distinta** —
o grupo do franqueado não é "2 marcas", é "N operações" (uma por CNPJ), possivelmente
agrupadas por marca.

### O que isso NÃO quebra
- A arquitetura da Fase 0 já suporta: um login → N orgs, cada uma isolada, alternando com
  `switch-org`. Provisionar N operações (F1) é o mesmo fluxo repetido.
- A **consolidação por fan-out (F2)** é EXATAMENTE o que uma rede de N CNPJs precisa: soma
  as operações mantendo cada CNPJ isolado. Ela já foi construída pensando em N operações.

### O que precisa ser DECIDIDO (antes da F1b — WhatsApp/ERP por CNPJ)
- **Confirmar a estrutura real do cliente:** a "Toulon" do cliente é UMA loja (1 CNPJ) ou
  VÁRIAS lojas franqueadas (N CNPJs)? Idem Democrata. Isso define quantas orgs provisionar.
- **Agrupamento por marca dentro do grupo:** se o franqueado tem 5 CNPJs Toulon + 3
  Democrata, faz sentido um nível de "sub-grupo por marca" para o filtro do dashboard
  (hoje o filtro é por operação/org; agrupar por marca é uma extensão simples e aditiva).
- **WhatsApp/ERP por CNPJ (F1b):** cada org (CNPJ) precisa de sua própria conexão
  Evolution + perfil fiscal/Alterdata. Isso é **1 conexão por CNPJ** — o custo escala com o
  número de CNPJs, não de marcas. O wizard da F1 precisa coletar/conectar essas credenciais
  por operação (só "liga" quando o cliente entregar os dados de cada CNPJ).

### Recomendação
Manter **org = CNPJ** (não forçar franquias de CNPJs distintos dentro de uma org via
`retail_stores` — isso violaria o isolamento fiscal). Confirmar a contagem real de CNPJs do
cliente antes de dimensionar F1b e o custo de infra (instâncias Evolution — PRD §12/§14).

### Ação
- [ ] Cliente/produto confirma: quantos CNPJs por marca o franqueado opera.
- [ ] Decidir se o grupo ganha um nível "marca" (sub-agrupamento) para o dashboard F2.
- [ ] F1b: wizard coleta credencial WhatsApp + ERP/fiscal **por CNPJ** (depende dos dados
      reais de cada operação — não há como automatizar/testar sem eles).

---

## Status das fatias (referência)

| Fatia | Estado |
| --- | --- |
| ADR-199 · F0a · F0b · F0c-1 · F0c-2 · F1 · F2 | ✅ em produção (atrás da flag) |
| F1b — WhatsApp/ERP por CNPJ | ⏳ observação #2 (depende de credencial real por CNPJ) |
| F3 — billing de grupo | ⛔ observação #1 (bloqueado pelo ASAAS mockado) |
