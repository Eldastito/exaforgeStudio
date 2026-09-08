/**
 * TEST — Fala Tu "gravar" pela conversa (FalaTuAskService.converse, F4).
 * Prova que o dono pode GRAVAR pela mesma superfície conversacional, sempre via
 * captura PENDENTE (Fala→Faz→Confere) — nunca escrita direta:
 *   - classify() reconhece verbo de gravar no início → kind 'record'.
 *   - converse(record) cria item PENDENTE (reusa FalaTuService.capture) e devolve
 *     o pendingId; o verbo é retirado do conteúdo gravado.
 *   - converse(pergunta) continua respondendo (0-regressão do F1).
 *   - "anota" sem conteúdo → pede o que gravar.
 *   - isolamento multi-tenant.
 * interpret() é mockado (é o método isolado justamente pra teste sem chave IA).
 *
 * Uso: npm run test:falatu-record
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-record-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-record-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuAskService } = await import("../src/server/FalaTuAskService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");

  // Mock DETERMINÍSTICO do interpret (sem LLM): eco do texto como summary/TASK.
  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: "", summary: String(input?.text || "").slice(0, 80), intent: "TASK",
    entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
    confidence: 0.9, suggestedAction: "",
  });

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    FalaTuService.setOrgEnabled(o, true);
    return o;
  };
  const owner = (org: string) => ({ userId: randomUUID(), email: "dono@toulon.com", role: "owner", organizationId: org });

  const A = mkOrg();
  const donoA = owner(A);

  // ── 1. classify: gravar × perguntar ──
  check("1.1 'anota ...' → record", FalaTuAskService.classify("anota ligar pro contador amanhã", "2026-09-08").kind === "record");
  check("1.2 'grava: ...' → record", FalaTuAskService.classify("grava: comprar embalagens", "2026-09-08").kind === "record");
  check("1.3 'registra ...' → record", FalaTuAskService.classify("registra reunião com fornecedor", "2026-09-08").kind === "record");
  check("1.4 pergunta de vendas NÃO é record", FalaTuAskService.classify("quanto vendi em dinheiro hoje?", "2026-09-08").kind !== "record");
  check("1.5 folga NÃO é record", FalaTuAskService.classify("quem está de folga amanhã?", "2026-09-08").kind === "who_is_off");

  // ── 2. converse(record) → item pendente ──
  const r1 = await FalaTuAskService.converse(A, donoA, "anota ligar pro contador amanhã");
  check("2.1 record → kind record", r1.kind === "record");
  check("2.2 record → devolve pendingId", !!r1.data?.pendingId);
  const item = db.prepare(`SELECT * FROM falatu_inbox_items WHERE id = ?`).get(r1.data?.pendingId) as any;
  check("2.3 item existe e está PENDENTE (Confere, não escrita direta)", item && item.status === "pending");
  check("2.4 isolado na org A", item?.organization_id === A);
  check("2.5 verbo 'anota' foi retirado do conteúdo gravado", item?.content === "ligar pro contador amanhã");
  check("2.6 resposta pede confirmação", /confirme/i.test(r1.answer));

  // ── 3. converse(pergunta) continua respondendo (0-regressão F1) ──
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name) VALUES (?, ?, 'Centro')`).run(store, A);
  const cid = randomUUID();
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, informed_total, status) VALUES (?, ?, ?, '2025-08-31', 900, 'reconciled')`).run(cid, A, store);
  db.prepare(`INSERT INTO retail_daily_closing_items (id, organization_id, closing_id, payment_method, informed_amount) VALUES (?, ?, ?, 'dinheiro', 900)`).run(randomUUID(), A, cid);
  const r2 = await FalaTuAskService.converse(A, donoA, "quanto vendi em dinheiro no dia 31 de agosto de 2025?");
  check("3.1 pergunta → cash_on_day (não record)", r2.kind === "cash_on_day");
  check("3.2 pergunta responde o valor", /900,00/.test(r2.answer));

  // ── 4. "anota" sem conteúdo → pede o que gravar ──
  const r3 = await FalaTuAskService.converse(A, donoA, "anota");
  check("4.1 record vazio → pede o que gravar (não cria item)", r3.kind === "record" && !r3.data?.pendingId && /o que é pra gravar/i.test(r3.answer));

  // ── 5. isolamento: org B não vê o pendente de A ──
  const B = mkOrg();
  const countB = db.prepare(`SELECT COUNT(*) AS n FROM falatu_inbox_items WHERE organization_id = ?`).get(B) as any;
  check("5.1 org B sem itens de A", Number(countB?.n || 0) === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-record: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
