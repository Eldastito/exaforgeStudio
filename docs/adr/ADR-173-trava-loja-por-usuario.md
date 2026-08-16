# ADR-173 — Trava de loja por usuário (escopo de loja)

**Status:** Implementado (backend + enforcement; UI de atribuição em fatia
seguinte). **Origem:** PRD Moda/TOULON, CRM-002 / AC-04 / AC-18.

## Contexto

O isolamento existia por **organização**, mas não por **loja**: um gerente da
Loja A conseguia consultar a Loja B trocando o filtro/URL. O PRD exige que o
escopo por loja seja imposto **no servidor** (RN nº 4/10), não só na tela.

Não havia modelo de "lojas de um usuário". Decisão de modelo: **`user_stores`
(N:N)** — um usuário pode gerir 1 ou várias lojas (gerente, regional).

## Decisão

Tabela aditiva `user_stores` (org, user_id, store_id) + `RetailStoreScopeService`.

### Regra de resolução (`allowed`)

- **owner/admin** → SEM restrição (vê todas as lojas da org);
- usuário **SEM atribuição** → SEM restrição (opt-in, **retrocompatível** —
  ninguém perde acesso num deploy; a trava só passa a valer quando o admin
  atribui lojas ao usuário);
- usuário **COM atribuição** → restrito ao conjunto atribuído (ids + códigos).

### Enforcement no servidor

Aplicado nos endpoints de leitura com dimensão de loja:

- `GET /stores` → lista filtrada ao escopo.
- `GET /pdv-customers` → loja pedida fora do escopo → **403**; sem loja pedida →
  restringe por `filial IN (códigos permitidos)`; o seletor de lojas também.
- `GET /stock/negative` → loja pedida fora do escopo → **403**; restringe por
  `store_id IN (permitidas)`.
- `GET /replenishment` → mostra reposição só das lojas **necessitadas** que a
  pessoa gere.

Restrição vazia (usuário atribuído a lojas sem código, etc.) → não vaza nada
(`1=0`), nunca "abre" por engano.

### Administração

`GET /store-scope/me` (meu escopo), `GET/PUT /store-scope/:userId`
(owner/admin) para atribuir o conjunto de lojas de um usuário. `setForUser`
valida que a loja pertence à org.

## Consequências

- Cobre AC-04 (gerente restrito a uma loja não vê outra) e AC-18 (trocar
  `store_id`/URL é negado — 403 no servidor).
- Aditivo/retrocompatível: sem atribuição, comportamento inalterado.
- Isolado por organização.

## Fora desta fatia

- **UI de atribuição** (tela de Usuários: marcar as lojas de cada usuário) —
  próxima fatia. Enquanto isso, via `PUT /store-scope/:userId`.
- Enforcement nos demais endpoints de retail que tenham dimensão de loja
  (fechamento, comissão, etc.) — estender no mesmo padrão conforme necessidade.

Teste: `scripts/test-retail-store-scope.ts` (18 checks).
