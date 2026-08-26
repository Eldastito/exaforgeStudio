/**
 * TEST — Hardening / production-readiness da vertical Advocacia (ADR-191 F10).
 * Doc-of-record executável de dupla função:
 *   (A) CODIFICA os guardrails RN-ADV-01..09 como REGRESSÃO tocando os serviços
 *       REAIS (F1–F9);
 *   (B) verifica a FIAÇÃO de produção (serviços importáveis, rota montada, passes
 *       no Scheduler, testes wired no package.json, runbook presente).
 *
 * FECHA o ADR-191. Uso: npm run test:advocacia-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-adv-hard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-adv-hard-123456";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function routePaths(router: any): string[] {
  const out: string[] = [];
  try { for (const l of router?.stack || []) if (l?.route?.path) out.push(String(l.route.path)); } catch { /* noop */ }
  return out;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { LegalPracticeService: P } = await import("../src/server/LegalPracticeService.js");
  const { LegalCaseService: C } = await import("../src/server/LegalCaseService.js");
  const { LegalDeadlineService: DL } = await import("../src/server/LegalDeadlineService.js");
  const { LegalHearingService: H } = await import("../src/server/LegalHearingService.js");
  const { LegalDocumentService: DOC } = await import("../src/server/LegalDocumentService.js");
  const { LegalFeeService: FEE } = await import("../src/server/LegalFeeService.js");
  const { LegalPrivilegeService: PRIV } = await import("../src/server/LegalPrivilegeService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { legalTerms } = await import("../src/lib/legalTerms.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Adv A', 'active', 'advocacia')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'Adv B', 'active', 'advocacia')`).run(randomUUID(), B);
  const clientA = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, 'ch', 'Cliente A', ?)`).run(clientA, A, "5511" + Math.floor(Math.random() * 1e9));

  // ═══════════ (B) FIAÇÃO DE PRODUÇÃO ═══════════
  check("B1 serviços importáveis", typeof C?.open === "function" && typeof DL?.computeDeadline === "function" && typeof H?.schedule === "function" && typeof DOC?.issue === "function" && typeof FEE?.createFixed === "function" && typeof PRIV?.assertAccess === "function");
  const router = (await import("../src/server/routes/advocacia.js")).default as any;
  const rp = routePaths(router);
  check("B2 rotas de processo/prazo montadas", rp.includes("/cases") && rp.includes("/deadlines") && rp.includes("/deadlines/preview"));
  check("B3 rotas de audiência/documento montadas", rp.includes("/hearings") && rp.includes("/documents") && rp.includes("/documents/:id/pdf"));
  check("B4 rotas de honorário/sigilo montadas", rp.includes("/fees") && rp.includes("/fees/statement") && rp.includes("/privilege") && rp.includes("/clients/:contactId/sigilo/grant"));
  const schedulerSrc = fs.readFileSync(path.join(repoRoot, "src/server/Scheduler.ts"), "utf8");
  check("B5 passes no Scheduler (prazo + audiência)", schedulerSrc.includes("LegalDeadlineService.pass()") && schedulerSrc.includes("LegalHearingService.pass()"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const wired = ["test:advocacia-vertical", "test:legal-terms", "test:legal-practice-areas", "test:legal-case", "test:legal-deadline", "test:legal-hearing", "test:legal-document", "test:legal-fee", "test:legal-privilege", "test:advocacia-hardening"];
  check("B6 todos os testes da vertical wired no package.json", wired.every((t) => typeof pkg.scripts?.[t] === "string"));
  check("B7 runbook presente", fs.existsSync(path.join(repoRoot, "docs/runbook/advocacia-operacao.md")));
  check("B8 terminologia gate isLegal", legalTerms("advocacia").isLegal === true && legalTerms("varejo").isLegal === false);

  // ═══════════ (A) GUARDRAILS RN-ADV ═══════════

  // RN-ADV-08 — CNJ validado pelo dígito verificador (nunca inventado).
  let cnjBad = false; try { C.open(A, { contactId: clientA, title: "X", cnjNumber: "0000001-11.2025.8.26.0100" }, "u1"); } catch { cnjBad = true; }
  check("RN-ADV-08 CNJ com DV errado é rejeitado", cnjBad);
  // Gera um CNJ com DV correto (mesma fórmula mód. 97 do serviço) e aceita.
  const seq = "1234567", ano = "2025", seg = "8", trib = "26", orig = "0100";
  const dv = (98n - (BigInt(seq + ano + seg + trib + orig + "00") % 97n)).toString().padStart(2, "0");
  const proc = C.open(A, { contactId: clientA, title: "Ação Principal", cnjNumber: `${seq}${dv}${ano}${seg}${trib}${orig}` }, "u1");
  check("RN-ADV-08 CNJ com DV correto é aceito e normalizado", proc.cnj_number === `${seq}-${dv}.${ano}.${seg}.${trib}.${orig}`);

  // RN-ADV-02/03 — prazo em dias úteis + honestidade do calendário.
  const r = DL.computeDeadline(A, "2025-06-02", 5, "business");
  check("RN-ADV-03 5 dias úteis pulam fim de semana (2025-06-09)", r.dueDate === "2025-06-09");
  check("RN-ADV-02 sem calendário → holidaysLoaded false (não finge precisão)", r.holidaysLoaded === false);

  // RN-ADV-04 — prazo fatal na ESPINHA (nunca alerta paralelo).
  const dl = DL.create(A, { caseId: proc.id, title: "Contestação", publicationDate: "2025-06-02", termDays: 1, countingMode: "business", isFatal: true }, "u1");
  db.prepare(`UPDATE legal_deadlines SET due_date = ? WHERE id = ?`).run(new Date(Date.now() - 86400000).toISOString().slice(0, 10), dl.id);
  const sig = await DL.signalFatal(A, 3);
  const attnDl = BusinessSignalService.attention(A).items.find((i: any) => i.type === "deadline_due");
  check("RN-ADV-04 prazo fatal vencido sinaliza na espinha (critical, domain legal)", sig.signaled >= 1 && !!attnDl && attnDl.severity === "critical" && attnDl.domain === "legal");

  // RN-ADV-06 — documento congelado (snapshot imutável).
  const doc = DOC.createDraft(A, { caseId: proc.id, docType: "peticao", title: "Petição" }, "u1");
  DOC.update(A, doc.id, { body: "corpo" }, "u1");
  DOC.issue(A, doc.id, "u1");
  db.prepare(`UPDATE contacts SET name = 'Renomeado' WHERE id = ?`).run(clientA);
  check("RN-ADV-06 documento emitido congela o snapshot do cliente", DOC.get(A, doc.id).client_name_snapshot === "Cliente A");

  // RN-ADV-07 — nunca inventa dinheiro.
  let feeBad = false; try { FEE.createFixed(A, { caseId: proc.id, description: "sem valor", amount: 0, dueDate: "2025-09-30" }, "u1"); } catch { feeBad = true; }
  check("RN-ADV-07 honorário sem valor é rejeitado", feeBad);
  check("RN-ADV-07 extrato sem honorário → totais NULL (não R$ 0,00)", FEE.statement(A, { caseId: proc.id }).agreedTotal === null);

  // RN-ADV-05/09 — sigilo gated + opt-in (default off = 0-regressão).
  check("RN-ADV-09 sigilo default DESLIGADO (opt-in)", PRIV.isEnabled(A) === false);
  PRIV.setEnabled(A, true, "u1");
  let sigiloBlocked = false; try { DOC.get(A, doc.id); } catch (e: any) { sigiloBlocked = e?.code === "SIGILO_REQUIRED"; }
  check("RN-ADV-05 sigilo ligado sem consentimento barra o conteúdo", sigiloBlocked);
  PRIV.grant(A, clientA, "u1");
  check("RN-ADV-05 consentimento libera o conteúdo", !!DOC.get(A, doc.id));

  // RN-ADV-01 — isolamento multi-tenant (B não vê nada de A).
  check("RN-ADV-01 isolamento: B não enxerga processo/prazo/doc/honorário de A",
    C.list(B).length === 0 && DL.list(B).length === 0 && DOC.list(B).length === 0 && FEE.list(B).length === 0);
  check("RN-ADV-01 isolamento: gate de sigilo de A não afeta B", PRIV.isEnabled(B) === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} advocacia-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
