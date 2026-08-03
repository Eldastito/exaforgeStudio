/**
 * TEST — FalaTu Fatia 4 (ADR-151): compras com conferência.
 *
 * Cobre: matching determinístico (acento, prefixo, sem-match, 1:1 guloso);
 * check() registra conferência PENDENTE com snapshot da nota sem tocar a
 * lista (RN-151: nada marcado antes do confirm humano); consumo contado no
 * ai_interactions_log e teto do plano respeitado; confirm marca só os
 * pareados ESCOLHIDOS; extra da nota só entra na lista com opt-in explícito;
 * item já comprado não re-casa; discard é UPDATE (nunca DELETE); re-resolver
 * falha; lista de outro usuário/org invisível; auditoria.
 *
 * Mocka FalaTuPurchaseService.readInvoice (sem chave OpenAI) — o resto real.
 *
 * Uso: npm run test:falatu-compras
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-f4-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-compras-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuPurchaseService } = await import("../src/server/FalaTuPurchaseService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);

  const mkList = (org: string, user: string, title: string, items: string[]) => {
    const listId = randomUUID();
    db.prepare(`INSERT INTO falatu_lists (id, organization_id, user_id, title, list_type) VALUES (?, ?, ?, ?, 'shopping')`).run(listId, org, user, title);
    const ins = db.prepare(`INSERT INTO falatu_list_items (id, organization_id, list_id, name) VALUES (?, ?, ?, ?)`);
    const ids = items.map((n) => { const id = randomUUID(); ins.run(id, org, listId, n); return id; });
    return { listId, itemIds: ids };
  };

  // ===== 1. matchItems puro: acento, prefixo, guloso 1:1, sem-match =====
  const m1 = FalaTuPurchaseService.matchItems(
    [{ id: "a", name: "Café" }, { id: "b", name: "feijão" }, { id: "c", name: "sabão em pó" }, { id: "d", name: "picanha" }],
    [
      { name: "CAFE PILAO 500G", quantity: 2, unit: "un", unitCost: 18.9, confidence: 95 },
      { name: "FEIJAO CARIOCA T1 1KG", quantity: 1, unit: "un", unitCost: 8.5, confidence: 90 },
      { name: "REFRIGERANTE COLA 2L", quantity: 6, unit: "un", unitCost: 9.99, confidence: 88 },
    ]
  );
  check("acento/caixa não atrapalham (café ↔ CAFE)", m1.matched.some((m) => m.listItemId === "a" && m.invoiceName.includes("CAFE")));
  check("prefixo casa (feijão ↔ FEIJAO CARIOCA)", m1.matched.some((m) => m.listItemId === "b"));
  check("não pareados da lista viram missing", m1.missing.map((x) => x.listItemId).sort().join(",") === "c,d");
  check("item da nota fora da lista vira extra", m1.extras.length === 1 && m1.extras[0].name.includes("REFRIGERANTE"));

  // Guloso 1:1: dois itens parecidos não roubam o mesmo da nota.
  const m2 = FalaTuPurchaseService.matchItems(
    [{ id: "x", name: "leite" }, { id: "y", name: "leite condensado" }],
    [
      { name: "LEITE CONDENSADO 395G", quantity: 1, unit: "un", unitCost: 6.5, confidence: 92 },
      { name: "LEITE INTEGRAL 1L", quantity: 12, unit: "un", unitCost: 4.99, confidence: 93 },
    ]
  );
  const yMatch = m2.matched.find((m) => m.listItemId === "y");
  check("melhor score vence (leite condensado ↔ CONDENSADO)", !!yMatch && yMatch.invoiceName.includes("CONDENSADO") && m2.matched.length === 2);

  // ===== 2. check() cria conferência pendente SEM tocar a lista =====
  const { listId, itemIds } = mkList(orgA, userA, "Mercado", ["café", "feijão", "picanha"]);
  (FalaTuPurchaseService as any).readInvoice = async () => ({
    supplierName: "Atacadão",
    items: [
      { name: "CAFE PILAO 500G", quantity: 2, unit: "un", unitCost: 18.9, confidence: 95 },
      { name: "FEIJAO CARIOCA 1KG", quantity: 1, unit: "un", unitCost: 8.5, confidence: 90 },
      { name: "CHOCOLATE AO LEITE", quantity: 3, unit: "un", unitCost: 7.0, confidence: 85 },
    ],
    confidence: 90,
  });
  const img = { mimeType: "image/jpeg", data: "Zm9vYmFy" };
  const chk = await FalaTuPurchaseService.check(orgA, userA, listId, img);
  check("conferência registrada como pendente", chk?.status === "pending" && chk?.supplier_name === "Atacadão");
  const matching = JSON.parse(chk.matching_json);
  check("matching: 2 pareados, 1 faltante, 1 extra", matching.matched.length === 2 && matching.missing.length === 1 && matching.extras.length === 1);
  const realizedNow = (db.prepare(`SELECT COUNT(*) c FROM falatu_list_items WHERE list_id = ? AND realized = 1`).get(listId) as any).c;
  check("NADA marcado na lista antes do confirm (RN-151)", realizedNow === 0);
  const aiCount = (db.prepare(`SELECT COUNT(*) c FROM ai_interactions_log WHERE organization_id = ? AND agent_used = 'falatu'`).get(orgA) as any).c;
  check("leitura da nota conta como ação de IA", aiCount === 1);
  const audit = (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FALATU_PURCHASE_CHECK'`).get(orgA) as any).c;
  check("auditoria FALATU_PURCHASE_CHECK", audit === 1);
  check("latestForList devolve a pendente", FalaTuPurchaseService.latestForList(orgA, userA, listId)?.id === chk.id);

  // ===== 3. confirm com SUBCONJUNTO: só o escolhido marca; extra só com opt-in =====
  const cafeId = itemIds[0];
  const conf = FalaTuPurchaseService.confirm(orgA, userA, chk.id, { listItemIds: [cafeId], addExtras: [] });
  check("confirm marca só o item escolhido", conf.realized === 1 && conf.added === 0);
  const cafe = db.prepare(`SELECT realized FROM falatu_list_items WHERE id = ?`).get(cafeId) as any;
  const feijao = db.prepare(`SELECT realized FROM falatu_list_items WHERE id = ?`).get(itemIds[1]) as any;
  check("café comprado, feijão segue pendente", cafe?.realized === 1 && feijao?.realized === 0);
  const totalItems = (db.prepare(`SELECT COUNT(*) c FROM falatu_list_items WHERE list_id = ?`).get(listId) as any).c;
  check("extra sem opt-in NÃO entra na lista (RN-151)", totalItems === 3);
  check("conferência resolvida", conf.check?.status === "confirmed");
  let threw = false;
  try { FalaTuPurchaseService.confirm(orgA, userA, chk.id, {}); } catch { threw = true; }
  check("re-confirm recusado (já resolvida)", threw);

  // ===== 4. Novo check: item já comprado não re-casa; extra com opt-in entra =====
  const chk2 = await FalaTuPurchaseService.check(orgA, userA, listId, img);
  const matching2 = JSON.parse(chk2.matching_json);
  check("item já comprado (café) fica fora do novo matching", !matching2.matched.some((m: any) => m.listItemId === cafeId) && !matching2.missing.some((m: any) => m.listItemId === cafeId));
  const extraIdx = matching2.extras.find((x: any) => x.name.includes("CHOCOLATE"))?.invoiceIndex;
  const conf2 = FalaTuPurchaseService.confirm(orgA, userA, chk2.id, { addExtras: [extraIdx] });
  check("extra com opt-in entra como comprado", conf2.added === 1);
  const choc = db.prepare(`SELECT * FROM falatu_list_items WHERE list_id = ? AND name LIKE 'CHOCOLATE%'`).get(listId) as any;
  check("extra gravado com quantidade e realized=1", choc?.realized === 1 && choc?.planned === 0 && choc?.quantity === "3 un");

  // ===== 5. discard é UPDATE de status =====
  const chk3 = await FalaTuPurchaseService.check(orgA, userA, listId, img);
  FalaTuPurchaseService.discard(orgA, userA, chk3.id);
  const st3 = db.prepare(`SELECT status FROM falatu_purchase_checks WHERE id = ?`).get(chk3.id) as any;
  const allChecks = (db.prepare(`SELECT COUNT(*) c FROM falatu_purchase_checks WHERE organization_id = ?`).get(orgA) as any).c;
  check("discard vira status='discarded' (nunca DELETE)", st3?.status === "discarded" && allChecks === 3);

  // ===== 6. Nota ilegível (0 itens) → recusa clara, sem registro =====
  (FalaTuPurchaseService as any).readInvoice = async () => ({ supplierName: null, items: [], confidence: 10 });
  threw = false;
  try { await FalaTuPurchaseService.check(orgA, userA, listId, img); } catch (e: any) { threw = /nítida/.test(e.message); }
  check("nota sem itens legíveis recusada com mensagem clara", threw);

  // ===== 7. Isolamento: lista de outro usuário/org invisível =====
  (FalaTuPurchaseService as any).readInvoice = async () => ({ supplierName: null, items: [{ name: "X", quantity: 1, unit: null, unitCost: 1, confidence: 90 }], confidence: 90 });
  threw = false;
  try { await FalaTuPurchaseService.check(orgB, userB, listId, img); } catch { threw = true; }
  check("lista de outra org invisível no check", threw);
  check("conferência de A invisível pra B", FalaTuPurchaseService.get(orgB, userB, chk.id) === null);

  // ===== 8. Teto do plano trava a leitura =====
  db.prepare(`INSERT INTO plans (id, name, price, features) VALUES ('test_nano_f4', 'Nano', 1, ?)`).run(JSON.stringify({ ai_monthly_limit: 3 }));
  db.prepare(`UPDATE organization_settings SET plan_id = 'test_nano_f4' WHERE organization_id = ?`).run(orgA);
  threw = false; // orgA já consumiu 3 ações de IA (2 checks confirmados + 1 descartado)
  try { await FalaTuPurchaseService.check(orgA, userA, listId, img); } catch (e: any) { threw = /Limite mensal/.test(e.message); }
  check("teto do plano trava a leitura de nota", threw);

  // ===== Resultado =====
  console.log("\n=== FalaTu Fatia 4 (compras com conferência) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
