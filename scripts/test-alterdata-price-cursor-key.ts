/**
 * TEST — Cursor de PREÇO chaveado por FORMATO (não por posição).
 * ----------------------------------------------------------------------------
 * BUG de produção (Toulon): o cursor do preço era guardado por POSIÇÃO na lista
 * de formatos (`5~0`, `5~1`, `5~2`). Quando o formato vencedor é cacheado a
 * ordem muda, e o mesmo formato passava a ler uma chave de posição diferente,
 * RESSUSCITANDO um cursor velho (ex.: 141994718) que a ModaUp responde 500 em
 * `/versao/{valor}` — wedgeando o módulo price (required) em server_error.
 * Agora a chave é o NOME do formato (`5~redeTabelaVersao`) — cursor estável.
 *
 * Prova, offline (HTTP fake):
 *   - o cursor velho envenenado (guardado numa chave de POSIÇÃO) NÃO é lido —
 *     o endpoint `/versao/01/5/141994718` NUNCA é chamado (nada de 500);
 *   - a chave nova por formato nasce em "0", faz o pull limpo e guarda o cursor
 *     correto (142635816);
 *   - 2ª execução (formato cacheado) lê a MESMA chave — estável, poison intocado.
 *
 * Uso: npm run test:alterdata-price-cursor-key
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-price-cursor-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-price-cursor-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "01", priceTable: "5", filiais: [],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });

  const POISON = "141994718";   // cursor velho envenenado (500 na ModaUp)
  const GOOD = "142635816";     // versão mais nova (topo do stream de preço)
  // Estado PRÉ-fix: o cursor velho estava guardado numa chave de POSIÇÃO (`5~2`).
  AlterdataConnectorService.setCursor(A, "price", "Preco", "5~2", POISON);

  const calledPoison = { n: 0 };
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes(`/Preco/versao/01/5/${POISON}`)) { calledPoison.n++; return resp(500, "Internal Server Error"); }
    if (url.includes(`/Preco/versao/01/5/${GOOD}`)) return resp(200, { success: true, data: [] }); // topo do stream
    if (url.includes(`/Preco/versao/01/5/0`)) return resp(200, { success: true, data: [{ produto: "011994036015", tabela: 5, preco1: 59.9, versao: Number(GOOD), controleVersao: Number(GOOD) }] });
    if (url.includes(`/Preco/versao/5/`) || url.match(/\/Preco\/versao\/\d+$/)) return resp(404, "Not Found"); // formatos tabela/versao e versao
    return resp(200, { success: true, data: [] }); // Referencia/Saldo/DataCaixa/… vazios
  });

  // ===== 1ª execução: chave nova por formato nasce em 0, pull limpo =====
  const s1 = await AlterdataSyncRunner.runOrg(A, { manual: true });
  check("preço reconhecido (skippedNoProduct>=1, sem produto casando)", Number(s1.precos?.skippedNoProduct || 0) >= 1, JSON.stringify(s1.precos));
  check("cursor envenenado NUNCA foi chamado (sem 500 ressuscitado)", calledPoison.n === 0, `chamadas ao poison=${calledPoison.n}`);
  const curByFormat = AlterdataConnectorService.getCursor(A, "price", "Preco", "5~redeTabelaVersao");
  check("cursor guardado na chave por FORMATO (5~redeTabelaVersao) = topo do stream", String(curByFormat) === GOOD, `cursor=${curByFormat}`);
  const curOldPos = AlterdataConnectorService.getCursor(A, "price", "Preco", "5~2");
  check("chave de POSIÇÃO velha fica órfã (não é mais lida nem sobrescrita)", String(curOldPos) === POISON, `5~2=${curOldPos}`);

  // ===== 2ª execução (formato cacheado): mesma chave, estável, poison intocado =====
  const s2 = await AlterdataSyncRunner.runOrg(A, { manual: true });
  check("2ª execução não ressuscita o poison (segue 0 chamadas)", calledPoison.n === 0, `chamadas ao poison=${calledPoison.n}`);
  const curByFormat2 = AlterdataConnectorService.getCursor(A, "price", "Preco", "5~redeTabelaVersao");
  check("cursor por formato estável entre execuções", String(curByFormat2) === GOOD, `cursor=${curByFormat2}`);
  check("2ª execução roda sem quebrar (runStatus definido)", !!s2.runStatus, JSON.stringify(s2.runStatus));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Cursor de preço por formato (fim do 500 ressuscitado) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
