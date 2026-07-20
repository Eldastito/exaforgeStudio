# ADR-103 — Provador com avatares preset da loja (varejo/moda)

**Status:** Aprovado (PR 1 backend em implementação).

**Origem:** Item #13 do `docs/BACKLOG-CAMPO-TOULON.md`. Hoje o provador ("Ver em
mim") exige a **foto do próprio cliente**. Muitos clientes não querem subir foto.
A loja passa a oferecer **avatares pré-cadastrados** (modelos por tipo de corpo)
para o cliente **escolher** em vez de subir a própria imagem.

---

## Contexto

O provador atual (ADR-037, FAS-3) é 100% ancorado na foto do cliente:
`fashion_avatar_assets` (por `customer_id`) com **consentimento, quarentena,
storage privado, URL assinada, retenção e gate 18+ da foto**. O provedor de
try-on (`TryOnProvider.generate({ avatar: Buffer, garments })`) é **agnóstico à
origem** da imagem — recebe um `Buffer`. O ponto de leitura da imagem-modelo é
único (`FashionTryOnService.processJob`).

Um **avatar preset** inverte a lógica de proteção: não é a foto de um cliente, é
um **modelo curado pela loja** — não passa (nem precisa) pelo pipeline de
consentimento/quarentena/18+, que existe para proteger a foto do cliente. A loja
assume a responsabilidade de que a imagem do preset é lícita (modelo com
direitos).

## Decisão

### 1. Avatares por LOJA (não plataforma-global, por ora)
Cada organização cura seus próprios presets (tabela `fashion_preset_avatars` por
`organization_id`). Sem compartilhamento cross-tenant. Plataforma-global fica
como evolução futura. Para o piloto, o operador sobe os avatares na conta da
TOULON.

### 2. Storage público (`/media`), reusando o upload existente
Presets são conteúdo curado não-sensível, análogo a foto de produto. Sobem por
`POST /api/uploads/image` (já existe, salva em `MEDIA_DIR`, devolve `/media/...`)
— **sem** novo código de storage privado/URL assinada.

### 3. Sem consentimento/quarentena; checkbox de responsabilidade
Ao usar um preset, o cliente **não** passa pelo consentimento de processamento de
foto (não há foto dele). No upload pelo lojista, um **checkbox** ("confirmo ter
direitos de uso desta imagem") registra a responsabilidade. O gate 18+ do
**cadastro** do cliente permanece intacto.

### 4. Integração mínima no try-on
`requestGeneration(orgId, customerId, lookId, presetAvatarId?)`: com
`presetAvatarId`, valida o preset (ativo, da org), **pula** a checagem do avatar
do cliente, inclui o preset no `input_hash` (idempotência) e grava
`preset_avatar_id` no job. `processJob` lê a imagem do preset em `MEDIA_DIR`
(público) em vez do avatar privado do cliente. Créditos (3/dia), fila e
idempotência **inalterados**. O `SAFETY_PROMPT` ("primeira imagem é a foto real
de uma pessoa") segue coerente — o preset é a foto de um modelo real.

## Consequências

**Positivas:** remove o maior atrito do provador (subir foto); a loja controla os
modelos que representam sua marca; reaproveita ~90% da infra (provedor, créditos,
fila, idempotência, upload).

**Trade-offs:**
- A imagem do preset não é validada por IA (o `uploads.ts` não valida conteúdo) —
  mitigado pelo checkbox de responsabilidade do lojista + curadoria manual.
- Presets públicos em `/media` são acessíveis por URL (como fotos de produto) —
  aceitável: é conteúdo de vitrine, não dado pessoal do cliente.
- Idempotência precisa distinguir preset de avatar do cliente — resolvido pelo
  `input_hash` incluir o preset id.

## Implementação

- **PR 1 (backend):** tabela `fashion_preset_avatars` + `preset_avatar_id` em
  `fashion_tryon_jobs`; `FashionPresetAvatarService` (CRUD + listagem pública);
  CRUD de staff em `routes/storefront.ts`; `GET /api/public/fashion/preset-avatars`
  + `presetAvatarId` no generate; ramo no `FashionTryOnService`. Teste
  `test:fashion-preset-avatars`.
- **PR 2 (frontend):** upload/gestão dos presets em `StorefrontSettingsView`
  (com o checkbox de direitos) + seletor de galeria na vitrine (`FashionStudio`),
  escolhendo avatar em vez de subir foto, alimentando `generateTryOn`.

## Aprovação

Aprovado por Emerson (jul/26): avatares **por loja** (não global agora), storage
**público** reusando o upload, **sem consentimento/quarentena** para preset (com
checkbox de direitos no upload), 2 PRs (backend + frontend). Item #13 do backlog.
