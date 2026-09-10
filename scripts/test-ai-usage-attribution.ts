/**
 * TESTE — atribuição de custo de IA por MÓDULO/USUÁRIO no caminho autenticado.
 * ----------------------------------------------------------------------------
 * Gap (ANALISE-ESTADO-FINAL §6): o middleware do protectedApi usava setUsageOrg,
 * que zera userId e força module='legacy'. Toda chamada de IA de rota
 * autenticada (Studio/Executive/Prospects/…) ficava atribuída à org, mas SEM
 * módulo nem usuário — custo-por-módulo/usuário impossível.
 *
 * Esta fatia deriva o `module` do 1º segmento da rota (`moduleFromApiPath`) e
 * passa userId, via `setUsageContext`. Prova:
 *  - moduleFromApiPath mapeia o segmento corretamente (e 'legacy' sem segmento);
 *  - o contexto (module + userId + org) PROPAGA através de awaits (AsyncLocalStorage);
 *  - guarda de fiação: server.ts atribui module/userId (não mais só a org).
 *
 * Uso:  npm run test:ai-usage-attribution
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ai-usage-attr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ai-usage-attr-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { moduleFromApiPath, setUsageContext, currentUsageContext, usageContext } = await import("../src/server/usageContext.js");

  // ── 1. derivação do módulo a partir do path ──
  check("1.1 /studio/brand-dna → studio", moduleFromApiPath("/studio/brand-dna") === "studio");
  check("1.2 /executive/analyze → executive", moduleFromApiPath("/executive/analyze") === "executive");
  check("1.3 segmento único /insights → insights", moduleFromApiPath("/insights") === "insights");
  check("1.4 caixa alta normaliza → prospects", moduleFromApiPath("/Prospects/x") === "prospects");
  check("1.5 raiz '/' → legacy", moduleFromApiPath("/") === "legacy");
  check("1.6 vazio → legacy", moduleFromApiPath("") === "legacy");

  // ── 2. propagação por AsyncLocalStorage (o que o middleware faz por requisição) ──
  const seen = await usageContext.run(
    { orgId: "org-1", userId: "user-9", module: moduleFromApiPath("/studio/x"), correlationId: null },
    async () => {
      await new Promise((r) => setTimeout(r, 5)); // await: contexto tem que sobreviver
      return currentUsageContext();
    },
  );
  check("2.1 module propaga após await", seen.module === "studio");
  check("2.2 userId propaga após await", seen.userId === "user-9");
  check("2.3 org propaga após await", seen.orgId === "org-1");

  // ── 3. requisições concorrentes não vazam contexto entre si ──
  const [a, b] = await Promise.all([
    usageContext.run({ orgId: "orgA", userId: "uA", module: "studio", correlationId: null }, async () => { await new Promise((r) => setTimeout(r, 8)); return currentUsageContext(); }),
    usageContext.run({ orgId: "orgB", userId: "uB", module: "executive", correlationId: null }, async () => { await new Promise((r) => setTimeout(r, 2)); return currentUsageContext(); }),
  ]);
  check("3.1 contexto A isolado", a.orgId === "orgA" && a.module === "studio" && a.userId === "uA");
  check("3.2 contexto B isolado", b.orgId === "orgB" && b.module === "executive" && b.userId === "uB");

  // ── 4. setUsageContext normaliza module (lowercase) e default legacy ──
  setUsageContext({ orgId: "o", userId: "u", module: "Studio" });
  check("4.1 setUsageContext lowercased", currentUsageContext().module === "studio");
  setUsageContext({ orgId: "o" });
  check("4.2 setUsageContext sem module → legacy", currentUsageContext().module === "legacy");

  // ── 5. guarda de FIAÇÃO: server.ts atribui module/userId (não mais só a org) ──
  let server = "";
  try { server = fs.readFileSync(path.resolve(new URL("..", import.meta.url).pathname, "server.ts"), "utf8"); } catch { /* */ }
  check("5.1 server.ts usa setUsageContext (não só setUsageOrg)", /setUsageContext\(\s*\{[\s\S]*?module:\s*moduleFromApiPath\(req\.path\)/.test(server));
  check("5.2 server.ts atribui userId no contexto de IA", /userId:\s*req\.user\?\.userId/.test(server));
  check("5.3 server.ts não regride pra setUsageOrg no protectedApi", !/setUsageOrg\(/.test(server));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} ai-usage-attribution: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
