/**
 * TEST — Radar de Recuperação Disney (Tier 2, ADR-047).
 *
 * Cobre:
 *  1. detect() cria evento + gera playbook em 4 passos
 *  2. Dedupe: mesmo contato + trigger em 7 dias NÃO duplica
 *  3. Playbook usa nome do contato quando disponível
 *  4. Playbook usa tom do Manifesto quando presente (fallback caso vazio)
 *  5. list() com filtros + updateStatus com transições
 *  6. Métricas: recovery rate, avg time, byTrigger
 *  7. Hook: OpportunityRadar dispara complaint_detected por contato individual
 *  8. Isolamento entre tenants
 *
 * Uso: npm run test:tier2-recovery-radar
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-recovery-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-recovery-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RecoveryRadarService } = await import("../src/server/RecoveryRadarService.js");
  const { BusinessManifestoService } = await import("../src/server/BusinessManifestoService.js");
  const { OpportunityRadarService } = await import("../src/server/OpportunityRadarService.js");

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
  const seedContact = (orgId: string, ch: string, name = "Ana") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, ch, name, `55${id.slice(0, 8)}`);
    return id;
  };

  // ==== 1. detect() cria evento + gera playbook ====
  console.log("\n=== 1. detect + playbook ===");
  const orgA = seedOrg("A");
  const chA = seedChannel(orgA);
  const anaId = seedContact(orgA, chA, "Ana Souza");

  const evt = RecoveryRadarService.detect({
    organizationId: orgA, contactId: anaId, triggerType: "order_cancelled",
    context: { finalStatus: "cancelado", totalAmount: 250 },
  });
  check("1.1 detect devolve evento", !!evt && evt.id.length > 0);
  check("1.2 status inicial = triggered", evt?.status === "triggered");
  check("1.3 playbook usa nome do contato", evt?.playbookText.includes("Ana Souza") ?? false);
  check("1.4 playbook tem 4 passos Disney (1️⃣ 2️⃣ 3️⃣ 4️⃣)", ["1️⃣", "2️⃣", "3️⃣", "4️⃣"].every((n) => evt?.playbookText.includes(n)));
  check("1.5 playbook explica que é rascunho", evt?.playbookText.includes("RASCUNHO") ?? false);

  // ==== 2. Dedupe ====
  console.log("\n=== 2. Dedupe em 7 dias ===");
  const evt2 = RecoveryRadarService.detect({
    organizationId: orgA, contactId: anaId, triggerType: "order_cancelled",
    context: { finalStatus: "reembolso", totalAmount: 500 },
  });
  check("2.1 Mesmo contato + trigger devolve MESMO id", evt2?.id === evt?.id);
  const totalA = RecoveryRadarService.list(orgA, { status: "all" }).length;
  check("2.2 Só 1 linha ativa por par contato+trigger", totalA === 1);
  // Trigger diferente cria linha nova
  const evt3 = RecoveryRadarService.detect({
    organizationId: orgA, contactId: anaId, triggerType: "complaint_detected",
    context: { snippet: "atendimento ruim" },
  });
  check("2.3 Trigger diferente cria linha nova", evt3?.id !== evt?.id);
  check("2.4 Agora 2 linhas ativas", RecoveryRadarService.list(orgA, { status: "all" }).length === 2);

  // ==== 3. Manifesto influencia tom ====
  console.log("\n=== 3. Tom do Manifesto ===");
  const orgB = seedOrg("B");
  BusinessManifestoService.save(orgB, {
    whyStatement: "Desafogar donos",
    toneVoice: "Registro casual carinhoso. Usamos: 'ó', 'partiu'. Evitamos: 'querido(a)'.",
  });
  const chB = seedChannel(orgB);
  const contactB = seedContact(orgB, chB, "Bruno");
  const evtB = RecoveryRadarService.detect({
    organizationId: orgB, contactId: contactB, triggerType: "pix_expired",
  });
  check("3.1 Playbook menciona tom do Manifesto quando presente", evtB?.playbookText.includes("Registro casual carinhoso") ?? false);
  // Fallback quando não há Manifesto
  const orgC = seedOrg("C");
  const evtC = RecoveryRadarService.detect({
    organizationId: orgC, triggerType: "delay_detected",
  });
  check("3.2 Playbook cai em tom padrão quando Manifesto vazio", evtC?.playbookText.includes("próximo e cordial") ?? false);

  // ==== 4. list() com filtros ====
  console.log("\n=== 4. list + filtros ===");
  check("4.1 status='active' pega triggered + playbook_sent",
    RecoveryRadarService.list(orgA, { status: "active" }).length === 2);
  RecoveryRadarService.updateStatus(orgA, evt3!.id, "playbook_sent", { handledBy: "user-1" });
  check("4.2 Após updateStatus 'playbook_sent', continua em 'active'",
    RecoveryRadarService.list(orgA, { status: "active" }).length === 2);
  RecoveryRadarService.updateStatus(orgA, evt3!.id, "resolved_positive", { handledBy: "user-1", notes: "Cliente voltou e comprou de novo" });
  check("4.3 Após resolved_positive, sai de 'active'",
    RecoveryRadarService.list(orgA, { status: "active" }).length === 1);
  const resolved = RecoveryRadarService.list(orgA, { status: "resolved_positive" });
  check("4.4 Filtro por status específico funciona", resolved.length === 1 && resolved[0].id === evt3!.id);
  check("4.5 Nota de resolução persistida", resolved[0].resolutionNotes?.includes("Cliente voltou") ?? false);

  // ==== 5. Transições inválidas + isolamento ====
  console.log("\n=== 5. Isolamento entre orgs ===");
  const cross = RecoveryRadarService.updateStatus(seedOrg("outra"), evt!.id, "dismissed");
  check("5.1 Outra org NÃO consegue atualizar", cross === false);
  const otherView = RecoveryRadarService.list(seedOrg("outra2"));
  check("5.2 Outra org NÃO enxerga eventos", otherView.length === 0);

  // ==== 6. Métricas ====
  console.log("\n=== 6. Métricas ===");
  // Precisa de mais eventos pra rate ficar não-null
  const contD = seedContact(orgA, chA, "Carlos"), contE = seedContact(orgA, chA, "Diego");
  const eD = RecoveryRadarService.detect({ organizationId: orgA, contactId: contD, triggerType: "complaint_detected" });
  const eE = RecoveryRadarService.detect({ organizationId: orgA, contactId: contE, triggerType: "delay_detected" });
  RecoveryRadarService.updateStatus(orgA, eD!.id, "resolved_positive");
  RecoveryRadarService.updateStatus(orgA, eE!.id, "resolved_neutral");
  const m = RecoveryRadarService.metrics(orgA);
  check("6.1 total conta todos os eventos", m.total === 4);
  check("6.2 recovered conta apenas resolved_positive", m.recovered === 2);
  check("6.3 recoveryRate calculado quando denominador >= 3", m.recoveryRate === 0.67);
  check("6.4 byTrigger agrega corretamente",
    (m.byTrigger.order_cancelled || 0) === 1 && (m.byTrigger.complaint_detected || 0) === 2 && (m.byTrigger.delay_detected || 0) === 1);
  check("6.5 avgResolutionHours definido quando há resolved_at", m.avgResolutionHours !== null && m.avgResolutionHours >= 0);

  // Denominador pequeno → null
  const orgSmall = seedOrg("small");
  const mSmall = RecoveryRadarService.metrics(orgSmall);
  check("6.6 recoveryRate null quando amostra insuficiente", mSmall.recoveryRate === null);

  // ==== 7. OpportunityRadar dispara complaint_detected por contato ====
  console.log("\n=== 7. Hook OpportunityRadar → RecoveryRadar ===");
  const orgH = seedOrg("hook");
  const chH = seedChannel(orgH);
  const ct1 = seedContact(orgH, chH, "Ana H"),
        ct2 = seedContact(orgH, chH, "Bia H"),
        ct3 = seedContact(orgH, chH, "Cris H");
  const seedMsg = (orgId: string, ticketId: string, sender: string, content: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, ticketId, sender, content);
    return id;
  };
  const seedTicket = (orgId: string, contactId: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage) VALUES (?, ?, ?, 'open', 'novo_lead')`).run(id, orgId, contactId);
    return id;
  };
  const tk1 = seedTicket(orgH, ct1), tk2 = seedTicket(orgH, ct2), tk3 = seedTicket(orgH, ct3);
  seedMsg(orgH, tk1, "contact", "Ficou péssimo o atendimento, demorou muito");
  seedMsg(orgH, tk2, "contact", "Vim reclamar, produto quebrou de novo");
  seedMsg(orgH, tk3, "contact", "Serviço ruim, tô decepcionado, quero cancelar");

  OpportunityRadarService.scan(orgH);
  const recoveries = RecoveryRadarService.list(orgH, { status: "all" });
  check("7.1 3 reclamações → 3 recovery events (1 por contato)", recoveries.length === 3);
  check("7.2 Todos são trigger=complaint_detected", recoveries.every((r) => r.triggerType === "complaint_detected"));
  check("7.3 Cada evento traz contactName no context",
    recoveries.every((r) => typeof r.triggerContext?.contactName === "string" && r.triggerContext.contactName.length > 0));

  // Segundo scan não duplica
  OpportunityRadarService.scan(orgH);
  check("7.4 Rescan não duplica recovery events", RecoveryRadarService.list(orgH, { status: "all" }).length === 3);

  // ==== 8. labelFor + trigger inválido gracioso ====
  console.log("\n=== 8. Robustez ===");
  check("8.1 labelFor devolve label legível", RecoveryRadarService.labelFor("pix_expired").includes("PIX"));
  const bad = RecoveryRadarService.detect({ organizationId: "", triggerType: "order_cancelled" });
  check("8.2 detect com orgId vazio devolve null", bad === null);

  console.log("\n──── Resultados ────");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
