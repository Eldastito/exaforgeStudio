/**
 * TEST — Documentos jurídicos (ADR-191 F7). DB-backed, determinístico.
 * Prova o ciclo rascunho→emitido, o CONGELAMENTO do documento (RN-ADV-06: snapshot +
 * hash canônico estáveis mesmo renomeando cliente/negócio), a imutabilidade do emitido,
 * a assinatura por PIN (reuso da infra da clínica) e o PDF.
 *
 * Uso: npm run test:legal-document
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-legaldoc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-legaldoc-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalDocumentService: D } = await import("../src/server/LegalDocumentService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");
  const { LegalPracticeService: P } = await import("../src/server/LegalPracticeService.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Silva Advocacia', 'active', 'advocacia')`).run(randomUUID(), A);
  const clientId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'João Cliente', ?)`).run(clientId, A, "5511" + Math.floor(Math.random() * 1e9));
  const lawyer = P.createLawyer(A, { name: "Dra. Ana", oabUf: "SP", oabNumber: "123456" }, "u1");
  const proc = C.open(A, { contactId: clientId, title: "Ação Cível", responsibleLawyerId: lawyer.id }, "u1");

  // ── 1. Criar rascunho (cliente/advogado DERIVADOS do processo) ──
  const d1 = D.createDraft(A, { caseId: proc.id, docType: "peticao", title: "Petição Inicial" }, "u1");
  check("1.1 rascunho criado", d1.status === "draft" && d1.doc_type === "peticao");
  check("1.2 cliente DERIVADO do processo (nunca inventado)", d1.contact_id === clientId);
  check("1.3 advogado default = responsável pelo processo", d1.professional_id === lawyer.id);

  // ── 2. Validações ──
  let e1 = false; try { D.createDraft(A, { caseId: proc.id, docType: "recibo_pet", title: "X" }, "u1"); } catch { e1 = true; }
  check("2.1 tipo de documento inválido rejeitado", e1);
  let e2 = false; try { D.createDraft(A, { docType: "contrato", title: "Sem cliente" }, "u1"); } catch { e2 = true; }
  check("2.2 sem processo e sem contactId → rejeitado", e2);
  let e3 = false; try { D.issue(A, d1.id, "u1"); } catch { e3 = true; }
  check("2.3 emitir sem conteúdo é rejeitado", e3);

  // ── 3. Editar rascunho + emitir SEM PIN (compat) ──
  D.update(A, d1.id, { body: "Excelentíssimo Senhor Doutor Juiz... (corpo da petição)" }, "u1");
  const issued = D.issue(A, d1.id, "u1");
  check("3.1 emitido sem PIN → status issued, sem assinatura", issued.status === "issued" && issued.signed_with_pin === 0 && issued.signature_hash === null);
  check("3.2 snapshots congelados na emissão", issued.client_name_snapshot === "João Cliente" && issued.business_name_snapshot === "Silva Advocacia" && issued.professional_name_snapshot === "Dra. Ana");

  // ── 4. RN-ADV-06: documento congelado (renomear cliente/negócio NÃO altera o doc) ──
  db.prepare(`UPDATE contacts SET name = 'João Renomeado' WHERE id = ?`).run(clientId);
  db.prepare(`UPDATE organization_settings SET business_name = 'Outro Nome LTDA' WHERE organization_id = ?`).run(A);
  const after = D.get(A, d1.id);
  check("4.1 snapshot do cliente permanece o do momento da emissão", after.client_name_snapshot === "João Cliente");
  check("4.2 snapshot do negócio permanece o do momento da emissão", after.business_name_snapshot === "Silva Advocacia");

  // ── 5. Imutabilidade do emitido ──
  let e4 = false; try { D.update(A, d1.id, { title: "Mudei" }, "u1"); } catch { e4 = true; }
  check("5.1 documento emitido é imutável (update recusado)", e4);

  // ── 6. Assinatura por PIN + hash canônico estável (reuso da infra da clínica) ──
  ClinicAgendaService.setProfessionalPin(A, lawyer.id, "4321", "u1");
  const d2 = D.createDraft(A, { caseId: proc.id, docType: "procuracao", title: "Procuração ad judicia" }, "u1");
  D.update(A, d2.id, { body: "Outorgo poderes ao advogado para o foro em geral." }, "u1");
  let pinReq = false; try { D.issue(A, d2.id, "u1"); } catch (e: any) { pinReq = e?.code === "PIN_REQUIRED"; }
  check("6.1 advogado com PIN exige PIN pra emitir", pinReq);
  const signed = D.issue(A, d2.id, "u1", { pin: "4321" });
  check("6.2 emitido com PIN → assinatura + hash presentes", signed.signed_with_pin === 1 && typeof signed.signature_hash === "string" && signed.signature_hash.length === 64);
  // Re-emitir é idempotente (retorna o mesmo hash congelado).
  check("6.3 re-emissão idempotente preserva o hash", D.issue(A, d2.id, "u1").signature_hash === signed.signature_hash);

  // ── 7. PDF (emitido e rascunho) ──
  const pdf = await D.renderPdf(A, d2.id);
  check("7.1 PDF do emitido gera buffer válido", Buffer.isBuffer(pdf) && pdf.length > 500 && pdf.slice(0, 4).toString() === "%PDF");
  const d3 = D.createDraft(A, { caseId: proc.id, docType: "contrato", title: "Contrato de honorários" }, "u1");
  const pdfDraft = await D.renderPdf(A, d3.id);
  check("7.2 PDF do rascunho também gera buffer", Buffer.isBuffer(pdfDraft) && pdfDraft.length > 300);

  // ── 8. Cancelar (retenção — nunca DELETE) + listagens ──
  const canc = D.cancel(A, d3.id, "desistência", "u1");
  check("8.1 cancelar marca cancelled + preserva a linha", canc.status === "cancelled" && !!D.get(A, d3.id));
  check("8.2 listar por processo traz os 3 documentos", D.list(A, { caseId: proc.id }).length === 3);
  check("8.3 filtrar por tipo", D.list(A, { docType: "procuracao" }).length === 1);

  // ── 9. Isolamento ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Outro', 'active', 'advocacia')`).run(randomUUID(), B);
  check("9.1 org B não enxerga documentos de A", D.list(B).length === 0 && D.get(B, d2.id) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} legal-document: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
