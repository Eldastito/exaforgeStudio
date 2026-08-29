# ADR-198 — Alterdata Go-Live: perfis por ambiente + ledger de execuções + política de módulos

**Status:** Aceito (PR 1 do PRD-ZF-ALTERDATA-GOLIVE-01)
**Data:** 2026-08-29
**Autor:** IA Dev
**PRD:** [PRD-ZF-ALTERDATA-GOLIVE-01](../prd/PRD-ZF-ALTERDATA-GOLIVE-01.md)
**Substitui/complementa:** ADR-105 (integração base Alterdata/ModaUp)

## 1. Contexto

O conector Alterdata atual (ADR-105) tem 1 linha por org em
`alterdata_integration_settings` com uma coluna `environment` que **não
determina URLs, credenciais nem cursores**. Consequência prática (RF-01
a RF-03 do PRD):

- O `AlterdataSyncService` resolve URLs a partir de `base_pattern`
  guardado UMA VEZ na linha da org — trocar `environment` no dropdown
  não muda pra onde o request vai.
- `access_token_enc` é UM único token por org — homolog e prod
  compartilhariam a mesma coluna.
- `alterdata_sync_cursors` tem chave `(org, module, resource, filial)` —
  sem `environment`. Um cursor que avançou pra versão 9.000 em homolog
  seria lido pra prod na próxima chamada.
- Erros silenciosos (`catch {}` em Price/Sales/CRM) fazem `sync` reportar
  "sucesso" mesmo com módulos quebrados.

Além disso, **não existe ledger de execução**: cada run é `console.log`
+ um `summary` in-memory retornado pelo runner. Impossível auditar
histórico, diagnosticar falha, ou provar pro cliente qual dado veio de
onde.

E **não existe política formal por módulo**: o runner tenta rodar tudo
que a org tem configurado, sem saber que Supply é obrigatório e CRM é
condicional. Um go-live não pode ter status verde se o obrigatório
falhou; um module `unsupported` (HR, Logistic, etc.) não pode receber
selo verde só porque teve HTTP 200.

Este ADR estabelece a fundação schema/dados. **Não** migra código
(runner/connector) — isso vem no PR 2 do PRD (RF-01/02/03) e PR 3 (RF-08).

## 2. Decisão

### 2.1 Perfis por ambiente (RF-01)

Nova tabela `alterdata_integration_profiles`, PK composta
`(organization_id, environment)`. Cada perfil independente:

```sql
CREATE TABLE alterdata_integration_profiles (
  organization_id TEXT NOT NULL,
  environment TEXT NOT NULL,            -- 'homolog' | 'prod'
  base_pattern TEXT,                    -- ex.: 'toulon-{module}.apimodaup.com.br'
  module_base_urls_json TEXT,           -- override por módulo, opcional
  auth_config_enc TEXT,                 -- CIFRADO por env (nunca compartilhado)
  access_token_enc TEXT,                -- CIFRADO por env
  token_expires_at DATETIME,
  scopes_json TEXT,                     -- scopes do Guardian confirmados
  rede TEXT,
  filiais_json TEXT,
  price_table TEXT,
  validation_status TEXT DEFAULT 'unvalidated', -- 'unvalidated' | 'validated' | 'failed'
  last_validated_at DATETIME,
  approved_by TEXT,                     -- user_id de quem promoveu (só prod)
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, environment)
);
```

**Compatibilidade:** `alterdata_integration_settings` (legado) permanece.
Backfill trivial no PR 2: cada linha existente vira um profile `homolog`.
Fachada de leitura no `AlterdataConnectorService` prefere `profiles` e
cai no `settings` quando não achou (0-regressão até o PR 2 completar a
migração).

### 2.2 Cursor por ambiente (RF-03)

Adicionar coluna `environment` na tabela `alterdata_sync_cursors`
(ALTER TABLE + DEFAULT 'homolog' pra backfill implícito) e criar nova
chave única incluindo `environment`:

```sql
ALTER TABLE alterdata_sync_cursors ADD COLUMN environment TEXT DEFAULT 'homolog';
CREATE UNIQUE INDEX idx_alterdata_cursor_uniq_v2
  ON alterdata_sync_cursors(organization_id, environment, module, resource, filial);
```

**Compatibilidade:** o índice antigo `idx_alterdata_cursor_uniq` é
**dropado neste PR** porque violaria a inserção da mesma tripla
`(module, resource, filial)` em ambientes diferentes — que é o problema
exato que este PR resolve. Zero perda: o índice v2 cobre tudo que o
antigo cobria + `environment`. Código antigo que insere sem
`environment` usa `DEFAULT 'homolog'` e continua respeitando unicidade.

### 2.3 Ledger de execuções (RF-06)

Duas tabelas — cabeçalho (`_runs`) e detalhes por recurso
(`_run_resources`):

```sql
CREATE TABLE alterdata_sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  trigger TEXT NOT NULL,                -- 'manual' | 'scheduler' | 'resync'
  status TEXT NOT NULL,                 -- 'queued' | 'running' | 'success' | 'partial_failure' | 'failed' | 'cancelled'
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  required_failures INTEGER DEFAULT 0,
  optional_failures INTEGER DEFAULT 0,
  correlation_id TEXT NOT NULL,
  initiated_by TEXT                     -- user_id ou 'system'
);
CREATE INDEX idx_alterdata_runs_org_env_started
  ON alterdata_sync_runs(organization_id, environment, started_at DESC);
CREATE INDEX idx_alterdata_runs_correlation
  ON alterdata_sync_runs(correlation_id);

CREATE TABLE alterdata_sync_run_resources (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  module TEXT NOT NULL,
  resource TEXT NOT NULL,
  filial TEXT DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,  -- 1 = required, 0 = optional
  status TEXT NOT NULL,                 -- ver RF-09 (ready, empty_but_valid, auth_failed, etc.)
  http_status INTEGER,
  cursor_before TEXT,
  cursor_after TEXT,
  pages INTEGER DEFAULT 0,
  received INTEGER DEFAULT 0,
  imported INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  mapping_errors INTEGER DEFAULT 0,
  error_code TEXT,                      -- RF-17: ZAPFLOW_CODE | ALTERDATA_AUTH | TOULON_CONFIGURATION | ...
  error_message_sanitized TEXT,         -- sem token, sem PII
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME
);
CREATE INDEX idx_alterdata_run_resources_run
  ON alterdata_sync_run_resources(run_id);
CREATE INDEX idx_alterdata_run_resources_status
  ON alterdata_sync_run_resources(status);
```

### 2.4 Política por módulo (RF-05)

Nova tabela `alterdata_module_policy` — por (org, module) declara se é
`required | conditional | optional | unsupported | disabled`. Seed
inicial da Toulon fica em código (constante), não no schema, porque
depende do PRD (Toulon = varejo/moda). Vertical nova = seed novo.

```sql
CREATE TABLE alterdata_module_policy (
  organization_id TEXT NOT NULL,
  module TEXT NOT NULL,
  policy TEXT NOT NULL,                 -- 'required' | 'conditional' | 'optional' | 'unsupported' | 'disabled'
  condition_flag TEXT,                  -- ex.: 'pdvCustomerImport' pra CRM condicional
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, module)
);
```

Constante em código (`AlterdataModulePolicy.DEFAULT_POLICY_BY_VERTICAL`)
declara pra Toulon (varejo/moda):

```ts
{
  guardian: 'required',
  supply:   'required',
  price:    'required',
  sales:    'required',
  crm:      'conditional',   // condition_flag = 'pdvCustomerImport'
  financial: 'unsupported',
  hr:       'unsupported',
  logistic: 'unsupported',
  purchase: 'unsupported',
  tributary: 'unsupported',
  ecommerce: 'unsupported',
  receber:  'unsupported',
}
```

O readiness (RF-10, PR 4) usa essa política pra calcular status
geral: **um `unsupported` que retornou HTTP 200 nunca conta como
verde** — é ignorado pra fim de gate.

## 3. O que este ADR NÃO faz

- **Não** troca o `AlterdataConnectorService` pra ler dos profiles
  ainda (PR 2 do §10 do PRD).
- **Não** remove os `catch {}` silenciosos do runner (PR 3 do PRD, RF-08).
- **Não** implementa o probe contratual (PR 4, RF-09).
- **Não** implementa o gate `GET /api/integrations/alterdata/readiness`
  (PR 4, RF-10).
- **Não** implementa nada de UI (PR 5, RF-11/12).
- **Não** apaga `alterdata_integration_settings` — permanece coexistindo
  até o backfill do PR 2 estar validado em produção.

## 4. Consequências

### Positivas

- Fundação schema pronta pra os próximos 7 PRs do PRD.
- Zero risco de regressão: tudo aditivo, código antigo continua rodando
  contra `alterdata_integration_settings` até o PR 2.
- Ledger permite auditoria histórica assim que qualquer código começar
  a escrever nele.
- Política formal por módulo elimina o problema "HTTP 200 em módulo
  não suportado conta como sucesso".

### Negativas / dívidas conscientes

- Coexistência temporária de 2 tabelas (`settings` + `profiles`) até
  o PR 2 completar migração — precisa de fachada de leitura no
  connector escolhendo qual usar.
- `alterdata_module_policy` fica vazia por org até um seed rodar
  (PR 4 popula na primeira leitura do readiness).

### Rollback

- Todas as tabelas novas ficam inertes se PR 2..8 não avançarem —
  ninguém escreve nelas, ninguém lê. Zero impacto.
- ALTER TABLE em `alterdata_sync_cursors` adicionando `environment`
  com DEFAULT é irreversível na prática (SQLite não DROP COLUMN
  facilmente), mas totalmente compatível com código antigo.

## 5. Referências

- PRD-ZF-ALTERDATA-GOLIVE-01, §5 (RFs) e §10 (plano de PRs)
- ADR-105 — integração base Alterdata/ModaUp
- ADR-197 — padrão de composição pra integrações (fachada aditiva)
- SESSION-PAUSA-2026-08-29-DUP-AUDIT.md — contexto de por que separação
  de responsabilidade importa
