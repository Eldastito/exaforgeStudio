/**
 * TESTE — Índice de Velocidade de Conversão (ConversionVelocityService)
 * ------------------------------------------------------------------
 * Mesmo espírito de scripts/test-tenant-isolation.ts e
 * scripts/test-radar-isolation.ts: banco temporário, verificações PASS/FAIL.
 *
 * Cobre:
 *   - cálculo determinístico dos componentes (SLA, P50/P90/P95, cobertura fora
 *     do horário comercial, conformidade de follow-up, rastreabilidade) contra
 *     um cenário sintético com resultado esperado calculado à mão;
 *   - "sem dado" nunca vira "0" (organização sem tickets => componentes nulos,
 *     não um score inflado nem zerado);
 *   - isolamento cross-tenant do snapshot;
 *   - anexar o cálculo a uma radar_sessions existente (e rejeitar sessão de
 *     outra organização);
 *   - determinismo (recalcular sem mudar dados dá o mesmo resultado);
 *   - evento de auditoria registrado.
 *
 * Uso: npm run test:conversion-velocity
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-velocity-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-velocidade-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}
function close(a: number, b: number, tol = 0.05) {
  return Math.abs(a - b) <= tol;
}

// Acha o dia (1-28) de um determinado mês/ano cujo getUTCDay() bate com targetDow
// (0=dom..6=sáb, convenção nativa do JS) — evita depender de qual dia da semana
// a data "hoje" do ambiente realmente cai.
function findWeekday(year: number, month0: number, targetDow: number): number {
  for (let day = 1; day <= 28; day++) {
    if (new Date(Date.UTC(year, month0, day)).getUTCDay() === targetDow) return day;
  }
  throw new Error("dia da semana não encontrado no mês");
}

// Converte "horário local de Brasília" (UTC-3, sem horário de verão desde
// 2019 — mesma constante TZ_OFFSET_MIN usada em AppointmentService/ConversionVelocityService)
// para o epoch ms REAL (UTC) que deve ser gravado no banco.
function localToMs(year: number, month0: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month0, day, hour, minute, 0) + 180 * 60000;
}
function sqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RadarService } = await import("../src/server/RadarService.js");
  const { ConversionVelocityService } = await import("../src/server/ConversionVelocityService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    ModuleService.applyVertical(orgId, "outro");
    const modsRow = db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    ModuleService.setModules(orgId, [...JSON.parse(modsRow.enabled_modules), "radar"]);

    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `id_${tag}`);
    return { orgId, channelId };
  }

  function makeTicket(orgId: string, channelId: string, opts: {
    contactAtMs?: number; responseAtMs?: number; responseSenderType?: "bot" | "agent";
    closedAtMs?: number; withStageLog?: boolean; withCadence?: boolean; extraLateMessage?: boolean;
  }) {
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, "Cliente Teste", `55119${Math.floor(Math.random() * 1e7)}`);
    const ticketId = randomUUID();
    const status = opts.closedAtMs ? "closed" : "open";
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage, created_at, closed_at) VALUES (?, ?, ?, ?, 'novo_lead', ?, ?)`)
      .run(ticketId, orgId, contactId, status, opts.contactAtMs ? sqliteDatetime(opts.contactAtMs) : sqliteDatetime(opts.closedAtMs!), opts.closedAtMs ? sqliteDatetime(opts.closedAtMs) : null);

    if (opts.contactAtMs) {
      db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'contact', 'oi, tudo bem?', ?)`)
        .run(randomUUID(), orgId, ticketId, sqliteDatetime(opts.contactAtMs));
    }
    if (opts.responseAtMs) {
      db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, ?, 'como posso ajudar?', ?)`)
        .run(randomUUID(), orgId, ticketId, opts.responseSenderType || "bot", sqliteDatetime(opts.responseAtMs));
      if (opts.extraLateMessage) {
        db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'agent', 'ainda por aí?', ?)`)
          .run(randomUUID(), orgId, ticketId, sqliteDatetime(opts.responseAtMs + 60000));
      }
    }
    if (opts.withStageLog) {
      db.prepare(`INSERT INTO ticket_stage_logs (id, organization_id, ticket_id, from_stage, to_stage, changed_by, created_at) VALUES (?, ?, ?, 'novo_lead', 'convertido', 'user_x', ?)`)
        .run(randomUUID(), orgId, ticketId, sqliteDatetime(opts.closedAtMs || Date.now()));
    }
    if (opts.withCadence) {
      const cadenceId = randomUUID();
      db.prepare(`INSERT INTO cadences (id, organization_id, name, trigger_stage) VALUES (?, ?, 'Follow-up padrão', 'novo_lead')`).run(cadenceId, orgId);
      db.prepare(`
        INSERT INTO contact_cadences (id, organization_id, cadence_id, ticket_id, contact_id, channel_id, contact_identifier, contact_name, current_step, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active')
      `).run(randomUUID(), orgId, cadenceId, ticketId, contactId, channelId, "5511999999999", "Cliente Teste");
    }
    return ticketId;
  }

  const A = seedOrg("A");
  const B = seedOrg("B");

  // Quarta-feira e sábado de um mês fixo (jun/2026), para não depender do dia
  // real do ambiente. Horário comercial padrão da organização: seg-sex 08-18.
  const WED_D = findWeekday(2026, 5, 3); // 3 = quarta (JS: dom=0..sáb=6)
  const SAT_D = findWeekday(2026, 5, 6); // 6 = sábado

  // T1: rápido, dentro do horário, dentro do SLA (300s) — resposta em 180s.
  makeTicket(A.orgId, A.channelId, { contactAtMs: localToMs(2026, 5, WED_D, 10, 0), responseAtMs: localToMs(2026, 5, WED_D, 10, 3) });
  // T2: dentro do horário, ACIMA do SLA (1200s), sem follow-up (1 msg só).
  makeTicket(A.orgId, A.channelId, { contactAtMs: localToMs(2026, 5, WED_D, 11, 0), responseAtMs: localToMs(2026, 5, WED_D, 11, 20) });
  // T3: dentro do horário, NUNCA respondido, sem follow-up.
  makeTicket(A.orgId, A.channelId, { contactAtMs: localToMs(2026, 5, WED_D, 13, 0) });
  // T4: FORA do horário (20h), coberto rápido (240s).
  makeTicket(A.orgId, A.channelId, { contactAtMs: localToMs(2026, 5, WED_D, 20, 0), responseAtMs: localToMs(2026, 5, WED_D, 20, 4) });
  // T5: FORA do horário (22h), resposta tardia (3600s) MAS com cadência ativa (follow-up conforme).
  makeTicket(A.orgId, A.channelId, { contactAtMs: localToMs(2026, 5, WED_D, 22, 0), responseAtMs: localToMs(2026, 5, WED_D, 23, 0), withCadence: true });
  // T6: sábado (fora do horário por dia da semana), nunca respondido, sem follow-up.
  makeTicket(A.orgId, A.channelId, { contactAtMs: localToMs(2026, 5, SAT_D, 10, 0) });
  // T7: fechado, COM rastro de mudança de estágio (rastreável).
  makeTicket(A.orgId, A.channelId, { closedAtMs: localToMs(2026, 5, WED_D, 15, 0), withStageLog: true });
  // T8: fechado, SEM rastro de mudança de estágio (não rastreável).
  makeTicket(A.orgId, A.channelId, { closedAtMs: localToMs(2026, 5, WED_D, 16, 0), withStageLog: false });

  const snap = ConversionVelocityService.calculate(A.orgId, "user_a", { periodDays: 60 });

  check("6 tickets com contato entram na análise (T1-T6; T7/T8 não têm mensagem)", snap.tickets_analyzed === 6, `analisados=${snap.tickets_analyzed}`);
  check("2 tickets nunca respondidos (T3, T6)", snap.tickets_never_responded === 2, `never=${snap.tickets_never_responded}`);
  check("Conformidade de SLA = 2/6 (T1, T4 dentro do limiar)", close(snap.sla_compliance_rate, 2 / 6), `sla=${snap.sla_compliance_rate}`);
  check("P50 de primeira resposta = 240s", snap.first_response_p50_seconds === 240, `p50=${snap.first_response_p50_seconds}`);
  check("P90 de primeira resposta = 3600s (cauda longa capturada)", snap.first_response_p90_seconds === 3600, `p90=${snap.first_response_p90_seconds}`);
  check("3 mensagens de contato fora do horário comercial (T4, T5, T6)", snap.out_of_hours_messages_total === 3, `fora_horario=${snap.out_of_hours_messages_total}`);
  check("1 das 3 fora do horário foi coberta dentro do SLA (T4)", snap.out_of_hours_covered_total === 1, `cobertas=${snap.out_of_hours_covered_total}`);
  check("Cobertura fora do horário = 1/3", close(snap.out_of_hours_coverage_rate, 1 / 3), `cobertura=${snap.out_of_hours_coverage_rate}`);
  check("4 tickets em risco (T2, T3, T5, T6)", snap.followup_at_risk_total === 4, `em_risco=${snap.followup_at_risk_total}`);
  check("Só 1 em risco teve follow-up (T5, via cadência)", snap.followup_compliant_total === 1, `followup_ok=${snap.followup_compliant_total}`);
  check("2 tickets fechados no período (T7, T8)", snap.conversion_closed_total === 2, `fechados=${snap.conversion_closed_total}`);
  check("1 dos 2 fechados é rastreável (T7)", snap.conversion_traceable_total === 1, `rastreaveis=${snap.conversion_traceable_total}`);
  check("Rastreabilidade de conversão = 1/2", close(snap.conversion_traceability_rate, 0.5), `rastreabilidade=${snap.conversion_traceability_rate}`);
  check("IVC calculado na faixa esperada (~27.5, banda 'reativa')", snap.ivc_score != null && close(snap.ivc_score, 27.5, 0.5) && snap.ivc_band === "reativa",
    `ivc=${snap.ivc_score} banda=${snap.ivc_band}`);

  // Organização sem NENHUM ticket: todo componente deve ficar NULO, nunca 0.
  const emptySnap = ConversionVelocityService.calculate(B.orgId, "user_b", { periodDays: 30 });
  check("Sem dado nenhum, IVC fica NULO (não vira 0 nem 100)", emptySnap.ivc_score == null, `ivc=${emptySnap.ivc_score}`);
  check("Sem dado nenhum, banda também fica nula", emptySnap.ivc_band == null);
  check("Sem dado nenhum, conformidade de SLA fica nula (não '100% por omissão')", emptySnap.sla_compliance_rate == null);

  // Isolamento cross-tenant.
  check("B lendo o snapshot de A retorna undefined", ConversionVelocityService.get(B.orgId, snap.id) == null);
  const listB = ConversionVelocityService.list(B.orgId) as any[];
  check("Listagem de B não inclui o snapshot de A", !listB.some((s) => s.id === snap.id));

  // Determinismo: recalcular sem mudar dado nenhum dá o mesmo IVC.
  const snap2 = ConversionVelocityService.calculate(A.orgId, "user_a", { periodDays: 60 });
  check("Recalcular sem mudar dados é determinístico", snap2.ivc_score === snap.ivc_score, `${snap2.ivc_score} vs ${snap.ivc_score}`);

  // Anexar a uma radar_sessions existente + rejeitar sessão de outra organização.
  const template = (RadarService.listTemplates(A.orgId) as any[])[0];
  const session = RadarService.createSession(A.orgId, "user_a", { templateId: template.id, companyName: "Empresa A" });
  const attached = ConversionVelocityService.calculate(A.orgId, "user_a", { periodDays: 60, sessionId: session.id });
  check("Snapshot anexado à sessão certa", attached.session_id === session.id);

  const sessionB = RadarService.createSession(B.orgId, "user_b", { templateId: template.id, companyName: "Empresa B" });
  let rejectedCrossSession = false;
  try { ConversionVelocityService.calculate(A.orgId, "user_a", { sessionId: sessionB.id }); }
  catch { rejectedCrossSession = true; }
  check("Anexar a uma sessão de OUTRA organização é rejeitado", rejectedCrossSession);

  // Auditoria.
  const auditEvents = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'radar_velocity_calculated'`).all(A.orgId) as any[];
  check("Cada cálculo gera evento de auditoria radar_velocity_calculated", auditEvents.length >= 3, `eventos=${auditEvents.length}`);

  // ============ RELATÓRIO ============
  console.log("\n==================================================");
  console.log("  TESTE — ÍNDICE DE VELOCIDADE DE CONVERSÃO (IVC)");
  console.log("==================================================\n");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅ PASS" : "❌ FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  }
  const total = results.length;
  console.log(`\n  Resultado: ${total - failures}/${total} verificações passaram.`);
  console.log(failures === 0 ? "  🔒 CÁLCULO, ISOLAMENTO E DETERMINISMO CONFIRMADOS.\n" : `  ⚠️  ${failures} verificação(ões) FALHARAM.\n`);

  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erro ao rodar o teste de velocidade de conversão:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
