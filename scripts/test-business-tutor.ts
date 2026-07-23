/**
 * TEST — Tutor de Gestão no WhatsApp (ADR-131, Fatia 1: resumo da manhã).
 * Determinístico, sem chave de IA, envio injetado (sem rede).
 *
 * Uso: npm run test:business-tutor
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-tutor-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-tutor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessTutorService: T } = await import("../src/server/BusinessTutorService.js");

  const MORNING = new Date("2026-07-23T11:30:00Z"); // 08:30 em São Paulo
  const AFTERNOON = new Date("2026-07-23T18:00:00Z"); // 15:00 em São Paulo

  function seedOrg(enabled: number, phone: string | null) {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
    db.prepare(`UPDATE organization_settings SET tutor_wa_enabled = ?, tutor_wa_phone = ? WHERE organization_id = ?`).run(enabled, phone, orgId);
    return orgId;
  }
  const sends: { phone: string; text: string }[] = [];
  const send = (phone: string, text: string) => { sends.push({ phone, text }); };

  // ===== 1. Fuso de São Paulo =====
  check("hora de SP às 08:30 (UTC-3)", T.spParts(MORNING).hourSP === 8 && T.spParts(MORNING).dateSP === "2026-07-23");
  check("hora de SP às 15:00", T.spParts(AFTERNOON).hourSP === 15);

  // ===== 2. Texto determinístico do resumo =====
  const orgA = seedOrg(1, "5521999887766");
  const brief = T.morningBrief(orgA);
  check("resumo tem saudação de bom dia", /Bom dia/.test(brief.text));
  check("resumo traz a situação e os KPIs de caixa", /Situação:/.test(brief.text) && /Caixa/.test(brief.text) && /a receber/.test(brief.text));

  // ===== 3. Número do dono: configurado, senão o do usuário dono =====
  check("usa o número configurado do tutor", T.ownerPhone(orgA) === "5521999887766");
  const orgB = seedOrg(1, null);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role) VALUES (?, ?, 'Dono', ?, '5511911112222', 'owner')`).run(randomUUID(), orgB, `dono_${orgB}@x.com`);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role) VALUES (?, ?, 'Atendente', ?, '5511900000000', 'agent')`).run(randomUUID(), orgB, `at_${orgB}@x.com`);
  check("sem número configurado, cai no telefone do DONO (não do agente)", T.ownerPhone(orgB) === "5511911112222");

  // ===== 4. Passe da manhã: envia 1x, deduplica no dia =====
  const r1 = await T.runMorningPass(orgA, { now: MORNING, send });
  check("envia de manhã quando ligado e com número", r1.sent === true && sends.length === 1 && sends[0].phone === "5521999887766");
  check("mensagem enviada é o resumo (bom dia)", /Bom dia/.test(sends[0].text));
  const r2 = await T.runMorningPass(orgA, { now: MORNING, send });
  check("não reenvia no mesmo dia (dedupe)", r2.sent === false && r2.reason === "already_sent" && sends.length === 1);

  // ===== 5. Fora da janela e desligado =====
  const before = sends.length;
  const r3 = await T.runMorningPass(orgB, { now: AFTERNOON, send });
  check("fora da janela da manhã não envia", r3.sent === false && r3.reason === "outside_window" && sends.length === before);
  const orgOff = seedOrg(0, "5521988887777");
  const r4 = await T.runMorningPass(orgOff, { now: MORNING, send });
  check("org com tutor desligado não envia", r4.sent === false && r4.reason === "disabled");

  // ===== 6. Ligado, sem número: não envia e NÃO marca (retenta depois) =====
  const orgNoPhone = seedOrg(1, null);
  const r5 = await T.runMorningPass(orgNoPhone, { now: MORNING, send });
  check("ligado sem número não envia (no_phone)", r5.sent === false && r5.reason === "no_phone");
  const marked = db.prepare("SELECT tutor_wa_last_morning m FROM organization_settings WHERE organization_id = ?").get(orgNoPhone) as any;
  check("sem número, não marca a data (poderá enviar quando configurar)", !marked.m);

  // ===== 7. sendNow (teste manual) ignora janela/dedupe =====
  const sn = await T.sendNow(orgA, { send });
  check("envio de teste manda mesmo já tendo enviado hoje", (sn as any).ok === true && sends.length === before + 1);

  // ===== 8. Isolamento =====
  const lastB = db.prepare("SELECT tutor_wa_last_morning m FROM organization_settings WHERE organization_id = ?").get(orgB) as any;
  check("org B (fora da janela) não foi marcada", !lastB.m);

  console.log("\n=== TEST: Tutor no WhatsApp (ADR-131) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Tutor no WhatsApp OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
