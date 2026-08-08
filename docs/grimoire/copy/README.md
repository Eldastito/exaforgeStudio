# Grimoire de copy operacional

Base de conhecimento de **copy** que os redatores de IA do ZappFlow (Cobrança, Recuperação Comercial, FalaTu) consultam **antes de compor** uma mensagem ao cliente. Implementa o **padrão 4 (grimoire / progressive-disclosure)** de `docs/patterns/agentic-pipeline-lessons.md` e a **Fase 1 da ADR-155**.

A diferença pra uma pasta de docs comum: aqui o conhecimento é **roteado por estágio de decisão** e **carregado just-in-time** — o redator recebe a rubrica **certa** no momento certo, não o dump inteiro. Isso corta token (padrão 6) e alucinação.

> **Estado (F1.1):** só conteúdo + roteamento. O loader em runtime (`GrimoireService.load(orgId, module, stage)`) é a **F1.2**. Por ora, este diretório é a fonte da verdade versionada e o `INDEX.json` é o mapa que a F1.2 vai consumir.

## Organização por estágio (não por tópico)

| Pasta | Estágio | O que mora aqui |
| --- | --- | --- |
| `intake/` | classificar antes de escrever | temperatura/risco do cliente, estágio da cadência, soft vs hard decline |
| `compose/` | compor a mensagem | rubricas por tipo (dunning, save-offer, timing de sequência) |
| `guardrails/` | regras duras transversais | LGPD opt-out, template/opt-in do WhatsApp, tom "não culpar" |
| `review/` | auto-crítica antes de enviar | checklist pré-envio (liga nos padrões 2/8: julgamento subordinado + evidência) |
| `glossary/` | vocabulário controlado | tom de voz base do produto |

## Cada rubrica é um CONTRATO

Todo `.md` de rubrica segue o `_TEMPLATE.md`: frontmatter YAML (`id`, `estagio`, `modulos`, `fonte`, `versao`) + as 5 seções fixas:

1. **Quando aplicar** — o gatilho exato.
2. **Deve conter** — o que a mensagem obrigatoriamente inclui.
3. **Nunca fazer** — os guardrails duros daquela rubrica.
4. **Exemplos (PT-BR)** — modelos reais, no contexto brasileiro.
5. **Lições (post-mortem)** — memória institucional: quando A/B ou `business_signal` marca uma cadência ruim (F1.4), a lição vira regra aqui e passa a ser injetada dali pra frente.

## Duas camadas

- **Global** (este diretório) — versionado no repo, revisável e diffável.
- **Por-org** — `organization_settings.brand_voice_context` (opt-in, F1.3). O prompt final = rubrica global roteada **+** contexto da org.

## Roteamento

`INDEX.json` mapeia `(módulo, estágio) → rubrica(s)`. A F1.2 lê esse índice pra injetar só o necessário.

## Licença & atribuição

As rubricas derivadas do repo [`coreyhaines31/marketingskills`](https://github.com/coreyhaines31/marketingskills) (MIT) são **adaptadas** ao contexto ZappFlow (PT-BR/PIX/boleto/WhatsApp/LGPD), **nunca copiadas literalmente**, e creditam a origem no campo `fonte` do frontmatter. Rubricas internas (guardrails, glossary, review) marcam `fonte: Interno ZappFlow`.
