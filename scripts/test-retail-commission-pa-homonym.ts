/**
 * TESTE — P.A de HOMÔNIMOS na mesma loja (detectar + sinalizar).
 * ----------------------------------------------------------------------------
 * Achado secundário da auditoria de comissão: o denominador de P.A (atendimentos)
 * é lido por alias com `max`, e o alias `nom:<nome>` acumula a soma de todas as
 * fontes (necessário pra reconciliar a MESMA pessoa entre manual/floor). Efeito
 * colateral: dois vendedores DISTINTOS com nome normalizado idêntico na MESMA
 * loja compartilham o bucket `nom:` → o P.A de cada um fica não-confiável.
 *
 * Como não dá pra decidir de quem é cada atendimento (indecidível pelos dados),
 * a correção NÃO silencia nem paga número duvidoso: MARCA a linha (`paAmbiguous`)
 * e expõe a colisão (`paAmbiguities`) pro gestor desambiguar. Nada muda no caso
 * normal (nomes distintos) → 0 ruído.
 *
 * Uso:  npm run test:retail-commission-pa-homonym
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pa-homonym-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pa-homonym-1";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionRaceService } = await import("../src/server/RetailCommissionRaceService.js");

  const MONTH = "2026-08";
  const D = (day: string) => `2026-08-${day}`;
  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'T', 'active')`).run(randomUUID(), id);
  const mkStore = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, org, name); return id; };
  const mkSale = (org: string, storeId: string, name: string, matricula: string, valor: number, pecas: number, atend: number, day: string) => {
    db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas, atendimentos, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`)
      .run(randomUUID(), org, storeId, D(day), name, matricula, valor, pecas, atend);
  };

  // ── Org A, Loja S: DUAS "Maria" com matrículas diferentes (homônimas) + 1 João ──
  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const S = mkStore(A, "Loja Sul");
  mkSale(A, S, "Maria", "M1", 30000, 60, 20, "10");
  mkSale(A, S, "Maria", "M2", 20000, 40, 15, "11");
  mkSale(A, S, "João", "M3", 25000, 50, 18, "12");

  const race = RetailCommissionRaceService.raceMonth(A, MONTH);
  const store = (race.stores || []).find((s: any) => s.storeId === S);
  const marias = (store?.monthly || []).filter((s: any) => /maria/i.test(s.sellerName));
  const joao = (store?.monthly || []).find((s: any) => /jo[ãa]o/i.test(s.sellerName));

  // ── 1. a(s) linha(s) "Maria" do mês são MARCADAS como ambíguas ──
  // (o roster funde homônimas por compartilharem o alias nom: — por isso a
  // detecção é nas linhas de ORIGEM; aqui garantimos que a linha resultante
  // fica sinalizada, nunca um número silenciosamente errado.)
  check("1.1 há linha Maria no mês", marias.length >= 1, `n=${marias.length}`);
  check("1.2 toda linha Maria marcada paAmbiguous", marias.length >= 1 && marias.every((m: any) => m.paAmbiguous === true));
  check("1.3 João (nome distinto) NÃO é marcado", !!joao && !joao.paAmbiguous);

  // ── 2. colisão exposta no resumo transversal ──
  check("2.1 paAmbiguityCount >= 1", race.paAmbiguityCount >= 1, `count=${race.paAmbiguityCount}`);
  const grp = (race.paAmbiguities || []).find((s: any) => s.storeId === S);
  check("2.2 loja aparece em paAmbiguities", !!grp);
  const first = grp?.groups?.[0];
  check("2.3 grupo lista as 2 matrículas distintas do mesmo nome", !!first && first.sellers.length === 2 && new Set(first.sellers.map((x: any) => x.matricula)).size === 2, JSON.stringify(first));

  // ── 3. 0-regressão: loja só com nomes distintos → nada marcado ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const SB = mkStore(B, "Loja B");
  mkSale(B, SB, "Ana", "N1", 10000, 20, 8, "10");
  mkSale(B, SB, "Bia", "N2", 12000, 24, 9, "10");
  const raceB = RetailCommissionRaceService.raceMonth(B, MONTH);
  check("3.1 nomes distintos → paAmbiguityCount 0", raceB.paAmbiguityCount === 0);
  check("3.2 nomes distintos → nenhum seller marcado", ((raceB.stores || []).flatMap((s: any) => s.monthly || [])).every((m: any) => !m.paAmbiguous));

  // ── 4. isolamento ──
  check("4.1 A não vaza colisão pra B", (raceB.paAmbiguities || []).every((s: any) => s.storeId !== S));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name} ${x.detail ? `(${x.detail})` : ""}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} retail-commission-pa-homonym: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
