# ADR-075 — StorageService — disco local vs S3, URLs assinadas

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de decisão já em código, sem ADR próprio (o `StorageService` era mencionado de passagem no ADR-011 §4 e no ADR-057 §22, mas nunca tinha ganho documento seu). O enquadramento original do plano ("dev roda disco, prod roda S3 — código de negócio nunca sabe qual") **não** é o que está implementado, e este ADR existe justamente para registrar o que foi feito no lugar disso e por quê.

---

## Contexto

Três produtores geram arquivos que sobrevivem à request:

- `ReportPdfService` — PDF de relatório gerencial e de proposta (`src/server/ReportPdfService.ts:73,169`), gravado em `MEDIA_DIR/reports/`.
- `routes/radar.ts` — evidência anexada a resposta do radar consultor (ADR-015), PNG/JPG/WEBP/PDF em `MEDIA_DIR/radar-evidence/`.
- `routes/integrations.ts` — backup em JSON da organização (ADR-057), em `DATA_DIR/backups/`.

O problema real que o serviço resolve **não** é "abstrair disco vs S3" — é: quando o ZappFlow rodar em mais de uma réplica, ou quando o operador quiser trocar de host sem perder relatórios antigos, o disco local vira armadilha. Enquanto for uma instância só (o caso hoje, single-tenant por hotel/rede), disco local é mais simples, mais rápido e não depende de credencial externa.

A saída seria adapter pattern (`STORAGE_BACKEND=disk|s3`, path por org, URL assinada, TTL de retenção). **Não foi por aí.** O motivo é honesto: em nenhum consumidor atual o código de negócio "não sabe" onde o arquivo está — todos servem o arquivo local via `/media/...` no mesmo processo Node, e o S3 nunca substitui essa URL. Construir a abstração completa teria custado interface, migração e testes para resolver um problema que ainda não existe.

## Decisão

**Regras invioláveis do `StorageService`:**

1. **Mirror best-effort, não adapter.** A única superfície é `mirrorToS3(localFilePath, key)`. O arquivo já foi gravado no disco local antes de chamar; o S3 é cópia posterior, nunca substituição.
2. **Desligado por padrão.** `isS3Enabled()` só vira `true` com `S3_ENABLED=true` **e** `S3_BUCKET` definidos. Sem env, o comportamento é idêntico ao pré-serviço (disco local puro).
3. **Nunca lança.** Falha de rede, credencial errada, bucket inexistente — tudo cai em `console.error` + `{stored:false}`. Quem chamou continua com o arquivo local funcionando. Testado em `test-storage-service.ts:59-67` apontando para `127.0.0.1:1`.
4. **Import dinâmico do `@aws-sdk/client-s3`.** Só carrega o SDK quando alguém realmente configurou S3 — dev normal nem paga o custo de resolver o módulo.
5. **Provedor-agnóstico.** `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE` cobrem AWS S3, Cloudflare R2, Backblaze B2, MinIO. Sem credenciais explícitas, cai na cadeia padrão do SDK (roles IAM, env da nuvem).
6. **`Content-Type` derivado da extensão da `key`** — `.pdf`, `.json`, senão `octet-stream`. Suficiente porque quem grava é o próprio ZappFlow e conhece o formato.
7. **URL pública opcional** via `S3_PUBLIC_URL_BASE` — quando presente, `mirrorToS3` devolve `${base}/${key}`. Sem base, monta a URL virtual-hosted padrão. Nenhum consumidor de hoje usa essa URL como fonte primária; ela existe para logging e para portabilidade futura.

## Consequências

**Positivas:**
- Adotar S3 em produção é ligar quatro envs; desligar é desconfigurar uma. Sem migração de dados, sem risco de perder relatório antigo.
- Falha do provedor S3 nunca degrada UX — a rota de geração de PDF/backup nem sabe se o mirror deu certo.
- Custo zero em dev/CI: sem SDK carregado, sem chamada de rede, sem stub.

**Trade-offs aceitos:**
- **Não é uma abstração de storage.** Não há segregação de path por org (as keys são `reports/{id}.pdf`, `radar-evidence/{name}`, `backups/{name}` — flat), não há URL assinada com TTL, não há política de retenção (Fashion avatar por N dias, etc.), não há CDN, não há multi-region, não há event notification para lifecycle do bucket. Tudo isso fica delegado ao operador via console do provedor (lifecycle rule no bucket resolve retenção; CloudFront/R2 público na frente resolve CDN).
- **Disco local é fonte de verdade, S3 é redundância.** Se uma réplica cair antes do mirror, o arquivo existe só no disco perdido. Aceitável enquanto a instância é única; vira problema real no dia do multi-réplica, e aí sim precisa virar adapter de verdade (ou usar volume compartilhado).
- **Falha silenciosa.** `stored:false` só aparece no `console.error`. Sem observabilidade estruturada, um bucket configurado errado passa meses despercebido. Revisitar quando entrar log estruturado.
- **Sem separação por tenant no path.** Se um dia rodar multi-tenant hospedado, `reports/{id}.pdf` colide entre orgs (o `id` do relatório já é único por org, mas não há prefixo `org/{orgId}/`). É retrabalho fácil no dia que precisar.

## Testes

`scripts/test-storage-service.ts` cobre o essencial do contrato — não a integração real com S3, e sim as garantias que quebrariam produção se falhassem:

- **Desligado por padrão:** sem env, `isS3Enabled()` é `false` e `mirrorToS3` é no-op com `stored:false`.
- **Baseline preservado:** `ReportPdfService.generateManagerReport` funciona idêntico ao pré-serviço, URL em `APP_URL/media/reports/...`.
- **Reflexo da config:** com envs setadas, `isS3Enabled()` vira `true`.
- **Nunca lança:** apontando para `127.0.0.1:1` (recusa garantida), `mirrorToS3` retorna `stored:false` sem exceção.
- **Fallback do produtor:** com S3 mal configurado, `ReportPdfService` continua devolvendo URL local válida.

**Lacunas honestas:** nenhum teste toca S3 real (ambiente CI não tem bucket) — a garantia é que o *fluxo local* nunca depende do S3. Sucesso real de upload é validado manualmente contra R2/MinIO no ambiente do operador.
