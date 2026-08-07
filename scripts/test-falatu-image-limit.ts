// ADR-154 F11.2 — teto de imagem do FalaTu (captura → IA de visão).
//
// A captura manda a foto como base64 DENTRO do corpo JSON, então o teto real é
// ditado por TRÊS camadas empilhadas: cliente (downscale + cap final) →
// parser dedicado /api/falatu (server.ts) → MAX_MEDIA_B64 (validação de rota,
// DUPLICADA em routes/falatu.ts + routes/falatuIngest.ts). O bug clássico é
// uma camada subir e a outra não — então este teste guarda a INVARIANTE de
// empilhamento (um upload máximo do cliente cabe no check do backend, que cabe
// no parser) além do wiring do detail:"high" na visão.
//
// Sem DB, sem rede — só lê os arquivos do repo e checa números + tokens.

import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}`);
  if (!ok) failures++;
}

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const numAfter = (src: string, re: RegExp): number | null => {
  const m = src.match(re);
  return m ? Number(m[1].replace(/_/g, "")) : null;
};
const MB = 1024 * 1024;

const server = read("server.ts");
const falatuRoute = read("src/server/routes/falatu.ts");
const ingestRoute = read("src/server/routes/falatuIngest.ts");
const view = read("src/features/FalaTuView.tsx");
const llm = read("src/server/llm.ts");
const falatuSvc = read("src/server/FalaTuService.ts");
const purchaseSvc = read("src/server/FalaTuPurchaseService.ts");

// ---- Números das três camadas ----
const falatuBodyMb = numAfter(server, /falatuJson\s*=\s*express\.json\(\{\s*limit:\s*['"](\d+)mb['"]/);
const globalBodyMb = numAfter(server, /app\.use\(express\.json\(\{\s*limit:\s*['"](\d+)mb['"]/);
const mediaB64Falatu = numAfter(falatuRoute, /MAX_MEDIA_B64\s*=\s*([\d_]+)/);
const mediaB64Ingest = numAfter(ingestRoute, /MAX_MEDIA_B64\s*=\s*([\d_]+)/);
const clientUpload = numAfter(view, /MAX_UPLOAD_BYTES\s*=\s*([\d_]+)/);
const clientSource = numAfter(view, /MAX_SOURCE_IMAGE_BYTES\s*=\s*([\d_]+)/);
const clientMaxDim = numAfter(view, /IMAGE_MAX_DIM\s*=\s*([\d_]+)/);

check("server.ts define parser dedicado /falatu com limite", falatuBodyMb !== null);
check("server.ts mantém o parser global", globalBodyMb !== null);
check("routes/falatu.ts define MAX_MEDIA_B64", mediaB64Falatu !== null);
check("routes/falatuIngest.ts define MAX_MEDIA_B64", mediaB64Ingest !== null);
check("FalaTuView define MAX_UPLOAD_BYTES", clientUpload !== null);
check("FalaTuView define MAX_SOURCE_IMAGE_BYTES", clientSource !== null);
check("FalaTuView define IMAGE_MAX_DIM", clientMaxDim !== null);

// ---- Invariante de empilhamento (o que impede drift entre camadas) ----
check("os dois MAX_MEDIA_B64 (falatu + ingest) são iguais (sem drift)",
  mediaB64Falatu === mediaB64Ingest);

// Upload máximo do cliente (cru) vira ~4/3 em base64 e TEM que caber no check do backend.
if (clientUpload !== null && mediaB64Falatu !== null) {
  const clientAsB64 = Math.ceil(clientUpload * 4 / 3);
  check("upload máx do cliente (em base64) cabe no MAX_MEDIA_B64 do backend",
    clientAsB64 <= mediaB64Falatu);
}
// MAX_MEDIA_B64 (bytes da string base64) + envelope tem que caber no parser dedicado.
if (mediaB64Falatu !== null && falatuBodyMb !== null) {
  check("MAX_MEDIA_B64 + envelope cabe no parser dedicado do FalaTu",
    mediaB64Falatu + 512_000 < falatuBodyMb * MB);
}
// O FalaTu tem que ter MAIS folga que o resto da API (senão o esforço foi em vão).
if (falatuBodyMb !== null && globalBodyMb !== null) {
  check("parser do FalaTu é maior que o global (2mb da ADR-151)", falatuBodyMb > globalBodyMb);
}
// Origem aceita > cap final (o downscale existe justamente pra fechar essa folga).
if (clientSource !== null && clientUpload !== null) {
  check("origem aceita (pré-downscale) é maior que o cap final", clientSource > clientUpload);
}
// O novo teto é de fato MAIOR que o antigo "~1MB".
check("novo cap do cliente é bem maior que o antigo 1.3MB", (clientUpload || 0) > 1_300_000);

// ---- Ordenação do middleware em server.ts (o dedicado ANTES do global) ----
const idxFalatuMount = server.indexOf("app.use('/api/falatu', falatuJson)");
const idxIngestMount = server.indexOf("app.use('/api/falatu-ingest', falatuJson)");
const idxGlobalJson = server.search(/app\.use\(express\.json\(/);
check("parser dedicado montado em /api/falatu", idxFalatuMount >= 0);
check("parser dedicado montado em /api/falatu-ingest", idxIngestMount >= 0);
check("parser dedicado roda ANTES do global (req._body já setado)",
  idxFalatuMount >= 0 && idxGlobalJson >= 0 && idxFalatuMount < idxGlobalJson && idxIngestMount < idxGlobalJson);

// ---- Cliente: downscale em vez de rejeição pura ----
check("FalaTuView não rejeita mais em 1_300_000 (o teto antigo saiu)", !view.includes("1_300_000"));
check("FalaTuView tem prepareImage (downscale)", view.includes("prepareImage"));
check("prepareImage usa createImageBitmap + canvas.toBlob (JPEG)",
  view.includes("createImageBitmap") && view.includes("toBlob") && view.includes("image/jpeg"));
check("onImage passa pelo prepareImage antes de enviar",
  /const onImage[\s\S]{0,400}prepareImage/.test(view));
check("onCheckImage (conferência de compra) passa pelo prepareImage",
  /const onCheckImage[\s\S]{0,500}prepareImage/.test(view));

// ---- Visão: detail:"high" no caminho FalaTu, "auto" preservado nos demais ----
check("extractStructuredFromImage aceita param detail", /extractStructuredFromImage\([^)]*detail/.test(llm));
check("extractInvoiceItems aceita param detail", /extractInvoiceItems\([^)]*detail/.test(llm));
check("llm passa detail no image_url", /image_url:[\s\S]{0,90}detail\s*\}/.test(llm));
check("detail default é 'auto' (não muda custo dos outros consumidores)",
  (llm.match(/detail:\s*"auto"\s*\|\s*"low"\s*\|\s*"high"\s*=\s*"auto"/g) || []).length >= 2);
check("FalaTuService (captura) pede detail high", /extractStructuredFromImage\([\s\S]{0,200}"high"/.test(falatuSvc));
check("FalaTuPurchaseService (nota fiscal) pede detail high", /extractInvoiceItems\([^)]*"high"/.test(purchaseSvc));

console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
process.exit(failures === 0 ? 0 : 1);
