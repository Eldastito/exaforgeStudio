/**
 * TESTE — Master admin move um usuário (gerente) pra empresa certa (UserOrgMoveService)
 * ----------------------------------------------------------------------------
 * Caso real (TOULON): o login do gerente foi criado numa empresa SEPARADA ("Toulon Carioca") e as
 * lojas/Alterdata/histórico estão na empresa principal. O isolamento é por empresa, então a conta
 * dele só enxergava o que existia na empresa errada (nada). A correção é mover o LOGIN pra empresa
 * certa — não abrir leitura entre empresas.
 *
 * Prova, pela API real (admin + retailops):
 *   - ANTES: o gerente lê os fechamentos da empresa em que está → vazio;
 *   - mover SEM loja pra uma empresa com lojas → recusa (store_required) e NADA muda;
 *   - loja de OUTRA empresa → recusa; dono / master admin / mesma empresa / destino inexistente → recusa;
 *   - mover COM a loja → perfil remapeado pro 'gerente' da destino, restrito SÓ à loja marcada, sessão
 *     antiga revogada (security_version) e mesmo login/identidade;
 *   - DEPOIS: o gerente lê o histórico da loja dele e NÃO a de outra loja da mesma empresa;
 *   - o dono da empresa destino segue vendo tudo.
 *
 * Uso:  npm run test:admin-user-move-org
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";
import express from "express";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-move-org-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-move-org-1234567890abcd";
process.env.MASTER_ADMIN_EMAIL = "master@zappflow.test";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { RetailStoreScopeService } = await import("../src/server/RetailStoreScopeService.js");
  const adminRoutes = (await import("../src/server/routes/admin.js")).default;
  const retailRoutes = (await import("../src/server/routes/retailops.js")).default;

  const SRC = `org_${randomUUID().slice(0, 8)}`, DST = `org_${randomUUID().slice(0, 8)}`;
  for (const [org, name] of [[SRC, "Toulon Carioca"], [DST, "TOULON"]] as [string, string][])
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  const exec = (sql: string, ...a: any[]) => db.prepare(sql).run(...a);

  // Empresa destino: 2 lojas com histórico (fechamento de hoje, marcador distinto)
  const today = (await import("../src/server/spDate.js")).todaySP();
  const carioca = randomUUID(), bangu = randomUUID();
  exec(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Carioca-LOJA', 'CAR', 1)`, carioca, DST);
  exec(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Bangu-LOJA', 'BAN', 1)`, bangu, DST);
  for (const [sid, amount] of [[carioca, 1111.11], [bangu, 7777.77]] as const)
    exec(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`, randomUUID(), DST, sid, today, amount, amount);
  const foreignStore = randomUUID();
  exec(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Outra-Empresa', 'OUT', 1)`, foreignStore, SRC);

  // Usuários: gerente (admin) na empresa errada com perfil 'gerente' dela; dono da empresa destino; master
  const mkUser = (org: string, email: string, role: string, extra: Record<string, any> = {}) => {
    const id = randomUUID();
    exec(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`, id, org, email, email, role);
    for (const [k, v] of Object.entries(extra)) exec(`UPDATE users SET ${k} = ? WHERE id = ?`, v, id);
    return id;
  };
  PermissionService.seedSystemProfiles(SRC);
  const gerenteSrc = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(SRC) as any).id;
  const gabriel = mkUser(SRC, "gabriel@toulonrio.com.br", "admin", { role_profile_id: gerenteSrc });
  const ownerDst = mkUser(DST, "bruno@toulon.com", "owner");
  const ownerSrc = mkUser(SRC, "dono.src@toulon.com", "owner");
  const master = mkUser(SRC, "master@zappflow.test", "admin");

  // ── mini-app com as rotas reais: o "login" é o id do usuário no header (empresa e papel vêm do banco) ──
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => {
    const uid = String(req.headers["x-uid"] || "");
    const row = uid ? (db.prepare("SELECT id, organization_id, role, role_profile_id FROM users WHERE id = ?").get(uid) as any) : null;
    if (row) { req.organizationId = row.organization_id; req.user = { userId: row.id, role: row.role, role_profile_id: row.role_profile_id, organizationId: row.organization_id, email: "master@zappflow.test" }; }
    next();
  });
  app.use("/api/admin", adminRoutes);
  app.use("/api/retailops", retailRoutes);
  const server = http.createServer(app);
  const port: number = await new Promise((r) => server.listen(0, () => r((server.address() as any).port)));
  const call = async (uid: string, method: string, url: string, body?: any) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { "Content-Type": "application/json", "x-uid": uid }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, text };
  };
  const move = (userId: string, body: any) => call(master, "POST", `/api/admin/users/${userId}/move-org`, body);
  const rowOf = (id: string) => db.prepare("SELECT organization_id, role_profile_id, security_version, identity_id FROM users WHERE id = ?").get(id) as any;

  // ── ANTES: na empresa errada o gerente não vê nada ──
  const before = await call(gabriel, "GET", `/api/retailops/closings?date=${today}`);
  check("ANTES: na empresa errada o gerente lê os fechamentos → vazio (o sintoma da TOULON)", before.status === 200 && (before.json.closings || []).length === 0, before.text.slice(0, 80));

  // ── recusas (nada pode mudar) ──
  const svBefore = rowOf(gabriel).security_version ?? 1;
  let r = await move(gabriel, { toOrgId: DST });
  check("sem loja pra empresa COM lojas → 400 store_required", r.status === 400 && r.json.error === "store_required", JSON.stringify(r.json));
  check("…e nada mudou (continua na empresa de origem, sessão intacta)", rowOf(gabriel).organization_id === SRC && (rowOf(gabriel).security_version ?? 1) === svBefore);
  r = await move(gabriel, { toOrgId: DST, storeIds: [foreignStore] });
  check("loja de OUTRA empresa → 400 store_not_in_target", r.status === 400 && r.json.error === "store_not_in_target", JSON.stringify(r.json));
  r = await move(ownerSrc, { toOrgId: DST, storeIds: [carioca] });
  check("dono da empresa não é movido (403)", r.status === 403 && r.json.error === "cannot_move_owner" && rowOf(ownerSrc).organization_id === SRC);
  r = await move(master, { toOrgId: DST, storeIds: [carioca] });
  check("master admin não é movido (400)", r.status === 400 && r.json.error === "cannot_move_master_admin" && rowOf(master).organization_id === SRC);
  r = await move(gabriel, { toOrgId: SRC });
  check("mesma empresa → 400 same_org", r.status === 400 && r.json.error === "same_org");
  r = await move(gabriel, { toOrgId: "org_que_nao_existe", storeIds: [] });
  check("empresa destino inexistente → 404", r.status === 404 && r.json.error === "target_not_found");
  r = await move(randomUUID(), { toOrgId: DST, storeIds: [carioca] });
  check("usuário inexistente → 404", r.status === 404 && r.json.error === "user_not_found");
  check("rota sem toOrgId → 400", (await call(master, "POST", `/api/admin/users/${gabriel}/move-org`, {})).status === 400);

  // ── mover COM a loja ──
  const identityBefore = rowOf(gabriel).identity_id;
  r = await move(gabriel, { toOrgId: DST, storeIds: [carioca] });
  check("mover com a loja Carioca → 200", r.status === 200 && r.json.ok === true && r.json.fromOrgId === SRC, JSON.stringify(r.json));
  const after = rowOf(gabriel);
  const gerenteDst = (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = 'gerente'").get(DST) as any)?.id;
  check("agora está na empresa destino", after.organization_id === DST);
  check("perfil remapeado pro 'gerente' DA DESTINO (perfil é por empresa)", !!gerenteDst && after.role_profile_id === gerenteDst);
  check("sessão antiga revogada (security_version subiu) e mesmo login/identidade", (after.security_version ?? 1) === svBefore + 1 && after.identity_id === identityBefore);
  const scope = RetailStoreScopeService.allowed(DST, gabriel, "admin");
  check("nasce RESTRITO só à Carioca (nunca irrestrito)", scope.unrestricted === false && scope.storeIds.length === 1 && scope.storeIds[0] === carioca);

  // ── DEPOIS: lê o histórico da loja dele, e só dela ──
  const mine = await call(gabriel, "GET", `/api/retailops/closings?date=${today}`);
  check("DEPOIS: o gerente vê o fechamento da Carioca", /1111\.11/.test(mine.text), mine.text.slice(0, 120));
  check("…e NÃO vê o da Bangu (outra loja da mesma empresa)", !/7777\.77/.test(mine.text));
  const other = await call(gabriel, "GET", `/api/retailops/cash/ledger?storeId=${bangu}&month=${today.slice(0, 7)}`);
  check("…e não abre a Bangu por id (403/404)", other.status === 403 || other.status === 404, `${other.status}`);
  const own = await call(ownerDst, "GET", `/api/retailops/closings?date=${today}`);
  check("o dono da empresa destino segue vendo as duas lojas", /1111\.11/.test(own.text) && /7777\.77/.test(own.text));

  console.log("\n=== Master admin: mover gerente pra empresa certa ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} admin-user-move-org: ${results.length - failures}/${results.length} checks`);
  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
