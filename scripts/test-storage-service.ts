/**
 * TESTE — Storage plugável (StorageService) e integração com ReportPdfService
 * ------------------------------------------------------------------
 * Sem credenciais/bucket S3 reais disponíveis neste ambiente, o foco é a
 * garantia que mais importa: o mirror para S3 é SEMPRE best-effort — desligado
 * por padrão (comportamento local inalterado) e, mesmo configurado, uma falha
 * de rede/credencial NUNCA derruba quem chamou (PDF/backup continuam
 * funcionando pelo disco local).
 *
 * Uso: npm run test:storage-service
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-storage-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-storage-1234567890";
process.env.APP_URL = "https://app.teste.local";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { StorageService } = await import("../src/server/StorageService.js");
  const { ReportPdfService } = await import("../src/server/ReportPdfService.js");

  // ---- Desligado por padrão ----
  check("S3 desligado por padrão (sem nenhuma env configurada)", StorageService.isS3Enabled() === false);

  const scratchFile = path.join(tmpDir, "arquivo-teste.txt");
  fs.writeFileSync(scratchFile, "conteúdo de teste");
  const mirrorDisabled = await StorageService.mirrorToS3(scratchFile, "qualquer/coisa.txt");
  check("mirrorToS3 é no-op quando S3 está desligado (stored:false, sem lançar)", mirrorDisabled.stored === false);

  // ---- PDF continua funcionando normalmente com S3 desligado (baseline) ----
  const pdfLocal = await ReportPdfService.generateManagerReport("org_teste", {
    title: "Relatório de teste", summary: "Resumo", panorama: "Panorama do negócio",
  });
  check("ReportPdfService funciona normalmente com S3 desligado", !!pdfLocal?.url, `url=${pdfLocal?.url}`);
  check("URL do PDF é local (APP_URL + /media/reports) quando S3 está desligado",
    !!pdfLocal?.url && pdfLocal.url.startsWith("https://app.teste.local/media/reports/"));

  // ---- "Ligado" mas apontando para um destino que não existe: nunca deve quebrar ----
  process.env.S3_ENABLED = "true";
  process.env.S3_BUCKET = "bucket-que-nao-existe";
  process.env.S3_ENDPOINT = "http://127.0.0.1:1"; // porta que garantidamente recusa conexão
  process.env.S3_ACCESS_KEY_ID = "fake";
  process.env.S3_SECRET_ACCESS_KEY = "fake";
  process.env.S3_FORCE_PATH_STYLE = "true";

  check("isS3Enabled() reflete a configuração quando ligado", StorageService.isS3Enabled() === true);

  let threw = false;
  let mirrorBroken: any = null;
  try {
    mirrorBroken = await StorageService.mirrorToS3(scratchFile, "qualquer/coisa.txt");
  } catch (e) {
    threw = true;
  }
  check("mirrorToS3 NUNCA lança, mesmo com endpoint inalcançável", !threw);
  check("mirrorToS3 reporta stored:false quando o upload falha", mirrorBroken?.stored === false);

  // O ponto mais importante: gerar o PDF continua funcionando (arquivo local
  // OK) mesmo com o S3 mal configurado — o mirror falho não pode quebrar a
  // geração do relatório.
  const pdfWithBrokenS3 = await ReportPdfService.generateManagerReport("org_teste", {
    title: "Relatório com S3 quebrado", summary: "Resumo", panorama: "Panorama",
  });
  check("Geração de PDF sobrevive a um S3 mal configurado (fallback para local)", !!pdfWithBrokenS3?.url);
  check("URL cai para local quando o mirror S3 falha", !!pdfWithBrokenS3?.url && pdfWithBrokenS3.url.includes("/media/reports/"));

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — STORAGE PLUGÁVEL (S3 OPCIONAL)");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 STORAGE LOCAL PRESERVADO; MIRROR S3 NUNCA QUEBRA O FLUXO.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de storage:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
