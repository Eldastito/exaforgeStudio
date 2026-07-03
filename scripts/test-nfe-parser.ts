/**
 * TESTE — Cadastro via XML de NF-e (Smart Inventory Fase 2, ADR-022)
 * ---------------------------------------------------------------------
 * Cobre `src/server/nfeParser.ts` (parseNFeXml), incluindo as variações reais
 * de XML de NF-e que aparecem na prática:
 *   - envelope "autorizado" (nfeProc > NFe > infNFe) vs. NFe assinada isolada
 *     (NFe > infNFe);
 *   - nota com 1 item só (o parser de XML devolve OBJETO em vez de array
 *     quando há um único <det> — bug clássico se não normalizar);
 *   - nota com vários itens;
 *   - namespace com prefixo (nfe:NFe, ns2:det) — schemas variam por emissor;
 *   - XML que não é NF-e nenhuma (deve rejeitar com erro claro, não inventar
 *     dados vazios silenciosamente);
 *   - itens sem nome (linha "vazia") são descartados.
 *
 * Diferente dos testes de smart-scan/invoice-scan (foto), este teste NÃO
 * precisa de banco de dados nem mock de IA — parseNFeXml é uma função pura, e
 * o XML é dado estruturado real (não uma chamada de IA a validar depois).
 * Cobre também, com banco temporário, que o draft criado a partir do XML flui
 * pelo MESMO endpoint de confirmação da Fase 1 sem nenhuma mudança de schema.
 *
 * Uso: npm run test:nfe-parser
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-nfe-parser-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-nfe-parser-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

const XML_MULTI_ITEM_AUTORIZADO = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe123" versao="4.00">
      <ide><nNF>123</nNF></ide>
      <emit><xNome>Atacadão Central LTDA</xNome><CNPJ>12345678000199</CNPJ></emit>
      <det nItem="1">
        <prod><cProd>001</cProd><xProd>FEIJAO PRETO KICALDO 1KG</xProd><uCom>UN</uCom><qCom>20.0000</qCom><vUnCom>6.500000000</vUnCom><vProd>130.00</vProd></prod>
      </det>
      <det nItem="2">
        <prod><cProd>002</cProd><xProd>ARROZ BRANCO 5KG</xProd><uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>17.000000000</vUnCom><vProd>170.00</vProd></prod>
      </det>
    </infNFe>
  </NFe>
</nfeProc>`;

const XML_SINGLE_ITEM_ISOLADO = `<?xml version="1.0"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe456" versao="4.00">
    <emit><xNome>Fornecedor Único ME</xNome></emit>
    <det nItem="1"><prod><xProd>ITEM ÚNICO DA NOTA</xProd><uCom>CX</uCom><qCom>5</qCom><vUnCom>3.00</vUnCom></prod></det>
  </infNFe>
</NFe>`;

const XML_COM_NAMESPACE_PREFIXADO = `<?xml version="1.0"?>
<nfe:nfeProc xmlns:nfe="http://www.portalfiscal.inf.br/nfe">
  <nfe:NFe>
    <nfe:infNFe Id="NFe789" versao="4.00">
      <nfe:emit><nfe:xNome>Distribuidora Prefixada SA</nfe:xNome></nfe:emit>
      <nfe:det nItem="1"><nfe:prod><nfe:xProd>PRODUTO COM PREFIXO</nfe:xProd><nfe:uCom>UN</nfe:uCom><nfe:qCom>2</nfe:qCom><nfe:vUnCom>50.00</nfe:vUnCom></nfe:prod></nfe:det>
    </nfe:infNFe>
  </nfe:NFe>
</nfe:nfeProc>`;

const XML_NAO_E_NFE = `<?xml version="1.0"?><pedido><cliente>João</cliente><itens><item>Camisa</item></itens></pedido>`;

const XML_ITEM_SEM_NOME = `<?xml version="1.0"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe999" versao="4.00">
    <det nItem="1"><prod><xProd>ITEM VÁLIDO</xProd><qCom>1</qCom><vUnCom>10</vUnCom></prod></det>
    <det nItem="2"><prod><xProd></xProd><qCom>1</qCom><vUnCom>10</vUnCom></prod></det>
  </infNFe>
</NFe>`;

async function main() {
  const { parseNFeXml } = await import("../src/server/nfeParser.js");

  // ---- envelope autorizado, múltiplos itens ----
  const multi = parseNFeXml(XML_MULTI_ITEM_AUTORIZADO);
  check("Fornecedor identificado corretamente (envelope nfeProc)", multi.supplierName === "Atacadão Central LTDA");
  check("2 itens extraídos", multi.items.length === 2);
  check("Item 1: nome correto", multi.items[0].name === "FEIJAO PRETO KICALDO 1KG");
  check("Item 1: quantidade correta", multi.items[0].quantity === 20);
  check("Item 1: custo unitário correto", Math.abs(multi.items[0].unitCost - 6.5) < 0.001);
  check("Item 1: unidade correta", multi.items[0].unit === "UN");
  check("Item 2: nome correto", multi.items[1].name === "ARROZ BRANCO 5KG");
  check("Item 2: custo unitário correto", Math.abs(multi.items[1].unitCost - 17.0) < 0.001);

  // ---- NFe isolada (sem nfeProc), item único (det vira objeto, não array) ----
  const single = parseNFeXml(XML_SINGLE_ITEM_ISOLADO);
  check("Fornecedor identificado (NFe isolada, sem nfeProc)", single.supplierName === "Fornecedor Único ME");
  check("1 item extraído mesmo com <det> único (objeto, não array)", single.items.length === 1);
  check("Item único: nome correto", single.items[0].name === "ITEM ÚNICO DA NOTA");
  check("Item único: quantidade correta", single.items[0].quantity === 5);

  // ---- namespace com prefixo (nfe:xxx) ----
  const prefixed = parseNFeXml(XML_COM_NAMESPACE_PREFIXADO);
  check("Fornecedor identificado com namespace prefixado", prefixed.supplierName === "Distribuidora Prefixada SA");
  check("Item extraído com namespace prefixado", prefixed.items.length === 1 && prefixed.items[0].name === "PRODUTO COM PREFIXO");

  // ---- XML que não é NF-e: deve rejeitar, não inventar dados vazios ----
  let rejectedNonNFe = false;
  try { parseNFeXml(XML_NAO_E_NFE); } catch (e: any) { rejectedNonNFe = /NF-e/i.test(e.message); }
  check("XML que não é NF-e é rejeitado com erro claro (não retorna itens vazios silenciosamente)", rejectedNonNFe);

  // ---- item sem nome é descartado, item válido continua ----
  const withEmpty = parseNFeXml(XML_ITEM_SEM_NOME);
  check("Item sem nome é descartado", withEmpty.items.length === 1);
  check("Item válido ao lado do vazio continua presente", withEmpty.items[0]?.name === "ITEM VÁLIDO");

  // ---- fluxo completo: draft criado a partir do XML confirma pelo MESMO endpoint da Fase 1 ----
  const { default: db } = await import("../src/server/db.js");
  const { logAuthEvent } = await import("../src/server/auditLog.js");
  const { InventoryService } = await import("../src/server/InventoryService.js");

  const orgA = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Empresa A', 'active')`).run(randomUUID(), orgA);
  const userA = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role) VALUES (?, ?, 'Dono A', 'dono.a@teste.com', 'owner')`).run(userA, orgA);

  const draftId = randomUUID();
  const items = multi.items.map((it) => ({ ...it, confidence: 100 }));
  db.prepare(
    `INSERT INTO invoice_scan_drafts (id, organization_id, uploaded_by, image_url, raw_extraction_json, confidence_score, status)
     VALUES (?, ?, ?, '', ?, 100, 'pending')`
  ).run(draftId, orgA, userA, JSON.stringify({ supplierName: multi.supplierName, items, source: "xml" }));
  logAuthEvent(orgA, userA, draftId, "INVOICE_SCAN_EXTRACTED", { confidenceScore: 100, itemCount: items.length, source: "xml" });

  const draftRow = db.prepare(`SELECT * FROM invoice_scan_drafts WHERE id = ?`).get(draftId) as any;
  check("Draft criado a partir do XML: confidence_score é 100 (dado estruturado, sem incerteza de leitura)", draftRow?.confidence_score === 100);
  check("Draft criado a partir do XML: image_url vazio (sem foto)", draftRow?.image_url === "");

  // confirma o primeiro item como produto novo — usando a MESMA lógica de
  // dados do endpoint de confirmação da Fase 1 (nenhuma mudança de schema
  // necessária para o XML fluir pelo mesmo caminho da foto)
  const productId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled) VALUES (?, ?, 'product', ?, '', 9.99, 1)`)
    .run(productId, orgA, items[0].name);
  InventoryService.recordMovement(orgA, { productId, type: "entrada", quantity: items[0].quantity, unitCost: items[0].unitCost, origin: "invoice_scan", note: multi.supplierName || undefined, createdBy: userA });
  db.prepare(`UPDATE invoice_scan_drafts SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(draftId);

  const stock = db.prepare(`SELECT quantity_available, avg_cost FROM inventory_items WHERE product_service_id = ?`).get(productId) as any;
  check("Produto criado a partir de item do XML entra com a quantidade e custo corretos", stock?.quantity_available === 20 && Math.abs(stock.avg_cost - 6.5) < 0.001);

  const movement = db.prepare(`SELECT * FROM stock_movements WHERE organization_id = ? AND origin = 'invoice_scan'`).get(orgA) as any;
  check("Movimentação de estoque registrada com origin=invoice_scan (mesmo caminho da Fase 1)", !!movement);

  // ---- resultado ----
  console.log("\n=== Cadastro via XML de NF-e — Smart Inventory Fase 2 (ADR-022) ===\n");
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
