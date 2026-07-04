# ADR-034 — Fashion AI Studio, FAS-0: fundação (flag, schema, catálogo elegível, telemetria)

**Status:** Implementado e testado (37 verificações novas, suíte completa sem quebras — 33 scripts, `lint`/`build` limpos).
**Origem:** PRD-E-006 (Fashion AI Studio — Provador Virtual), trazido pelo usuário; primeira de 6 entregas (FAS-0 a FAS-5). Piloto técnico previsto: TOULON (moda masculina).

## Contexto e decisões do usuário (registradas nesta conversa)

O PRD-E-006 propõe provador virtual por foto, Look Builder, consultora por ocasião e memória de estilo na vitrine pública. A avaliação de viabilidade contra o código real identificou lacunas de fundação (sem login de cliente, mídia 100% pública, sem scanner/moderação, sem verificação de idade, SQLite sem RLS nativo). O usuário decidiu explicitamente:

1. **Cadastro só para quem usar o provador** — a Loja Virtual continua anônima para navegação/compra; quem quiser o provador cria conta e **vira lead no CRM** (entra no funil como `contacts`). Sistema de conta nasce no FAS-1.
2. **Mídia pública continua como está** para o caso comum (fotos de produto). Storage privado/assinado será construído **apenas** para avatar e resultado de try-on, no FAS-1 — os campos `storage_key`/`output_storage_key` do schema já nascem documentados como "nunca /media público".
3. **Segurança (scanner de malware, NSFW, sandbox) adiada** — foco 100% no provador; o Security & Trust Gateway fica para um PRD próprio, depois.
4. **Menores de idade**: acesso só via conta do responsável (18+) com autorização — o schema de consentimento já prevê `consent_type = 'guardian_approval'`; a implementação é do FAS-1.
5. **SQLite mantido** — isolamento multi-tenant continua sendo disciplina de aplicação (`WHERE organization_id = ?`), como em todo o produto; a conversa sobre Postgres/RLS ficou para depois.
6. **Confiança na maturidade do try-on** — o usuário avalia que a tecnologia está madura (uso pelo Google Shopping como referência). A escolha do provedor concreto continua sendo a "ADR candidata A" do PRD: decidir no FAS-3, com teste real de qualidade/custo/privacidade.

## O que o FAS-0 entrega

1. **Flag por loja** (`storefront_settings.fashion_studio_enabled`, `DEFAULT 0`) — o próprio toggle é o kill switch do RF-035: desligar desativa o módulo inteiro na hora. Limite diário de gerações (`fashion_daily_generation_limit`, padrão 3, clamp 1–20 — config corrompida nunca vira ilimitado nem zero) já nasce configurável (RF-031), embora só seja consumido no FAS-3.
2. **Schema completo** (10 tabelas `fashion_*`, seção 16 do PRD adaptada às convenções do projeto: `TEXT` ids, `organization_id`, `DATETIME`): perfis, preferências, avatares, look requests, looks, itens de look, jobs de try-on, créditos, consentimentos e eventos. Nenhuma tem caminho de escrita público ainda — o schema nasce na fundação para as fases seguintes não precisarem de migration coordenada com código em produção.
3. **Catálogo elegível** (`FashionStudioService.eligibleItems`, seção 8.3): ativo + visível na vitrine (o que já embute ADR-033/auto-ocultar e a recusa de preço da ADR-032) + preço > 0 + ao menos uma imagem comercial (a foto de estúdio da ADR-032 conta) + estoque vendável (produto e por variação; todas as variações esgotadas = inelegível). O provador **consome** o catálogo real — nunca duplica estoque/preço (regra 15.1 do PRD, mesmo princípio de todas as entregas anteriores). O motor de recomendação futuro só poderá selecionar itens por IDs vindos daqui (regra 19.3, anti prompt-injection).
4. **Rota pública** `GET /api/public/store/:slug/fashion/eligible` — responde **404 quando a flag está desligada**, indistinguível de rota inexistente (não revela que a loja tem o recurso disponível mas desativado).
5. **Telemetria** (`fashion_events` + `recordEvent`): eventos da seção 17 com `correlation_id`; recusa payloads grandes (proxy barato para "nunca conteúdo visual/base64 em log/evento", RNF-004); agregação por tipo para o admin (RF-036 — agregado, nunca dado privado).
6. **Toggle na UI** de Configurações da Loja, com o campo de limite diário aparecendo só quando ligado.

## O que fica para as próximas fases

- **FAS-1**: conta de cliente do provador (vira lead), consentimento versionado, upload em quarentena, storage privado com URL assinada/expirável, validação de foto guiada, exclusão/retenção, fluxo de responsável para menores.
- **FAS-2**: questionário, taxonomia de ocasião, motor de filtros, até 3 looks candidatos com explicação segura.
- **FAS-3**: interface de provedor de try-on plugável (decidir o provedor com teste real — ADR candidata A), jobs assíncronos via `JobQueueService`, consumo de créditos.
- **FAS-4**: carrinho do look completo transacional, link seguro via WhatsApp.
- **FAS-5**: memória de estilo.

## Validação

`npm run test:fashion-foundation` (37 verificações) + suíte completa (33 scripts, zero quebras) + `lint`/`build` limpos: schema completo; flag desligada por padrão e por loja; clamp do limite; todas as regras de elegibilidade (preço, visibilidade, atividade, imagem, estoque, variações); isolamento entre organizações; telemetria com recusa de blob; kill switch imediato; rota pública gated.
