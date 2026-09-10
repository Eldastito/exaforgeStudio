/**
 * TEST — F7.2 (RF §21 §598.1 / Gate G7): ENSAIO OFFLINE do ciclo representativo
 * do piloto (staging com fixtures, o passo que ANTECEDE o número autorizado).
 *
 * NÃO é o piloto real (isso é do dono: flags de produção, números autorizados,
 * janela de observação). É a prova, num banco ISOLADO com o CONJUNTO DE FLAGS DO
 * PILOTO LIGADO, de que o ciclo é EXERCITÁVEL e OBSERVÁVEL sem efeito externo —
 * compõe os serviços REAIS das Fases 1–6 (nada de produção novo). Cobre os
 * quatro trilhos do §530 (atendimento · gestão · automação agendada · arquivos)
 * e confere que as TRÊS superfícies de observação refletem a atividade de forma
 * coerente, e que NADA vaza para uma 2ª org com as flags desligadas.
 *
 * Uso: npm run test:piloto-ciclo-representativo
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-piloto-ciclo-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-piloto-1";
process.env.APP_URL = "https://app.test"; // links assinados absolutos (F5.3)
process.env.CONTINUITY_DELIVERY_MAX_ATTEMPTS = "2";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MixedModeRouterService: R } = await import("../src/server/MixedModeRouterService.js");
  const { MessageDeliveryService: MD } = await import("../src/server/MessageDeliveryService.js");
  const { WhatsAppHealthService: WH } = await import("../src/server/WhatsAppHealthService.js");
  const { ChannelStateService: CS } = await import("../src/server/ChannelStateService.js");
  const { FalaTuBridgeReconService: BR } = await import("../src/server/FalaTuBridgeReconService.js");
  const { ChannelBindingService, OutboundFeatureDisabledError } = await import("../src/server/ChannelBindingService.js");
  const { FileDeliveryService: FD } = await import("../src/server/FileDeliveryService.js");
  const { MessageProviderService: MP } = await import("../src/server/MessageProviderService.js");
  const { ContextEngineService: CE } = await import("../src/server/ContextEngineService.js");
  const { PermissionService } = await import("../src/server/PermissionService.js");
  const { setWebhookEnforced, recordWebhookHit } = await import("../src/server/webhookSecurity.js");
  const { XLSX_MIME } = await import("../src/server/XlsxService.js");

  // ── fixtures: org PILOTO (A, flags ON) + org de CONTROLE (B, flags OFF) ──
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  const mkOrg = (id: string, flagsOn: boolean) => {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mixed_mode_enabled, falatu_enabled, falatu_bridge_tasks_enabled, falatu_bridge_lists_enabled) VALUES (?, ?, 'T', 'active', ?, ?, ?, ?)`)
      .run(randomUUID(), id, flagsOn ? 1 : 0, flagsOn ? 1 : 0, flagsOn ? 1 : 0, flagsOn ? 1 : 0);
  };
  mkOrg(A, true); mkOrg(B, false);
  PermissionService.seedSystemProfiles(A);

  const mkUser = (org: string, phone: string | null, role: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, 'U', ?, ?, ?, 'active')`).run(id, org, `${id}@t.com`, phone, role);
    return id;
  };
  const mkCh = (org: string, name: string, kind = "client", status = "connected") => {
    const id = `ch_${name}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, kind, token_encrypted) VALUES (?, ?, 'whatsapp_cloud', ?, ?, ?, ?, 'SECRET_TOKEN')`).run(id, org, name, name, status, kind);
    return id;
  };
  const bind = (org: string, ch: string, feature: string, outbound: number) =>
    db.prepare(`INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, inbound, outbound) VALUES (?, ?, ?, ?, 1, ?)`).run(randomUUID(), org, ch, feature, outbound);

  const chComercial = mkCh(A, "comercial", "client");     // atendimento + gestão (modo misto)
  const chAutomacao = mkCh(A, "automacao", "client");     // cadências/automação
  const chArquivos = mkCh(A, "arquivos", "client");       // relatórios (gestão)

  // Conjunto de flags do piloto: webhook enforce ON (A10) + finalidades (F2.4).
  setWebhookEnforced(true);
  bind(A, chAutomacao, "cobranca", 0);  // finalidade cobrança DESLIGADA de propósito (silenciar automação)
  bind(A, chArquivos, "gestao", 0);     // relatório (gestão) DESLIGADO de propósito
  bind(A, chComercial, "atendimento", 1);

  // ═══ TRILHO 1 — ATENDIMENTO (cliente desconhecido → único que autoriza CRM) ═══
  const d1 = R.route(A, "5511900000001", { channelKind: "client" });
  check("1.1 cliente desconhecido → attendance (autoriza CRM)", d1.lane === "attendance");
  check("1.2 sem identidade elevada (userId/role nulos)", d1.userId === null && d1.role === null);

  // ═══ TRILHO 2 — GESTÃO (gestor no MESMO número comercial, modo misto) ═══
  const gestor = mkUser(A, "5511988887777", "owner");
  // com contexto de cliente ativo → segue no atendimento (não sequestra a conversa)
  const dCtx = R.route(A, "5511988887777", { channelKind: "client", hasActiveCustomerContext: true });
  check("2.1 gestor com atendimento em curso → attendance", dCtx.lane === "attendance");
  // sem contexto → pergunta a faixa (§10.7, nunca infere por texto)
  const dAsk = R.route(A, "5511988887777", { channelKind: "client" });
  check("2.2 gestor sem contexto → ask_which (não vira lead)", dAsk.lane === "ask_which");
  // canal interno dedicado → gestão direta, com papel REAL
  const dInt = R.route(A, "5511988887777", { channelKind: "internal" });
  check("2.3 gestor em canal interno → internal + papel real", dInt.lane === "internal" && dInt.userId === gestor && dInt.role === "owner");

  // ═══ TRILHO 3 — AUTOMAÇÃO AGENDADA (fila durável carrega finalidade; gate silencia) ═══
  // (a) a fila carrega a finalidade até o sink (F6.1) — automação diária real.
  (MD as any).__setSenderForTests(async () => "wamid-auto");
  for (let i = 0; i < 5; i++) MD.enqueue(A, { messageId: randomUUID(), channelId: chAutomacao, recipient: `5511${i}`, content: "lembrete", feature: "agenda" });
  const queued = db.prepare(`SELECT feature FROM message_deliveries WHERE organization_id = ? AND channel_id = ? LIMIT 1`).get(A, chAutomacao) as any;
  check("3.1 fila durável carrega a finalidade da automação (F6.1)", queued?.feature === "agenda");
  const summary = await MD.dispatchDue(100);
  check("3.2 automação agendada despacha (envio representativo)", summary.sent >= 5);
  // (b) desligar a finalidade SILENCIA só ela, antes de tocar o provedor (CA-03).
  let blocked = false;
  try { ChannelBindingService.assertOutboundAllowed(A, "cobranca", { unitId: null }); } catch (e) { blocked = e instanceof OutboundFeatureDisabledError; }
  check("3.3 automação de finalidade DESLIGADA é bloqueada no gate (CA-03)", blocked === true);
  check("3.4 outra finalidade do mesmo canal segue liberada", (() => { try { ChannelBindingService.assertOutboundAllowed(A, "atendimento"); return true; } catch { return false; } })());

  // ═══ TRILHO 4 — ARQUIVOS (pedir relatório → 3 formatos; permissão/fallback) ═══
  // snapshot com dado de vendas + finance sensível (projeção por papel).
  (CE as any).build = (_o: string) => ({ narrative: "Panorama.", snapshot: { domains: { sales: { total: 120 }, finance: { caixa: 9000 } }, topPriorities: [], dataQuality: {} }, snapshotEnabled: true, sources: [], generatedAt: "", schemaVersion: 1 });
  const userFor = (key: string) => ({ userId: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(A, key) as any)?.id, role: key });
  const owner = userFor("owner");
  // (a) finalidade "gestao" DESLIGADA no canal de arquivos → NÃO manda link (§14): pausa.
  const blockedFile = await FD.deliverNow(A, { channelId: chArquivos, toIdentifier: "5511999", user: owner, format: "pdf", catalogKey: "executive_summary" });
  check("4.1 relatório com finalidade desligada → pausa (nem link) — §14", blockedFile.sent === false && (blockedFile as any).reason === "feature_disabled");
  // (b) com a finalidade LIGADA + provedor stubado → entrega tipada, URL absoluta.
  db.prepare(`UPDATE channel_feature_bindings SET outbound = 1 WHERE organization_id = ? AND channel_id = ? AND feature_key = 'gestao'`).run(A, chArquivos);
  let lastDoc: any = null;
  (MP as any).sendDocument = async (channelId: string, to: string, url: string, fileName: string, caption: string, opts: any) => { lastDoc = { url, fileName, opts }; return true; };
  const okXlsx = await FD.deliverNow(A, { channelId: chArquivos, toIdentifier: "5511999", user: owner, format: "xlsx", catalogKey: "executive_summary" });
  check("4.2 relatório liberado → entrega nativa", okXlsx.sent === true && (okXlsx as any).native === true);
  check("4.3 URL absoluta (APP_URL) + MIME tipado por formato", String(lastDoc?.url || "").startsWith("https://app.test") && lastDoc?.opts?.mimeType === XLSX_MIME);

  // ═══ OBSERVAÇÃO — as três superfícies refletem a atividade, coerentes ═══
  recordWebhookHit(true, "recebido"); // 1º evento real → webhook healthy
  // (1) saúde do envio (token-safe)
  const health = WH.channelHealth(A);
  const byName = Object.fromEntries(health.map((h) => [h.channelId, h]));
  check("5.1 saúde: canal da automação com envios OK", byName[chAutomacao]?.counts.sent >= 5);
  check("5.2 saúde é TOKEN-SAFE (segredo do canal nunca vaza)", !JSON.stringify(health).includes("SECRET_TOKEN"));
  const metrics = WH.metrics(A);
  check("5.3 métricas mínimas derivadas (volume enviado)", metrics.sent >= 5);
  // (2) estados lógicos do canal (4 dimensões, RF-02)
  const st = CS.state(A, chComercial);
  check("5.4 estado lógico: sessão connected + webhook healthy → operação ready", st?.session === "connected" && st?.webhook === "healthy" && st?.operation === "ready");
  check("5.5 webhook enforce ligado é observável", CS.webhookEnforced() === true);
  // (3) consolidação de registros (surface observável e isolada)
  const rec = BR.records(A);
  check("5.6 relatório de consolidação é consultável (counts por classe)", rec && typeof rec.counts === "object" && "linked_ok" in rec.counts);

  // ═══ ISOLAMENTO — org de controle (flags OFF) não vê nada do piloto ═══
  check("6.1 org de controle sem canais na saúde", WH.channelHealth(B).length === 0 && WH.metrics(B).sent === 0);
  check("6.2 org de controle sem estados de canal", CS.list(B).length === 0);
  check("6.3 canal do piloto não é visível na org de controle", CS.state(B, chComercial) === null);
  check("6.4 binding do piloto não vaza (gate passa na org de controle)", (() => { try { ChannelBindingService.assertOutboundAllowed(B, "cobranca"); return true; } catch { return false; } })());

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} piloto-ciclo-representativo: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
