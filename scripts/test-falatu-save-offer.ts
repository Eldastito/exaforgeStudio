/**
 * TEST — ADR-155 F5.1: save offers no cancel/refund do FalaTu.
 *
 * Cobre a captura do motivo + o mapa motivo→degrau do ladder (grimoire
 * save-offer-ladder) e, principalmente, o GUARDRAIL money-critical: a garantia
 * de 7 dias (CDC Art. 49) NUNCA é bloqueada pela oferta — todo retorno carrega a
 * elegibilidade do reembolso, elegível ou não.
 *
 *  - offerForReason: cada motivo cai no degrau certo (preço→downgrade,
 *    pouco_uso→pausa, faltou_feature→roadmap, problema_técnico→suporte,
 *    outro→none); função pura, sem tocar o banco;
 *  - captureIntent: grava a intenção, devolve a oferta + SEMPRE a eligibility;
 *  - dedupe: reabrir o fluxo faz upsert (UMA intenção pending por org);
 *  - isolamento multi-tenant: intenção de uma org não vaza pra outra;
 *  - resolve: fecha a intenção pending (retained/refunded/cancelled);
 *  - rota POST /save-offer/intent: motivo válido → 200 com eligibility;
 *    motivo inválido → 400; a garantia segue acessível mesmo fora da janela.
 *
 * Uso: npm run test:falatu-save-offer
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import express from "express";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-save-offer-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-save-offer-123456";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalatuSaveOfferService } = await import("../src/server/FalatuSaveOfferService.js");
  const falatuRoutes = (await import("../src/server/routes/falatu.js")).default;

  // Org FalaTu com aceite AGORA → dentro da garantia (eligible true por relógio real).
  function seedFalatu(orgId: string) {
    db.prepare(`
      INSERT INTO organization_settings
        (id, organization_id, business_name, vertical, status, onboarding_status, plan_id, billing_status, default_landing_view, falatu_enabled, falatu_terms_version, falatu_terms_accepted_at)
      VALUES (?, ?, ?, 'servicos', 'active', 'completed', 'falatu_solo', 'active', 'falatu', 1, '2026-08-08', CURRENT_TIMESTAMP)
    `).run(randomUUID(), orgId, "Org " + orgId);
  }
  // Org B2B (plano não-FalaTu): eligibility volta not_falatu_plan, mas a oferta ainda funciona.
  function seedB2B(orgId: string) {
    db.prepare(`
      INSERT INTO organization_settings
        (id, organization_id, business_name, vertical, status, onboarding_status, plan_id, billing_status, default_landing_view)
      VALUES (?, ?, ?, 'servicos', 'active', 'completed', 'growth', 'active', 'dashboard')
    `).run(randomUUID(), orgId, "Org " + orgId);
  }
  const pendingCount = (orgId: string) => (db.prepare(`SELECT COUNT(*) c FROM falatu_cancellation_intents WHERE organization_id = ? AND outcome = 'pending'`).get(orgId) as any).c;
  const rowOf = (orgId: string) => db.prepare(`SELECT * FROM falatu_cancellation_intents WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1`).get(orgId) as any;

  // ===== 1. Mapa motivo → degrau do ladder (puro) =====
  check("preço → downgrade", FalatuSaveOfferService.offerForReason("preco").type === "downgrade");
  check("pouco_uso → pause", FalatuSaveOfferService.offerForReason("pouco_uso").type === "pause");
  check("faltou_feature → roadmap", FalatuSaveOfferService.offerForReason("faltou_feature").type === "roadmap");
  check("problema_tecnico → support", FalatuSaveOfferService.offerForReason("problema_tecnico").type === "support");
  check("outro → none (saída limpa)", FalatuSaveOfferService.offerForReason("outro").type === "none");
  check("downgrade tem CTA acionável", !!FalatuSaveOfferService.offerForReason("preco").cta);
  check("none não empurra CTA", FalatuSaveOfferService.offerForReason("outro").cta === null);

  // ===== 2. isReason guarda a forma =====
  check("isReason aceita motivo válido", FalatuSaveOfferService.isReason("pouco_uso") === true);
  check("isReason rejeita lixo", FalatuSaveOfferService.isReason("qualquer") === false);

  // ===== 3. captureIntent grava + SEMPRE devolve eligibility (guardrail) =====
  seedFalatu("org_a");
  const i1 = FalatuSaveOfferService.captureIntent("org_a", "user_a", { reason: "preco", freeText: "tá caro" });
  check("captura devolve a oferta mapeada", i1.offer.type === "downgrade");
  check("captura SEMPRE traz eligibility", !!i1.eligibility && typeof i1.eligibility.eligible === "boolean");
  check("org na janela → elegível ao reembolso", i1.eligibility.eligible === true);
  check("refundNote reforça o direito à garantia", /garantia/i.test(i1.refundNote));
  check("gravou 1 intenção pending", pendingCount("org_a") === 1);
  check("persistiu motivo + free_text + oferta", (() => { const r = rowOf("org_a"); return r.reason === "preco" && r.free_text === "tá caro" && r.offered_type === "downgrade"; })());

  // ===== 4. Guardrail com org SEM garantia: oferta ainda funciona, nunca trava =====
  seedB2B("org_b2b");
  const iB = FalatuSaveOfferService.captureIntent("org_b2b", "user_b", { reason: "pouco_uso" });
  check("org sem garantia ainda recebe oferta", iB.offer.type === "pause");
  check("eligibility presente mesmo não-elegível", iB.eligibility.eligible === false && iB.eligibility.reason === "not_falatu_plan");
  check("refundNote não bloqueia a saída", /cancelar/i.test(iB.refundNote));

  // ===== 5. Dedupe: reabrir o fluxo faz upsert (uma pending por org) =====
  const i2 = FalatuSaveOfferService.captureIntent("org_a", "user_a", { reason: "problema_tecnico", freeText: "deu erro" });
  check("reabrir mantém a MESMA intenção", i2.intentId === i1.intentId);
  check("upsert atualiza motivo/oferta", i2.offer.type === "support" && rowOf("org_a").reason === "problema_tecnico");
  check("continua só 1 pending após reabrir", pendingCount("org_a") === 1);

  // ===== 6. Isolamento multi-tenant =====
  check("intenção da org_a não vaza pra org_b2b", rowOf("org_b2b").reason === "pouco_uso" && pendingCount("org_b2b") === 1);
  seedFalatu("org_c");
  check("org_c começa sem intenção", pendingCount("org_c") === 0);

  // ===== 7. resolve fecha a pending =====
  const res = FalatuSaveOfferService.resolve("org_a", "retained");
  check("resolve marca a pending", res.ok === true && pendingCount("org_a") === 0);
  check("resolve idempotente (nada pending → ok=false)", FalatuSaveOfferService.resolve("org_a", "retained").ok === false);
  check("resolve de uma org não toca outra", pendingCount("org_b2b") === 1);

  // ===== 8. Rota POST /save-offer/intent =====
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { userId: "user_r", email: "r@teste.com" }; req.organizationId = "org_route"; next(); });
  app.use("/api/falatu", falatuRoutes);
  seedFalatu("org_route");
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = (method: string, p: string, body?: any): Promise<any> => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = http.request({ port, path: p, method, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (r) => {
      const chunks: Buffer[] = []; r.on("data", (c) => chunks.push(c));
      r.on("end", () => { try { resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") }); } catch (err) { reject(err); } });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });

  const ok = await call("POST", "/api/falatu/save-offer/intent", { reason: "preco", freeText: "caro" });
  check("POST motivo válido → 200 com oferta", ok.status === 200 && ok.json.offer.type === "downgrade");
  check("POST 200 traz eligibility (garantia acessível)", !!ok.json.eligibility && typeof ok.json.eligibility.eligible === "boolean");
  const bad = await call("POST", "/api/falatu/save-offer/intent", { reason: "sei_la" });
  check("POST motivo inválido → 400", bad.status === 400);
  await new Promise<void>((r) => server.close(() => r()));

  console.log("");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"} — ${x.name}`);
  console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(1);
});
