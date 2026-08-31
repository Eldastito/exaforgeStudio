/**
 * TEST — ADR-199 (obs #1): prévia de fatura do grupo (GroupBillingService). Isolado.
 *
 * Prova o modelo decidido: assinatura por operação (preço do plano de cada CNPJ) + faixa
 * de desconto por volume (1–2 cheio · 3–5 −10% · 6+ −20%) + add-on de grupo (uma vez,
 * configurável, default 0). Honestidade: operação sem plano conhecido é "unpriced" (fora
 * do subtotal, nunca inventa preço); só operações ativas contam; grupo vazio → zeros.
 *
 * Uso: npm run test:group-billing
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gbill-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-gbill-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Preços de tabela (PLAN_GRADE): start 597, growth 1797, scale 4797.
function mkOrgInGroup(db: any, GRP: any, groupId: string, name: string, planId: string | null, opts: { status?: string; billing?: string } = {}) {
  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, plan_id, billing_status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), org, name, opts.status || "active", planId, opts.billing || "active");
  GRP.addMember(groupId, org);
  return org;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { OrgGroupService: GRP } = await import("../src/server/OrgGroupService.js");
  const { GroupBillingService: BILL } = await import("../src/server/GroupBillingService.js");

  const identityId = randomUUID();
  db.prepare(`INSERT INTO account_identities (id, email, status) VALUES (?, 'dono@grupo.com', 'active')`).run(identityId);

  // --- Grupo com 2 operações (faixa 1–2 = 0% desconto): Growth + Growth ---
  const g2 = GRP.createGroup({ name: "G2", ownerIdentityId: identityId });
  mkOrgInGroup(db, GRP, g2.id, "Toulon Carioca", "growth");
  mkOrgInGroup(db, GRP, g2.id, "Toulon Av Brasil", "growth");
  const p2 = BILL.preview(g2.id);
  check("1.1 conta 2 operações", p2.operationCount === 2);
  check("1.2 faixa 1–2 → 0% desconto", p2.volumeDiscountPct === 0);
  check("1.3 subtotal = 1797+1797 (sem desconto)", p2.operationsSubtotal === 3594);
  check("1.4 add-on default 0 → total = subtotal", p2.groupAddon === 0 && p2.total === 3594);

  // --- Grupo com 3 operações (faixa 3–5 = 10%): Growth×2 + Start ---
  const g3 = GRP.createGroup({ name: "G3", ownerIdentityId: identityId });
  mkOrgInGroup(db, GRP, g3.id, "L1", "growth");
  mkOrgInGroup(db, GRP, g3.id, "L2", "growth");
  mkOrgInGroup(db, GRP, g3.id, "L3", "start");
  const p3 = BILL.preview(g3.id);
  check("2.1 conta 3 operações", p3.operationCount === 3);
  check("2.2 faixa 3–5 → 10% desconto", p3.volumeDiscountPct === 10);
  // 1797*0.9=1617.3 (×2) + 597*0.9=537.3 = 3771.9
  check("2.3 subtotal com 10% off = 3771.9", p3.operationsSubtotal === 3771.9);
  const rowStart = p3.operations.find((o) => o.planId === "start")!;
  check("2.4 netPrice por operação com desconto", rowStart.basePrice === 597 && rowStart.netPrice === 537.3);

  // --- Grupo com 6 operações (faixa 6+ = 20%) + add-on de grupo ---
  const g6 = GRP.createGroup({ name: "G6", ownerIdentityId: identityId });
  for (let i = 0; i < 6; i++) mkOrgInGroup(db, GRP, g6.id, `Loja ${i}`, "start"); // 597 cada
  const p6 = BILL.preview(g6.id, { groupAddon: 300 });
  check("3.1 conta 6 operações", p6.operationCount === 6);
  check("3.2 faixa 6+ → 20% desconto", p6.volumeDiscountPct === 20);
  // 597*0.8=477.6 × 6 = 2865.6 ; + add-on 300 = 3165.6
  check("3.3 subtotal com 20% off = 2865.6", p6.operationsSubtotal === 2865.6);
  check("3.4 add-on de grupo entra no total (uma vez)", p6.groupAddon === 300 && p6.total === 3165.6);

  // --- Honestidade: operação SEM plano conhecido é unpriced (não inventa) ---
  const gU = GRP.createGroup({ name: "GU", ownerIdentityId: identityId });
  mkOrgInGroup(db, GRP, gU.id, "Com plano", "start");
  mkOrgInGroup(db, GRP, gU.id, "Sem plano", null);
  mkOrgInGroup(db, GRP, gU.id, "Plano desconhecido", "plano_inexistente");
  const pU = BILL.preview(gU.id);
  check("4.1 conta as 3 operações ativas", pU.operationCount === 3);
  check("4.2 2 operações unpriced (sem preço inventado)", pU.unpricedOperations.length === 2);
  check("4.3 subtotal só da operação com plano (faixa 3–5=10%: 597*0.9=537.3)", pU.operationsSubtotal === 537.3);

  // --- Só operações ATIVAS contam (bloqueada / cancelada ficam de fora) ---
  const gA = GRP.createGroup({ name: "GA", ownerIdentityId: identityId });
  mkOrgInGroup(db, GRP, gA.id, "Ativa", "growth");
  mkOrgInGroup(db, GRP, gA.id, "Bloqueada", "growth", { status: "blocked" });
  mkOrgInGroup(db, GRP, gA.id, "Cancelada", "growth", { billing: "cancelled" });
  const pA = BILL.preview(gA.id);
  check("5.1 só a operação ativa conta", pA.operationCount === 1 && pA.operationsSubtotal === 1797);

  // --- Grupo vazio → zeros ---
  const gE = GRP.createGroup({ name: "GE", ownerIdentityId: identityId });
  const pE = BILL.preview(gE.id);
  check("6.1 grupo vazio → total zero", pE.operationCount === 0 && pE.total === 0 && pE.operations.length === 0);

  // --- FATURAMENTO SEPARADO (obs #1): cada CNPJ paga a própria; desconto pela escala do grupo ---
  // Cliente: Toulon (3 CNPJs Growth) + Democrata (2 CNPJs Growth) = 5 operações → faixa 3–5 = 10%.
  const gS = GRP.createGroup({ name: "GS", ownerIdentityId: identityId });
  const tCar = mkOrgInGroup(db, GRP, gS.id, "Toulon Carioca", "growth");
  const tAv = mkOrgInGroup(db, GRP, gS.id, "Toulon Av Brasil", "growth");
  const tGr = mkOrgInGroup(db, GRP, gS.id, "Toulon Grande Rio", "growth");
  const dA = mkOrgInGroup(db, GRP, gS.id, "Democrata A", "growth");
  const dB = mkOrgInGroup(db, GRP, gS.id, "Democrata B", "growth");

  // Default: cada CNPJ é seu próprio pagador (payer_ref null) → 5 faturas.
  const split = BILL.previewByPayer(gS.id, { groupAddon: 200 });
  check("7.1 desconto pela ESCALA do grupo (5 ops → 10%)", split.volumeDiscountPct === 10);
  check("7.2 default: uma fatura por CNPJ (5 pagadores)", split.payers.length === 5);
  // 1797*0.9 = 1617.3 por operação; cada fatura de 1 CNPJ = 1617.3 (+ add-on no principal)
  const withAddon = split.payers.filter((p) => p.addon > 0);
  check("7.3 add-on de grupo cobrado UMA vez só", withAddon.length === 1 && withAddon[0].addon === 200);
  check("7.4 cada CNPJ paga o plano com o desconto do grupo (1617.3)", split.payers.every((p) => p.operations.length === 1 && p.operations[0].netPrice === 1617.3));
  // RECONCILIAÇÃO: soma das faturas separadas == prévia consolidada.
  const consolidated = BILL.preview(gS.id, { groupAddon: 200 });
  check("7.5 soma das faturas separadas == consolidado", split.grandTotal === consolidated.total);
  check("7.6 grandTotal = 5×1617.3 + 200 = 8286.5", split.grandTotal === 8286.5);

  // Agrupar por MARCA: rotula os 3 CNPJs Toulon como um pagador e os 2 Democrata como outro.
  for (const o of [tCar, tAv, tGr]) GRP.setPayerRef(gS.id, o, "toulon");
  for (const o of [dA, dB]) GRP.setPayerRef(gS.id, o, "democrata");
  const byBrand = BILL.previewByPayer(gS.id, { groupAddon: 200 });
  check("8.1 agora 2 faturas (Toulon, Democrata)", byBrand.payers.length === 2);
  const toulon = byBrand.payers.find((p) => p.payerRef === "toulon")!;
  const democrata = byBrand.payers.find((p) => p.payerRef === "democrata")!;
  check("8.2 Toulon: 3 CNPJs, subtotal 3×1617.3 = 4851.9", toulon.operations.length === 3 && toulon.subtotal === 4851.9);
  check("8.3 Democrata: 2 CNPJs, subtotal 2×1617.3 = 3234.6", democrata.operations.length === 2 && democrata.subtotal === 3234.6);
  check("8.4 desconto do grupo preservado (ainda 10%, escala do cliente)", byBrand.volumeDiscountPct === 10);
  check("8.5 soma por marca == consolidado (add-on uma vez)", byBrand.grandTotal === consolidated.total);

  // Resultado.
  console.log("\n=== ADR-199 obs#1 — prévia de fatura do grupo (GroupBillingService) ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S)`); process.exit(1); }
  console.log("\n✅ TODOS OS CHECKS PASSARAM");
}

main().catch((e) => { console.error(e); process.exit(1); });
