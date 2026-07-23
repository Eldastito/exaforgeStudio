/**
 * TEST — Governança de IA (ADR-130): sugestão que afeta pessoa nunca executa
 * sozinha (exige humano + motivo), tudo auditado. Sem chave de IA.
 *
 * Uso: npm run test:ai-governance
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-aigov-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-aigov-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AiGovernanceService: G } = await import("../src/server/AiGovernanceService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
  const cnt = (o: string) => (db.prepare("SELECT COUNT(*) c FROM ai_decisions WHERE organization_id=?").get(o) as any).c;

  // ===== 1. Registro de sugestões que afetam pessoas =====
  check("lista negra é sugestão que afeta pessoa", G.isPeopleAffecting("fiado_blacklist"));
  check("tipo neutro não afeta pessoa", G.isPeopleAffecting("relatorio_qualquer") === false);

  // ===== 2. GUARDRAIL: aplicar sem humano/motivo é bloqueado =====
  let threw = false;
  try { G.recordDecision(orgId, { kind: "fiado_blacklist", subjectId: "c1", decision: "applied" }); } catch (e: any) { threw = e?.code === "human_decision_required"; }
  check("aplicar sem humano+motivo lança human_decision_required", threw);
  check("nada foi gravado quando o guardrail barrou", cnt(orgId) === 0);

  // Sem motivo (só ator) também barra.
  let threw2 = false;
  try { G.recordDecision(orgId, { kind: "fiado_blacklist", subjectId: "c1", decision: "applied", actorId: "user-1", reason: "  " }); } catch (e: any) { threw2 = e?.code === "human_decision_required"; }
  check("aplicar sem motivo (só ator) também barra", threw2);

  // ===== 3. Com humano + motivo: aplica e AUDITA =====
  const r = G.recordDecision(orgId, { kind: "fiado_blacklist", subjectId: "c1", decision: "applied", actorId: "user-1", reason: "35 dias em atraso", suggestedBy: "ai" });
  check("com humano+motivo, aplica", (r as any).ok === true);
  const row = db.prepare("SELECT * FROM ai_decisions WHERE organization_id=? AND kind='fiado_blacklist' LIMIT 1").get(orgId) as any;
  check("decisão auditada com motivo, ator e origem (ai)", row && row.reason === "35 dias em atraso" && row.actor_user_id === "user-1" && row.suggested_by === "ai" && row.decision === "applied");

  // ===== 3b. Outros fluxos que afetam pessoas: limite e suspensão total =====
  check("limite de crédito afeta pessoa", G.isPeopleAffecting("fiado_limit"));
  check("suspensão total afeta pessoa", G.isPeopleAffecting("fiado_block_all"));
  // Ambos exigem humano + motivo ao aplicar.
  let threwLim = false;
  try { G.recordDecision(orgId, { kind: "fiado_limit", subjectId: "c2", decision: "applied", actorId: "user-1" }); } catch (e: any) { threwLim = e?.code === "human_decision_required"; }
  check("definir limite sem motivo é barrado", threwLim);
  let threwBlk = false;
  try { G.recordDecision(orgId, { kind: "fiado_block_all", subjectId: "c2", decision: "applied", reason: "risco" }); } catch (e: any) { threwBlk = e?.code === "human_decision_required"; }
  check("suspensão total sem ator é barrada", threwBlk);
  // Com humano + motivo: aplicam e auditam.
  const rl = G.recordDecision(orgId, { kind: "fiado_limit", subjectId: "c2", decision: "applied", actorId: "user-1", reason: "bom histórico de pagamento" });
  check("limite com humano+motivo aplica", (rl as any).ok === true);
  const rb = G.recordDecision(orgId, { kind: "fiado_block_all", subjectId: "c2", decision: "applied", actorId: "user-1", reason: "inadimplência reiterada" });
  check("suspensão total com humano+motivo aplica", (rb as any).ok === true);
  const audited = db.prepare("SELECT kind FROM ai_decisions WHERE organization_id=? AND decision='applied'").all(orgId).map((r: any) => r.kind);
  check("as duas decisões ficam auditadas", audited.includes("fiado_limit") && audited.includes("fiado_block_all"));

  // ===== 4. 'dismissed' e tipos neutros não travam =====
  const d = G.recordDecision(orgId, { kind: "fiado_blacklist", subjectId: "c1", decision: "dismissed" });
  check("dismissed não exige humano/motivo", (d as any).ok === true);
  const n = G.recordDecision(orgId, { kind: "relatorio_qualquer", decision: "applied" });
  check("tipo que não afeta pessoa não trava", (n as any).ok === true);

  // ===== 5. Política publicável + checklist de fairness =====
  const pol = G.policy();
  check("política lista controles (LGPD, viés, auditoria...)", Array.isArray(pol.controles) && pol.controles.length >= 5);
  check("política expõe as sugestões que afetam pessoas", pol.peopleAffecting.some((p: any) => p.kind === "fiado_blacklist" && /comportamento/.test(p.basis)));
  check("checklist de fairness presente", Array.isArray(pol.checklistFairness) && pol.checklistFairness.length >= 3);

  // ===== 6. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  check("isolamento: outra org sem decisões", cnt(other) === 0 && G.decisions(other).length === 0);

  // ===== 7. Trilha de reabilitação (restrição antiga ainda ativa) =====
  const cOld = "contact-reab-old";
  db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente Antigo', ?)").run(cOld, orgId, "5521999900");
  G.recordDecision(orgId, { kind: "fiado_block_all", subjectId: cOld, decision: "applied", actorId: "user-1", reason: "inadimplência reiterada" });
  db.prepare("UPDATE ai_decisions SET created_at = datetime('now','-40 days') WHERE organization_id=? AND kind='fiado_block_all' AND subject_id=?").run(orgId, cOld);
  const due = G.rehabilitationDue(orgId, 30);
  check("restrição ativa há 40d aparece para revisão", due.some((d: any) => d.subjectId === cOld && d.kind === "fiado_block_all"));
  check("nome do sujeito é resolvido pelo contato", (due.find((d: any) => d.subjectId === cOld) || {}).subjectName === "Cliente Antigo");
  check("dias ativos calculados (~40)", (due.find((d: any) => d.subjectId === cOld) || {}).daysActive >= 39);

  const cNew = "contact-reab-new";
  db.prepare("INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente Novo', ?)").run(cNew, orgId, "5521888800");
  G.recordDecision(orgId, { kind: "fiado_blacklist", subjectId: cNew, decision: "applied", actorId: "user-1", reason: "atraso" });
  check("restrição recente NÃO entra na trilha", !G.rehabilitationDue(orgId, 30).some((d: any) => d.subjectId === cNew));

  // Reverter (dismissed) tira da trilha de reabilitação.
  G.recordDecision(orgId, { kind: "fiado_block_all", subjectId: cOld, decision: "dismissed", actorId: "user-1", reason: "reabilitado" });
  check("restrição revertida sai da trilha", !G.rehabilitationDue(orgId, 30).some((d: any) => d.subjectId === cOld));
  // Limite de crédito não é bloqueio — nunca entra na trilha de reabilitação.
  check("limite de crédito não entra na trilha", !G.rehabilitationDue(orgId, 0).some((d: any) => d.kind === "fiado_limit"));
  check("trilha de reabilitação isolada por org", G.rehabilitationDue(other, 0).length === 0);

  // ===== 8. Exportação para auditoria externa (CSV/PDF) =====
  const repRows = G.decisionsReportRows(orgId);
  check("relatório tem cabeçalho legível", repRows[0].join(",") === "Data,Tipo,Sujeito,Decisão,Sugerido por,Responsável,Motivo");
  check("relatório traz as decisões (com dados)", repRows.length > 1);
  const flat = repRows.slice(1).map((r: any) => r.join(" | ")).join("\n");
  check("relatório usa rótulo legível do tipo (não a chave crua)", flat.includes("Lista negra de fiado") && !flat.includes("fiado_blacklist"));
  check("relatório mostra origem IA/humano em texto", flat.includes(" | IA | ") || flat.includes(" | humano | "));
  const { ReportPdfService } = await import("../src/server/ReportPdfService.js");
  const pdf = await ReportPdfService.generateGovernancePdf(orgId, { policy: G.policy(), rows: repRows });
  check("PDF de governança é gerado (assinatura %PDF)", Buffer.isBuffer(pdf) && pdf.length > 500 && pdf.slice(0, 4).toString() === "%PDF");
  check("exportação isolada por org (outra org sem linhas de dados)", G.decisionsReportRows(other).length === 1);

  // --- Relatório ---
  console.log("\n=== TEST: Governança de IA (ADR-130) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Governança de IA OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
