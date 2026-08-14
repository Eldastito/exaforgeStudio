/**
 * TEST — Upload magic-byte validation (SEC-F10 / achado A9). Puro/determinístico.
 *
 * Prova que a mídia é validada por CONTEÚDO (magic bytes), não pela extensão/MIME do cliente:
 * imagens reais (png/jpeg/webp/gif) passam com a extensão DERIVADA do conteúdo; qualquer outra
 * coisa (texto, script, PDF, base64 lixo) é REJEITADA (null) — nada arbitrário vai pro /media.
 *
 * Uso: npm run test:security-media-upload
 */
const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { validateImageBase64, detectImageMime } = await import("../src/server/mediaValidation.js");

  // Assinaturas reais (magic bytes) — só o cabeçalho basta pro sniff.
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
  const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
  const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
  const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]; // RIFF....WEBP

  // ── 1. Imagens reais passam, extensão DERIVADA do conteúdo ──
  check("1.1 PNG real → aceito, ext png", validateImageBase64(b64(PNG))?.ext === "png");
  check("1.2 JPEG real → aceito, ext jpg", validateImageBase64(b64(JPEG))?.ext === "jpg");
  check("1.3 GIF real → aceito, ext gif", validateImageBase64(b64(GIF))?.ext === "gif");
  check("1.4 WEBP real → aceito, ext webp", validateImageBase64(b64(WEBP))?.ext === "webp");

  // ── 2. A extensão vem do CONTEÚDO, não do rótulo do cliente ──
  //     (mesmo que o cliente jurasse "jpg", um PNG real é gravado como .png)
  check("2.1 conteúdo PNG → mime image/png (não confia no rótulo)", validateImageBase64(b64(PNG))?.mime === "image/png");

  // ── 3. Conteúdo NÃO-imagem é REJEITADO (nada arbitrário no /media público) ──
  const SCRIPT = Array.from(Buffer.from("<?php system($_GET[0]); ?>")); // payload perigoso
  const HTML = Array.from(Buffer.from("<html><script>alert(1)</script>"));
  const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF- (não é imagem → rejeita aqui)
  const TXT = Array.from(Buffer.from("apenas texto"));
  check("3.1 script PHP → REJEITADO (null)", validateImageBase64(b64(SCRIPT)) === null);
  check("3.2 HTML/JS → REJEITADO", validateImageBase64(b64(HTML)) === null);
  check("3.3 PDF (não é imagem) → REJEITADO no sink de imagem", validateImageBase64(b64(PDF)) === null);
  check("3.4 texto puro → REJEITADO", validateImageBase64(b64(TXT)) === null);

  // ── 4. Entradas degeneradas → null (nunca grava) ──
  check("4.1 base64 vazio → null", validateImageBase64("") === null);
  check("4.2 buffer curto demais → null", validateImageBase64(b64([0x89])) === null);
  check("4.3 detectImageMime de lixo → null", detectImageMime(Buffer.from([1, 2, 3, 4, 5])) === null);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-media-upload: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
