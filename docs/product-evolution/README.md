# Product Evolution — governança de evolução do produto

Diretório criado na **Fase 0** do PRD-PEL-01 (ZapFlow Product Evolution Ledger +
Gap Closure). Este README documenta o propósito, o modelo mental e a regra
central. As decisões arquiteturais completas ficam no ADR quando a Fase 1 abrir.

## Por que este diretório existe

Nas últimas semanas o repo ganhou 60+ ADRs, 19 PRDs/análises, múltiplos motores
transversais (Decision Intelligence, Radar, Platform Reliability, Fala Tu,
Retail Floor, etc.) e diversos módulos verticais. A velocidade trouxe um problema
novo: **não há uma fonte única que responda "essa ideia virou código? em qual
PR? foi testada? está habilitada? foi validada em produção?"** — a resposta hoje
depende de reconstruir contexto olhando ADRs, git log, testes e branch atual em
paralelo.

O Product Evolution Ledger (PEL) resolve esse problema, sem substituir ADRs nem
git log — ele **indexa** o que já existe e explicita gaps.

## Regra central (imperativa)

> **PRD não significa implementado.**
> **Commit não significa pronto.**
> **Tela não significa operacional.**
> **"Completo" só pode ser afirmado com evidência técnica e operacional
> (código mergeado + rota ligada + teste específico + rollout definido).**

## Arquivos desta pasta

| Arquivo | Propósito | Fase |
| --- | --- | --- |
| `README.md` | Este arquivo | F0 |
| `INITIAL-GAP-MATRIX.md` | Matriz inicial das 25 iniciativas do PRD-PEL-01 §11 com evidência arquivo/serviço/commit por linha | F0 |
| `STATUS-DE-EXECUCAO.md` | Baseline de estado (branch atual, suítes que rodam, PRDs superseded) | F0 |
| `CONVENCOES.md` | Convenções fixas (formato de `evolution_key`, definição operacional de "evidência", estados válidos) | F0 |
| `ADR-XXX-product-evolution-ledger.md` (em `docs/adr/`) | ADR do Ledger | F1 (não desta fatia) |

Fases 1+ (backend, UI, reconciliação, GitHub sync) **não** entram nesta fatia.
A Fase 0 é auditoria pura — nenhuma migration, nenhum service, nenhuma rota.

## Modelo de estados (referência rápida)

Estados oficiais que a matriz e o futuro Ledger reconhecem (PRD-PEL-01 §5):

`IDEA` → `ANALYZED` → `PRD_READY` → `APPROVED` → `IMPLEMENTING` → `CODED` →
`TESTED` → `PILOT` → `PRODUCTION` → `VALIDATED`

Terminais alternativos: `DEFERRED`, `REJECTED`, `SUPERSEDED`.

**Diferença crítica**: `CODED` (código existe) ≠ `TESTED` (testes cobrem o
caminho principal) ≠ `PRODUCTION` (rodando com tráfego real) ≠ `VALIDATED`
(evidência de que o resultado esperado aconteceu).

Sub-estado adicional usado na matriz F0 quando a auditoria não é conclusiva:
`PRECISA VALIDAR COM DADOS REAIS` — código existe, mas nenhuma amostra de
tráfego/dado permite classificar entre CODED e PRODUCTION.

## Convenção de `evolution_key`

- Formato: `^[A-Z][A-Z0-9_]{2,63}$` (UPPER_SNAKE, 3–64 chars, começa com letra).
- Estável — nunca renomeia após publicada. Superseded via link `superseded_by`.
- Uma iniciativa transversal (ex.: `DECISION_INTELLIGENCE`) pode ter
  sub-iniciativas (ex.: `DECISION_INTELLIGENCE_RADAR`). Prefira 1 nível de
  aninhamento; `_` como separador.

## Definição operacional de "evidência"

Uma evidência só conta se satisfizer TODOS os itens aplicáveis:

- referência estável (path do repo, SHA de commit, número de PR/issue);
- se é código: aponta arquivo + linha ou função;
- se é teste: aponta script + comando `npm run test:<nome>` que passa;
- se é rollout: aponta flag em `organization_settings` ou wire de rota;
- se é validação: aponta métrica ou log com data.

Contadores agregados (`X features implementadas`) **não** são evidência. PRDs
descritos como "concluído" no header do arquivo também não — a evidência precisa
ser observável no código atual da branch `main`.

## O que esta Fase 0 NÃO faz

- Não cria tabelas.
- Não cria serviços.
- Não cria rotas.
- Não cria testes.
- Não altera nenhum ADR existente.
- Não decide destino de `SUPERSEDED` (só sinaliza suspeita).
- Não implementa nenhum dos 7 Closure Tracks (A–G) do PRD-PEL-01.

Tudo isso vem em fatias subsequentes, cada uma como PR próprio, seguindo o
fluxo padrão do repo (`docs/adr/ADR-XXX.md` → service → rota → teste → wire).

## Próximos passos (não desta fatia)

1. Revisão humana da matriz inicial.
2. Se aprovado: abrir ADR do Ledger e começar Fase 1 (backend mínimo — items +
   evidence + sources; batches e reviews ficam para depois).
3. UI Admin Master em fatia própria.
4. GitHub Evidence Sync (read-only, cache obrigatório, rate-limited) em fatia
   própria.
5. Closure Tracks em ordem P0 → P1 → P2 → P3 conforme §21 do PRD.
