/**
 * TESTE — F7.2 do PRD Conexão WhatsApp (20/09/2026): fallback das Clinic*
 * no resolvedor canônico (`ChannelBindingService.selectContactChannel`).
 * -----------------------------------------------------------------------------
 * Inventário §5 da análise F0: os 7 serviços clínicos de aviso/entrega
 * (Addendum/FollowUp/Guide/MonthlyReport/Document/Reminder/Vacancy) tinham o
 * MESMO helper duplicado: canal do registro do paciente primeiro (correto —
 * preservado) + fallback SQL direto. A fatia centraliza no resolvedor.
 *
 * Prova, offline:
 *  - o canal do REGISTRO do paciente vence até sobre o binding (histórico da
 *    conversa mora lá);
 *  - contato com canal inutilizável → binding de 'clinica' decide;
 *  - sem binding → fallback legado EXATO (exclui desconectado — canal
 *    desconectado nunca é escolhido mesmo sendo evolution-first);
 *  - finalidade 'clinica' desligada pra saída → null (produtor pula, CA-03);
 *  - isolamento multi-tenant;
 *  - FIAÇÃO: os 7 arquivos usam o helper e o SQL duplicado sumiu.
 *
 * Uso: npm run test:clinic-channel-fallback
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinfb-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-clinfb-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ChannelBindingService } = await import("../src/server/ChannelBindingService.js");

  const mkOrg = (tag: string) => {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `Clínica ${tag}`);
    return orgId;
  };
  const mkCh = (org: string, provider: string, createdAt: string, status = "connected") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, org, provider, `${provider}-ch`, `${provider}-${id.slice(0, 6)}`, status, createdAt);
    return id;
  };

  const A = mkOrg("A");
  const chCloud = mkCh(A, "whatsapp_cloud", "2026-01-01 10:00:00");
  const chEvo = mkCh(A, "evolution", "2026-02-01 10:00:00");
  const pick = (contactChId?: string | null) => ChannelBindingService.selectContactChannel(A, "clinica", contactChId ?? null);

  // ── 1) Canal do registro do paciente vence (contact-first preservado). ──
  check("1.1 canal do contato usável vence o fallback", pick(chCloud) === chCloud);
  ChannelBindingService.upsert(A, "u1", { channelId: chEvo, featureKey: "clinica" });
  check("1.2 canal do contato vence ATÉ o binding (histórico mora lá)", pick(chCloud) === chCloud);

  // ── 2) Contato sem canal utilizável → binding decide o fallback. ──
  db.prepare(`UPDATE channels SET status = 'disconnected' WHERE id = ?`).run(chCloud);
  check("2.1 canal do contato desconectado → binding de 'clinica' decide", pick(chCloud) === chEvo);
  check("2.2 contato sem canal → binding decide", pick(null) === chEvo);

  // ── 3) Finalidade desligada pra saída → null (produtor pula). ──
  ChannelBindingService.upsert(A, "u1", { channelId: chEvo, featureKey: "clinica", outbound: false });
  check("3.1 'clinica' desligada → null (não chuta canal)", pick(null) === null);
  check("3.2 canal do contato usável AINDA vence (aviso já endereçado)", (db.prepare(`UPDATE channels SET status='connected' WHERE id=?`).run(chCloud), pick(chCloud)) === chCloud);
  ChannelBindingService.upsert(A, "u1", { channelId: chEvo, featureKey: "clinica", outbound: true });

  // ── 4) Sem binding → fallback legado EXATO (nunca canal desconectado). ──
  const B = mkOrg("B");
  const bEvoDisc = mkCh(B, "evolution", "2026-01-01 10:00:00", "disconnected");
  const bCloud = mkCh(B, "whatsapp_cloud", "2026-03-01 10:00:00");
  const pb = ChannelBindingService.selectContactChannel(B, "clinica", null);
  check("4.1 evolution desconectado NUNCA é escolhido (pega o cloud conectado)", pb === bCloud, String(pb));
  db.prepare(`UPDATE channels SET status = 'disabled' WHERE id = ?`).run(bCloud);
  check("4.2 só desconectado/pausado → null (sem inventar canal)", ChannelBindingService.selectContactChannel(B, "clinica", null) === null);
  check("4.3 org sem canal → null", ChannelBindingService.selectContactChannel(mkOrg("Z"), "clinica", null) === null);

  // ── 5) Isolamento: canal/binding de A nunca decide pra B. ──
  const pb2 = ChannelBindingService.selectContactChannel(B, "clinica", chCloud);
  check("5.1 canal do contato de OUTRA org não é aceito", pb2 !== chCloud && pb2 !== chEvo, String(pb2));

  // ── 6) FIAÇÃO: os 7 serviços usam o helper; SQL duplicado sumiu. ──
  const root = process.cwd();
  const clinicFiles = [
    "src/server/ClinicAddendumNoticeService.ts", "src/server/ClinicFollowUpNoticeService.ts",
    "src/server/ClinicGuideDeliveryService.ts", "src/server/ClinicMonthlyReportDeliveryService.ts",
    "src/server/ClinicDocumentDeliveryService.ts", "src/server/ClinicReminderService.ts",
    "src/server/ClinicVacancyService.ts",
  ];
  const NEEDLE = "ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1";
  for (const rel of clinicFiles) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    check(`6.x ${path.basename(rel)} usa o helper e sem SQL duplicado`, src.includes("selectContactChannel(") && !src.includes(NEEDLE));
  }

  console.log("\n=== TEST: F7.2 — fallback clínico no resolvedor canônico ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
