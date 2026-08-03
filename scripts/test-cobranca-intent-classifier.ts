/**
 * TEST — ADR-152 Fatia 4b.2: intent classifier + reply router (Cobrança).
 *
 * Cobre:
 *  1. Classifier — cada uma das 10 intenções PT-BR do PRD §13.4 é
 *     mapeada corretamente quando o mock do LLM devolve o label + fallback
 *     `unknown` quando LLM devolve valor fora do enum ou não é JSON.
 *  2. Classifier: OPENAI_API_KEY ausente → `unknown` sem chamar `chat`.
 *  3. Classifier: `chat` throw → `unknown` + rationale contém "throw".
 *  4. ReplyService: sem cobrança viva pro contato → `{handled:false}`
 *     (não engole).
 *  5. ReplyService: cobrança viva + reply "vou pagar amanhã" →
 *     `handled:true`, sinal `collection:reply_promise:*` publicado,
 *     severity='attention', reply canned.
 *  6. ReplyService: reply "manda o pix" → sinal `resend_pix` publicado.
 *  7. ReplyService: reply "não reconheço" → sinal `dispute` severity='risk'.
 *  8. ReplyService: 2 replies iguais no mesmo receivable → sinal DEDUPADO
 *     (mesmo id, deduped=true na 2a chamada).
 *  9. ReplyService: `unknown` do LLM → severity='info', reply neutra,
 *     dedupeKey inclui hash da mensagem (sinais distintos por texto).
 * 10. Isolamento: cobrança da orgA + reply na orgB → `{handled:false}`.
 * 11. Correlação por phone quando contactId não bate.
 * 12. Correlação por contactId prioriza cobrança MAIS RECENTE (segundo
 *     lembrete manda pro segundo receivable, não pro primeiro).
 * 13. Audit log RUNTIME_COLLECTION_REPLY_INTERPRETED gravado.
 *
 * Determinístico (mock do `chat` do llm.ts).
 * Uso: npm run test:cobranca-intent-classifier
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cobr-intent-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cobranca-intent-1234567890";
// Chave "fake" só pra passar do guard early-exit do classifier; o mock
// intercepta `chat` antes de qualquer chamada real ao provedor.
process.env.OPENAI_API_KEY = "sk-fake-test-key";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { classify, INTENT_LABELS, __setClassifierChatForTests } = await import("../src/server/CollectionIntentClassifier.js");
  const { CollectionReplyService } = await import("../src/server/CollectionReplyService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  // ── Mock chat ──────────────────────────────────────────────────────────
  let nextChatResponse: string | ((prompt: string) => string) = '{"intent":"unknown","reason":"default"}';
  let chatThrow: any = null;
  const chatCalls: Array<{ prompt: string; opts: any }> = [];
  __setClassifierChatForTests(async (prompt: string, opts: any) => {
    chatCalls.push({ prompt, opts });
    if (chatThrow) throw chatThrow;
    return typeof nextChatResponse === "function" ? nextChatResponse(prompt) : nextChatResponse;
  });

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkOrg = () => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id);
    return id;
  };
  const mkReceivable = (orgId: string, contactId: string, amount: number, dueDate: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO receivables (id, organization_id, contact_id, description, amount, due_date, status) VALUES (?, ?, ?, 'Fatura teste', ?, ?, 'open')`)
      .run(id, orgId, contactId, amount, dueDate);
    return id;
  };
  /**
   * Cria uma cobrança viva "de mentira" — só o par (decision_action approved
   * com command_type='collection_send_reminder' + action_confirmation pending
   * amarrada), que é o que o findLiveForContact precisa. Evita rodar todo o
   * playbook (que exige mock Asaas + WhatsApp).
   */
  const mkLiveCollection = (orgId: string, opts: { receivableId: string; contactId: string; phone: string; amount: number; dueDate: string; paymentId?: string; }) => {
    const actionId = randomUUID();
    const payload = { receivableId: opts.receivableId, contactId: opts.contactId, phone: opts.phone, amount: opts.amount, dueDate: opts.dueDate, channelId: `ch-${orgId}`, customerId: `cust-${orgId}` };
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, expected_impact, command_type, command_payload_json, basis, created_at) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'approved', ?, ?, 'collection_send_reminder', ?, 'fact', CURRENT_TIMESTAMP)`)
      .run(actionId, orgId, `test cobrança ${opts.receivableId}`, opts.amount, JSON.stringify(payload));
    const confId = randomUUID();
    const paymentId = opts.paymentId || `pay_test_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, deadline_at, external_ref) VALUES (?, ?, ?, 'asaas_payment_webhook', 'pending', ?, ?)`)
      .run(confId, orgId, actionId, new Date(Date.now() + 30 * 86400_000).toISOString(), paymentId);
    return { actionId, confId, paymentId };
  };
  const mkContact = (orgId: string, phone: string) => {
    const chId = `ch-${orgId}`;
    const existingCh = db.prepare(`SELECT id FROM channels WHERE id = ?`).get(chId) as any;
    if (!existingCh) {
      db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active')`).run(chId, orgId);
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier) VALUES (?, ?, ?, ?)`).run(id, orgId, chId, phone);
    return id;
  };
  const auditCount = (orgId: string, eventType: string) => (db.prepare(`SELECT COUNT(*) as n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgId, eventType) as any).n;

  // ============================================================
  // Setup
  // ============================================================
  const orgA = mkOrg();
  const orgB = mkOrg();

  // ===== 1. Cada uma das 10 intenções é mapeada quando LLM devolve o label =====
  const KNOWN_INTENTS = INTENT_LABELS.filter((l) => l !== "unknown");
  for (const label of KNOWN_INTENTS) {
    nextChatResponse = JSON.stringify({ intent: label, reason: `test ${label}` });
    const r = await classify(`teste ${label}`);
    check(`classify(${label}): retorna intent=${label} + confidence>0`, r.intent === label && r.confidence > 0);
  }

  // ===== 2. LLM devolve valor fora do enum → unknown =====
  nextChatResponse = '{"intent":"fantasia_qualquer","reason":"foi"}';
  const rFake = await classify("qualquer coisa");
  check("intent fora do enum → unknown", rFake.intent === "unknown" && rFake.confidence === 0);

  // ===== 3. LLM devolve não-JSON → unknown =====
  nextChatResponse = "isso não é json";
  const rBad = await classify("qualquer coisa");
  check("resposta não-JSON → unknown", rBad.intent === "unknown");

  // ===== 4. LLM devolve JSON sem intent → unknown =====
  nextChatResponse = '{"reason":"no intent"}';
  const rNoIntent = await classify("qualquer coisa");
  check("JSON sem intent → unknown", rNoIntent.intent === "unknown");

  // ===== 5. OPENAI_API_KEY ausente → unknown SEM chamar chat =====
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const chatCallsBefore = chatCalls.length;
  const rNoKey = await classify("vou pagar amanhã");
  check("sem OPENAI_API_KEY → unknown, chat NÃO chamado", rNoKey.intent === "unknown" && rNoKey.rationale.includes("LLM indisponível") && chatCalls.length === chatCallsBefore);
  process.env.OPENAI_API_KEY = savedKey;

  // ===== 6. chat throw → unknown + rationale menciona erro =====
  chatThrow = new Error("timeout");
  nextChatResponse = '{"intent":"promise"}';
  const rThrow = await classify("vou pagar amanhã");
  check("chat throw → unknown + rationale menciona LLM erro", rThrow.intent === "unknown" && rThrow.rationale.startsWith("LLM erro"));
  chatThrow = null;

  // ===== 7. mensagem vazia → unknown sem chamar chat =====
  const chatCallsPre = chatCalls.length;
  const rEmpty = await classify("   ");
  check("mensagem vazia → unknown sem chamar chat", rEmpty.intent === "unknown" && chatCalls.length === chatCallsPre);

  // ============================================================
  // ReplyService
  // ============================================================
  const contactA = mkContact(orgA, "5511999998888");
  const recA = mkReceivable(orgA, contactA, 250, "2026-09-15");
  const liveA = mkLiveCollection(orgA, { receivableId: recA, contactId: contactA, phone: "5511999998888", amount: 250, dueDate: "2026-09-15" });

  // ===== 8. Sem cobrança viva pro contato → not_handled =====
  const contactSemCobr = mkContact(orgA, "5511777777777");
  nextChatResponse = '{"intent":"promise","reason":"ok"}';
  const noneRes = await CollectionReplyService.tryHandle(orgA, contactSemCobr, "5511777777777", "oi tudo bem?");
  check("sem cobrança viva → handled=false", noneRes.handled === false);

  // ===== 9. Reply promise → handled + sinal collection:promise:* =====
  nextChatResponse = '{"intent":"promise","reason":"vai pagar amanhã"}';
  const rPromise = await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "Vou pagar amanhã sem falta.");
  check("promise: handled=true + intent=promise", rPromise.handled === true && rPromise.intent === "promise");
  check("promise: reply canned menciona anotado/combinado", !!rPromise.reply && /combinado|anotar/i.test(rPromise.reply));
  const sigsA = BusinessSignalService.list(orgA, { domain: "collection" });
  const promiseSig = sigsA.find((s: any) => s.signal_type === "reply_promise");
  check("promise: sinal reply_promise publicado", !!promiseSig && promiseSig.severity === "attention");
  check("promise: sinal.impact_amount=250 (do receivable)", promiseSig && Number(promiseSig.impact_amount) === 250);
  check("promise: sinal.dedupe_key inclui receivableId", promiseSig && promiseSig.dedupe_key === `collection:promise:${recA}`);

  // ===== 10. Segundo reply promise NO MESMO RECEIVABLE → sinal DEDUPADO =====
  nextChatResponse = '{"intent":"promise","reason":"outra vez"}';
  const rPromise2 = await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "Amanhã sem falta.");
  const sigsA2 = BusinessSignalService.list(orgA, { domain: "collection" });
  const promise2 = sigsA2.filter((s: any) => s.signal_type === "reply_promise");
  check("promise 2x: sinal continua ÚNICO (deduped por dedupe_key)", promise2.length === 1);
  check("promise 2x: mesmo signalId nas 2 chamadas", rPromise.signalId === rPromise2.signalId);

  // ===== 11. Reply resend_pix → sinal reply_resend_pix =====
  nextChatResponse = '{"intent":"resend_pix","reason":"quer o pix"}';
  const rResend = await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "manda o pix");
  const sigsA3 = BusinessSignalService.list(orgA, { domain: "collection" });
  check("resend_pix: sinal reply_resend_pix publicado", !!sigsA3.find((s: any) => s.signal_type === "reply_resend_pix"));
  check("resend_pix: reply canned menciona reenviar", !!rResend.reply && /reenviar|pix/i.test(rResend.reply));

  // ===== 12. Reply dispute → severity=risk =====
  nextChatResponse = '{"intent":"dispute","reason":"cliente contesta"}';
  const rDisp = await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "não reconheço esse valor");
  const dispSig = BusinessSignalService.list(orgA, { domain: "collection" }).find((s: any) => s.signal_type === "reply_dispute");
  check("dispute: severity=risk", dispSig?.severity === "risk");
  check("dispute: reply canned menciona time/revisar", !!rDisp.reply && /time|revisar|retorno/i.test(rDisp.reply));

  // ===== 13. Reply unknown → severity=info + dedupeKey inclui hash =====
  nextChatResponse = '{"intent":"algo_estranho","reason":"nada"}';
  const rUnk1 = await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "aaabbb ??");
  nextChatResponse = '{"intent":"tambem_estranho","reason":"nada"}';
  const rUnk2 = await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "cccdddeee !!");
  const unkSigs = BusinessSignalService.list(orgA, { domain: "collection" }).filter((s: any) => s.signal_type === "reply_unknown");
  check("unknown: 2 mensagens distintas geram 2 sinais distintos (dedupe por hash)", unkSigs.length === 2);
  check("unknown: severity=info", unkSigs.every((s: any) => s.severity === "info"));
  check("unknown: dedupeKey contém 'collection:unknown:'", unkSigs.every((s: any) => s.dedupe_key.startsWith("collection:unknown:")));

  // ===== 14. Isolamento — mesma cobrança + reply na orgB → not_handled =====
  const contactB = mkContact(orgB, "5511999998888");
  nextChatResponse = '{"intent":"promise","reason":"ok"}';
  const rIso = await CollectionReplyService.tryHandle(orgB, contactB, "5511999998888", "vou pagar");
  check("isolamento: reply na orgB sem cobrança lá → handled=false", rIso.handled === false);

  // ===== 15. Correlação por phone quando contactId não bate =====
  // Simula: contato foi recriado (novo id), mas o payload da cobrança
  // ainda tem o contactId antigo. Phone continua igual → deve casar.
  const contactRenewed = mkContact(orgA, "5522988887777");
  const recPhone = mkReceivable(orgA, contactRenewed, 80, "2026-08-30");
  // Payload guarda um contactId "antigo" (não bate com contactRenewed)
  // mas o phone do payload é o mesmo do contact atual.
  mkLiveCollection(orgA, { receivableId: recPhone, contactId: "contact-antigo-nao-existe-mais", phone: "5522988887777", amount: 80, dueDate: "2026-08-30" });
  nextChatResponse = '{"intent":"promise","reason":"ok"}';
  const rByPhone = await CollectionReplyService.tryHandle(orgA, contactRenewed, "5522988887777", "vou pagar");
  check("correlação por phone: acha cobrança mesmo com contactId diferente", rByPhone.handled === true && rByPhone.receivableId === recPhone);

  // ===== 16. Correlação: cobrança MAIS RECENTE quando o contato tem 2 =====
  const recA2 = mkReceivable(orgA, contactA, 500, "2026-10-01");
  const liveA2 = mkLiveCollection(orgA, { receivableId: recA2, contactId: contactA, phone: "5511999998888", amount: 500, dueDate: "2026-10-01" });
  nextChatResponse = '{"intent":"promise","reason":"segunda cobrança"}';
  const rRecent = await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "vou pagar amanhã");
  check("correlação: pega a cobrança MAIS RECENTE (recA2)", rRecent.receivableId === recA2);

  // ===== 17. Audit log gravado =====
  check("audit log RUNTIME_COLLECTION_REPLY_INTERPRETED registrado", auditCount(orgA, "RUNTIME_COLLECTION_REPLY_INTERPRETED") >= 5);

  // ============================================================
  // Resultado
  // ============================================================
  console.log("\n=== ADR-152 Fatia 4b.2 (Intent Classifier + Reply Router) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  // Referências pra manter linter feliz (os handles usados em setup)
  void liveA; void liveA2;
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
