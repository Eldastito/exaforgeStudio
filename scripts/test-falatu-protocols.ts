/**
 * TEST — FalaTu F8.7 (ADR-154 Fase 8): Protocolos (chamada de resgate).
 *
 * Cobre os GUARDRAILS duros da fatia: flag opt-in por org (desligada = tudo
 * segue fluxo normal); CRUD humano com validações + teto + remoção lógica;
 * verificação do número por código FALADO (hash + timingSafeEqual + 5
 * tentativas + TTL, molde PIN F28) — hash no banco, nunca claro; match
 * determinístico exato/prefixo com wake words e acentos (REGRA DE CÓDIGO:
 * ativação por texto não chama IA; por áudio paga só a transcrição);
 * ativação exige número VERIFICADO e nunca vira item de inbox; cancelamento
 * por voz e por UI é UPDATE (nunca DELETE); disparo com claim atômico +
 * re-check dos guardrails na hora + ligação SÓ pro número do dono; falha do
 * provider marca failed + sinal falatu_protocol_failed (best-effort, nunca
 * lança); isolamento multi-tenant; trocar telefone RESETA verificação.
 *
 * Telefonia INJETADA (sem rede); mock só do interpret (sem chave OpenAI).
 * Uso: npm run test:falatu-protocols
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-proto-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-proto-1234567890";
delete process.env.OPENAI_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PAST = new Date("2026-08-05T12:00:00Z");
const AFTER = new Date("2026-08-05T12:10:00Z");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuProtocolService } = await import("../src/server/FalaTuProtocolService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userB = randomUUID();
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org A', 'active')`).run(randomUUID(), orgA);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Org B', 'active')`).run(randomUUID(), orgB);
  FalaTuService.setOrgEnabled(orgA, true);
  FalaTuService.setOrgEnabled(orgB, true);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dona A', 'a@a.test', 'owner', 'active')`).run(userA, orgA);
  db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'Dono B', 'b@b.test', 'owner', 'active')`).run(userB, orgB);

  let interpretCalls = 0;
  (FalaTuService as any).interpret = async (input: any) => {
    interpretCalls++;
    const text = input.audio ? "protocolo de segurança" : String(input.text || "");
    return {
      transcription: text, summary: text.slice(0, 40), intent: "NOTE",
      entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
      confidence: 0.9, suggestedAction: "s",
    };
  };

  const auditCount = (org: string, type: string) =>
    (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(org, type) as any).c;
  const inboxCount = () => (db.prepare(`SELECT COUNT(*) c FROM falatu_inbox_items WHERE organization_id = ?`).get(orgA) as any).c;
  const calls: Array<{ to: string; message: string }> = [];
  const okCall = async (to: string, message: string) => { calls.push({ to, message }); return { callId: `CA_${calls.length}` }; };

  const PHONE = "+5511999990001";

  // ===== 1. Flag desligada: nada de protocolo, captura segue normal =====
  let threw = false;
  try { FalaTuProtocolService.create(orgA, userA, { name: "protocolo de segurança", phoneE164: PHONE, delayMinutes: 5 }); } catch { threw = true; }
  check("flag off: create recusado", threw);
  check("flag off: match devolve null", FalaTuProtocolService.handleCaptureText(orgA, userA, "protocolo de segurança") === null);
  const r0 = await FalaTuService.capture(orgA, userA, { text: "protocolo de segurança" });
  check("flag off: captura vira item pendente normal (IA paga)", !r0.protocol && inboxCount() === 1 && interpretCalls === 1);

  // ===== 2. Liga a flag + CRUD com validações =====
  FalaTuProtocolService.setOrgEnabled(orgA, userA, true);
  FalaTuProtocolService.setOrgEnabled(orgB, userB, true);
  check("auditoria ORG_ENABLE", auditCount(orgA, "FALATU_PROTOCOLS_ORG_ENABLE") === 1);
  threw = false; try { FalaTuProtocolService.create(orgA, userA, { name: "p1", phoneE164: "11999990001", delayMinutes: 5 }); } catch { threw = true; }
  check("telefone sem +E.164 recusado", threw);
  threw = false; try { FalaTuProtocolService.create(orgA, userA, { name: "p1", phoneE164: PHONE, delayMinutes: 0 }); } catch { threw = true; }
  check("delay 0 recusado", threw);
  threw = false; try { FalaTuProtocolService.create(orgA, userA, { name: "p1", phoneE164: PHONE, delayMinutes: 61 }); } catch { threw = true; }
  check("delay 61 recusado", threw);
  const p1 = FalaTuProtocolService.create(orgA, userA, { name: "Protocolo de Segurança", phoneE164: PHONE, delayMinutes: 5 });
  check("create ok + audit", !!p1.id && auditCount(orgA, "FALATU_PROTOCOL_CREATE") === 1);
  threw = false; try { FalaTuProtocolService.create(orgA, userA, { name: "protocolo de SEGURANCA", phoneE164: PHONE, delayMinutes: 5 }); } catch { threw = true; }
  check("nome duplicado (case/acento) recusado", threw);

  // Teto de 5 + remoção lógica libera vaga (linha fica como trilha).
  const extras = ["dois", "tres", "quatro", "cinco"].map((n) => FalaTuProtocolService.create(orgA, userA, { name: `protocolo ${n}`, phoneE164: PHONE, delayMinutes: 5 }));
  threw = false; try { FalaTuProtocolService.create(orgA, userA, { name: "protocolo seis", phoneE164: PHONE, delayMinutes: 5 }); } catch { threw = true; }
  check("teto de 5 protocolos", threw);
  for (const e of extras.slice(1)) FalaTuProtocolService.remove(orgA, userA, e.id);
  const trail = db.prepare(`SELECT COUNT(*) c FROM falatu_protocols WHERE organization_id = ? AND deleted_at IS NOT NULL`).get(orgA) as any;
  check("remoção é deleted_at (trilha fica)", trail.c === 3 && FalaTuProtocolService.list(orgA, userA).length === 2);
  const p2 = extras[0]; // "protocolo dois", não verificado

  // ===== 3. Verificação por código falado (molde PIN F28) =====
  threw = false; try { FalaTuProtocolService.confirmPhoneVerification(orgA, userA, p1.id, "123456"); } catch { threw = true; }
  check("confirmar sem pedir ligação recusado", threw);
  await FalaTuProtocolService.requestPhoneVerification(orgA, userA, p1.id, { call: okCall });
  check("ligação de verificação vai pro número do protocolo", calls.length === 1 && calls[0].to === PHONE);
  const row1 = db.prepare(`SELECT * FROM falatu_protocols WHERE id = ?`).get(p1.id) as any;
  const code = (calls[0].message.match(/\d/g) || []).slice(0, 6).join("");
  check("banco guarda hash (64 hex), nunca o código claro", /^[0-9a-f]{64}$/.test(row1.verify_code_hash) && !row1.verify_code_hash.includes(code));
  threw = false; try { FalaTuProtocolService.confirmPhoneVerification(orgA, userA, p1.id, "000000"); } catch { threw = true; }
  const att = db.prepare(`SELECT verify_attempts a FROM falatu_protocols WHERE id = ?`).get(p1.id) as any;
  check("código errado recusa e conta tentativa", threw && att.a === 1);
  for (let i = 0; i < 4; i++) { try { FalaTuProtocolService.confirmPhoneVerification(orgA, userA, p1.id, "000001"); } catch { /* esperado */ } }
  threw = false; try { FalaTuProtocolService.confirmPhoneVerification(orgA, userA, p1.id, code); } catch { threw = true; }
  check("5 tentativas erradas trancam até nova ligação", threw);
  await FalaTuProtocolService.requestPhoneVerification(orgA, userA, p1.id, { call: okCall });
  const code2 = (calls[1].message.match(/\d/g) || []).slice(0, 6).join("");
  FalaTuProtocolService.confirmPhoneVerification(orgA, userA, p1.id, code2);
  const verified = db.prepare(`SELECT phone_verified_at v, verify_code_hash h FROM falatu_protocols WHERE id = ?`).get(p1.id) as any;
  check("código certo verifica e limpa o hash", !!verified.v && verified.h === null && auditCount(orgA, "FALATU_PROTOCOL_VERIFIED") === 1);

  // ===== 4. Match determinístico (regra de código) =====
  check("não verificado NÃO ativa (kind unverified)", (FalaTuProtocolService.handleCaptureText(orgA, userA, "protocolo dois") as any)?.kind === "unverified");
  const actCount = () => (db.prepare(`SELECT COUNT(*) c FROM falatu_protocol_activations WHERE organization_id = ?`).get(orgA) as any).c;
  check("unverified não criou ativação", actCount() === 0);

  const tryMatch = (text: string) => FalaTuProtocolService.handleCaptureText(orgA, userA, text) as any;
  let m = tryMatch("Protocolo de Segurança!");
  check("match exato (case/pontuação/acento)", m?.kind === "activated");
  FalaTuProtocolService.cancelScheduled(orgA, userA, "test");
  m = tryMatch("protocolo de segurança por favor agora");
  check("match por prefixo da transcrição", m?.kind === "activated");
  FalaTuProtocolService.cancelScheduled(orgA, userA, "test");
  m = tryMatch("FalaTu, protocolo de segurança");
  check("wake word 'falatu' removida antes do match", m?.kind === "activated");
  FalaTuProtocolService.cancelScheduled(orgA, userA, "test");
  m = tryMatch("ativa o protocolo de segurança");
  check("wake word 'ativa o' removida antes do match", m?.kind === "activated");
  FalaTuProtocolService.cancelScheduled(orgA, userA, "test");
  check("0 match → null (segue fluxo normal)", tryMatch("protocolo") === null && tryMatch("liga pro contador") === null);

  // Ambíguo: segundo protocolo verificado cujo nome compartilha prefixo.
  const p3 = FalaTuProtocolService.create(orgA, userA, { name: "protocolo de segurança máxima", phoneE164: PHONE, delayMinutes: 5 });
  db.prepare(`UPDATE falatu_protocols SET phone_verified_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p3.id);
  // As ativações canceladas dos passos acima FICAM no banco (nunca DELETE) —
  // o que se afere é que o ambíguo não cria NENHUMA nova.
  const actBeforeAmbiguous = actCount();
  m = tryMatch("protocolo de segurança máxima total");
  check("2+ matches → pergunta (ambiguous, sem ativar)", m?.kind === "ambiguous" && m.names.length === 2 && actCount() === actBeforeAmbiguous);
  m = tryMatch("protocolo de segurança");
  check("nome exato desambigua sozinho", m?.kind === "activated" && m.name === "Protocolo de Segurança");
  FalaTuProtocolService.cancelScheduled(orgA, userA, "test");

  // ===== 5. E2E no capture(): texto não paga IA nem vira inbox =====
  const inboxBefore = inboxCount(); const aiBefore = interpretCalls;
  const rText = await FalaTuService.capture(orgA, userA, { text: "falatu protocolo de segurança" });
  check("capture texto → activated, sem item, sem IA", rText?.protocol?.kind === "activated" && inboxCount() === inboxBefore && interpretCalls === aiBefore);
  const act = db.prepare(`SELECT * FROM falatu_protocol_activations WHERE id = ?`).get(rText.protocol.activationId) as any;
  check("ativação registrada com source webapp + audit", act?.status === "scheduled" && act.source === "webapp" && auditCount(orgA, "FALATU_PROTOCOL_ACTIVATE") >= 1);

  // Cancelamento por voz: UPDATE, nunca DELETE.
  const rCancel = await FalaTuService.capture(orgA, userA, { text: "cancela o protocolo" });
  const actAfter = db.prepare(`SELECT status FROM falatu_protocol_activations WHERE id = ?`).get(rText.protocol.activationId) as any;
  check("'cancela o protocolo' cancela (UPDATE, linha fica)", rCancel?.protocol?.kind === "cancelled" && actAfter.status === "cancelled");
  const rNothing = await FalaTuService.capture(orgA, userA, { text: "cancela o protocolo" });
  check("sem agendada → nothing_to_cancel", rNothing?.protocol?.kind === "nothing_to_cancel");

  // ===== 6. E2E áudio: paga SÓ a transcrição, ativa igual =====
  const aiBefore2 = interpretCalls;
  const rAudio = await FalaTuService.capture(orgA, userA, { audio: { mimeType: "audio/ogg", data: "eGZha2U=" } });
  check("capture áudio → activated (transcrição paga 1x, sem item)", rAudio?.protocol?.kind === "activated" && interpretCalls === aiBefore2 + 1 && inboxCount() === inboxBefore);
  FalaTuProtocolService.cancelScheduled(orgA, userA, "test");

  // ===== 7. Disparo: claim atômico + só pro número do dono =====
  calls.length = 0;
  const a1 = FalaTuProtocolService.activate(orgA, userA, p1.id, "webapp", { now: PAST, armTimer: false });
  const fired = await FalaTuProtocolService.fireDue({ now: AFTER, call: okCall });
  const a1row = db.prepare(`SELECT * FROM falatu_protocol_activations WHERE id = ?`).get(a1.id) as any;
  check("fireDue liga pro número VERIFICADO do dono", fired.fired === 1 && calls.length === 1 && calls[0].to === PHONE);
  check("fired + provider_call_id + fired_at + audit", a1row.status === "fired" && !!a1row.provider_call_id && !!a1row.fired_at && auditCount(orgA, "FALATU_PROTOCOL_FIRED") === 1);
  const again = await FalaTuProtocolService.fireDue({ now: AFTER, call: okCall });
  check("disparo é idempotente (claim atômico)", again.fired === 0 && calls.length === 1);

  // Cancelada não dispara; futura não dispara.
  const a2 = FalaTuProtocolService.activate(orgA, userA, p1.id, "webapp", { now: PAST, armTimer: false });
  FalaTuProtocolService.cancelScheduled(orgA, userA, "test");
  const a3 = FalaTuProtocolService.activate(orgA, userA, p1.id, "webapp", { now: AFTER, armTimer: false });
  const r7 = await FalaTuProtocolService.fireDue({ now: AFTER, call: okCall });
  check("cancelada e futura não disparam", r7.fired === 0 && calls.length === 1 && !!a2 && !!a3);
  db.prepare(`UPDATE falatu_protocol_activations SET status = 'cancelled' WHERE id = ?`).run(a3.id);

  // ===== 8. Falha do provider: failed + sinal, nunca lança =====
  const a4 = FalaTuProtocolService.activate(orgA, userA, p1.id, "webapp", { now: PAST, armTimer: false });
  const boom = async () => { throw new Error("provider down"); };
  const r8 = await FalaTuProtocolService.fireDue({ now: AFTER, call: boom });
  const a4row = db.prepare(`SELECT * FROM falatu_protocol_activations WHERE id = ?`).get(a4.id) as any;
  check("falha marca failed + fail_reason sem lançar", r8.failed === 1 && a4row.status === "failed" && String(a4row.fail_reason).includes("provider down"));
  const sig = db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ? AND signal_type = 'falatu_protocol_failed'`).get(orgA) as any;
  check("sinal falatu_protocol_failed publicado (ADR-136)", sig.c === 1);

  // ===== 9. Re-check dos guardrails NO DISPARO =====
  const a5 = FalaTuProtocolService.activate(orgA, userA, p1.id, "webapp", { now: PAST, armTimer: false });
  FalaTuProtocolService.update(orgA, userA, p1.id, { enabled: false });
  calls.length = 0;
  await FalaTuProtocolService.fireDue({ now: AFTER, call: okCall });
  const a5row = db.prepare(`SELECT * FROM falatu_protocol_activations WHERE id = ?`).get(a5.id) as any;
  check("protocolo desligado na janela → não liga (cancelled no disparo)", calls.length === 0 && a5row.status === "cancelled" && a5row.fail_reason === "protocol_unavailable_at_fire");
  FalaTuProtocolService.update(orgA, userA, p1.id, { enabled: true });

  // ===== 10. Trocar o telefone RESETA a verificação =====
  FalaTuProtocolService.update(orgA, userA, p1.id, { phoneE164: "+5511999990002" });
  const reset = db.prepare(`SELECT phone_verified_at v FROM falatu_protocols WHERE id = ?`).get(p1.id) as any;
  check("número novo → verificação zerada (não ativa mais)", reset.v === null && (tryMatch("protocolo de segurança") as any)?.kind === "unverified");

  // ===== 11. Isolamento multi-tenant =====
  const pB = FalaTuProtocolService.create(orgB, userB, { name: "protocolo b", phoneE164: "+5511999990003", delayMinutes: 5 });
  check("list é escopado por org/user", FalaTuProtocolService.list(orgA, userA).length === 3 && FalaTuProtocolService.list(orgB, userB).length === 1);
  threw = false; try { FalaTuProtocolService.remove(orgB, userB, p1.id); } catch { threw = true; }
  check("org B não remove protocolo da org A (anti-IDOR)", threw && !!pB);
  check("match da org B não vê protocolos da A", FalaTuProtocolService.handleCaptureText(orgB, userB, "protocolo de segurança máxima") === null);

  // ===== resumo =====
  console.log("");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
