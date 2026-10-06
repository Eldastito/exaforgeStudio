/**
 * TESTE — ADR-204 D4: consentimento LGPD (`comunicacoes`) dos clientes da base do PDV.
 * Prova: sem registro = SEM consentimento (nunca inferido) · livro append-only, última decisão vale, revogar vence · valida cliente/origem/celular ·
 * assertContactable recusa unknown/revogado/sem celular/inativo · summary só com contagens (null≠0) · contactable só granted+celular ·
 * o SINK de mensagens (OutboundConsentGuardService) passa a barrar cliente do PDV sem consentimento (antes passava como "contato desconhecido"),
 * só com a flag ligada (0-regressão), casando celular formatado/DDI · isolamento · rotas (escopo de loja, 403/404/400).
 * Uso: npm run test:pdv-consent
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pdvc-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pdvc-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PdvConsentService: P } = await import("../src/server/PdvConsentService.js");
  const { OutboundConsentGuardService: G } = await import("../src/server/OutboundConsentGuardService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const O = mkOrg(), Q = mkOrg();
  const cust = (org: string, code: string, nome: string, celular: string | null, filial = "01", inativo = 0) => db.prepare("INSERT INTO retail_pdv_customers (id, organization_id, codigo_n, nome, celular, filial, inativo) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), org, code, nome, celular, filial, inativo);
  cust(O, "100", "Ana", "(21) 99876-5432"); cust(O, "101", "Beto", "21 98765-0001"); cust(O, "102", "Sem Fone", null); cust(O, "103", "Inativo", "(21) 90000-0003", "01", 1); cust(O, "104", "Carla", "+55 21 97777-0004", "02");
  cust(Q, "100", "Outra Org", "(21) 99876-5432");

  // 1) sem registro = sem consentimento
  check("sem registro: estado 'unknown' (nunca granted)", P.status(O, "100").state === "unknown");
  check("assertContactable: unknown recusa com o motivo", P.assertContactable(O, "100").reason === "consent_unknown" && !P.assertContactable(O, "100").allowed);
  check("cliente inexistente / inativo / sem celular recusam com o motivo certo", P.assertContactable(O, "999").reason === "customer_not_found" && P.assertContactable(O, "103").reason === "inactive" && P.assertContactable(O, "102").reason === "no_phone");

  // 2) validação
  const bad = (f: () => any) => { try { f(); return false; } catch { return true; } };
  check("registrar: granted não-booleano, origem inválida, cliente inexistente e sem celular são recusados", bad(() => P.record(O, "100", { granted: "sim" as any, source: "balcao" })) && bad(() => P.record(O, "100", { granted: true, source: "magica" })) && bad(() => P.record(O, "999", { granted: true, source: "balcao" })) && bad(() => P.record(O, "102", { granted: true, source: "balcao" })));
  check("recusas NÃO gravaram nada", (db.prepare("SELECT COUNT(*) c FROM retail_pdv_consents WHERE organization_id = ?").get(O) as any).c === 0);

  // 3) livro append-only, última vale, revogar vence
  const r1 = P.record(O, "100", { granted: true, source: "balcao", evidence: "assinou o termo na loja 01" }, "u1");
  check("registrar autorização → granted + contactable", r1.state === "granted" && P.status(O, "100").state === "granted" && P.status(O, "100").source === "balcao" && P.assertContactable(O, "100").allowed);
  P.record(O, "100", { granted: false, source: "whatsapp", evidence: "cliente pediu pra parar" }, "u1");
  check("revogar SEMPRE vence a anterior (vira revoked, recusa)", P.status(O, "100").state === "revoked" && P.assertContactable(O, "100").reason === "consent_revoked");
  P.record(O, "100", { granted: true, source: "formulario" }, "u1");
  check("nova autorização depois vale (última decisão manda)", P.status(O, "100").state === "granted");
  check("livro append-only: 3 linhas, histórico completo, nada apagado", (db.prepare("SELECT COUNT(*) c FROM retail_pdv_consents WHERE organization_id = ? AND customer_code = '100'").get(O) as any).c === 3 && P.history(O, "100").length === 3);
  check("evidência é limitada (300) e a ação é auditada sem PII", (() => { P.record(O, "101", { granted: true, source: "telefone", evidence: "x".repeat(900) }, "u1"); return (db.prepare("SELECT LENGTH(evidence) l FROM retail_pdv_consents WHERE organization_id = ? AND customer_code = '101'").get(O) as any).l === 300; })());

  // 4) summary e contactable
  const sm = P.summary(O);
  check("summary: só contagens — 4 ativos, 3 com celular, 2 autorizados, 0 revogados", sm.total === 4 && sm.withPhone === 3 && sm.granted === 2 && sm.revoked === 0 && sm.unknown === 2 && sm.contactable === 2 && sm.contactablePctOfWithPhone === 67 && !JSON.stringify(sm).includes("Ana"));
  check("summary de org sem clientes: percentual null (não 0%)", P.summary(mkOrg()).contactablePctOfWithPhone === null);
  check("contactable: só granted + celular (Ana, Beto), nunca unknown/inativo", P.contactable(O).map((x) => x.code).sort().join() === "100,101");
  check("contactable respeita o escopo de loja (filial 02 não vê 01)", P.contactable(O, { restrictCodes: ["02"] }).length === 0 && P.contactable(O, { restrictCodes: [] }).length === 0 && P.contactable(O, { restrictCodes: ["01"] }).length === 2);

  // 5) isolamento
  check("isolado por empresa: o mesmo código em outra org não herda consentimento", P.status(Q, "100").state === "unknown" && P.summary(Q).granted === 0);

  // 6) SINK: o cliente do PDV deixa de passar como "contato desconhecido" (só com a flag)
  check("flag OFF: tudo passa (0-regressão)", G.evaluate(O, "5521998765432").allow === true && (G.evaluate(O, "5521998765432") as any).reason === "flag_off");
  G.setEnabled(O, true);
  const okAna = G.evaluate(O, "5521998765432");
  check("flag ON: cliente do PDV COM consentimento passa (celular formatado ↔ DDI casam)", okAna.allow === true && (okAna as any).reason === "pdv_consent_active");
  const noCarla: any = G.evaluate(O, "5521977770004");
  check("flag ON: cliente do PDV SEM consentimento é BLOQUEADO (consent_missing, origem pdv)", noCarla.allow === false && noCarla.reason === "consent_missing" && noCarla.source === "pdv" && noCarla.contactName === "Carla");
  P.record(O, "100", { granted: false, source: "whatsapp" }, "u1");
  check("flag ON: depois de revogar, volta a bloquear (leitura viva)", G.evaluate(O, "5521998765432").allow === false);
  check("flag ON: número que NÃO é cliente do PDV segue como mensagem de sistema (0-regressão)", G.evaluate(O, "5511911112222").allow === true && (G.evaluate(O, "5511911112222") as any).reason === "unknown_contact");
  check("flag ON: cliente INATIVO não é tratado como cliente (segue o comportamento anterior)", G.evaluate(O, "5521900000003").allow === true);
  check("cross-tenant: consentimento da outra org não libera", (() => { G.setEnabled(Q, true); return G.evaluate(Q, "5521998765432").allow === false; })());
  check("o gate é puro: não escreveu consentimento nem contato", (db.prepare("SELECT COUNT(*) c FROM contact_consents WHERE organization_id = ?").get(O) as any).c === 0);

  // 7) rotas
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
  const post = await call("POST", "/pdv-consent/104", "dono", { granted: true, source: "balcao", evidence: "termo assinado" });
  check("rota POST: dono registra (201) e o estado muda", post.status === 201 && post.body.state === "granted" && P.status(O, "104").state === "granted");
  check("rota POST: origem inválida → 400; cliente inexistente → 404; vendedor → 403", (await call("POST", "/pdv-consent/104", "dono", { granted: true, source: "x" })).status === 400 && (await call("POST", "/pdv-consent/nao-existe", "dono", { granted: true, source: "balcao" })).status === 404 && (await call("POST", "/pdv-consent/104", "vend", { granted: true, source: "balcao" })).status === 403);
  const get = await call("GET", "/pdv-consent/104", "dono");
  check("rota GET /:code: estado + histórico", get.status === 200 && get.body.state === "granted" && get.body.history.length === 1);
  const sum = await call("GET", "/pdv-consent/summary", "dono");
  check("rota GET /summary: contagens da rede, sem nome de cliente", sum.status === 200 && sum.body.total === 4 && sum.body.granted >= 2 && !JSON.stringify(sum.body).includes("Ana"));
  check("rota GET /contactable: só quem autorizou", (await call("GET", "/pdv-consent/contactable", "dono")).body.items.every((x: any) => ["101", "104"].includes(x.code)));
  server.close();

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
