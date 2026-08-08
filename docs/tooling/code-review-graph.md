# code-review-graph — tooling de review de risco

Ferramenta [`tirth8205/code-review-graph`](https://github.com/tirth8205/code-review-graph) (MIT, Python 3.10+): mapeia o codebase com tree-sitter, guarda o grafo de dependências em SQLite e calcula o **blast radius** de uma mudança (o que de fato é afetado por um diff). Serve isso de dois jeitos — como **GitHub Action** (review de risco em PR) e como **servidor MCP** (contexto preciso e barato de tokens pra assistentes de IA).

Contexto da decisão de adoção: **ADR-155** (Trilha B).

## O que está instalado no projeto

**Só a GitHub Action** — `.github/workflows/code-review-graph.yml`:

- Roda em cada PR pra `main`, pinada em `@v2.3.7`.
- Posta um comentário sticky com score de risco + arquivos no blast radius.
- É **sinal, não gate**: `fail-on-risk: none` (não trava merge). O CI (`ci.yml`) continua sendo o gate de regressão.
- Menor privilégio: `contents: read` + `pull-requests: write`.
- Auto-contida: instala o pacote Python no runner. **Não exige nada no ambiente de dev de ninguém.**

Exclusões de parsing em `.code-review-graphignore` (foca em `src/ apps/ scripts/ tools/`).

## Por que NÃO comitamos `.mcp.json`

O modo MCP (contexto pro Claude Code) é ótimo, mas comitar `.mcp.json` na raiz faria **toda** sessão do Claude Code neste repo tentar subir `code-review-graph serve` — e falhar pra quem não tem o pacote pip instalado localmente. Efeito colateral que não vale o risco a nível de projeto. Quem quiser o MCP habilita **na própria máquina** (abaixo), sem impor ao time.

## Uso local opcional (MCP + grafo)

```bash
pipx install code-review-graph        # ou: pip install / uv tool install
code-review-graph build               # parseia o codebase -> SQLite local
code-review-graph install --platform claude-code   # registra o MCP no SEU Claude Code
```

Comandos úteis: `update` (incremental), `detect-changes` (risco do diff atual), `visualize` (exporta o grafo), `serve` (sobe o MCP), `watch` (auto-update).

Variáveis de ambiente relevantes: `CRG_DATA_DIR` (onde fica o SQLite), `CRG_TOOLS` (filtra as ferramentas MCP expostas), `CRG_MAX_IMPACT_NODES` (limite do blast radius, default 500).

## Subir o rigor depois (opcional)

Quando o time confiar no score, dá pra transformar em gate trocando no workflow:

```yaml
fail-on-risk: 'high'   # falha o job se risco >= 0.70 (ou 'critical' p/ >= 0.85)
```

É decisão de produto — por ora fica advisory pra não atritar o fluxo 1-PR-por-fatia.
