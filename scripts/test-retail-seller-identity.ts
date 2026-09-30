/**
 * TESTE — PRD Fase 1, F1.1a: identidade única de vendedor (aliases + fusão + alocação por período)
 * Casos reais confirmados: Eduardo Lázaro/EDUARDO (mesma pessoa), Lohan Grande Rio/LOHAN (mesma
 * pessoa → fundir), Vinícius Romão ≠ Vinícius Nascimento (NUNCA unir), matrícula sem nome →
 * "Vendedor não identificado — matrícula X", vender em outra loja não cria outro vendedor.
 * Uso:  npm run test:retail-seller-identity
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-identity-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-seller-identity-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const throws = (fn: () => any, re: RegExp) => { try { fn(); return false; } catch (e: any) { return re.test(e.message); } };

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerIdentityService: S, normalizeAlias } = await import("../src/server/RetailSellerIdentityService.js");
  const { RetailSellerDirectoryService: D } = await import("../src/server/RetailSellerDirectoryService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const seller = (org: string, mat: string, name: string | null, userId: string | null = null) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id) VALUES (?, ?, ?, ?, ?)`).run(id, org, mat, name, userId); return id; };
  const avBrasil = store(A, "Avenida Brasil", "1001"), carioca = store(A, "Carioca", "1002"), bangu = store(A, "Bangu", "1003");

  const eduardo = seller(A, "1001-EL", "Eduardo Lázaro");
  const vRomao = seller(A, "1001-VR", "Vinícius Romão");
  const vNasc = seller(A, "1003-VN", "Vinícius Nascimento");
  const lohanA = seller(A, "1002-LG", "Lohan Grande Rio");
  const lohanB = seller(A, "1002-LX", "LOHAN");
  const cnt = () => (db.prepare(`SELECT COUNT(*) AS n FROM retail_sellers WHERE organization_id = ?`).get(A) as any).n;

  // ── normalização e resolução exata ──
  check("normaliza acento/caixa/espaços", normalizeAlias("  Eduardo   LÁZARO ") === "eduardo lazaro");
  const r1 = S.resolve(A, { name: "Eduardo Lazaro" });
  check("Eduardo Lazaro (sem acento) resolve o mesmo Eduardo Lázaro", r1.status === "identified" && r1.seller?.id === eduardo && r1.via === "name");
  check("'EDUARDO' sozinho NÃO é inferido — não identificado até alguém confirmar", S.resolve(A, { name: "EDUARDO" }).status === "unidentified");
  const al = S.addAlias(A, eduardo, { alias: "EDUARDO", kind: "name" }, "u-owner");
  check("confirmar o alias 'EDUARDO' (gesto humano) → passa a identificar", al.deduped === false && S.resolve(A, { name: "eduardo" }).seller?.id === eduardo && S.resolve(A, { name: "eduardo" }).via === "alias");
  check("alias repetido é idempotente", S.addAlias(A, eduardo, { alias: "Eduardo" }).deduped === true);

  // ── Vinícius Romão ≠ Vinícius Nascimento ──
  check("Vinícius Romão e Vinícius Nascimento resolvem para pessoas DIFERENTES", S.resolve(A, { name: "Vinícius Romão" }).seller?.id === vRomao && S.resolve(A, { name: "Vinicius Nascimento" }).seller?.id === vNasc);
  check("'Vinícius' (primeiro nome) NÃO resolve nenhum dos dois", S.resolve(A, { name: "Vinícius" }).status === "unidentified");
  check("alias que é a identidade OFICIAL de outro é conflito (não rouba)", throws(() => S.addAlias(A, vRomao, { alias: "Vinícius Nascimento" }), /alias_conflict/));
  check("alias já de OUTRO vendedor é conflito", throws(() => S.addAlias(A, vRomao, { alias: "EDUARDO" }), /alias_conflict/));
  check("fundir Vinícius Romão em Nascimento é possível só por gesto explícito; sem isso seguem 2 pessoas", cnt() === 5);

  // ── matrícula sem identificação ──
  const un = S.resolve(A, { matricula: "99999" });
  check("matrícula desconhecida → não identificada (nunca inventa)", un.status === "unidentified" && un.seller === null);
  check("displayName de matrícula sem pessoa = 'Vendedor não identificado — matrícula X'", S.displayName(A, "99999") === "Vendedor não identificado — matrícula 99999");
  const noName = seller(A, "88888", null);
  check("matrícula existente mas SEM nome também não vira nome inventado", S.displayName(A, "88888") === "Vendedor não identificado — matrícula 88888");
  const insSale = db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status, vendedor_codigo) VALUES (?, ?, '1002', ?, '2026-09-10', 100, 1, 'N', ?)`);
  insSale.run(randomUUID(), A, "b1", "99999"); insSale.run(randomUUID(), A, "b2", "99999"); insSale.run(randomUUID(), A, "b3", "88888"); insSale.run(randomUUID(), A, "b4", "1001-EL");
  const pend = S.unidentified(A);
  check("unidentified lista as matrículas sem pessoa (99999, 88888) e NÃO a do Eduardo", pend.map((p: any) => p.matricula).sort().join() === "88888,99999" && pend.find((p: any) => p.matricula === "99999")?.sales === 2);
  check("alias de matrícula (CAI_USUARIO) identifica quando confirmado", (() => { S.addAlias(A, eduardo, { alias: "CAI-EDU-7", kind: "cai_usuario" }); return S.resolve(A, { matricula: "cai-edu-7" }).seller?.id === eduardo; })());

  // ── Lohan: fusão governada ──
  D.setStores(A, lohanA, [carioca], carioca);
  D.setStores(A, lohanB, [carioca, bangu], bangu);
  check("antes da fusão: 'LOHAN' e 'Lohan Grande Rio' são identidades distintas", S.resolve(A, { name: "LOHAN" }).seller?.id === lohanB && S.resolve(A, { matricula: "1002-LG" }).seller?.id === lohanA);
  check("não funde consigo mesmo / inexistente", throws(() => S.mergeSellers(A, lohanA, lohanA), /nele mesmo/) && throws(() => S.mergeSellers(A, lohanA, randomUUID()), /não encontrado/));
  const uA = seller(A, "U1", "User A", "user-a"), uB = seller(A, "U2", "User B", "user-b");
  check("usuários diferentes → user_conflict (não decide sozinho)", throws(() => S.mergeSellers(A, uA, uB), /user_conflict/));
  const m = S.mergeSellers(A, lohanB, lohanA, "u-owner");
  check("fusão: LOHAN (1002-LX) passa a resolver para Lohan Grande Rio", m.merged && S.resolve(A, { matricula: "1002-LX" }).seller?.id === lohanA && S.resolve(A, { name: "LOHAN" }).seller?.id === lohanA);
  check("fusão: canonicalMatricula da fundida = matrícula da canônica; sem mapeamento devolve a própria", S.canonicalMatricula(A, "1002-LX") === "1002-LG" && S.canonicalMatricula(A, "1002-LG") === "1002-LG" && S.canonicalMatricula(A, "zzz") === "zzz");
  const rowB = db.prepare(`SELECT active, merged_into_seller_id FROM retail_sellers WHERE id = ?`).get(lohanB) as any;
  check("fusão NÃO apaga: identidade fundida fica inativa com merged_into (retenção)", cnt() >= 8 && rowB.active === 0 && rowB.merged_into_seller_id === lohanA);
  const lohanStores = D.storesForSeller(A, lohanA).map((s: any) => s.store_id).sort();
  check("fusão: lotações movidas sem duplicar a loja (Carioca 1x + Bangu)", lohanStores.length === 2 && lohanStores.includes(carioca) && lohanStores.includes(bangu));
  check("fusão: não fundir 2x nem para um já fundido", throws(() => S.mergeSellers(A, lohanB, lohanA), /já foi fundido/) && throws(() => S.mergeSellers(A, lohanA, lohanB), /já foi fundido/));
  check("alias em identidade fundida é recusado (use a canônica)", throws(() => S.addAlias(A, lohanB, { alias: "outro" }), /seller_merged/));
  const un2 = S.unmerge(A, lohanB, "u-owner");
  const rowB2 = db.prepare(`SELECT active, merged_into_seller_id FROM retail_sellers WHERE id = ?`).get(lohanB) as any;
  check("desfazer fusão: reativa e volta a resolver como pessoa própria", un2.unmerged && rowB2.active === 1 && rowB2.merged_into_seller_id === null && S.resolve(A, { matricula: "1002-LX" }).seller?.id === lohanB && S.resolve(A, { name: "LOHAN" }).seller?.id === lohanB);
  check("unmerge de quem não está fundido é recusado", throws(() => S.unmerge(A, lohanB), /não está fundido/));
  // colisão com TERCEIRO na fusão
  const t1 = seller(A, "T1", "Tercio"), t2 = seller(A, "T2", "Tercio Outro"), t3 = seller(A, "T3", "Terceiro");
  // estado legado: um TERCEIRO já tinha o nome de t2 como alias (addAlias hoje bloquearia isso; simulado direto)
  db.prepare(`INSERT INTO retail_seller_aliases (id, organization_id, seller_id, alias, alias_norm, kind, source) VALUES (?, ?, ?, 'Tercio Outro', 'tercio outro', 'name', 'manual')`).run(randomUUID(), A, t3);
  check("fusão com alias colidindo com TERCEIRO é recusada antes de escrever", throws(() => S.mergeSellers(A, t2, t1), /alias_conflict/) && (db.prepare(`SELECT merged_into_seller_id m FROM retail_sellers WHERE id = ?`).get(t2) as any).m === null);

  // ── alocação por tipo e período ──
  D.setStores(A, eduardo, [avBrasil], avBrasil);
  const before = cnt();
  const tmp = S.addAssignment(A, { sellerId: eduardo, storeId: carioca, type: "temporaria", startDate: "2026-09-10", endDate: "2026-09-15" }, "u-owner");
  check("temporária no Carioca NÃO cria outro vendedor (mesma identidade)", cnt() === before && tmp.type === "temporaria");
  check("dentro do período: loja = Carioca (cobertura vence a principal)", S.storeOn(A, eduardo, "2026-09-12")?.storeId === carioca && S.storeOn(A, eduardo, "2026-09-12")?.type === "temporaria");
  check("fora do período: volta à loja-base Avenida Brasil", S.storeOn(A, eduardo, "2026-09-20")?.storeId === avBrasil && S.storeOn(A, eduardo, "2026-09-09")?.storeId === avBrasil);
  check("assignmentsOn no período mostra as DUAS lojas (base + cobertura)", S.assignmentsOn(A, eduardo, "2026-09-12").length === 2);
  check("período é inclusivo nas duas pontas", S.storeOn(A, eduardo, "2026-09-10")?.storeId === carioca && S.storeOn(A, eduardo, "2026-09-15")?.storeId === carioca);
  check("temporária NÃO entra no roster legado da loja (Atendimento de Loja segue igual)", !D.sellersForStore(A, carioca).some((r: any) => r.seller_id === eduardo));
  check("temporária exige janela válida", throws(() => S.addAssignment(A, { sellerId: eduardo, storeId: carioca, type: "cobertura_ferias", startDate: "2026-10-01" }), /endDate é obrigatória/) && throws(() => S.addAssignment(A, { sellerId: eduardo, storeId: carioca, type: "temporaria", startDate: "2026-10-05", endDate: "2026-10-01" }), /anterior/));
  check("type/loja/vendedor inválidos recusados", throws(() => S.addAssignment(A, { sellerId: eduardo, storeId: carioca, type: "x" as any, startDate: "2026-10-01", endDate: "2026-10-02" }), /type inválido/) && throws(() => S.addAssignment(A, { sellerId: eduardo, storeId: randomUUID(), type: "temporaria", startDate: "2026-10-01", endDate: "2026-10-02" }), /Loja não encontrada/) && throws(() => S.addAssignment(A, { sellerId: randomUUID(), storeId: carioca, type: "temporaria", startDate: "2026-10-01", endDate: "2026-10-02" }), /Vendedor não encontrado/));
  // gestor reconciliando a equipe do Carioca não pode "promover" o período temporário a lotação
  D.setStoreSellers(A, carioca, [eduardo], "u-owner");
  const rows = db.prepare(`SELECT assignment_type, active FROM retail_seller_store_assignments WHERE organization_id = ? AND seller_id = ? AND store_id = ?`).all(A, eduardo, carioca) as any[];
  check("setStoreSellers cria lotação NOVA e não reativa o período temporário", rows.filter((r) => r.active === 1).length === 1 && rows.some((r) => r.assignment_type === "temporaria" && r.active === 0));
  // transferência definitiva
  const today = new Date().toISOString().slice(0, 10);
  check("transferência definitiva com data futura é recusada", throws(() => S.addAssignment(A, { sellerId: vNasc, storeId: bangu, type: "transferencia_definitiva", startDate: "2099-01-01" }), /aplica hoje/));
  D.setStores(A, vNasc, [bangu], bangu);
  S.addAssignment(A, { sellerId: vNasc, storeId: carioca, type: "transferencia_definitiva", startDate: today }, "u-owner");
  check("transferência definitiva: encerra a antiga e cria a nova principal (roster legado enxerga)", D.sellersForStore(A, carioca).some((r: any) => r.seller_id === vNasc && r.is_primary === 1) && !D.sellersForStore(A, bangu).some((r: any) => r.seller_id === vNasc));
  check("transferência: no dia da mudança já é a loja nova; antes era a antiga", S.storeOn(A, vNasc, today)?.storeId === carioca && S.storeOn(A, vNasc, "2020-01-01")?.storeId === bangu);
  check("sem alocação nenhuma → storeOn null (não inventa loja)", S.storeOn(A, noName, "2026-09-12") === null);

  // ── isolamento multi-tenant ──
  const bSeller = seller(B, "1001-EL", "Eduardo Lázaro");
  check("isolamento: org B não enxerga aliases/identidades da A", S.resolve(B, { name: "EDUARDO" }).status === "unidentified" && S.resolve(B, { name: "Eduardo Lazaro" }).seller?.id === bSeller);
  check("isolamento: não dá pra aliasar/fundir/alocar vendedor de outra org", throws(() => S.addAlias(B, eduardo, { alias: "x1" }), /não encontrado/) && throws(() => S.mergeSellers(B, eduardo, bSeller), /não encontrado/) && throws(() => S.addAssignment(B, { sellerId: eduardo, storeId: carioca, type: "temporaria", startDate: "2026-09-01", endDate: "2026-09-02" }), /não encontrad/));
  check("isolamento: mesmo alias em orgs diferentes coexistem", S.addAlias(B, bSeller, { alias: "EDUARDO" }).deduped === false);
  check("removeAlias remove e é isolado por org", S.removeAlias(B, al.id) === false && S.removeAlias(A, al.id) === true && S.resolve(A, { name: "EDUARDO" }).status === "unidentified");

  console.log("\n=== PRD Fase 1 · F1.1a: identidade única de vendedor ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
