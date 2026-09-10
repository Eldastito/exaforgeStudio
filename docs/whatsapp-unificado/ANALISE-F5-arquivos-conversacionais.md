# F5.0 — Auditoria de Arquivos pela Conversa (RF-07 / CA-07)

> Abertura da **Fase 5** no mesmo espírito da F0/F3.0/F4.0: **revalidar o que
> existe antes de mexer**. Doc-only. Referências `arquivo:linha` no HEAD.

## Contexto

A Fase 5 (RF-07, PRD §13) entrega o ciclo "**pedir → gerar/localizar → entregar**"
de arquivos pela conversa: o dono/gestor pede "me manda as vendas por loja em
Excel/PDF/Word" e recebe um arquivo **real** (não renomeado), com os **mesmos
dados/filtros/período** da resposta anterior, entregue pelo WhatsApp ou por
**link seguro declarado** — e quem não tem permissão **não recebe nada** (nem
conteúdo, nem link). Gate **G5 = CA-07**, com prova de arquivos reais gerados em
teste (Word **não** pode ser marcado só por extensão reconhecida).

A Fase 5 **não começa do zero**: PDF e XLSX já geram artefato privado + link
assinado; o que falta é **DOCX real**, o **catálogo com referência ao último
resultado**, a **entrega tipada** (MIME/URL absoluta) e a **prova de aceite**.

## O que JÁ existe (reusar, não reconstruir)

### Geração PDF — `ReportPdfService` (pdfkit)
`src/server/ReportPdfService.ts:4` (import pdfkit). Métodos `static`:
- `renderSimplePdf(orgId, {title,subtitle?,sections,footer?})` (`:28`) → **Buffer**
  genérico (é o que alimenta o caminho de artefato privado).
- `generateSalesReport`/`generateManagerReport`/`generateRadarReport`
  (`:67`/`:146`/`:212`) → escrevem em disco `‹DATA_DIR›/media/reports` (`:9`) e
  devolvem **URL pública** `${APP_URL}/media/reports/{id}.pdf` (`:134`/`:189`/`:285`),
  espelho S3 opcional. `generateGovernancePdf` (`:307`) → Buffer.
- **Duas famílias de saída**: Buffer (→ ArtifactService privado) × arquivo em
  `/media/reports` público (fluxo gestor WhatsApp legado). A Fase 5 usa a
  privada + link assinado.

### Geração XLSX — `buildXlsx` (sem dependência externa)
`src/server/XlsxService.ts` — OOXML+ZIP escrito à mão (CRC32 próprio `:16-29`,
ZIP STORED, data DOS fixa p/ determinismo `:31-32`; o header `:1-10` explica a
decisão de **não** adicionar dependência). Exports:
- `CellValue` (`:12`), `XlsxSheet {name,rows}` (`:13`),
  `buildXlsx(sheets): Buffer` (`:66`, multi-sheet, célula numérica `t="n"` ×
  `t="inlineStr"`, escapa XML), `XLSX_MIME` (`:162`).
- Não há `class XlsxService` — são funções livres. Único chamador hoje:
  `FalaTuReportService.ts:17`/`:55`.

### Relatório do Fala Tu — `FalaTuReportService` (determinístico, zero IA)
`src/server/FalaTuReportService.ts:28`:
`executiveSummary(orgId, user, {correlationId?, format?})`. Um único relatório
("**Resumo Executivo**", `kind:"report"`, `origin:"falatu"` `:69`).
`ReportFormat = "pdf" | "xlsx"` (`:19`); PDF default (`:36`). Usa
`ContextEngineService.buildForUser` (`:37`, **projeção por papel** — vendedor
perde finanças/compras → `droppedDomains`). Persiste via `ArtifactService.create`
(`:68`) e devolve **link assinado** `ArtifactService.signedUrl` (`:75`) — nunca o
binário. Rota `POST /api/falatu/reports/summary` (`routes/falatu.ts:304-308`,
lê `format` do body). **Único caminho onde XLSX é alcançável hoje.**

### Artefato privado + assinatura — `ArtifactService`
`src/server/ArtifactService.ts` — binário em disco **privado**
`‹DATA_DIR›/private_media/artifacts` (`:27`), chave `${orgId}/${id}.${ext}`.
`create(orgId, input)` (`:69`) computa `sha256` (`:83`) + `size_bytes` e grava na
tabela `artifacts` (`:85-88`: `mime_type`/`size_bytes`/`storage_key`/`origin`/
`classification`/`sha256`/`correlation_id`/`expires_at`). `KINDS` (`:31`:
report/export/receipt/document/image/other), `CLASSES` (`:32`:
internal/sensitive/public, default internal `:75`). **MIME→ext** já mapeia
**DOCX** (`:37`
`application/vnd.openxmlformats-officedocument.wordprocessingml.document → docx`)
— pronto pra **armazenar** DOCX, sem gerador que o **produza**.
- `signedUrl(orgId, id, ttl=15min)` (`:121`) → **URL RELATIVA**
  `/api/public/artifacts/{org}/{id}?exp&sig` (`:125`).
- RBAC por classificação: `canAccess` (`:141`, `sensitive` só criador ou
  `hasFullBusinessVisibility`, fail-closed), `getForUser`/`listForUser`/
  `signedUrlForUser` (`:150`/`:156`/`:161`).
- Download público (sem auth, HMAC-verificado): `routes/artifacts.ts:39-43`
  (`resolveSigned`). Link autenticado por usuário: `routes/falatu.ts:330`
  (`/artifacts/:id/link`).

### Assinatura HMAC — `fileSigning`
`src/server/fileSigning.ts` — `DEFAULT_SIGNED_TTL_MS=15min` (`:22`),
`scopeSecret = sha256(${JWT_SECRET}:${scope}_v1)` (`:25`, cache; escopos não
cruzam), `signKey`/`verifyKey` (`:49`/`:57`, `timingSafeEqual` `:65`),
`safeStorageKey` anti-traversal (`:35`). ArtifactService usa `SCOPE="artifact"`.
(Mídia de chat tem helper irmão `mediaSigning.ts`.)

### Entrega de documento — `MessageProviderService.sendDocument`
`src/server/MessageProviderService.ts:217`:
`sendDocument(channelId, recipient, fileUrl, fileName, caption?, opts?)`
— recebe **URL**, não buffer. Já passa pelo **gate de finalidade** da F2.4
(`assertOutboundAllowed`, `:223-225`). Dois provedores:
- **whatsapp_cloud** (`:230-248`): `document:{link:fileUrl, filename}` — Meta
  infere o tipo pela extensão do `filename`; **busca a URL server-to-server**.
- **evolution/evolution_go** (`:250+`): 🚩 **`mimetype:'application/pdf'`
  HARDCODED** em `bodyA` (`:259`), o corpo primário de `/send/media` +
  `/message/sendMedia`. XLSX/DOCX sairiam **rotulados como PDF**.
- Chamadores atuais (todos entregam PDF): `webhookProcessor.ts:50`/`:994`,
  `RadarService.ts:769`, `Clinic{Guide,Document,MonthlyReport}Delivery` (via
  `DocSender` injetável).

### Fila durável — `JobQueueService`
`src/server/JobQueueService.ts`: `registerHandler(type, handler)` (`:50`),
`enqueue(type, payload, {organizationId, maxAttempts})` (`:55`, insere
`background_jobs`, dispara em background). Precedente concreto de "preparar
arquivo": job `generate_manager_pdf` (handler em `webhookProcessor.ts:~41-53`,
enfileirado `:981` sob `PDF_REPORT_ASYNC_ENABLED`).

### Fluxo "isso em Excel/PDF" hoje — DUAS trilhas desconexas
1. **API (PDF+XLSX)**: `POST /api/falatu/reports/summary` com `format` no body —
   chamada explícita, **não** intenção em texto livre.
2. **WhatsApp texto livre (só PDF)**: intenção por **regex**
   `AIOrchestratorService.ts:437` `exportPdf: /\bpdf\b/i.test(message)`
   (+ `pdfTitle`/`pdfBody`); consumido em `webhookProcessor.ts:972` → enfileira
   `generate_manager_pdf` ou gera síncrono + `sendDocument` (`:994`) com
   fallback de link em texto (`:997`). **Não existe `exportXlsx`** (grep zero).
- `FalaTuAskService` devolve **só texto** (`FalaTuAskKind` `:38` sem tipo de
  arquivo). `GestorCommandService` **não** trata relatório/export (grep zero).
- **Net:** não há roteador conversacional unificado de arquivo; XLSX só via API,
  texto-livre só dispara PDF por `\bpdf\b`.

### Testes já existentes (reusar/estender)
`test-falatu-report` (PDF: artefato+sha256+link assinado, projeção por papel,
correlation, isolamento), `test-xlsx` (ZIP/OOXML real via unzip + XLSX pelo
FalaTuReportService), `test-artifacts` (fileSigning roundtrip + ArtifactService),
`test-artifact-rbac` (RBAC por classificação), `test-security-media-signing`
(mídia de chat). **Não existe `test-docx*`.**

## Gaps da Fase 5 (o que FALTA)

| Fatia | O que o PRD pede (§13) | Estado hoje | Gap |
|---|---|---|---|
| **F5.1** | Catálogo inicial (§13.2) + **referência ao último resultado/filtros** com autorização; consulta ⇒ export usa **mesmo recorte/snapshot** quando é "isso" | Só "Resumo Executivo" (PDF/XLSX) via API; nenhuma memória de "última resposta" pra reexportar; catálogo vendas/financeiro/tarefas não plugado a export | Falta o **catálogo** ligado às consultas de domínio existentes + a **referência de recorte** ("isso" = último resultado) + autorização revalidada na geração |
| **F5.2** | Reutilizar PDF/XLSX e **adicionar DOCX real** (§13.3: MIME/extensão corretos, editável, **não** renomear PDF/HTML) | PDF+XLSX ok; **DOCX inexistente** — só o mapa MIME→ext em `ArtifactService.ts:37` | Falta o **gerador DOCX real** (renderer OOXML/wordprocessingml, à moda do `buildXlsx` sem dependência OU lib adequada ao runtime) + `DOCX_MIME` + teste que abre o arquivo |
| **F5.3** | Ligar geração/localização à **fila de entrega** com **MIME e URL assinada corretos** (§13.4: envio tipado, URL **absoluta** assinada, sem fixar `application/pdf`) | `sendDocument` fixa `application/pdf` (Evolution `:259`); `signedUrl` é **relativo** (`:125`); geração pesada tem precedente de job (`generate_manager_pdf`) | Falta **envio tipado por MIME** (parar de fixar PDF), **resolver URL absoluta** (`APP_URL` + link assinado), e o **job durável** de preparação de arquivo genérico (não só manager PDF) |
| **F5.4** | Validar **abertura real**, dados, classificação, **permissão revogada** (na geração E na entrega), tamanho e **fallback declarado** (§13.4 + CA-07) | `test-falatu-report`/`test-xlsx` provam PDF/XLSX; RBAC por classe testado; sem teste DOCX; sem teste de revogação entre geração↔entrega; sem teste de fallback de link | Falta a **prova CA-07** ponta-a-ponta pros 3 formatos + revogação + tamanho/limite do provedor + fallback "é link, não anexo" |

## Achados que orientam o recorte

1. **DOCX é o único gerador ausente** — PDF/XLSX/artefato/assinatura/RBAC/fila já
   existem. O peso da fase está em (a) DOCX real e (b) tornar a **entrega**
   honesta por MIME + URL absoluta.
2. **`sendDocument` fixa `application/pdf`** (`MessageProviderService.ts:259`) —
   correção pequena e cirúrgica: aceitar `mimeType` tipado e propagá-lo (Evolution
   `bodyA`; Cloud já usa `filename`). **Compat**: chamadores atuais de PDF não
   quebram (default `application/pdf`).
3. **`signedUrl` é relativo** (`ArtifactService.ts:125`) — WhatsApp (Meta/Evolution)
   busca a URL **server-to-server**, então precisa de **URL absoluta**
   (`APP_URL` + path assinado). O endpoint público já existe
   (`routes/artifacts.ts:43`). O PRD §13.4 pede exatamente "resolver o retorno
   relativo".
4. **Sem roteador de intenção de arquivo** — hoje `\bpdf\b` regex. O catálogo
   (F5.1) deve resolver **tipo × período × filtros × unidade × formato**
   reutilizando consultas de domínio **existentes** (não inventar consulta no
   webhook/gerador — PRD §13.1/§13.2). "Isso" = referência ao último resultado.
5. **Autorização em DOIS momentos** (§13.4): revalidar no **início da geração** e
   **antes da entrega** (incl. lista de artefatos e link). Já há `signedUrlForUser`/
   `getForUser`/`listForUser` por classificação — reusar, não recriar.
6. **Nada de inventar dados** (§13.2/§13.3): "qualquer arquivo" não é testável;
   zero ≠ dado ausente; fonte + instante da consulta impressos; período sem
   fechamento sinalizado.

## Recorte proposto (fatia-por-PR)

- **F5.0** — esta auditoria (doc-only). ✅
- **F5.1** — **catálogo + referência de recorte**: um resolvedor de pedido de
  arquivo (tipo/período/filtro/unidade/formato) plugado às consultas de domínio
  existentes + memória do "último resultado" pra reexportar "isso" com o **mesmo
  snapshot**; autorização revalidada. Sem gerar arquivo ainda (retorna o
  resultado estruturado + o que seria gerado). Teste determinístico.
- **F5.2** — **DOCX real**: gerador `buildDocx`/renderer OOXML wordprocessingml
  (editável, MIME/ext corretos) + `DOCX_MIME`, integrado ao `FalaTuReportService`
  (3º formato) e ao ArtifactService. `test:falatu-docx` que **abre** o .docx (unzip
  + partes OOXML), nunca só extensão.
- **F5.3** — **entrega tipada + URL absoluta + job durável**: `sendDocument`
  aceita `mimeType` (para de fixar PDF, compat default); resolver de **URL
  absoluta assinada** (`APP_URL`); job de preparação de arquivo genérico na
  `JobQueueService` (resposta "preparando…" + retomada sem duplicar).
- **F5.4** — **prova CA-07**: teste ponta-a-ponta pros 3 formatos (abrem no app
  correto, mesmos valores/período), **revogação** entre geração↔entrega, tamanho/
  limite do provedor, **fallback de link declarado** ("é link, não anexo"), e
  usuário sem permissão **não recebe nada**. Fecha o **Gate G5**.

## Guardrails (não regredir)

- **Compat de chamadores PDF** — `sendDocument`/`executiveSummary` mantêm default
  PDF; nenhum caller atual quebra.
- **Isolamento multi-tenant** — `orgId` 1º arg; artefato por org; link assinado
  por `${orgId}/${id}`.
- **CREATE-then-ALTER** — qualquer coluna nova em `artifacts`/settings é aditiva
  no fim.
- **Determinístico antes de IA** — geração e catálogo rodam em CI sem chave de IA
  (como `buildXlsx`/`FalaTuReportService`).
- **Sem inventar dados/arquivos** — catálogo fechado; ausência sinalizada; DOCX é
  arquivo real, nunca renomeado.
- **Autorização ≠ assinatura** — a URL assinada não substitui o RBAC; revalidar
  na geração e na entrega.
