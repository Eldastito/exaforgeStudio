# ADR-056 — LgpdService — consentimento, exportação e direito ao esquecimento

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de módulo já em uso + obrigação legal (LGPD, Lei 13.709/2018). Como SaaS multi-tenant que armazena PII de contatos (nome, telefone/e-mail como `identifier`, histórico completo de conversas, pedidos, reservas, agendamentos, memória de IA), a superfície de risco é grande e a resposta a titular tem prazo legal. Sem um serviço central, cada rota reinventaria o fluxo e a auditoria seria impossível.

---

## Contexto

Os dados pessoais estão espalhados por várias tabelas (`contacts`, `messages`, `tickets`, `orders`, `reservations`, `appointments`, além de `memory_facts`/`memory_summary` dentro do próprio contato). A LGPD exige:

- **Base legal explícita** por finalidade (execução de contrato para atendimento; consentimento para marketing/perfilamento).
- **Portabilidade** — devolver os dados do titular em formato legível.
- **Direito ao esquecimento** — sem comprometer registros contábeis/financeiros.
- **Retenção mínima** — não guardar conteúdo além do necessário.
- **Auditoria de consentimento** — quem, quando, em qual versão da política.

Centralizar em `src/server/LgpdService.ts` (chamado por `src/server/routes/lgpd.ts` e pelo `Scheduler`) evita:

- reimplementação em cada rota (risco de esquecer uma tabela);
- inconsistência entre "esquecer" e "exportar" (o que sai tem que casar com o que some);
- perda de registro contábil ao apagar contatos com pedidos pagos.

## Decisão

**Regras invioláveis do `LgpdService`:**

1. **Base legal por consentimento é granular por tipo** — `contact_consents` guarda `consent_type` (`marketing`, `dados_pessoais`, `perfilamento`, `comunicacoes` por padrão, configurável por org via `updateConsentConfig`), `legal_basis`, `policy_version`, `channel`, `actor_id`, `granted_at`/`revoked_at`. Re-grant **revoga o registro anterior e cria um novo** (`grantConsent` faz isso numa transação) — nunca sobrescreve; a trilha histórica é imutável.
2. **Retenção é opt-in por org** — `organization_settings.retention_enabled` + `retention_days` (mín. 30, default 365). `retentionPass()` roda no Scheduler e faz **soft-purge do CONTEÚDO** de `messages` (setando `content = '[removido por política de retenção]'` e `media_url = NULL`) **apenas em tickets já `closed`**. Não apaga a linha — preserva contagem, timestamps e ligação com pedidos.
3. **Exportação (`exportContact`) é somente-leitura** — retorna JSON com contato + tickets + messages + orders + reservations + appointments filtrados por `organization_id AND contact_id`. `reservations`/`appointments` usam try/catch porque a tabela pode não existir em orgs antigas.
4. **Direito ao esquecimento é anonimização, não DELETE** (`forgetContact`):
   - `contacts`: `name='Contato removido'`, `email=NULL`, `profile_pic_url=NULL`, `memory_facts/summary=NULL`, `marketing_opt_out=1`, `anonymized_at=CURRENT_TIMESTAMP`, e `identifier=anon_<prefix>` (estável para não quebrar o índice único por canal);
   - `messages`: `content='[removido a pedido do titular]'`, `media_url=NULL`;
   - `orders`/`reservations`/`appointments` **permanecem intactos** (valor, status, datas) — obrigação fiscal supera direito ao esquecimento nesse ponto (Art. 16, LGPD).
   - Tudo dentro de `db.transaction` — falha parcial não pode deixar contato meio-anonimizado.
5. **Isolamento por tenant** — todo método recebe `orgId` e todo WHERE é `AND organization_id = ?`. A rota extrai o `orgId` do JWT (`req.organizationId`), nunca do body.
6. **Endpoints estáveis** (`/api/lgpd/*`): `GET/PUT /settings`, `GET /contact/:id/export`, `POST /contact/:id/forget`, `GET/PUT /consent-config`, `GET /consent-summary`, `GET/POST /contact/:id/consents`.

## Consequências

**Positivas:**
- Um único ponto para atender solicitação de titular (portabilidade em 1 GET, esquecimento em 1 POST).
- Trilha de consentimento com versão da política — defensável em fiscalização da ANPD.
- Retenção configurável por org (varejo pode querer 365 dias; hotel pode querer 730 para histórico de hóspedes).
- Registros contábeis sobrevivem ao esquecimento sem PII vazando junto.

**Trade-offs aceitos:**
- **Backup ainda contém PII** por até a janela de retenção do provedor (ver `docs/DEPLOY.md`). O esquecimento se propaga em produção, não em snapshots antigos.
- **Retenção "apaga o conteúdo" e não a linha** — a mensagem ainda ocupa espaço com o placeholder. Escolha consciente para preservar contagens de KPI (mensagens/ticket, tempo de primeira resposta).
- **`forgetContact` não invalida sessões nem apaga logs** — o titular deixa de ter PII no banco, mas linhas de `[LGPD]` no log ficam com o `contactId`. Aceitável (ID interno, não PII).
- **Sem DPO configurável no serviço** — o e-mail/endereço do DPO vive em `organization_settings` (banner) e é responsabilidade do onboarding preencher.

## Testes

`scripts/test-lgpd-nps-abandoned.ts` (parte 1, **20 verificações**) cobre:
- config default (4 categorias, versão `1.0`, banner vazio) + update;
- `grantConsent`/`hasConsent`/`getConsentsForContact`/`getConsentSummary`;
- `revokeConsent` (idempotente — retorna `false` se nada foi revogado);
- re-grant preservando histórico (revoga o antigo, insere o novo).

**Gaps conhecidos** (não cobertos por teste automatizado):
- `retentionPass()` — sem teste; risco de regressão silenciosa se alguém mexer no filtro de tickets `closed` ou na janela mínima de 30 dias.
- `exportContact` — sem teste de payload completo nem de isolamento cross-org.
- `forgetContact` — sem teste de que `orders` sobrevive, nem de que `identifier` anonimizado não colide.
- Sem teste da rota (`src/server/routes/lgpd.ts`) — apenas do serviço.

Registrar esses casos em `test-lgpd-service.ts` é ação de follow-up para a Fase 4.
