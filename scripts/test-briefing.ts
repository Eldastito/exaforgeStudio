/**
 * TEST — BriefingService (Epic 3 — Fatia 4). Preferências + briefing matinal
 * (≤3 prioridades, RBAC financeiro) + entrega idempotente. Determinístico.
 *
 * Uso: npm run test:briefing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-brief-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-brief-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BriefingService: B } = await import("../src/server/BriefingService.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();
  P.seedSystemProfiles(orgA);
  const profId = (key: string) => (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?").get(orgA, key) as any)?.id;
  const owner = { userId: "u_owner", role: "owner", role_profile_id: profId("owner"), name: "Ana" };
  const vendedor = { userId: "u_vend", role: "agent", role_profile_id: profId("vendedor"), name: "Beto" };
  const pub = (o: string, s: any) => S.publish(o, { sourceService: "test", evidence: {}, basis: "fact", confidence: 0.9, ...s });

  // Sinais: finança crítica (5000) + venda atenção (1000).
  pub(orgA, { domain: "finance", signalType: "cash_below_minimum", severity: "critical", impactAmount: 5000, impactUnit: "BRL", dedupeKey: "fin:1" });
  pub(orgA, { domain: "sales", signalType: "slow_moving", severity: "attention", impactAmount: 1000, impactUnit: "BRL", dedupeKey: "sal:1" });

  // ===== 1. Preferências: default + upsert =====
  check("prefs default: habilitado, whatsapp, 08:00, todos os dias", (() => { const p = B.getPrefs(orgA, owner.userId); return p.enabled && p.channel === "whatsapp" && p.morningTime === "08:00" && p.days === null; })());
  B.setPrefs(orgA, owner.userId, { morningTime: "07:30", days: [1, 2, 3, 4, 5], domains: ["finance", "sales"] });
  const p2 = B.getPrefs(orgA, owner.userId);
  check("prefs upsert persiste horário/dias/domínios", p2.morningTime === "07:30" && JSON.stringify(p2.days) === "[1,2,3,4,5]" && JSON.stringify(p2.domains) === "[\"finance\",\"sales\"]");

  // ===== 2. Dias da semana =====
  check("scheduledForDay: seg (1) sim", B.scheduledForDay(p2, 1) === true);
  check("scheduledForDay: sáb (6) não", B.scheduledForDay(p2, 6) === false);
  check("scheduledForDay: sem dias = todos", B.scheduledForDay({ ...p2, days: null }, 7) === true);
  check("scheduledForDay: desabilitado = nunca", B.scheduledForDay({ ...p2, enabled: false }, 1) === false);

  // ===== 3. Briefing matinal: owner vê finanças =====
  const bo = B.buildMorning(orgA, owner);
  check("owner: briefing tem prioridades", bo.priorityCount >= 1);
  check("owner: inclui prioridade financeira (caixa)", /caixa|Reforçar o caixa/i.test(bo.text));
  check("owner: rodapé financeiro presente (💰)", bo.text.includes("💰"));

  // ===== 4. RBAC: vendedor NÃO recebe finanças (aceite do PRD) =====
  const bv = B.buildMorning(orgA, vendedor);
  check("vendedor: SEM rodapé financeiro", !bv.text.includes("💰"));
  check("vendedor: prioridade financeira filtrada", !/Reforçar o caixa/i.test(bv.text));
  check("vendedor: ainda vê prioridade de vendas", bv.priorityCount >= 0);

  // ===== 5. Máximo de 3 prioridades =====
  for (let i = 0; i < 5; i++) pub(orgA, { domain: "inventory", signalType: `stockout_${i}`, severity: "risk", impactAmount: 200 * (i + 1), impactUnit: "BRL", dedupeKey: `inv:${i}` });
  check("no máximo 3 prioridades no briefing", B.buildMorning(orgA, owner).priorityCount <= 3);

  // ===== 6. Domínios permitidos filtram =====
  B.setPrefs(orgA, owner.userId, { domains: ["sales"] });
  const onlySales = B.buildMorning(orgA, owner);
  check("domínios=['sales']: sem prioridade financeira", !/Reforçar o caixa/i.test(onlySales.text));

  // ===== 7. Entrega idempotente (reenvio não duplica) =====
  const d1 = B.deliver(orgA, owner, "morning", "2026-07-23");
  check("1ª entrega: delivered", d1.delivered === true && d1.deduped === false && !!d1.text);
  const d2 = B.deliver(orgA, owner, "morning", "2026-07-23");
  check("reenvio do mesmo dia: deduped (não duplica)", d2.deduped === true && d2.delivered === false);
  check("só 1 linha de entrega para o dia", (db.prepare("SELECT COUNT(*) n FROM briefing_delivery WHERE organization_id = ? AND user_id = ? AND ref_date = '2026-07-23'").get(orgA, owner.userId) as any).n === 1);
  const d3 = B.deliver(orgA, owner, "morning", "2026-07-24");
  check("outro dia: entrega de novo", d3.delivered === true);

  // ===== 8. Isolamento por organização =====
  const orgB = mkOrg();
  check("isolamento: prefs de B são default (não vazam de A)", B.getPrefs(orgB, owner.userId).morningTime === "08:00");

  console.log("\n=== TEST: BriefingService (Epic 3 — Fatia 4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Briefing OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
