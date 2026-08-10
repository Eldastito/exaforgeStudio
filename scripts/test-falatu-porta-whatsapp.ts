/**
 * TEST — ADR-160 F8 (Onda A): porta I/O, 4ª fatia — PARIDADE DE CANAL (WhatsApp).
 *
 * Antes da F8, o bridge de listas (F7) só disparava no painel: `listType` era um
 * override exclusivo da UI, e o confirm via WhatsApp passa overrides VAZIOS — então
 * uma lista de compras ditada no WhatsApp caía como 'general' e nunca virava
 * requisição. A F8 classifica o tipo de lista DETERMINISTICAMENTE na captura e o
 * PERSISTE, pra o choke-point (confirm) reconhecer compras em QUALQUER canal.
 *
 * Prova (mocka só interpret — sem chave; classificador/persistência/bridge reais):
 *   - classifyFalaTuListType: cues de compra→shopping; resto→general (unit);
 *   - captura persiste entities_json.listType (base é o texto do humano);
 *   - PARIDADE: "anota lista de compras…" + "confere" no WhatsApp (handle() real,
 *     overrides vazios) espelha na requisição canônica + reply mostra o desfecho;
 *   - lista não-compras via WhatsApp NÃO vira requisição;
 *   - override do painel ainda vence (shopping→general bloqueia; general→shopping
 *     dispara) — web intacto;
 *   - flag off = 0 regressão; TASK via WhatsApp segue espelhando (F5) + reply.
 *
 * Uso: npm run test:falatu-porta-whatsapp
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-porta-wa-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-porta-wa-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService: FT, classifyFalaTuListType } = await import("../src/server/FalaTuService.js");
  const { FalaTuWhatsAppService: WA } = await import("../src/server/FalaTuWhatsAppService.js");

  // Mock da extração: "tarefa" → TASK; senão LIST com itens após ":". A
  // transcrição é o próprio texto → o classificador (real) roda em cima dele.
  (FT as any).interpret = async (input: any) => {
    const text = String(input.text || "");
    const base = { transcription: text, summary: text.slice(0, 40), confidence: 0.9, suggestedAction: "s" };
    if (/tarefa/i.test(text)) return { ...base, intent: "TASK", entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null } };
    const items = text.includes(":") ? text.split(":")[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    return { ...base, intent: "LIST", entities: { people: [], projects: [], actions: [], listItems: items, eventDate: null, eventTime: null } };
  };

  let orgSeq = 0;
  const mkOrg = (opts: { lists?: boolean; tasks?: boolean } = {}) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, falatu_bridge_lists_enabled, falatu_bridge_tasks_enabled) VALUES (?, ?, 'X', 'active', ?, ?)`)
      .run(randomUUID(), id, opts.lists ? 1 : 0, opts.tasks ? 1 : 0);
    FT.setOrgEnabled(id, true);
    return id;
  };
  const mkOwner = (org: string) => {
    const id = randomUUID(); const phone = `55119${String(1000000 + orgSeq++).slice(-7)}`;
    db.prepare("INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'Owner', ?, ?, 'owner', 'active')").run(id, org, `${id}@x.com`, phone);
    return { id, phone };
  };
  const mkProduct = (org: string, name: string) => db.prepare(`INSERT INTO products_services (id, organization_id, type, name, active) VALUES (?, ?, 'product', ?, 1)`).run(randomUUID(), org, name);
  const reqCount = (org: string) => (db.prepare(`SELECT COUNT(*) n FROM purchase_requisitions WHERE organization_id = ?`).get(org) as any).n;
  const canonTasks = (org: string) => (db.prepare(`SELECT COUNT(*) n FROM tasks WHERE organization_id = ?`).get(org) as any).n;
  const lastListType = (org: string) => { const r = db.prepare(`SELECT entities_json FROM falatu_inbox_items WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(org) as any; try { return JSON.parse(r.entities_json).listType; } catch { return undefined; } };

  // ===== 1. Classificador (unit) =====
  check("classify: 'comprar leite e café' → shopping", classifyFalaTuListType("comprar leite e café") === "shopping");
  check("classify: 'repor estoque da loja' → shopping", classifyFalaTuListType("repor estoque da loja") === "shopping");
  check("classify: 'lista de compras do mês' → shopping", classifyFalaTuListType("lista de compras do mês") === "shopping");
  check("classify: 'material de limpeza' → shopping", classifyFalaTuListType("material de limpeza") === "shopping");
  check("classify: 'pauta da reunião de segunda' → general", classifyFalaTuListType("pauta da reunião de segunda") === "general");
  check("classify: 'roteiro da viagem' → general", classifyFalaTuListType("roteiro da viagem") === "general");
  check("classify: vazio → general", classifyFalaTuListType("") === "general");

  // ===== 2. Captura persiste listType (base = texto do humano) =====
  const orgCap = mkOrg(); const uCap = mkOwner(orgCap);
  await FT.capture(orgCap, uCap.id, { text: "lista de compras: leite, café" });
  check("captura: entities_json.listType = shopping (cue de compra)", lastListType(orgCap) === "shopping");
  await FT.capture(orgCap, uCap.id, { text: "pauta da reunião: abertura, metas" });
  check("captura: entities_json.listType = general (sem cue)", lastListType(orgCap) === "general");

  // ===== 3. PARIDADE: WhatsApp handle() end-to-end espelha lista de compras =====
  const orgWA = mkOrg({ lists: true }); const uWA = mkOwner(orgWA);
  mkProduct(orgWA, "Leite Integral"); mkProduct(orgWA, "Café em pó");
  const cap = await WA.handle(orgWA, uWA.phone, "anota lista de compras: leite, café");
  check("WA: capturou a lista (pendente)", cap.handled === true);
  const conf = await WA.handle(orgWA, uWA.phone, "confere");
  check("WA: confirmou (handled)", conf.handled === true);
  check("WA: lista de compras virou requisição canônica (paridade de canal!)", reqCount(orgWA) === 1);
  check("WA: reply mostra o desfecho do bridge (requisição)", /requisi[çc][aã]o de compras/i.test(conf.reply));
  check("WA: silo falatu_lists com bridged_requisition_id", (db.prepare(`SELECT bridged_requisition_id b FROM falatu_lists WHERE organization_id = ?`).get(orgWA) as any)?.b != null);

  // ===== 4. WhatsApp lista NÃO-compras não vira requisição =====
  const orgWG = mkOrg({ lists: true }); const uWG = mkOwner(orgWG);
  mkProduct(orgWG, "Leite Integral");
  await WA.handle(orgWG, uWG.phone, "anota pauta da reunião: abertura, metas");
  const confG = await WA.handle(orgWG, uWG.phone, "confere");
  check("WA: lista 'general' não vira requisição", reqCount(orgWG) === 0 && !/requisi/i.test(confG.reply));

  // ===== 5. Override do painel ainda vence (web intacto) =====
  const orgOv = mkOrg({ lists: true }); const uOv = mkOwner(orgOv);
  mkProduct(orgOv, "Leite Integral");
  const capShop = await FT.capture(orgOv, uOv.id, { text: "lista de compras: leite" });
  FT.confirm(orgOv, uOv.id, (capShop as any).id, { listType: "general" }); // painel força general
  check("web override: shopping→general bloqueia o bridge", reqCount(orgOv) === 0);
  const capGen = await FT.capture(orgOv, uOv.id, { text: "coisas: leite" }); // classificado general
  FT.confirm(orgOv, uOv.id, (capGen as any).id, { listType: "shopping" }); // painel força shopping
  check("web override: general→shopping dispara o bridge", reqCount(orgOv) === 1);

  // ===== 6. Flag off = 0 regressão =====
  const orgOff = mkOrg({ lists: false }); const uOff = mkOwner(orgOff);
  mkProduct(orgOff, "Leite Integral");
  await WA.handle(orgOff, uOff.phone, "anota lista de compras: leite");
  await WA.handle(orgOff, uOff.phone, "confere");
  check("flag off: WhatsApp shopping não vira requisição", reqCount(orgOff) === 0);

  // ===== 7. TASK via WhatsApp segue espelhando (F5) + reply surfacing =====
  const orgT = mkOrg({ tasks: true }); const uT = mkOwner(orgT);
  await WA.handle(orgT, uT.phone, "anota tarefa: ligar pro contador");
  const confT = await WA.handle(orgT, uT.phone, "confere");
  check("WA: TASK espelha no quadro canônico (F5 via WhatsApp)", canonTasks(orgT) === 1);
  check("WA: reply mostra o desfecho (quadro de tarefas)", /quadro de tarefas/i.test(confT.reply));

  console.log("\n=== TEST: Fala Tu porta I/O — paridade de canal WhatsApp (ADR-160 F8) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu porta I/O — paridade WhatsApp (F8) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
