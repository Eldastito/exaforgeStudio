/**
 * TEST — BEAUTY-038 (ADR-169 F37): Fila virtual por QR code + aviso no celular.
 *
 * Prova o BeautyQueueService (derivado da agenda canônica `appointments`, sem
 * tabela nova):
 *   - assinatura HMAC do link (escopo `beauty_queue`) + isolamento cross-tenant;
 *   - status público: waiting / your_turn / serving / done / cancelled;
 *   - "é a sua vez" POR PROFISSIONAL (não avisa cedo demais quando há cadeiras
 *     ocupadas em paralelo);
 *   - minimização LGPD: só o PRIMEIRO NOME do próprio cliente, NUNCA nomes de
 *     outros da fila (só a contagem);
 *   - assinatura adulterada / expirada / de outro agendamento → not_found;
 *   - fiação de rotas + UI (QR na recepção, rota pública, página do celular).
 *
 * Uso: npm run test:beauty-queue
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-queue-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-queue-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { BeautyQueueService } = await import("../src/server/BeautyQueueService.js");
  const { signKey } = await import("../src/server/fileSigning.js");

  const seedOrg = () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`)
      .run(randomUUID(), orgId);
    return orgId;
  };
  const seedContact = (orgId: string, name: string) => {
    const id = `c_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`)
      .run(id, orgId, name, "1199" + Math.floor(Math.random() * 1e7));
    return id;
  };
  const seedPro = (orgId: string, name: string) => {
    const id = `p_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, orgId, name);
    return id;
  };
  const seedAppt = (orgId: string, contactId: string, proId: string | null, proName: string | null, hhLocal: number, status: string, title = "Corte") => {
    const id = `a_${randomUUID().slice(0, 6)}`;
    const nowSp = new Date(Date.now() - 3 * 3600_000);
    const startUtc = Date.UTC(nowSp.getUTCFullYear(), nowSp.getUTCMonth(), nowSp.getUTCDate(), hhLocal + 3, 0, 0);
    db.prepare(
      `INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, professional_id, professional_name_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, orgId, contactId, title, new Date(startUtc).toISOString(), new Date(startUtc + 3600_000).toISOString(), status, proId, proName);
    return id;
  };

  const orgA = seedOrg();
  const orgB = seedOrg();

  const emily = seedContact(orgA, "Emily Souza");
  const carlos = seedContact(orgA, "Carlos Lima");
  const ana = seedContact(orgA, "Ana Prado");
  const bruna = seedContact(orgA, "Bruna Dias");
  const dora = seedContact(orgA, "Dora Reis");
  const maria = seedPro(orgA, "Maria");
  const joana = seedPro(orgA, "Joana");

  // Cenário do dia:
  //  Maria: Emily EM ATENDIMENTO (9h) · Carlos aguardando (14h) · Dora finalizada (8h)
  //  Joana: Ana aguardando (10h) · Bruna aguardando (11h) — Joana LIVRE
  const aEmily = seedAppt(orgA, emily, maria, "Maria", 9, "in_progress", "Coloração");
  const aCarlos = seedAppt(orgA, carlos, maria, "Maria", 14, "confirmed", "Corte");
  const aDora = seedAppt(orgA, dora, maria, "Maria", 8, "completed", "Escova");
  const aAna = seedAppt(orgA, ana, joana, "Joana", 10, "pending", "Hidratação");
  const aBruna = seedAppt(orgA, bruna, joana, "Joana", 11, "pending", "Manicure");

  // ===== Assinatura + isolamento =====
  const s = BeautyQueueService.sign(orgA, aEmily);
  check("sign de agendamento da org → ok", s.ok === true && !!(s as any).sig && !!(s as any).exp);
  const sig = (s as any).sig, exp = (s as any).exp;
  check("sign cross-org → recusa (isolamento RN-BS-07)", BeautyQueueService.sign(orgB, aEmily).ok === false);
  check("sign de agendamento inexistente → recusa", BeautyQueueService.sign(orgA, "nao_existe").ok === false);

  // ===== Status: assinatura válida =====
  const stEmily = BeautyQueueService.status(aEmily, exp, sig);
  check("status Emily (in_progress) = serving", stEmily.found === true && stEmily.state === "serving");
  check("status Emily menciona a profissional (Maria)", (stEmily.message || "").includes("Maria"));

  // ===== Assinatura inválida / adulterada / trocada / expirada =====
  check("sig adulterada → not_found (403)", BeautyQueueService.status(aEmily, exp, sig + "00").state === "not_found");
  check("sig de OUTRO agendamento → not_found", BeautyQueueService.status(aCarlos, exp, sig).state === "not_found");
  const expired = signKey("beauty_queue", `queue/${aEmily}`, -1000); // exp no passado
  check("sig expirada → not_found", BeautyQueueService.status(aEmily, expired.exp, expired.sig).state === "not_found");

  // ===== É a sua vez (por profissional) =====
  const sAna = BeautyQueueService.sign(orgA, aAna); const stAna = BeautyQueueService.status(aAna, (sAna as any).exp, (sAna as any).sig);
  check("Ana (Joana livre, 1ª da fila) → your_turn", stAna.state === "your_turn" && stAna.position === 1);
  check("your_turn menciona 'É a sua vez'", (stAna.message || "").toLowerCase().includes("é a sua vez"));

  const sBruna = BeautyQueueService.sign(orgA, aBruna); const stBruna = BeautyQueueService.status(aBruna, (sBruna as any).exp, (sBruna as any).sig);
  check("Bruna (2ª na fila da Joana) → waiting position 2, peopleAhead 1", stBruna.state === "waiting" && stBruna.position === 2 && stBruna.peopleAhead === 1);
  check("Bruna: mensagem 'Falta 1 pessoa'", (stBruna.message || "").includes("Falta 1 pessoa"));

  const sCarlos = BeautyQueueService.sign(orgA, aCarlos); const stCarlos = BeautyQueueService.status(aCarlos, (sCarlos as any).exp, (sCarlos as any).sig);
  // Maria está OCUPADA (Emily in_progress) → mesmo sendo o 1º da espera dela,
  // NÃO é a vez do Carlos ainda (não avisa cedo demais quando a cadeira está ocupada).
  check("Carlos (Maria ocupada) → NÃO é your_turn (waiting)", stCarlos.state === "waiting");
  check("Carlos é o próximo (position 1, peopleAhead 0)", stCarlos.position === 1 && stCarlos.peopleAhead === 0);

  // ===== Estados terminais =====
  const sDora = BeautyQueueService.sign(orgA, aDora); const stDora = BeautyQueueService.status(aDora, (sDora as any).exp, (sDora as any).sig);
  check("Dora (completed) → done", stDora.state === "done");
  // Cancelamento posterior: o cliente tinha o link, o agendamento foi cancelado.
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(aBruna);
  check("Bruna cancelada (link ainda válido) → cancelled", BeautyQueueService.status(aBruna, (sBruna as any).exp, (sBruna as any).sig).state === "cancelled");

  // ===== Minimização LGPD: só o 1º nome; nunca outros clientes =====
  check("clientName = só primeiro nome ('Emily')", stEmily.clientName === "Emily");
  const dump = JSON.stringify(stCarlos);
  check("payload NÃO vaza sobrenome do próprio cliente", !dump.includes("Lima"));
  check("payload NÃO vaza nome de OUTROS clientes da fila", !dump.includes("Emily") && !dump.includes("Ana") && !dump.includes("Dora"));

  // ===== Fiação: rotas + UI =====
  const pubSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/beautyPublic.ts"), "utf8");
  check("rota pública /queue/:id montada + usa BeautyQueueService", pubSrc.includes(`"/queue/:id"`) && pubSrc.includes("BeautyQueueService"));
  const authSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/beauty.ts"), "utf8");
  check("rota autenticada /reception/appointments/:id/queue-link + QR", authSrc.includes("queue-link") && authSrc.includes("QRCode.toDataURL"));
  const appSrc = fs.readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
  check("App renderiza a página da fila como rota pública (?beautyQueue, antes do login)",
    appSrc.includes("BeautyQueuePanel") && appSrc.includes("beautyQueue"));
  const panelSrc = fs.readFileSync(path.join(process.cwd(), "src/features/BeautyQueuePanel.tsx"), "utf8");
  check("página do celular consome /api/public/beauty/queue/ + alerta (vibrate) na sua vez",
    panelSrc.includes("/api/public/beauty/queue/") && panelSrc.includes("your_turn") && panelSrc.includes("vibrate"));
  const recepSrc = fs.readFileSync(path.join(process.cwd(), "src/features/BeautyReceptionPanel.tsx"), "utf8");
  check("recepção mostra o QR da fila (queue-link + openQr)", recepSrc.includes("queue-link") && recepSrc.includes("openQr"));

  // ===== Report =====
  console.log("\n=== TEST beauty-queue (ADR-169 F37) ===\n");
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}${x.note ? ` — ${x.note}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
