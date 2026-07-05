# ADR-042 — Fashion AI Studio: provedor Google Gemini para o provador virtual

**Status:** Implementado (build limpo, suítes fashion completas sem quebras).
**Origem:** feedback do usuário — o gpt-image-1 (OpenAI) re-sintetiza o rosto da pessoa no provador; o usuário já obteve bons resultados de preservação de identidade com Google AI Studio (app TOULON).

## Contexto

O provador virtual (FAS-3) usa um provedor plugável (`TryOnProvider`) para gerar a prévia "look em você". O provedor padrão até agora era o `OpenAIEditTryOnProvider` (gpt-image-1, `images.edit` com `input_fidelity: "high"`). Apesar do reforço de prompt e do parâmetro de fidelidade (ADR-040), o gpt-image-1 continua re-sintetizando o rosto — a pessoa no resultado NÃO se parece com a foto original.

O Gemini com `responseModalities: ["IMAGE", "TEXT"]` trata as imagens de entrada como REFERÊNCIA multimodal: o modelo "vê" a foto e a usa como contexto para gerar a composição, em vez de editá-la pixel a pixel. Na prática, isso preserva melhor a identidade.

## Decisão

### Novo provedor: `GoogleGeminiTryOnProvider`

- **`llm.ts`** ganha `editImagesGoogleB64()`: envia N imagens + prompt ao endpoint `generateContent` do Gemini e extrai o base64 da imagem gerada na resposta. Mesmo padrão de `fetch` direto (sem SDK extra) já usado para Imagen e Veo.
- **`FashionTryOnService.ts`** ganha `GoogleGeminiTryOnProvider` (`key = "google_gemini_v1"`):
  - `available()` → `true` se `GOOGLE_AI_API_KEY` ou `GEMINI_API_KEY` estiver configurada.
  - `generate()` → monta as partes (foto da pessoa + fotos das peças), envia via `editImagesGoogleB64` com o mesmo `SAFETY_PROMPT` (19.2).
- Registrado no mapa `PROVIDERS` ao lado do `openai_edit` existente.

### Seleção automática (sem breaking change)

```
FASHION_TRYON_PROVIDER explícito? → usa esse.
Senão, GOOGLE_AI_API_KEY configurada? → google_gemini.
Senão → openai_edit (fallback).
```

Segue o mesmo padrão de `generateImageB64` (Imagen preferido quando configurado, OpenAI como fallback).

### Idempotência

O `input_hash` já inclui `provider.key`. Mudar de `openai_edit_hifi_v1` para `google_gemini_v1` invalida os resultados antigos automaticamente — o próximo "Ver em mim" gera de novo com o Google.

### Variáveis de ambiente

| Var | Padrão | Descrição |
|-----|--------|-----------|
| `GOOGLE_AI_API_KEY` / `GEMINI_API_KEY` | — | Chave da API Google AI (já usada para Imagen/Veo) |
| `GOOGLE_TRYON_MODEL` | `gemini-2.0-flash-exp` | Modelo Gemini para try-on (configurável) |
| `GOOGLE_TRYON_COST_USD` | `0.04` | Custo fixo por geração para a medição interna |
| `FASHION_TRYON_PROVIDER` | (auto) | Override explícito: `google_gemini` ou `openai_edit` |

## Consequências

- Com `GOOGLE_AI_API_KEY` configurada (já existe no deploy para Imagen/criação de imagens), o provador **automaticamente** usa o Google Gemini — sem nenhuma mudança de código ou config adicional.
- Lojas sem chave Google continuam usando o OpenAI como antes.
- O provedor OpenAI permanece funcional e selecionável via `FASHION_TRYON_PROVIDER=openai_edit`.
- Custo e modelo são configuráveis por env, sem re-deploy de código.
