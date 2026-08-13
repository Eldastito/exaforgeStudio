/**
 * TEST — Editorial Calendar + Best-Time (PRD 10 / ADR-167 F10). DB-backed, determinístico.
 * Prova (§42, RN-SI-12):
 *   - draft cria entrada que NÃO entra no conjunto publicável (status='draft'); aprovar
 *     move draft→scheduled + horário e ENTRA no publicável (0-regressão do passe);
 *   - só rascunho aprova; cancelar preserva histórico; calendário lista os estágios;
 *   - best-time DERIVA do desempenho próprio (F4); sem amostras → insufficient_data honesto;
 *   - fio oportunidade/variante (correlationId/variantKey) preservado; isolamento.
 *
 * Uso: npm run test:editorial-calendar
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cal-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cal-12345";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { EditorialCalendarService: CAL } = await import("../src/server/EditorialCalendarService.js");

  const A = "org_cal_A", B = "org_cal_B";
  const publishable = (org: string) => db.prepare(
    `SELECT id FROM scheduled_posts WHERE organization_id = ? AND status='scheduled' AND scheduled_at <= datetime('now')`,
  ).all(org) as any[];

  // ═══════════════ 1. draft → não publicável ═══════════════
  const d = CAL.draft(A, { channel: "stub", caption: "linho", scheduledAt: "2020-01-01T00:00:00Z", variantKey: "sig-1:A", correlationId: "corr-1" });
  check("1.1 draft criado", !!d.id);
  const row = db.prepare(`SELECT status, variant_key, correlation_id FROM scheduled_posts WHERE id = ?`).get(d.id) as any;
  check("1.2 status='draft' + fio preservado", row.status === "draft" && row.variant_key === "sig-1:A" && row.correlation_id === "corr-1");
  check("1.3 draft NÃO entra no conjunto publicável (mesmo com horário no passado)", !publishable(A).some((r: any) => r.id === d.id));

  // ═══════════════ 2. aprovar move p/ publicável ═══════════════
  CAL.approve(A, d.id, { scheduledAt: "2020-01-01T00:00:00Z" });
  check("2.1 draft→scheduled entra no publicável", publishable(A).some((r: any) => r.id === d.id));
  let threw = false; try { CAL.approve(A, d.id, { scheduledAt: "2020-01-01T00:00:00Z" }); } catch { threw = true; }
  check("2.2 aprovar de novo (não é mais draft) falha", threw);

  // ═══════════════ 3. cancelar preserva histórico ═══════════════
  const d2 = CAL.draft(A, { channel: "stub", caption: "outro" });
  check("3.1 cancela rascunho", CAL.cancel(A, d2.id) === true);
  check("3.2 linha preservada com status canceled (não deleta)", (db.prepare(`SELECT status FROM scheduled_posts WHERE id = ?`).get(d2.id) as any).status === "canceled");

  // ═══════════════ 4. calendário lista os estágios ═══════════════
  const cal = CAL.calendar(A);
  check("4.1 calendário traz as 2 entradas (scheduled + canceled)", cal.length === 2);
  check("4.2 entradas com estágio + fio", cal.some((e: any) => e.status === "scheduled" && e.variantKey === "sig-1:A"));

  // ═══════════════ 5. best-time derivado do desempenho próprio (F4) ═══════════════
  const seed = (org: string, ch: string, when: string, likes: number, hasA = 1) =>
    db.prepare(`INSERT INTO social_post_metrics (id, organization_id, channel, post_external_id, published_at, likes, comments, shares, saves, analytics_available)
                VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`).run(randomUUID(), org, ch, randomUUID(), when, likes, hasA);
  seed(A, "stub", "2026-08-10T18:00:00Z", 100);   // 3× seg 18h alto engajamento
  seed(A, "stub", "2026-08-17T18:00:00Z", 90);
  seed(A, "stub", "2026-08-24T18:00:00Z", 110);
  seed(A, "stub", "2026-08-11T09:00:00Z", 10);    // ter 9h baixo
  const bt = CAL.bestTime(A, "stub");
  check("5.1 best-time disponível com amostras", bt.available === true && bt.samples === 4);
  check("5.2 top recomendação = hora 18 (maior engajamento medido)", bt.recommendations[0]?.hour === 18 && bt.recommendations[0]?.samples === 3);
  check("5.3 avgEngagement do topo ~100", Math.round(bt.recommendations[0]?.avgEngagement) === 100);

  // ═══════════════ 6. honesto: sem amostras → insufficient_data ═══════════════
  const btEmpty = CAL.bestTime(A, "youtube");
  check("6.1 canal sem posts → insufficient_data (não inventa)", btEmpty.available === false && btEmpty.reason === "insufficient_data");
  // posts SEM analytics não contam (null≠medido)
  seed(A, "x", "2026-08-10T12:00:00Z", 50, 0); seed(A, "x", "2026-08-11T12:00:00Z", 50, 0); seed(A, "x", "2026-08-12T12:00:00Z", 50, 0);
  check("6.2 posts sem analytics não contam p/ best-time", CAL.bestTime(A, "x").available === false);

  // ═══════════════ 7. isolamento multi-tenant ═══════════════
  check("7.1 B não vê o calendário de A", CAL.calendar(B).length === 0);
  check("7.2 B não aprova entrada de A", (() => { try { CAL.approve(B, d.id, { scheduledAt: "2020-01-01T00:00:00Z" }); return false; } catch { return true; } })());

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} editorial-calendar: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
