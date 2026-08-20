/**
 * TEST — Google Calendar por profissional (ADR-180 F6.1). DB-backed, det., SEM rede
 * (fetch injetado). Prova: conexão GLOBAL por professional_id, tokens CIFRADOS, OAuth
 * state assinado (tampering recusado), freeBusy estruturado, create/delete de evento,
 * status redigido e desconexão. Least-privilege (escopo calendar-only).
 *
 * Uso: npm run test:professional-google
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-profg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-profg-123456";
process.env.GOOGLE_CLIENT_ID = "cid.test"; process.env.GOOGLE_CLIENT_SECRET = "csecret.test"; process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// fetch falso: roteia por URL. Cobre token(code+refresh), userinfo, freeBusy, event create/delete.
function fakeFetch(created: { id: string }): typeof fetch {
  return (async (url: any, init?: any): Promise<any> => {
    const u = String(url);
    const json = (o: any, ok = true, status = 200) => ({ ok, status, json: async () => o });
    if (u.includes("oauth2.googleapis.com/token")) {
      const body = String(init?.body || "");
      if (body.includes("grant_type=refresh_token")) return json({ access_token: "acc-refreshed", expires_in: 3600 });
      return json({ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 });
    }
    if (u.includes("oauth2/v3/userinfo")) return json({ email: "vet@ex.com", name: "Dra. Ave" });
    if (u.includes("/freeBusy")) return json({ calendars: { primary: { busy: [{ start: "2026-08-24T09:00:00Z", end: "2026-08-24T10:00:00Z" }] } } });
    if (u.includes("/events/")) return json({}, true, 200); // delete
    if (u.includes("/events")) return json({ id: created.id, htmlLink: "http://ev" });
    return json({}, false, 404);
  }) as any;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ProfessionalGoogleService: G } = await import("../src/server/ProfessionalGoogleService.js");
  G.deps.fetchFn = fakeFetch({ id: "evt-123" });

  const orgA = `org_${randomUUID().slice(0, 8)}`, orgB = `org_${randomUUID().slice(0, 8)}`;
  const pid = PRO.upsertIdentity({ name: "Dra. Ave", council: "CRMV-SP", registrationNumber: "12345" }, orgA).id;

  // 1. Configurado + authUrl com state assinado.
  check("1.1 isConfigured (env presente)", G.isConfigured() === true);
  const url = G.authUrl(pid, orgA);
  const state = new URL(url).searchParams.get("state") || "";
  check("1.2 authUrl escopo calendar-only (least-privilege)", /calendar\.events/.test(url) && /calendar\.freebusy/.test(url) && !/drive|spreadsheets|gmail/.test(url));
  check("1.3 state assinado presente", state.includes("."));

  // 2. handleCallback grava a conexão (troca code→token via fetch injetado).
  const okPid = await G.handleCallback("the-code", state);
  check("2.1 callback devolve o professionalId", okPid === pid);
  const st = G.status(pid);
  check("2.2 status conectado + e-mail", st.connected === true && st.email === "vet@ex.com");
  check("2.3 status é redigido (sem token)", !("access_token" in (st as any)));

  // 3. Tokens CIFRADOS em repouso (nunca plaintext).
  const raw = db.prepare("SELECT access_token, refresh_token FROM professional_google_connections WHERE professional_id = ?").get(pid) as any;
  check("3.1 access_token cifrado (enc:)", typeof raw.access_token === "string" && raw.access_token.startsWith("enc:"));
  check("3.2 refresh_token cifrado (enc:)", typeof raw.refresh_token === "string" && raw.refresh_token.startsWith("enc:"));

  // 4. Conexão é GLOBAL (por professional_id, sem organization_id na chave).
  const conn = G.getConnection(pid);
  check("4.1 getConnection decifra o access_token", conn.access_token === "acc-1");
  const cols = (db.prepare("PRAGMA table_info(professional_google_connections)").all() as any[]).map((c) => c.name);
  check("4.2 tabela não tem organization_id (chave é o profissional, GLOBAL)", !cols.includes("organization_id") && cols.includes("professional_id"));

  // 5. getAccessToken usa o válido sem refresh; freeBusy estruturado.
  const tk = await G.getAccessToken(pid);
  check("5.1 access_token válido reaproveitado (sem refresh)", tk === "acc-1");
  const busy = await G.busyIntervals(pid, { timeMinISO: "2026-08-24T00:00:00Z", timeMaxISO: "2026-08-25T00:00:00Z" });
  check("5.2 freeBusy estruturado {start,end} ms", busy.length === 1 && busy[0].end > busy[0].start);

  // 6. create/delete de evento.
  const evId = await G.createEvent(pid, { summary: "Cirurgia", startISO: "2026-08-24T11:00:00Z", endISO: "2026-08-24T12:00:00Z" });
  check("6.1 createEvent devolve id", evId === "evt-123");
  check("6.2 deleteEvent ok", (await G.deleteEvent(pid, "evt-123")) === true);

  // 7. State ADULTERADO é recusado (anti-CSRF) — não grava nada.
  const pid2 = PRO.upsertIdentity({ name: "Dr. Dois", council: "CRMV-SP", registrationNumber: "222" }, orgA).id;
  const url2 = G.authUrl(pid2, orgA);
  const badState = (new URL(url2).searchParams.get("state") || "") + "x";
  const bad = await G.handleCallback("code", badState);
  check("7.1 state adulterado → null", bad === null);
  check("7.2 nada gravado pro pid2", G.status(pid2).connected === false);

  // 8. Profissional não conectado → honesto (null/vazio).
  check("8.1 sem conexão → getAccessToken null", (await G.getAccessToken(pid2)) === null);
  check("8.2 sem conexão → busy vazio", (await G.busyIntervals(pid2, { timeMinISO: "2026-08-24T00:00:00Z", timeMaxISO: "2026-08-25T00:00:00Z" })).length === 0);

  // 9. Desconectar.
  G.disconnect(pid);
  check("9.1 desconectado", G.status(pid).connected === false);
  check("9.2 sem token após desconectar", (await G.getAccessToken(pid)) === null);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-google: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
