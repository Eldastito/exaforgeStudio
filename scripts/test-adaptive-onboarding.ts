/**
 * TEST — Onboarding adaptativo (PRD 6 / ADR-163 F5). DB-backed, det., isolado.
 * Prova (§17-§25):
 *   - autodiscovery: perfil com fonte+confiança; conhecido vs lacuna;
 *   - RN-UX-6: NUNCA inventa — ausente vira "ainda não sei"/unknown, entra na fila;
 *   - ask-only-gaps (§21): nextQuestion = 1 lacuna por vez; completeness sobe ao gravar;
 *   - confirmation-first (§18-20): campo conhecido pede confirmação;
 *   - RN-UX-3: confirmar campo DESCRITIVO grava (+audit); campo MATERIAL (vertical) recusa;
 *   - flag refletida; multi-tenant.
 *
 * Uso: npm run test:adaptive-onboarding
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-onb-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-onb-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { AdaptiveOnboardingService: ONB } = await import("../src/server/AdaptiveOnboardingService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  // Org A: nome + vertical conhecidos; segmento + contato AUSENTES (lacunas); flag ON.
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, plan_id, billing_status, adaptive_onboarding_enabled) VALUES (?, ?, 'Padaria Pão Quente', 'active', 'varejo', 'autonomo', 'active', 1)`).run(randomUUID(), A);
  // Org B: quase vazia (só o mínimo) — muitas lacunas; flag OFF.
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status, adaptive_onboarding_enabled) VALUES (?, ?, NULL, 'active', 'autonomo', 'active', 0)`).run(randomUUID(), B);
  const actor = "u1";

  // ═══════════════ 1. autodiscovery com fonte+confiança ═══════════════
  const d = ONB.discover(A);
  const f = (k: string) => d.profile.find((x: any) => x.key === k)!;
  check("1.1 nome conhecido (fonte+confiança alta)", f("businessName").status === "known" && f("businessName").value === "Padaria Pão Quente" && f("businessName").confidence === "alta" && f("businessName").source === "organization_settings");
  check("1.2 vertical conhecido", f("vertical").status === "known" && f("vertical").value === "varejo");
  check("1.3 flag refletida (ON em A)", d.adaptiveOnboardingEnabled === true);

  // ═══════════════ 2. RN-UX-6 — nunca inventa ═══════════════
  check("2.1 segmento AUSENTE → 'ainda não sei'/unknown (não inventa)", f("segment").status === "unknown" && f("segment").displayValue === "ainda não sei" && f("segment").value === null);
  check("2.2 contato ausente → unknown com pergunta", f("contact").status === "unknown" && !!f("contact").question);
  check("2.3 sem loja cadastrada → unidades INCERTO (não zero-inventado)", f("units").status === "uncertain" && f("units").value === null);

  // ═══════════════ 3. ask-only-gaps (§21) + confirmation-first ═══════════════
  check("3.1 gaps só o não-conhecido", d.gaps.every((g: any) => g.status !== "known") && d.gaps.length >= 3);
  check("3.2 nextQuestion = 1 pergunta por vez", typeof d.nextQuestion === "string" && d.nextQuestion!.length > 0);
  check("3.3 campo conhecido pede confirmação (confirmation-first)", f("businessName").needsConfirmation === true);
  check("3.4 completeness < 1 (há lacunas)", d.completeness < 1 && d.completeness > 0);

  // ═══════════════ 4. RN-UX-3 — confirmar descritivo grava; material recusa ═══════════════
  const okSeg = ONB.confirm(A, actor, { key: "segment", value: "Padaria artesanal" });
  check("4.1 confirmar segmento (descritivo) grava", okSeg.applied === true && okSeg.value === "Padaria artesanal");
  const d2 = ONB.discover(A);
  check("4.2 após gravar: segmento vira conhecido + completeness sobe", d2.profile.find((x: any) => x.key === "segment")!.status === "known" && d2.completeness > d.completeness);
  const audited = (db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'ONBOARDING_FIELD_CONFIRMED'`).get(A) as any).n;
  check("4.3 confirmação auditada", audited >= 1);
  const rejVert = ONB.confirm(A, actor, { key: "vertical", value: "clinica" });
  check("4.4 confirmar VERTICAL (material) é RECUSADO (RN-UX-3)", rejVert.applied === false && /RN-UX-3|blueprint|libera/i.test(rejVert.reason || ""));
  check("4.5 vertical NÃO mudou no banco (recusa não grava)", (db.prepare(`SELECT vertical v FROM organization_settings WHERE organization_id = ?`).get(A) as any).v === "varejo");
  const rejEmpty = ONB.confirm(A, actor, { key: "businessName", value: "  " });
  check("4.6 valor vazio não grava", rejEmpty.applied === false);

  // ═══════════════ 5. multi-tenant + flag OFF ═══════════════
  const dB = ONB.discover(B);
  check("5.1 org B isolada: nome é lacuna (não vê 'Padaria' de A)", dB.profile.find((x: any) => x.key === "businessName")!.status === "unknown");
  check("5.2 flag OFF em B", dB.adaptiveOnboardingEnabled === false);

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} adaptive-onboarding: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
