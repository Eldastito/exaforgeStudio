/**
 * TEST — Mission Legacy Reduction (ADR-189 F9, Mission OS). DB-backed, determinístico.
 * Prova (§25/§52/§112): o par "Executando → Missões" entra no gate advisório do LegacyReductionService;
 * sem telemetria de "missoes" → insufficient_data (NUNCA aposenta sem prova); com "missoes" adotada +
 * "executando" resíduo (≤10%) → ready_to_retire (advisório); ainda em uso → keep; nada é removido
 * (não existe método de remoção); role-gated (não-gestor → restricted); isolamento.
 *
 * Uso: npm run test:mission-legacy-reduction
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mlegacy-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mlegacy-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegacyReductionService: LR } = await import("../src/server/LegacyReductionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  const view = (org: string, surface: string, user: string) => db.prepare(`INSERT INTO ux_telemetry_events (id, organization_id, user_id, event_type, surface) VALUES (?, ?, ?, 'view_opened', ?)`).run(randomUUID(), org, user, surface);
  const owner = (org: string) => ({ userId: "u1", role: "owner", organizationId: org });
  const pair = (r: any) => (r.candidates || []).find((c: any) => c.legacy === "executando" && c.replacement === "missoes");

  // 1. O par existe no mapa.
  const A = mkOrg();
  const r1 = LR.candidates(A, owner(A)) as any;
  check("1.1 par 'Executando → Missões' presente", !!pair(r1) && pair(r1).label === "Executando → Missões");

  // 2. Sem telemetria de missoes → insufficient_data (nunca aposenta sem prova).
  check("2.1 sem adoção → insufficient_data (keep, §112)", pair(r1).status === "insufficient_data" && pair(r1).advisory === true);

  // 3. Missões adotada (>=10 views, >=2 users) + Executando resíduo (≤10%) → ready_to_retire.
  const B = mkOrg();
  for (let i = 0; i < 20; i++) view(B, "missoes", `u${i % 4}`); // 20 aberturas, 4 usuários
  view(B, "executando", "u0"); // 1 abertura legada → share ~5%
  const rB = LR.candidates(B, owner(B)) as any;
  check("3.1 adotada + resíduo → ready_to_retire", pair(rB).status === "ready_to_retire");
  check("3.2 advisório: sem método de remoção (nada apagado)", typeof (LR as any).remove === "undefined" && typeof (LR as any).retire === "undefined");

  // 4. Executando ainda em uso real → keep.
  const C = mkOrg();
  for (let i = 0; i < 20; i++) view(C, "missoes", `u${i % 4}`);
  for (let i = 0; i < 20; i++) view(C, "executando", `u${i % 4}`); // 50% share → em uso
  check("4.1 legado em uso → keep", pair(LR.candidates(C, owner(C)) as any).status === "keep");

  // 5. Role-gate: não-gestor → restricted.
  const rNon = LR.candidates(B, { userId: "u9", role: "agent", organizationId: B }) as any;
  check("5.1 não-gestor → restricted", rNon.restricted === true);

  // 6. Isolamento: a telemetria de B não vaza pra A.
  check("6.1 isolado (A ainda insufficient_data)", pair(LR.candidates(A, owner(A)) as any).status === "insufficient_data");

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-legacy-reduction: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
