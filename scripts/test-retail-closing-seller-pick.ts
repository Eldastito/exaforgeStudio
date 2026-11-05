/**
 * TESTE — P4 (fechamento escolhe o vendedor da equipe) + travas do cadastro (análise dos códigos sem nome).
 * ----------------------------------------------------------------------------
 * O ranking da folha era digitado por nome todo dia ("MARCUS", "Marcus V.", "Marcus Vinícius") e cada grafia
 * podia virar uma "pessoa" à parte, somando em dobro com o PDV. Prova:
 *   - equipe da loja (lotação do dia) + demais pessoas da rede; nada inativo/sem nome; sem vazar outra org;
 *   - matrícula escolhida só vale se for de pessoa ATIVA da org (principal ou apelido); senão é descartada;
 *   - escolhida → o nome CADASTRADO é gravado: grafias diferentes no papel viram UMA pessoa nas vendas;
 *   - nome fora da equipe e da rede fica marcado (`unmatchedSellers`) — não bloqueia, não some;
 *   - lançamento manual de vendas (rede) também valida a matrícula e grava o nome cadastrado;
 *   - rota da equipe: gerente só da loja dele (outra loja: 403);
 *   - cadastro da rede nunca cria pessoa SEM nome; Atendimento de Loja recusa nome IGUAL ao de alguém da rede
 *     (409 com a pessoa) e só cria homônimo de propósito;
 *   - regras puras do seletor (casa nome com UMA pessoa; equipe antes da rede; "outro" sinalizado); fiação.
 *
 * Uso:  npm run test:retail-closing-seller-pick
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-pick-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-seller-pick-1234567890abc";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { RetailClosingTeamService: T } = await import("../src/server/RetailClosingTeamService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { RetailFloorService } = await import("../src/server/RetailFloorService.js");
  const { RetailSellerDirectoryService: Dir } = await import("../src/server/RetailSellerDirectoryService.js");
  const { RetailSellerIdentityService: Id } = await import("../src/server/RetailSellerIdentityService.js");
  const rules = await import("../src/features/retailops/sellerPickRules.js");
  const express = (await import("express")).default;
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");
  const { default: floorRoutes } = await import("../src/server/routes/retailFloor.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, O = `org_O_${randomUUID().slice(0, 6)}`;
  for (const o of [A, O]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, code); return id; };
  const bangu = store(A, "BANGU", "1083"), carioca = store(A, "Carioca", "1065"), outra = store(O, "Outra", "1083");
  const seller = (org: string, name: string | null, matricula: string, active = 1) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, ?)`).run(id, org, matricula, name, active); return id; };
  const marcus = seller(A, "Marcus Vinícius", "10830002"), paula = seller(A, "Paula Lima", "10830007");
  const rita = seller(A, "Rita Carioca", "10650003"), sumiu = seller(A, "Fulano Inativo", "10830099", 0), semNome = seller(A, null, "10830050");
  seller(O, "Marcus Vinícius", "X1");
  Dir.setStoreSellers(A, bangu, [marcus, paula], "t");
  Dir.setStoreSellers(A, carioca, [rita], "t");
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, '1083', 'b1', '2026-11-01', '10830005', 100)`).run(randomUUID(), A);
  Id.linkMatricula(A, "10830005", marcus, "t"); // o código real do caixa é apelido do Marcus

  // ── 1. Equipe do fechamento ──
  const t = T.team(A, bangu, "2026-11-04");
  const teamIds = t.team.map((p) => p.sellerId), otherIds = t.others.map((p) => p.sellerId);
  check("1.1 equipe da BANGU = Marcus e Paula (lotação)", teamIds.length === 2 && teamIds.includes(marcus) && teamIds.includes(paula));
  check("1.2 demais da rede (cobertura) traz a Rita com a loja dela", otherIds.includes(rita) && t.others.find((p) => p.sellerId === rita)!.stores.includes("Carioca"));
  check("1.3 inativo e sem nome não aparecem", ![...teamIds, ...otherIds].includes(sumiu) && ![...teamIds, ...otherIds].includes(semNome));
  check("1.4 outra org não aparece", t.others.every((p) => p.matricula !== "X1"));
  let threw = false; try { T.team(A, outra); } catch { threw = true; }
  check("1.5 loja de outra org: recusada", threw);

  // ── 2. Matrícula escolhida precisa ser de pessoa ativa da org ──
  check("2.1 principal → nome cadastrado", T.validMatricula(A, "10830002")?.name === "Marcus Vinícius");
  check("2.2 apelido (código do caixa) → mesma pessoa", T.validMatricula(A, "10830005")?.name === "Marcus Vinícius" && T.validMatricula(A, "10830005")?.matricula === "10830005");
  check("2.3 inativo, inexistente e de outra org → null", T.validMatricula(A, "10830099") === null && T.validMatricula(A, "lixo") === null && T.validMatricula(A, "X1") === null && T.validMatricula(A, "") === null);

  // ── 3. Fechamento: escolhida = nome cadastrado; grafias diferentes = UMA pessoa ──
  const day = (d: string, rows: any[]) => RetailClosingService.submitDetailed(A, bangu, d, { dinheiro: 1000, ranking: rows }, { source: "manual" }, "t");
  const c1 = day("2026-11-03", [
    { sellerName: "MARCUS", matricula: "10830002", valor: 600 },
    { sellerName: "Paula", valor: 300 },                         // sem escolha: casa pelo nome (regra de sempre)
    { sellerName: "Fulano Novo", matricula: "inventada", valor: 100 }, // matrícula inválida descartada; fora da rede
  ]);
  const det1 = JSON.parse(c1.details_json);
  const r1 = (n: string) => det1.ranking.find((r: any) => r.sellerName === n);
  check("3.1 escolhido grava o nome CADASTRADO ('MARCUS' → 'Marcus Vinícius') e a matrícula", !!r1("Marcus Vinícius") && r1("Marcus Vinícius").matricula === "10830002", JSON.stringify(det1.ranking));
  check("3.2 matrícula inventada é descartada (nome digitado fica)", r1("Fulano Novo")?.matricula === null);
  check("3.3 fora da equipe e da rede fica marcado (não bloqueia, não some)", JSON.stringify(det1.derived.unmatchedSellers) === JSON.stringify(["Fulano Novo"]), JSON.stringify(det1.derived.unmatchedSellers));
  day("2026-11-04", [{ sellerName: "Marcus V.", matricula: "10830002", valor: 700 }]);
  day("2026-11-05", [{ sellerName: "marcus vinicius", matricula: "10830005", valor: 800 }]);
  const sales = db.prepare(`SELECT sale_date, seller_name, matricula FROM retail_seller_sales WHERE organization_id = ? AND source = 'closing' ORDER BY sale_date`).all(A) as any[];
  const marcusRows = sales.filter((r) => /Marcus/i.test(r.seller_name));
  check("3.4 três grafias no papel, escolhido da lista → o MESMO nome nas vendas dos 3 dias", marcusRows.length === 3 && marcusRows.every((r) => r.seller_name === "Marcus Vinícius"), JSON.stringify(marcusRows));
  check("3.5 matrícula gravada: principal e o código do caixa (ambos do Marcus)", marcusRows.map((r) => r.matricula).join() === "10830002,10830002,10830005");
  check("3.6 sem escolha continua casando pelo nome (Paula → matrícula dela)", sales.find((r) => r.seller_name === "Paula")?.matricula === "10830007");
  check("3.7 fora da rede vai sem matrícula (pessoa à parte, visível)", sales.find((r) => r.seller_name === "Fulano Novo")?.matricula === null);

  // ── 4. Rotas ──
  db.prepare(`INSERT INTO user_stores (id, organization_id, user_id, store_id) VALUES (?, ?, 'mgrB', ?)`).run(randomUUID(), A, bangu);
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
    const tm = await call("GET", `/api/retailops/stores/${bangu}/team?date=2026-11-04`, A, "admin", "mgrB");
    check("4.1 gerente da BANGU recebe a equipe da loja dele", tm.status === 200 && tm.body.team.length === 2);
    const tmC = await call("GET", `/api/retailops/stores/${carioca}/team`, A, "admin", "mgrB");
    check("4.2 gerente da BANGU pedindo a equipe da Carioca: 403", tmC.status === 403);
    const tmO = await call("GET", `/api/retailops/stores/${outra}/team`, A, "owner", "own");
    check("4.3 loja de outra org: 404", tmO.status === 404);

    const ss = await call("POST", "/api/retailops/seller-sales", A, "owner", "own", { storeId: bangu, saleDate: "2026-11-02", entries: [{ sellerName: "marcão", matricula: "10830002", valor: 50 }, { sellerName: "Zé", matricula: "inventada", valor: 40 }] });
    const created = (ss.body?.created || []) as any[];
    check("4.4 lançamento manual: escolhido grava nome cadastrado; matrícula inventada descartada", ss.status === 201 && created.some((r) => r.seller_name === "Marcus Vinícius" && r.matricula === "10830002") && created.some((r) => r.seller_name === "Zé" && r.matricula === null), JSON.stringify(created));

    const noName = await call("PUT", "/api/retailops/sellers/77770001", A, "owner", "own", {});
    check("4.5 cadastro da rede: código novo SEM nome → 400 (não cria pessoa sem nome)", noName.status === 400 && !db.prepare(`SELECT 1 FROM retail_sellers WHERE organization_id = ? AND matricula = '77770001'`).get(A));
    const wipe = await call("PUT", "/api/retailops/sellers/10830007", A, "owner", "own", { name: "" });
    check("4.6 cadastro da rede: apagar o nome de quem tem → 400", wipe.status === 400 && (db.prepare(`SELECT name FROM retail_sellers WHERE id = ?`).get(paula) as any).name === "Paula Lima");
    const okName = await call("PUT", "/api/retailops/sellers/77770002", A, "owner", "own", { name: "Pessoa Nova" });
    check("4.7 com nome: cria normal", okName.status === 200 && okName.body?.name === "Pessoa Nova");

    const dupFloor = await call("POST", "/api/retail-floor/sellers", A, "owner", "own", { name: "  marcus  VINICIUS " });
    check("4.8 Atendimento de Loja: nome igual ao de alguém da rede → 409 com a pessoa", dupFloor.status === 409 && dupFloor.body?.code === "same_name_exists" && dupFloor.body?.existingId === marcus, JSON.stringify(dupFloor.body));
    const homonimo = await call("POST", "/api/retail-floor/sellers", A, "owner", "own", { name: "Marcus Vinícius", allowSameName: true });
    check("4.9 homônimo de propósito (allowSameName): cria", homonimo.status === 200 && homonimo.body?.name === "Marcus Vinícius" && homonimo.body?.id !== marcus);
    const novo = await call("POST", "/api/retail-floor/sellers", A, "owner", "own", { name: "Bruna Nova" });
    check("4.10 nome que ninguém tem: cria normal", novo.status === 200);
    const outroOrg = await call("POST", "/api/retail-floor/sellers", O, "owner", "own", { name: "Paula Lima" });
    check("4.11 nome igual em OUTRA org não conta", outroOrg.status === 200);
  } finally { server.close(); }

  let floorErr = ""; try { RetailFloorService.createSeller(A, { name: "PAULA lima" }, "t"); } catch (e: any) { floorErr = e.message; }
  check("4.12 serviço do Atendimento recusa com a pessoa existente", /^same_name_exists:/.test(floorErr) && floorErr.includes(paula));

  // ── 5. Regras puras do seletor ──
  const people = [{ sellerId: "1", matricula: "1", name: "Marcus Vinícius", stores: [] }, { sellerId: "2", matricula: "2", name: "Paula Lima", stores: [] }, { sellerId: "3", matricula: "3", name: "Paula Souza", stores: [] }];
  check("5.1 casa nome completo (sem acento/caixa)", rules.matchPerson("MARCUS VINICIUS", people)?.sellerId === "1");
  check("5.2 primeiro nome único casa ('Marcus V.')", rules.matchPerson("Marcus V.", people)?.sellerId === "1");
  check("5.3 primeiro nome ambíguo ('Paula') não chuta", rules.matchPerson("Paula", people) === null);
  const rows = rules.autoMatchRows([{ sellerName: "marcus", matricula: null }, { sellerName: "Rita", matricula: null }, { sellerName: "Zé", matricula: null }],
    [people[0]], [{ sellerId: "9", matricula: "9", name: "Rita Carioca", stores: ["Carioca"] }]);
  check("5.4 auto-casamento: equipe e rede; o resto fica 'outro'", rows[0].matricula === "1" && rows[0].sellerName === "Marcus Vinícius" && rows[1].matricula === "9" && rows[2].matricula === null);
  check("5.5 nomes fora da equipe listados para o aviso", JSON.stringify(rules.outsideTeamNames(rows)) === JSON.stringify(["Zé"]));

  // ── 6. Fiação das telas ──
  const ops = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  const floor = fs.readFileSync(path.join(process.cwd(), "src/features/RetailFloorView.tsx"), "utf8");
  check("6.1 fechamento e lançamento manual usam o seletor da equipe", (ops.match(/<SellerPick /g) || []).length >= 2 && ops.includes("/api/retailops/stores/${storeId}/team?date=${date}"));
  check("6.2 fechamento não tem mais o campo livre 'Nome do vendedor' no ranking", !ops.includes(`setRanking(p => p.map((x, j) => j === i ? { ...x, sellerName: e.target.value } : x))`));
  check("6.3 Atendimento de Loja: 'já trabalha na rede?' + nome parecido + homônimo só de propósito", floor.includes("Já trabalha na rede") && floor.includes("similarPeople(") && floor.includes("allowSameName: true"));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-closing-seller-pick: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
