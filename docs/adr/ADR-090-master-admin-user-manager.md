# ADR-090 — Master Admin: gerenciador de usuários (listar / resetar senha / remover)

**Status:** Implementado.

**Origem:** Cliente real (TOULON, piloto) cadastrou uma conta com email fictício, esqueceu a senha e ficou travado — o fluxo de "esqueci minha senha" depende de o email ser real e receber o link de reset. Sem essa ferramenta, a única saída era SSH na VPS + `sqlite3` + comando `node -e "bcrypt.hash..."`. Isso não é aceitável em produção nem escalável para atendimento a clientes reais.

---

## Contexto

O ZappFlow já tinha o mecanismo de autenticação por e-mail + senha bcrypt (`src/server/routes/auth.ts`) e o master admin (`MASTER_ADMIN_EMAIL`, ADR-054) com acesso à tela `AdminMasterView` que gerencia **organizações**. Faltava a peça equivalente para **usuários**: cross-tenant, com busca, reset de senha e soft delete.

Casos concretos que a ferramenta resolve:
- Cliente esqueceu senha e o email cadastrado é fictício (piloto/teste)
- Provedor de e-mail do cliente está com problema — link de reset não chega
- Suspeita de conta comprometida — master precisa forçar troca de senha
- Cliente pediu para ser desativado (churn manual, LGPD art. 17)

Alternativa considerada: expor apenas via SSH+script. Descartada porque:
- Exige conhecimento de Linux para pessoal de suporte
- Não deixa rastro auditável no app
- Não escala para múltiplos operadores ou terceirização de atendimento

## Decisão

**Três rotas em `POST/GET/DELETE /api/admin/users*` + seção "Usuários" na tela `AdminMasterView`.** Todas protegidas por `requireMasterAdmin` (herda do mount em `server.ts`).

### Rotas

1. **`GET /api/admin/users?q=&limit=&offset=`** — lista usuários com JOIN em `organization_settings` (mostra `org_name`, `org_status`), busca por email/nome/nome_da_empresa (case-insensitive), paginação com teto de 100/página.
2. **`POST /api/admin/users/:id/reset-password`** — recebe `{ password: string }`, hash bcrypt (rounds=10, mesmo custo do `/register`), grava direto em `users.password_hash`, dispara `logAuthEvent("admin_password_reset")` com quem executou e quem foi alvo. Senha mínima: **8 caracteres**.
3. **`DELETE /api/admin/users/:id`** — soft delete: `global_status = 'deleted'`. NÃO apaga a linha (preserva integridade referencial + histórico para auditoria/LGPD). Um usuário 'deleted' não passa mais no login. Dispara `logAuthEvent("admin_user_soft_deleted")`.

### Guards invioláveis

- **Master admin não pode resetar a própria senha aqui** (`cannot_reset_master_admin_here`, 400) — evita auto-lockout se digitar errado. O master usa o fluxo normal de troca de senha em Perfil.
- **Master admin não pode ser removido** (`cannot_delete_master_admin`, 400) — o email do master vem da env, não deve ter estado excluído no DB.
- **Usuário inexistente** → 404 explícito (`user_not_found`) para não confundir com "senha errada".
- **Senha < 8 chars** → 400 explícito (`senha_muito_curta`).

### UI

- Componente `UsersManagementPanel` embutido em `AdminMasterView.tsx` (logo antes de `AuditLogsPanel`).
- Campo de busca com Enter para executar.
- Tabela: email, nome, empresa, papel, status, ações.
- Botão "Redefinir senha" abre inline uma linha com input de senha + confirmar (não modal — mantém foco na lista).
- Botão "Remover" com `confirmDialog` de aviso (danger + soft delete). Removidos aparecem com status "deleted".
- Master admin é listado mas sem botão de remover; reset devolve erro amigável ("Master admin não pode resetar por aqui").

## Consequências

**Positivas:**
- Cliente travado é resolvido em 3 cliques pelo painel, sem SSH.
- Toda ação fica em `auth_events` — auditável, defensável perante ANPD.
- Reusa `bcrypt` (mesma cadência do `/register`), não introduz novo caminho de senha.
- Base clara para expandir no futuro (impersonate, resetar 2FA, ver últimos logins).

**Trade-offs aceitos:**
- **Senha nova aparece em plaintext no request body** — protegida por HTTPS na produção e pela sessão do master admin. Aceitável enquanto o master é o único operador. Se um dia tiver suporte terceirizado, revisitar para "gerar senha temporária e enviar por outro canal".
- **Soft delete não remove PII** (email, nome, telefone). Preserva histórico, mas titular ainda está no banco. Se o titular pedir "esquecimento LGPD", o operador deve executar o `LgpdService.forgetContact` — que é fluxo separado por design (ADR-056).
- **Sem MFA para o master admin ao redefinir senha** — hoje o master só precisa estar logado. Aceitável enquanto o master é o dono; ao adicionar múltiplos operadores, exigir 2FA no `requireMasterAdmin`.
- **Não protege contra insider malicioso do master admin** — se o master for comprometido, ele pode setar qualquer senha em qualquer conta. Mitigação: `auth_events` deixa rastro, e a rotação de `ENCRYPTION_KEY` (ADR-078) invalida sessões antigas.

## Testes

`scripts/test-admin-users.ts` — **20 verificações**:

- **Listagem** (4): status 200, total correto, array com registros, join com `org_name`
- **Busca** (3): case-insensitive por email direto; inclusão via `org.business_name`; sem resultado
- **Reset senha** (4): 200 ok, hash mudou, bcrypt aceita nova senha, bcrypt rejeita senha antiga
- **Guards de reset** (3): senha curta → 400, user inexistente → 404, master admin → 400
- **Soft delete** (4): 200 ok, `global_status='deleted'`, hash e email preservados
- **Guards de delete** (2): inexistente → 404, master admin → 400

Rodado em CI (`admin-users`).
