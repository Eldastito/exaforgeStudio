/**
 * TEST — ChurnRiskDetector (ADR-155 F4.1).
 *
 * Prova: score 0–100 derivado por query (fatura vencida + silêncio + ticket
 * frio), threshold 70 (só publica o "alto"), explicabilidade (breakdown +
 * factors), sinal churn_risk_high em business_signals, sweep (quem sai do risco
 * é resolvido), opt-in por org e isolamento multi-tenant. Guardrail RN-014
 * (sugere, não age) na evidência.
 *
 * Uso: npm run test:churn-risk-detector
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-churn-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-churn-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const daysAgoISO = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
const daysAgoYMD = (n: number) => daysAgoISO(n).slice(0, 10);

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChurnRiskDetectorService } = await import("../src/server/ChurnRiskDetectorService.js");

  const mkOrg = (churnOn: boolean) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, churn_detector_enabled) VALUES (?, ?, 'Loja', 'active', 'varejo', ?)`).run(randomUUID(), orgId, churnOn ? 1 : 0);
    return orgId;
  };
  const mkContact = (orgId: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch1', ?, ?)`).run(id, orgId, name, randomUUID().slice(0, 10));
    return id;
  };
  const mkTicket = (orgId: string, contactId: string, temperature: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, temperature) VALUES (?, ?, ?, 'open', ?)`).run(id, orgId, contactId, temperature);
    return id;
  };
  const mkInbound = (orgId: string, ticketId: string, daysAgo: number) => {
    db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'contact', 'oi', ?)`).run(randomUUID(), orgId, ticketId, daysAgoISO(daysAgo));
  };
  const mkOverdue = (orgId: string, contactId: string, daysAgo: number, amount: number) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO receivables (id, organization_id, contact_id, description, amount, due_date, status) VALUES (?, ?, ?, 'Fatura', ?, ?, 'open')`).run(id, orgId, contactId, amount, daysAgoYMD(daysAgo));
    return id;
  };

  const orgA = mkOrg(true);
  // contato HIGH: vencida 40d (50) + silêncio 40d (30) + frio (20) = 100
  const cHigh = mkContact(orgA, "Ana Alta");
  const recHigh = mkOverdue(orgA, cHigh, 40, 300);
  const tHigh = mkTicket(orgA, cHigh, "cold");
  mkInbound(orgA, tHigh, 40);
  // contato ATT: vencida 20d (40) + silêncio 20d (20) + frio (20) = 80
  const cAtt = mkContact(orgA, "Bia Atenção");
  mkOverdue(orgA, cAtt, 20, 150);
  const tAtt = mkTicket(orgA, cAtt, "cold");
  mkInbound(orgA, tAtt, 20);
  // contato MID: vencida 5d (25) + silêncio 1d (0) + warm (5) = 30 → NÃO publica
  const cMid = mkContact(orgA, "Caio Médio");
  mkOverdue(orgA, cMid, 5, 80);
  const tMid = mkTicket(orgA, cMid, "warm");
  mkInbound(orgA, tMid, 1);

  // ===== 1. detect: só os de alto risco (≥70), ordenados desc =====
  const cands = ChurnRiskDetectorService.detect(orgA);
  check("detect traz 2 candidatos (high + att)", cands.length === 2);
  check("ordenado por score desc", cands[0].score >= cands[1].score);
  const high = cands.find((c) => c.contactId === cHigh)!;
  const att = cands.find((c) => c.contactId === cAtt)!;
  check("MID (score 30) NÃO entra", !cands.find((c) => c.contactId === cMid));

  // ===== 2. score + severidade + breakdown =====
  check("high: score 100", high?.score === 100);
  check("high: severity risk (≥85)", high?.severity === "risk");
  check("high: breakdown overdue 50 / silence 30 / ticket 20", high?.breakdown.overdue.points === 50 && high?.breakdown.silence.points === 30 && high?.breakdown.ticket.points === 20);
  check("att: score 80 / severity attention", att?.score === 80 && att?.severity === "attention");

  // ===== 3. explicabilidade (factors) =====
  check("high: factor de fatura vencida", high?.factors.some((f) => /vencida há 40/.test(f)));
  check("high: factor de silêncio", high?.factors.some((f) => /sem responder há 40/.test(f)));
  check("high: factor de atendimento frio", high?.factors.some((f) => /frio/.test(f)));

  // ===== 4. publish → business_signals + guardrail RN-014 =====
  const p1 = ChurnRiskDetectorService.publish(orgA);
  check("publish: 2 sinais publicados", p1.published === 2);
  const sig = db.prepare(`SELECT signal_type, severity, evidence_json, impact_amount FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `churn:risk:${cHigh}`) as any;
  check("sinal churn_risk_high publicado (severity risk)", sig?.signal_type === "churn_risk_high" && sig?.severity === "risk");
  check("sinal: impact_amount = total vencido (300)", Number(sig?.impact_amount) === 300);
  const ev = sig ? JSON.parse(sig.evidence_json) : {};
  check("evidência tem score + breakdown + factors", ev?.score === 100 && !!ev?.breakdown && Array.isArray(ev?.factors));
  check("RN-014: evidência diz 'sugere; humano decide'", /humano decide/i.test(ev?.nota || ""));

  // ===== 5. sweep: contato sai do risco → sinal resolvido =====
  db.prepare(`UPDATE receivables SET status = 'received' WHERE id = ?`).run(recHigh); // high agora sem fatura: 30+20=50 < 70
  const p2 = ChurnRiskDetectorService.publish(orgA);
  check("após quitar, high sai do detect", !ChurnRiskDetectorService.detect(orgA).find((c) => c.contactId === cHigh));
  check("sweep resolve o sinal do high", p2.resolved >= 1);
  const sigAfter = db.prepare(`SELECT status FROM business_signals WHERE organization_id = ? AND dedupe_key = ?`).get(orgA, `churn:risk:${cHigh}`) as any;
  check("sinal do high agora status=resolved", sigAfter?.status === "resolved");

  // ===== 6. opt-in por org: runAll ignora quem não optou =====
  const orgC = mkOrg(false); // NÃO opt-in
  const cC = mkContact(orgC, "Dora Off");
  mkOverdue(orgC, cC, 40, 500); mkTicket(orgC, cC, "cold"); // seria high, mas org não optou
  const all = ChurnRiskDetectorService.runAll();
  check("runAll processa só orgs opt-in (orgC fora)", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id = ?`).get(orgC));

  // ===== 7. ISOLAMENTO multi-tenant =====
  const orgB = mkOrg(true);
  check("ISOLAMENTO: detect(orgB) vazio (não vê contatos de orgA)", ChurnRiskDetectorService.detect(orgB).length === 0);

  // ===== resultado =====
  console.log("\n=== ChurnRiskDetector — F4.1 ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ ChurnRiskDetector íntegro");
}

main();
