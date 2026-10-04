/**
 * TESTE — Comissão da loja: o gerente PROPÕE, o dono APROVA, os dois são avisados (RetailCommissionGovernanceService)
 * ----------------------------------------------------------------------------
 * Decisão do dono (TOULON, 04/10): o gerente vê e edita as regras de comissão da PRÓPRIA loja, mas só o Bruno confirma.
 * Prova, pelas rotas reais (retailops), com gerente preso à Carioca, dono e co-admin:
 *   - gerente LÊ o plano e as propostas SÓ da loja dele; não abre a de outra loja;
 *   - gerente propõe pra loja dele (loja forçada quando só tem uma), sempre `manual`, e NÃO consegue propor pra outra loja,
 *     nem pra rede inteira, nem importar por IA, nem confirmar, nem arquivar política viva, nem salvar plano direto;
 *   - proposta pendente NUNCA paga: o plano vigente só muda quando o dono confirma;
 *   - o gerente só envia/retira proposta que ele mesmo criou, da loja dele;
 *   - avisos pela espinha (business_signals): ao enviar → "aguardando aprovação" visível ao dono e ao gerente da loja
 *     (não ao gerente de outra loja), com o que/onde/o que fazer; ao confirmar/recusar → pendente resolvido + aviso
 *     de decisão pra loja (com motivo); dono que propõe e confirma a si mesmo → sem aviso redundante.
 *
 * Uso:  npm run test:retail-commission-governance
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-gov-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-gov-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");
  const { StoreSignalScopeService: SC } = await import("../src/server/StoreSignalScopeService.js");
  const { RetailCommissionRaceService: Race, DEFAULT_RACE_PLAN } = await import("../src/server/RetailCommissionRaceService.js");
  const routes = (await import("../src/server/routes/retailops.js")).default;

  const ORG = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), ORG);
  P.seedSystemProfiles(ORG);
  const gerenteProfile = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(ORG) as any).id;
  const mkUser = (name: string, role: string, profile: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status, role_profile_id) VALUES (?, ?, ?, ?, ?, 'active', ?)`).run(id, ORG, name, `${name}@t.com`, role, profile);
    return id;
  };
  const gabriel = mkUser("Gabriel", "admin", gerenteProfile), bruno = mkUser("Bruno", "owner", null), coAdmin = mkUser("Co", "admin", gerenteProfile);
  const carioca = randomUUID(), grande = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Carioca', 'CAR', 1)`).run(carioca, ORG);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Grande Rio', 'GRD', 1)`).run(grande, ORG);
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)`).run(ORG, gabriel, carioca);

  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, role, role_profile_id FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = ORG; req.user = { userId: row.id, role: row.role, role_profile_id: row.role_profile_id, organizationId: ORG }; }
    next();
  });
  app.use("/api/retailops", routes);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const call = async (uid: string, method: string, url: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/retailops${url}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, text };
  };
  const planA = (name: string, pct: number) => ({ ...JSON.parse(JSON.stringify(DEFAULT_RACE_PLAN)), name });
  const MONTH = "2026-10";

  // plano vigente aprovado pelo dono (Carioca) — a base que o gerente enxerga
  Race.savePlan(ORG, carioca, planA("Vigente Carioca", 3), bruno, MONTH);

  // ── leitura da própria loja ──
  let r = await call(gabriel, "GET", `/commission/plan?storeId=${carioca}&month=${MONTH}`);
  check("gerente LÊ o plano da própria loja", r.status === 200 && /Vigente Carioca/.test(r.text), r.text.slice(0, 100));
  r = await call(gabriel, "GET", `/commission/plan?month=${MONTH}`);
  check("…sem informar a loja, a dele é forçada (só tem uma)", r.status === 200 && /Vigente Carioca/.test(r.text));
  r = await call(gabriel, "GET", `/commission/plan?storeId=${grande}&month=${MONTH}`);
  check("…e NÃO lê o plano de outra loja (403)", r.status === 403);

  // ── propor ──
  const bodyFor = (store: string | null, name: string, extra: any = {}) => ({ storeId: store, month: MONTH, config: planA(name, 4), note: "subir a meta", ...extra });
  r = await call(gabriel, "POST", "/commission/policies/proposals", bodyFor(null, "Proposta Gabriel", { submit: true, source: "ai_import" }));
  check("gerente propõe SEM informar a loja → vira a loja dele (forçada) e a origem é sempre manual", r.status === 201 && r.json.storeId === carioca && r.json.source === "manual" && r.json.status === "pending_confirmation", r.text.slice(0, 160));
  const pid = r.json.id;
  r = await call(gabriel, "POST", "/commission/policies/proposals", bodyFor(grande, "Invasora"));
  check("gerente NÃO propõe pra outra loja (403)", r.status === 403);
  check("proposta pendente NÃO paga: o plano vigente continua o aprovado", /Vigente Carioca/.test((await call(bruno, "GET", `/commission/plan?storeId=${carioca}&month=${MONTH}`)).text));

  // ── avisos ao dono / à loja ──
  const sigs = (type: string) => db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = ? ORDER BY created_at").all(ORG, type) as any[];
  const pend = sigs("retail_commission_proposal_pending");
  check("enviar a proposta publica 'aguardando aprovação' na espinha, amarrado à loja", pend.length === 1 && pend[0].source_entity_type === "retail_store" && pend[0].source_entity_id === carioca && pend[0].status === "open");
  const ev = JSON.parse(pend[0]?.evidence_json || "{}");
  check("o aviso diz O QUE (quem/loja/mês), ONDE (tela) e o que FAZER", /Gabriel/.test(ev.what) && /Carioca/.test(ev.what) && /Comissão/.test(ev.where) && /confirme ou recuse/i.test(ev.todo), JSON.stringify(ev).slice(0, 200));
  const gabrielSees = SC.hiddenFor(ORG, { userId: gabriel, role: "admin" });
  check("o gerente da loja enxerga o aviso; o de OUTRA loja não", !gabrielSees!.has(pend[0].id) && (() => { const g2 = mkUser("G2", "admin", gerenteProfile); db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)`).run(ORG, g2, grande); return SC.hiddenFor(ORG, { userId: g2, role: "admin" })!.has(pend[0].id); })());
  check("o dono enxerga o aviso (irrestrito)", SC.hiddenFor(ORG, { userId: bruno, role: "owner" }) === null);

  // ── leitura das propostas: só da loja ──
  const other = await call(bruno, "POST", "/commission/policies/proposals", bodyFor(grande, "Proposta Grande Rio", { submit: true }));
  const rosterG = await call(gabriel, "GET", "/commission/policies");
  check("gerente vê as propostas da loja dele e NÃO as da Grande Rio nem da rede", rosterG.status === 200 && rosterG.json.proposals.every((p: any) => p.storeId === carioca) && rosterG.json.proposals.length === 1);
  check("o dono vê todas", (await call(bruno, "GET", "/commission/policies")).json.proposals.length === 2);

  // ── o que o gerente NÃO faz ──
  for (const [label, rr] of [
    ["confirmar", await call(gabriel, "POST", `/commission/policies/proposals/${pid}/confirm`)],
    ["importar por IA", await call(gabriel, "POST", "/commission/policies/import", { text: "x", storeId: carioca })],
    ["arquivar política viva", await call(gabriel, "POST", "/commission/policies/archive-live", { storeId: carioca, month: MONTH })],
    ["salvar plano direto", await call(gabriel, "PUT", "/commission/plan", { storeId: carioca, month: MONTH, config: planA("Direto", 9) })],
  ] as const) check(`gerente NÃO consegue ${label} (403)`, (rr as any).status === 403, `${(rr as any).status}`);
  r = await call(gabriel, "POST", `/commission/policies/proposals/${other.json.id}/archive`, { reason: "x" });
  check("gerente NÃO mexe na proposta de outra loja (403)", r.status === 403);
  const byBruno = await call(bruno, "POST", "/commission/policies/proposals", bodyFor(carioca, "Do Bruno", {}));
  r = await call(gabriel, "POST", `/commission/policies/proposals/${byBruno.json.id}/submit`);
  check("gerente NÃO mexe em proposta da própria loja criada por OUTRA pessoa (403)", r.status === 403);
  const draft = await call(gabriel, "POST", "/commission/policies/proposals", bodyFor(carioca, "Rascunho G"));
  r = await call(gabriel, "POST", `/commission/policies/proposals/${draft.json.id}/submit`);
  check("gerente envia o próprio rascunho (200) e gera o aviso", r.status === 200 && r.json.status === "pending_confirmation" && sigs("retail_commission_proposal_pending").some((s) => s.dedupe_key.endsWith(draft.json.id) && s.status === "open"));
  r = await call(gabriel, "POST", `/commission/policies/proposals/${draft.json.id}/archive`, { reason: "desisti" });
  check("gerente retira a própria proposta (200): o aviso pendente é resolvido, sem aviso de decisão redundante", r.status === 200 && sigs("retail_commission_proposal_pending").find((s) => s.dedupe_key.endsWith(draft.json.id))!.status === "resolved" && sigs("retail_commission_proposal_rejected").length === 0);

  // ── decisão do dono ──
  r = await call(bruno, "POST", `/commission/policies/proposals/${pid}/confirm`);
  check("o DONO confirma → vira o plano vigente", r.status === 200 && /Proposta Gabriel/.test((await call(bruno, "GET", `/commission/plan?storeId=${carioca}&month=${MONTH}`)).text));
  const decided = sigs("retail_commission_proposal_confirmed");
  check("confirmar resolve o pendente e avisa a loja da decisão (quem decidiu, já vale)", sigs("retail_commission_proposal_pending").find((s) => s.dedupe_key.endsWith(pid))!.status === "resolved" && decided.length === 1 && /Bruno/.test(JSON.parse(decided[0].evidence_json).what) && /já vale/i.test(JSON.parse(decided[0].evidence_json).what));
  const g3 = await call(gabriel, "POST", "/commission/policies/proposals", bodyFor(carioca, "Outra G", { submit: true }));
  await call(bruno, "POST", `/commission/policies/proposals/${g3.json.id}/archive`, { reason: "meta alta demais" });
  const rej = sigs("retail_commission_proposal_rejected");
  check("recusar avisa a loja com o MOTIVO e o que fazer", rej.length === 1 && /meta alta demais/.test(JSON.parse(rej[0].evidence_json).what) && /nova proposta/i.test(JSON.parse(rej[0].evidence_json).todo));
  const own = await call(bruno, "POST", "/commission/policies/proposals", bodyFor(carioca, "Dono propõe", { submit: true }));
  await call(bruno, "POST", `/commission/policies/proposals/${own.json.id}/confirm`);
  check("dono que propõe e confirma a si mesmo → sem aviso de decisão redundante", sigs("retail_commission_proposal_confirmed").length === 1);

  // ── co-admin (irrestrito) segue como dono ──
  r = await call(coAdmin, "GET", "/commission/policies");
  check("admin SEM loja atribuída segue vendo tudo (0-regressão)", r.status === 200 && r.json.proposals.length >= 3);

  console.log("\n=== Comissão da loja: gerente propõe, dono aprova ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-commission-governance: ${results.length - failures}/${results.length} checks`);
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
