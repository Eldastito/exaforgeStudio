# ADR-098 — Instagram DM (regressão) + Diagnóstico Meta (deletar manual + privacidade)

**Status:** Aprovado (aguardando implementação — item pequeno e independente).

**Origem:** Item #9 do `docs/BACKLOG-CAMPO-TOULON.md`. Dois assuntos: (1) a automação de resposta no Direct do Instagram precisa ser testada/travada; (2) o console de Diagnóstico Webhooks Meta "cresce infinito" e precisa de limpeza. Durante a investigação surgiu um terceiro ponto: o console vaza payload de webhook (com PII de lead) entre tenants.

---

## Contexto

### 1. Instagram DM
- O bug histórico **já foi corrigido**: `MessageProviderService.ts` enviava a resposta ao Direct via `graph.facebook.com`, que rejeita 100% dos envios do produto "Instagram com Instagram Login" em silêncio. Hoje usa o host correto — `https://graph.instagram.com/v21.0/me/messages` com o IG User Token (`MessageProviderService.ts:62`). A assinatura do webhook também já foi ajustada.
- **Risco atual:** não há teste que trave esse caminho. Uma refatoração futura pode reintroduzir o host errado e o cliente volta a nunca receber resposta no Instagram — falha silenciosa, difícil de perceber.

### 2. Diagnóstico Webhooks Meta — crescimento
- O `MetaWebhookLogService` **já auto-purga**: mantém no máximo **500 hits ou 48h** (o que vier primeiro), varrendo a cada ~5 min (`meta_webhook_hits`). No disco não vira lixo eterno.
- **O que falta:** não existe limpeza manual. A rota `metaDebug.ts` só tem `GET /hits` — sem deletar por linha nem "limpar tudo". O incômodo do campo é visual (lista densa), não de disco.

### 3. Privacidade do console (achado novo)
- O console (`GET /api/meta-debug/hits`) exige owner/admin, mas devolve os hits **globais de TODOS os tenants** — a tabela `meta_webhook_hits` **não tem `organization_id`** (é diagnóstico técnico do canal Meta, por design).
- O payload do webhook contém **PII do lead** (nome, texto do DM). Com 2+ clientes, o dono de um enxergaria webhooks de outro. No piloto (1 cliente) não pesa, mas é um vazamento cruzado que precisa fechar antes de escalar.

## Decisão

### 1. Instagram DM — teste de regressão + checklist de campo
- **Teste automatizado** (`test:instagram-send`) que trava o caminho de envio: para `provider='instagram'`, o endpoint DEVE ser `graph.instagram.com/.../me/messages` com body `{ recipient: { id }, message: { text } }` e Bearer do token do canal — mockando o `fetch`, sem chamar a Meta. Se alguém trocar o host de volta, o CI quebra.
- **Checklist de teste de campo** (no ADR, responsabilidade do Emerson): o automatizado garante que o *nosso* código não regride, mas só o teste real prova que a Meta entrega. Passos: (a) app Instagram com webhook verificado (verde); (b) conta subscrita ao evento `messages`; (c) mandar um DM de um número externo; (d) confirmar hit no console + resposta da IA no Direct; (e) checar que não caiu em "Solicitações de mensagens".

### 2. Diagnóstico Meta — deletar manual (mantém auto-purga)
- Mantém a auto-purga (500/48h) como está — é a rede de segurança do disco.
- Adiciona controle manual no console:
  - **Deletar por linha** (`DELETE /api/meta-debug/hits/:id`).
  - **Limpar tudo** (`DELETE /api/meta-debug/hits`).
- UI (`MetaWebhookDiagnostics` em `ChannelsPanel.tsx`): lixeira por linha + botão "Limpar tudo" com confirmação.

### 3. Console restrito a Master Admin
- O acesso deixa de ser owner/admin de qualquer org e passa a ser **somente Master Admin** (`req.user?.email === MASTER_ADMIN_EMAIL`), fechando o vazamento cruzado entre tenants — o diagnóstico é técnico da plataforma, não do lojista.
- Consequência de produto: o dono da loja deixa de ver o console. Aceitável — quem depura webhook Meta é a plataforma (nós), não o lojista. Se um dono precisar do sinal "a Meta está chamando?", isso pode virar um indicador simplificado por-org no futuro (sem payload cru), mas fora do escopo deste item.
- A tabela continua sem `organization_id` (não vale migrar o design de diagnóstico técnico); o isolamento vem de restringir o acesso ao Master Admin.

## Consequências

**Positivas:**
- O caminho de envio do Instagram fica travado contra regressão (o bug mais caro — falha silenciosa — não volta sem o CI avisar).
- O dono limpa o console quando quiser, sem esperar a auto-purga.
- Fecha o vazamento de PII entre tenants com uma mudança mínima (checagem de Master Admin), sem redesenhar a tabela.

**Trade-offs aceitos:**
- Teste automatizado mocka a Meta — não substitui o teste de campo (por isso o checklist). Aceito: é o máximo verificável em CI.
- Restringir a Master Admin remove o console da mão do lojista. Aceito no piloto; se virar demanda, um "sinal de saúde" por-org sem payload resolve depois.
- Deletar manual + auto-purga coexistem sem conflito (a purga só remove o que passou do teto/idade).

## Implementação (item pequeno e independente — não bloqueia nada)

1. `metaDebug.ts`: troca `isAdmin` por checagem de `MASTER_ADMIN_EMAIL`; adiciona `DELETE /hits/:id` e `DELETE /hits`.
2. `MetaWebhookLogService`: `deleteOne(id)` e `clearAll()`.
3. `ChannelsPanel.tsx` (`MetaWebhookDiagnostics`): lixeira por linha + "Limpar tudo" com confirmação; esconder o bloco quando não for Master Admin.
4. `test:instagram-send`: trava host/body do envio Instagram (fetch mockado).
5. Checklist de teste de campo documentado (este ADR).

## Aprovação

Aprovado por Emerson (jul/26): teste de regressão do envio Instagram + checklist de campo; deletar manual (por linha + limpar tudo) mantendo a auto-purga; console restrito a Master Admin (fecha o vazamento entre tenants). Item #9 do backlog marcado `[x] decidido`.
