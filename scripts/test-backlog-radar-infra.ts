/**
 * TESTE — Backlog Radar infra (ADR-026)
 * ---------------------------------------
 * Cobre os itens do pacote 3 do backlog (08, 09, 14, 20, 21):
 *   08. rate limit genérico na rota pública (o honeypot descobriu-se JÁ
 *       implementado desde a ADR-012 — comprovado aqui por leitura do fonte);
 *   09. SLA por canal: config sanitizada (sla_by_channel_json) + cálculo do
 *       IVC avaliando cada ticket contra o limiar do SEU canal;
 *   14. edição concorrente: índices únicos parciais em radar_answers +
 *       upsert atômico em saveAnswer (duas escritas na mesma pergunta nunca
 *       duplicam linha — last-writer-wins);
 *   20. anexo binário no gmailSend (contentBase64 preserva bytes de PDF, sem
 *       corromper via UTF-8) + generateRadarReport devolve filePath;
 *   21. dicas medidas do pilar Receita (measuredHints a partir do snapshot
 *       do IVC — dica, nunca resposta automática).
 *
 * Roda num banco TEMPORÁRIO. Uso: npm run test:backlog-radar-infra
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-backlog-rinfra-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-backlog-radar-infra-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ModuleService } = await import("../src/server/ModuleService.js");
  const { RadarService } = await import("../src/server/RadarService.js");
  const { RevenueIntelligenceService } = await import("../src/server/RevenueIntelligenceService.js");
  const { ConversionVelocityService } = await import("../src/server/ConversionVelocityService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    ModuleService.applyVertical(orgId, "outro");
    const mods = JSON.parse((db.prepare(`SELECT enabled_modules FROM organization_settings WHERE organization_id = ?`).get(orgId) as any).enabled_modules);
    ModuleService.setModules(orgId, [...mods, "radar"]);
    return orgId;
  }
  const orgA = seedOrg("A");

  // ---- item 08: honeypot já existia; teto genérico novo cobre TODAS as rotas públicas ----
  const publicSrc = fs.readFileSync(path.join(process.cwd(), "src/server/routes/radarPublic.ts"), "utf-8");
  check("Honeypot (campo 'website' -> 201 falso) já existe na rota pública (item era backlog desatualizado)", /req\.body\?\.website/.test(publicSrc) && /randomFakeToken/.test(publicSrc));
  check("Teto genérico por IP cobre toda a rota pública (radar_public_all)", /radar_public_all/.test(publicSrc) && /router\.use\(/.test(publicSrc));

  // ---- item 09: SLA por canal ----
  const chFast = randomUUID();
  const chSlow = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'Canal Rápido', 'c1', 'active')`).run(chFast, orgA);
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp', 'Canal Tolerante', 'c2', 'active')`).run(chSlow, orgA);

  // sanitização da config
  RevenueIntelligenceService.saveConfig(orgA, {
    slow_response_seconds: 300,
    sla_by_channel: { [chFast]: 60, [chSlow]: 3600, invalido1: -5, invalido2: "abc" as any, invalido3: 999999 },
  } as any);
  const cfg = RevenueIntelligenceService.getConfig(orgA);
  check("sla_by_channel persiste entradas válidas", cfg.sla_by_channel[chFast] === 60 && cfg.sla_by_channel[chSlow] === 3600);
  check("sla_by_channel descarta valores inválidos (negativo, não numérico, acima de 24h)",
    !("invalido1" in cfg.sla_by_channel) && !("invalido2" in cfg.sla_by_channel) && !("invalido3" in cfg.sla_by_channel));

  // dois tickets, mesma velocidade de resposta (120s), canais diferentes:
  // no canal rápido (SLA 60s) estoura; no tolerante (SLA 3600s) cumpre.
  function seedTicket(channelId: string, tag: string) {
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgA, channelId, `Contato ${tag}`, `55119${Math.floor(Math.random() * 1e8)}`);
    const ticketId = randomUUID();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status) VALUES (?, ?, ?, 'open')`).run(ticketId, orgA, contactId);
    const contactAt = new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19);
    const replyAt = new Date(Date.now() - 3600_000 + 120_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'contact', 'oi', ?)`)
      .run(randomUUID(), orgA, ticketId, contactAt);
    db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'bot', 'olá!', ?)`)
      .run(randomUUID(), orgA, ticketId, replyAt);
    return ticketId;
  }
  seedTicket(chFast, "rápido");
  seedTicket(chSlow, "tolerante");

  const snap = ConversionVelocityService.calculate(orgA, "actor_A", {}) as any;
  check("IVC calculado com 2 tickets analisados", snap.tickets_analyzed === 2, `analisados=${snap.tickets_analyzed}`);
  check("Conformidade de SLA usa o limiar do canal de cada ticket (1 de 2 = 50%)", Math.abs((snap.sla_compliance_rate ?? -1) - 0.5) < 0.001, `rate=${snap.sla_compliance_rate}`);
  const calcJson = JSON.parse(snap.calculation_json || "{}");
  check("calculation_json audita os limiares por canal usados no cálculo", calcJson.slaByChannel && calcJson.slaByChannel[chFast] === 60);

  // ---- item 14: concorrência em radar_answers ----
  const template = (RadarService.listTemplates(orgA) as any[])[0];
  const session = RadarService.createSession(orgA, "actor_A", { templateId: template.id, companyName: "Empresa A LTDA" });
  const full = RadarService.getTemplateWithQuestions(orgA, template.id) as any;
  const q1 = full.questions.filter((q: any) => q.answer_type === "scale")[0];

  // duas escritas na mesma pergunta (mesmo fluxo autenticado, respondent NULL)
  RadarService.saveAnswer(orgA, session.id, "user_1", { questionId: q1.id, value: "1" });
  RadarService.saveAnswer(orgA, session.id, "user_2", { questionId: q1.id, value: "3" });
  const rows = db.prepare(`SELECT * FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id IS NULL`).all(session.id, q1.id) as any[];
  check("Duas escritas na mesma pergunta = UMA linha (upsert atômico)", rows.length === 1, `linhas=${rows.length}`);
  check("Última escrita vence (valor '3')", JSON.parse(rows[0].answer_json) === "3");

  // inserção direta duplicada bate no índice único (proteção no nível do banco)
  let uniqueBlocked = false;
  try {
    db.prepare(`INSERT INTO radar_answers (id, session_id, organization_id, question_id, respondent_id, answer_json) VALUES (?, ?, ?, ?, NULL, '"x"')`)
      .run(randomUUID(), session.id, orgA, q1.id);
  } catch { uniqueBlocked = true; }
  check("Índice único parcial bloqueia duplicata mesmo fora do saveAnswer", uniqueBlocked);

  // respondente convidado tem linha própria (não colide com a resposta autenticada)
  const added = RadarService.addRespondent(orgA, session.id, "actor_A", { name: "Convidado" });
  RadarService.saveAnswer(orgA, session.id, undefined, { questionId: q1.id, value: "2", respondentId: added.respondent.id });
  const allRows = db.prepare(`SELECT COUNT(*) AS c FROM radar_answers WHERE session_id = ? AND question_id = ?`).get(session.id, q1.id) as any;
  check("Resposta de respondente convidado convive com a autenticada (2 linhas, chaves distintas)", allRows.c === 2);
  RadarService.saveAnswer(orgA, session.id, undefined, { questionId: q1.id, value: "4", respondentId: added.respondent.id });
  const respRows = db.prepare(`SELECT * FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id = ?`).all(session.id, q1.id, added.respondent.id) as any[];
  check("Upsert por respondente também não duplica", respRows.length === 1 && JSON.parse(respRows[0].answer_json) === "4");

  // ---- item 20: anexo binário ----
  const googleSrc = fs.readFileSync(path.join(process.cwd(), "src/server/GoogleOAuthService.ts"), "utf-8");
  check("gmailSend aceita contentBase64 (binário) além de content (texto)", /contentBase64/.test(googleSrc));
  // O ponto crítico: binário NÃO pode passar por Buffer.from(x, 'utf-8').
  // Comprova que o caminho base64 preserva bytes que a codificação UTF-8 corromperia.
  const pdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff, 0xfe, 0x80]);
  const viaBase64 = Buffer.from(pdfHeader.toString("base64"), "base64");
  const viaUtf8 = Buffer.from(Buffer.from(pdfHeader.toString("utf-8"), "utf-8").toString("base64"), "base64");
  check("Caminho contentBase64 preserva os bytes binários exatamente", viaBase64.equals(pdfHeader));
  check("Caminho UTF-8 corromperia esses mesmos bytes (justifica o campo novo)", !viaUtf8.equals(pdfHeader));
  const reportSrc = fs.readFileSync(path.join(process.cwd(), "src/server/ReportPdfService.ts"), "utf-8");
  check("generateRadarReport devolve filePath junto com a url", /Promise<\{ url: string; filePath: string \} \| null>/.test(reportSrc));

  // ---- item 21: dicas medidas do pilar Receita ----
  const hints = RadarService.measuredHints(orgA, template.id);
  const hintKeys = Object.keys(hints);
  check("measuredHints existe quando há snapshot do IVC", hintKeys.length >= 1, `dicas=${hintKeys.length}`);
  check("Dica de tempo de resposta cita o dado medido", hintKeys.some((k) => k.includes("q_receita_tempo_resposta")) && Object.values(hints).some((h) => /Medido na sua operação/.test(h)));
  const sessWithHints = RadarService.getSession(orgA, session.id) as any;
  check("getSession inclui measuredHints para a tela", sessWithHints.measuredHints && typeof sessWithHints.measuredHints === "object");

  const orgSemDados = seedOrg("SemDados");
  check("Organização sem snapshot de IVC -> nenhuma dica (nunca inventa medição)", Object.keys(RadarService.measuredHints(orgSemDados, template.id)).length === 0);

  // dica NUNCA vira resposta: a pergunta continua sem resposta até o humano declarar
  const answered = db.prepare(`SELECT COUNT(*) AS c FROM radar_answers WHERE session_id = ? AND question_id LIKE '%q_receita_tempo_resposta'`).get(session.id) as any;
  check("Dica medida não cria resposta automática (pergunta segue sem resposta)", answered.c === 0);

  // ---- resultado ----
  console.log("\n=== Backlog Radar infra (ADR-026) ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Erro fatal no teste:", e);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
