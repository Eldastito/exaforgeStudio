/**
 * TESTE — 19/09/2026: ingestão do COMPROVANTE DE DEPÓSITO pelo WhatsApp.
 * -----------------------------------------------------------------------
 * Dor do dono (Toulon): a loja deposita o malote toda segunda e manda o
 * comprovante por WhatsApp — mas o depósito nunca era registrado, então o
 * card "EM CAIXA (A DEPOSITAR)" só acumulava. Esta fatia liga a foto do
 * comprovante (ou o valor em texto) direto no `retail_cash_deposits`.
 *
 * Prova, offline (OCR stubado via __setDepositExtractorForTests):
 *  - foto + legenda "depósito" → OCR lê valor+data → registrado com comprovante;
 *  - reenvio do MESMO comprovante → dedupe (não conta em dobro);
 *  - valor em TEXTO ("depositei 2.500,00") → registrado sem foto;
 *  - OCR ilegível → NÃO registra (orienta, nunca inventa);
 *  - semana fechada → trava honesta;
 *  - foto SEM palavra de depósito → segue pro fluxo de FECHAMENTO (0-regressão);
 *  - gates puros (hasDepositIntent/parseDepositAmount) + isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-deposit-whatsapp
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dep-wpp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dep-wpp-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

// JPEG mínimo válido (magic bytes FF D8 FF) — passa no validateImageBase64.
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString("base64");

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { RetailCashDepositService, __setDepositExtractorForTests } = await import("../src/server/RetailCashDepositService.js");
  const { RetailWhatsAppIntakeService, hasDepositIntent, parseDepositAmount } = await import("../src/server/RetailWhatsAppIntakeService.js");
  const { __setClosingExtractorForTests } = await import("../src/server/RetailOpsService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkStore = (org: string, name: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, org, name);
    return { id, name };
  };
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const lojaA = mkStore(A, "Av. Brasil");
  const lojaB = mkStore(B, "Outra");
  const countDeps = (org: string, store: string) =>
    Number((db.prepare(`SELECT COUNT(*) c FROM retail_cash_deposits WHERE organization_id = ? AND store_id = ?`).get(org, store) as any)?.c || 0);

  // ── 1) Gates puros. ──
  check("1.1 'depósito' tem intenção", hasDepositIntent("segue o depósito de hoje"));
  check("1.2 'comprovante' tem intenção", hasDepositIntent("comprovante em anexo"));
  check("1.3 'malote enviado' NÃO é depósito (fluxo ADR-108)", !hasDepositIntent("malote enviado"));
  check("1.4 conversa comum não dispara", !hasDepositIntent("bom dia, tudo bem?"));
  check("1.5 parse 'depositei 1.500,00' → 1500", parseDepositAmount("depositei 1.500,00") === 1500);
  check("1.6 parse 'depósito de R$ 1179,75' → 1179.75", parseDepositAmount("depósito de R$ 1179,75") === 1179.75);
  check("1.7 frase sem número → null (não chuta)", parseDepositAmount("fiz o depósito no banco") === null);

  // ── 2) FOTO do comprovante + legenda → OCR → registrado com comprovante. ──
  __setDepositExtractorForTests(async () => JSON.stringify({ valor: 1179.75, data: "2026-09-15", confidence: 0.95 }));
  const r2a = await RetailWhatsAppIntakeService.handleInbound(A, lojaA, {
    text: "segue o comprovante do depósito", imageBase64: FAKE_JPEG, imageMime: "image/jpeg", senderId: "5521999990001",
  });
  check("2.1 respondeu confirmando o registro", /Depósito de \*R\$ 1\.179,75\* registrado/.test(r2a?.reply || ""), r2a?.reply);
  const dep = db.prepare(`SELECT * FROM retail_cash_deposits WHERE organization_id = ? AND store_id = ?`).get(A, lojaA.id) as any;
  check("2.2 depósito gravado com a DATA do comprovante (OCR)", dep?.deposit_date === "2026-09-15" && Number(dep?.amount) === 1179.75);
  check("2.3 comprovante salvo e anexado (/media/*.jpg)", /^\/media\/[a-f0-9-]+\.jpg$/.test(dep?.receipt_url || ""), dep?.receipt_url);
  check("2.4 arquivo do comprovante existe no disco", !!dep?.receipt_url && fs.existsSync(path.join(tmpDir, "media", path.basename(dep.receipt_url))));
  check("2.5 origem rastreável (via WhatsApp)", /via WhatsApp/.test(dep?.notes || ""));

  // ── 3) Reenvio do MESMO comprovante → dedupe (não dobra o depositado). ──
  const r3 = await RetailWhatsAppIntakeService.handleInbound(A, lojaA, {
    text: "comprovante do depósito", imageBase64: FAKE_JPEG, imageMime: "image/jpeg", senderId: "5521999990001",
  });
  check("3.1 avisou que já estava registrado", /já estava registrado/.test(r3?.reply || ""), r3?.reply);
  check("3.2 continua 1 depósito só", countDeps(A, lojaA.id) === 1);

  // ── 4) Valor em TEXTO (sem foto) → registrado no dia comercial. ──
  const r4 = await RetailWhatsAppIntakeService.handleInbound(A, lojaA, { text: "depositei 2.500,00", senderId: "5521999990001" });
  check("4.1 registrado pelo texto", /R\$ 2\.500,00\* registrado/.test(r4?.reply || ""), r4?.reply);
  check("4.2 agora 2 depósitos", countDeps(A, lojaA.id) === 2);

  // ── 5) OCR ilegível → NÃO registra, orienta (nunca inventa). ──
  __setDepositExtractorForTests(async () => "{}");
  const r5 = await RetailWhatsAppIntakeService.handleInbound(A, lojaA, {
    text: "depósito", imageBase64: FAKE_JPEG, imageMime: "image/jpeg", senderId: "5521999990001",
  });
  check("5.1 pediu o valor em texto", /não consegui ler o valor/.test(r5?.reply || ""), r5?.reply);
  check("5.2 nada registrado", countDeps(A, lojaA.id) === 2);

  // ── 6) Intenção sem foto nem valor → orienta o caminho. ──
  const r6 = await RetailWhatsAppIntakeService.handleInbound(A, lojaA, { text: "fiz o depósito", senderId: "5521999990001" });
  check("6.1 orientação com os dois caminhos", /foto do comprovante/.test(r6?.reply || "") && /valor em texto/.test(r6?.reply || ""));

  // ── 7) Semana FECHADA trava o lançamento (invariante preservada). ──
  RetailCashDepositService.closeWeek(A, lojaA.id, { weekStart: "2026-09-21", weekEnd: "2026-09-27" });
  __setDepositExtractorForTests(async () => JSON.stringify({ valor: 300, data: "2026-09-22", confidence: 0.9 }));
  const r7 = await RetailWhatsAppIntakeService.handleInbound(A, lojaA, {
    text: "depósito", imageBase64: FAKE_JPEG, imageMime: "image/jpeg", senderId: "5521999990001",
  });
  check("7.1 semana fechada → resposta honesta, sem lançar", /fechada/.test(r7?.reply || "") && countDeps(A, lojaA.id) === 2, r7?.reply);

  // ── 8) 0-REGRESSÃO: foto SEM palavra de depósito segue pro FECHAMENTO. ──
  __setClosingExtractorForTests(async () => JSON.stringify({ total: 4850, dinheiro: 4850, confidence: 0.9 }));
  const r8 = await RetailWhatsAppIntakeService.handleInbound(A, lojaA, { imageBase64: FAKE_JPEG, imageMime: "image/jpeg", senderId: "5521999990001" });
  check("8.1 foto sem legenda de depósito → fechamento", /Fechamento da loja/.test(r8?.reply || ""), r8?.reply);
  __setClosingExtractorForTests(null);

  // ── 9) Ledger reflete + isolamento multi-tenant. ──
  const ledger = RetailCashDepositService.monthLedger(A, lojaA.id, "2026-09");
  check("9.1 totalDeposited do mês soma os 2 lançados via WhatsApp (1179,75 + 2500)", Math.abs(ledger.totalDeposited - 3679.75) < 0.01, String(ledger.totalDeposited));
  check("9.2 org B não vê nada", countDeps(B, lojaB.id) === 0 && RetailCashDepositService.monthLedger(B, lojaB.id, "2026-09").totalDeposited === 0);

  __setDepositExtractorForTests(null);
  console.log("\n=== TEST: Comprovante de depósito pelo WhatsApp (19/09) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
