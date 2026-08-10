/**
 * TEST — PRD 1 (Fala Tu Universal Interaction Layer), fatia de FUNDAÇÃO:
 * envelope canônico de interação + correlação no metering.
 *
 * O `falatu_inbox_items` É o envelope (§9). Esta fatia fecha os campos que
 * faltavam — `channel`, `input_type`, `attachments_json`, `correlation_id` —
 * derivados DETERMINISTICAMENTE na captura, e propaga o `correlation_id` até o
 * contexto de uso de IA (o que popula `ai_usage_log.request_id`, §41/§52).
 *
 * Prova (mocka só interpret — sem chave; derivação/persistência/contexto reais):
 *   - colunas do envelope populadas (channel/input_type/attachments/correlation);
 *   - derivação de channel (whatsapp / explícito / fallback) e input_type;
 *   - attachments FACTUAIS (image/audio) vs texto ([]);
 *   - correlation_id: nova cadeia por padrão; continua thread se o caller passa;
 *   - usageContext carrega correlationId (unit + default);
 *   - a captura seta o correlationId no contexto ANTES do interpret → qualquer
 *     chamada de IA da captura recebe o request_id certo (prova via mirror do
 *     recordUsage, mesmo idioma do test-ai-usage-ledger);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-envelope
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-envelope-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-envelope-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService: FT } = await import("../src/server/FalaTuService.js");
  const { setUsageContext, currentUsageContext } = await import("../src/server/usageContext.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  // Mock de interpret: captura o contexto de uso VIGENTE (pra provar que a
  // captura já correlacionou antes de qualquer IA) e devolve extração NOTE.
  let seenCtx: any = null;
  (FT as any).interpret = async (input: any) => {
    seenCtx = currentUsageContext();
    return { transcription: input.text || "", summary: (input.text || "mídia").slice(0, 20), intent: "NOTE", entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null }, confidence: 0.9, suggestedAction: "-" };
  };
  const lastItem = (org: string) => db.prepare(`SELECT * FROM falatu_inbox_items WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(org) as any;

  // ===== 1. Envelope populado (texto, webapp) =====
  const orgA = mkOrg();
  const r1 = await FT.capture(orgA, "u1", { text: "anota isso aqui" }) as any;
  const i1 = lastItem(orgA);
  check("1.1 channel='falatu_web' (default do operador)", i1.channel === "falatu_web");
  check("1.2 input_type='text'", i1.input_type === "text");
  check("1.3 attachments_json='[]' (texto sem anexo)", i1.attachments_json === "[]");
  check("1.4 correlation_id presente (uuid)", typeof i1.correlation_id === "string" && i1.correlation_id.length >= 8);
  check("1.5 correlation_id == retorno da captura", r1.correlation_id === i1.correlation_id);

  // ===== 2. Derivação de channel =====
  await FT.capture(orgA, "u1", { text: "via whats", source: "whatsapp" });
  check("2.1 source=whatsapp → channel='whatsapp'", lastItem(orgA).channel === "whatsapp");
  await FT.capture(orgA, "u1", { text: "via share", channel: "share_target" });
  check("2.2 channel explícito respeitado", lastItem(orgA).channel === "share_target");
  await FT.capture(orgA, "u1", { text: "canal inválido", channel: "hackerman" });
  check("2.3 channel inválido → fallback falatu_web", lastItem(orgA).channel === "falatu_web");

  // ===== 3. input_type + attachments factuais =====
  await FT.capture(orgA, "u1", { image: { mimeType: "image/jpeg", data: "Zm9v" } });
  const img = lastItem(orgA);
  check("3.1 imagem → input_type='image' + attachment factual", img.input_type === "image" && JSON.parse(img.attachments_json)[0]?.type === "image" && JSON.parse(img.attachments_json)[0]?.mime === "image/jpeg");
  await FT.capture(orgA, "u1", { audio: { mimeType: "audio/ogg", data: "YmFy" } });
  const aud = lastItem(orgA);
  check("3.2 áudio → input_type='audio' + attachment factual", aud.input_type === "audio" && JSON.parse(aud.attachments_json)[0]?.type === "audio");

  // ===== 4. correlation_id: nova cadeia vs continuação de thread (§51) =====
  const c1 = lastItem(orgA).correlation_id;
  await FT.capture(orgA, "u1", { text: "outra entrada" });
  check("4.1 nova captura → nova cadeia (correlation_id diferente)", lastItem(orgA).correlation_id !== c1);
  const chain = randomUUID();
  await FT.capture(orgA, "u1", { text: "continua o caso", correlationId: chain });
  check("4.2 caller passa correlationId → thread continua", lastItem(orgA).correlation_id === chain);

  // ===== 5. usageContext carrega correlationId =====
  setUsageContext({ orgId: "o", userId: "u", module: "falatu", correlationId: "corr-xyz" });
  check("5.1 currentUsageContext().correlationId propagado", currentUsageContext().correlationId === "corr-xyz");
  setUsageContext({ orgId: "o", module: "falatu" });
  check("5.2 sem correlationId → null (default)", currentUsageContext().correlationId == null);

  // ===== 6. Captura correlaciona ANTES do interpret =====
  await FT.capture(orgA, "u1", { text: "prova de contexto" });
  const i6 = lastItem(orgA);
  check("6.1 interpret viu o correlationId da interação (setado antes da IA)", seenCtx?.correlationId === i6.correlation_id);
  check("6.2 interpret viu module='falatu'", seenCtx?.module === "falatu");

  // ===== 7. Metering: mirror do recordUsage grava request_id = correlationId =====
  // Mesmo idioma do test-ai-usage-ledger: o mock injeta uma escrita no ledger
  // que LÊ currentUsageContext().correlationId — exatamente como o recordUsage
  // real (llm.ts) faz — provando que a chamada de IA da captura recebe o
  // request_id correto.
  (FT as any).interpret = async (input: any) => {
    const ctx = currentUsageContext();
    db.prepare(`INSERT INTO ai_usage_log (id, organization_id, user_id, model, kind, module, request_id) VALUES (?, ?, ?, 'mock', 'chat', ?, ?)`)
      .run(randomUUID(), ctx.orgId, ctx.userId, ctx.module, ctx.correlationId || null);
    return { transcription: input.text || "", summary: "s", intent: "NOTE", entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null }, confidence: 0.9, suggestedAction: "-" };
  };
  await FT.capture(orgA, "u1", { text: "gera custo correlacionado" });
  const i7 = lastItem(orgA);
  const usage = db.prepare(`SELECT * FROM ai_usage_log WHERE request_id = ?`).get(i7.correlation_id) as any;
  check("7.1 ledger tem linha com request_id = correlation_id da interação", !!usage);
  check("7.2 linha atribuída à org + module falatu", usage?.organization_id === orgA && usage?.module === "falatu");

  // ===== 8. Isolamento multi-tenant =====
  const orgB = mkOrg();
  await FT.capture(orgB, "ub", { text: "org B" });
  check("8.1 correlation_id de B não colide com A", lastItem(orgB).correlation_id !== i7.correlation_id);
  check("8.2 item de B isolado por org", lastItem(orgB).organization_id === orgB);

  console.log("\n=== TEST: Fala Tu envelope canônico + correlação (PRD 1 — fundação) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu envelope + correlação (PRD 1 fundação) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
