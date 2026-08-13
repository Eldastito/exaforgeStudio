/**
 * TEST — Hook Intelligence (PRD 11 / ADR-168 F3). DB-backed, determinístico (sem LLM).
 * Prova: ganchos grounded no tópico + objetivo + Brand DNA; padrões distintos; ordem pelo
 * objetivo; respeito à marca (termos PROIBIDOS filtrados, RN-CG-04); GROUNDED (RN-CG-09 —
 * sem tópico erro, identidade só com persona/público); isolamento multi-tenant.
 *
 * Uso: npm run test:hook-intelligence
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-hooks-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-hooks-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { HookIntelligenceService: HOOK } = await import("../src/server/HookIntelligenceService.js");
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");

  const orgA = `org_hk_${randomUUID().slice(0, 8)}`;
  const orgB = `org_hk_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  }

  // ── 1. Sem Brand DNA: ganchos genéricos grounded no tópico ──
  const g1 = await HOOK.generate(orgA, { topic: "camisa de linho", count: 3 });
  check("1.1 gera 3 ganchos", g1.hooks.length === 3);
  check("1.2 grounded no tópico (aparece no texto)", g1.hooks.every((h: any) => h.text.toLowerCase().includes("camisa de linho")));
  check("1.3 padrões distintos", new Set(g1.hooks.map((h: any) => h.pattern)).size === 3);
  check("1.4 brandGrounded false + caveat", g1.brandGrounded === false && g1.caveats.some((c: string) => /Brand DNA/.test(c)));
  check("1.5 sem persona → padrão identidade não sai", g1.hooks.every((h: any) => h.pattern !== "identidade"));

  // ── 2. Objetivo molda a ORDEM (vendas → ousada primeiro) ──
  const gv = await HOOK.generate(orgA, { topic: "camisa de linho", objectiveId: "vendas", count: 1 });
  check("2.1 vendas → 1º gancho é 'ousada'", gv.hooks[0].pattern === "ousada");
  const ge = await HOOK.generate(orgA, { topic: "camisa de linho", objectiveId: "educativo", count: 1 });
  check("2.2 educativo → 1º gancho é 'curiosidade'", ge.hooks[0].pattern === "curiosidade");
  check("2.3 objetivo desconhecido é ignorado (não quebra)", (await HOOK.generate(orgA, { topic: "x", objectiveId: "zzz" })).objectiveId === null);

  // ── 3. Brand DNA: persona habilita identidade + voz marca brandGrounded ──
  await BrandDnaService.save(orgA, "u", { persona: "Estilista acolhedora", audience: "mulheres 25-40", voice: "amiga que entende de moda" });
  const g3 = await HOOK.generate(orgA, { topic: "camisa de linho", objectiveId: "reativacao", count: 6 });
  check("3.1 brandGrounded true", g3.brandGrounded === true);
  check("3.2 identidade agora disponível", g3.hooks.some((h: any) => h.pattern === "identidade"));
  check("3.3 identidade usa o público/persona", g3.hooks.find((h: any) => h.pattern === "identidade")!.text.includes("mulheres 25-40"));

  // ── 4. Respeito à marca: termo PROIBIDO filtra o gancho (RN-CG-04) ──
  await BrandDnaService.save(orgA, "u", { forbidden: ["segredo"] });
  const g4 = await HOOK.generate(orgA, { topic: "camisa de linho", count: 6 });
  check("4.1 nenhum gancho contém termo proibido", g4.hooks.every((h: any) => !h.text.toLowerCase().includes("segredo")));
  check("4.2 caveat explica o descarte", g4.caveats.some((c: string) => /proibido/.test(c)));

  // ── 5. GROUNDED: sem tópico → erro; count clampeado ──
  let threw = false;
  try { await HOOK.generate(orgA, { topic: "  " }); } catch { threw = true; }
  check("5.1 sem tópico lança", threw);
  const gClamp = await HOOK.generate(orgA, { topic: "linho", count: 99 });
  check("5.2 count clampeado a 6", gClamp.count === 6 && gClamp.hooks.length <= 6);

  // ── 6. Isolamento multi-tenant (Brand DNA de A não vaza pro B) ──
  const g6 = await HOOK.generate(orgB, { topic: "camisa de linho", count: 6 });
  check("6.1 org B sem persona → sem identidade", g6.hooks.every((h: any) => h.pattern !== "identidade"));
  check("6.2 org B não herda proibições de A", g6.hooks.some((h: any) => h.text.toLowerCase().includes("segredo")));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} hook-intelligence: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
