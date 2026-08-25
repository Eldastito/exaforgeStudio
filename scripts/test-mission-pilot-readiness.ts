/**
 * TEST — Pré-check do piloto (ADR-189 F28). Dada uma org, DERIVA por família (receita/agenda/
 * cobrança) se o dado sustenta uma missão útil — pra escolher a 1ª missão certa e não bater em
 * "premissa faltante". Read-only, honesto (reasons dizem o que falta), isolado por org.
 *
 * Uso: npm run test:mission-pilot-readiness
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mpr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mpr-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionPilotReadinessService: R } = await import("../src/server/MissionPilotReadinessService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const fam = (r: any, f: string) => r.families.find((x: any) => x.family === f);

  // ── Org VAZIA: nada pronto, honesto ──
  const E = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'Vazia', 'active', 0)`).run(randomUUID(), E);
  const re = R.check(E);
  check("1.1 org vazia: nenhuma família pronta + note honesto", re.readyFamilies.length === 0 && fam(re, "revenue").ready === false && fam(re, "revenue").reasons.length > 0);
  check("1.2 flag off refletida", re.missionLayerEnabled === false && re.channelConnected === false);

  // ── Clínica: canal + histórico de agenda + base → AGENDA pronta; receita/cobrança não ──
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, mission_layer_enabled) VALUES (?, ?, 'Clínica', 'active', 'clinica', 1)`).run(randomUUID(), C);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'wa', '5511', 'connected')`).run(randomUUID(), C);
  for (let i = 0; i < 40; i++) db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, status, scheduled_start) VALUES (?, ?, 'ct', 'C', ?, '2026-07-10 09:00:00')`).run(randomUUID(), C, i < 32 ? "completed" : "no_show");
  for (let i = 0; i < 200; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), C, `c${i}`);
  const rc = R.check(C);
  check("2.1 clínica: AGENDA pronta (histórico + base + canal)", fam(rc, "appointments").ready === true && rc.readyFamilies.includes("Agenda"));
  check("2.2 receita NÃO pronta (sem vendas) — honesto", fam(rc, "revenue").ready === false && fam(rc, "revenue").reasons.some((s: string) => /venda/i.test(s)));
  check("2.3 cobrança NÃO pronta (sem recebível) — honesto", fam(rc, "receivables").ready === false && fam(rc, "receivables").reasons.some((s: string) => /recebível|aberto/i.test(s)));
  check("2.4 facts expostos (transparência)", fam(rc, "appointments").facts.historicoAtendimentos === 40 && fam(rc, "appointments").facts.contatos === 200);

  // ── Loja: canal + vendas + base → RECEITA pronta ──
  const L = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, mission_layer_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', 1)`).run(randomUUID(), L);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'wa', '5511', 'connected')`).run(randomUUID(), L);
  for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 300, '2026-08-01 10:00:00')`).run(randomUUID(), L);
  for (let i = 0; i < 500; i++) db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'C', ?)`).run(randomUUID(), L, `c${i}`);
  const rl = R.check(L);
  check("3.1 loja: RECEITA pronta", fam(rl, "revenue").ready === true && rl.readyFamilies.includes("Receita"));

  // ── Serviços: canal + recebíveis em aberto → COBRANÇA pronta ──
  const S = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, mission_layer_enabled) VALUES (?, ?, 'Serviços', 'active', 'servicos', 1)`).run(randomUUID(), S);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'wa', '5511', 'connected')`).run(randomUUID(), S);
  for (let i = 0; i < 5; i++) db.prepare(`INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Fatura', 1000, '2026-08-01', 'open')`).run(randomUUID(), S);
  const rs = R.check(S);
  check("4.1 serviços: COBRANÇA pronta", fam(rs, "receivables").ready === true && rs.readyFamilies.includes("Cobrança"));
  check("4.2 sem canal derrubaria — canal presente aqui", rs.channelConnected === true);

  // ── Isolamento: cada org enxerga só o seu ──
  check("5.1 isolamento (loja não vê agenda da clínica)", fam(rl, "appointments").facts.historicoAtendimentos === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-pilot-readiness: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
