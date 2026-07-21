# ADR-106 — Master Admin (plataforma) × Admin de organização (cliente)

**Status:** Aprovado. Decisão de governança para o go-live da TOULON + hardening
do gating de menu.

**Origem:** Antes de colocar a plataforma pra rodar com a TOULON, é preciso
cravar a distinção entre o **operador da plataforma** (ZappFlow) e o **admin do
cliente** (TOULON) — o cliente administra o próprio negócio e vê **só os dados
dele**, nunca a plataforma inteira.

---

## Contexto (como o modelo funciona hoje)

- **Master Admin** = **um único e-mail global** (`MASTER_ADMIN_EMAIL`, env; default
  de dev `eldastito@gmail.com`). É **cross-tenant** e **contorna TODO o RBAC**:
  `requirePermission` e `enforceModulePermission` dão `next()` direto quando
  `req.user.email === MASTER_ADMIN_EMAIL`. Vê e faz tudo, em **todas** as orgs.
  **Não existe "Master Admin por organização"** — Master é da plataforma.
- **Admin da organização (owner/dono)** = usuário comum, **isolado por
  `organization_id`** em toda query, com acesso total aos módulos da **própria**
  org via RBAC (ADR-095). Nunca enxerga outra org nem a plataforma.
- **Contas vinculadas** (vendedor/estoquista/gerente) = ainda mais restritas por
  perfil RBAC, sempre dentro da org.

## Decisão

1. **A conta da TOULON (`eldastito@toulon.com`) é OWNER da org TOULON — NUNCA
   Master Admin.** Fazer um cliente virar Master Admin daria a ele acesso a
   **todos os outros clientes** + controles de plataforma (cobrança de todos,
   gestão de usuários de qualquer org, console Meta cross-tenant). Risco alto e
   desnecessário: o papel de owner já entrega "admin do próprio negócio, só com
   os dados dele".
   - Como `eldastito@toulon.com` ≠ `MASTER_ADMIN_EMAIL`, a distinção **já vale
     hoje** — a conta entra isolada por tenant automaticamente.
   - ⚠️ **Go-live:** garantir que o dono da TOULON seja `eldastito@toulon.com` e
     **NÃO** `eldastito@gmail.com` (este é o master default — cadastrar a TOULON
     com ele a tornaria master admin sem querer).

2. **Superfície só-plataforma, escondida do admin do cliente** (já bloqueada no
   servidor por `requireMasterAdmin`; o menu esconde no front):
   - **Admin Master** (gerir todas as orgs, planos/cobrança de todos os
     clientes, reset/remoção de usuários de qualquer org, ativação de contas).
   - **Radar — Consultor** (visão de plataforma, cross-tenant).
   - **Console de Diagnóstico Meta** (cross-tenant; já teve vazamento de PII —
     ADR-098).

3. **Hardening (este ADR):** o front escondia essa superfície comparando o
   e-mail **hardcoded** `'eldastito@gmail.com'` em 3 lugares (`Sidebar`,
   `ChannelsPanel`, item do Radar Consultor). Trocado por um **flag
   `isMasterAdmin` vindo do servidor** (`GET /api/permissions/me`), fonte única
   de verdade que **segue o `MASTER_ADMIN_EMAIL` configurado**. O servidor
   **continua** reforçando via `requireMasterAdmin` — o flag é só coerência de
   menu, defesa em profundidade.

## Funcionalidades da vertical MODA (o que a TOULON usa)

Preset `moda` (`verticals.ts`) = **`catalogo, vendas, loja, pagamentos,
campanhas, integracoes, estudio, diretor, rie, execucao`** — é o `varejo` **+
`estudio`**. Em linguagem de negócio:

| Módulo | Para a TOULON |
|---|---|
| catalogo | Catálogo/estoque (produtos, grade, EAN, cadastro por foto no WhatsApp) |
| vendas | Vendas + relatórios + comissão |
| loja | Loja Virtual (vitrine, checkout, vitrinista IA/lookbook) |
| estudio | Estúdio / Fashion AI Studio (provador + geração de looks) |
| pagamentos | Pagamento (link Stone) |
| campanhas | Campanhas de marketing |
| integracoes | Integrações (Google; Alterdata na Fase 2) |
| diretor / rie / execucao | Camada de IA/gestão (Diretor honesto, Radar de Execução, execução) |

Sempre ligados fora do preset: atendimento IA por WhatsApp, Contatos/CRM,
Configurações, Canais. **O plano é o teto** (ADR-092): a TOULON vê a interseção
`moda ∩ plano`.

## Consequências

**Positivas:** distinção plataforma × cliente cravada e documentada para o
go-live; gating de menu deixa de depender de e-mail hardcoded e passa a seguir a
config; isolamento multi-tenant (server) inalterado e já testado
(`test:isolation`, `test:rbac-enforcement`).

**Trade-offs:** o flag `isMasterAdmin` é cosmético (menu) — a segurança real
continua 100% no servidor (`requireMasterAdmin` + `organization_id` em toda
query). Se algum dia for preciso mais de um operador de plataforma, será um
follow-up (hoje `MASTER_ADMIN_EMAIL` é único e global).
