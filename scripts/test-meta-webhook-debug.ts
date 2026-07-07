/**
 * TEST — Console de diagnóstico de webhooks Meta.
 * Uso: npm run test:meta-webhook-debug
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-metadbg-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-metadbg-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { MetaWebhookLogService } = await import("../src/server/MetaWebhookLogService.js");

  // 1. Record básico
  const id1 = MetaWebhookLogService.record({
    method: "GET",
    sourceIp: "192.168.1.1",
    userAgent: "facebookexternalua",
    object: "verify",
    payload: { mode: "subscribe", token: "<presente>" },
    headers: { "content-type": "application/json", "x-hub-signature-256": "abc" },
  });
  check("1.1 grava hit e devolve id", typeof id1 === "string" && id1.length > 0);

  // 2. Record POST com objeto Instagram
  const id2 = MetaWebhookLogService.record({
    method: "POST",
    sourceIp: "1.2.3.4",
    object: "instagram",
    payload: { object: "instagram", entry: [{ id: "17841401808284969", messaging: [{ sender: { id: "111" }, message: { text: "oi" } }] }] },
    headers: { "content-type": "application/json" },
  });
  check("1.2 grava hit POST", typeof id2 === "string");

  // 3. Marca como processado
  MetaWebhookLogService.markProcessed(id2!);
  const listed = MetaWebhookLogService.list(10);
  const found = listed.find((h) => h.id === id2);
  check("1.3 markProcessed vira processed=1", found?.processed === 1);

  // 4. Marca como falhado
  const id3 = MetaWebhookLogService.record({ method: "POST", object: "desconhecido", payload: { object: "coisa_estranha" } });
  MetaWebhookLogService.markFailed(id3!, "payload.object desconhecido: coisa_estranha");
  const failed = MetaWebhookLogService.list(10).find((h) => h.id === id3);
  check("1.4 markFailed grava erro", failed?.error?.includes("desconhecido") === true);

  // 5. Listagem em ordem DESC
  check("1.5 listagem tem 3 entradas", MetaWebhookLogService.list(10).length === 3);
  check("1.6 primeira entrada é a mais recente", MetaWebhookLogService.list(10)[0].id === id3);

  // 6. Filtra headers sensíveis
  const withAuth = MetaWebhookLogService.record({
    method: "POST", object: "instagram",
    payload: { object: "instagram" },
    headers: { "content-type": "application/json", "authorization": "Bearer SEGREDO", "x-hub-signature-256": "sig123" },
  });
  const withAuthRow = MetaWebhookLogService.list(10).find((h) => h.id === withAuth);
  const headers = JSON.parse(withAuthRow?.headers_json || "{}");
  check("1.7 header authorization NÃO é salvo", !("authorization" in headers));
  check("1.8 header x-hub-signature-256 É salvo", "x-hub-signature-256" in headers);

  // 7. Payload gigante é truncado
  const huge = "A".repeat(20 * 1024);
  const idHuge = MetaWebhookLogService.record({ method: "POST", object: "instagram", payload: { object: "instagram", huge } });
  const hugeRow = MetaWebhookLogService.list(10).find((h) => h.id === idHuge);
  check("1.9 payload > 10KB é truncado", (hugeRow?.payload_json?.length || 0) < 12000 && hugeRow?.payload_json?.includes("[truncated]"));

  // 8. Summary
  const s = MetaWebhookLogService.summary();
  check("1.10 summary tem last24h > 0", s.last24h > 0);
  check("1.11 summary agrega por object", (s.byObject?.instagram || 0) >= 2);
  check("1.12 summary agrega por method", (s.byMethod?.POST || 0) >= 3 && (s.byMethod?.GET || 0) >= 1);

  console.log("\n──── Resultados ────");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length} verificações, ${failures} falha(s).`);
  process.exit(failures > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
