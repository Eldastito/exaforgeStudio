/**
 * TEST — Comigo/Cadastro por Áudio (Gap A do levantamento autônomos, ADR-088 D2).
 *
 * Prova, offline e em banco temporário (SEM bater no Whisper/LLM real):
 *   - buffer < 512 bytes → source='no_transcript', sem chamada
 *   - sem AI configurado → source='no_transcript', sem chamada
 *   - cap por org/dia estourado → source='cap_reached', capReached=true, Whisper NÃO chamado
 *   - transcribeFn lança → source='no_transcript'; cap NÃO é consumido
 *   - transcribeFn retorna vazio → source='no_transcript'
 *   - LLM devolve itens válidos → source='llm', normaliza name/type/price
 *   - LLM devolve preço "combinar" → price=null (não force número)
 *   - LLM devolve type inválido → força 'product' (padrão seguro)
 *   - LLM devolve mais de 20 itens → trunca em 20
 *   - LLM devolve JSON malformado → source='empty', transcript preservado
 *   - LLM lança → source='empty', transcript preservado, cap consumido (Whisper rodou)
 *   - Isolamento entre orgs: cap de A não afeta B; menu de A não vaza pra B
 *
 * Uso: npm run test:comigo-audio-catalog
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-audio-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-audio-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoAudioCatalogService, _internals } = await import("../src/server/ComigoAudioCatalogService.js");

  // Buffer > 512 bytes (limite de "áudio de verdade" no service).
  const bigBuf = Buffer.alloc(1024, 1);
  const tinyBuf = Buffer.alloc(100, 1);

  // ── Setup: 2 orgs (isolamento) ────────────────────────────────────────────
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_audio_catalog_daily_cap) VALUES (?, ?, 'Loja A', 'active', 10)`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_audio_catalog_daily_cap) VALUES (?, ?, 'Loja B', 'active', 30)`).run(randomUUID(), orgB);

  // ── 1. Buffer muito pequeno → sem chamada ────────────────────────────────
  let transcribeCalls = 0, chatCalls = 0;
  _internals.setAIConfiguredFn(() => true);
  _internals.setTranscribeFn(async () => { transcribeCalls++; return "transcrito"; });
  _internals.setChatFn(async () => { chatCalls++; return '{"items":[]}'; });

  const tiny = await ComigoAudioCatalogService.parseAudio(orgA, tinyBuf, "audio/webm");
  check("buffer minúsculo → source=no_transcript", tiny.source === "no_transcript");
  check("buffer minúsculo → transcribeFn NÃO chamado", transcribeCalls === 0);
  check("buffer minúsculo → chatFn NÃO chamado", chatCalls === 0);

  // ── 2. Sem AI configurado → no_transcript ────────────────────────────────
  _internals.setAIConfiguredFn(() => false);
  const noAi = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("sem AI → source=no_transcript", noAi.source === "no_transcript");
  check("sem AI → transcribeFn NÃO chamado", transcribeCalls === 0);

  // ── 3. transcribeFn retorna vazio → no_transcript ────────────────────────
  _internals.setAIConfiguredFn(() => true);
  transcribeCalls = 0; chatCalls = 0;
  _internals.setTranscribeFn(async () => { transcribeCalls++; return "  "; });
  const emptyTx = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("transcrição vazia → source=no_transcript", emptyTx.source === "no_transcript");
  check("transcrição vazia → chatFn NÃO chamado", chatCalls === 0);
  // Cap NÃO deve ser consumido (não gastou LLM).
  const meterAfterEmptyTx = (db.prepare(`SELECT COUNT(*) c FROM ai_usage_log WHERE organization_id=? AND kind='comigo_audio_catalog'`).get(orgA) as any).c;
  check("transcrição vazia não consome cap", meterAfterEmptyTx === 0);

  // ── 4. transcribeFn lança → no_transcript, cap intocado ──────────────────
  chatCalls = 0;
  _internals.setTranscribeFn(async () => { throw new Error("whisper_down"); });
  const thrownTx = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("transcribeFn lança → source=no_transcript", thrownTx.source === "no_transcript");
  check("transcribeFn lança → chatFn NÃO chamado", chatCalls === 0);
  const meterAfterThrownTx = (db.prepare(`SELECT COUNT(*) c FROM ai_usage_log WHERE organization_id=? AND kind='comigo_audio_catalog'`).get(orgA) as any).c;
  check("transcribeFn lança não consome cap", meterAfterThrownTx === 0);

  // ── 5. LLM devolve 3 itens válidos → source=llm, normaliza ───────────────
  _internals.setTranscribeFn(async () => "bolo de pote pê 8 reais galeto inteiro 45 e água mineral 3");
  chatCalls = 0;
  _internals.setChatFn(async (_prompt, opts) => {
    chatCalls++;
    check("chatFn recebe json:true", opts?.json === true);
    check("chatFn recebe temperature:0", opts?.temperature === 0);
    return JSON.stringify({ items: [
      { name: "Bolo de Pote P", price: 8, type: "product", description: null, confidence: 90 },
      { name: "Galeto Inteiro", price: 45.0, type: "product", description: "com farofa", confidence: 85 },
      { name: "Água Mineral", price: 3, type: "product", description: null, confidence: 95 },
    ]});
  });
  const ok = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("LLM OK → source=llm", ok.source === "llm");
  check("LLM OK → 3 items", ok.items.length === 3);
  check("LLM OK → nome preservado", ok.items[0].name === "Bolo de Pote P");
  check("LLM OK → preço number", ok.items[0].price === 8);
  check("LLM OK → type product", ok.items[0].type === "product");
  check("LLM OK → transcript preservado", ok.transcript.includes("bolo de pote"));
  check("LLM OK → chatFn chamado 1 vez", chatCalls === 1);

  // ── 6. Preço "combinar" / string → price=null ────────────────────────────
  _internals.setChatFn(async () => JSON.stringify({ items: [
    { name: "Bolo Custom", price: "combinar", type: "product", confidence: 70 },
    { name: "Consulta", price: null, type: "service", confidence: 80 },
    { name: "Item Zero", price: 0, type: "product", confidence: 60 },  // 0 tb vira null
    { name: "Item Negativo", price: -5, type: "product", confidence: 50 },
  ]}));
  const noPrices = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("preço string 'combinar' → null", noPrices.items[0].price === null);
  check("preço null explícito → null", noPrices.items[1].price === null);
  check("preço 0 → null", noPrices.items[2].price === null);
  check("preço negativo → null", noPrices.items[3].price === null);
  check("type service preservado", noPrices.items[1].type === "service");

  // ── 7. type inválido → force 'product' ────────────────────────────────────
  _internals.setChatFn(async () => JSON.stringify({ items: [
    { name: "X", price: 10, type: "coisa_maluca", confidence: 90 },
    { name: "Y", price: 5, type: "reservation", confidence: 90 },   // não é aceito nesse serviço
  ]}));
  const badTypes = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("type maluco → force product", badTypes.items[0].type === "product");
  check("type reservation (não aceito) → force product", badTypes.items[1].type === "product");

  // ── 8. Truncamento em 20 itens ───────────────────────────────────────────
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `Item ${i}`, price: i + 1, type: "product", confidence: 80 }));
  _internals.setChatFn(async () => JSON.stringify({ items: many }));
  const truncated = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("30 itens vindos do LLM → trunca em 20", truncated.items.length === 20);

  // ── 9. JSON malformado → empty, transcript preservado ────────────────────
  _internals.setChatFn(async () => "não é json {{{");
  const bad = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("JSON malformado → source=empty", bad.source === "empty");
  check("JSON malformado → items=[]", bad.items.length === 0);
  check("JSON malformado → transcript preservado", bad.transcript.length > 0);

  // ── 10. LLM lança → empty, transcript preservado, cap ainda consumido ────
  const meterBeforeThrow = (db.prepare(`SELECT COUNT(*) c FROM ai_usage_log WHERE organization_id=? AND kind='comigo_audio_catalog'`).get(orgA) as any).c;
  _internals.setChatFn(async () => { throw new Error("rate_limit"); });
  const thrown = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("LLM lança → source=empty", thrown.source === "empty");
  check("LLM lança → transcript preservado", thrown.transcript.length > 0);
  const meterAfterThrow = (db.prepare(`SELECT COUNT(*) c FROM ai_usage_log WHERE organization_id=? AND kind='comigo_audio_catalog'`).get(orgA) as any).c;
  // Whisper rodou → gastou o cap; LLM lançou depois. Cap CONSUMIDO (Whisper é caro).
  check("LLM lança mas Whisper rodou → cap consumido", meterAfterThrow === meterBeforeThrow + 1);

  // ── 11. Cap por org/dia → cap_reached; Whisper NÃO chamado ───────────────
  // orgA cap=10; meter atual pós-passos 5–10 é 6. Preenche pra estourar.
  const meterNow = (db.prepare(`SELECT COUNT(*) c FROM ai_usage_log WHERE organization_id=? AND kind='comigo_audio_catalog'`).get(orgA) as any).c;
  for (let i = meterNow; i < 10; i++) {
    db.prepare(`INSERT INTO ai_usage_log (id, organization_id, model, kind) VALUES (?, ?, 'meter', 'comigo_audio_catalog')`).run(randomUUID(), orgA);
  }
  transcribeCalls = 0; chatCalls = 0;
  _internals.setTranscribeFn(async () => { transcribeCalls++; return "x"; });
  _internals.setChatFn(async () => { chatCalls++; return '{"items":[]}'; });
  const capped = await ComigoAudioCatalogService.parseAudio(orgA, bigBuf, "audio/webm");
  check("cap estourado → source=cap_reached", capped.source === "cap_reached");
  check("cap estourado → capReached=true", capped.capReached === true);
  check("cap estourado → Whisper NÃO chamado", transcribeCalls === 0);
  check("cap estourado → chatFn NÃO chamado", chatCalls === 0);

  // ── 12. Isolamento: orgB (cap 30) chama normalmente ──────────────────────
  transcribeCalls = 0; chatCalls = 0;
  _internals.setTranscribeFn(async () => { transcribeCalls++; return "pizza 30 reais"; });
  _internals.setChatFn(async () => { chatCalls++; return JSON.stringify({ items: [{ name: "Pizza", price: 30, type: "product", confidence: 90 }] }); });
  const bOk = await ComigoAudioCatalogService.parseAudio(orgB, bigBuf, "audio/webm");
  check("orgB não é afetada pelo cap da orgA", transcribeCalls === 1 && chatCalls === 1);
  check("orgB → source=llm", bOk.source === "llm" && bOk.items.length === 1);
  const statusB = ComigoAudioCatalogService.status(orgB);
  check("orgB status cap=30", statusB.cap === 30);
  check("orgB status used=1", statusB.used === 1);
  check("orgB status remaining=29", statusB.remaining === 29);

  // ── 13. Nome vazio no LLM → descarta ─────────────────────────────────────
  _internals.setChatFn(async () => JSON.stringify({ items: [
    { name: "", price: 10, type: "product", confidence: 90 },
    { name: "   ", price: 20, type: "product", confidence: 90 },
    { name: "Válido", price: 15, type: "product", confidence: 85 },
  ]}));
  const emptyName = await ComigoAudioCatalogService.parseAudio(orgB, bigBuf, "audio/webm");
  check("nomes vazios descartados", emptyName.items.length === 1);
  check("só item válido sobrevive", emptyName.items[0].name === "Válido");

  // Reseta pra não vazar entre suites.
  _internals.setChatFn(null);
  _internals.setTranscribeFn(null);
  _internals.setAIConfiguredFn(null);

  // ── Relatório ────────────────────────────────────────────────────────────
  console.log("\n=== TEST: Comigo — Cadastro por Áudio (Gap A, ADR-088 D2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Cadastro por Áudio OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
