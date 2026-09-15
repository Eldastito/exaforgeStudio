/**
 * TEST — LINHA DO TEMPO de uma filial (diagnóstico de migração de código).
 * ----------------------------------------------------------------------------
 * Varre os fechamentos (ResumoFecharMovimento) numa janela e descobre o PRIMEIRO
 * e o ÚLTIMO dia com venda de cada filial + a última movimentação. Serve pra
 * provar uma passagem de bastão entre códigos: o velho PAROU num dia e o novo
 * COMEÇOU em seguida = mesma loja que migrou. Prova, offline:
 *   - código "velho" tem dado ATÉ certa data e nada depois (parou);
 *   - código "novo" só tem dado A PARTIR de certa data (começou);
 *   - firstData/lastData/daysWithData corretos; dias sem caixa não contam;
 *   - lastMovement vem do UltimoMovimento; read-only (não grava fechamento).
 *
 * Uso: npm run test:alterdata-filial-timeline
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-timeline-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-timeline-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

function resp(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

async function main() {
  const { AlterdataConnectorService, __setAlterdataTokenHttpForTests } = await import("../src/server/AlterdataConnectorService.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");
  const { default: db } = await import("../src/server/db.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  __setAlterdataTokenHttpForTests(async () => resp(200, { access_token: "tok-1", expires_in: 3600 }));
  AlterdataConnectorService.saveSettings(A, {
    enabled: true, environment: "homolog", rede: "01", filiais: ["1006", "1084"],
    basePattern: "toulon-{module}.apimodaup.com.br",
    authConfig: { clientId: "int@toulon", clientSecret: "s3nh4" },
  });

  // Código VELHO (1006): vendeu de 40 a 30 dias atrás, parou depois.
  // Código NOVO (1084): só passou a vender de 28 dias atrás pra cá.
  const OLD_FIRST = daysAgo(40), OLD_LAST = daysAgo(30);
  const NEW_FIRST = daysAgo(28), NEW_LAST = daysAgo(1);
  const oldDates = new Set([daysAgo(40), daysAgo(35), daysAgo(30)]);
  const newDates = new Set([daysAgo(28), daysAgo(15), daysAgo(1)]);

  __setAlterdataSyncHttpForTests(async (url: string) => {
    // Última movimentação
    const um = url.match(/\/DataCaixa\/UltimoMovimento\/(\d+)/);
    if (um) {
      const last = um[1] === "1006" ? OLD_LAST : NEW_LAST;
      return resp(200, { success: true, data: { data: `${last}T00:00:00`, filial: um[1], finalizado2: 1, turno: 1 } });
    }
    // Fechamento por dia/turno
    const rf = url.match(/\/DataCaixa\/ResumoFecharMovimento\/(\d+)\/(\d{4}-\d{2}-\d{2})\/(\d+)/);
    if (rf) {
      const [, filial, date, turno] = rf;
      // Só turno 1 tem venda (turno 2 sempre vazio).
      if (turno !== "1") return resp(200, { success: true, data: [] });
      const known = filial === "1006" || filial === "1084";
      const has = known && (filial === "1006" ? oldDates.has(date) : newDates.has(date));
      if (has) return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 1000 }] });
      return resp(200, { success: true, data: [{ titulo: "Total de Vendas", valor: 0 }] });
    }
    return resp(200, { success: true, data: [] });
  });

  const old = await AlterdataSyncRunner.filialTimeline(A, "1006", 60);
  const neu = await AlterdataSyncRunner.filialTimeline(A, "1084", 60);

  check("1006 (velho) primeiro dia com venda = 40 dias atrás", old.firstData === OLD_FIRST, `${old.firstData} != ${OLD_FIRST}`);
  check("1006 (velho) último dia com venda = 30 dias atrás (parou)", old.lastData === OLD_LAST, `${old.lastData} != ${OLD_LAST}`);
  check("1006 (velho) 3 dias com venda", old.daysWithData === 3, String(old.daysWithData));
  check("1084 (novo) primeiro dia com venda = 28 dias atrás (começou)", neu.firstData === NEW_FIRST, `${neu.firstData} != ${NEW_FIRST}`);
  check("1084 (novo) último dia com venda = 1 dia atrás", neu.lastData === NEW_LAST, `${neu.lastData} != ${NEW_LAST}`);
  check("1084 (novo) 3 dias com venda", neu.daysWithData === 3, String(neu.daysWithData));
  // Passagem de bastão: o novo começa DEPOIS do velho parar.
  check("handoff: 1084 começa depois de 1006 parar", (neu.firstData || "") > (old.lastData || ""), `${neu.firstData} vs ${old.lastData}`);
  check("1006 última movimentação vem do UltimoMovimento", old.lastMovement === OLD_LAST, String(old.lastMovement));
  check("1084 última movimentação vem do UltimoMovimento", neu.lastMovement === NEW_LAST, String(neu.lastMovement));
  check("amostras trazem só dias com venda (<=6)", old.samples.length === 3 && old.samples.every((s) => s.total > 0), JSON.stringify(old.samples));

  // Filial sem venda nenhuma na janela → tudo null, sem inventar.
  const empty = await AlterdataSyncRunner.filialTimeline(A, "9999", 60);
  check("filial sem venda → firstData/lastData null, 0 dias", empty.firstData === null && empty.lastData === null && empty.daysWithData === 0, JSON.stringify(empty));

  // Isolamento: outra org não vê a timeline desta (sem settings → sem token/erro, mas não vaza dado).
  const B = `org_${randomUUID().slice(0, 8)}`;
  const isolated = await AlterdataSyncRunner.filialTimeline(B, "1006", 5).catch(() => null);
  check("isolamento: org sem conexão não retorna venda da org A", !isolated || (isolated.daysWithData === 0), JSON.stringify(isolated));

  __setAlterdataSyncHttpForTests(null);
  __setAlterdataTokenHttpForTests(null);

  console.log("\n=== TEST: Linha do tempo da filial (migração de código) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
