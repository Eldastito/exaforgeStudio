/**
 * TESTE — Parser expandido de documento fiscal (ADR-200, Fase 1, PR 1).
 * ---------------------------------------------------------------------
 * Cobre `parseNFeDocument` de src/server/nfeParser.ts: classificação de
 * completude, preservação de `xProd` (sem truncar), quantidade decimal,
 * extração de cProd/EAN/NCM/CFOP/valores, e validação do DV da chave.
 *
 * Usa as fixtures sanitizadas da Fase 0 (scripts/fixtures/fiscal-inbound).
 * Função pura — não precisa de banco nem rede.
 * Uso: npm run test:nfe-document-parser
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { parseNFeDocument, isValidAccessKey } from "../src/server/nfeParser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, "fixtures", "fiscal-inbound");
const readFix = (f: string) => fs.readFileSync(path.join(FIX_DIR, f), "utf8");

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

function main() {
  // Classificação de completude ------------------------------------------------
  const autorizado = parseNFeDocument(readFix("procNFe-autorizado.xml"));
  check("procNFe autorizado → content_level authorized_process", autorizado.contentLevel === "authorized_process", autorizado.contentLevel);
  check("procNFe autorizado → fiscal_status authorized", autorizado.fiscalStatus === "authorized");
  check("procNFe autorizado → protocolo cStat 100", autorizado.protocolStatus === "100");

  const resumo = parseNFeDocument(readFix("resNFe.xml"));
  check("resNFe → content_level summary_only", resumo.contentLevel === "summary_only", resumo.contentLevel);
  check("resNFe → sem itens", resumo.items.length === 0);
  check("resNFe → fiscal_status authorized (cSitNFe=1)", resumo.fiscalStatus === "authorized");

  const evento = parseNFeDocument(readFix("procEventoNFe-cancelamento.xml"));
  check("evento → content_level event_only", evento.contentLevel === "event_only", evento.contentLevel);
  check("evento → tpEvento 110111", evento.eventType === "110111");
  check("evento → fiscal_status cancelled", evento.fiscalStatus === "cancelled");

  const naoNFe = parseNFeDocument("<foo><bar>nada</bar></foo>");
  check("XML não-NFe → content_level invalid", naoNFe.contentLevel === "invalid", naoNFe.contentLevel);
  const lixo = parseNFeDocument("isto não é xml <<<");
  check("texto quebrado → invalid (não lança)", lixo.contentLevel === "invalid");

  // Namespace prefixado --------------------------------------------------------
  const ns = parseNFeDocument(readFix("procNFe-namespace-prefixado.xml"));
  check("namespace prefixado → authorized_process", ns.contentLevel === "authorized_process", ns.contentLevel);
  check("namespace prefixado → 1 item lido", ns.items.length === 1);

  // Cabeçalho / chave ----------------------------------------------------------
  check("chave 44 díg. extraída", autorizado.accessKey === "35240612345678000199550010000001231000000122", autorizado.accessKey || "null");
  check("DV da chave válido (accessKeyValid)", autorizado.accessKeyValid === true);
  check("emitente CNPJ", autorizado.issuerCnpj === "12345678000199");
  check("destinatário CNPJ", autorizado.recipientCnpj === "98765432000155");
  check("total vNF", autorizado.totalInvoice === 1078.0);
  check("isValidAccessKey rejeita DV errado", isValidAccessKey("35240612345678000199550010000001231000000129") === false);
  check("isValidAccessKey rejeita tamanho != 44", isValidAccessKey("123") === false);

  // Itens: xProd não truncado + campos -----------------------------------------
  const it1 = autorizado.items[0];
  check("procNFe autorizado → 2 itens", autorizado.items.length === 2);
  check("item: cProd preservado", it1.supplierProductCode === "FORN-001");
  check("item: xProd completo (não truncado)", it1.fiscalDescription === "CAMISETA BASICA GOLA CARECA PRETA TAM M");
  check("item: EAN válido", it1.ean === "7891234567895");
  check("item: NCM preservado", it1.ncm === "61091000");
  check("item: CFOP preservado", it1.cfop === "5102");
  check("item: qCom decimal (12)", it1.commercialQty === 12);
  check("item: vUnCom", it1.commercialUnitValue === 29.9);

  // Item sem EAN ---------------------------------------------------------------
  const semEan = parseNFeDocument(readFix("procNFe-item-sem-ean.xml"));
  check('item-sem-ean → ean null (não "SEM GTIN")', semEan.items[0].ean === null);
  check("item-sem-ean → cProd preservado", semEan.items[0].supplierProductCode === "FORN-777");

  // Quantidade decimal fracionada ----------------------------------------------
  const decimal = parseNFeDocument(readFix("procNFe-quantidade-decimal.xml"));
  check("quantidade-decimal → qCom = 2.5 (não truncado)", decimal.items[0].commercialQty === 2.5);
  check("quantidade-decimal → uCom KG", decimal.items[0].commercialUnit === "KG");
  check("quantidade-decimal → qTrib = 2.5", decimal.items[0].taxQty === 2.5);

  // Relatório ------------------------------------------------------------------
  console.log("\n=== Parser expandido de NF-e — Fase 1 PR 1 (ADR-200) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) process.exit(1);
}

main();
