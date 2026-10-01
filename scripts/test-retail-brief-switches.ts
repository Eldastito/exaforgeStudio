/**
 * TESTE — chaves dos resumos por loja (parcial 16h + fechamento da noite) na Central de Saúde.
 * Achado: as chaves só existiam na API (sem tela) e os resumos iam para QUALQUER admin com telefone — inclusive o gerente de loja
 * (admin COM loja), que receberia no WhatsApp a venda/cota/dinheiro da REDE inteira, furando a trava por loja. Prova, por HTTP e pelos
 * serviços: só owner/admin SEM loja recebem; `GET /brief-settings` informa chaves + horários + quantos recebem (0 = ligar não envia nada);
 * o dono liga as chaves e ajusta o horário de cada loja (ex.: Av. Brasil 19:30) e o gerente não alcança nada disso (403).
 * Uso:  npm run test:retail-brief-switches
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-brief-switches-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-brief-switches-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const express = (await import("express")).default;
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");
  const { RetailStoreService: Stores } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreScopeService: Scope } = await import("../src/server/RetailStoreScopeService.js");
  const { RetailDayBriefService: Night } = await import("../src/server/RetailDayBriefService.js");
  const { RetailAfternoonBriefService: Aft } = await import("../src/server/RetailAfternoonBriefService.js");

  const app = express();
  app.use(express.json());
  app.use("/api/retailops", (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || null;
    req.user = { userId: req.headers["x-test-user"] || "u1", role: req.headers["x-test-role"] || "owner", organizationId: req.organizationId };
    next();
  }, retailRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/retailops`;
  const who: Record<string, [string, string]> = { owner: ["owner", "u_owner"], co: ["admin", "u_co"], ger: ["admin", "u_ger"], agent: ["agent", "u_agent"] };
  const call = async (method: string, p: string, org: string, w: keyof typeof who, body?: any) => {
    const [role, user] = who[w];
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-org": org, "x-test-role": role, "x-test-user": user }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, body: j };
  };

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`, E = `org_E_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B, E]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, retail_official_sale_source) VALUES (?, ?, 'X', 'active', 'folha')`).run(randomUUID(), o);
  const mk = (org: string, name: string) => Stores.create(org, { name, code: name.slice(0, 4) + randomUUID().slice(0, 3) } as any).id;
  const carioca = mk(A, "Carioca"), avb = mk(A, "Avenida Brasil"); mk(B, "LojaB");
  const user = (org: string, id: string, role: string, phone: string | null, status = "active") => db.prepare(`INSERT INTO users (id, organization_id, name, email, role, phone, global_status) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, org, id, `${id}@x.com`, role, phone, status);
  user(A, "u_owner", "owner", "5521900000001"); user(A, "u_co", "admin", "5521900000002"); user(A, "u_ger", "admin", "5521900000003"); user(A, "u_agent", "agent", "5521900000004");
  user(A, "u_nophone", "admin", null); user(A, "u_off", "admin", "5521900000005", "suspended");
  Scope.setForUser(A, "u_ger", [carioca], "u_owner");

  // ── (1) destinatários: só a rede (owner + admin sem loja, com telefone, ativo) ──
  const phones = (l: any[]) => l.map((r) => r.phone).sort();
  const expected = ["5521900000001", "5521900000002"];
  check("noite: recebem só owner e admin SEM loja (gerente, agent, sem telefone e suspenso ficam de fora)", JSON.stringify(phones(Night.recipients(A))) === JSON.stringify(expected), JSON.stringify(phones(Night.recipients(A))));
  check("tarde: mesma regra", JSON.stringify(phones(Aft.recipients(A))) === JSON.stringify(expected), JSON.stringify(phones(Aft.recipients(A))));

  // envio de verdade (força): o telefone do gerente nunca recebe o texto da rede
  const D = "2026-09-24";
  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, ?, 1000)`).run(randomUUID(), A, carioca, D);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'received', 900)`).run(randomUUID(), A, carioca, D);
  const sent: Array<{ phone: string; text: string }> = [];
  const send = (phone: string, text: string) => { sent.push({ phone, text }); };
  const at = (h: number) => new Date(Date.UTC(2026, 8, 24, h + 3, 0, 0)); // h BRT (UTC−3)
  Night.setEnabled(A, true); Aft.setEnabled(A, true);
  await Night.runPass(A, { now: at(22), send, force: true });
  await Aft.runPass(A, { now: at(16), send, force: true });
  check("envio real: houve mensagem da noite e da tarde, só para owner e co-admin", sent.length >= 2 && sent.every((m) => expected.includes(m.phone)) && sent.some((m) => /Fechamento do dia/.test(m.text)), JSON.stringify(sent.map((m) => m.phone)));
  check("envio real: o gerente (5521900000003) não recebeu nada", !sent.some((m) => m.phone === "5521900000003"));
  Night.setEnabled(A, false); Aft.setEnabled(A, false);

  // ── (2) GET /brief-settings ──
  const g0 = await call("GET", "/brief-settings", A, "owner");
  check("owner: vê as 2 chaves desligadas, o padrão 22:30, as 2 lojas e 2 destinatários", g0.status === 200 && g0.body.afternoonEnabled === false && g0.body.nightEnabled === false && g0.body.defaultNightTime === "22:30" && g0.body.stores.length === 2 && g0.body.recipients === 2, JSON.stringify(g0.body));
  check("co-admin (sem loja) também vê", (await call("GET", "/brief-settings", A, "co")).status === 200);
  check("gerente de loja: 403 (a tela some e o servidor barra)", (await call("GET", "/brief-settings", A, "ger")).status === 403);
  check("agent: 403", (await call("GET", "/brief-settings", A, "agent")).status === 403);
  const gE = await call("GET", "/brief-settings", E, "owner");
  check("org sem lojas: lista vazia (a tela não aparece)", gE.status === 200 && gE.body.stores.length === 0);
  const gB = await call("GET", "/brief-settings", B, "owner");
  check("isolamento: a org B não vê as lojas nem os destinatários da A", gB.body.stores.length === 1 && gB.body.stores[0].name === "LojaB" && gB.body.recipients === 0, JSON.stringify(gB.body));

  // ── (3) o dono liga as chaves e o gerente não consegue ──
  check("gerente não liga a parcial das 16h nem o fechamento da noite (403)", (await call("PUT", "/afternoon-brief/enabled", A, "ger", { enabled: true })).status === 403 && (await call("PUT", "/night-brief/enabled", A, "ger", { enabled: true })).status === 403);
  const on1 = await call("PUT", "/afternoon-brief/enabled", A, "owner", { enabled: true });
  const on2 = await call("PUT", "/night-brief/enabled", A, "owner", { enabled: true });
  const g1 = await call("GET", "/brief-settings", A, "owner");
  check("dono liga as duas e o GET reflete", on1.body?.enabled === true && on2.body?.enabled === true && g1.body.afternoonEnabled === true && g1.body.nightEnabled === true);
  await call("PUT", "/afternoon-brief/enabled", A, "owner", { enabled: false });
  check("e desliga de volta (reversível)", (await call("GET", "/brief-settings", A, "owner")).body.afternoonEnabled === false);

  // ── (4) horário por loja: Av. Brasil 19:30 ──
  const p1 = await call("PATCH", `/stores/${avb}`, A, "owner", { closingBriefTime: "19:30" });
  const g2 = await call("GET", "/brief-settings", A, "owner");
  check("dono cadastra 19:30 na Avenida Brasil; as outras seguem sem horário (padrão)", p1.status === 200 && g2.body.stores.find((s: any) => s.id === avb).closingBriefTime === "19:30" && g2.body.stores.find((s: any) => s.id === carioca).closingBriefTime === null, JSON.stringify(g2.body.stores));
  const slots = Night.slots(A, D);
  check("o resumo da noite passa a ter 2 horários: 19:30 (Av. Brasil) e 22:30 (resto + rede)", slots.length === 2 && slots[0].time === "19:30" && slots[0].storeIds.includes(avb) && slots[1].time === "22:30" && slots[1].last === true, JSON.stringify(slots));
  check("horário inválido é recusado (400) e o 19:30 continua", (await call("PATCH", `/stores/${avb}`, A, "owner", { closingBriefTime: "25:99" })).status === 400 && (await call("GET", "/brief-settings", A, "owner")).body.stores.find((s: any) => s.id === avb).closingBriefTime === "19:30");
  check("gerente não altera o horário de loja nenhuma (403)", (await call("PATCH", `/stores/${carioca}`, A, "ger", { closingBriefTime: "20:00" })).status === 403);
  await call("PATCH", `/stores/${avb}`, A, "owner", { closingBriefTime: "" });
  check("limpar o campo volta ao padrão 22:30", (await call("GET", "/brief-settings", A, "owner")).body.stores.find((s: any) => s.id === avb).closingBriefTime === null);

  // ── (5) sem ninguém para receber: o painel avisa (0) ──
  db.prepare(`UPDATE users SET phone = NULL WHERE organization_id = ?`).run(A);
  check("ninguém com telefone: recipients = 0 (a tela avisa que ligar não envia nada)", (await call("GET", "/brief-settings", A, "owner")).body.recipients === 0);

  server.close();
  const pass = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${!r.ok && r.detail ? `\n      ↳ ${r.detail}` : ""}`);
  console.log(failures ? `\n${failures} FALHA(S) (${pass}/${results.length} ok)` : `\n${pass}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
