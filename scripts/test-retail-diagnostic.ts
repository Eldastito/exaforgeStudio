/**
 * TESTE — ADR-084 D3/D6: diagnóstico + motor de composição (prévia)
 * ----------------------------------------------------------------
 * Prova, offline, o motor de recomendação (função pura):
 *   - as 7 perguntas estão expostas;
 *   - rede multiloja + metas + PDV externo → retail + modo supervised;
 *   - loja única nativa (sem PDV) → sem retail + modo native;
 *   - e-commerce liga o módulo loja; variações são capacidade disponível;
 *   - peso/receita entram como capacidade "por vir" (available=false) + nota;
 *   - multiloja sem PDV externo gera aviso de nativo indisponível.
 *
 * Uso:  npm run test:retail-diagnostic
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-diag-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-diag-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  await import("../src/server/db.js");
  const { RetailDiagnosticService } = await import("../src/server/RetailDiagnosticService.js");
  const cap = (r: any, key: string) => r.capabilities.find((c: any) => c.key === key);

  check("Expõe as 7 perguntas", RetailDiagnosticService.questions().length === 7);

  // ---- TOULON: rede multiloja, metas, PDV externo ----
  const toulon = RetailDiagnosticService.recommend({ units: "multi", storeOps: true, externalPdv: true, variants: true, channels: ["whatsapp", "balcao"] });
  check("Rede+metas → recomenda retail", toulon.retailNetworkOps === true && toulon.modules.includes("retail"));
  check("PDV externo → modo supervised", toulon.stockMode === "supervised");
  check("Variações → capacidade disponível", cap(toulon, "variants")?.available === true);

  // ---- Loja única nativa (sem PDV) ----
  const single = RetailDiagnosticService.recommend({ units: "single", storeOps: false, externalPdv: false, channels: ["whatsapp", "ecommerce"] });
  check("Loja única sem metas → NÃO recomenda retail", single.retailNetworkOps === false && !single.modules.includes("retail"));
  check("Sem PDV externo → modo native", single.stockMode === "native");
  check("E-commerce → liga o módulo loja", single.modules.includes("loja"));

  // ---- Perecível / produção: capacidades por vir ----
  const bakery = RetailDiagnosticService.recommend({ units: "single", saleUnit: "weight", production: true, channels: ["balcao", "delivery"] });
  check("Peso → capacidade 'weight' por vir (available=false)", cap(bakery, "weight")?.available === false);
  check("Produção → capacidade 'recipe' por vir (available=false)", cap(bakery, "recipe")?.available === false);
  check("Gera notas de roadmap (peso/produção)", bakery.notes.some((n: string) => /peso|receita|produção/i.test(n)));

  // ---- Multiloja sem PDV externo → aviso de nativo indisponível ----
  const multiNative = RetailDiagnosticService.recommend({ units: "multi", storeOps: true, externalPdv: false });
  check("Multiloja sem PDV → aviso de multiloja nativo indisponível", multiNative.notes.some((n: string) => /multiloja nativo/i.test(n)) && multiNative.stockMode === "native");

  console.log("\n=== ADR-084 D3/D6: diagnóstico + motor de composição (prévia) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
