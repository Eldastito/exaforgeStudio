/**
 * TEST — Fala Tu lança RECEBÍVEL/FIADO por comando GOVERNADO (F12, fecha a fila).
 * "lança um recebível de R$X do cliente Y vence Z" NÃO grava direto: proposta
 * governada (awaiting_approval) → aprovação + execução → conta a receber
 * (FinancialLedgerService.addReceivable).
 *   - classify detecta recebível/fiado; pergunta ("quanto tenho a receber?") não vira.
 *   - parseReceivable: valor/cliente/vencimento.
 *   - converse(owner) → propõe finance/falatu_record_receivable (cliente resolvido
 *     vira contactId), nada em receivables; approve→execute cria o recebível.
 *   - sem valor → não propõe; RBAC colaborador barrado; isolamento.
 *
 * Uso: npm run test:falatu-record-receivable
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-recv-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-recv-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuAskService } = await import("../src/server/FalaTuAskService.js");
  const { FalatuRecordService } = await import("../src/server/FalatuRecordService.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService } = await import("../src/server/CommandExecutorService.js");

  const mkOrg = () => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    FalaTuService.setOrgEnabled(o, true);
    return o;
  };
  const mkContact = (org: string, name: string) => {
    let ch = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND provider = 'falatu'`).get(org) as any;
    if (!ch) { const cid = randomUUID(); db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'falatu', 'Fala Tu', 'falatu', 'connected')`).run(cid, org); ch = { id: cid }; }
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, org, ch.id, name, `${name}-${id.slice(0, 4)}`);
    return id;
  };
  const recvCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM receivables WHERE organization_id = ?`).get(org) as any)?.n || 0);

  const A = mkOrg();
  const owner = { userId: randomUUID(), role: "owner", organizationId: A };
  const joao = mkContact(A, "João Silva");

  // ── 1. classify ──
  check("1.1 'lança um recebível de R$500 do cliente João' → record_receivable", FalaTuAskService.classify("lança um recebível de R$500 do cliente João", "2026-09-08").kind === "record_receivable");
  check("1.2 'fiado de R$200 do cliente Maria' → record_receivable", FalaTuAskService.classify("fiado de R$200 do cliente Maria", "2026-09-08").kind === "record_receivable");
  check("1.3 pergunta 'quanto tenho a receber?' → NÃO record_receivable", FalaTuAskService.classify("quanto tenho a receber?", "2026-09-08").kind !== "record_receivable");
  check("1.4 recebível needsMoney=true", FalaTuAskService.classify("recebível de R$500", "2026-09-08").needsMoney === true);

  // ── 2. parseReceivable ──
  const p = FalatuRecordService.parseReceivable("lança um recebível de R$500 do cliente João vence 10/09/2025", "2026-09-08");
  check("2.1 valor 500", p.amount === 500);
  check("2.2 cliente João", p.clientName === "João");
  check("2.3 vencimento 2025-09-10", p.dueDate === "2025-09-10");

  // ── 3. converse(owner) → proposta governada ──
  const r1 = await FalaTuAskService.converse(A, owner, "lança um recebível de R$500 do cliente João vence 10/09/2025");
  check("3.1 kind record_receivable + actionId", r1.kind === "record_receivable" && !!r1.data?.actionId);
  const action = DecisionActionService.get(A, r1.data!.actionId);
  check("3.2 awaiting_approval, finance/falatu_record_receivable", action?.status === "awaiting_approval" && action?.domain === "finance" && action?.action_type === "falatu_record_receivable");
  check("3.3 payload valor 500 + cliente resolvido (contactId)", action?.command_payload?.amount === 500 && action?.command_payload?.contactId === joao);
  check("3.4 NADA em receivables ainda", recvCount(A) === 0);

  // ── 4. approve → execute → recebível criado ──
  DecisionActionService.approve(A, r1.data!.actionId, owner.userId, { reason: "ok" });
  await CommandExecutorService.execute(A, r1.data!.actionId);
  const rec = db.prepare(`SELECT * FROM receivables WHERE organization_id = ?`).get(A) as any;
  check("4.1 recebível criado", recvCount(A) === 1);
  check("4.2 valor 500, status open, vencimento, contato", rec && Math.round(rec.amount * 100) / 100 === 500 && rec.status === "open" && rec.due_date === "2025-09-10" && rec.contact_id === joao);

  // ── 5. sem valor → não propõe ──
  const r2 = await FalaTuAskService.converse(A, owner, "lança um recebível de uns reais do cliente João");
  check("5.1 sem valor → pede o valor", r2.kind === "record_receivable" && !r2.data?.actionId && /não peguei o valor/i.test(r2.answer));

  // ── 6. RBAC §73 — colaborador barrado ──
  const vend = { userId: randomUUID(), role: "agent", organizationId: A };
  const r3 = await FalaTuAskService.converse(A, vend, "lança um recebível de R$300 do cliente João");
  check("6.1 colaborador → restrito", r3.moneyRestricted === true);
  check("6.2 colaborador não criou recebível", recvCount(A) === 1);

  // ── 7. isolamento ──
  const B = mkOrg();
  const ownerB = { userId: randomUUID(), role: "owner", organizationId: B };
  await FalaTuAskService.converse(B, ownerB, "lança um recebível de R$50 do cliente X");
  check("7.1 org B não tocou os recebíveis de A", recvCount(A) === 1);
  check("7.2 org B só proposta (não executada)", recvCount(B) === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-record-receivable: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
