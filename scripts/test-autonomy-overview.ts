/**
 * TESTE — ADR-204 F3.1d: tela Empresa → Autonomia da IA ("O que a IA pode fazer sozinha"). Não há teste de componente no
 * repo; prova-se (A) o read-model `ApprovalPolicyService.overview` e a rota nos serviços REAIS, e (B) a FIAÇÃO da tela
 * por regex de fonte (painel montado em Governança, usa só rotas já testadas, sem controle novo de elevar autonomia).
 *
 * Uso:  npm run test:autonomy-overview
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-autonomy-overview-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-autonomy-overview-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ApprovalPolicyService: P } = await import("../src/server/ApprovalPolicyService.js");
  const { AutonomyKillSwitchService: K } = await import("../src/server/AutonomyKillSwitchService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const profile = (org: string, key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id;
  const mkUser = (org: string, role: string, key: string, name: string) => {
    const id = randomUUID(); const email = `${id}@t.local`;
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, email, role);
    return { userId: id, id, role, role_profile_id: profile(org, key), name, email };
  };
  const maria = mkUser(A, "owner", "owner", "Maria Dona");
  const joao = mkUser(A, "admin", "vendedor", "João Vendedor");
  const ins = (org: string, domain: string, t: string, autonomy: string, mode: string, max: number | null = null) =>
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, max_auto_amount, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(randomUUID(), org, domain, t, autonomy, mode, max);

  // ── A) read-model ──
  const empty = P.overview(A);
  check("sem política: lista vazia, piso presente, sem pausa", empty.policies.length === 0 && empty.humanOnly.length >= 6 && empty.pause.paused === false);
  check("piso traz rótulo humano e tipos por categoria", empty.humanOnly.every((c: any) => c.label && Array.isArray(c.types) && c.types.length > 0));

  ins(A, "finance", "collection", "execute", "approved_execution", 500);
  ins(A, "ops", "ov_suggest", "suggest", "shadow");
  ins(B, "ops", "ov_other", "suggest", "shadow");
  P.setGates(A, "finance", "collection", { minConfidence: 0.8, maxDataAgeMinutes: 30 });
  const o1 = P.overview(A);
  const col = o1.policies.find((p: any) => p.actionType === "collection");
  const sug = o1.policies.find((p: any) => p.actionType === "ov_suggest");
  check("lista só as políticas da empresa (isolamento)", o1.policies.length === 2 && !o1.policies.some((p: any) => p.actionType === "ov_other"));
  check("nível derivado: execute+teto → 3; suggest → 1", col?.level === 3 && sug?.level === 1, JSON.stringify([col?.level, sug?.level]));
  check("travas do tipo aparecem; tipo sem trava não inventa", col?.gates?.minConfidence === 0.8 && col?.gates?.maxDataAgeMinutes === 30 && !sug?.gates?.minConfidence);
  check("rótulo humano (não o código técnico)", typeof col?.label === "string" && col.label !== "collection" && sug?.label === "Ação interna");

  K.pause(A, { domain: "finance", actionType: "collection", reason: "teste de pausa", by: maria.userId });
  const o2 = P.overview(A);
  const colP = o2.policies.find((p: any) => p.actionType === "collection");
  check("pausa do tipo: paused, nível ≤2 e escopo", colP.paused === true && colP.level <= 2 && !!colP.pausedScope);
  check("outra empresa não enxerga a pausa", P.overview(B).policies.every((p: any) => !p.paused) && P.overview(B).pause.paused === false);
  K.pause(A, { reason: "pausa geral", by: maria.userId });
  check("pausa da empresa inteira aparece no status", P.overview(A).pause.paused === true);

  // ── rota ──
  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/actions.js")).default;
  const who: Record<string, any> = { maria, joao };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/actions", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = async (user: string | null, org: string | null) => {
    const h: any = {}; if (user) h["x-user"] = user; if (org) h["x-org"] = org;
    const r = await fetch(`http://127.0.0.1:${port}/api/actions/autonomy/overview`, { headers: h });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const rm = await get("maria", A), rj = await get("joao", A), rn = await get(null, null);
  check("rota: dono lê e pode governar", rm.status === 200 && rm.body.canGovern === true && rm.body.policies.length === 2);
  check("rota: não-dono lê, mas canGovern=false", rj.status === 200 && rj.body.canGovern === false);
  check("rota: sem empresa → 401", rn.status === 401);
  server.close();

  // ── B) fiação do front (regex de fonte) ──
  const root = path.resolve(process.cwd());
  const panel = fs.readFileSync(path.join(root, "src/features/settings/AutonomyContractPanel.tsx"), "utf8");
  const settings = fs.readFileSync(path.join(root, "src/features/SettingsView.tsx"), "utf8");
  check("painel montado em Configurações → Governança", /import \{ AutonomyContractPanel \}/.test(settings) && /<AutonomyContractPanel \/>/.test(settings));
  check("painel lê /autonomy/overview e usa pause/resume/gates", ["/autonomy/overview", "/autonomy/pause", "/autonomy/resume", "/autonomy/gates"].every((s) => panel.includes(s)));
  check("painel NÃO tem controle de elevar autonomia (RN-F3-3)", !/autonomy_level|autonomyLevel\s*:|execution_mode|raise|elevar|subir nível/i.test(panel.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  check("ações só p/ quem pode governar (canGovern)", /canGovern/.test(panel));

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
