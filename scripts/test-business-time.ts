/**
 * TESTE — Data comercial no fuso da organização (PDR Estabilização TOULON, Fatia A/TIME).
 * ------------------------------------------------------------------------------------
 * Prova, offline (BusinessTimeService), que a DATA COMERCIAL é calculada no fuso
 * da org (fallback America/Sao_Paulo) e NÃO em UTC — a raiz do bug "boletas somem
 * no reload após 21h" no Rio:
 *   - 20:59 SP → ainda é o dia D; 21:00/23:59 SP → ainda é o dia D (UTC já virou);
 *     00:00 SP → é o dia D+1;
 *   - servidor rodando em UTC não muda o resultado;
 *   - timezone por org (coluna aditiva) com fallback SP;
 *   - dayBounds devolve a janela UTC do dia comercial;
 *   - context expõe {timezone, businessDate, serverNow}.
 *
 * Uso:  npm run test:business-time
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-business-time-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-business-time-1234567890";
process.env.TZ = "UTC"; // servidor em UTC — o serviço não pode depender do relógio do host

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessTimeService } = await import("../src/server/BusinessTimeService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), org);

  // Instantes UTC correspondentes a horários de parede no Rio (UTC-3, sem DST desde 2019).
  const at = (utc: string) => new Date(utc);
  // 2026-08-18 20:59 SP == 2026-08-18 23:59Z (mesmo dia em ambos)
  check("20:59 SP → dia D", BusinessTimeService.businessDate(org, at("2026-08-18T23:59:00Z")) === "2026-08-18");
  // 2026-08-18 21:00 SP == 2026-08-19 00:00Z (UTC já virou, SP não)
  check("21:00 SP → ainda dia D (UTC já é D+1)", BusinessTimeService.businessDate(org, at("2026-08-19T00:00:00Z")) === "2026-08-18");
  // 2026-08-18 23:59 SP == 2026-08-19 02:59Z
  check("23:59 SP → ainda dia D", BusinessTimeService.businessDate(org, at("2026-08-19T02:59:00Z")) === "2026-08-18");
  // 2026-08-19 00:00 SP == 2026-08-19 03:00Z
  check("00:00 SP → dia D+1", BusinessTimeService.businessDate(org, at("2026-08-19T03:00:00Z")) === "2026-08-19");

  // Timezone por org: fallback SP quando a coluna está vazia.
  check("timezone fallback America/Sao_Paulo", BusinessTimeService.timezoneFor(org) === "America/Sao_Paulo");
  // Define outro fuso e confirma que muda a data comercial.
  db.prepare(`UPDATE organization_settings SET timezone = 'America/Noronha' WHERE organization_id = ?`).run(org); // UTC-2
  check("timezone por org é respeitado", BusinessTimeService.timezoneFor(org) === "America/Noronha");
  // 2026-08-19 01:30Z: SP(-3)=22:30 dia 18; Noronha(-2)=23:30 dia 18 — ambos dia 18, mas testa leitura da coluna
  check("Noronha 23:30 → dia 18", BusinessTimeService.businessDate(org, at("2026-08-19T01:30:00Z")) === "2026-08-18");
  db.prepare(`UPDATE organization_settings SET timezone = NULL WHERE organization_id = ?`).run(org);

  // dayBounds: janela UTC do dia comercial em SP (00:00 SP = 03:00Z; fim = próximo 03:00Z).
  const b = BusinessTimeService.dayBounds(org, "2026-08-18");
  check("dayBounds início = 03:00Z", b.startUtc === "2026-08-18T03:00:00.000Z", `start=${b.startUtc}`);
  check("dayBounds fim = D+1 03:00Z", b.endUtc === "2026-08-19T03:00:00.000Z", `end=${b.endUtc}`);

  // context
  const ctx = BusinessTimeService.context(org, at("2026-08-19T00:00:00Z"));
  check("context traz timezone/businessDate/serverNow", ctx.timezone === "America/Sao_Paulo" && ctx.businessDate === "2026-08-18" && !!ctx.serverNow);

  console.log("\n=== TEST: Data comercial no fuso (Fatia A/TIME) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
