/**
 * TESTE — "Confirmar" troca a matrícula sozinho quando a oficial da pessoa nunca vendeu (caso real TOULON, 11/2026).
 * ----------------------------------------------------------------------------
 * O Beto (gerente de Nova Iguaçu, não vende) foi cadastrado na 10650054 pela antiga "próxima matrícula". A 10650054 é
 * do Rodrigo no caixa: o cadastro do Rodrigo era recusado ("já é de Beto") e, se o código vendesse, a venda cairia no
 * Beto. O "Confirmar" ligava o código real só como apelido e o palpite continuava preso à pessoa. Prova:
 *   - matrícula oficial que nunca vendeu + código que vendeu → o código vira a OFICIAL; a antiga fica livre (sem apelido);
 *   - escala/cota e lançamento manual acompanham a pessoa; venda do caixa não é tocada;
 *   - placeholder LV- também vira o código real; confirmar de novo um código já ligado (apelido) faz a troca;
 *   - oficial que JÁ vendeu → continua apelido (pessoa com dois códigos reais);
 *   - planejamento já lançado no código novo → não decide sozinho: apelido + aviso;
 *   - nunca rouba: código de outra pessoa (oficial ou apelido) → conflito, nada escrito; código fora das vendas → erro;
 *   - a matrícula liberada aceita o cadastro do dono real (pessoa NOVA, o Beto não é renomeado);
 *   - roteiro do caso Beto/Rodrigo pela tela (lápis → LV-BETO, depois cadastrar Rodrigo) sem perder nada do Beto;
 *   - rotas: rede (link-matricula) e Atendimento de Loja (link-code) devolvem a troca; isolamento; auditoria;
 *   - rótulos da pergunta/aviso e fiação das telas.
 *
 * Uso:  npm run test:retail-seller-confirm-code
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-confirm-code-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-confirm-code-1234567890abc";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const throws = (fn: () => any, re: RegExp) => { try { fn(); return false; } catch (e: any) { return re.test(e.message); } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { RetailSellerIdentityService: S } = await import("../src/server/RetailSellerIdentityService.js");
  const { RetailSellerDirectoryService: Dir } = await import("../src/server/RetailSellerDirectoryService.js");
  const labels = await import("../src/features/retailops/sellerCodeLabels.js");
  const express = (await import("express")).default;
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");
  const { default: floorRoutes } = await import("../src/server/routes/retailFloor.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, code); return id; };
  const nova = store(A, "Nova Iguaçu", "1065"), bangu = store(A, "BANGU", "1083");
  const seller = (org: string, mat: string, name: string | null) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, mat, name); return id; };
  let bol = 0;
  const pdv = (org: string, filial: string, code: string, valor = 100, date = "2026-11-10") => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, vendedor_codigo, valor) VALUES (?, ?, ?, ?, ?, 'op', ?, ?)`).run(randomUUID(), org, filial, String(++bol), date, code, valor);
  const matOf = (id: string) => (db.prepare(`SELECT matricula m FROM retail_sellers WHERE id = ?`).get(id) as any)?.m;
  const aliasesOf = (id: string) => (db.prepare(`SELECT alias FROM retail_seller_aliases WHERE organization_id = ? AND seller_id = ? AND kind IN ('matricula','cai_usuario')`).all(A, id) as any[]).map((r) => r.alias);
  const pdvCount = (code: string) => (db.prepare(`SELECT COUNT(*) n FROM retail_pdv_sales WHERE organization_id = ? AND vendedor_codigo = ?`).get(A, code) as any).n;

  // ── 1. Matrícula "chutada" que nunca vendeu → o código real vira a oficial ──
  const marcus = seller(A, "10830002", "MARCUS VINICIUS");            // palpite antigo: nunca vendeu
  for (let i = 0; i < 4; i++) pdv(A, "1083", "10830005");             // código real dele
  db.prepare(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, 'mat:10830002', 'MARCUS', '2026-11-09', 5000)`).run(randomUUID(), A, bangu);
  db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, '2026-11-14', 'mat:10830002', 'MARCUS', 'work')`).run(randomUUID(), A, bangu);
  db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, source) VALUES (?, ?, ?, '2026-11-10', 'MARCUS VINICIUS', '10830002', 400, 'closing')`).run(randomUUID(), A, bangu);
  Dir.setStoreSellers(A, bangu, [marcus], "t");
  const r1 = S.confirmCode(A, "10830005", marcus, "u-dono");
  check("1.1 confirma: troca (mode swapped) e diz qual era a antiga", r1.mode === "swapped" && r1.previous === "10830002", JSON.stringify(r1));
  check("1.2 a matrícula OFICIAL passa a ser o código do caixa", matOf(marcus) === "10830005");
  check("1.3 a antiga NÃO fica como apelido (fica livre para o dono real)", !aliasesOf(marcus).includes("10830002") && !aliasesOf(marcus).includes("10830005"));
  check("1.4 cota e escala acompanham a pessoa", (db.prepare(`SELECT COUNT(*) n FROM retail_seller_quotas WHERE organization_id = ? AND seller_key = 'mat:10830005'`).get(A) as any).n === 1 && (db.prepare(`SELECT COUNT(*) n FROM retail_schedule_entries WHERE organization_id = ? AND seller_key = 'mat:10830005'`).get(A) as any).n === 1 && (db.prepare(`SELECT COUNT(*) n FROM retail_seller_quotas WHERE organization_id = ? AND seller_key = 'mat:10830002'`).get(A) as any).n === 0);
  check("1.5 lançamento manual acompanha a pessoa", (db.prepare(`SELECT COUNT(*) n FROM retail_seller_sales WHERE organization_id = ? AND matricula = '10830005'`).get(A) as any).n === 1);
  check("1.6 venda do caixa não é tocada", pdvCount("10830005") === 4);
  check("1.7 lotação e id da pessoa não mudam", !!db.prepare(`SELECT 1 FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND store_id = ? AND active = 1`).get(A, marcus, bangu));
  check("1.8 auditado (troca de matrícula)", !!db.prepare(`SELECT 1 FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_SELLER_MATRICULA_CHANGED' AND target_user_id = ?`).get(A, marcus));

  // ── 2. A matrícula liberada aceita o dono real como pessoa NOVA ──
  for (let i = 0; i < 2; i++) pdv(A, "1083", "10830002");             // o dono real do 10830002 começa a vender
  const app = express();
  app.use(express.json());
  const fake = (req: any, _res: any, next: any) => { req.organizationId = req.headers["x-test-org"] || null; req.user = { userId: req.headers["x-test-user"] || "u1", role: req.headers["x-test-role"] || "owner", organizationId: req.organizationId }; next(); };
  app.use("/api/retailops", fake, retailRoutes);
  app.use("/api/retail-floor", fake, floorRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, p: string, org: string, role: string, user: string, body?: any) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-org": org, "x-test-role": role, "x-test-user": user }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, body: j };
  };
  try {
    const nova2 = await call("PUT", "/api/retailops/sellers/10830002", A, "owner", "own", { name: "MARIA EDUARDA" });
    check("2.1 cadastrar o dono real do código liberado cria pessoa NOVA", nova2.status === 200 && nova2.body?.id && nova2.body.id !== marcus && nova2.body.name === "MARIA EDUARDA");
    check("2.2 o Marcus não foi renomeado", (db.prepare(`SELECT name FROM retail_sellers WHERE id = ?`).get(marcus) as any).name === "MARCUS VINICIUS");

    // ── 3. Caso Beto/Rodrigo pela tela de hoje: lápis do Beto → LV-BETO, depois cadastrar Rodrigo no 10650054 ──
    const beto = seller(A, "10650054", "BETO GERENTE");
    Dir.setStoreSellers(A, nova, [beto], "t");
    db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, '2026-11-24', 'mat:10650054', 'BETO GERENTE', 'work')`).run(randomUUID(), A, nova);
    db.prepare(`UPDATE retail_sellers SET user_id = 'user-beto' WHERE id = ?`).run(beto);
    const pencil = await call("POST", `/api/retailops/sellers/${beto}/matricula`, A, "owner", "own", { matricula: "LV-BETO" });
    check("3.1 lápis do Beto: matrícula vira LV-BETO (sem código do caixa)", pencil.status === 200 && matOf(beto) === "LV-BETO", JSON.stringify(pencil.body));
    const rod = await call("PUT", "/api/retailops/sellers/10650054", A, "owner", "own", { name: "RODRIGO" });
    check("3.2 Rodrigo cadastrado no 10650054 como pessoa NOVA", rod.status === 200 && rod.body?.id !== beto && rod.body?.name === "RODRIGO");
    const betoRow = db.prepare(`SELECT name, active, user_id FROM retail_sellers WHERE id = ?`).get(beto) as any;
    check("3.3 o Beto segue ativo, com o nome e o login dele", betoRow.name === "BETO GERENTE" && betoRow.active === 1 && betoRow.user_id === "user-beto");
    check("3.4 a escala do Beto foi junto (mat:LV-BETO), nada ficou no código do Rodrigo", (db.prepare(`SELECT COUNT(*) n FROM retail_schedule_entries WHERE organization_id = ? AND seller_key = 'mat:LV-BETO'`).get(A) as any).n === 1 && (db.prepare(`SELECT COUNT(*) n FROM retail_schedule_entries WHERE organization_id = ? AND seller_key = 'mat:10650054'`).get(A) as any).n === 0);
    check("3.5 a lotação do Beto em Nova Iguaçu continua", !!db.prepare(`SELECT 1 FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND store_id = ? AND active = 1`).get(A, beto, nova));

    // ── 4. Rotas: rede e Atendimento de Loja ──
    const thais = seller(A, "10650052", "THAIS");
    for (let i = 0; i < 3; i++) pdv(A, "1065", "10650051");
    const net = await call("POST", "/api/retailops/sellers/identity/link-matricula", A, "owner", "own", { matricula: "10650051", sellerId: thais });
    check("4.1 rede ('Confirmar'/'É esta pessoa'): devolve a troca", net.status === 200 && net.body?.mode === "swapped" && net.body?.previous === "10650052" && matOf(thais) === "10650051", JSON.stringify(net.body));
    db.prepare(`UPDATE retail_stores SET manager_user_id = 'mgrN' WHERE organization_id = ? AND id = ?`).run(A, nova); // gerente da loja
    const kamilla = seller(A, "LV-K1", "kamilla");
    Dir.setStoreSellers(A, nova, [beto, kamilla], "t");
    for (let i = 0; i < 3; i++) pdv(A, "1065", "10650077");
    const fl = await call("POST", `/api/retail-floor/stores/${nova}/sellers/${kamilla}/link-code`, A, "agent", "mgrN", { code: "10650077" });
    check("4.2 Atendimento de Loja ('Confirmar' do gerente): LV- vira o código do caixa", fl.status === 200 && fl.body?.mode === "swapped" && matOf(kamilla) === "10650077", JSON.stringify(fl.body));
    const other = await call("POST", "/api/retailops/sellers/identity/link-matricula", B, "owner", "own", { matricula: "10650051", sellerId: thais });
    check("4.3 outra empresa não mexe nesta pessoa (isolamento)", other.status === 400 && matOf(thais) === "10650051");
  } finally { server.close(); }

  // ── 5. Oficial que JÁ vendeu → continua apelido ──
  const ana = seller(A, "10840001", "ANA");
  pdv(A, "1084", "10840001"); pdv(A, "1084", "10840009");
  const r5 = S.confirmCode(A, "10840009", ana, "t");
  check("5.1 pessoa com código real que vendeu: o novo vira apelido", r5.mode === "alias" && matOf(ana) === "10840001" && aliasesOf(ana).includes("10840009"));

  // ── 6. Já confirmado antes como apelido → confirmar de novo faz a troca ──
  const camila = seller(A, "10840003", "CAMILA");
  pdv(A, "1084", "10840002");
  S.linkMatricula(A, "10840002", camila, "t");                         // "Confirmar" antigo (só apelido)
  const r6 = S.confirmCode(A, "10840002", camila, "t");
  check("6.1 apelido antigo + oficial que nunca vendeu: vira a oficial", r6.mode === "swapped" && matOf(camila) === "10840002" && !aliasesOf(camila).includes("10840002"));

  // ── 7. Nunca rouba ──
  const rita = seller(A, "10650099", "RITA");
  const ritaMat = matOf(rita);
  check("7.1 código que é a OFICIAL de outra pessoa → conflito", throws(() => S.confirmCode(A, "10840001", rita, "t"), /conflict/) && matOf(rita) === ritaMat && matOf(ana) === "10840001");
  check("7.2 código que é APELIDO de outra pessoa → conflito", throws(() => S.confirmCode(A, "10840009", rita, "t"), /conflict/) && matOf(rita) === ritaMat);
  check("7.3 código que não aparece nas vendas → erro", throws(() => S.confirmCode(A, "99999999", rita, "t"), /não aparece/));
  check("7.4 pessoa inexistente → erro", throws(() => S.confirmCode(A, "10650051", "nao-existe", "t"), /não encontrado/));

  // ── 8. Planejamento já lançado no código novo → não decide sozinho ──
  const leo = seller(A, "10830020", "LEO");
  pdv(A, "1083", "10830021");
  db.prepare(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, 'mat:10830021', 'código sem nome', '2026-11-09', 3000)`).run(randomUUID(), A, bangu);
  const r8 = S.confirmCode(A, "10830021", leo, "t");
  check("8.1 cota já lançada no código novo: fica apelido, com aviso", r8.mode === "alias" && /escala\/cota/.test(r8.note || "") && matOf(leo) === "10830020" && aliasesOf(leo).includes("10830021"));

  // ── 9. Rótulos ──
  check("9.1 pergunta: palpite que nunca vendeu", labels.confirmCodeQuestion({ code: "10830005", name: "MARCUS", matricula: "10830002" }).includes("A matrícula de MARCUS passa a ser 10830005. A 10830002, que nunca vendeu no caixa, fica livre"));
  check("9.2 pergunta: sem código do caixa (LV-)", labels.confirmCodeQuestion({ code: "10650077", name: "kamilla", matricula: "LV-K1" }).includes("estava sem código do caixa e passa a ter a matrícula 10650077"));
  check("9.3 aviso: troca", labels.codeConfirmedMessage("10830005", "MARCUS", { mode: "swapped", previous: "10830002" }) === "MARCUS agora tem a matrícula 10830005; a 10830002 ficou livre.");
  check("9.4 aviso: LV- → só a matrícula nova", labels.codeConfirmedMessage("10650077", "kamilla", { mode: "swapped", previous: "LV-K1" }) === "kamilla agora tem a matrícula 10650077.");
  check("9.5 aviso: apelido (e nota quando houver)", labels.codeConfirmedMessage("10840009", "ANA", { mode: "alias" }) === "Código 10840009 agora é de ANA." && labels.codeConfirmedMessage("1", "X", { mode: "alias", note: "N." }) === "Código 1 agora é de X. N.");

  // ── 10. Fiação ──
  const ops = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  const floor = fs.readFileSync(path.join(process.cwd(), "src/features/RetailFloorView.tsx"), "utf8");
  const routesOps = fs.readFileSync(path.join(process.cwd(), "src/server/routes/retailops.ts"), "utf8");
  const routesFloor = fs.readFileSync(path.join(process.cwd(), "src/server/routes/retailFloor.ts"), "utf8");
  check("10.1 as duas rotas de confirmar usam confirmCode", routesOps.includes("RetailSellerIdentityService.confirmCode(orgId, String(req.body?.matricula") && routesFloor.includes("RetailSellerIdentityService.confirmCode(orgId, code, seller.id"));
  check("10.2 rede: 'Confirmar' pergunta e avisa a troca", ops.includes("confirmCodeQuestion({ code: p.code, name: p.name, matricula: p.matricula })") && (ops.match(/codeConfirmedMessage\(/g) || []).length >= 5);
  check("10.3 'é a mesma pessoa?' e 'Já cadastrado?' passam pelo Confirmar do servidor", (ops.match(/linkCodeToPerson\(/g) || []).length >= 3);
  check("10.4 Atendimento de Loja: pergunta e aviso da troca", floor.includes("confirmCodeQuestion({ code, name, matricula })") && floor.includes("codeConfirmedMessage(code, name, r)"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-seller-confirm-code: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
