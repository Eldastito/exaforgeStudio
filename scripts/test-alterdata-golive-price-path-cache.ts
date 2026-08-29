/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 7, RF-14) — price path caching.
 * DB-backed, determinístico. Prova que:
 *
 *   1. Primeira sync sem cache → tenta múltiplos formatos até achar um
 *      que devolva linhas de preço; grava o formato vencedor no profile
 *   2. Segunda sync com cache → vai DIRETO no formato salvo (sem tentar
 *      os outros primeiro)
 *   3. Isolamento env: cache do prod NÃO afeta homolog
 *   4. Se o formato cacheado falhar (ex.: cliente mudou config), runner
 *      tenta os outros e ATUALIZA o cache pro novo vencedor
 *   5. setPricePathFormat(null) limpa o cache — próximo sync volta a
 *      probar do zero
 *   6. Formato inválido no cache é ignorado (não gera crash) — cai
 *      pro conjunto de candidatos padrão
 *
 * Usa mock do transport pra contar quantas URLs distintas foram tentadas.
 *
 * Uso: npm run test:alterdata-golive-price-path-cache
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-pricepath-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-pricepath-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { AlterdataProfileService } = await import("../src/server/AlterdataProfileService.js");
  const { AlterdataConnectorService } = await import("../src/server/AlterdataConnectorService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");

  // Config comum
  const ORG = "org-pricepath";
  AlterdataConnectorService.saveSettings(ORG, {
    enabled: true, environment: "homolog",
    authConfig: { clientId: "x", clientSecret: "y" },
    basePattern: "toulon-{module}.apimodaup.com.br",
    rede: "REDE-01", filiais: ["001"], priceTable: "1",
  });
  AlterdataConnectorService.setAccessToken(ORG, "TOKEN-1", new Date(Date.now() + 3600_000));

  const resp = (status: number, body: any) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_n: string) => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });

  // Mock: só o formato `versao` (o 2º candidato na ordem padrão) devolve
  // uma linha de preço. Os outros voltam vazios (200 com items=[]) — o
  // runner detecta que o preço rodou de verdade só quando o mapper aplica
  // >0 preços (aqui simulamos com produto conhecido).
  //
  // Setup: garante 1 variant no catálogo pra o mapper conseguir aplicar
  // uma linha (evita falso empate 0=0).
  const db = (await import("../src/server/db.js")).default;
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, external_ref) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("prod-1", ORG, "Camisa X", "product", 0, "REF-1");
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, sku, price) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("var-1", ORG, "prod-1", "Camisa X 01", "REF-1", 0);

  const tries: string[] = [];
  const makeMock = (winnerPath: string) => async (url: string) => {
    tries.push(url);
    // Referência / Saldo / Barra / DataCaixa / VendaMalote / Comissão / CRM: vazio 200
    if (url.includes(winnerPath)) {
      // devolve UMA linha de preço com produto conhecido pra o mapper aplicar
      return resp(200, { items: [{ produto: "REF-1", preco1: 99.9 }], totalPages: 1 });
    }
    return resp(200, { items: [], totalPages: 1 });
  };

  // ═══════ 1. Primeira sync sem cache ═══════
  tries.length = 0;
  __setAlterdataSyncHttpForTests(makeMock("/api/v1/Preco/versao/1/"));
  // Formato esperado a vencer: `tabelaVersao` = /Preco/versao/{table}/{c}
  // ORDER default: tabelaVersao → versao → redeTabelaVersao
  await AlterdataSyncRunner.runOrg(ORG, { manual: true });
  const cachedAfter1 = AlterdataProfileService.getPricePathFormat(ORG, "homolog");
  check("1.1 cache preenchido após 1ª sync",
    cachedAfter1 === "tabelaVersao",
    `esperado 'tabelaVersao', got '${cachedAfter1}'`);
  const priceTries1 = tries.filter(u => u.includes("/api/v1/Preco/")).length;
  check("1.2 pelo menos 1 tentativa de preço na 1ª sync", priceTries1 >= 1);

  // ═══════ 2. Segunda sync usa cache — vai direto no vencedor ═══════
  tries.length = 0;
  await AlterdataSyncRunner.runOrg(ORG, { manual: true });
  const distinctPriceFormats2 = new Set(
    tries.filter(u => u.includes("/api/v1/Preco/"))
         .map(u => u.replace(/\/\d+$/, "/N")) // normaliza cursor final
  );
  // Todas as tentativas de preço devem usar `versao/{table}/N` — o cache!
  check("2.1 2ª sync só usa o formato cacheado",
    Array.from(distinctPriceFormats2).every(u => u.includes("/api/v1/Preco/versao/1/")),
    `distinct: ${JSON.stringify(Array.from(distinctPriceFormats2))}`);

  // ═══════ 3. Isolamento env ═══════
  const cachedProd = AlterdataProfileService.getPricePathFormat(ORG, "prod");
  check("3.1 cache prod NÃO foi preenchido (isolamento)", cachedProd === null);

  // ═══════ 4. Cache inválido → tenta outros e atualiza ═══════
  // Semeia cache com formato que NÃO vence mais; muda o vencedor no mock
  // pra `versao` (sem tabela). Após o sync, cache deve trocar pra `versao`.
  AlterdataProfileService.setPricePathFormat(ORG, "homolog", "tabelaVersao");
  __setAlterdataSyncHttpForTests(async (url: string) => {
    tries.push(url);
    // Só o formato `versao` (sem tabela) devolve linhas agora.
    // Precisa distinguir: /Preco/versao/1/N (tabelaVersao) vs /Preco/versao/N (versao)
    const isTabelaVersao = /\/Preco\/versao\/1\/\d/.test(url);
    const isVersaoOnly = /\/Preco\/versao\/\d/.test(url) && !isTabelaVersao;
    if (isVersaoOnly) return resp(200, { items: [{ produto: "REF-1", preco1: 111 }], totalPages: 1 });
    return resp(200, { items: [], totalPages: 1 });
  });
  // Limpa cursor pra forçar re-consulta do módulo Price
  AlterdataConnectorService.setCursor(ORG, "price", "Preco", "1~0", "0");
  AlterdataConnectorService.setCursor(ORG, "price", "Preco", "1~1", "0");
  tries.length = 0;
  await AlterdataSyncRunner.runOrg(ORG, { manual: true });
  const cachedAfter4 = AlterdataProfileService.getPricePathFormat(ORG, "homolog");
  check("4.1 cache atualizado pro novo vencedor",
    cachedAfter4 === "versao",
    `esperado 'versao', got '${cachedAfter4}'`);

  // ═══════ 5. Limpar cache ═══════
  AlterdataProfileService.setPricePathFormat(ORG, "homolog", null);
  check("5.1 setPricePathFormat(null) limpa",
    AlterdataProfileService.getPricePathFormat(ORG, "homolog") === null);

  // ═══════ 6. Cache com formato desconhecido ═══════
  AlterdataProfileService.setPricePathFormat(ORG, "homolog", "formatoInexistente");
  // Runner deve ignorar (formato não está no FORMATS map) e voltar à ordem padrão
  tries.length = 0;
  AlterdataConnectorService.setCursor(ORG, "price", "Preco", "1~0", "0");
  AlterdataConnectorService.setCursor(ORG, "price", "Preco", "1~1", "0");
  await AlterdataSyncRunner.runOrg(ORG, { manual: true });
  // Depois do sync, o cache DEVE ser atualizado pro vencedor real ('versao'):
  const cachedAfter6 = AlterdataProfileService.getPricePathFormat(ORG, "homolog");
  check("6.1 cache inválido é sobrescrito pelo vencedor real",
    cachedAfter6 === "versao",
    `esperado 'versao', got '${cachedAfter6}'`);

  __setAlterdataSyncHttpForTests(null);

  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) {
    const line = `  ${r.ok ? "✓" : "✗"} ${r.name}`;
    console.log(r.ok ? line : `${line} — ${r.detail ?? ""}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
