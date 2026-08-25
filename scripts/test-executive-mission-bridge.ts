/**
 * TEST — Executive → Mission Bridge (ADR-190 F6, CEO Operating Layer). De um desvio
 * que AMEAÇA UMA META declarada, SUGERE (nunca cria — RN-CEO-06) a missão que a
 * endereça. Rascunho ancorado no alvo REAL da meta; sem meta mapeável → sem rascunho
 * (não inventa alvo, RN-CEO-11); missão já existente → alreadyCovered.
 *
 * Uso: npm run test:executive-mission-bridge
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-embridge-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-embridge-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveMissionBridgeService: B } = await import("../src/server/ExecutiveMissionBridgeService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService } = await import("../src/server/BusinessGoalService.js");
  const { MissionService } = await import("../src/server/MissionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), A);

  // ── 1. Sem desvio → nenhuma sugestão (honesto) ──
  const r0 = B.suggest(A);
  check("1.1 sem desvio → 0 sugestões", r0.suggestions.length === 0);
  check("1.2 missionLayerEnabled false por padrão", r0.missionLayerEnabled === false);

  // ── 2. Desvio SEM meta declarada → registra sem rascunho (não inventa alvo) ──
  BusinessSignalService.publish(A, {
    domain: "sales", signalType: "conversion_drop", severity: "risk", basis: "fact", confidence: 0.8,
    sourceService: "test", evidence: { pct: -25 }, dedupeKey: "sales-drop-1",
  });
  const r1 = B.suggest(A);
  check("2.1 desvio sem meta → sugestão sem rascunho (draft null)", r1.suggestions.length >= 1 && r1.suggestions[0].draft === null);
  check("2.2 razão explica que falta meta", r1.suggestions[0].reason.includes("sem meta"));

  // ── 3. Meta declarada ATRASADA + desvio no domínio → rascunho com alvo REAL ──
  // revenue mapeia p/ domínio "sales"; alvo alto + org sem venda → meta "behind".
  BusinessGoalService.set(A, { metric: "revenue", targetAmount: 100000, actor: "u1" });
  const r2 = B.suggest(A);
  const s = r2.suggestions.find((x: any) => x.draft);
  check("3.1 agora há rascunho de missão", !!s && !!s.draft);
  check("3.2 rascunho ancora targetMetric=revenue + targetValue=100000 (alvo REAL)", s?.draft?.targetMetric === "revenue" && s?.draft?.targetValue === 100000);
  check("3.3 origem válida p/ o dono criar direto (system_proposed)", s?.draft?.source === "system_proposed");
  check("3.4 é hipótese, não causa provada", s?.basis === "hypothesis");
  check("3.5 nada foi criado (bridge read-only)", MissionService.list(A).length === 0);

  // ── 4. Missão já existente pra a métrica → alreadyCovered (não duplica) ──
  MissionService.setEnabled(A, true, "u1");
  MissionService.create(A, { title: "Recuperar faturamento", targetMetric: "revenue", targetValue: 100000, source: "user" }, "u1");
  const r3 = B.suggest(A);
  const s3 = r3.suggestions.find((x: any) => x.draft?.targetMetric === "revenue");
  check("4.1 missão viva pra revenue → alreadyCovered true", s3?.alreadyCovered === true);
  check("4.2 missionLayerEnabled agora true", r3.missionLayerEnabled === true);

  // ── 5. Isolamento multi-tenant ──
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), C);
  check("5.1 org C sem sugestões", B.suggest(C).suggestions.length === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-mission-bridge: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
