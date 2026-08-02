/**
 * TESTE — Boletas em tempo real (ADR-083 Fase C3).
 * ---------------------------------------------------------------------------
 * O talão manuscrito sequencial continua no papel; o app devolve a HORA real
 * de cada venda. Prova:
 *   - abrir o dia com o nº inicial (formato com zeros preservado);
 *   - clique gera o próximo nº da sequência com timestamp DO SERVIDOR;
 *   - clique sem dia aberto é rejeitado;
 *   - nº inicial só muda enquanto não há clique ativo;
 *   - desfazer: SÓ o último clique, vira 'cancelled' (nunca DELETE) e o
 *     número volta pra sequência;
 *   - match derivado com o PDV por (filial, nº sem zeros, data): valor,
 *     peças e vendedor de cada boleta clicada (após lançamento noturno);
 *   - conferência do fechamento: range da folha × cliques (gap como flag no
 *     derived do submitDetailed, nunca bloqueio);
 *   - audit + isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-boletas
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-boletas-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-boletas-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailBoletaService } = await import("../src/server/RetailBoletaService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const loja = RetailStoreService.create(A, { name: "Nova Iguaçu", code: "2" });
  const DAY = "2026-08-03";

  // ── Clique sem dia aberto ─────────────────────────────────────────────────
  let threw = false;
  try { RetailBoletaService.click(A, loja.id, DAY, {}, "tester"); } catch { threw = true; }
  check("Clique sem dia aberto é rejeitado", threw);

  // ── Abrir o dia + sequência ───────────────────────────────────────────────
  const day = RetailBoletaService.openDay(A, loja.id, DAY, "017752", "gerente");
  check("Dia aberto com nº inicial preservando zeros", day.initial_number === "017752");
  check("Próximo número = o inicial antes do 1º clique", RetailBoletaService.nextNumber(A, loja.id, DAY) === "017752");

  const e1 = RetailBoletaService.click(A, loja.id, DAY, { sellerName: "Rafaela" }, "vendedor1");
  const e2 = RetailBoletaService.click(A, loja.id, DAY, {}, "vendedor1");
  const e3 = RetailBoletaService.click(A, loja.id, DAY, {}, "gerente");
  check("Cliques geram a sequência 017752/017753/017754", e1.boleta_number === "017752" && e2.boleta_number === "017753" && e3.boleta_number === "017754", `${e1.boleta_number},${e2.boleta_number},${e3.boleta_number}`);
  check("Timestamp do servidor gravado no clique", !!e1.clicked_at && String(e1.clicked_at).length >= 19, `at=${e1.clicked_at}`);
  check("Vendedor opcional no clique", e1.seller_name === "Rafaela" && e2.seller_name == null);
  check("Próximo número avança (017755)", RetailBoletaService.nextNumber(A, loja.id, DAY) === "017755");

  // Nº inicial não muda com cliques ativos; reabrir com o MESMO nº é ok.
  threw = false;
  try { RetailBoletaService.openDay(A, loja.id, DAY, "020000", "gerente"); } catch { threw = true; }
  check("Nº inicial não muda depois de cliques ativos", threw);
  const same = RetailBoletaService.openDay(A, loja.id, DAY, "017752", "gerente");
  check("Reabrir com o mesmo nº inicial é idempotente", same.initial_number === "017752");

  // ── Desfazer (só o último; nunca DELETE) ──────────────────────────────────
  threw = false;
  try { RetailBoletaService.cancelClick(A, e2.id, "gerente"); } catch { threw = true; }
  check("Cancelar clique do MEIO é rejeitado (sequência não fura)", threw);
  const cancelled = RetailBoletaService.cancelClick(A, e3.id, "gerente");
  check("Último clique cancelado vira status='cancelled' (não DELETE)", cancelled.status === "cancelled" && cancelled.cancelled_at != null);
  const rows = db.prepare(`SELECT COUNT(*) n FROM retail_boleta_events WHERE organization_id = ? AND day = ?`).get(A, DAY) as any;
  check("Linha cancelada continua no banco (retenção)", Number(rows.n) === 3);
  check("Número cancelado volta pra sequência (próximo = 017754)", RetailBoletaService.nextNumber(A, loja.id, DAY) === "017754");
  const e4 = RetailBoletaService.click(A, loja.id, DAY, {}, "vendedor2");
  check("Novo clique reusa o número liberado (017754)", e4.boleta_number === "017754");

  // ── Match derivado com o PDV ──────────────────────────────────────────────
  // O lançamento noturno + sync traz as vendas com o nº da boleta. O PDV grava
  // sem zeros à esquerda ("17752") — o match normaliza.
  const pdv = db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, usuario, vendedor_codigo, valor, pecas, status) VALUES (?, ?, ?, ?, ?, 'OP1', 'OP1', ?, ?, ?, 'N')`);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'R1', 'Rafaela')`).run(randomUUID(), A);
  pdv.run(randomUUID(), A, "2", "17752", DAY, "R1", 269.9, 2);
  pdv.run(randomUUID(), A, "2", "017753", DAY, "R1", 89.9, 1);
  // boleta 017754 ainda sem PDV (aguardando lançamento).
  const report = RetailBoletaService.dayReport(A, loja.id, DAY);
  check("Relatório: 3 cliques ativos + 1 cancelado", report.count === 3 && report.cancelledCount === 1);
  const c752 = report.clicks.find((c: any) => c.number === "017752");
  check("Match PDV normaliza zeros ('17752' ≡ '017752') com valor e vendedor", c752?.pdv?.valor === 269.9 && c752?.pdv?.sellerName === "Rafaela", JSON.stringify(c752?.pdv));
  check("Boleta sem PDV fica 'aguardando' (pdv null)", report.clicks.find((c: any) => c.number === "017754")?.pdv == null);
  check("Resumo do match: 2 casadas, 1 aguardando, R$ 359,80", report.pdvMatch.matched === 2 && report.pdvMatch.unmatched === 1 && report.pdvMatch.valorTotal === 359.8, JSON.stringify(report.pdvMatch));
  check("Cliques agrupados por hora (byHourUtc)", Array.isArray(report.byHourUtc) && report.byHourUtc.reduce((a: number, h: any) => a + h.count, 0) === 3);

  // ── Conferência no fechamento (submitDetailed.derived.boleta) ─────────────
  const closingOk = RetailClosingService.submitDetailed(A, loja.id, DAY, {
    dinheiro: 400, credito: { Visa: 100 },
    boletaInicial: "017752", boletaFinal: "017754",
  }, {}, "gerente");
  const detOk = JSON.parse(closingOk.details_json);
  check("Fechamento: range 3 × 3 cliques → gap 0", detOk.derived.boleta?.clicks === 3 && detOk.derived.boleta?.rangeCount === 3 && detOk.derived.boleta?.gap === 0, JSON.stringify(detOk.derived.boleta));
  const closingGap = RetailClosingService.submitDetailed(A, loja.id, DAY, {
    dinheiro: 400,
    boletaInicial: "017752", boletaFinal: "017756",
  }, {}, "gerente");
  const detGap = JSON.parse(closingGap.details_json);
  check("Range maior que cliques → gap 2 como FLAG (não bloqueia)", detGap.derived.boleta?.gap === 2 && closingGap.status === "received", JSON.stringify(detGap.derived.boleta));

  // ── Audit ─────────────────────────────────────────────────────────────────
  const audit = db.prepare(`SELECT DISTINCT event_type FROM auth_audit_logs WHERE organization_id = ?`).all(A) as any[];
  const has = (t: string) => audit.some((a) => a.event_type === t);
  check("Audit: abertura, clique e cancelamento auditados", has("RETAIL_BOLETA_DAY_OPENED") && has("RETAIL_BOLETA_CLICKED") && has("RETAIL_BOLETA_CANCELLED"), JSON.stringify(audit.map((a) => a.event_type)));

  // ── Isolamento multi-tenant ───────────────────────────────────────────────
  check("Org B não vê o dia da org A", RetailBoletaService.getDay(B, loja.id, DAY) == null);
  const repB = RetailBoletaService.dayReport(B, loja.id, DAY);
  check("Org B não vê cliques da org A", repB.count === 0 && repB.initialNumber == null);
  threw = false;
  try { RetailBoletaService.cancelClick(B, e4.id, "x"); } catch { threw = true; }
  check("Org B não cancela clique da org A", threw);

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
