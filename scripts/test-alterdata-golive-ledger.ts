/**
 * TEST — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 3, RF-06/08/17) — ledger + sem catch{}.
 * DB-backed, determinístico. Prova que:
 *   1. `begin` cria uma run com status 'running' e correlation_id único
 *   2. `record` grava resource, com sanitização de segredo em errorMessage
 *   3. `finish` tabula required_failures/optional_failures e computa status:
 *      - 0 falhas required + 0 opcionais → success
 *      - só opcionais falharam → partial_failure
 *      - required falhou → failed
 *   4. Códigos de erro classificados: 401 → ALTERDATA_AUTH, 5xx → ALTERDATA_API,
 *      TypeError → ZAPFLOW_CODE, "configuração" → TOULON_CONFIGURATION
 *   5. sanitizeErrorMessage esconde Bearer, enc:, client_secret= etc.
 *   6. Runner chama begin→record→finish end-to-end quando roda contra um
 *      transport mockado — Referencia, Saldo, DataCaixa, VendaMalote, Comissao,
 *      CRM aparecem no ledger, com CodigoDeBarras 'skipped_by_policy' quando
 *      rede vazia e CRM 'skipped_by_policy' com error_code LGPD_APPROVAL
 *      quando opt-in off.
 *   7. Falha do módulo NÃO derruba o sync (mantém tolerância) mas AGORA fica
 *      no ledger — nada de {imported:0} silencioso.
 *
 * Uso: npm run test:alterdata-golive-ledger
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-alterdata-ledger-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-alterdata-ledger-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const {
    AlterdataSyncLedgerService,
    sanitizeErrorMessage,
    classifyError,
    extractHttpStatus,
  } = await import("../src/server/AlterdataSyncLedgerService.js");

  const ORG = "org-ledger-1";

  // ═══════ 1. begin cria run running com correlationId ═══════
  const h1 = AlterdataSyncLedgerService.begin(ORG, "homolog", "manual", "user-a");
  const run1 = db.prepare(`SELECT * FROM alterdata_sync_runs WHERE id=?`).get(h1.runId) as any;
  check("1.1 begin cria run", !!run1);
  check("1.2 status=running", run1.status === "running");
  check("1.3 environment=homolog", run1.environment === "homolog");
  check("1.4 trigger=manual", run1.trigger === "manual");
  check("1.5 correlationId gravado", run1.correlation_id === h1.correlationId);
  check("1.6 initiated_by preservado", run1.initiated_by === "user-a");

  // ═══════ 2. record grava resource + sanitiza ═══════
  h1.record({
    module: "supply", resource: "Referencia", required: true,
    status: "server_error", httpStatus: 500,
    errorCode: "ALTERDATA_API",
    errorMessage: "Bearer AAAA.BBBB.CCCC failed with token enc:XYZ12345678901234567890",
  });
  const r1 = db.prepare(`SELECT * FROM alterdata_sync_run_resources WHERE run_id=?`).get(h1.runId) as any;
  check("2.1 resource gravado", !!r1);
  check("2.2 status=server_error", r1.status === "server_error");
  check("2.3 error_code=ALTERDATA_API", r1.error_code === "ALTERDATA_API");
  check("2.4 error_message não contém Bearer AAAA",
    !String(r1.error_message_sanitized).includes("AAAA.BBBB.CCCC"),
    `got: ${r1.error_message_sanitized}`);
  check("2.5 error_message contém 'Bearer <redacted>'",
    String(r1.error_message_sanitized).includes("Bearer <redacted>"));
  check("2.6 error_message não contém 'enc:XYZ'",
    !String(r1.error_message_sanitized).includes("XYZ12345678901234567890"));

  // ═══════ 3. finish computa status ═══════
  // Só a resource acima (required + server_error) → failed
  const finalStatus1 = h1.finish();
  const run1After = db.prepare(`SELECT * FROM alterdata_sync_runs WHERE id=?`).get(h1.runId) as any;
  check("3.1 finish devolve 'failed' quando required falhou", finalStatus1 === "failed");
  check("3.2 required_failures=1", run1After.required_failures === 1);
  check("3.3 optional_failures=0", run1After.optional_failures === 0);
  check("3.4 finished_at preenchido", !!run1After.finished_at);

  // Run 2: só opcional falhou → partial_failure
  const h2 = AlterdataSyncLedgerService.begin(ORG, "homolog", "scheduler");
  h2.record({ module: "supply", resource: "Referencia", required: true, status: "ready", imported: 100 });
  h2.record({ module: "crm", resource: "ClienteMalote", required: false, status: "server_error", errorCode: "ALTERDATA_API" });
  const finalStatus2 = h2.finish();
  check("3.5 partial_failure quando só opcional falhou", finalStatus2 === "partial_failure");
  const run2 = db.prepare(`SELECT * FROM alterdata_sync_runs WHERE id=?`).get(h2.runId) as any;
  check("3.6 required_failures=0, optional_failures=1",
    run2.required_failures === 0 && run2.optional_failures === 1);

  // Run 3: só sucesso → success
  const h3 = AlterdataSyncLedgerService.begin(ORG, "prod", "resync");
  h3.record({ module: "supply", resource: "Referencia", required: true, status: "ready", imported: 50 });
  h3.record({ module: "supply", resource: "Saldo", filial: "001", required: true, status: "empty_but_valid" });
  h3.record({ module: "crm", resource: "ClienteMalote", required: false, status: "skipped_by_policy", errorCode: "LGPD_APPROVAL" });
  const finalStatus3 = h3.finish();
  check("3.7 success quando tudo ready/empty/skipped_by_policy", finalStatus3 === "success");

  // Isolamento: correlation_ids únicos
  check("3.8 correlation_ids únicos entre runs",
    new Set([h1.correlationId, h2.correlationId, h3.correlationId]).size === 3);

  // ═══════ 4. classifyError ═══════
  check("4.1 HTTP 401 → ALTERDATA_AUTH",
    classifyError(new Error("HTTP 401 unauthorized"), 401) === "ALTERDATA_AUTH");
  check("4.2 HTTP 500 → ALTERDATA_API",
    classifyError(new Error("HTTP 500 boom"), 500) === "ALTERDATA_API");
  check("4.3 TypeError → ZAPFLOW_CODE",
    classifyError(new TypeError("undefined is not a function")) === "ZAPFLOW_CODE");
  check("4.4 msg com 'configuração' → TOULON_CONFIGURATION",
    classifyError(new Error("filial não configurada")) === "TOULON_CONFIGURATION");
  check("4.5 msg com 'lgpd' → LGPD_APPROVAL",
    classifyError(new Error("aprovação LGPD ausente")) === "LGPD_APPROVAL");
  check("4.6 msg com 'guardian' → ALTERDATA_AUTH",
    classifyError(new Error("Alterdata Guardian: token inválido")) === "ALTERDATA_AUTH");
  check("4.7 desconhecido → UNKNOWN",
    classifyError(new Error("qualquer coisa")) === "UNKNOWN");

  // ═══════ 5. sanitizeErrorMessage ═══════
  check("5.1 sanitize corta Bearer",
    !sanitizeErrorMessage("Bearer abcXYZ.token123").includes("abcXYZ.token123"));
  check("5.2 sanitize corta enc:",
    !sanitizeErrorMessage("erro enc:AAAAAAAAAAAAAAAAAAAAAAA==").includes("AAAAAAAAAAAAAAAAAAAAAAA"));
  check("5.3 sanitize corta client_secret",
    sanitizeErrorMessage("client_secret=my-super-secret&other=x").includes("<redacted>") &&
    !sanitizeErrorMessage("client_secret=my-super-secret&other=x").includes("my-super-secret"));
  check("5.4 sanitize preserva mensagem legível",
    sanitizeErrorMessage("HTTP 500 upstream broken").includes("HTTP 500"));
  check("5.5 sanitize corta em 500 chars",
    sanitizeErrorMessage("X".repeat(2000)).length === 500);

  // ═══════ 6. extractHttpStatus ═══════
  check("6.1 extract 'HTTP 401' → 401", extractHttpStatus("failed HTTP 401") === 401);
  check("6.2 extract 'HTTP 500' → 500", extractHttpStatus(new Error("HTTP 500 boom")) === 500);
  check("6.3 sem HTTP → null", extractHttpStatus("just a message") === null);

  // ═══════ 7. Runner end-to-end contra transport mockado ═══════
  // Mocka o transport HTTP do sync service pra devolver respostas rápidas.
  const { AlterdataConnectorService } = await import("../src/server/AlterdataConnectorService.js");
  const { AlterdataSyncRunner } = await import("../src/server/AlterdataSyncRunner.js");
  const { __setAlterdataSyncHttpForTests } = await import("../src/server/AlterdataSyncService.js");

  const ORG2 = "org-ledger-runner";
  AlterdataConnectorService.saveSettings(ORG2, {
    enabled: true,
    environment: "homolog",
    authConfig: { clientId: "x", clientSecret: "y" },
    basePattern: "toulon-{module}.apimodaup.com.br",
    // sem rede → CodigoDeBarras vai gerar skipped_by_policy
    filiais: ["001"],
    // sem priceTable → Preco vai gerar skipped_by_policy
  });
  AlterdataConnectorService.setAccessToken(ORG2, "TOKEN-XYZ", new Date(Date.now() + 3600_000));

  // Mock: Referencia OK, Saldo OK, tudo mais dá 500. Simula falha em módulos
  // opcionais → partial_failure com erros registrados no ledger.
  const resp = (status: number, body: any) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_n: string) => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  __setAlterdataSyncHttpForTests(async (url: string) => {
    if (url.includes("/api/v1/Referencia/versao/")) return resp(200, { items: [], totalPages: 1 });
    if (url.includes("/api/v1/Saldo/versao/")) return resp(200, { items: [], totalPages: 1 });
    // Tudo mais: 500
    return resp(500, "boom");
  });

  const summary = await AlterdataSyncRunner.runOrg(ORG2, { manual: true });
  check("7.1 runOrg completa sem throw (tolerância preservada)", !!summary);

  const runs = db.prepare(
    `SELECT * FROM alterdata_sync_runs WHERE organization_id=? ORDER BY started_at DESC LIMIT 1`
  ).all(ORG2) as any[];
  check("7.2 run criada", runs.length === 1);
  const runId = runs[0].id;
  check("7.3 correlation_id preenchido", !!runs[0].correlation_id);
  // sales/DataCaixa e sales/VendaMalote são módulos required (policy Toulon).
  // Como o mock devolveu 500 pra eles, o run inteiro fecha 'failed'. Tolerância
  // do runtime preservada (não lançou); o gate de go-live (RF-10, PR 4) usa o
  // ledger pra bloquear.
  check("7.4 status = failed (sales required quebrou)",
    runs[0].status === "failed",
    `got: ${runs[0].status}`);
  check("7.4b required_failures > 0",
    Number(runs[0].required_failures) > 0,
    `got: ${runs[0].required_failures}`);

  const resources = db.prepare(
    `SELECT module, resource, filial, required, status, error_code FROM alterdata_sync_run_resources
     WHERE run_id=? ORDER BY started_at ASC`
  ).all(runId) as any[];

  check("7.5 pelo menos 5 resources gravados",
    resources.length >= 5,
    `got ${resources.length}: ${JSON.stringify(resources.map(r=>r.resource))}`);

  const byResource = new Map<string, any>();
  for (const r of resources) byResource.set(`${r.module}:${r.resource}`, r);

  check("7.6 supply/Referencia = ready ou empty_but_valid",
    ["ready", "empty_but_valid"].includes(byResource.get("supply:Referencia")?.status));

  check("7.7 supply/CodigoDeBarras skipped_by_policy (sem rede)",
    byResource.get("supply:CodigoDeBarras")?.status === "skipped_by_policy");

  check("7.8 supply/Saldo (filial 001) = ready ou empty_but_valid",
    ["ready", "empty_but_valid"].includes(byResource.get("supply:Saldo")?.status));

  check("7.9 price/Preco skipped_by_policy (sem priceTable)",
    byResource.get("price:Preco")?.status === "skipped_by_policy");

  const salesDataCaixa = byResource.get("sales:DataCaixa");
  check("7.10 sales/DataCaixa gravado", !!salesDataCaixa);
  // O DataCaixa é required=1 e o transport devolveu 500 → server_error
  check("7.11 sales/DataCaixa = server_error + error_code",
    salesDataCaixa?.status === "server_error" && !!salesDataCaixa?.error_code,
    `got: ${salesDataCaixa?.status} / ${salesDataCaixa?.error_code}`);

  // CRM só entra se opt-in — não está ligado, então skipped_by_policy
  const crm = byResource.get("crm:ClienteMalote");
  check("7.12 crm/ClienteMalote skipped_by_policy + LGPD_APPROVAL",
    crm?.status === "skipped_by_policy" && crm?.error_code === "LGPD_APPROVAL");

  // Nenhum error_message vaza TOKEN-XYZ
  const anyLeak = resources.some(r =>
    r.error_message_sanitized && String(r.error_message_sanitized).includes("TOKEN-XYZ"));
  check("7.13 nenhum error_message vaza TOKEN-XYZ", !anyLeak);

  // ═══════ 8. listRecentRuns / getRun ═══════
  const list = AlterdataSyncLedgerService.listRecentRuns(ORG2, "homolog", 5);
  check("8.1 listRecentRuns devolve a run recém-criada",
    list.length >= 1 && list[0].id === runId);
  check("8.2 resource_count > 0", Number(list[0].resource_count) > 0);
  const detail = AlterdataSyncLedgerService.getRun(runId);
  check("8.3 getRun devolve run + resources",
    !!detail && detail.run.id === runId && detail.resources.length === resources.length);

  __setAlterdataSyncHttpForTests(null);

  // ─── Relatório final ───
  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks OK`);
  for (const r of results) {
    const line = `  ${r.ok ? "✓" : "✗"} ${r.name}`;
    console.log(r.ok ? line : `${line} — ${r.detail ?? ""}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
