# ADR-095 — RBAC granular: perfis customizáveis com nível de acesso por módulo

**Status:** Aprovado (aguardando implementação).

**Origem:** Item #5 do `docs/BACKLOG-CAMPO-TOULON.md`. Hoje só existem 3 papéis fixos (owner/admin/agent) com gating binário por rota. O dono da TOULON (e qualquer loja com equipe — mín. 2 colaboradores por turno) precisa de perfis por função: vendedor vê vendas mas não financeiro, estoquista mexe em quantidade mas não em preço, "grava e lê mas nunca exclui".

---

## Contexto

Estado atual:
- 3 papéis fixos globais: `owner`, `admin`, `agent` (coluna `users.role`).
- Gating por rota via `requireRole("owner","admin")` — binário, sem escopo por módulo nem nível de operação.
- Não há como o dono criar um perfil "Caixa" ou "Estoquista" com acesso próprio.

Demanda real do piloto: lojas têm equipe com funções distintas. O dono quer definir quem vê o quê e quem pode fazer o quê, incluindo o nível "pode criar e editar mas não excluir".

## Decisão

### 1. Nível de acesso por módulo (simplificado — 1 dropdown)

Em vez de 4 checkboxes independentes por módulo (ler/criar/editar/excluir = combinatória confusa), cada módulo tem **um único nível** escolhido num dropdown:

| Nível | Código | Permite |
|---|---|---|
| Sem acesso | `none` | Módulo oculto no menu; rotas retornam 403/404 |
| Ver | `read` | Somente leitura (GET) |
| Operar | `write` | Ver + criar + editar (GET/POST/PUT) — **não exclui** |
| Total | `full` | Tudo, incluindo excluir (GET/POST/PUT/DELETE) |

Isso cobre o caso "grava e lê, nunca exclui" = `write`. Simples de entender e configurar.

### 2. Perfis customizáveis (templates + criação do zero)

- Roles deixam de ser 3 fixos globais e passam a ser **perfis por organização**, cada um com um mapa `módulo → nível`.
- **6 templates semeados** (ponto de partida editável):

| Perfil | Escopo padrão (nível por módulo) |
|---|---|
| **Dono** (owner) | Tudo em `full` — imutável, sempre existe, não pode ser rebaixado |
| **Gerente** | Quase tudo em `full`, exceto Cobrança/Config sensível em `read` |
| **Vendedor** | Vendas `write`, Catálogo `read`, Atendimento `write`, Contatos `write`, resto `none` |
| **Estoquista** | Catálogo `write`, Compras `write`, resto `none`. Financeiro/Vendas ocultos |
| **Financeiro** | Vendas `read`, Pagamentos `full`, Relatórios `read`, resto `none` |
| **Atendente** | Atendimento `write`, Contatos `write`, resto `none` (equivale ao agent atual) |

- **Botão "Criar perfil"**: o dono monta um perfil do zero (nome + nível por módulo). Ex.: "Caixa" com Vendas `write` + Pagamentos `write` + resto `none`.
- **Editar template**: o dono ajusta qualquer template pra sua realidade (não é imutável, exceto Dono).

### 3. Enforcement

- Nova tabela `role_profiles` (id, organization_id, name, is_system, created_at).
- Nova tabela `role_permissions` (role_profile_id, module, level).
- `users.role` passa a referenciar um `role_profiles.id` (com migração dos 3 papéis atuais para os templates equivalentes: owner→Dono, admin→Gerente, agent→Atendente).
- Middleware evolui de `requireRole(...)` para `requirePermission(module, action)` que consulta o nível do perfil do usuário:
  - `action=read` exige nível ≥ `read`
  - `action=write` (POST/PUT) exige nível ≥ `write`
  - `action=delete` exige nível `full`
- Frontend esconde do menu o que está em `none` e desabilita botões de excluir quando nível < `full`.

## Consequências

**Positivas:**
- Dono controla acesso por função sem depender de dev.
- Cobre o caso "lê e grava, não exclui" com um único conceito simples.
- Templates aceleram (dono aplica "Vendedor" e ajusta), customização dá poder.
- Migração dos 3 papéis atuais é direta (mapeamento 1:1 pros templates).

**Trade-offs aceitos:**
- É um refactor **grande**: toca todas as rotas protegidas (trocar `requireRole` por `requirePermission`), migra o schema de roles, e cria a tela de editor de perfis. Estimativa: 4-6 dias.
- Um nível único por módulo é menos flexível que 4 flags (ex.: não dá "pode excluir mas não editar" — combinação rara e sem valor prático). Aceito pela simplicidade.
- O "Dono" precisa ser imutável (não pode se auto-rebaixar e travar a conta) — regra especial no enforcement.
- Perfis por org multiplicam linhas em `role_permissions` (nº perfis × nº módulos), mas o volume é pequeno (dezenas por org).

## Prioridade

Confirmado relevante para o piloto: TOULON tem no mínimo 2 colaboradores por turno por loja, com funções distintas (vendedor, caixa, estoquista). Sem RBAC granular, ou todo mundo é "atendente" (limitado) ou "gerente" (vê demais). Portanto **entra no piloto**, mas por ser refactor grande, vai em bloco próprio depois do Bloco A do ADR-091 (não misturar com a migração de planos pra não acumular risco num PR só).

## Implementação (bloco próprio, pós-Bloco A)

1. Schema: `role_profiles` + `role_permissions` + migração dos 3 papéis atuais
2. `PermissionService`: resolve nível do usuário por módulo, com cache
3. Middleware `requirePermission(module, action)` substituindo `requireRole`
4. Migração incremental das rotas (módulo por módulo, sem big-bang)
5. Tela `Configurações → Usuários e Permissões`: editor de perfis (dropdown nível por módulo) + criar/duplicar/excluir perfil
6. Frontend: menu + botões respeitam o nível
7. Teste: `test:rbac-granular` — cada template acessa só o que deve; "write" não exclui; Dono imutável; perfil custom funciona

## Aprovação

Aprovado por Emerson (jul/26): simplificar níveis (1 dropdown por módulo com 4 opções), 6 templates + criação de perfis customizados pelo dono, prioridade no piloto (bloco próprio). Item #5 do backlog marcado `[x] decidido`.
