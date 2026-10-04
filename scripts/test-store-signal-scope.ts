/**
 * TESTE — Gerente de loja só vê os SINAIS da(s) loja(s) dele (StoreSignalScopeService)
 * ----------------------------------------------------------------------------
 * O feed de atenção (`business_signals`) é da EMPRESA inteira. Na TOULON o gerente da Carioca via, no Hoje e na
 * Central de Saúde, "Produtos com divergência de estoque — Grande Rio", "A loja está abaixo da meta — Av. Brasil" e
 * "100 riscos sendo acompanhados" (somando as outras lojas). Prova, nas superfícies reais:
 *   - Caixa de Entrada Inteligente (alimenta o Hoje) · Central de Saúde · Hoje · Executando · feed /signals/attention
 *   - o gerente enxerga o sinal da PRÓPRIA loja e os sinais que não são de loja (ex.: financeiro);
 *   - NÃO enxerga: sinal da outra loja, padrões da rede (sem loja identificável) nem ação nascida de sinal de outra loja;
 *   - a contagem de "riscos acompanhados" não soma as outras lojas;
 *   - dono e admin SEM loja atribuída (irrestritos) enxergam TUDO — 0-regressão.
 *
 * Uso:  npm run test:store-signal-scope
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-signal-scope-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-signal-scope-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { SmartInboxService } = await import("../src/server/SmartInboxService.js");
  const { BusinessHealthService } = await import("../src/server/BusinessHealthService.js");
  const { StoreSignalScopeService: SC } = await import("../src/server/StoreSignalScopeService.js");
  const { TodayCockpitService } = await import("../src/server/TodayCockpitService.js");
  const { ExecutingBoardService } = await import("../src/server/ExecutingBoardService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const ORG = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'TOULON', 'active')`).run(randomUUID(), ORG);
  P.seedSystemProfiles(ORG);
  const profile = (key: string) => (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(ORG, key) as any)?.id;
  const mk = (role: string, key: string) => ({ userId: randomUUID(), id: randomUUID(), role, role_profile_id: profile(key) });
  const owner = mk("owner", "owner"), mgr = mk("admin", "gerente"), coAdmin = mk("admin", "gerente");

  const carioca = randomUUID(), grande = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Carioca-LOJA', 'CAR', 1)`).run(carioca, ORG);
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'GrandeRio-LOJA', 'GRD', 1)`).run(grande, ORG);
  db.prepare(`INSERT INTO user_stores (organization_id, user_id, store_id) VALUES (?, ?, ?)`).run(ORG, mgr.userId, carioca); // gerente preso à Carioca

  const pub = (signalType: string, domain: string, service: string, entityType: string | null, entityId: string | null, store: string, severity = "risk") =>
    BS.publish(ORG, { domain, signalType, severity, basis: "fact", confidence: 1, sourceService: service, sourceEntityType: entityType, sourceEntityId: entityId, evidence: { store }, dedupeKey: `${signalType}:${entityId || store}` } as any);
  const sA = pub("retail_store_stockout", "inventory", "RetailOpsSignalPublisher", "retail_store", carioca, "Carioca-LOJA");
  const sB = pub("retail_store_stockout", "inventory", "RetailOpsSignalPublisher", "retail_store", grande, "GrandeRio-LOJA");
  const sB2 = pub("retail_store_below_quota", "retail_ops", "RetailOpsSignalPublisher", "retail_store", grande, "GrandeRio-LOJA", "attention");
  const sP = pub("retail_pattern_negative_stock", "retail_ops", "RetailPatternMemoryService", "retail_store_pattern", randomUUID(), "GrandeRio-LOJA");
  const sF = pub("cash_low", "finance", "FinanceService", "organization", ORG, "—", "critical");
  const idOf = (r: any) => String(r?.id ?? r?.signalId ?? "");

  // ações: uma nascida do sinal da B (esconder), uma da A (mostrar)
  const act = (title: string, signalId: string) => { const id = randomUUID(); db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, signal_id) VALUES (?, ?, 'inventory', 'transfer', ?, 'awaiting_approval', 'single', 'rule', 10, ?)`).run(id, ORG, title, signalId); return id; };
  const actA = act("Repor estoque Carioca-LOJA", idOf(sA)), actB = act("Repor estoque GrandeRio-LOJA", idOf(sB));

  // ── a regra em si ──
  const hid = SC.hiddenFor(ORG, mgr)!;
  check("gerente preso: esconde o sinal da outra loja, o 2º da outra loja e o padrão da rede", hid.has(idOf(sB)) && hid.has(idOf(sB2)) && hid.has(idOf(sP)));
  check("…e NÃO esconde o da própria loja nem o financeiro (não é de loja)", !hid.has(idOf(sA)) && !hid.has(idOf(sF)));
  check("dono → null (sem restrição)", SC.hiddenFor(ORG, owner) === null);
  check("admin SEM loja atribuída (co-admin) → null (0-regressão)", SC.hiddenFor(ORG, coAdmin) === null);
  const ha = SC.hiddenActionsFor(ORG, mgr)!;
  check("ação nascida de sinal de OUTRA loja é escondida; a da própria não", ha.has(actB) && !ha.has(actA));

  // ── Caixa de Entrada (alimenta o Hoje) ──
  const inboxM = SmartInboxService.build(ORG, mgr), inboxO = SmartInboxService.build(ORG, owner);
  const titles = (b: any) => Object.values(b.categories).flat().map((i: any) => `${i.id}`);
  const idsM = new Set(titles(inboxM)), idsO = new Set(titles(inboxO));
  check("caixa de entrada do dono tem os 5 sinais e as 2 ações", [sA, sB, sB2, sP, sF].every((s) => idsO.has(idOf(s))) && idsO.has(actA) && idsO.has(actB));
  check("caixa do gerente: vê o da Carioca e o financeiro", idsM.has(idOf(sA)) && idsM.has(idOf(sF)));
  check("caixa do gerente: NÃO vê Grande Rio, o padrão da rede nem a ação da outra loja", !idsM.has(idOf(sB)) && !idsM.has(idOf(sB2)) && !idsM.has(idOf(sP)) && !idsM.has(actB) && idsM.has(actA));
  check("'riscos acompanhados' do gerente NÃO soma as outras lojas (4 no dono → 2 no gerente)", inboxO.counts.risk === 4 && inboxM.counts.risk === 2, `${inboxO.counts.risk}/${inboxM.counts.risk}`);

  // ── Central de Saúde ──
  const hcM = BusinessHealthService.overview(ORG, 0, SC.hiddenFor(ORG, mgr)) as any;
  const hcO = BusinessHealthService.overview(ORG, 0, SC.hiddenFor(ORG, owner)) as any;
  const hcTitles = (o: any) => JSON.stringify(o.attention?.items || []);
  check("Central de Saúde do dono lista assuntos de várias lojas", hcO.attention.count >= 3, String(hcO.attention.count));
  check("Central de Saúde do gerente tem MENOS assuntos e nenhum da Grande Rio", hcM.attention.count < hcO.attention.count && !/GrandeRio/.test(hcTitles(hcM)), `${hcO.attention.count}/${hcM.attention.count}`);

  // ── Hoje ──
  const todayM = TodayCockpitService.build(ORG, mgr), todayO = TodayCockpitService.build(ORG, owner);
  const ptxt = (t: any) => JSON.stringify(t.priorities);
  check("Hoje do gerente: nenhuma prioridade da Grande Rio", !/GrandeRio|Grande Rio/.test(ptxt(todayM)), ptxt(todayM).slice(0, 900));
  check("Hoje do dono segue com prioridades (0-regressão)", todayO.priorities.length > 0);

  // ── Executando ──
  const exM = JSON.stringify(ExecutingBoardService.build(ORG, mgr)), exO = JSON.stringify(ExecutingBoardService.build(ORG, owner));
  check("Executando do gerente: sem a ação da outra loja; dono vê as duas", !/GrandeRio-LOJA/.test(exM) && /GrandeRio-LOJA/.test(exO) && /Carioca-LOJA/.test(exM), exM.slice(0, 160));

  // ── feed /signals/attention (BusinessSignalService.attention com o filtro) ──
  const feedM = BS.attention(ORG, { limit: 100, hideSignalIds: hid }).items.map((i: any) => i.id);
  const feedO = BS.attention(ORG, { limit: 100 }).items.map((i: any) => i.id);
  check("feed de atenção: o gerente perde só os sinais de outras lojas", feedO.length - feedM.length === 3 && feedM.includes(idOf(sA)) && !feedM.includes(idOf(sB)), `${feedO.length}/${feedM.length}`);

  // ── isolamento entre empresas ──
  const OTHER = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), OTHER);
  check("sinais de OUTRA empresa nunca entram no conjunto escondido (isolamento)", ![...hid].some((id) => (db.prepare("SELECT organization_id FROM business_signals WHERE id = ?").get(id) as any)?.organization_id !== ORG));

  console.log("\n=== Gerente de loja: sinais só da própria loja ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} store-signal-scope: ${results.length - failures}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } process.exit(1); });
