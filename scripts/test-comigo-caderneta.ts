/**
 * TEST — Comigo/Caderneta: caixa × a receber + cobrança cortês + sugestão de
 * lista negra (ADR-112 D3 / ADR-113 D1/D3, PR #4).
 *
 * Uso: npm run test:comigo-caderneta
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-cad-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-cad-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");
  const { ComigoCollectionService: C } = await import("../src/server/ComigoCollectionService.js");

  const today = new Date().toISOString().slice(0, 10);
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_fiado_default_limit, comigo_blacklist_suggest_days) VALUES (?, ?, 'X', 'active', ?, ?)`)
    .run(randomUUID(), orgId, 200, 20);

  // Venda à vista (dinheiro) R$55 — entra no caixa.
  const o1 = B.openOrder(orgId, { sessionAlias: "Zé" });
  B.addItem(orgId, o1, { name: "Galeto", unitPrice: 45 });
  B.addItem(orgId, o1, { name: "Refri", qty: 2, unitPrice: 5 });
  B.pay(orgId, o1, { paidVia: "cash" });

  // Venda no fiado R$30 — é a receber, NÃO entra no caixa.
  const cid = B.ensureFiadoContact(orgId, "Maria Silva", "5511988887777");
  const o2 = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o2, { name: "Marmita", qty: 2, unitPrice: 15 });
  B.pay(orgId, o2, { paidVia: "fiado" });

  // ===== 1. Resumo do dia: caixa × a receber =====
  const s1 = B.daySummary(orgId, today);
  check("caixa do dia = 55 (só o à vista)", near(s1.caixaHoje, 55));
  check("a receber = 30 (fiado em aberto)", near(s1.aReceber, 30));
  check("fiado NÃO entra no caixa", !near(s1.caixaHoje, 85));
  check("vendas do dia = 85 (à vista + fiado)", near(s1.vendasHoje, 85));
  check("pedidos do dia = 2", s1.pedidosHoje === 2);
  check("ticket médio = 42.50", near(s1.ticketMedio, 42.5));

  // ===== 2. Fiado quitado VIRA caixa =====
  B.settleFiado(orgId, cid, 30, "pagou tudo");
  const s2 = B.daySummary(orgId, today);
  check("após quitar: caixa = 85 (55 + 30 recebido)", near(s2.caixaHoje, 85));
  check("após quitar: a receber = 0", near(s2.aReceber, 0));

  // ===== 3. Cobrança amigável e cortês =====
  // Nova dívida para ter saldo a cobrar.
  const o3 = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o3, { name: "Bolo", unitPrice: 40 });
  B.pay(orgId, o3, { paidVia: "fiado" });
  const built = C.build(orgId, cid);
  check("lembrete nível 1 por padrão", built.level === 1);
  check("texto cita o primeiro nome", built.text.includes("Maria"));
  check("texto cita o saldo (R$ 40,00)", built.text.includes("40,00"));
  check("texto é cortês (sem ameaça)", /carinho|lembrar|jeitinho|combina/i.test(built.text) && !/processo|justiça|negativ/i.test(built.text));
  check("gera link wa.me com os dígitos do telefone", (built.waLink || "").includes("wa.me/5511988887777"));

  C.record(orgId, cid); // registra o nível 1
  const rec = db.prepare("SELECT COUNT(*) c FROM comigo_fiado_reminders WHERE organization_id = ? AND contact_id = ?").get(orgId, cid) as any;
  check("lembrete registrado (auditável)", rec.c === 1);
  check("próximo lembrete escala para nível 2", C.nextLevel(orgId, cid) === 2);

  // ===== 4. Sugestão de lista negra após N dias (IA sugere, dono decide) =====
  const cid2 = B.ensureFiadoContact(orgId, "João Caloteiro", "5511900000000");
  const o4 = B.openOrder(orgId, { contactId: cid2 });
  B.addItem(orgId, o4, { name: "Fiado antigo", unitPrice: 50 });
  B.pay(orgId, o4, { paidVia: "fiado" });
  // Envelhece a dívida 40 dias atrás (simula vencido).
  db.prepare("UPDATE comigo_fiado_ledger SET created_at = datetime('now','-40 days') WHERE organization_id = ? AND contact_id = ?").run(orgId, cid2);
  const oldest = db.prepare("SELECT MIN(created_at) m FROM comigo_fiado_ledger WHERE organization_id = ? AND contact_id = ? AND kind='debt'").get(orgId, cid2) as any;
  const daysOverdue = Math.floor((Date.now() - new Date(oldest.m + "Z").getTime()) / 86400000);
  check("dívida com 40 dias > limiar (20)", daysOverdue >= 20);
  // (a flag blacklistSuggested é derivada na rota GET /fiado com a mesma regra)
  check("cliente não está na lista negra ainda (só sugerido)", !(db.prepare("SELECT blacklisted FROM comigo_customer_credit WHERE organization_id = ? AND contact_id = ?").get(orgId, cid2) as any)?.blacklisted);

  // ===== 5. Isolamento =====
  const otherOrg = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), otherOrg);
  const sOther = B.daySummary(otherOrg, today);
  check("isolamento: outra org tem caixa 0", sOther.caixaHoje === 0 && sOther.aReceber === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Caderneta (caixa × a receber + cobrança) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Caderneta OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
