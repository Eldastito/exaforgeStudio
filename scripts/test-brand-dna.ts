/**
 * TEST — Brand DNA 2.0 (PRD 11 / ADR-168 F1). DB-backed, determinístico.
 * Prova: identidade ESTRUTURADA (persona/público/posicionamento/proibições/do-don't) +
 * UNIFICAÇÃO da voz (brand_voice_context, ADR-155) + VERSIONAMENTO (histórico + restore) +
 * GROUNDED (RN-CG-09 — nunca inventa) + isolamento multi-tenant.
 *
 * Uso: npm run test:brand-dna
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-branddna-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-branddna-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { BrandDnaService } = await import("../src/server/BrandDnaService.js");
  const { GrimoireService } = await import("../src/server/GrimoireService.js");

  const orgA = `org_dna_${randomUUID().slice(0, 8)}`;
  const orgB = `org_dna_${randomUUID().slice(0, 8)}`;
  for (const o of [orgA, orgB]) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Loja', 'active', 'moda')`).run(`os-${o}`, o);
  }

  // ── 1. Schema aditivo presente ──
  const cols = (db.prepare(`PRAGMA table_info(brand_profiles)`).all() as any[]).map((c) => c.name);
  for (const c of ["persona", "audience", "positioning", "forbidden_json", "do_examples_json", "dont_examples_json", "dna_version", "dna_updated_at", "dna_updated_by"]) {
    check(`coluna brand_profiles.${c}`, cols.includes(c));
  }
  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brand_dna_versions'`).get();
  check("tabela brand_dna_versions existe", !!tbl);

  // ── 2. get() honesto num org vazio (RN-CG-09 — nunca inventa) ──
  const empty = await BrandDnaService.get(orgA);
  check("2.1 vazio: version 0", empty.version === 0);
  check("2.2 vazio: campos null (não inventa)", empty.persona === null && empty.positioning === null && empty.summary === null && empty.voice === null);
  check("2.3 vazio: arrays []", empty.palette.length === 0 && empty.forbidden.length === 0 && empty.doExamples.length === 0);
  check("2.4 vazio: completeness 0", empty.completeness === 0);
  check("2.5 vazio: voiceEnabled false", empty.voiceEnabled === false);

  // ── 3. save() estruturado sobe versão + completeness ──
  const v1 = await BrandDnaService.save(orgA, "user-1", {
    persona: "Especialista acolhedora e direta",
    audience: "Mulheres 25-40 que valorizam conforto",
    positioning: "Moda consciente e acessível",
    forbidden: ["barato", "liquidação total"],
    doExamples: ["mostrar o caimento real"],
    dontExamples: ["prometer milagre"],
    tone: "próximo",
  });
  check("3.1 save → version 1", v1.version === 1);
  check("3.2 persona gravada", v1.persona === "Especialista acolhedora e direta");
  check("3.3 forbidden gravado (2)", v1.forbidden.length === 2 && v1.forbidden.includes("barato"));
  check("3.4 do/dont gravados", v1.doExamples.length === 1 && v1.dontExamples.length === 1);
  check("3.5 completeness subiu (>0)", v1.completeness > 0);
  check("3.6 updatedBy registrado", v1.updatedBy === "user-1");

  // ── 4. Patch PARCIAL só toca o passado (grounded) ──
  const v2 = await BrandDnaService.save(orgA, "user-2", { positioning: "Moda consciente, feita pra durar" });
  check("4.1 patch → version 2", v2.version === 2);
  check("4.2 positioning atualizado", v2.positioning === "Moda consciente, feita pra durar");
  check("4.3 persona PRESERVADA (patch não apagou)", v2.persona === "Especialista acolhedora e direta");
  check("4.4 forbidden PRESERVADO", v2.forbidden.length === 2);

  // ── 5. Unificação da voz (brand_voice_context, ADR-155 — fonte única) ──
  const v3 = await BrandDnaService.save(orgA, "user-3", { voice: "Fala como amiga que entende de moda", voiceEnabled: true });
  check("5.1 voz no DNA", v3.voice === "Fala como amiga que entende de moda");
  check("5.2 voiceEnabled true", v3.voiceEnabled === true);
  const bv = await GrimoireService.getBrandVoice(orgA);
  check("5.3 voz gravada NO store canônico (brand_voice_context, não duplicada)", bv.context === "Fala como amiga que entende de moda" && bv.enabled === true);

  // ── 6. Versionamento: histórico + snapshot congelado ──
  const versions = BrandDnaService.versions(orgA);
  check("6.1 histórico tem 3 versões", versions.length === 3);
  check("6.2 histórico mais recente primeiro", versions[0].version === 3 && versions[2].version === 1);
  const snap1 = BrandDnaService.snapshot(orgA, 1);
  check("6.3 snapshot v1 congelado (positioning original)", snap1?.positioning === "Moda consciente e acessível");
  check("6.4 snapshot v1 sem a voz (que veio na v3)", (snap1?.voice ?? null) === null);

  // ── 7. restore() NÃO rebobina o contador (nova versão com conteúdo antigo) ──
  const restored = await BrandDnaService.restore(orgA, "user-4", 1);
  check("7.1 restore → version 4 (não rebobina)", restored.version === 4);
  check("7.2 restore trouxe o positioning da v1", restored.positioning === "Moda consciente e acessível");
  check("7.3 histórico agora tem 4", BrandDnaService.versions(orgA).length === 4);

  // ── 8. Isolamento multi-tenant ──
  const bEmpty = await BrandDnaService.get(orgB);
  check("8.1 org B intacto (persona null)", bEmpty.persona === null && bEmpty.version === 0);
  await BrandDnaService.save(orgB, "user-b", { persona: "Persona do B" });
  check("8.2 org B isolado", (await BrandDnaService.get(orgB)).persona === "Persona do B");
  check("8.3 org A não vazou pro B", (await BrandDnaService.get(orgA)).persona === "Especialista acolhedora e direta");
  check("8.4 versões de B não contam as de A", BrandDnaService.versions(orgB).length === 1);

  // ── 9. Restore de versão inexistente falha honesto ──
  let threw = false;
  try { await BrandDnaService.restore(orgA, "u", 99); } catch { threw = true; }
  check("9.1 restore de versão inexistente lança", threw);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} brand-dna: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
