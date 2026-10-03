/**
 * TESTE — Fase 2 / F2.6 (ADR-203): "Empresa" + Integrações/Canais em MODO NORMAL (IntegrationStatusService + GET /api/ux/integration-status).
 * Prova: (1) org sem ERP: nem aparece card de Alterdata; (2) ERP sem token → "Parada"; (3) ERP verde → "Conectada" com "última sync às HH:MM",
 * fluxos (Estoque/Preços/Vendas) ok; (4) "1 filial requer atenção" conta filiais DISTINTAS com recurso falhando; módulo falhando vira atenção;
 * (5) sync velha (> 4× o intervalo) vira ATENÇÃO + carimbo; sem nenhuma sync = "ainda não sincronizou", nunca "conectada";
 * (6) nada de segredo/token/credencial na resposta (o técnico fica no modo avançado, que é linkado); (7) canais conectado × desconectado;
 * (8) só gestor — vendedor recebe `restricted`; (9) isolamento por org; (10) rota montada; nav "Empresa" abre a tela própria; telas técnicas preservadas.
 * Determinístico, sem rede, sem LLM.
 * Uso:  npm run test:integration-status
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f26-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-integration-status-1234567890";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { IntegrationStatusService: S } = await import("../src/server/IntegrationStatusService.js");
  const { AlterdataConnectorService: C } = await import("../src/server/AlterdataConnectorService.js");
  const { AlterdataSyncLedgerService: L } = await import("../src/server/AlterdataSyncLedgerService.js");
  const owner = { role: "owner" }, vendedor = { role: "vendedor" };

  const cfg = (org: string, token: boolean) => {
    C.saveSettings(org, { enabled: true, environment: "homolog", authConfig: { clientId: "cid-secreto", clientSecret: "csecret-secreto" }, rede: "REDE-X", filiais: ["001", "002"], priceTable: "1", basePattern: "x-{module}.apimodaup.com.br" });
    if (token) C.setAccessToken(org, "TOKEN-SECRETO-123", new Date(Date.now() + 3600_000));
  };
  const green = (org: string) => { const h = L.begin(org, "homolog", "manual", "u");
    h.record({ module: "supply", resource: "Referencia", required: true, status: "ready", imported: 100 });
    h.record({ module: "supply", resource: "Saldo", filial: "001", required: true, status: "ready", imported: 50 });
    h.record({ module: "price", resource: "Preco", filial: "1", required: true, status: "ready", imported: 30 });
    h.record({ module: "sales", resource: "DataCaixa", required: true, status: "ready", imported: 10 });
    h.record({ module: "sales", resource: "VendaMalote", required: true, status: "ready", imported: 20 });
    h.finish(); };

  // ── (1) sem ERP ──
  const NOERP = `org_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?,?,?,?,?)`).run(randomUUID(), NOERP, "whatsapp_evolution", "WhatsApp Loja", "connected");
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?,?,?,?,?)`).run(randomUUID(), NOERP, "instagram", "Instagram Direct", "disconnected");
  let r = S.simple(NOERP, owner);
  check("org sem ERP: nenhum card de Alterdata", r.integrations.length === 0);
  check("canais: conectado 'Conectado' × desconectado 'precisa reconectar'", r.channels.length === 2 && r.channels.find(c => c.name === "WhatsApp Loja")?.state === "ok" && r.channels.find(c => c.name === "Instagram Direct")?.state === "attention" && /reconectar/.test(r.channels.find(c => c.name === "Instagram Direct")!.stateLabel) && r.channels.find(c => c.name === "WhatsApp Loja")?.kind === "WhatsApp");
  check("resumo conta só o que precisa de atenção ('1 ponto precisa de atenção')", r.summary === "1 ponto precisa de atenção.", String(r.summary));

  // ── (2) sem token → parada ──
  const DOWN = `org_${randomUUID().slice(0, 6)}`; cfg(DOWN, false);
  r = S.simple(DOWN, owner);
  check("ERP com credencial mas sem token: 'Parada' (nunca 'Conectada')", r.integrations[0]?.state === "down" && r.integrations[0].stateLabel === "Parada", JSON.stringify(r.integrations[0]?.state));

  // ── (5a) sem nenhuma sync ──
  const NOSYNC = `org_${randomUUID().slice(0, 6)}`; cfg(NOSYNC, true);
  r = S.simple(NOSYNC, owner);
  check("token ok mas NUNCA sincronizou: atenção + 'Ainda não sincronizou' (não diz 'Conectada')", r.integrations[0]?.state === "attention" && r.integrations[0].lastSyncAt === null && r.integrations[0].issues.some(i => /Ainda não sincronizou|ainda não/i.test(i.text)) && r.integrations[0].lastSyncHhmm === null, JSON.stringify(r.integrations[0]));

  // ── (3) verde ──
  const GREEN = `org_${randomUUID().slice(0, 6)}`; cfg(GREEN, true); green(GREEN);
  r = S.simple(GREEN, owner);
  const g = r.integrations[0];
  check("ERP verde: 'Conectada', última sync às HH:MM, não atrasada", g?.state === "ok" && g.stateLabel === "Conectada" && /^\d{2}:\d{2}$/.test(g.lastSyncHhmm || "") && g.stale === false, JSON.stringify(g && { s: g.state, h: g.lastSyncHhmm, st: g.stale }));
  check("fluxos em linguagem de dono (Estoque e compras · Preços · Vendas) todos ok", ["Estoque e compras", "Preços", "Vendas"].every(l => g.flows.some(f => f.label === l && f.state === "ok")), JSON.stringify(g.flows.map(f => f.label)));
  check("sem filial com problema: sem 'requer atenção'", g.attentionCount === 0 && g.attentionText === null);
  check("tela técnica preservada e linkada (modo avançado → 'integrations')", g.advancedViewMode === "integrations");
  const dump = JSON.stringify(r);
  check("NENHUM segredo na resposta (token, client id/secret, base URL)", !/TOKEN-SECRETO|cid-secreto|csecret-secreto|apimodaup|REDE-X/.test(dump));

  // ── (5b) sync velha ──
  const old = S.simple(GREEN, owner, { now: new Date(Date.now() + 5 * 3600_000) });
  check("sync com 5h: vira ATENÇÃO + stale + carimbo da última sync", old.integrations[0].state === "attention" && old.integrations[0].stale === true && old.integrations[0].issues.some(i => /Não sincroniza desde/.test(i.text)));

  // ── (4) filial com problema ──
  const BADF = `org_${randomUUID().slice(0, 6)}`; cfg(BADF, true);
  const h = L.begin(BADF, "homolog", "manual", "u");
  h.record({ module: "supply", resource: "Referencia", required: true, status: "ready", imported: 100 });
  h.record({ module: "supply", resource: "Saldo", filial: "002", required: true, status: "server_error", httpStatus: 500, errorCode: "ALTERDATA_API", errorMessage: "HTTP 500" });
  h.record({ module: "supply", resource: "Saldo", filial: "003", required: true, status: "server_error", httpStatus: 500, errorCode: "ALTERDATA_API", errorMessage: "HTTP 500" });
  h.record({ module: "supply", resource: "Entrada", filial: "003", required: false, status: "server_error", httpStatus: 500, errorCode: "ALTERDATA_API", errorMessage: "HTTP 500" });
  h.record({ module: "price", resource: "Preco", filial: "1", required: true, status: "ready", imported: 30 });
  h.record({ module: "sales", resource: "DataCaixa", required: true, status: "ready", imported: 10 });
  h.finish();
  r = S.simple(BADF, owner);
  const b = r.integrations[0];
  check("2 filiais DISTINTAS com recurso falhando → '2 filiais requerem atenção' (a 003 com 2 falhas conta 1 vez)", b.attentionCount === 2 && b.attentionText === "2 filiais requerem atenção", b.attentionText || "");
  check("com filial falhando o estado é ATENÇÃO e o fluxo 'Estoque e compras' acusa atenção", b.state === "attention" && b.flows.find(f => f.label === "Estoque e compras")?.state === "attention");
  check("problemas em linguagem de dono: nada de '(required)', 'server_error' ou código técnico", b.issues.length > 0 ? b.issues.every(i => !/required|server_error|ALTERDATA_API|MODULE_/.test(i.text + i.action)) : true, JSON.stringify(b.issues));
  check("fluxos sem ruído: 'Acesso' (guardian) nunca aparece", !b.flows.some(f => f.label === "Acesso" || f.key === "guardian"), JSON.stringify(b.flows.map(f => f.label)));
  const ONE = `org_${randomUUID().slice(0, 6)}`; cfg(ONE, true);
  const h1 = L.begin(ONE, "homolog", "manual", "u");
  h1.record({ module: "supply", resource: "Referencia", required: true, status: "ready", imported: 1 });
  h1.record({ module: "supply", resource: "Saldo", filial: "002", required: true, status: "server_error", httpStatus: 500, errorCode: "ALTERDATA_API", errorMessage: "HTTP 500" });
  h1.record({ module: "price", resource: "Preco", filial: "1", required: true, status: "ready", imported: 1 }); h1.finish();
  check("1 filial → singular: '1 filial requer atenção'", S.simple(ONE, owner).integrations[0].attentionText === "1 filial requer atenção");

  // ── (8) papel + (9) isolamento ──
  check("vendedor: restricted, sem cards, sem canais", (() => { const v = S.simple(GREEN, vendedor); return v.restricted === true && v.integrations.length === 0 && v.channels.length === 0 && v.summary === null; })());
  check("admin também vê (gestor)", S.simple(GREEN, { role: "admin" }).restricted === false);
  const other = S.simple(`org_${randomUUID().slice(0, 6)}`, owner);
  check("isolamento: outra org não vê o ERP nem os canais alheios", other.integrations.length === 0 && other.channels.length === 0 && other.summary === null);

  // ── (10) fiação ──
  check("rota GET /api/ux/integration-status montada", /router\.get\("\/integration-status"/.test(fs.readFileSync("src/server/routes/ux.ts", "utf8")));
  const nav = fs.readFileSync("src/lib/navCatalog.ts", "utf8"), app = fs.readFileSync("src/App.tsx", "utf8");
  check("nav 'Empresa' abre a tela própria; App renderiza CompanyView", /key: 'empresa', label: 'Empresa', viewMode: 'empresa'/.test(nav) && /viewMode === 'empresa' && <CompanyView \/>/.test(app));
  const view = fs.readFileSync("src/features/CompanyView.tsx", "utf8");
  check("telas técnicas preservadas: 'Integrações' e 'Canais e I.A.' seguem no catálogo e a Empresa linka o modo avançado", /viewMode: 'integrations'/.test(nav) && /viewMode: 'channels'/.test(nav) && /advancedViewMode/.test(view) && /setViewMode\('channels'/.test(view));

  console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
