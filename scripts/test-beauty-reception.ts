/**
 * TEST — BEAUTY-035 (ADR-169 F34): Painel da Recepção.
 *
 * Prova as 4 perguntas do dono, compondo appointments + clinic_professionals +
 * contacts (sem tabela nova):
 *   Q1 buscar cliente (dedupe antes de cadastrar) — por nome/telefone.
 *   Q2 buscar profissional → agendamentos do dia + horários vagos.
 *   Q3 agenda do dia + quem está em atendimento AGORA (in_progress) e por quem.
 *   Q4 quais profissionais estão trabalhando hoje (derivado dos agendamentos).
 *   + tempo real: setStatus move o atendimento pelo funil.
 *   + isolamento cross-tenant (RN-BS-07).
 *
 * Uso: npm run test:beauty-reception
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-recep-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-recep-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { BeautyReceptionService } = await import("../src/server/BeautyReceptionService.js");
  const { AppointmentService } = await import("../src/server/AppointmentService.js");

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`)
      .run(randomUUID(), orgId);
    return orgId;
  };
  const seedContact = (orgId: string, name: string, phone: string) => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`)
      .run(id, orgId, name, phone);
    return id;
  };
  const seedPro = (orgId: string, name: string, active = true) => {
    const id = `p_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, ?)`)
      .run(id, orgId, name, active ? 1 : 0);
    return id;
  };
  // Agendamento HOJE em `hhLocal` (hora BRT), com status/pro.
  const seedAppt = (orgId: string, contactId: string, proId: string | null, proName: string | null, hhLocal: number, status: string, title = "Corte") => {
    const id = `a_${randomUUID().slice(0, 6)}`;
    const nowSp = new Date(Date.now() - 3 * 3600_000);
    const startUtc = Date.UTC(nowSp.getUTCFullYear(), nowSp.getUTCMonth(), nowSp.getUTCDate(), hhLocal + 3, 0, 0);
    const startIso = new Date(startUtc).toISOString();
    const endIso = new Date(startUtc + 3600_000).toISOString();
    db.prepare(
      `INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, professional_id, professional_name_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, contactId, title, startIso, endIso, status, proId, proName);
    return id;
  };

  const orgA = seedOrg();
  const orgB = seedOrg();
  // Config de agenda 8h-18h, slot 60min (default já é isso, mas fixa).
  AppointmentService.saveConfig(orgA, { openHour: 8, closeHour: 18, slotMin: 60 });

  const emily = seedContact(orgA, "Emily Souza", "11999990001");
  const emilene = seedContact(orgA, "Emilene Costa", "11999990002");
  const carlos = seedContact(orgA, "Carlos Lima", "11988887777");
  const proMaria = seedPro(orgA, "Maria");
  const proJoana = seedPro(orgA, "Joana");
  const proFolga = seedPro(orgA, "Beatriz");           // ativa mas sem agenda hoje
  seedPro(orgA, "Ex-funcionária", false);              // inativa → nunca aparece

  // ficha capilar da Emily (hasProfile=true)
  db.prepare(`INSERT INTO beauty_client_profiles (id, organization_id, contact_id, hair_type) VALUES (?, ?, ?, 'liso')`)
    .run(randomUUID(), orgA, emily);

  // ===== Q1 — busca cliente (dedupe) =====
  let r: any = BeautyReceptionService.searchClients(orgA, "emil");
  check("busca 'emil' acha Emily + Emilene", r.length === 2 && r.some((c: any) => c.name === "Emily Souza") && r.some((c: any) => c.name === "Emilene Costa"));
  check("busca marca hasProfile na Emily (tem ficha)", r.find((c: any) => c.name === "Emily Souza")?.hasProfile === true);
  check("busca marca hasProfile=false na Emilene (sem ficha)", r.find((c: any) => c.name === "Emilene Costa")?.hasProfile === false);
  r = BeautyReceptionService.searchClients(orgA, "9888");
  check("busca por telefone parcial acha Carlos", r.length === 1 && r[0].name === "Carlos Lima" && r[0].phone === "11988887777");
  r = BeautyReceptionService.searchClients(orgA, "");
  check("busca vazia lista a base (3 clientes)", r.length === 3);
  check("busca cross-org: orgB não vê clientes da orgA", BeautyReceptionService.searchClients(orgB, "emil").length === 0);

  // ===== Agendamentos de hoje =====
  seedAppt(orgA, emily, proMaria, "Maria", 9, "in_progress", "Coloração");  // em atendimento AGORA
  seedAppt(orgA, carlos, proMaria, "Maria", 14, "confirmed", "Corte");       // Maria mais tarde
  seedAppt(orgA, emilene, proJoana, "Joana", 10, "completed", "Escova");     // Joana já finalizou 1
  seedAppt(orgA, carlos, proJoana, "Joana", 16, "pending", "Hidratação");    // Joana agendado
  seedAppt(orgA, emily, proMaria, "Maria", 8, "cancelled", "Corte");         // cancelado → não conta

  // ===== Q3+Q4 — quadro do dia =====
  const board = BeautyReceptionService.dayBoard(orgA);
  check("agenda do dia traz 4 (exclui cancelado)", board.appointments.length === 4);
  check("agenda ordenada por horário (1º às 08/09h)", board.appointments[0].startTime! <= board.appointments[1].startTime!);
  check("nowServing = 1 (Emily com Maria, in_progress)",
    board.nowServing.length === 1 && board.nowServing[0].clientName === "Emily Souza" && board.nowServing[0].professionalName === "Maria");
  check("statusLabel pt-BR (Em atendimento)", board.nowServing[0].statusLabel === "Em atendimento");
  check("contadores: total 4, inProgress 1, done 1", board.counts.total === 4 && board.counts.inProgress === 1 && board.counts.done === 1);

  // Q4 — profissionais trabalhando hoje
  const maria = board.professionals.find((p) => p.id === proMaria)!;
  const joana = board.professionals.find((p) => p.id === proJoana)!;
  const bea = board.professionals.find((p) => p.id === proFolga)!;
  check("Maria trabalhando hoje (2 agendamentos)", maria.working === true && maria.bookedToday === 2);
  check("Maria servindo a Emily agora", maria.serving?.clientName === "Emily Souza");
  check("Joana trabalhando hoje (2 agendamentos), sem atendimento em curso", joana.working === true && joana.bookedToday === 2 && joana.serving === null);
  check("Beatriz ativa mas NÃO trabalhando (sem agenda hoje)", bea.working === false && bea.bookedToday === 0);
  check("Ex-funcionária inativa não aparece no roster", !board.professionals.some((p) => p.name === "Ex-funcionária"));

  // ===== Q2 — dia do profissional + horários vagos =====
  const diaMaria = BeautyReceptionService.professionalDay(orgA, proMaria);
  check("dia da Maria: 2 agendamentos", diaMaria.professional?.name === "Maria" && diaMaria.appointments.length === 2);
  check("horários vagos da Maria não incluem 09:00 (ocupado)", !diaMaria.freeSlots.includes("09:00"));
  check("horários vagos da Maria não incluem 14:00 (ocupado)", !diaMaria.freeSlots.includes("14:00"));
  // Horários vagos: determinístico numa data FUTURA (todos os slots são
  // futuros, então a grade cheia aparece). Beatriz não tem agenda → grade
  // completa 8h..17h (10 slots de 60min, pois 17:00+60=18:00 = fechamento).
  const nowSp2 = new Date(Date.now() + 24 * 3600_000 - 3 * 3600_000);
  const amanha = `${nowSp2.getUTCFullYear()}-${String(nowSp2.getUTCMonth() + 1).padStart(2, "0")}-${String(nowSp2.getUTCDate()).padStart(2, "0")}`;
  const diaBeaAmanha = BeautyReceptionService.professionalDay(orgA, proFolga, amanha);
  check("horários vagos numa data futura: grade cheia (10 slots 08:00–17:00)",
    diaBeaAmanha.freeSlots.length === 10 && diaBeaAmanha.freeSlots[0] === "08:00" && diaBeaAmanha.freeSlots.includes("17:00"));
  check("profissional inexistente → null", BeautyReceptionService.professionalDay(orgA, "nao_existe").professional === null);
  check("dia do profissional cross-org → null", BeautyReceptionService.professionalDay(orgB, proMaria).professional === null);

  // ===== Tempo real — setStatus =====
  const emilyAppt = board.nowServing[0].id;
  let sr: any = BeautyReceptionService.setStatus(orgA, emilyAppt, "completed");
  check("setStatus in_progress → completed ok", sr.ok === true && sr.status === "completed");
  const board2 = BeautyReceptionService.dayBoard(orgA);
  check("após finalizar, nowServing fica 0", board2.nowServing.length === 0);
  check("após finalizar, done sobe pra 2", board2.counts.done === 2);
  sr = BeautyReceptionService.setStatus(orgA, emilyAppt, "banana");
  check("setStatus com status inválido → erro", sr.ok === false);
  sr = BeautyReceptionService.setStatus(orgB, emilyAppt, "completed");
  check("setStatus cross-org → não acha (isolamento)", sr.ok === false);

  // ===== Fiação: rotas + UI =====
  const routesSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/beauty.ts"), "utf8");
  check("rotas /reception/* montadas",
    routesSrc.includes(`"/reception/clients"`) && routesSrc.includes(`"/reception/today"`) &&
    routesSrc.includes(`"/reception/professional/:id"`) && routesSrc.includes(`"/reception/appointments/:id/status"`));
  check("BeautyView monta o Painel da Recepção",
    fs.readFileSync(path.join(process.cwd(), "src/features/BeautyView.tsx"), "utf8").includes("BeautyReceptionPanel"));
  check("Painel consome as rotas /reception/*",
    fs.readFileSync(path.join(process.cwd(), "src/features/BeautyReceptionPanel.tsx"), "utf8").includes("/api/beauty/reception/today"));

  // ===== F35 — Painel de TV: privacidade do nome + fiação =====
  // Regra pura (espelha tvDisplayName do BeautyTvPanel): primeiro nome +
  // inicial do sobrenome — tela pública mostra "Emily S.", não o nome cheio.
  const tvName = (full: string) => {
    const p = String(full || "").trim().split(/\s+/).filter(Boolean);
    if (!p.length) return "Cliente";
    if (p.length === 1) return p[0];
    return `${p[0]} ${p[p.length - 1][0].toUpperCase()}.`;
  };
  check("nome na TV: 'Emily Souza' → 'Emily S.'", tvName("Emily Souza") === "Emily S.");
  check("nome na TV: um nome só fica inteiro", tvName("Madonna") === "Madonna");
  check("nome na TV: vazio → 'Cliente'", tvName("") === "Cliente");
  const tvSrc = fs.readFileSync(path.join(process.cwd(), "src/features/BeautyTvPanel.tsx"), "utf8");
  check("BeautyTvPanel consome /reception/today (sem endpoint público)", tvSrc.includes("/api/beauty/reception/today"));
  check("BeautyTvPanel exibe pelo nome mascarado (não o clientName cru)",
    tvSrc.includes("tvDisplayName(a.clientName)") && !/>\{a\.clientName\}</.test(tvSrc));
  const recepSrc = fs.readFileSync(path.join(process.cwd(), "src/features/BeautyReceptionPanel.tsx"), "utf8");
  check("Recepção tem botão 'Modo TV' que abre o BeautyTvPanel",
    recepSrc.includes("Modo TV") && recepSrc.includes("BeautyTvPanel") && recepSrc.includes("setTvMode"));

  // ===== Report =====
  console.log("\n=== TEST beauty-reception (ADR-169 F34+F35) ===\n");
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.note ? ` — ${x.note}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
