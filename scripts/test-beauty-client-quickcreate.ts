/**
 * TEST — BEAUTY-023 (ADR-169 F22): cadastro de cliente walk-in.
 *
 * Prova que a recepção consegue cadastrar uma cliente que CHEGOU no balcão
 * (sem mensagem prévia) e que essa cliente aparece no seletor da Beauty AI e
 * consegue iniciar uma consulta — fechando o bloqueio "sem contato, sem
 * simulação".
 *
 * Checks:
 *  1. GET /clients vazio no começo (sem contato).
 *  2. POST /clients cria contato (name+phone) → aparece no GET.
 *  3. POST idempotente por telefone (mesmo phone → mesmo id, não duplica).
 *  4. POST sem name → 400.
 *  5. GET/POST sem vertical=beleza → 404 (não vaza).
 *  6. Isolamento multi-tenant (cliente de orgA não aparece em orgB).
 *  7. Integração real: contato criado consegue receber consent + iniciar
 *     consulta (BeautyVisualConsultationService).
 *  8. audit BEAUTY_CLIENT_CREATED gravado.
 *
 * Uso: npm run test:beauty-client-quickcreate
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-beauty-client-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-beauty-client-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const express = (await import("express")).default;
  const { default: beautyRoutes } = await import("../src/server/routes/beauty.js");
  const { BeautyVisualConsultationService } = await import("../src/server/BeautyVisualConsultationService.js");
  const { BeautyClientService } = await import("../src/server/BeautyClientService.js");

  const app = express();
  app.use(express.json());
  const authStub = (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || null;
    req.user = { userId: req.headers["x-test-user"] || "u1", role: "owner", organizationId: req.headers["x-test-org"] || null };
    next();
  };
  app.use("/api/beauty", authStub, beautyRoutes);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const seedOrg = (vertical: string) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'X', 'active', ?)`)
      .run(randomUUID(), orgId, vertical);
    return orgId;
  };
  const call = async (method: string, url: string, opts: { orgId?: string | null; body?: any } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.orgId !== null && opts.orgId !== undefined) headers["x-test-org"] = opts.orgId;
    const r = await fetch(`${base}${url}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await r.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* */ }
    return { status: r.status, json, text };
  };

  try {
    const orgA = seedOrg("beleza");
    const orgVarejo = seedOrg("varejo");

    // ===== 1. GET vazio =====
    let r = await call("GET", "/api/beauty/clients", { orgId: orgA });
    check("GET /clients vazio no começo", r.status === 200 && Array.isArray(r.json?.clients) && r.json.clients.length === 0, r.text);

    // ===== 2. POST cria =====
    r = await call("POST", "/api/beauty/clients", { orgId: orgA, body: { name: "Emily Souza", phone: "11999998888" } });
    check("POST /clients cria → 200 + id", r.status === 200 && !!r.json?.client?.id, r.text);
    const emilyId = r.json?.client?.id;
    check("client devolve name + identifier(telefone)", r.json?.client?.name === "Emily Souza" && r.json?.client?.identifier === "11999998888");

    r = await call("GET", "/api/beauty/clients", { orgId: orgA });
    check("GET /clients agora lista a Emily", r.json?.clients?.length === 1 && r.json.clients[0].id === emilyId);

    // ===== 3. Idempotência por telefone =====
    r = await call("POST", "/api/beauty/clients", { orgId: orgA, body: { name: "Emily S.", phone: "11999998888" } });
    check("POST mesmo telefone → mesmo id (dedupe, não duplica)", r.json?.client?.id === emilyId, r.text);
    r = await call("GET", "/api/beauty/clients", { orgId: orgA });
    check("segue com 1 cliente (não duplicou)", r.json?.clients?.length === 1);

    // ===== 4. name obrigatório =====
    r = await call("POST", "/api/beauty/clients", { orgId: orgA, body: { phone: "1188887777" } });
    check("POST sem name → 400", r.status === 400, r.text);

    // ===== 5. Gate vertical =====
    r = await call("GET", "/api/beauty/clients", { orgId: orgVarejo });
    check("GET sem vertical=beleza → 404", r.status === 404);
    r = await call("POST", "/api/beauty/clients", { orgId: orgVarejo, body: { name: "X" } });
    check("POST sem vertical=beleza → 404", r.status === 404);

    // ===== 6. Isolamento multi-tenant =====
    const orgB = seedOrg("beleza");
    r = await call("POST", "/api/beauty/clients", { orgId: orgB, body: { name: "Fernanda", phone: "2199990000" } });
    check("orgB cria a Fernanda", r.status === 200);
    r = await call("GET", "/api/beauty/clients", { orgId: orgA });
    check("orgA NÃO vê a Fernanda (isolamento)", r.json?.clients?.every((c: any) => c.name !== "Fernanda"));
    r = await call("GET", "/api/beauty/clients", { orgId: orgB });
    check("orgB NÃO vê a Emily (isolamento)", r.json?.clients?.every((c: any) => c.name !== "Emily Souza") && r.json?.clients?.length === 1);

    // ===== 7. Integração: contato criado consegue iniciar consulta =====
    // grantConsent (hair_simulation) + startConsultation com o contato novo.
    BeautyVisualConsultationService.grantConsent(orgA, emilyId, "hair_simulation");
    const cons = BeautyVisualConsultationService.startConsultation(orgA, { contactId: emilyId, goal: "coloração" });
    check("contato criado consegue iniciar consulta (draft)", !!cons?.id && cons.status === "draft", JSON.stringify(cons));

    // ===== 8. Audit =====
    await new Promise((r) => setTimeout(r, 50));
    const audit = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE event_type='BEAUTY_CLIENT_CREATED' AND organization_id=? LIMIT 1`).get(orgA) as any;
    check("audit BEAUTY_CLIENT_CREATED gravado", !!audit);

    // ===== 9. Service unit: list ordena e não vaza cross-org =====
    const listA = BeautyClientService.list(orgA).map(c => c.name);
    check("BeautyClientService.list só traz contatos da orgA", listA.includes("Emily S.") && !listA.includes("Fernanda"));

    // ===== 10. Ficha capilar (F25) =====
    r = await call("POST", "/api/beauty/clients", {
      orgId: orgA,
      body: { name: "Paula", phone: "11888887777", email: "paula@email.com",
              profile: { hairType: "cacheado", chemicalHistory: "progressiva", leadSource: "instagram" } },
    });
    check("POST com email + ficha capilar → 200", r.status === 200, r.text);
    const paulaId = r.json?.client?.id;
    r = await call("GET", `/api/beauty/clients/${paulaId}/profile`, { orgId: orgA });
    check("GET profile devolve a ficha", r.json?.profile?.hairType === "cacheado" && r.json?.profile?.chemicalHistory === "progressiva" && r.json?.profile?.leadSource === "instagram", r.text);
    // vocab fechado: valor fora do vocab vira null (nunca grava lixo)
    r = await call("PUT", `/api/beauty/clients/${paulaId}/profile`, { orgId: orgA, body: { hairThickness: "grosso", hairType: "verde_neon" } });
    check("PUT profile: valor fora do vocab é descartado; válido gravado",
      r.json?.profile?.hairThickness === "grosso" && r.json?.profile?.hairType === "cacheado", r.text);
    // isolamento: orgB não lê a ficha da Paula
    r = await call("GET", `/api/beauty/clients/${paulaId}/profile`, { orgId: orgB });
    check("orgB não lê a ficha da Paula (isolamento)", r.json?.profile === null);
    // vocabulário da ficha exposto
    r = await call("GET", "/api/beauty/clients/profile-vocabulary", { orgId: orgA });
    check("GET profile-vocabulary devolve vocabs fechados", Array.isArray(r.json?.hairTypes) && r.json.hairTypes.includes("cacheado"));
  } finally {
    server.close();
  }

  console.log("\n=== TEST — BEAUTY-023 (ADR-169 F22): cadastro cliente walk-in ===");
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.note ? ` — ${r.note}` : ""}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  if (failures > 0) { console.error(`\n${failures} FAIL`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
