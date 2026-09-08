/**
 * TEST — Fala Tu cadastra CLIENTE por comando GOVERNADO (F7, fecha a opção a).
 * "cadastra o cliente João, telefone 11 99999-0000" NÃO escreve direto: proposta
 * governada (awaiting_approval) → aprovação + execução → contato criado (canal
 * sintético 'falatu' + dedupe, espelhando BalcaoService).
 *   - classify detecta cliente por VERBO + cliente/contato; pergunta não vira
 *     cadastro; "registra o cliente" vem antes da gravação genérica.
 *   - parseContact extrai nome (obrigatório) + telefone/email best-effort.
 *   - converse(owner) → propõe crm/falatu_record_contact, nada em contacts.
 *   - approve → execute → contato criado (nome/identifier/email).
 *   - 2º cadastro do mesmo telefone → dedupe (1 contato só).
 *   - sem nome → não propõe; isolamento.
 *
 * Uso: npm run test:falatu-record-contact
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-contact-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-contact-123456";

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
  const A = mkOrg();
  const owner = { userId: randomUUID(), email: "dono@toulon.com", role: "owner", organizationId: A };
  const contactsCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE organization_id = ?`).get(org) as any)?.n || 0);

  // ── 1. classify ──
  check("1.1 'cadastra o cliente João' → record_contact", FalaTuAskService.classify("cadastra o cliente João", "2026-09-08").kind === "record_contact");
  check("1.2 'registra o cliente Pedro' → record_contact (antes da gravação genérica)", FalaTuAskService.classify("registra o cliente Pedro", "2026-09-08").kind === "record_contact");
  check("1.3 pergunta 'quantos clientes tenho?' → NÃO record_contact", FalaTuAskService.classify("quantos clientes tenho?", "2026-09-08").kind !== "record_contact");
  check("1.4 record_contact needsMoney=false", FalaTuAskService.classify("cadastra o cliente Ana", "2026-09-08").needsMoney === false);

  // ── 2. parseContact ──
  const pc = FalatuRecordService.parseContact("cadastra o cliente João Silva, telefone 11 99999-0000, email joao@x.com");
  check("2.1 nome extraído", pc.name === "João Silva");
  check("2.2 telefone extraído (só dígitos)", pc.phone === "11999990000");
  check("2.3 email extraído", pc.email === "joao@x.com");
  check("2.4 sem nome → null", FalatuRecordService.parseContact("cadastra o cliente").name === null);

  // ── 3. converse(owner) → proposta governada ──
  const r1 = await FalaTuAskService.converse(A, owner, "cadastra o cliente Maria Souza, telefone 11 98888-1111");
  check("3.1 kind record_contact", r1.kind === "record_contact");
  check("3.2 actionId + awaitingApproval", !!r1.data?.actionId && r1.data?.awaitingApproval === true);
  const action = DecisionActionService.get(A, r1.data!.actionId);
  check("3.3 awaiting_approval (não cadastra sozinho)", action?.status === "awaiting_approval");
  check("3.4 crm / falatu_record_contact", action?.domain === "crm" && action?.action_type === "falatu_record_contact");
  check("3.5 payload nome Maria", /Maria/.test(String(action?.command_payload?.name || "")));
  check("3.6 NADA em contacts ainda", contactsCount(A) === 0);

  // ── 4. approve → execute → contato criado ──
  DecisionActionService.approve(A, r1.data!.actionId, owner.userId, { reason: "ok" });
  await CommandExecutorService.execute(A, r1.data!.actionId);
  const c = db.prepare(`SELECT * FROM contacts WHERE organization_id = ?`).get(A) as any;
  check("4.1 contato criado", contactsCount(A) === 1);
  check("4.2 nome gravado", c?.name === "Maria Souza");
  check("4.3 identifier = telefone", c?.identifier === "11988881111");
  check("4.4 canal sintético 'falatu'", !!db.prepare(`SELECT 1 FROM channels WHERE organization_id = ? AND provider = 'falatu'`).get(A));

  // ── 5. dedupe: mesmo telefone → não duplica ──
  const r2 = await FalaTuAskService.converse(A, owner, "cadastra o cliente Maria S., telefone 11 98888-1111");
  DecisionActionService.approve(A, r2.data!.actionId, owner.userId, {});
  await CommandExecutorService.execute(A, r2.data!.actionId);
  check("5.1 dedupe por telefone → segue 1 contato", contactsCount(A) === 1);

  // ── 6. sem nome → não propõe ──
  const r3 = await FalaTuAskService.converse(A, owner, "cadastra o cliente");
  check("6.1 sem nome → pede o nome, não propõe", r3.kind === "record_contact" && !r3.data?.actionId && /não peguei o nome/i.test(r3.answer));

  // ── 7. isolamento ──
  const B = mkOrg();
  const ownerB = { userId: randomUUID(), role: "owner", organizationId: B };
  await FalaTuAskService.converse(B, ownerB, "cadastra o cliente Outro");
  check("7.1 org B não tocou contacts de A", contactsCount(A) === 1);
  check("7.2 org B só proposta (não executada)", contactsCount(B) === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-record-contact: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
