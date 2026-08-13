/**
 * TEST — Script Intelligence (PRD 11 / ADR-168 F4). DB-backed, determinístico (sem LLM).
 * Prova: roteiro/storyboard estruturado (5 beats: gancho→contexto→demonstração→prova→CTA);
 * beat 1 REUSA o gancho da F3; CTA vem do OBJETIVO; duração por FORMATO; grounded no tópico
 * + Brand DNA; respeito à marca (termo PROIBIDO saneia beat, RN-CG-04); sem tópico erro
 * (RN-CG-09); isolamento multi-tenant.
 *
 * Uso: npm run test:script-intelligence
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-script-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-script-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ScriptIntelligenceService: SCR } = await import("../src/server/ScriptIntelligenceService.js");
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");

  const orgA = `org_sc_${randomUUID().slice(0, 8)}`;
  const orgB = `org_sc_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  }

  // ── 1. Estrutura base (reels, sem objetivo) ──
  const s1 = await SCR.generate(orgA, { topic: "camisa de linho" });
  check("1.1 formato default reels", s1.format === "reels");
  check("1.2 tem 5 beats na ordem", s1.beats.length === 5 && s1.beats.map((b: any) => b.order).join(",") === "1,2,3,4,5");
  check("1.3 labels esperados", s1.beats.map((b: any) => b.label).join("|") === "Gancho|Contexto|Demonstração|Prova|CTA");
  check("1.4 beat 1 = hook (reusa F3)", s1.beats[0].script === s1.hook);
  check("1.5 grounded no tópico", s1.beats.some((b: any) => b.script.toLowerCase().includes("camisa de linho")));
  check("1.6 totalDuration = soma dos beats", s1.totalDurationSec === s1.beats.reduce((a: number, b: any) => a + b.durationSec, 0));
  check("1.7 sem objetivo → CTA default", s1.beats[4].script === "Fala com a gente pra saber mais.");
  check("1.8 sem marca → brandGrounded false + caveat", s1.brandGrounded === false && s1.caveats.some((c: string) => /Brand DNA/.test(c)));

  // ── 2. CTA vem do OBJETIVO ──
  const sv = await SCR.generate(orgA, { topic: "camisa de linho", objectiveId: "vendas" });
  check("2.1 vendas → CTA de venda", sv.beats[4].script.includes("link na bio"));
  const sa = await SCR.generate(orgA, { topic: "camisa de linho", objectiveId: "agendamento" });
  check("2.2 agendamento → CTA de agendar", sa.beats[4].script.includes("Agende"));

  // ── 3. Duração por FORMATO ──
  const sStory = await SCR.generate(orgA, { topic: "linho", format: "story" });
  check("3.1 story mais curto que reels", sStory.totalDurationSec < s1.totalDurationSec);
  check("3.2 story soma 14s", sStory.totalDurationSec === 14);
  const sPost = await SCR.generate(orgA, { topic: "linho", format: "post" });
  check("3.3 post soma 19s", sPost.totalDurationSec === 19);
  check("3.4 formato inválido cai pra reels", (await SCR.generate(orgA, { topic: "x", format: "xyz" as any })).format === "reels");

  // ── 4. Brand DNA: voz entra na demonstração + brandGrounded ──
  await BrandDnaService.save(orgA, "u", { voice: "leve e direto", persona: "estilista", audience: "mulheres 25-40" });
  const s4 = await SCR.generate(orgA, { topic: "camisa de linho" });
  check("4.1 brandGrounded true", s4.brandGrounded === true);
  check("4.2 voz entra no roteiro", s4.beats.some((b: any) => b.script.includes("leve e direto")));
  check("4.3 gancho reusa persona/público (F3 identidade possível)", typeof s4.hook === "string" && s4.hook.length > 0);

  // ── 5. Respeito à marca: termo PROIBIDO saneia o beat (RN-CG-04) ──
  await BrandDnaService.save(orgA, "u", { forbidden: ["prova"] });
  const s5 = await SCR.generate(orgA, { topic: "camisa de linho" });
  check("5.1 nenhum beat contém termo proibido", s5.beats.every((b: any) => !b.script.toLowerCase().includes("prova")));
  check("5.2 caveat explica o saneamento", s5.caveats.some((c: string) => /saneado/.test(c)));

  // ── 6. GROUNDED: sem tópico → erro ──
  let threw = false;
  try { await SCR.generate(orgA, { topic: "   " }); } catch { threw = true; }
  check("6.1 sem tópico lança", threw);

  // ── 7. Isolamento multi-tenant ──
  const s7 = await SCR.generate(orgB, { topic: "camisa de linho" });
  check("7.1 org B sem marca (não herda voz de A)", s7.brandGrounded === false);
  check("7.2 org B não herda proibições de A", s7.beats.some((b: any) => b.script.toLowerCase().includes("prova")));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} script-intelligence: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
