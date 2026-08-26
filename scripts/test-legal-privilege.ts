/**
 * TEST — Sigilo profissional (ADR-191 F9). DB-backed, determinístico.
 * Prova o gate LGPD OPT-IN (RN-ADV-05/09): desligado é 0-regressão; ligado, o CONTEÚDO
 * dos documentos do caso (get/PDF) só é exposto com consentimento `sigilo_profissional`
 * do cliente; a lista REDIGE o corpo dos clientes sem consentimento; operações do
 * escritório (criar/emitir/cancelar) NÃO são bloqueadas; revogar volta a barrar.
 *
 * Uso: npm run test:legal-privilege
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legalpriv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legalpriv-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalDocumentService: D } = await import("../src/server/LegalDocumentService.js");
  const { LegalPrivilegeService: PR } = await import("../src/server/LegalPrivilegeService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Adv', 'active', 'advocacia')`).run(randomUUID(), A);
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const proc = C.open(A, { contactId: clientId, title: "Ação Sigilosa" }, "u1");
  const doc = D.createDraft(A, { caseId: proc.id, docType: "peticao", title: "Petição confidencial" }, "u1");
  D.update(A, doc.id, { body: "Conteúdo estritamente sigiloso do cliente." }, "u1");

  // ── 1. Gate DESLIGADO (default) → 0-regressão: lê conteúdo normalmente ──
  check("1.1 gate default desligado", PR.isEnabled(A) === false);
  check("1.2 desligado → get expõe o conteúdo", D.get(A, doc.id).body === "Conteúdo estritamente sigiloso do cliente.");
  check("1.3 desligado → lista traz o corpo", D.list(A, { caseId: proc.id })[0].body !== null);

  // ── 2. Gate LIGADO sem consentimento → barra o CONTEÚDO ──
  PR.setEnabled(A, true, "u1");
  check("2.1 status: ligado + sem consentimento", PR.status(A, clientId).enabled === true && PR.status(A, clientId).hasConsent === false);
  let blocked = false, code = "";
  try { D.get(A, doc.id); } catch (e: any) { blocked = true; code = e?.code; }
  check("2.2 get bloqueado sem consentimento (SIGILO_REQUIRED)", blocked && code === "SIGILO_REQUIRED");
  let pdfBlocked = false; try { await D.renderPdf(A, doc.id); } catch (e: any) { pdfBlocked = e?.code === "SIGILO_REQUIRED"; }
  check("2.3 PDF bloqueado sem consentimento", pdfBlocked);
  const redacted = D.list(A, { caseId: proc.id })[0];
  check("2.4 lista REDIGE o corpo (metadado visível, conteúdo não)", redacted.body === null && redacted.sigilo_redacted === 1 && redacted.title === "Petição confidencial");

  // ── 3. Operações do escritório NÃO são bloqueadas pelo gate ──
  const doc2 = D.createDraft(A, { caseId: proc.id, docType: "contrato", title: "Contrato" }, "u1");
  check("3.1 criar rascunho funciona com gate ligado", !!doc2 && doc2.status === "draft");
  D.update(A, doc2.id, { body: "corpo do contrato" }, "u1");
  const issued = D.issue(A, doc2.id, "u1");
  check("3.2 emitir funciona com gate ligado", issued.status === "issued");
  const canc = D.cancel(A, doc2.id, "erro", "u1");
  check("3.3 cancelar funciona com gate ligado", canc.status === "cancelled");

  // ── 4. Conceder consentimento → libera o conteúdo ──
  PR.grant(A, clientId, "u1");
  check("4.1 concedido → status hasConsent true", PR.status(A, clientId).hasConsent === true);
  check("4.2 concedido → get expõe conteúdo de novo", D.get(A, doc.id).body === "Conteúdo estritamente sigiloso do cliente.");
  const pdf = await D.renderPdf(A, doc.id);
  check("4.3 concedido → PDF gera", Buffer.isBuffer(pdf) && pdf.length > 300);
  check("4.4 concedido → lista não redige mais", D.list(A, { caseId: proc.id }).find((x: any) => x.id === doc.id).body !== null);

  // ── 5. Revogar → volta a barrar ──
  PR.revoke(A, clientId, "u1");
  let reblocked = false; try { D.get(A, doc.id); } catch (e: any) { reblocked = e?.code === "SIGILO_REQUIRED"; }
  check("5.1 revogar volta a barrar o conteúdo", reblocked);

  // ── 6. Consentimento inválido (cliente inexistente) rejeitado ──
  let e1 = false; try { PR.grant(A, randomUUID(), "u1"); } catch { e1 = true; }
  check("6.1 conceder sigilo a cliente inexistente é rejeitado", e1);

  // ── 7. Isolamento: gate de A não afeta B ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("7.1 org B tem gate desligado (isolado)", PR.isEnabled(B) === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-privilege: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
