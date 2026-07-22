# ADR-122 — Comigo: graduação MEI + nota fiscal (guia de formalização) (Fatia 3)

- **Status:** Proposto (escopo aprovado; implementação neste PR)
- **Data:** 2026-07
- **Origem:** Fatia 3 do Comigo (ADR-111). Implementa o "Futuro (graduação)" do ADR-088.
- **Relacionadas:** ADR-088 (graduação: orientar MEI + nota fiscal — o caminho natural, endereça o buraco fiscal), ADR-121 (progressão pedagógica — a formalização é o passo após "metas"), termômetro (ADR-116 — faturamento).

## Contexto

O autônomo muitas vezes começa **informal** (sem CNPJ). Quando o negócio cresce, formalizar como **MEI** destrava nota fiscal, previdência e crédito — mas o processo assusta. O ADR-088 põe a graduação como **orientação**, não como emissão fiscal: o Comigo detecta quando vale formalizar (pelo faturamento que já registra) e **conduz** os passos, em linguagem de gente.

**Escopo é ORIENTAÇÃO.** Emissão real de NF-e (certificado digital + SEFAZ) está fora — é integração futura. Aqui o Comigo **ensina e encaminha**, não emite.

## Decisões

### D1 — Detectar prontidão pelo faturamento (que já temos)
Projeta o faturamento anual a partir do que o Balcão/Mesa registram (média recente × 12) e compara com o **teto do MEI (R$ 81.000/ano)**. Níveis:
| Nível | Projeção anual | Mensagem |
|---|---|---|
| **cedo** | < R$ 12k | foco em crescer; formalizar pode esperar |
| **vale_formalizar** | R$ 12k–70k | já compensa virar MEI (nota, INSS, crédito) |
| **perto_do_teto** | R$ 70k–81k | atenção: planeje pra não estourar o MEI |
| **acima_mei** | > R$ 81k | acima do MEI — considere ME/enquadramento |

### D2 — Conduzir a formalização (checklist, não burocracia)
Passos objetivos do MEI (gratuito no **gov.br/empreendedor**), em linguagem simples: documentos, o que é o DAS mensal, direitos (INSS, nota). O Comigo mostra o passo a passo e um CTA; **não** coleta dado sensível nem emite nada.

### D3 — Registrar a graduação (para de cutucar quando formalizou)
O dono marca **"já sou MEI"** (ou ME). Guardado em `comigo_formalization`. Formalizado → o guia troca de "por que formalizar" para **nota fiscal** (como emitir NFS-e/nota avulsa no seu município) e alerta se aproximar do teto.

## Modelo de dados
`organization_settings`: `comigo_formalization TEXT DEFAULT 'informal'` (informal|mei|empresa), `comigo_cnpj TEXT`.

## Serviço (`ComigoGraduationService`)
- `status(orgId)` → `{ formalization, revenue12mo, monthlyAvg, projectedAnnual, meiLimit, pctOfMei, readiness, recommendation, steps[], notaFiscal }` (puro/derivado).
- `declare(orgId, { type, cnpj })` → registra a formalização.
- Rotas `GET/POST /api/comigo/graduation`.
- UI: card no Comigo (aba Saúde) quando vale formalizar; botão "já sou MEI".

## Consequências
**Positivas:** fecha o arco da graduação (ADR-088); usa o faturamento que já existe; endereça o buraco fiscal com orientação responsável; para de cutucar quando o dono formaliza.
**Trade-offs:** não emite NF-e (decisão consciente — integração fiscal é outro projeto); limiares e regras do MEI mudam por lei — número do teto fica configurável/versionado no serviço.

## Guardas
- **Orientação, não emissão** — nunca coleta certificado nem emite fiscal.
- Regras do MEI (teto R$ 81k) centralizadas no serviço, fáceis de atualizar quando a lei mudar.
- Puro/derivado; isolamento por `organization_id`.

## Testes
`test:comigo-graduation` — projeção anual do faturamento; nível cedo/vale_formalizar/perto_do_teto/acima_mei nos cortes certos; `declare` persiste e troca o guia para nota fiscal; isolamento.
