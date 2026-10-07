/**
 * TESTE — ADR-204 D4d: interruptor do bloqueio de envio sem consentimento (`outbound_consent_required`).
 * Prova: prévia de impacto espelha o gate (contatos sem `comunicacoes` + clientes do PDV sem autorização) · ligar EXIGE acknowledge no servidor ·
 * só dono/admin · auditado com os números · ligado de verdade bloqueia (PDV e contato) · desligar volta a liberar · isolamento · UI.
 * Uso: npm run test:outbound-consent-switch
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ocs-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ocs-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OutboundConsentGuardService: G } = await import("../src/server/OutboundConsentGuardService.js");
  const { PdvConsentService: P } = await import("../src/server/PdvConsentService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const O = mkOrg(), Q = mkOrg();
  const chan = (org: string) => { const id = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name) VALUES (?, ?, 'whatsapp', 'c')`).run(id, org); return id; };
  const cO = chan(O), cQ = chan(Q);
  const contact = (org: string, ch: string, ident: string) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier, name) VALUES (?,?,?,?,?)`).run(id, org, ch, ident, `N${ident}`); return id; };
  const consent = (org: string, cid: string) => db.prepare(`INSERT INTO contact_consents (id, organization_id, contact_id, consent_type, legal_basis, policy_version, granted, granted_at) VALUES (?,?,?,?,?,?,1,CURRENT_TIMESTAMP)`).run(randomUUID(), org, cid, "comunicacoes", "consent", "1.0");
  const c1 = contact(O, cO, "5521911110001"); contact(O, cO, "5521911110002"); contact(O, cO, "5521911110003"); consent(O, c1);
  contact(Q, cQ, "5521922220001");
  const pdv = (org: string, code: string, cel: string | null) => db.prepare("INSERT INTO retail_pdv_customers (id, organization_id, codigo_n, nome, celular, filial, inativo) VALUES (?,?,?,?,?,?,0)").run(randomUUID(), org, code, `P${code}`, cel, "01");
  pdv(O, "1", "(21) 98888-0001"); pdv(O, "2", "(21) 98888-0002"); pdv(O, "3", null);
  P.record(O, "1", { granted: true, source: "balcao" }, "u");

  // 1) prévia
  const im = G.impact(O);
  check("prévia: contatos 3 total / 1 com consentimento / 2 sem", im.contacts.total === 3 && im.contacts.withConsent === 1 && im.contacts.withoutConsent === 2);
  check("prévia: PDV 2 com celular / 1 autorizado / 1 bloqueado (sem celular não conta)", im.pdv.withPhone === 2 && im.pdv.authorized === 1 && im.pdv.blocked === 1);
  check("prévia: desligada por padrão e isolada por empresa", im.enabled === false && G.impact(Q).contacts.total === 1 && G.impact(Q).pdv.withPhone === 0);
  check("a prévia não liga nada (read-only)", G.isEnabled(O) === false);

  // 2) rotas
  const { default: router } = await import("../src/server/routes/retailops.js");
  const express = (await import("express")).default;
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const who: any = { dono: mkU(O, "owner", "owner"), vend: mkU(O, "agent", "vendedor") };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = O; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/retailops", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const call = async (m: string, u: string, user: string, body?: any) => { const r = await fetch(`http://127.0.0.1:${port}/api/retailops${u}`, { method: m, headers: { "Content-Type": "application/json", "x-user": user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };

  const g0 = await call("GET", "/pdv-consent/guard", "dono");
  check("GET guard (dono): 200 com a prévia", g0.status === 200 && g0.body.enabled === false && g0.body.contacts.withoutConsent === 2);
  check("vendedor não vê nem liga (403)", (await call("GET", "/pdv-consent/guard", "vend")).status === 403 && (await call("PUT", "/pdv-consent/guard", "vend", { enabled: true, acknowledge: true })).status === 403 && !G.isEnabled(O));
  check("PUT sem booleano → 400", (await call("PUT", "/pdv-consent/guard", "dono", { enabled: "sim" })).status === 400);
  const noAck = await call("PUT", "/pdv-consent/guard", "dono", { enabled: true });
  check("ligar SEM acknowledge → 400 e NÃO liga (regra no servidor, não só na tela)", noAck.status === 400 && noAck.body.error === "acknowledge_required" && !G.isEnabled(O));
  check("ligar com acknowledge:false também recusa", (await call("PUT", "/pdv-consent/guard", "dono", { enabled: true, acknowledge: false })).status === 400 && !G.isEnabled(O));

  // 3) liga de verdade
  const on = await call("PUT", "/pdv-consent/guard", "dono", { enabled: true, acknowledge: true });
  check("ligar com acknowledge → 200 enabled:true", on.status === 200 && on.body.enabled === true && G.isEnabled(O));
  check("ligado bloqueia cliente do PDV sem autorização e contato sem consentimento", G.evaluate(O, "21988880002").allow === false && G.evaluate(O, "5521911110002").allow === false);
  check("ligado libera quem autorizou (PDV e contato)", G.evaluate(O, "21988880001").allow === true && G.evaluate(O, "5521911110001").allow === true);
  check("outra empresa segue desligada (isolamento)", G.isEnabled(Q) === false && G.evaluate(Q, "5521922220001").allow === true);
  const audit = db.prepare("SELECT metadata_json AS metadata FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'OUTBOUND_CONSENT_GUARD_ON' ORDER BY rowid DESC LIMIT 1").get(O) as any;
  check("auditado com os números (sem PII)", !!audit && /contactsBlocked/.test(String(audit.metadata)) && !/5521911110002|98888/.test(String(audit.metadata)));

  // 4) desliga
  const off = await call("PUT", "/pdv-consent/guard", "dono", { enabled: false });
  check("desligar não exige acknowledge e volta a liberar tudo", off.status === 200 && off.body.enabled === false && G.evaluate(O, "21988880002").allow === true && G.evaluate(O, "5521911110002").allow === true);
  server.close();

  // 5) UI
  const ro = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  check("UI: painel do bloqueio só com canRecord, mostra impacto e exige o aceite", /pdv-consent-guard/.test(ro) && /canRecord &&/.test(ro) && /pdv-guard-impact/.test(ro) && /disabled=\{!guardAck\}/.test(ro));
  check("UI: avisa que o gate vale pro atendimento, não só campanha", /respostas de atendimento/.test(ro));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
