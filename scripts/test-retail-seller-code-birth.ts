/**
 * TESTE — códigos de vendedor sem nome: o cadastro escolhe o código REAL (P1) e a loja é avisada
 * quando um código novo começa a vender (P2). Caso BANGU (out/2026): cadastro sugerido 10830002
 * (palpite "próxima matrícula") enquanto o caixa vendia em 10830005 — a pessoa ficava duplicada.
 * Prova:
 *   - candidatos do cadastro = códigos SEM NOME que venderam no caixa DAQUELA loja, vendendo primeiro,
 *     com "parece ser" da auditoria; código chutado nunca aparece; outra loja/org não vaza;
 *   - código digitado que nunca vendeu na loja é detectável (seenInStore);
 *   - dar nome repetido a outro código devolve 409 com a pessoa existente (não duplica em silêncio);
 *     allowSameName cria de propósito; renomear quem já tem nome não é barrado;
 *   - código NOVO (1ª venda na loja ≤30 dias) vira aviso DA LOJA, idempotente, sem dinheiro, com a
 *     sugestão; some sozinho ao ganhar nome; desligar as exceções fecha o aviso;
 *   - o número do "Hoje" conta só código vendendo (parado há >45 dias fica fora);
 *   - a tela não chama mais a "próxima matrícula" e trata o 409.
 *
 * Uso:  npm run test:retail-seller-code-birth
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-code-birth-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-code-birth-1234567890abc";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { RetailSellerCodeBirthService: B, NEW_CODE_DAYS } = await import("../src/server/RetailSellerCodeBirthService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");
  const { RetailExceptionSignalService: X } = await import("../src/server/RetailExceptionSignalService.js");
  const { RetailSellerIdentityService: Id } = await import("../src/server/RetailSellerIdentityService.js");
  const { presentSignal } = await import("../src/server/SignalLanguage.js");
  const labels = await import("../src/features/retailops/sellerCodeLabels.js");
  const express = (await import("express")).default;
  const { default: retailRoutes } = await import("../src/server/routes/retailops.js");

  const ASOF = "2026-11-04";
  const A = `org_A_${randomUUID().slice(0, 6)}`, O = `org_O_${randomUUID().slice(0, 6)}`;
  for (const o of [A, O]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, code); return id; };
  const bangu = store(A, "BANGU", "1083"), carioca = store(A, "Carioca", "1065"), otherOrgStore = store(O, "Outra", "1083");
  let b = 0;
  const sale = (org: string, filial: string, code: string, date: string, v = 100) => db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, filial, `b${b++}`, date, code, v);
  const man = (org: string, name: string, date: string, v: number) => db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, valor) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, date, name, v);

  // Cadastro chutado (o que o "próxima matrícula" produzia): Marcus em 10830002, que nunca vende.
  const marcusId = randomUUID();
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '10830002', 'Marcus Vinicius', 1)`).run(marcusId, A);
  // Caixa real: 10830005 vende desde 20/10 e bate com o lançamento manual do Marcus (código NOVO, ≤30 dias).
  const days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-27", "2026-10-28"];
  const vals = [900, 1200, 800, 1500, 700, 1000, 1100];
  days.forEach((d, i) => { sale(A, "1083", "10830005", d, vals[i] * 1.03); man(A, "Marcus Vinicius", d, vals[i]); });
  // 10830001: vendeu em maio e parou (parado >45 dias, nasceu há muito).
  sale(A, "1083", "10830001", "2026-05-02"); sale(A, "1083", "10830001", "2026-06-10");
  // 10830006: antigo (1ª venda em agosto) e ainda vendendo — sem nome, mas NÃO é novo.
  sale(A, "1083", "10830006", "2026-08-01"); sale(A, "1083", "10830006", "2026-11-02");
  // Código de outra loja da mesma rede (Carioca) e da mesma filial em OUTRA org.
  sale(A, "1065", "10650009", "2026-11-01");
  sale(O, "1083", "10839999", "2026-11-01");

  // ── 1. P1: candidatos do cadastro ──
  const cand = B.candidatesForStore(A, bangu, { asOf: ASOF });
  const codes = cand.candidates.map((c: any) => c.matricula);
  check("1.1 candidatos da BANGU = só códigos sem nome que venderam no caixa dela", JSON.stringify([...codes].sort()) === JSON.stringify(["10830001", "10830005", "10830006"]), JSON.stringify(codes));
  check("1.2 código chutado do cadastro (10830002) nunca aparece como candidato", !codes.includes("10830002"));
  check("1.3 vendendo agora primeiro, parado por último", codes[codes.length - 1] === "10830001" && cand.candidates.find((c: any) => c.matricula === "10830001").status === "parado");
  const c5 = cand.candidates.find((c: any) => c.matricula === "10830005");
  check("1.4 10830005 traz 'parece ser Marcus' (lançamento manual diário bate)", c5?.likelyPerson?.name === "Marcus Vinicius" && c5?.likelyPerson?.sellerId === marcusId, JSON.stringify(c5?.likelyPerson));
  check("1.5 outra loja (Carioca) e outra org não entram", !codes.includes("10650009") && !codes.includes("10839999"));
  check("1.6 seenInStore: real sim, chutado não, outra loja não", B.seenInStore(A, bangu, "10830005") && !B.seenInStore(A, bangu, "10830002") && !B.seenInStore(A, bangu, "10650009"));
  let threw = false; try { B.candidatesForStore(A, otherOrgStore); } catch { threw = true; }
  check("1.7 loja de outra org: recusada", threw);

  // ── 2. P2: código novo vira aviso da loja ──
  const news = B.newCodes(A, ASOF);
  check("2.1 código NOVO = só 10830005 (1ª venda na loja ≤30 dias); antigos e parados fora", news.length === 2 && news.some((n) => n.matricula === "10830005" && n.storeId === bangu) && !news.some((n) => ["10830001", "10830006"].includes(n.matricula)), JSON.stringify(news.map((n) => n.matricula)));
  check("2.2 código novo da Carioca é aviso da Carioca", news.some((n) => n.matricula === "10650009" && n.storeId === carioca));
  check("2.3 janela de código novo = 30 dias", NEW_CODE_DAYS === 30);
  RetailOpsSignalPublisher.run(A, { asOf: ASOF });
  const open = (org: string) => db.prepare(`SELECT * FROM business_signals WHERE organization_id = ? AND signal_type = 'retail_seller_code_new' AND status = 'open'`).all(org) as any[];
  const s5 = open(A).find((s) => s.dedupe_key === `retail_ops:seller_code_new:${bangu}:10830005`);
  const ev5 = s5 ? JSON.parse(s5.evidence_json) : {};
  check("2.4 aviso publicado na LOJA (gerente dela vê), sem dinheiro", !!s5 && s5.source_entity_type === "retail_store" && s5.source_entity_id === bangu && s5.impact_amount === null, JSON.stringify(s5));
  check("2.5 aviso diz o código, a loja, desde quando e 'parece ser Marcus'", /10830005/.test(ev5.summary) && /BANGU/.test(ev5.summary) && /20\/10/.test(ev5.summary) && /Marcus Vinicius/.test(ev5.summary), ev5.summary);
  RetailOpsSignalPublisher.run(A, { asOf: ASOF });
  check("2.6 idempotente: rodar de novo não duplica", open(A).filter((s) => s.dedupe_key.endsWith(":10830005")).length === 1 && open(A).length === 2);
  const pres = presentSignal({ signalType: "retail_seller_code_new", domain: "retail_ops", evidence: ev5 } as any);
  check("2.7 texto do aviso: 'BANGU: código novo 10830005 vendendo sem nome — quem é?'", /BANGU: código novo 10830005 vendendo sem nome — quem é\?/.test(pres.title), pres.title);
  check("2.8 outra org não recebe aviso da A", open(O).length === 0);

  // Dá nome ligando o código ao Marcus (alias) → o aviso some sozinho.
  Id.linkMatricula(A, "10830005", marcusId, "t");
  RetailOpsSignalPublisher.run(A, { asOf: ASOF });
  check("2.9 código ganhou nome → aviso resolve sozinho", !open(A).some((s) => s.dedupe_key.endsWith(":10830005")));
  X.setEnabled(A, false);
  RetailOpsSignalPublisher.run(A, { asOf: ASOF });
  check("2.10 exceções desligadas → nenhum aviso de código novo aberto", open(A).length === 0);
  X.setEnabled(A, true);

  // ── 3. "Hoje": conta só código vendendo ──
  // Pendentes agora: 10830001 (parado desde 10/06), 10830006 (vendeu 02/11), 10650009 (vendeu 01/11).
  check("3.1 Hoje conta só os 2 que vendem (o parado há >45 dias fica fora)", X.unidentifiedCount(A, ASOF) === 2, String(X.unidentifiedCount(A, ASOF)));
  const it = X.items(A, ASOF).find((x: any) => x.type === "retail_sellers_unidentified") as any;
  check("3.2 texto do Hoje: '2 vendedores ainda precisam ser identificados'", it?.count === 2 && /2 vendedores ainda precisam/.test(it.text));
  check("3.3 sem data: usa hoje (não quebra)", Number.isInteger(X.unidentifiedCount(A)));

  // ── 4. Rota: candidatos + trava de nome repetido ──
  const app = express();
  app.use(express.json());
  app.use("/api/retailops", (req: any, _res: any, next: any) => {
    req.organizationId = req.headers["x-test-org"] || null;
    req.user = { userId: "u1", role: req.headers["x-test-role"] || "owner", organizationId: req.organizationId };
    next();
  }, retailRoutes);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/retailops`;
  const call = async (method: string, p: string, org: string, body?: any, role = "owner") => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "x-test-org": org, "x-test-role": role }, body: body ? JSON.stringify(body) : undefined });
    let j: any = null; try { j = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, body: j };
  };
  try {
    const rc = await call("GET", `/sellers/code-candidates?storeId=${bangu}&matricula=10830002`, A);
    check("4.1 GET code-candidates: lista + diz que o código digitado nunca vendeu na loja", rc.status === 200 && Array.isArray(rc.body?.candidates) && rc.body.seenInStore === false, JSON.stringify(rc.body).slice(0, 200));
    const rcO = await call("GET", `/sellers/code-candidates?storeId=${bangu}`, O);
    check("4.2 outra org pedindo a loja da A: 404", rcO.status === 404);
    const rDup = await call("PUT", "/sellers/10830006", A, { name: "marcus  vinícius" });
    check("4.3 dar a 10830006 o nome de quem já existe → 409 com a pessoa (sem criar)", rDup.status === 409 && rDup.body?.code === "same_name_exists" && rDup.body?.existing?.id === marcusId && !db.prepare(`SELECT 1 FROM retail_sellers WHERE organization_id = ? AND matricula = '10830006'`).get(A), JSON.stringify(rDup.body));
    const rForce = await call("PUT", "/sellers/10830006", A, { name: "Marcus Vinicius", allowSameName: true });
    check("4.4 allowSameName: cria de propósito (outra pessoa com o mesmo nome)", rForce.status === 200 && rForce.body?.matricula === "10830006");
    const rNew = await call("PUT", "/sellers/10650009", A, { name: "Ana Paula" });
    check("4.5 nome novo: salva normal", rNew.status === 200 && rNew.body?.name === "Ana Paula");
    const rRename = await call("PUT", "/sellers/10650009", A, { name: "Marcus Vinicius" });
    check("4.6 renomear quem já tem nome não é barrado (edição, não cadastro)", rRename.status === 200);
    const rOtherOrg = await call("PUT", "/sellers/X1", O, { name: "Marcus Vinicius" });
    check("4.7 nome igual em OUTRA org não conta como repetido", rOtherOrg.status === 200);
    const rMgr = await call("GET", `/sellers/code-candidates?storeId=${bangu}`, A, undefined, "agent");
    check("4.8 sem papel de dono/admin: recusado", rMgr.status === 403);
  } finally { server.close(); }

  // ── 5. Rótulos da tela (puros) ──
  check("5.1 parado: 46 dias sim, 45 não, sem data sim", labels.isStoppedCode("2026-09-19", ASOF) && !labels.isStoppedCode("2026-09-20", ASOF) && labels.isStoppedCode(null, ASOF));
  check("5.2 rótulo do candidato", labels.candidateLabel({ matricula: "10830005", sales: 7, lastSale: "2026-10-28" }) === "10830005 · 7 vendas · última 28/10" && labels.candidateLabel({ matricula: "X", sales: 1, lastSale: "2026-10-28" }).includes("1 venda ·"));
  check("5.3 pergunta do nome repetido cita a pessoa e o código", /Marcus.*10830002[\s\S]*10830006/.test(labels.sameNameQuestion({ name: "Marcus", matricula: "10830002" }, "10830006")));

  // ── 6. Fiação da tela ──
  const view = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
  check("6.1 cadastro não chama mais a 'próxima matrícula' (palpite)", !view.includes("/sellers/next-matricula"));
  check("6.2 cadastro lista os códigos reais da loja", view.includes("/api/retailops/sellers/code-candidates?storeId="));
  check("6.3 tela trata o 409 'same_name_exists' (liga o código ou cria de propósito)", view.includes("same_name_exists") && view.includes("allowSameName: true"));
  check("6.4 'Vendedores da loja' separa os códigos parados (mesma regra do cartão)", view.includes("setShowStoppedPend") && /pendActive = cov\.pendingName\.filter\(\(p: any\) => !isStoppedCode\(p\.lastSale, today\)\)/.test(view));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-seller-code-birth: ${passed}/${results.length} checks`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });
