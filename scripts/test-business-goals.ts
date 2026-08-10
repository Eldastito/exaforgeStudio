/**
 * TEST — ADR-160 F4 (Onda A / D4): metas do negócio + distância à meta.
 *
 * Prova, determinístico:
 *   - inerte por padrão: sem meta, list/progress vazios + bloco do Diretor some;
 *   - set() faz upsert por (org, metric); valida métrica conhecida + alvo > 0;
 *   - progress() DERIVA o realizado (receita do snapshot D2; atendimentos do
 *     Analytics) e calcula remaining/attainmentPct/reached corretamente;
 *   - pace determinístico via asOf (esperado-proporcional-ao-dia; on_track/behind);
 *   - remove() é idempotente;
 *   - Diretor.goalsBlock só aparece quando há meta;
 *   - isolamento multi-tenant (meta de uma org não vaza).
 *
 * Uso: npm run test:business-goals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-goals-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-goals-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessGoalService: GOALS } = await import("../src/server/BusinessGoalService.js");
  const { ExecutiveAdvisorService: ADV } = await import("../src/server/ExecutiveAdvisorService.js");

  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id);
    return id;
  };
  // Semeia atendimentos NÃO cancelados no mês corrente (fonte do metric
  // appointments — Analytics filtra created_at nos últimos 30 dias).
  const seedAppointments = (orgId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, status, created_at) VALUES (?, ?, ?, 'Atendimento', 'confirmed', CURRENT_TIMESTAMP)`).run(randomUUID(), orgId, randomUUID());
    }
  };

  // ===== 1. Inerte por padrão =====
  const orgEmpty = mkOrg();
  check("inerte: list vazio sem meta", GOALS.list(orgEmpty).length === 0);
  check("inerte: progress.goals vazio sem meta", GOALS.progress(orgEmpty).goals.length === 0);
  check("inerte: Diretor.goalsBlock == '' sem meta", ADV.goalsBlock(orgEmpty) === "");
  check("catálogo: expõe revenue + appointments", GOALS.catalog().some((c: any) => c.metric === "revenue") && GOALS.catalog().some((c: any) => c.metric === "appointments"));

  // ===== 2. set() valida + upsert =====
  const org = mkOrg();
  let threwUnknown = false; try { GOALS.set(org, { metric: "lucro_impossivel", targetAmount: 100 }); } catch { threwUnknown = true; }
  check("valida: métrica desconhecida é rejeitada", threwUnknown);
  let threwZero = false; try { GOALS.set(org, { metric: "revenue", targetAmount: 0 }); } catch { threwZero = true; }
  check("valida: alvo <= 0 é rejeitado", threwZero);

  GOALS.set(org, { metric: "revenue", targetAmount: 10000, actor: "u1" });
  check("set: cria meta de receita", GOALS.list(org).length === 1 && GOALS.list(org)[0].target === 10000);
  GOALS.set(org, { metric: "revenue", targetAmount: 12000, actor: "u1" });
  check("upsert: atualiza (não duplica) a meta de receita", GOALS.list(org).length === 1 && GOALS.list(org)[0].target === 12000);

  // ===== 3. progress() deriva realizado + distância (atendimentos, determinístico) =====
  GOALS.remove(org, "revenue");
  seedAppointments(org, 4);
  GOALS.set(org, { metric: "appointments", targetAmount: 10 });
  // asOf no dia 15 de um mês de 30 dias → paceFraction 0.5 → esperado 5; realizado 4 < 5 → behind
  const pAppt = GOALS.progress(org, { asOf: "2026-06-15T12:00:00Z" });
  const gAppt = pAppt.goals.find((g: any) => g.metric === "appointments")!;
  check("progress: realizado de atendimentos derivado do Analytics (=4)", gAppt.current === 4);
  check("progress: remaining = 10 - 4 = 6", gAppt.remaining === 6);
  check("progress: attainmentPct = 40", gAppt.attainmentPct === 40);
  check("progress: não atingida (reached=false)", gAppt.reached === false);
  check("pace: esperado até dia 15/30 = 5 (metade)", gAppt.expectedByNow === 5);
  check("pace: 4 < 5 esperado → behind", gAppt.paceStatus === "behind");

  // início do mês (dia 1) → esperado baixo → on_track mesmo com pouco realizado
  const pEarly = GOALS.progress(org, { asOf: "2026-06-01T12:00:00Z" });
  const gEarly = pEarly.goals.find((g: any) => g.metric === "appointments")!;
  check("pace: no dia 1 o realizado supera o esperado → on_track", gEarly.paceStatus === "on_track");

  // meta batida → reached + remaining 0 + paceStatus reached
  GOALS.set(org, { metric: "appointments", targetAmount: 3 });
  const pReached = GOALS.progress(org, { asOf: "2026-06-15T12:00:00Z" });
  const gReached = pReached.goals.find((g: any) => g.metric === "appointments")!;
  check("reached: 4 >= 3 → reached + remaining 0 + paceStatus reached", gReached.reached === true && gReached.remaining === 0 && gReached.paceStatus === "reached");

  // ===== 4. Diretor.goalsBlock aparece com meta =====
  const block = ADV.goalsBlock(org);
  check("Diretor: goalsBlock aparece com meta (cita METAS DO NEGÓCIO + Atendimentos)", block.includes("METAS DO NEGÓCIO") && block.includes("Atendimentos do mês"));

  // ===== 5. remove idempotente =====
  check("remove: remove a meta existente (changes=1)", GOALS.remove(org, "appointments").removed === 1);
  check("remove: idempotente (changes=0 na 2ª)", GOALS.remove(org, "appointments").removed === 0);
  check("remove: volta a inerte", GOALS.list(org).length === 0 && ADV.goalsBlock(org) === "");

  // ===== 6. Isolamento =====
  const orgA = mkOrg(); const orgB = mkOrg();
  GOALS.set(orgA, { metric: "revenue", targetAmount: 5000 });
  check("isolamento: meta de A não aparece em B", GOALS.list(orgB).length === 0 && GOALS.list(orgA).length === 1);
  check("isolamento: progress de B vazio", GOALS.progress(orgB).goals.length === 0);

  console.log("\n=== TEST: Metas do negócio + distância à meta (ADR-160 F4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Metas do negócio (F4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
