/**
 * TESTE — PRD Fase 1, homologação: acabamentos achados na TOULON real (30/09/2026).
 * (1) valores no resumo do WhatsApp com separador de milhar ("R$ 1.426.635,58", não "R$ 1426635,58");
 * (2) manchete do estoque negativo na MESMA unidade ("796 com causa identificada · 9 sem causa provada" — antes
 *     "1 causa identificada · 9 sem causa provada" misturava tipos de causa com ocorrências);
 * (3) cartão "são a mesma pessoa?": não pergunta 3 vezes o mesmo assunto (EDUARDO × Eduardo × Eduardo Lázaro) e não
 *     deixa o dono confirmar "mesma pessoa" quando o nome curto bate com várias pessoas diferentes ("Vinicius" ×
 *     Vinicius Romão × MARCUS VINICIUS) — vira pergunta de "pessoas diferentes?", o lado seguro.
 * Uso:  npm run test:fase1-polish
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-polish-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-polish-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerDuplicateService: Dup } = await import("../src/server/RetailSellerDuplicateService.js");
  const { NegativeStockDiagnosisService: Neg } = await import("../src/server/NegativeStockDiagnosisService.js");
  const { BusinessTutorService: Tutor } = await import("../src/server/BusinessTutorService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);

  // ── (1) separador de milhar no resumo ──
  const { brl } = await import("../src/server/BusinessTutorService.js");
  check("R$ 1.426.635,58 (milhar pt-BR) — antes saía R$ 1426635,58", brl(1426635.58) === "R$ 1.426.635,58", brl(1426635.58));
  check("R$ 3.131,30 e R$ 5.700,00; abaixo de mil sem separador: R$ 999,99 e R$ 0,00", brl(3131.3) === "R$ 3.131,30" && brl(5700) === "R$ 5.700,00" && brl(999.99) === "R$ 999,99" && brl(0) === "R$ 0,00");
  check("negativo e valores inválidos: R$ -1.234,50 · null/NaN/'abc' viram R$ 0,00 (como antes)", brl(-1234.5) === "R$ -1.234,50" && brl(null) === "R$ 0,00" && brl(NaN) === "R$ 0,00" && brl("abc") === "R$ 0,00");
  void Tutor;

  // ── (2) manchete do estoque negativo ──
  const store = (name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, A, name, name.slice(0, 4)); return id; };
  const s1 = store("Grande Rio"), s2 = store("Carioca");
  const prod = () => { const id = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, name, price, type) VALUES (?, ?, ?, 10, 'product')`).run(id, A, "P" + id.slice(0, 4)); return id; };
  const neg = (st: string, pid: string) => db.prepare(`INSERT INTO retail_store_inventory (id, organization_id, store_id, product_service_id, quantity_available) VALUES (?, ?, ?, ?, -3)`).run(randomUUID(), A, st, pid);
  for (let i = 0; i < 4; i++) neg(i % 2 ? s1 : s2, prod());   // 4 produtos sem nenhuma entrada → causa identificada (no_entry_registered)
  const d = Neg.diagnose(A, {});
  check("manchete: 'N com causa identificada' conta OCORRÊNCIAS (4 de 4), não tipos de causa", d.total === 4 && /4 com causa identificada/.test(d.headline || "") && !/\d+ causas? identificadas?/.test(d.headline || ""), d.headline || "");
  check("manchete sem nenhuma causa provada continua dizendo isso", (() => { const B = `org_B_${randomUUID().slice(0, 6)}`; return Neg.diagnose(B, {}).headline === null; })());
  check("causeCount (tipos de causa) preservado no payload (compat)", d.causeCount === 1);

  // ── (3) cartão de vendedores ──
  const seller = (name: string, mat: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, A, mat, name); return id; };
  const edL = seller("Eduardo Lazaro", "1"), edU = seller("EDUARDO", "2"), edC = seller("Eduardo", "3");
  const vR = seller("Vinicius Romão", "4"), vN = seller("Vinicius Nascimento", "5"), vM = seller("MARCUS VINICIUS", "6"), vS = seller("Vinicius", "7");
  const sug = Dup.suggestions(A);
  const has = (x: string, y: string) => sug.find((s) => [s.a.id, s.b.id].includes(x) && [s.a.id, s.b.id].includes(y));
  check("Eduardo ×3: pergunta pelo nome completo (Lazaro × EDUARDO e Lazaro × Eduardo), sem o par redundante EDUARDO × Eduardo", !!has(edL, edU) && !!has(edL, edC) && !has(edU, edC), JSON.stringify(sug.map((s) => s.question)));
  check("...e esses dois continuam 'likely' (mesma pessoa provável) — só há um nome completo possível", has(edL, edU)?.kind === "likely" && has(edL, edC)?.kind === "likely");
  check("'Vinicius' bate com 3 pessoas diferentes: NÃO é 'likely' (não deixa confirmar 'mesma pessoa' no chute)", [vR, vN, vM].every((o) => has(vS, o)?.kind === "check"), JSON.stringify(sug.filter((s) => [s.a.id, s.b.id].includes(vS)).map((s) => s.kind)));
  check("...e a pergunta é pelo lado seguro ('pessoas diferentes?') e diz que o nome curto pode ser mais de uma pessoa", /pode ser mais de uma pessoa/.test(has(vS, vM)?.question || "") && /pessoas diferentes/.test(has(vS, vM)?.question || ""));
  check("Vinicius Romão × Nascimento = diferentes por construção (S1): não é sugerido nem fundido", !has(vR, vN));
  // nome curto que cabe em UMA só pessoa continua 'likely' (0-regressão)
  const O = `org_O_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), O);
  const sO = (n: string, m: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, O, m, n); return id; };
  const lo = sO("Lohan", "1"), lg = sO("Lohan Grande Rio", "2");
  const sO1 = Dup.suggestions(O);
  check("nome curto que cabe em uma só pessoa segue 'likely' (Lohan × Lohan Grande Rio)", sO1.length === 1 && sO1[0].kind === "likely" && sO1[0].suggestedIntoId === lg && [sO1[0].a.id, sO1[0].b.id].includes(lo));
  check("isolamento: a org O não enxerga os vendedores da A", sO1.every((s) => ![s.a.id, s.b.id].some((i) => ([edL, edU, edC, vR, vN, vM, vS] as string[]).includes(i))));

  console.log("\n=== PRD Fase 1 · homologação: acabamentos ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
