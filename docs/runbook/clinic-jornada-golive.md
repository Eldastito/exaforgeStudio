# Runbook — Habilitar Jornada de Tratamento por tenant

**Escopo:** ativar Jornada de Tratamento (ADR-145 backend + ADR-146 UI) numa organização específica.

**Pré-requisitos:** módulo Clínica (ADR-080) já configurado — a org tem `organization_settings` populada, ao menos 1 `clinic_professionals` cadastrado.

## Passo a passo

### 1. Dry-run (sempre primeiro)

```
tsx scripts/clinic-journey-tenant-setup.ts <orgId> --dry-run
```

Imprime o que faria sem mutar. Confere org, conta profissionais legados, verifica PIN, mostra estado atual de `clinic_cycle_requires_guide`.

### 2. Rodar de verdade

```
tsx scripts/clinic-journey-tenant-setup.ts <orgId>
```

Faz 3 coisas, idempotente:

1. **Backfill de especialidades** (F35 legacy migration) — migra `clinic_professionals.specialty` (string livre pré-145) para `clinic_specialties` + `clinic_professional_specialties` (N:N). Rodar N vezes é seguro.
2. **Validação de cobertura** — lista profissionais ativos sem PIN (BLOQUEADOR) e sem especialidade vinculada (WARN).
3. **Opt-in RN-005 §8** — só aplica `clinic_cycle_requires_guide=1` se passou `--cycle-requires-guide`. Nunca desliga (segurança).

Sai com código 0 se pronto, 1 se há bloqueadores.

### 3. Resolver bloqueadores

Cada profissional ativo precisa de PIN antes do go-live — alta/reopen (F39) exige PIN. Setar via API:

```
POST /api/clinic/professionals/:id/pin
Content-Type: application/json
{"pin":"1234"}
```

Rodar o script de novo até `Status: PRONTO`.

### 4. Setup opcional pra clínicas de convênio

Se o cliente opera SÓ com plano/convênio (ciclo tem que ter guia antes de agendar):

```
tsx scripts/clinic-journey-tenant-setup.ts <orgId> --cycle-requires-guide
```

Ciclos passam a nascer `pending_authorization` até uma guia `issued` ser amarrada. Padrão comportamental da RN-005 §8.

### 5. Smoke visual (recepção + médico)

Abrir a Clínica no app:

1. **Aba Especialidades** (F51) — confere se todas as especialidades legadas apareceram.
2. **Aba Episódios** (F52) — abre 1 episódio de teste com paciente real.
3. **Aba Ciclos** (F53) — cria 1 ciclo, confere saldo (RN-004 sempre derivado).
4. **Aba Grupos** (F54) — cria 1 sessão em grupo + adiciona 2 pacientes. Confere que aparece 1 ocupação na agenda do profissional (RN-006).
5. **Aba Guias** (F55) — se convênio, gera 1 draft com IA (F48 GuideDraftButton) e emite com PIN.
6. **Header + badges** (F56) — aparece automaticamente com counts corretos assim que há episódio ativo.

## Guardrails RN-014 (não regredir)

A IA operacional (F47/F48) nunca:
- Sugere outro profissional (RN-003).
- Renova ciclo (recepção decide + humano confirma).
- Dá alta (médico com PIN).
- Emite guia sem PIN.
- Inventa TUSS, carteirinha, `authorizationNumber` ou `validUntil`.
- Herda `referralReason` de encaminhamento anterior.
- Fabrica itens em pedido médico.

## Reverter

- **Backfill**: não desfaz automaticamente. Delete manual de linhas em `clinic_specialties` + `clinic_professional_specialties` se precisar (respeita FK de `clinic_care_episodes` — se já tem episódio ligado, remova o episódio primeiro).
- **cycle_requires_guide**: `UPDATE organization_settings SET clinic_cycle_requires_guide = 0 WHERE organization_id = ?`.
- **PINs**: `POST /api/clinic/professionals/:id/pin` com `{"pin":null}` remove.

## Troubleshooting

| Sintoma | Causa | Fix |
|---|---|---|
| Header F56 não aparece | Org não tem episódio ativo | Abrir 1 episódio de teste (aba Episódios) |
| Badge âmbar em Ciclos | `renewalDue > 0` (F47 detectou) | Aba Ciclos → renovar (humano decide) |
| Badge âmbar em Episódios | `withoutSchedule > 0` (F40) | Aba Episódios → agendar próxima sessão |
| Sessão em grupo aparece como 5 ocupações | Regressão RN-006 | Rodar `npm run test:clinic-journey-e2e` (F57) — deve pegar |
| Guia emite mas não vira ciclo `active` | Ciclo não estava `pending_authorization` OU `clinic_cycle_requires_guide=0` | Verificar flag; RN-005 §8 só atua com flag on |
| PIN bloqueado | 5 tentativas erradas em 15min (Fase 28) | `POST /api/clinic/professionals/:id/pin-reset` (owner/admin) |
