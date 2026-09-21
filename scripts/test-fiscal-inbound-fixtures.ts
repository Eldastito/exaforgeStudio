/**
 * TESTE — Fase 0 da Entrada Automática de NF-e (ADR-200).
 * ---------------------------------------------------------------------
 * Fase 0 é só PROTEÇÃO E CONTRATOS: não há adapter, job nem rota de efeito
 * ainda. Este teste garante o que a Fase 0 entrega:
 *
 *   1. As fixtures XML sanitizadas existem, são XML bem-formado e têm os
 *      marcadores estruturais que as fases seguintes vão exercitar
 *      (procNFe autorizado com protNFe/cStat=100, resNFe SEM itens,
 *       evento de cancelamento tpEvento=110111, namespace prefixado,
 *       item "SEM GTIN", quantidade decimal).
 *   2. A chave de acesso das NF-e completas tem 44 dígitos e DV (mod 11)
 *      VÁLIDO — base do teste de dígito verificador da Fase 1.
 *   3. O kill-switch `fiscal_inbound_enabled` nasce DESLIGADO por org
 *      (default off, opt-in), e a migração aditiva roda em banco vazio.
 *
 * NÃO precisa de rede nem de provedor. Uso: npm run test:fiscal-inbound-fixtures
 */
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscal-inbound-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-fiscal-inbound-1234567890";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_DIR = path.join(__dirname, "fixtures", "fiscal-inbound");

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });

function readFix(file: string): string {
  return fs.readFileSync(path.join(FIX_DIR, file), "utf8");
}

/** Dígito verificador (mod 11) da chave de acesso de 44 dígitos. */
function accessKeyDvValid(key: string): boolean {
  if (!/^\d{44}$/.test(key)) return false;
  const base = key.slice(0, 43);
  let peso = 2, soma = 0;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  let dv = 11 - (soma % 11);
  if (dv >= 10) dv = 0;
  return dv === Number(key[43]);
}

async function main() {
  // 1. Fixtures existem e são XML bem-formado ----------------------------------
  const expected = [
    "procNFe-autorizado.xml",
    "resNFe.xml",
    "procEventoNFe-cancelamento.xml",
    "procNFe-namespace-prefixado.xml",
    "procNFe-item-sem-ean.xml",
    "procNFe-quantidade-decimal.xml",
  ];
  for (const f of expected) {
    let ok = false, detail = "";
    try { parser.parse(readFix(f)); ok = true; } catch (e: any) { detail = e?.message || "parse falhou"; }
    check(`fixture bem-formada: ${f}`, ok, detail);
  }

  // 2. Marcadores estruturais por fixture --------------------------------------
  const autorizado = parser.parse(readFix("procNFe-autorizado.xml"));
  check("procNFe: envelope nfeProc com protNFe", !!autorizado?.nfeProc?.protNFe);
  check("procNFe: protocolo cStat=100 (autorizado)", Number(autorizado?.nfeProc?.protNFe?.infProt?.cStat) === 100);
  const det = autorizado?.nfeProc?.NFe?.infNFe?.det;
  check("procNFe: tem 2 itens", Array.isArray(det) && det.length === 2);

  const resumo = parser.parse(readFix("resNFe.xml"));
  check("resNFe: raiz resNFe presente", !!resumo?.resNFe);
  check("resNFe: NÃO contém itens (det)", !resumo?.resNFe?.det);

  const evento = parser.parse(readFix("procEventoNFe-cancelamento.xml"));
  const tpEvento = evento?.procEventoNFe?.evento?.infEvento?.tpEvento;
  check("evento: tpEvento=110111 (cancelamento)", String(tpEvento) === "110111");

  const nsPref = parser.parse(readFix("procNFe-namespace-prefixado.xml"));
  check("namespace prefixado: parse com removeNSPrefix resolve infNFe", !!nsPref?.nfeProc?.NFe?.infNFe);

  const semEan = parser.parse(readFix("procNFe-item-sem-ean.xml"));
  const semEanProd = semEan?.nfeProc?.NFe?.infNFe?.det?.prod;
  check('item-sem-ean: cEAN="SEM GTIN"', String(semEanProd?.cEAN) === "SEM GTIN");

  const decimal = parser.parse(readFix("procNFe-quantidade-decimal.xml"));
  const qCom = String(decimal?.nfeProc?.NFe?.infNFe?.det?.prod?.qCom || "");
  check("quantidade-decimal: qCom fracionado preservado", qCom.includes(".") && Number(qCom) === 2.5);

  // 3. Chave de acesso: 44 dígitos + DV válido nas NF-e completas ---------------
  const keyOf = (doc: any) => String(doc?.nfeProc?.NFe?.infNFe?.["@_Id"] || "").replace(/\D/g, "");
  for (const [label, doc] of [["autorizado", autorizado], ["item-sem-ean", semEan], ["decimal", decimal]] as const) {
    const key = keyOf(doc);
    check(`chave 44 díg. + DV válido (${label})`, accessKeyDvValid(key), key);
  }

  // 4. Kill-switch fiscal_inbound_enabled: default OFF + migração em banco vazio -
  const { default: db } = await import("../src/server/db.js");
  const { FiscalInboundFlagService } = await import("../src/server/FiscalInboundFlagService.js");

  const colExists = (db.prepare(`PRAGMA table_info(organization_settings)`).all() as any[])
    .some((c) => c.name === "fiscal_inbound_enabled");
  check("migração: coluna fiscal_inbound_enabled criada em banco vazio", colExists);

  const orgId = "org-fixture-test";
  check("flag: org sem registro → DESLIGADO (default off)", FiscalInboundFlagService.isEnabled("org-inexistente") === false);

  db.prepare(`INSERT INTO organization_settings (id, organization_id) VALUES (?, ?)`).run("s-fixture", orgId);
  check("flag: org recém-criada → DESLIGADO (default off)", FiscalInboundFlagService.isEnabled(orgId) === false);
  check("flag: set(true) liga", FiscalInboundFlagService.set(orgId, true) === true);
  check("flag: set(false) desliga", FiscalInboundFlagService.set(orgId, false) === false);

  // Relatório --------------------------------------------------------------------
  console.log("\n=== Entrada Automática de NF-e — Fase 0 (ADR-200) ===\n");
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
