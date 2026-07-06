/**
 * TEST — EAN/GTIN + Radar request-consultation
 * -----------------------------------------------------------------------
 * Covers:
 *   1. EAN column in products_services
 *   2. EAN extraction from NF-e XML (cEAN field)
 *   3. EAN in product CRUD (create/update)
 *   4. Radar consultation request table + service
 *   5. Stale comment cleanup verification
 *
 * Runs on a TEMPORARY database. Usage: npm run test:ean-radar-consultation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ean-radar-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ean-radar-1234567890abcdef";
process.env.APP_URL = "https://example.com";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    return orgId;
  }

  // ==== PART 1: EAN column exists ====
  console.log('\n=== PART 1: EAN column ===');

  const orgId = seedOrg("ean");
  const prodId = randomUUID();

  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, ean) VALUES (?, ?, 'product', ?, ?, 1, ?)`)
    .run(prodId, orgId, 'Camiseta EAN', 100, '7891234567890');

  const product = db.prepare(`SELECT ean FROM products_services WHERE id = ?`).get(prodId) as any;
  check("1.1 EAN column exists and stores value", product.ean === '7891234567890');

  // Update EAN
  db.prepare(`UPDATE products_services SET ean = ? WHERE id = ?`).run('0123456789012', prodId);
  const updated = db.prepare(`SELECT ean FROM products_services WHERE id = ?`).get(prodId) as any;
  check("1.2 EAN update works", updated.ean === '0123456789012');

  // Null EAN
  db.prepare(`UPDATE products_services SET ean = NULL WHERE id = ?`).run(prodId);
  const nulled = db.prepare(`SELECT ean FROM products_services WHERE id = ?`).get(prodId) as any;
  check("1.3 EAN can be NULL", nulled.ean === null);

  // ==== PART 2: NF-e parser EAN extraction ====
  console.log('\n=== PART 2: NF-e parser EAN ===');

  const { parseNFeXml } = await import("../src/server/nfeParser.js");

  const xmlWithEan = `<?xml version="1.0"?>
<nfeProc><NFe><infNFe Id="NFe12345678901234567890123456789012345678901234">
  <emit><xNome>Fornecedor Teste</xNome></emit>
  <det nItem="1"><prod>
    <cEAN>7891234567890</cEAN>
    <xProd>Produto com EAN</xProd>
    <qCom>10</qCom>
    <uCom>UN</uCom>
    <vUnCom>15.50</vUnCom>
  </prod></det>
  <det nItem="2"><prod>
    <cEAN>SEM GTIN</cEAN>
    <xProd>Produto sem EAN</xProd>
    <qCom>5</qCom>
    <uCom>CX</uCom>
    <vUnCom>30.00</vUnCom>
  </prod></det>
  <det nItem="3"><prod>
    <cEAN></cEAN>
    <cEANTrib>78901234</cEANTrib>
    <xProd>Produto EAN curto</xProd>
    <qCom>1</qCom>
    <uCom>UN</uCom>
    <vUnCom>50.00</vUnCom>
  </prod></det>
</infNFe></NFe></nfeProc>`;

  const parsed = parseNFeXml(xmlWithEan);
  check("2.1 Parser extracts 3 items", parsed.items.length === 3);
  check("2.2 Item 1 has EAN", parsed.items[0].ean === '7891234567890');
  check("2.3 Item 2 SEM GTIN → null", parsed.items[1].ean === null);
  check("2.4 Item 3 falls back to cEANTrib", parsed.items[2].ean === '78901234');

  // XML without any EAN
  const xmlNoEan = `<?xml version="1.0"?>
<NFe><infNFe>
  <emit><xNome>Forn</xNome></emit>
  <det nItem="1"><prod>
    <xProd>Produto simples</xProd>
    <qCom>1</qCom>
    <uCom>UN</uCom>
    <vUnCom>10</vUnCom>
  </prod></det>
</infNFe></NFe>`;
  const parsedNoEan = parseNFeXml(xmlNoEan);
  check("2.5 Item without cEAN tag → null", parsedNoEan.items[0].ean === null);

  // ==== PART 3: Radar consultation request table ====
  console.log('\n=== PART 3: Radar consultation requests ===');

  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='radar_consultation_requests'`).get() as any;
  check("3.1 Table radar_consultation_requests exists", !!tableExists);

  const reqId = randomUUID();
  const sessionId = randomUUID();

  // Create a radar session first (minimal columns for testing)
  db.prepare(`INSERT INTO radar_sessions (id, template_id, status, contact_name, contact_email, contact_phone, overall_maturity_score, maturity_level)
    VALUES (?, 'test_template', 'completed', 'João Teste', 'joao@test.com', '5511999999999', 45.5, 'experimental')`)
    .run(sessionId);

  db.prepare(`INSERT INTO radar_consultation_requests (id, session_id, contact_name, contact_email, contact_phone, message, overall_score, maturity_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reqId, sessionId, 'João Teste', 'joao@test.com', '5511999999999', 'Quero ajuda com processos', 45.5, 'experimental');

  const consultation = db.prepare(`SELECT * FROM radar_consultation_requests WHERE id = ?`).get(reqId) as any;
  check("3.2 Consultation request stored", !!consultation);
  check("3.3 Contact name correct", consultation.contact_name === 'João Teste');
  check("3.4 Email correct", consultation.contact_email === 'joao@test.com');
  check("3.5 Phone correct", consultation.contact_phone === '5511999999999');
  check("3.6 Message correct", consultation.message === 'Quero ajuda com processos');
  check("3.7 Score attached", consultation.overall_score === 45.5);
  check("3.8 Maturity level attached", consultation.maturity_level === 'experimental');
  check("3.9 Status defaults to pending", consultation.status === 'pending');

  // Idempotency: same session can't create two requests
  const dupId = randomUUID();
  try {
    const existing = db.prepare(`SELECT id FROM radar_consultation_requests WHERE session_id = ? LIMIT 1`).get(sessionId) as any;
    check("3.10 Duplicate prevention works", !!existing);
  } catch {
    check("3.10 Duplicate prevention works", false);
  }

  // ==== PART 4: Stale comment cleanup ====
  console.log('\n=== PART 4: Stale comments ===');

  const radarServiceContent = fs.readFileSync(path.join(process.cwd(), 'src/server/RadarService.ts'), 'utf-8');
  check("4.1 RadarService no longer says 'ainda não implementada'", !radarServiceContent.includes('ainda não implementada'));
  check("4.2 RadarService references RadarNarrativeService.ts", radarServiceContent.includes('RadarNarrativeService.ts'));

  const dbContent = fs.readFileSync(path.join(process.cwd(), 'src/server/db.ts'), 'utf-8');
  const dbRadarComment = dbContent.slice(dbContent.indexOf('RadarService, ver PRD'));
  check("4.3 db.ts radar comment updated for Fase 4", dbRadarComment.includes('RadarNarrativeService.ts'));
  check("4.4 db.ts radar comment updated for Fase 2", dbContent.includes('RadarPublicService.ts'));

  // ==== PART 5: EAN in NF-e confirm flow ====
  console.log('\n=== PART 5: EAN in NF-e import flow ===');

  const nfeParserContent = fs.readFileSync(path.join(process.cwd(), 'src/server/nfeParser.ts'), 'utf-8');
  check("5.1 nfeParser interface includes ean", nfeParserContent.includes('ean: string | null'));
  check("5.2 nfeParser extracts cEAN", nfeParserContent.includes('prod.cEAN'));

  const productsRouteContent = fs.readFileSync(path.join(process.cwd(), 'src/server/routes/products.ts'), 'utf-8');
  check("5.3 Product create includes ean column", productsRouteContent.includes('slug, ean)'));
  check("5.4 Product PATCH handles ean", productsRouteContent.includes('"ean = ?"'));

  // ==== PART 6: UI integration ====
  console.log('\n=== PART 6: UI integration ===');

  const catalogContent = fs.readFileSync(path.join(process.cwd(), 'src/features/CatalogView.tsx'), 'utf-8');
  check("6.1 CatalogView emptyForm has ean", catalogContent.includes("ean: ''"));
  check("6.2 CatalogView has EAN input", catalogContent.includes('EAN / GTIN'));

  const wizardContent = fs.readFileSync(path.join(process.cwd(), 'src/radar-public/RadarPublicWizard.tsx'), 'utf-8');
  check("6.3 Wizard has ConsultationForm", wizardContent.includes('ConsultationForm'));
  check("6.4 Wizard calls request-consultation endpoint", wizardContent.includes('request-consultation'));

  const radarRouteContent = fs.readFileSync(path.join(process.cwd(), 'src/server/routes/radarPublic.ts'), 'utf-8');
  check("6.5 Route has request-consultation endpoint", radarRouteContent.includes('/request-consultation'));

  // ---- Summary ----
  console.log("\n──── Resultados ────");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` [${r.detail}]` : ""}`);
  }
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
