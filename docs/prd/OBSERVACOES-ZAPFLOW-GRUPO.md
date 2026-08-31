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

### Recomendação
Começar no **A** (por operação) + add-on de grupo (C) para o dashboard consolidado. Isso
mantém a receita ligada ao custo e transforma a F2 (consolidação) no diferencial pago.

### Bloqueio técnico (não ignorar — PRD §11)
O gateway **ASAAS está mockado** (não processa assinatura real — ver ADR-177). Enquanto
isso: **não vender o tier de grupo de forma automatizada**; cobrar contrato multi-operação
**manualmente**. Métrica de proteção: contar orgs ativas por grupo vs. operações
contratadas (evitar "1 login rodando N orgs sem cobrança"). A fatia de billing de grupo
(F3) permanece **bloqueada** até o gateway ser real.

### Ação
- [ ] Comercial define o modelo (A/B/C) e o preço por operação + add-on de grupo.
- [ ] Só então implementar a medição/cobrança (depende do ASAAS real).

---

## 2. CNPJ por loja franqueada — cada loja Toulon é uma franquia (ARQUITETURA — a confirmar)

**Fato novo levantado pelo cliente:** cada loja da **Toulon** é uma **loja franqueada com
CNPJ próprio** (não é filial de um mesmo CNPJ). O mesmo vale, em tese, para redes maiores.

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
