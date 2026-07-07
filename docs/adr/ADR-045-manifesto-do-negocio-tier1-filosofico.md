# ADR-045 — Manifesto do Negócio (Tier 1 filosófico)

**Status:** Implementado.

**Origem:** Toda interação orientada por IA (Atendimento, Vendas, Campanhas, Negociação, Cadências) precisa de uma âncora consistente de voz e valores. Sem isso, cada prompt deriva pra genérico, o cliente sente inconsistência entre canais, e a marca perde identidade. Precisávamos de UMA fonte da verdade sobre "quem é a marca" injetada no topo de todo prompt.

---

## Decisão

Adoto o modelo **"Comece pelo Porquê" (Simon Sinek — Golden Circle)** como base: toda organização preenche uma vez o **Manifesto do Negócio**, e ele é injetado no header de cada chamada LLM.

**Estrutura persistida** (`business_manifesto` — 1 linha por organização):
- **Por Quê** (`why_statement`) — a razão de existir da marca (1-2 frases).
- **Como** (`how_principles`) — até 5 princípios de operação inegociáveis.
- **O Quê** (`what_summary`) — 1 frase do que oferta.
- **História fundadora** (`founder_story`) — 2-6 parágrafos (usada só em conteúdo/campanha, não em atendimento).
- **Promessa de transformação** (`transformation_promise`) — o que muda na vida do cliente.
- **Tom de voz** (`tone_voice`) — registro + palavras-âncora + palavras-veto.

**Injeção nos prompts:** `BusinessManifestoService.toPromptHeader(orgId)` monta um bloco `=== MANIFESTO DA MARCA ===` incluído em atendimento/negociação. Uma variante expandida (`toPromptHeaderExpanded`) traz também história e promessa para geração de conteúdo/campanhas. Se o manifesto está vazio, retorna string vazia — a IA cai no fallback genérico sem quebrar.

**Regra-mãe** no prompt: *"se uma mensagem sua diluir/contradizer este manifesto, ela está errada por definição — reformule antes de enviar."*

## Refinamentos filosóficos aplicados nos prompts (Tier 1)

Além do Manifesto, revisamos 5 prompts existentes pra incorporar leituras que estavam soltas:

1. **Diretor honesto** — Diretor IA responde perguntas do dono sem maquiar dados. Baseado no "conselheiro que fala a verdade" de Maquiavel/Gracián.
2. **Raposa e Leão** (Maquiavel) — em negociação, forma flexível (raposa: adapta canal/timing) mas essência firme (leão: não descontar sem margem, não prometer o que não entrega).
3. **Padrões Disney** — atendimento antecipa problemas, resolve com solução pessoal (não desconto genérico), documenta em playbook.
4. **Perfeição prática** — negociador não busca deal perfeito, busca "o melhor deal defensável agora" (Gracián: prudência sobre idealismo).
5. **PCIS (Personagem/Conflito/Interação/Solução)** — copy de campanha e resposta a frustração seguem a estrutura de StorySelling em vez de descrição fria de produto.

## Consequências

**Positivas:**
- Consistência entre canais: cliente sente a MESMA marca no WhatsApp, no Instagram, no e-mail.
- Onboarding acelerado: uma tela do Manifesto (frontend `ManifestoView`) e toda a IA já opera "no tom da marca".
- Base sólida para o Tier 2 (Big Idea Bar, Notas de Reconhecimento, Trio de Auditoria) — todos derivam do Manifesto.

**Negativas / mitigadas:**
- **Aumento de tokens no prompt** (~400-800 tokens no header). Mitigado com versão compacta pra atendimento e expandida só quando precisa da narrativa.
- **Prompt injection via Manifesto** (dono escreve algo malicioso no `whyStatement`) — mitigado por `slice(0, N)` em cada campo (limites de tamanho no `save`) e por ser conteúdo escrito pelo próprio owner autenticado da org.

## Testes

`scripts/test-tier1-manifesto-philosophy.ts` — **39 verificações**: Manifesto persiste + isolamento entre orgs, injeção no prompt, os 5 refinamentos filosóficos (raposa/leão, Disney, honestidade, perfeição prática, PCIS) presentes em `attendancePrompt`, `negotiationPrompt`, `directorPrompt`.
