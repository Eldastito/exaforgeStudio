# ADR-051 — Comparação tolerante de telefones (Coordenador IA)

**Status:** Implementado.

**Origem:** Fase 2 do plano de produção — o levantamento de maturidade apontou o `CoordenadorService` como incompleto (nenhum teste da função crítica `phoneMatches`). Como o CoordenadorService é a "voz interna" do ZappFlow no WhatsApp da equipe, um erro de match significa OU **falso negativo** (colaborador legítimo vira "número desconhecido" e perde acesso às tarefas) OU **falso positivo** (comandos de um número similar são executados em nome de outra pessoa — grave, viola confiança).

---

## Contexto

O número que chega no webhook varia por provedor:
- WhatsApp Cloud API: `5511987654321` (só dígitos, sem `+`).
- Evolution: `5511987654321@s.whatsapp.net` (dígitos + sufixo Jabber).
- Meta Webhook: pode incluir DDI `+55` ou vir sem.
- Interface do dono ao cadastrar: `(11) 98765-4321` ou `+55 11 98765 4321` ou `11 9 8765-4321`.

Adicionalmente, há **duas variações históricas** de celulares brasileiros:
- Antes de 2012: DDD + 8 dígitos.
- Depois de 2012: DDD + 9 dígitos (com "9" adicional após o DDD).

Um `users.phone` cadastrado como `11 98765-4321` precisa casar com `+55 11 98765 4321`, `5511987654321`, `1187654321` (antigo, sem 9º) e todas as variações intermediárias.

## Decisão

Extraí `phoneMatches` para módulo próprio (`src/server/phoneMatch.ts`) com:

1. **Normalização por `onlyDigits`** — remove tudo que não é dígito.
2. **`stripCountry`** — remove DDI `55` quando o número tem 12+ dígitos e começa com `55`. Não altera números já sem DDI.
3. **Match exato dos últimos N dígitos** — `k = min(11, min(x.length, y.length))`, com piso em 8 dígitos (proteção contra falso positivo de sufixos curtos).
4. **Fallback do 9º dígito opcional** — se um número tem 11 dígitos e o outro 10, DDDs iguais, e o mais longo tem `"9"` na posição 2 (após DDD), casa.

Guarda-costas: strings vazias, `null`, `undefined` sempre retornam `false`.

## Consequências

**Positivas:**
- Cobertura de 27 casos-teste incluindo formatos reais de provedor, com/sem DDI, com/sem 9º dígito, formatos digitados pelo dono.
- Bug real detectado no primeiro run: o algoritmo original NÃO tratava 9º dígito — só DDI. 3 casos falharam antes da refatoração.
- Módulo isolado permite reuso em outros lugares (validação de contato, dedupe de leads).

**Trade-offs aceitos:**
- Números com menos de 8 dígitos precisam ser IDÊNTICOS para casar (proteção). Isso significa que ramais internos curtos não casam por sufixo — mas ramais internos não são o caso de uso do CoordenadorService.
- Se um dia surgir necessidade de suportar DDIs além do 55, refatorar `stripCountry` para tabela.

## Testes

`scripts/test-phone-match.ts` — **27 verificações** cobrindo:
- Igualdade direta (com formatação).
- DDI presente/ausente nas duas direções.
- 9º dígito opcional (10 vs 11 dígitos).
- Números que NÃO devem casar (sufixos, DDDs, totalmente diferentes).
- Guards contra inputs inválidos (vazio, null, undefined, só letras).
- Anti-falso-positivo (números curtos < 8 dígitos).
- Formatos reais do WhatsApp (Cloud, +55 espaçado, com barras verticais).
- `onlyDigits` helper isolado.

Registrado no CI (`.github/workflows/ci.yml`).
