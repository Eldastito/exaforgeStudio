# ADR-030 — Validação da visão de IA contra a API real (script para o ambiente com chave)

**Status:** Script entregue e com o guard testado; a execução real acontece no ambiente de produção (Coolify), onde `OPENAI_API_KEY` existe — este sandbox de desenvolvimento não tem a chave, por isso a validação não pode rodar aqui (mesma limitação registrada desde a ADR-019).

## Contexto

As ADRs 019, 020 e 021 carregam a mesma ressalva: as funções de visão (`extractProductFromImage`, `extractInvoiceItems`) nunca foram exercitadas contra a API real da OpenAI. Toda a lógica ao redor (rascunho, confirmação, estoque, custo médio, auditoria) está coberta por 404 verificações determinísticas — o único elo não validado é a qualidade da extração em si.

O usuário confirmou que a chave está nas variáveis de ambiente do Coolify. A chave não deve ser copiada para o sandbox; o caminho certo é levar a validação até onde a chave mora.

## Decisão

`npm run validate:ai-vision` (`scripts/validate-ai-vision.ts`) — autocontido, para rodar no terminal do container em produção:

1. Gera na hora duas imagens JPEG sintéticas via `sharp` (sem depender de arquivo externo): um rótulo de produto ("KICALDO / FEIJÃO PRETO / TIPO 1 / 1 kg") e uma nota fiscal com 2 itens, fornecedor e linha de total — texto grande e nítido, o caso base que a IA tem de acertar.
2. Chama as duas funções de visão reais (2 chamadas de API, custo de centavos). Não abre o banco do produto — zero efeito colateral.
3. Valida conteúdo, não só forma: nome/peso extraídos batem com o rótulo; os 2 itens da nota vêm com quantidade e custo exatos; a linha de TOTAL não vira item; fornecedor identificado; `confidence` em 0–100; e a regra de produto — **nunca sugerir preço** — respeitada.
4. Imprime o JSON cru (inspeção humana) e sai com código 0/1 — utilizável em CI ou healthcheck se desejado.

Sem chave, o script instrui e sai com erro — não finge sucesso.

## O que este script NÃO prova

Ele valida o caso base com imagens limpas. Foto real de celular (desfoque, papel térmico desbotado, ângulo) só se valida com uso real — as faixas de confiança da ADR-020 e a revisão humana obrigatória existem exatamente para isso. Se a validação em produção passar, a ressalva das ADRs 019/020/021 pode ser considerada fechada para o caminho feliz, com a qualidade em fotos difíceis monitorada pela auditoria `changedFields` (o quanto o humano corrige a IA) já implementada na ADR-020.
