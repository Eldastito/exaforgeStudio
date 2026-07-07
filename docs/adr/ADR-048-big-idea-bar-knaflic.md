# ADR-048 — Big Idea Bar (Cole Nussbaumer Knaflic, "Storytelling com Dados")

**Status:** Implementado.

**Origem:** Um gráfico mostra *"vendas caíram 15%"*. O dono precisa do *"e daí?"*. Knaflic ensina que dado neutro (gráfico solto) exige do leitor o trabalho de INTERPRETAR — trabalho que o dono ocupado não faz. E quando não faz, o dashboard vira decoração e a decisão continua no achismo. Precisávamos entregar, em cada painel executivo, uma frase que:

- Resume o dado em **linguagem de decisão**, não descrição.
- Sugere UMA **ação recomendada** ancorada no Manifesto (Tier 1).
- Mostra `confidence` — quando amostra é pequena, sinaliza cautela.

---

## Decisão

`BigIdeaBarService` + tabela `big_ideas` + rota `POST /api/big-idea/generate` + componente React `<BigIdeaBar panelKey data />`.

**Fluxo:**
1. Frontend passa `{ panel_key, data }` — `panel_key` identifica o painel (ex.: `dashboard:month`), `data` são os KPIs brutos.
2. Backend calcula `dataHash = sha1(JSON canônico do data).slice(0,16)`.
3. Se existe linha em `big_ideas` com `(org, panel_key, data_hash)` — retorna do cache instantâneo. LLM NÃO é chamado.
4. Se não existe, monta prompt com:
   - Header do Manifesto (`BusinessManifestoService.toPromptHeader`).
   - Método Knaflic: contexto → mensagem única → ação.
   - Dado bruto (limitado a 6000 chars pra não estourar).
   - Regras: headline ≤ 30 palavras, específica, verbo de ação, sem chavão. `confidence` 0-100 refletindo qualidade da amostra.
5. LLM retorna `{ headline, action, confidence }`. Persiste + retorna.

**Cache por hash é a chave da economia:**
- Refresh do painel sem mudança nos KPIs → 0 chamadas LLM.
- Troca de período (mês → semana) → `panel_key` muda → gera nova (cache miss).
- Novo pedido entra → hash muda → gera nova (cache miss).

**Fallback silencioso:** se o LLM falhar, `BigIdeaBarService.latest(orgId, panelKey)` retorna a última Big Idea gerada com `stale: true` — melhor "algo velho" do que dashboard sem interpretação.

**Race-safe:** se dois requests idênticos batem simultâneos, um deles vai gerar, o outro pega o unique-index conflict e devolve o registro persistido.

**UI:** card gradient purple no topo do Dashboard executivo. Mostra headline, ação recomendada, badge de confiança (verde ≥80, âmbar ≥60, laranja <60), e um botão de regenerar (força `force: true` bypassando cache — usado quando o dono quer 2ª leitura).

## Consequências

**Positivas:**
- Dashboard deixa de ser decoração, vira **narrador**. Dono entra na tela, lê 1 frase, sabe o que fazer.
- Custo controlado: cache por hash + prompt compacto ≈ **1 chamada LLM por painel por período por delta de dado**.
- Alinhado com Manifesto — a ação sugerida sempre reflete o Por Quê da marca (se o dono preencheu Tier 1).

**Negativas / mitigadas:**
- **Hallucination** — LLM inventa insight sem base. Mitigado por regras estritas no prompt ("nunca descreva o dado; INTERPRETE") + campo `confidence` explícito + prompt exige "se dado insuficiente, diga honestamente na headline".
- **Cache pode ficar stale para o mesmo hash + período**. Mitigado com botão "regenerar" que força bypass.

## Testes

`scripts/test-tier2-big-idea-bar.ts` — **19 verificações**: hash determinístico (ordem de chaves irrelevante), cache hit vs miss vs `force=true`, isolamento entre orgs (mesmo hash, orgs diferentes = miss), `latest()` devolve linha mais recente, `rowToIdea` mapeia coluna → campo, injeção do Manifesto no header do prompt.
