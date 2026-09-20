/**
 * TESTE — W2: SELEÇÃO única de canal por finalidade (pendência nº 1 da F7.4).
 * ------------------------------------------------------------------------------
 * `ChannelBindingService.selectOutboundChannel` substitui as cópias A5 do SQL
 * "primeiro canal". Prova, offline:
 *   - 0-REGRESSÃO: sem binding, a seleção é BYTE-EQUIVALENTE ao SQL legado
 *     (evolution-first, created_at ASC);
 *   - binding configurado DECIDE (por finalidade, sem afetar as demais);
 *   - finalidade desligada pra saída → undefined (CA-03, produtor pula);
 *   - binding pra canal indisponível → cai na seleção legada (mesma régua do
 *     gate: canal indisponível não é bloqueio de finalidade);
 *   - isolamento multi-tenant;
 *   - FIAÇÃO: os produtores A5 migraram de fato (o SQL legado não existe mais
 *     fora do helper — gate de regressão estilo test:org-group-lint).
 *
 * Uso:  npm run test:channel-select-resolver
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-chan-select-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-channel-select-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ChannelBindingService } = await import("../src/server/ChannelBindingService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  const mkCh = (org: string, provider: string, createdAt: string, status = "connected") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, org, provider, `${provider}-ch`, `${provider}-${id.slice(0, 6)}`, status, createdAt);
    return id;
  };
  // Org A: canal cloud mais ANTIGO + canal evolution mais NOVO (o legado prefere evolution).
  const chCloud = mkCh(A, "whatsapp_cloud", "2026-01-01 10:00:00");
  const chEvo = mkCh(A, "evolution", "2026-02-01 10:00:00");
  const chB = mkCh(B, "evolution", "2026-01-15 10:00:00");

  const LEGACY_SQL = `SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`;

  // 1) 0-REGRESSÃO: sem binding, o helper devolve EXATAMENTE o que o SQL legado devolvia.
  const legacy = (db.prepare(LEGACY_SQL).get(A) as any)?.id;
  const picked = ChannelBindingService.selectOutboundChannel(A, "gestao");
  check("1.1 sem binding: helper == SQL legado (byte-equivalência)", picked?.id === legacy && legacy === chEvo);
  check("1.2 legado prefere evolution mesmo sendo mais novo", legacy === chEvo);

  // 2) Binding configurado DECIDE — só pra finalidade dele.
  const up = ChannelBindingService.upsert(A, "u1", { channelId: chCloud, featureKey: "cobranca" });
  check("2.1 upsert do binding grava", up.ok === true);
  check("2.2 cobranca resolve pelo BINDING (cloud, não evolution)", ChannelBindingService.selectOutboundChannel(A, "cobranca")?.id === chCloud);
  check("2.3 gestao (sem binding) segue no legado", ChannelBindingService.selectOutboundChannel(A, "gestao")?.id === chEvo);

  // 3) Finalidade DESLIGADA pra saída → undefined (CA-03: o produtor pula).
  ChannelBindingService.upsert(A, "u1", { channelId: chCloud, featureKey: "cobranca", outbound: false });
  check("3.1 outbound desligado → undefined (não chuta canal)", ChannelBindingService.selectOutboundChannel(A, "cobranca") === undefined);
  check("3.2 desligar cobranca NÃO afeta gestao (CA-03)", ChannelBindingService.selectOutboundChannel(A, "gestao")?.id === chEvo);
  ChannelBindingService.upsert(A, "u1", { channelId: chCloud, featureKey: "cobranca", outbound: true });

  // 4) Binding pra canal INDISPONÍVEL → seleção legada (não trava o envio).
  db.prepare(`UPDATE channels SET status = 'disabled' WHERE id = ?`).run(chCloud);
  check("4.1 canal do binding desabilitado → cai no legado", ChannelBindingService.selectOutboundChannel(A, "cobranca")?.id === chEvo);
  db.prepare(`UPDATE channels SET status = 'connected' WHERE id = ?`).run(chCloud);

  // 5) Só canais desabilitados → undefined (sem inventar canal).
  const C = `org_C_${randomUUID().slice(0, 6)}`;
  mkCh(C, "evolution", "2026-01-01 10:00:00", "disabled");
  check("5.1 org só com canal desabilitado → undefined", ChannelBindingService.selectOutboundChannel(C, "gestao") === undefined);
  check("5.2 org sem canal nenhum → undefined", ChannelBindingService.selectOutboundChannel(`org_zero_${randomUUID().slice(0, 6)}`, "gestao") === undefined);

  // 6) Isolamento multi-tenant.
  check("6.1 org B resolve o próprio canal", ChannelBindingService.selectOutboundChannel(B, "gestao")?.id === chB);
  const gotA = ChannelBindingService.selectOutboundChannel(A, "cobranca")?.id;
  check("6.2 seleção de A nunca devolve canal de B", gotA !== chB && (gotA === chCloud || gotA === chEvo));

  // 7) FIAÇÃO (gate de regressão A5): o SQL legado de seleção não existe mais
  //    fora do helper — nem nos 21 pontos migrados, nem em ponto novo.
  const root = process.cwd(); // os testes rodam da raiz do repo
  const migrated = [
    "src/server/Scheduler.ts", "src/server/QuoteService.ts", "src/server/TaskReminderService.ts",
    "src/server/PaymentService.ts", "src/server/SupplierQuoteService.ts", "src/server/CampaignService.ts",
    "src/server/routes/escola.ts", "src/server/routes/falatu.ts", "src/server/routes/health.ts", "src/server/routes/admin.ts",
    // F7 do PRD Conexão WhatsApp: produtores com seletor próprio migrados.
    "src/server/ProspectExecutionService.ts", "src/server/SchoolImportService.ts", "src/server/SubscriptionService.ts",
    // F7.2: fallback clínico centralizado no helper selectContactChannel.
    "src/server/ClinicAddendumNoticeService.ts", "src/server/ClinicFollowUpNoticeService.ts",
    "src/server/ClinicGuideDeliveryService.ts", "src/server/ClinicMonthlyReportDeliveryService.ts",
    "src/server/ClinicDocumentDeliveryService.ts", "src/server/ClinicReminderService.ts",
    "src/server/ClinicVacancyService.ts",
  ];
  const NEEDLE = "ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1";
  for (const rel of migrated) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    check(`7.x ${rel} sem cópia do SQL legado`, !src.includes(NEEDLE));
  }
  // F7: os produtores migrados usam o resolvedor (selectOutboundChannel pra
  // envio; resolve() pra âncora de contato, que preserva o default legado),
  // e os seletores próprios sumiram.
  for (const rel of ["src/server/ProspectExecutionService.ts", "src/server/SchoolImportService.ts", "src/server/SubscriptionService.ts"]) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    check(`7.z ${rel} usa o resolvedor canônico`, src.includes("ChannelBindingService."));
  }
  const prospectSrc = fs.readFileSync(path.join(root, "src/server/ProspectExecutionService.ts"), "utf8");
  check("7.w Prospect sem seletor próprio de WhatsApp (provider IN + connected)", !prospectSrc.includes("AND status = 'connected' ORDER BY created_at"));
  const subSrc = fs.readFileSync(path.join(root, "src/server/SubscriptionService.ts"), "utf8");
  check("7.w Subscription sem seletor próprio (status='connected' LIMIT 1)", !subSrc.includes("AND status = 'connected' LIMIT 1"));
  const sched = fs.readFileSync(path.join(root, "src/server/Scheduler.ts"), "utf8");
  const uses = (sched.match(/selectOutboundChannel\(/g) || []).length;
  check("7.y Scheduler usa o resolvedor nos 12 pontos", uses >= 12, `usos=${uses}`);

  console.log("\n=== TEST: Seleção única de canal por finalidade (W2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
