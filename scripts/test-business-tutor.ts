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

  // ===== 6b. Meio-dia (ADR-131 Fatia 2): % do ponto de equilíbrio =====
  const MIDDAY = new Date("2026-07-23T16:00:00Z"); // 13:00 em São Paulo
  // Org sem custo fixo: não há breakeven a reportar → passe pula sem enviar.
  const orgNoBE = seedOrg(1, "5521970000000");
  const rNoBE = await T.runMiddayPass(orgNoBE, { now: MIDDAY, send });
  check("sem custo fixo, meio-dia não se aplica (no_breakeven)", rNoBE.sent === false && rNoBE.reason === "no_breakeven");
  check("meio-dia sem breakeven não marca a data", !(db.prepare("SELECT tutor_wa_last_midday m FROM organization_settings WHERE organization_id = ?").get(orgNoBE) as any).m);
  check("middayBrief não aplicável quando falta custo fixo", T.middayBrief(orgNoBE).applicable === false);

  // Org com custo fixo + vendas pagas (janela 30d, inclui hoje).
  const orgBE = seedOrg(1, "5521960000000");
  db.prepare("UPDATE organization_settings SET comigo_fixed_costs_monthly = 3000 WHERE organization_id = ?").run(orgBE); // R$ 100/dia
  const seedSale = (revenue: number, cost: number) => {
    const oid = randomUUID();
    db.prepare("INSERT INTO comigo_orders (id, organization_id, status, total) VALUES (?, ?, 'paid', ?)").run(oid, orgBE, revenue);
    db.prepare("INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', 1, ?, ?)").run(randomUUID(), oid, revenue, cost);
  };
  for (let i = 0; i < 3; i++) seedSale(40, 16); // margem 60%, ticket 40
  const beBrief = T.middayBrief(orgBE);
  check("middayBrief aplicável com custo fixo + vendas", beBrief.applicable === true);
  check("texto do meio-dia cita o ponto de equilíbrio e o %", /ponto de equil/.test(beBrief.text) && /%/.test(beBrief.text));
  const midBefore = sends.length;
  const m1 = await T.runMiddayPass(orgBE, { now: MIDDAY, send });
  check("envia no meio-dia quando aplicável", m1.sent === true && sends.length === midBefore + 1 && sends[sends.length - 1].phone === "5521960000000");
  const m2 = await T.runMiddayPass(orgBE, { now: MIDDAY, send });
  check("não reenvia o meio-dia no mesmo dia (dedupe)", m2.sent === false && m2.reason === "already_sent");
  const m3 = await T.runMiddayPass(orgBE, { now: MORNING, send });
  check("fora da janela do meio-dia não envia", m3.sent === false && m3.reason === "outside_window");

  // ===== 6c. Fim do dia (ADR-131 Fatia 3): vendeu/recebeu/margem/pendências =====
  const EVENING = new Date("2026-07-23T23:00:00Z"); // 20:00 em São Paulo
  const ev = T.eveningBrief(orgBE);
  check("resumo do fim do dia traz vendas, caixa e margem", /Fim do dia/.test(ev.text) && /Vendas/.test(ev.text) && /Margem estimada/.test(ev.text));
  const evBefore = sends.length;
  const e1 = await T.runEveningPass(orgBE, { now: EVENING, send });
  check("envia o fim do dia na janela da noite", e1.sent === true && sends.length === evBefore + 1);
  const e2 = await T.runEveningPass(orgBE, { now: EVENING, send });
  check("não reenvia o fim do dia no mesmo dia (dedupe)", e2.sent === false && e2.reason === "already_sent");
  const e3 = await T.runEveningPass(orgBE, { now: MIDDAY, send });
  check("fora da janela da noite não envia", e3.sent === false && e3.reason === "outside_window");
  // Fim do dia envia mesmo sem custo fixo (é o fechamento, não depende de breakeven).
  const e4 = await T.runEveningPass(orgNoBE, { now: EVENING, send });
  check("fim do dia envia mesmo sem custo fixo", e4.sent === true);

  // ===== 6d. Loop conversacional (ADR-131 Fatia 4): "SIM" agenda a cobrança =====
  // orgBE já tem número (5521960000000) e recebíveis? Precisa de a receber > 0.
  // Cria um recebível em aberto para abrir a oferta.
  db.prepare("INSERT INTO receivables (id, organization_id, description, amount, due_date, status) VALUES (?, ?, 'Venda a prazo', 150, '2026-07-30', 'open')").run(randomUUID(), orgBE);
  const evBrief = T.eveningBrief(orgBE);
  check("fim do dia com a receber oferece cobrança (SIM)", evBrief.hasReceivables === true && /SIM/.test(evBrief.text));
  // Envia o fim do dia num 2º dia (para não colidir com o dedupe do EVENING acima).
  const EVENING2 = new Date("2026-07-24T23:00:00Z");
  await T.runEveningPass(orgBE, { now: EVENING2, send });
  const offer = db.prepare("SELECT tutor_collect_offer_at o FROM organization_settings WHERE organization_id = ?").get(orgBE) as any;
  check("envio da noite abre a oferta de cobrança", !!offer.o);

  // Resposta de um número que NÃO é o dono → não trata.
  const notOwner = await T.handleOwnerReply(orgBE, "5511000000000", "sim", { send, now: EVENING2 });
  check("resposta de não-dono não é tratada", notOwner === false);
  // Resposta ambígua do dono → não sequestra a conversa.
  const ambiguous = await T.handleOwnerReply(orgBE, "5521960000000", "quanto foi mesmo?", { send, now: EVENING2 });
  check("resposta ambígua do dono não é capturada", ambiguous === false);
  // "SIM" do dono → agenda a cobrança para o dia seguinte e responde.
  const replyBefore = sends.length;
  const yes = await T.handleOwnerReply(orgBE, "55 21 96000-0000", "Sim!", { send, now: EVENING2 });
  check("'SIM' do dono é tratado e responde", yes === true && sends.length === replyBefore + 1 && /Combinado/.test(sends[sends.length - 1].text));
  const sched = db.prepare("SELECT tutor_collect_scheduled_for f, tutor_collect_offer_at o FROM organization_settings WHERE organization_id = ?").get(orgBE) as any;
  check("agenda para o dia seguinte e limpa a oferta", sched.f === "2026-07-25" && !sched.o);

  // Na manhã seguinte (25/07), o passe de cobrança envia o lembrete e limpa.
  const MORNING_25 = new Date("2026-07-25T11:30:00Z"); // 08:30 SP
  const cBefore = sends.length;
  const c1 = await T.runCollectPass(orgBE, { now: MORNING_25, send });
  check("lembrete de cobrança é enviado na manhã agendada", c1.sent === true && sends.length === cBefore + 1 && /Cobran/.test(sends[sends.length - 1].text));
  const c2 = await T.runCollectPass(orgBE, { now: MORNING_25, send });
  check("cobrança não repete depois de enviada", c2.sent === false && c2.reason === "disabled");

  // "não" cancela a oferta sem agendar.
  db.prepare("UPDATE organization_settings SET tutor_collect_offer_at = ? WHERE organization_id = ?").run("2026-07-24", orgBE);
  const no = await T.handleOwnerReply(orgBE, "5521960000000", "não precisa", { send, now: EVENING2 });
  const afterNo = db.prepare("SELECT tutor_collect_offer_at o, tutor_collect_scheduled_for f FROM organization_settings WHERE organization_id = ?").get(orgBE) as any;
  check("'não' cancela a oferta e não agenda", no === true && !afterNo.o && !afterNo.f);

  // ===== 7. sendNow (teste manual) ignora janela/dedupe =====
  const snBefore = sends.length;
  const sn = await T.sendNow(orgA, { send });
  check("envio de teste manda mesmo já tendo enviado hoje", (sn as any).ok === true && sends.length === snBefore + 1);

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
