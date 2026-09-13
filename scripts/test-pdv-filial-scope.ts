/**
 * TEST — PDV por loja (Caminho 2a, rede TOULON): a importação de clientes do PDV
 * (ClienteMalote traz a REDE inteira) é filtrada pela(s) filial(is) da conta
 * quando ela OPTA pelo escopo. Prova a flag + o allow-set + a semântica do filtro.
 *
 * A conta guarda-chuva (flag OFF) importa TODOS (0-regressão); a conta de loja
 * (flag ON + filiais=[a dela]) importa SÓ os seus. Uso: npm run test:pdv-filial-scope
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pdvfilial-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pdvfilial-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { AlterdataConnectorService: AC } = await import("../src/server/AlterdataConnectorService.js");
  const TOULON = `org_${randomUUID().slice(0, 8)}`, CARIOCA = `org_${randomUUID().slice(0, 8)}`;

  // Simula o stream da REDE (ClienteMalote): clientes de 3 filiais.
  const rede = [
    { codigoN: "1", filial: "CA" }, { codigoN: "2", filial: "NI" },
    { codigoN: "3", filial: "CA" }, { codigoN: "4", filial: "GR" },
    { codigoN: "5", filial: " ca " }, { codigoN: "6", filial: null },
  ];
  const passes = (allow: Set<string> | null, filial: any) =>
    !allow || allow.has(String(filial).trim().toUpperCase());
  const imported = (allow: Set<string> | null) => rede.filter((c) => passes(allow, c.filial)).map((c) => c.codigoN);

  // ── 1. flag round-trip ──
  check("1.1 flag default OFF", AC.isPdvFilialScoped(TOULON) === false);
  AC.setPdvFilialScoped(CARIOCA, true);
  check("1.2 setPdvFilialScoped liga", AC.isPdvFilialScoped(CARIOCA) === true);
  AC.setPdvFilialScoped(CARIOCA, false);
  check("1.3 setPdvFilialScoped desliga", AC.isPdvFilialScoped(CARIOCA) === false);

  // ── 2. TOULON (flag OFF) → sem filtro → importa TODOS (0-regressão) ──
  const allowToulon = AC.pdvFilialAllowSet(TOULON, ["CA", "NI", "GR"]);
  check("2.1 flag OFF → allow-set null (sem filtro)", allowToulon === null);
  check("2.2 TOULON importa todos os 6", imported(allowToulon).length === 6);

  // ── 3. Carioca (flag ON + filiais=[CA]) → só CA ──
  AC.setPdvFilialScoped(CARIOCA, true);
  const allowCarioca = AC.pdvFilialAllowSet(CARIOCA, ["CA"]);
  check("3.1 flag ON + filial → allow-set com CA", allowCarioca instanceof Set && allowCarioca.has("CA"));
  const impCarioca = imported(allowCarioca);
  check("3.2 Carioca importa só filial CA (inclui variação de caixa/espaço)", impCarioca.sort().join(",") === "1,3,5");
  check("3.3 Carioca NÃO importa NI/GR", !impCarioca.includes("2") && !impCarioca.includes("4"));
  check("3.4 cliente sem filial não entra na conta escopada", !impCarioca.includes("6"));

  // ── 4. flag ON mas SEM filiais → sem filtro (não zera por engano) ──
  const allowEmpty = AC.pdvFilialAllowSet(CARIOCA, []);
  check("4.1 flag ON + filiais vazias → null (sem filtro, não esconde tudo)", allowEmpty === null);
  check("4.2 → importa todos (não some com a base por config incompleta)", imported(allowEmpty).length === 6);

  // ── 5. multi-filial (conta com 2 lojas) ──
  const allowMulti = AC.pdvFilialAllowSet(CARIOCA, ["CA", "GR"]);
  check("5.1 duas filiais → CA + GR", imported(allowMulti).sort().join(",") === "1,3,4,5");

  console.log("\n=== PDV por loja (filtro de filial no import) ===");
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pdv-filial-scope: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
