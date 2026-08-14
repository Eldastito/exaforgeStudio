/**
 * TEST — Zero-Trust tenant boundary (SEC-F4 / SEC-02, achado A5). Determinístico.
 *
 * Prova que o tenant é resolvido SOMENTE do JWT VERIFICADO — o header `x-organization-id`
 * enviado pelo cliente NUNCA é autoridade: um header forjado não muda o org; sem token válido
 * o resolvedor devolve null (o chamador não decide tenant por header spoofável).
 *
 * Uso: npm run test:security-tenant
 */
import jwt from "jsonwebtoken";
process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-sec-tenant-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { resolveTokenOrg } = await import("../src/server/middleware/auth.js");
  const SECRET = process.env.JWT_SECRET!;
  const tokenFor = (org: string) => jwt.sign({ userId: "u", organizationId: org, email: "a@b.com", role: "owner" }, SECRET);
  const req = (headers: Record<string, string | undefined>) => ({ headers } as any);

  // ── 1. Token válido do org A + header FORJADO org B → resolve A (header ignorado) ──
  const forged = req({ authorization: `Bearer ${tokenFor("orgA")}`, "x-organization-id": "orgB" });
  check("1.1 tenant vem do TOKEN, não do header forjado", resolveTokenOrg(forged) === "orgA");

  // ── 2. Só header, sem token → null (header nunca é autoridade) ──
  check("2.1 só header (sem token) → null", resolveTokenOrg(req({ "x-organization-id": "orgB" })) === null);

  // ── 3. Token inválido/adulterado → null (nunca cai pro header) ──
  check("3.1 token adulterado → null", resolveTokenOrg(req({ authorization: "Bearer lixo.invalido.xxx", "x-organization-id": "orgB" })) === null);
  check("3.2 token assinado com OUTRO segredo → null", resolveTokenOrg(req({ authorization: `Bearer ${jwt.sign({ organizationId: "orgB" }, "outro-segredo")}` })) === null);

  // ── 4. Sem Authorization → null ──
  check("4.1 sem Authorization → null", resolveTokenOrg(req({})) === null);
  check("4.2 Authorization sem token → null", resolveTokenOrg(req({ authorization: "Bearer" })) === null);

  // ── 5. Token válido sem header → resolve o org do token ──
  check("5.1 token sem header → org do token", resolveTokenOrg(req({ authorization: `Bearer ${tokenFor("orgC")}` })) === "orgC");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-tenant: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
