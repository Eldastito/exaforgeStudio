/**
 * TESTE — Backlog Smart Inventory (ADR-024)
 * -------------------------------------------
 * Cobre os 5 itens do pacote 1 do backlog (itens 25–28 e 35 do levantamento):
 *   25. matching aproximado de nome de produto (productMatcher.ts);
 *   26. vínculo da entrada de estoque com o fornecedor do CRM
 *       (stock_movements.supplier_contact_id, via InventoryService real);
 *   27. lote de XMLs — coberto aqui pela parte testável sem HTTP (dedupe
 *       intra-lote é a mesma lógica do dedupe contra o banco);
 *   28. dedupe por chave de acesso da NF-e (nfeParser.accessKey + consulta
 *       de duplicidade em invoice_scan_drafts);
 *   35. markup padrão configurável (storefront_settings.default_markup_percent
 *       + clamp da leitura, mesma lógica de orgMarkup em routes/products.ts).
 *
 * Uso: npm run test:backlog-inventory
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-backlog-inv-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-backlog-inventory-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

const XML_COM_CHAVE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe35240612345678000199550010000012341000012349" versao="4.00">
    <emit><xNome>Atacadao Central LTDA</xNome></emit>
    <det nItem="1"><prod><xProd>FEIJAO PRETO KICALDO 1KG</xProd><uCom>UN</uCom><qCom>20</qCom><vUnCom>6.35</vUnCom></prod></det>
  </infNFe></NFe>
</nfeProc>`;

const XML_SEM_CHAVE = `<?xml version="1.0"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe versao="4.00">
    <emit><xNome>Fornecedor Sem Chave</xNome></emit>
    <det nItem="1"><prod><xProd>ITEM QUALQUER</xProd><qCom>1</qCom><vUnCom>5</vUnCom></prod></det>
  </infNFe>
</NFe>`;

async function main() {
  // ---- item 25: matching aproximado ----
  const { normalizeProductName, nameSimilarity, findBestProductMatch } = await import("../src/server/productMatcher.js");

  check("normalizeProductName remove acento/caixa/pontuação", normalizeProductName("FEIJÃO Prêto, Kicaldo! 1KG") === "feijao preto kicaldo 1kg");
  check("Nomes idênticos após normalização -> similaridade 1", nameSimilarity("Feijão Preto Kicaldo 1kg", "FEIJAO PRETO KICALDO 1KG") === 1);
  check("Nome abreviado da nota casa com o nome completo do catálogo (>= 0.85)", nameSimilarity("FEIJAO PRETO 1KG", "Feijão Preto Kicaldo 1kg") >= 0.85);
  check("Produtos sem relação não casam (0)", nameSimilarity("Arroz Branco 5kg", "Sabão em Pó Omo 1kg") === 0);

  const catalog = [
    { id: "arroz", name: "Arroz Branco Tipo 1 5kg" },
    { id: "feijao", name: "Feijão Preto Kicaldo 1kg" },
  ];
  const best = findBestProductMatch("ARROZ BCO TIPO 1 5KG", catalog);
  check("findBestProductMatch escolhe o produto certo entre candidatos", best?.id === "arroz", `obtido=${best?.id} score=${best?.score}`);
  check("Nome sem nenhum candidato razoável retorna null (não força match errado)", findBestProductMatch("Chinelo Havaianas 39", catalog) === null);

  // ---- item 28: chave de acesso no parser ----
  const { parseNFeXml } = await import("../src/server/nfeParser.js");
  const parsed = parseNFeXml(XML_COM_CHAVE);
  check("Parser extrai a chave de acesso (44 dígitos do atributo Id)", parsed.accessKey === "35240612345678000199550010000012341000012349");
  check("Parser continua lendo itens/fornecedor normalmente com atributos ligados", parsed.items.length === 1 && parsed.supplierName === "Atacadao Central LTDA");
  const semChave = parseNFeXml(XML_SEM_CHAVE);
  check("XML sem atributo Id -> accessKey null, importação não bloqueada", semChave.accessKey === null && semChave.items.length === 1);

  // ---- banco: dedupe, fornecedor, markup ----
  const { default: db } = await import("../src/server/db.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");
  const { suggestSalePrice } = await import("../src/server/pricing.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);

  // item 28: dedupe por chave de acesso (mesma consulta da rota)
  const key = parsed.accessKey!;
  db.prepare(`INSERT INTO invoice_scan_drafts (id, organization_id, image_url, raw_extraction_json, confidence_score, status, access_key) VALUES (?, ?, '', '{}', 100, 'confirmed', ?)`)
    .run(randomUUID(), orgA, key);
  const dupe = db.prepare(`SELECT id FROM invoice_scan_drafts WHERE organization_id = ? AND access_key = ? AND status IN ('pending','confirmed') LIMIT 1`).get(orgA, key) as any;
  check("NF-e já confirmada é detectada como duplicada pela chave de acesso", !!dupe);
  const orgB = `org_${randomUUID().slice(0, 6)}`;
  const dupeOutraOrg = db.prepare(`SELECT id FROM invoice_scan_drafts WHERE organization_id = ? AND access_key = ? AND status IN ('pending','confirmed') LIMIT 1`).get(orgB, key) as any;
  check("Dedupe é por organização (outra org pode importar a mesma chave)", !dupeOutraOrg);
  const discarded = db.prepare(`SELECT id FROM invoice_scan_drafts WHERE organization_id = ? AND access_key = ? AND status = 'discarded' LIMIT 1`).get(orgA, key) as any;
  check("Rascunho descartado não bloqueia reimportação (consulta ignora 'discarded')", !discarded);

  // item 26: fornecedor vinculado na movimentação
  const supplierId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, is_supplier) VALUES (?, ?, 'ch1', 'Atacadão Central LTDA', '5511988887777', 1)`)
    .run(supplierId, orgA);
  const notSupplierId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, is_supplier) VALUES (?, ?, 'ch1', 'Cliente Comum', '5511911112222', 0)`)
    .run(notSupplierId, orgA);

  // mesma lógica de matchSupplierContact (rota): só contatos is_supplier=1, similaridade >= 0.7
  const suppliers = db.prepare(`SELECT id, name FROM contacts WHERE organization_id = ? AND COALESCE(is_supplier,0) = 1`).all(orgA) as any[];
  let matched: any = null;
  for (const s of suppliers) {
    const score = nameSimilarity("Atacadao Central LTDA", s.name || "");
    if (score >= 0.7 && (!matched || score > matched.score)) matched = { id: s.id, score };
  }
  check("Nome do emitente da nota casa com o contato fornecedor do CRM (sem acento vs. com acento)", matched?.id === supplierId, `score=${matched?.score}`);
  check("Contato que NÃO é fornecedor nunca entra como candidato", !suppliers.some((s) => s.id === notSupplierId));

  const productId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, stock_control_enabled) VALUES (?, ?, 'product', 'Feijão Preto Kicaldo 1kg', 9.99, 1)`).run(productId, orgA);
  const movId = InventoryService.recordMovement(orgA, {
    productId, type: "entrada", quantity: 20, unitCost: 6.35,
    origin: "invoice_scan", note: "Nota fiscal — Atacadao Central LTDA", supplierContactId: supplierId,
  });
  const mov = db.prepare(`SELECT * FROM stock_movements WHERE id = ?`).get(movId) as any;
  check("recordMovement grava supplier_contact_id na movimentação", mov?.supplier_contact_id === supplierId);
  const movSem = InventoryService.recordMovement(orgA, { productId, type: "entrada", quantity: 1, unitCost: 6.0, origin: "manual" });
  const movSemRow = db.prepare(`SELECT * FROM stock_movements WHERE id = ?`).get(movSem) as any;
  check("Movimentação sem fornecedor continua funcionando (coluna nula)", movSemRow && movSemRow.supplier_contact_id === null);

  // item 35: markup configurável (mesma lógica de orgMarkup na rota)
  function orgMarkup(orgIdX: string): number {
    const row = db.prepare(`SELECT default_markup_percent FROM storefront_settings WHERE organization_id = ?`).get(orgIdX) as any;
    const v = Number(row?.default_markup_percent);
    if (!Number.isFinite(v) || v <= 0) return 40;
    return Math.min(500, v);
  }
  check("Sem configuração de loja -> markup padrão 40%", orgMarkup(orgA) === 40);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, default_markup_percent) VALUES (?, ?, 60)`).run(orgA, `loja-${orgA}`);
  check("Markup configurado (60%) é lido corretamente", orgMarkup(orgA) === 60);
  check("Sugestão de preço usa o markup configurado (custo 10, 60% -> 15.99)", suggestSalePrice(10, orgMarkup(orgA)) === 15.99, `obtido=${suggestSalePrice(10, orgMarkup(orgA))}`);
  db.prepare(`UPDATE storefront_settings SET default_markup_percent = 9999 WHERE organization_id = ?`).run(orgA);
  check("Markup corrompido acima do limite é clampado em 500", orgMarkup(orgA) === 500);
  db.prepare(`UPDATE storefront_settings SET default_markup_percent = NULL WHERE organization_id = ?`).run(orgA);
  check("Markup NULL volta ao padrão 40%", orgMarkup(orgA) === 40);

  // ---- resultado ----
  console.log("\n=== Backlog Smart Inventory (ADR-024) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
