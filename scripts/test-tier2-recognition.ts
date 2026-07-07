/**
 * TEST — Notas de Reconhecimento (Tier 2, Hunter, ADR-049).
 *
 * Cobre:
 *  1. detect() cria nota + preenche mensagem com nome
 *  2. Dedupe 30 dias (mesma pessoa + trigger não duplica)
 *  3. Diferentes triggers para mesma pessoa CRIAM notas separadas
 *  4. Isolamento entre orgs (mesmo trigger, orgs diferentes = 2 notas)
 *  5. list() ordena suggested primeiro
 *  6. markSent / dismiss + idempotência
 *  7. metrics() calcula pending + sentPct + byTrigger
 *  8. Hook CSAT: SatisfactionService.record(score=5) dispara recognition
 *  9. Hook CSAT: score < 5 NÃO dispara
 * 10. Hook Recovery: resolved_positive dispara recovered_customer recognition
 * 11. Manifesto é injetado no tom da mensagem quando presente
 * 12. detect com orgId vazio devolve null (guard)
 *
 * Uso: npm run test:tier2-recognition
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-recognition-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-recognition-1234567890ab";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RecognitionNotesService } = await import("../src/server/RecognitionNotesService.js");
  const { BusinessManifestoService } = await import("../src/server/BusinessManifestoService.js");
  const { SatisfactionService } = await import("../src/server/SatisfactionService.js");
  const { RecoveryRadarService } = await import("../src/server/RecoveryRadarService.js");

  const seedOrg = (tag: string) => {
    const id = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), id, `Loja ${tag}`);
    return id;
  };
  const seedChannel = (orgId: string) => {
    const id = `ch_${randomUUID().slice(0, 8)}`;
    try { db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'whatsapp', 'C', 'active')`).run(id, orgId); } catch {}
    return id;
  };
  const seedContact = (orgId: string, ch: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(id, orgId, ch, name, `55${id.slice(0, 8)}`);
    return id;
  };

  // ==== 1. detect() cria nota ====
  console.log("\n=== 1. detect + mensagem ===");
  const orgA = seedOrg("A");
  const chA = seedChannel(orgA);
  const anaId = seedContact(orgA, chA, "Ana Souza");

  const note = RecognitionNotesService.detect({
    organizationId: orgA, targetType: "customer", targetId: anaId, triggerType: "csat_high",
    context: { score: 5 },
  });
  check("1.1 devolve nota", !!note && note.id.length > 0);
  check("1.2 status inicial = suggested", note?.status === "suggested");
  check("1.3 mensagem inclui primeiro nome (Ana)", note?.suggestedMessage.includes("Ana") ?? false);
  check("1.4 mensagem é RASCUNHO", note?.suggestedMessage.includes("RASCUNHO") ?? false);

  // ==== 2. Dedupe 30 dias ====
  console.log("\n=== 2. Dedupe 30 dias ===");
  const dup = RecognitionNotesService.detect({
    organizationId: orgA, targetId: anaId, triggerType: "csat_high",
    context: { score: 5, note: "outra ocasião" },
  });
  check("2.1 mesmo target+trigger → MESMO id", dup?.id === note?.id);
  const total = RecognitionNotesService.list(orgA, { status: "all" }).length;
  check("2.2 só 1 nota persistida (dedupe)", total === 1);

  // ==== 3. Trigger diferente = nota nova ====
  console.log("\n=== 3. Trigger diferente = nota nova ===");
  const note2 = RecognitionNotesService.detect({
    organizationId: orgA, targetId: anaId, triggerType: "loyal_repurchase",
    context: { orderCount: 5 },
  });
  check("3.1 outra nota criada", !!note2 && note2.id !== note?.id);
  check("3.2 triggerType correto", note2?.triggerType === "loyal_repurchase");
  const total2 = RecognitionNotesService.list(orgA, { status: "all" }).length;
  check("3.3 total = 2 notas", total2 === 2);

  // ==== 4. Isolamento entre orgs ====
  console.log("\n=== 4. Isolamento ===");
  const orgB = seedOrg("B");
  const chB = seedChannel(orgB);
  const bruno = seedContact(orgB, chB, "Bruno Alves");
  const noteB = RecognitionNotesService.detect({
    organizationId: orgB, targetId: bruno, triggerType: "csat_high", context: { score: 5 },
  });
  check("4.1 B tem 1 nota", RecognitionNotesService.list(orgB, { status: "all" }).length === 1);
  check("4.2 A continua com 2", RecognitionNotesService.list(orgA, { status: "all" }).length === 2);
  check("4.3 noteB pertence a B", noteB?.organizationId === orgB);

  // ==== 5. list() ordena suggested primeiro ====
  console.log("\n=== 5. list ordem ===");
  RecognitionNotesService.markSent(orgA, note!.id, {});
  const listed = RecognitionNotesService.list(orgA, { status: "all" });
  check("5.1 primeira é suggested", listed[0]?.status === "suggested");
  check("5.2 sent aparece depois", listed.some(n => n.status === "sent"));

  // ==== 6. markSent + dismiss + idempotência ====
  console.log("\n=== 6. transições ===");
  const asSent = RecognitionNotesService.markSent(orgA, note!.id, {});
  check("6.1 markSent idempotente", asSent === true);
  const sentRow = RecognitionNotesService.list(orgA, { status: "sent" });
  check("6.2 nota está em sent", sentRow.some(n => n.id === note!.id));
  const dismissed = RecognitionNotesService.dismiss(orgA, note2!.id, { handledBy: "u1" });
  check("6.3 dismiss retorna true", dismissed === true);
  const dismissedList = RecognitionNotesService.list(orgA, { status: "dismissed" });
  check("6.4 nota está em dismissed", dismissedList.some(n => n.id === note2!.id));
  check("6.5 markSent com id inexistente = false", RecognitionNotesService.markSent(orgA, "nao-existe", {}) === false);
  check("6.6 dismiss de OUTRA org = false (isolamento)", RecognitionNotesService.dismiss(orgB, note!.id, {}) === false);

  // ==== 7. metrics ====
  console.log("\n=== 7. metrics ===");
  // Cria mais notas na org A pra teste completo:
  const c2 = seedContact(orgA, chA, "Carla Lima");
  const c3 = seedContact(orgA, chA, "Diana Rosa");
  const c4 = seedContact(orgA, chA, "Eva Neta");
  RecognitionNotesService.detect({ organizationId: orgA, targetId: c2, triggerType: "csat_high" });
  RecognitionNotesService.detect({ organizationId: orgA, targetId: c3, triggerType: "high_ticket_order" });
  RecognitionNotesService.detect({ organizationId: orgA, targetId: c4, triggerType: "high_ticket_order" });
  const m = RecognitionNotesService.metrics(orgA, 30);
  check("7.1 pending > 0", m.pending >= 3);
  check("7.2 total >= 5", m.total >= 5);
  check("7.3 byTrigger tem csat_high", (m.byTrigger.csat_high || 0) >= 1);
  check("7.4 byTrigger tem high_ticket_order", (m.byTrigger.high_ticket_order || 0) >= 2);

  // ==== 8. Hook CSAT: score 5 dispara ====
  console.log("\n=== 8. Hook CSAT score=5 dispara ===");
  const orgC = seedOrg("C");
  const chC = seedChannel(orgC);
  const zeca = seedContact(orgC, chC, "Zeca Melo");
  const surveyId = SatisfactionService.create(orgC, { contactId: zeca });
  check("8.1 survey criada", !!surveyId);
  const preCount = RecognitionNotesService.list(orgC, { status: "all" }).length;
  SatisfactionService.record(orgC, surveyId!, 5, "Amei o atendimento");
  const postCount = RecognitionNotesService.list(orgC, { status: "all" }).length;
  check("8.2 score=5 cria +1 recognition", postCount === preCount + 1);
  const csatNote = RecognitionNotesService.list(orgC, { status: "suggested" }).find(n => n.targetId === zeca);
  check("8.3 recognition tem targetId = zeca", !!csatNote);
  check("8.4 trigger = csat_high", csatNote?.triggerType === "csat_high");

  // ==== 9. Hook CSAT: score < 5 NÃO dispara ====
  console.log("\n=== 9. Hook CSAT score<5 NÃO dispara ===");
  const jony = seedContact(orgC, chC, "Jony");
  const s2 = SatisfactionService.create(orgC, { contactId: jony });
  const beforeLow = RecognitionNotesService.list(orgC, { status: "all" }).length;
  SatisfactionService.record(orgC, s2!, 4, "");
  SatisfactionService.record(orgC, SatisfactionService.create(orgC, { contactId: jony })!, 3, "não gostei");
  const afterLow = RecognitionNotesService.list(orgC, { status: "all" }).length;
  check("9.1 notas 3 e 4 NÃO geram recognition", afterLow === beforeLow);

  // ==== 10. Hook Recovery: resolved_positive dispara ====
  console.log("\n=== 10. Hook Recovery resolved_positive ===");
  const nubia = seedContact(orgC, chC, "Núbia");
  const rec = RecoveryRadarService.detect({
    organizationId: orgC, contactId: nubia, triggerType: "order_cancelled",
    context: { finalStatus: "cancelado" },
  });
  check("10.1 recovery event criado", !!rec);
  const preRec = RecognitionNotesService.list(orgC, { status: "all" }).filter(n => n.targetId === nubia).length;
  RecoveryRadarService.updateStatus(orgC, rec!.id, "resolved_positive", { handledBy: "dono" });
  const postRec = RecognitionNotesService.list(orgC, { status: "all" }).filter(n => n.targetId === nubia).length;
  check("10.2 resolved_positive cria +1 recognition", postRec === preRec + 1);
  const recNote = RecognitionNotesService.list(orgC, { status: "all" }).find(n => n.targetId === nubia);
  check("10.3 trigger = recovered_customer", recNote?.triggerType === "recovered_customer");

  // ==== 10b. Recovery escalated_human NÃO dispara ====
  const outro = seedContact(orgC, chC, "Kleber");
  const rec2 = RecoveryRadarService.detect({
    organizationId: orgC, contactId: outro, triggerType: "complaint_detected",
    context: {},
  });
  const preRec2 = RecognitionNotesService.list(orgC, { status: "all" }).filter(n => n.targetId === outro).length;
  RecoveryRadarService.updateStatus(orgC, rec2!.id, "escalated_human", {});
  const postRec2 = RecognitionNotesService.list(orgC, { status: "all" }).filter(n => n.targetId === outro).length;
  check("10.4 escalated_human NÃO dispara recognition", postRec2 === preRec2);

  // ==== 11. Manifesto injetado no tom ====
  console.log("\n=== 11. Manifesto injetado ===");
  BusinessManifestoService.save(orgC, {
    whyStatement: "Ajudar donas de loja",
    toneVoice: "Amiga, direta, brasileira, sem formalidade",
  } as any);
  const bruna = seedContact(orgC, chC, "Bruna");
  const noteWithTone = RecognitionNotesService.detect({
    organizationId: orgC, targetId: bruna, triggerType: "loyal_repurchase",
  });
  check("11.1 mensagem cita o tom customizado", noteWithTone?.suggestedMessage.includes("Amiga, direta, brasileira") ?? false);

  // ==== 12. Guards ====
  console.log("\n=== 12. Guards ===");
  check("12.1 orgId vazio → null", RecognitionNotesService.detect({ organizationId: "", triggerType: "csat_high" }) === null);
  check("12.2 triggerType vazio → null", RecognitionNotesService.detect({ organizationId: orgA, triggerType: "" as any }) === null);
  check("12.3 labelFor devolve label pt-br", RecognitionNotesService.labelFor("csat_high").length > 0);

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — Notas de Reconhecimento (Tier 2)");
  console.log("=========================================");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  if (failures > 0) {
    console.log(`❌ ${failures} falhas`);
    process.exit(1);
  }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  process.exit(1);
});
