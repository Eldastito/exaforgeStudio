# Runbook Go-Live — Integração Alterdata / ModaUp (Toulon)

**PRD:** [PRD-ZF-ALTERDATA-GOLIVE-01](./prd/PRD-ZF-ALTERDATA-GOLIVE-01.md)
**ADR:** [ADR-198](./adr/ADR-198-alterdata-golive-profiles-and-ledger.md)
**Data:** 2026-08-29
**Escopo:** primeira ativação em produção da vertical moda-varejo (Toulon),
consumindo Guardian + Supply + Price + Sales + CRM opt-in.

Este runbook fecha o ciclo dos PRs 1-8 do PRD (isolamento por env, ledger,
gate readiness, promoção LGPD, price-path cache, revenue-bridge audit) com
o procedimento operacional de go-live e o roteiro de rollback.

---

## 0. Pré-requisitos

Antes de iniciar qualquer passo, confirme:

- [ ] Perfil homologação (`environment=homolog`) configurado e validado
      com pelo menos uma filial rodando por 7 dias contínuos sem `failed`
- [ ] Última run de homologação: `runStatus='success'` no ledger
      (consulta: `GET /api/integrations/alterdata/runs?environment=homolog`)
- [ ] `readiness` de homologação = `ready`
      (`GET /api/integrations/alterdata/readiness?environment=homolog`)
- [ ] Backup completo do banco realizado nas últimas 24h
      (rota: `POST /api/admin/backup` — verificar em `list_backups`)
- [ ] Backup externo/off-site também presente (S3 ou similar)
- [ ] Alterdata confirmou:
  - URL de produção (`toulon-{module}.apimodaup.com.br` OU outra)
  - Credenciais Guardian de produção (usuário retaguarda com acesso total)
  - Escopos liberados (Supply, Price, Sales, CRM)
- [ ] Toulon assinou aceite formal do escopo
- [ ] LGPD: aprovação registrada se `pdvCustomerImport=true` for ligado em prod

---

## 1. Configurar perfil de produção

1. Na UI de Integrações → seção Alterdata → dropdown **Ambiente = Produção**
2. Preencher:
   - Rede (mesma da homologação — não deve mudar)
   - Filiais (começar com **1 loja piloto**, expandir depois)
   - Base pattern (URL de PRODUÇÃO, fornecida pela Alterdata)
   - Tabela de preço (a válida em produção)
   - `client_id` / `client_secret` de PRODUÇÃO (nunca reutilizar homolog)
3. Clicar **Salvar**
4. Clicar **Testar conexão** — validar token Guardian emitido
5. Clicar **Testar módulos** — validar Supply/Price/Sales/CRM respondem 200

Confirmar isolamento (PR 2 já garante — este é apenas checagem):
- Token de homolog **não muda**
- Cursor de homolog **não muda**
- Base URL da homolog **não muda**

---

## 2. Registrar aprovação LGPD (se CRM ligado)

Se `pdvCustomerImport` for ligado em produção:

```bash
POST /api/integrations/alterdata/lgpd-approvals
Content-Type: application/json

{
  "purpose": "pdvCustomerImport",
  "legalBasis": "legitimo_interesse",
  "approvedByEmail": "dpo@toulon.com.br",
  "retentionDays": 730,
  "accessProfile": "owner,admin,dpo",
  "notes": "Aprovação ata nº XXX de DD/MM/YYYY"
}
```

Verificar histórico:
`GET /api/integrations/alterdata/lgpd-approvals?purpose=pdvCustomerImport`

---

## 3. Rodar sync manual em produção (piloto)

Antes de ativar scheduler, dispare **1 sync manual** em produção:

```bash
POST /api/integrations/alterdata/sync
```

Resposta esperada: `{ ok, summary, outcome }`. Ler `outcome.severity`:
- `ok` → seguir; anotar `summary.runId` e `summary.correlationId`
- `partial` → **NÃO promover**. Investigar `GET /alterdata/runs/:runId`
  para ver qual resource falhou, `responsible` no readiness
- `failed` → **NÃO promover**. Idem.

Validar números no banco:
```sql
SELECT COUNT(*) FROM products_services WHERE organization_id = ? AND external_ref IS NOT NULL;
SELECT COUNT(*) FROM product_variants WHERE organization_id = ?;
SELECT COUNT(*) FROM retail_daily_closings WHERE organization_id = ? AND source IN ('pdv','integration');
```

Comparar com o volume esperado da loja piloto (fornecido pela Toulon).

---

## 4. Consultar readiness e promover

```bash
GET /api/integrations/alterdata/readiness?environment=prod
```

Blockers residuais (dry-run):
```bash
POST /api/integrations/alterdata/promote?environment=prod&dry=1
```

Se `outcome=promoted` (residuais=0), executar promoção real:
```bash
POST /api/integrations/alterdata/promote?environment=prod
Body: { "note": "Promoção Toulon — go-live 1ª filial" }
```

Grava:
- `alterdata_integration_profiles.validation_status = 'validated'`
- `approved_by = <userId>`, `approved_at = NOW()`
- `ALTERDATA_PROMOTE` no audit log

Confirmar via:
```bash
GET /api/integrations/alterdata/readiness?environment=prod
# status DEVE ser 'ready'
```

---

## 5. Ativar scheduler

Só depois do passo 4 (readiness ready). Na UI:
- Toggle **Ativado** = ON no perfil de produção
- Confirmar `syncIntervalMinutes` (default 15)

O `AlterdataSyncRunner.alterdataSyncPass()` do Scheduler passará a
enfileirar sync a cada intervalo apenas para orgs com `enabled=1`.

Vigiar por **48h** com check-ins a cada 4h:
- `GET /api/integrations/alterdata/runs?environment=prod&limit=10`
- Cada run deve terminar `success` ou `partial_failure` (opcional caiu — ok)
- Zero runs `failed` — se houver, ver §7 (rollback).

---

## 6. Validar receita no Diretor IA / DRE

Se `retail_revenue_bridge` for ligado (RF-15):

```bash
GET /api/integrations/alterdata/revenue-bridge?months=1
```

Confirmar:
- `enabled: true`
- `months[0].bySource.pdv.count > 0` (fechamentos entrando pelo Alterdata)
- `months[0].totalRevenue` bate com o extrato do PDV do mês
- `recentClosings[]` com `source='pdv'` ou `'integration'` visíveis

Comparar com DRE:
```bash
GET /api/financial/dre?period=YYYY-MM
# receita bate com revenue-bridge.months[0].totalRevenue
```

Diretor IA (quando integrado à RevenueBridge audit): a resposta ao gestor
deve mencionar origem "Alterdata (via PDV)" nos cards de receita.

---

## 7. Rollback

Se qualquer coisa dar errado em produção:

### 7.1 Parar imediatamente (sem perda de dados)

1. Na UI → Ambiente=Produção → **Ativado = OFF**
2. Scheduler para de enfileirar automáticamente
3. Sync em andamento termina normalmente (idempotente)

**Efeito:** nenhum dado novo entra; o que já foi ingerido permanece
válido. Homolog continua funcionando (isolamento do PR 2).

### 7.2 Reverter promoção

Se a validação de produção foi prematura:

```sql
UPDATE alterdata_integration_profiles
   SET validation_status = 'failed',
       approved_by = NULL,
       approved_at = NULL,
       last_validated_at = CURRENT_TIMESTAMP
 WHERE organization_id = ? AND environment = 'prod';
```

Readiness volta a status=blocked com blocker `PROD_NOT_VALIDATED`.
Um novo `promote` será necessário depois de investigar.

### 7.3 Limpar cursores de produção

Se o cursor de produção avançou sobre dados errados (raro, mas possível):

```bash
# Via API — só limpa o env corrente (PR 2)
POST /api/integrations/alterdata/settings
Body: { "environment": "prod" }

POST /api/integrations/alterdata/resync
# Isso limpa TODOS os cursores do env corrente E enfileira ressync completo
```

Homolog continua **intocada** (idx v2 garante isolamento).

### 7.4 Restaurar backup (último recurso)

Só use se dados de homologação contaminaram produção OU se um bug do
mapper corrompeu produtos/variantes:

1. Parar scheduler (§7.1)
2. Restaurar backup pré-go-live via `POST /api/admin/backup/restore/:id`
3. Investigar causa raiz no ledger:
   `SELECT * FROM alterdata_sync_run_resources WHERE error_code IS NOT NULL ORDER BY started_at DESC LIMIT 50`
4. Corrigir causa raiz
5. Refazer §3-6 depois de green em homolog por 3+ dias

### 7.5 Revogar credenciais

Se suspeita de vazamento de token de produção:

```sql
UPDATE alterdata_integration_profiles
   SET access_token_enc = NULL,
       token_expires_at = NULL,
       auth_config_enc = NULL
 WHERE organization_id = ? AND environment = 'prod';
```

Solicitar rotação de client_secret ao operador ModaUp; salvar novo em §1.

### 7.6 Rollback total (nunca fazer sem escalar)

**NÃO** fazer nada disso sem escalar pra owner/DPO:

- `DROP` de tabelas Alterdata (perde ledger auditável)
- Delete de aprovações LGPD (ilegal — trilha LGPD é imutável)
- Force-restore ao estado pré-integração (perde ordens/vendas legítimas)

---

## 8. Auditoria pós go-live

Diariamente nos primeiros 30 dias:

```bash
GET /api/integrations/alterdata/runs?environment=prod&limit=100
# Nenhum failed. partial_failure OK se for opcional (CRM, Comissão).

GET /api/integrations/alterdata/revenue-bridge?months=1
# Bate com DRE.

# LGPD:
GET /api/integrations/alterdata/lgpd-approvals
# Aprovações vigentes registradas.
```

Guardar semanalmente snapshot do ledger em backup separado (compliance
LGPD — dados pessoais precisam de trilha de acesso por 5 anos).

---

## 9. Checklists por responsável

### Toulon (cliente)
- [ ] Confirmar filiais que entrarão em prod
- [ ] Confirmar tabela de preço válida
- [ ] Fornecer client_id/client_secret de produção
- [ ] Assinar aceite formal LGPD (se CRM ligado)
- [ ] Validar números do sync piloto (§3)
- [ ] Aprovar promoção (§4)

### Alterdata (fornecedor)
- [ ] Confirmar URL de produção
- [ ] Liberar escopos Guardian (Supply, Price, Sales, CRM)
- [ ] Confirmar suporte 24/7 na 1ª semana

### ZapFlow (nós)
- [ ] Backup pré-go-live (§0)
- [ ] Sync piloto verde (§3)
- [ ] Promoção executada (§4)
- [ ] Scheduler ativo (§5)
- [ ] Auditoria diária dos primeiros 30 dias (§8)
- [ ] Runbook publicado e link no PR
- [ ] Rollback testado em staging

---

## 10. Escalação

- **Falha imediata em produção** → owner ZapFlow (Emerson)
- **Suspeita de vazamento** → DPO Toulon + owner ZapFlow
- **Erro do serviço Alterdata (5xx contínuo)** → suporte Alterdata + owner
- **Falha em migração/backup** → owner ZapFlow + Bill of Rights (nunca perder dados de cliente)

---

_Este runbook fecha o PRD-ZF-ALTERDATA-GOLIVE-01. Referências dos PRs
que o implementam: #1432 (schema), #1433 (isolamento), #1434 (ledger),
#1435 (readiness), #1436 (UI), #1437 (promoção+LGPD), #1438 (price
cache), #1439 (revenue bridge)._
