/**
 * TEST — Pedido de compra por voz/texto do gestor (ADR-099, bloco #11).
 *
 * O gestor dita "compra 20 camisas polo brancas" no WhatsApp → o áudio já vira
 * texto (server.ts) → o orquestrador extrai os itens, casa com o catálogo e
 * monta um rascunho de compra CONFIRMADO antes de criar (SIM/NÃO). Os itens
 * ditados são marcados source='manual' e a reposição automática (syncDraft) NÃO
 * os apaga.
 *
 * Mocka PurchaseRequisitionService.extractOrderFromText (sem chave OpenAI) e
 * exercita o fluxo real: intent → pending → SIM → requisição.
 *
 * Uso: npm run test:purchase-order-by-audio
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-po-audio-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-po-audio-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { AIOrchestratorService } = await import("../src/server/AIOrchestratorService.js");
  const { PurchaseRequisitionService } = await import("../src/server/PurchaseRequisitionService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const managerPhone = "5521999990000";
  const channelId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO authorized_managers (id, organization_id, identifier, name) VALUES (?, ?, ?, 'Dono')`).run(randomUUID(), orgId, managerPhone);
  db.prepare(`INSERT INTO channels (id, organization_id, name, provider, identifier, status) VALUES (?, ?, 'Zap', 'evolution', 'me', 'active')`).run(channelId, orgId);

  const polo = randomUUID(), calca = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Camisa Polo Branca')`).run(polo, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Calça Jeans Preta')`).run(calca, orgId);

  // Mock só da extração por IA (o resto do fluxo é real).
  (PurchaseRequisitionService as any).extractOrderFromText = async (_org: string, text: string) => {
    if (/guarda-chuva/i.test(text)) return { isOrder: true, items: [{ name: "guarda-chuva", quantity: 5 }] };
    if (/camisa/i.test(text)) return { isOrder: true, items: [{ name: "camisa polo branca", quantity: 20 }, { name: "calça preta", quantity: 10 }] };
    return { isOrder: false, items: [] };
  };

  const send = (message: string) => AIOrchestratorService.processMessage({ message, organizationId: orgId, senderId: managerPhone, channelId });

  // ===== 1. Gestor dita o pedido → confirmação (nada criado ainda) =====
  const r1 = await send("Compra 20 camisas polo brancas e 10 calças pretas, por favor");
  check("pediu confirmação (SIM/NÃO)", /SIM/.test(r1.reply) && /pedido de compra/i.test(r1.reply));
  check("listou os itens casados", r1.reply.includes("20× Camisa Polo Branca") && r1.reply.includes("10× Calça Jeans Preta"));
  const pending = db.prepare(`SELECT * FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).get(orgId, managerPhone) as any;
  check("ação pendente 'purchase_order_audio' criada", pending?.action_type === "purchase_order_audio");
  const draftsBefore = db.prepare(`SELECT COUNT(*) c FROM purchase_requisitions WHERE organization_id = ?`).get(orgId) as any;
  check("NADA criado antes do SIM", draftsBefore.c === 0);

  // ===== 2. SIM → cria o rascunho com itens source='manual' =====
  const r2 = await send("SIM");
  check("confirmou criação", /Adicionei/i.test(r2.reply) && /Compras/.test(r2.reply));
  const draft = db.prepare(`SELECT * FROM purchase_requisitions WHERE organization_id = ? AND status = 'draft'`).get(orgId) as any;
  check("rascunho de compra criado", !!draft);
  check("rascunho é created_by='manager'", draft?.created_by === "manager");
  const mItems = db.prepare(`SELECT * FROM purchase_requisition_items WHERE requisition_id = ? AND source = 'manual' ORDER BY suggested_qty DESC`).all(draft.id) as any[];
  check("2 itens manuais", mItems.length === 2);
  check("quantidades preservadas (20 e 10)", mItems[0]?.suggested_qty === 20 && mItems[1]?.suggested_qty === 10);
  check("pendência consumida (SIM limpou)", !db.prepare(`SELECT 1 FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).get(orgId, managerPhone));

  // ===== 3. syncDraft (reposição auto) NÃO apaga os itens manuais =====
  // Cria um produto em estoque baixo → deve VIRAR item 'auto' sem tocar nos manuais.
  const boneRow = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, active, stock_control_enabled) VALUES (?, ?, 'product', 'Boné', 1, 1)`).run(boneRow, orgId);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, quantity_reserved, low_stock_threshold) VALUES (?, ?, ?, 1, 0, 5)`).run(randomUUID(), orgId, boneRow);
  const sync = PurchaseRequisitionService.syncDraft(orgId, 14);
  const afterSync = db.prepare(`SELECT source, COUNT(*) c FROM purchase_requisition_items WHERE requisition_id = ? GROUP BY source`).all(draft.id) as any[];
  const manualAfter = afterSync.find(r => r.source === "manual")?.c || 0;
  const autoAfter = afterSync.find(r => r.source === "auto")?.c || 0;
  check("itens manuais sobrevivem ao syncDraft", manualAfter === 2);
  check("reposição automática adicionou o item 'auto'", autoAfter === 1);

  // ===== 4. Item ditado sem correspondência no catálogo → pede cadastro =====
  const r4 = await send("compra 5 guarda-chuvas");
  check("avisa que não achou no catálogo", /não achei|catálogo|cadastre/i.test(r4.reply));
  check("não criou pendência para item inexistente", !db.prepare(`SELECT 1 FROM pending_manager_actions WHERE organization_id = ? AND identifier = ?`).get(orgId, managerPhone));

  // ===== 5. matchItemsToProducts — casamento e não-casamento (unidade) =====
  const m = PurchaseRequisitionService.matchItemsToProducts(orgId, [{ name: "camisa polo branca", quantity: 3 }, { name: "produto inexistente xyz", quantity: 1 }]);
  check("casa a camisa polo", m.matched.some(x => x.productServiceId === polo && x.quantity === 3));
  check("reporta o não-casado", m.unmatched.includes("produto inexistente xyz"));

  // --- Relatório ---
  console.log("\n=== TEST: Pedido de compra por áudio (ADR-099) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Pedido de compra por áudio OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
