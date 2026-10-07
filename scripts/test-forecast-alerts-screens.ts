/**
 * TESTE — ADR-204 (telas): "Previsão e alertas" — previsão do mês (F3.4), radar de exceções (F3.3) e plano de 14 dias do vendedor (F3.5).
 * São telas SÓ de renderização sobre rotas já testadas. Prova (código-fonte + rotas): a aba existe, está num grupo e renderiza; cada cartão consome a rota certa;
 * honestidade na tela (estimativa ≠ promessa, faixa, "sem previsão: motivo", sem meta → não calcula chance, fato × hipótese rotulados, nada altera meta);
 * ações só por clique (radar liga/verifica; tarefas do plano); `/sellers` agora devolve o `id` (o plano precisa dele) sem quebrar o resto; rotas seguem só pro gestor.
 * Uso: npm run test:forecast-alerts-screens
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fascr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fascr-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }

async function main() {
  const ui = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  const groups = fs.readFileSync(path.join(process.cwd(), "src/lib/retailOpsGroups.ts"), "utf8");

  // ── a aba existe, está num grupo e renderiza ──
  check("aba 'Previsão e alertas' no TABS, no tipo e renderizada", /key: 'previsao', label: 'Previsão e alertas'/.test(ui) && /'previsao'/.test((ui.match(/type RetailTab = [^;]+;/) || [""])[0]) && /tab === 'previsao' && <ForecastAlertsTab \/>/.test(ui));
  check("a aba está no grupo 'Vendas e metas' (menu simplificado) e o grupo continua com ≤ 5 abas", /key: 'vendas'[^\n]*'previsao'/.test(groups));
  check("os 3 cartões estão montados na aba", /<ForecastCard \/>/.test(ui) && /<RadarCard \/>/.test(ui) && /<SellerPlanCard \/>/.test(ui));

  // ── previsão ──
  check("Previsão consome GET /api/retailops/forecast e mostra faixa (low–high), chance de bater e por dia útil", /apiFetch\('\/api\/retailops\/forecast'\)/.test(ui) && /projection\.low/.test(ui) && /projection\.high/.test(ui) && /goalProbability/.test(ui) && /neededPerOpenDay/.test(ui));
  check("Previsão é honesta: 'Estimativa, não promessa', loja sem previsão mostra o motivo, sem meta não calcula a chance, 403 = área do gestor", /Estimativa, não promessa/.test(ui) && /Sem previsão: \{s\.reason/.test(ui) && /Sem meta mensal cadastrada — não calculo a chance de bater/.test(ui) && /Esta área é do gestor da rede inteira/.test(ui));

  // ── radar ──
  check("Radar consome GET /radar, liga/desliga por PUT /radar/enabled e só verifica-e-avisa por clique (POST /radar/scan, só com radar ligado)", /apiFetch\('\/api\/retailops\/radar'\)/.test(ui) && /\/api\/retailops\/radar\/enabled/.test(ui) && /method: 'PUT'/.test(ui) && /\/api\/retailops\/radar\/scan/.test(ui) && /data\.enabled && <button onClick=\{scan\}/.test(ui));
  check("Radar separa Dado/integração × Negócio × Oportunidade, marca hipótese e diz quando não compara lojas (dado atrasado)", /technical: \{ label: 'Dado ou integração'/.test(ui) && /business: \{ label: 'Negócio'/.test(ui) && /opportunity: \{ label: 'Oportunidade'/.test(ui) && /\(hipótese\)/.test(ui) && /não comparo lojas com dado velho/.test(ui));
  check("Radar desligado avisa que nada vai pro sistema", /Radar desligado: você vê esta lista aqui, mas nenhum aviso é enviado/.test(ui));

  // ── plano do vendedor ──
  check("Plano: lista vendedores de /sellers (com id), busca /seller-plan/:id e cria tarefas só por clique em POST /seller-plan/:id/tasks", /apiFetch\('\/api\/retailops\/sellers'\)/.test(ui) && /filter\(\(x: any\) => x\.id/.test(ui) && /\/api\/retailops\/seller-plan\/\$\{encodeURIComponent\(id\)\}/.test(ui) && /seller-plan\/\$\{encodeURIComponent\(sel\)\}\/tasks/.test(ui) && /Criar tarefas para o gerente/.test(ui));
  check("Plano rotula fato × hipótese, mostra o aviso 'não é avaliação de desempenho' e o disclaimer do servidor", /w\.kind === 'fact' \? 'fato' : 'hipótese'/.test(ui) && /Não é avaliação de desempenho/.test(ui) && /\{plan\.disclaimer\}/.test(ui));
  check("a tela nunca escreve meta/cota/comissão (só as rotas de radar, tarefas do plano e opt-in do radar)", !/PUT.*monthly-goals.*forecast|forecast.*method: 'PUT'/.test(ui));

  // ── backend: /sellers devolve id (aditivo) ──
  const { default: db } = await import("../src/server/db.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const { default: router } = await import("../src/server/routes/retailops.js");
  const express = (await import("express")).default;
  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org); PM.seedSystemProfiles(org);
  const sid = randomUUID();
  db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '77', 'Ana', 1)").run(sid, org);
  const uid = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dono', ?, 'owner', 'active')`).run(uid, org, `${uid}@t.local`);
  const vid = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Vend', ?, 'agent', 'active')`).run(vid, org, `${vid}@t.local`);
  const prof = (k: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, k) as any)?.id;
  const who: any = { dono: { userId: uid, id: uid, role: "owner", role_profile_id: prof("owner") }, vend: { userId: vid, id: vid, role: "agent", role_profile_id: prof("vendedor") } };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = org; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/retailops", router);
  const server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = async (u: string, user: string) => { const r = await fetch(`http://127.0.0.1:${port}/api/retailops${u}`, { headers: { "x-user": user } }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const s = await get("/sellers", "dono");
  check("GET /sellers devolve o id do vendedor (aditivo: matricula/name/active seguem)", s.status === 200 && s.body.sellers[0].id === sid && s.body.sellers[0].matricula === "77" && s.body.sellers[0].name === "Ana" && s.body.sellers[0].active === 1);
  const f = await get("/forecast", "dono"), r = await get("/radar", "dono");
  check("rotas das telas respondem pro dono (forecast e radar) e ficam fechadas pro vendedor (403)", f.status === 200 && Array.isArray(f.body.stores) && r.status === 200 && Array.isArray(r.body.findings) && (await get("/forecast", "vend")).status === 403 && (await get("/radar", "vend")).status === 403 && (await get(`/seller-plan/${sid}`, "vend")).status === 403);
  const sp = await get(`/seller-plan/${sid}`, "dono");
  check("plano de um vendedor sem números responde honesto (sem inventar plano)", sp.status === 200 && sp.body.found === true && (sp.body.plan14 === null || sp.body.enough === false));
  server.close();

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
