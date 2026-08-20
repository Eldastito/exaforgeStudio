/**
 * TEST — Disponibilidade subtrai o Google busy (ADR-180 F6.2). DB-backed, det., SEM rede
 * (fetch injetado). Prova: o compromisso do Google do profissional some das vagas
 * OFERECIDAS; sem conexão nada muda (0-regressão); falha no Google não derruba a agenda.
 *
 * Uso: npm run test:professional-availability-google
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-availg-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-availg-123456";
process.env.GOOGLE_CLIENT_ID = "cid.test"; process.env.GOOGLE_CLIENT_SECRET = "csecret.test"; process.env.APP_URL = "https://app.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// fetch falso: token(code+refresh), userinfo, e freeBusy com ocupado 10:00–11:00 UTC.
function makeFetch(opts: { throwOnFreeBusy?: boolean }): typeof fetch {
  return (async (url: any, init?: any): Promise<any> => {
    const u = String(url);
    const json = (o: any, ok = true, status = 200) => ({ ok, status, json: async () => o });
    if (u.includes("oauth2.googleapis.com/token")) {
      if (String(init?.body || "").includes("grant_type=refresh_token")) return json({ access_token: "acc-r", expires_in: 3600 });
      return json({ access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 });
    }
    if (u.includes("oauth2/v3/userinfo")) return json({ email: "vet@ex.com", name: "Vet" });
    if (u.includes("/freeBusy")) {
      if (opts.throwOnFreeBusy) throw new Error("network down");
      return json({ calendars: { primary: { busy: [{ start: "2026-08-24T10:00:00Z", end: "2026-08-24T11:00:00Z" }] } } });
    }
    return json({}, false, 404);
  }) as any;
}

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ProfessionalService: PRO } = await import("../src/server/ProfessionalService.js");
  const { ClinicProfessionalRelationshipService: REL } = await import("../src/server/ClinicProfessionalRelationshipService.js");
  const { ProfessionalScheduleConfigService: CFG } = await import("../src/server/ProfessionalScheduleConfigService.js");
  const { ProfessionalAvailabilityService: AV } = await import("../src/server/ProfessionalAvailabilityService.js");
  const { ProfessionalBookingService: BOOK } = await import("../src/server/ProfessionalBookingService.js");
  const { ProfessionalGoogleService: G } = await import("../src/server/ProfessionalGoogleService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, professional_network_enabled) VALUES (?, ?, 'Clin', 'active', 'petshop', 1)`).run(randomUUID(), A);
  const svc = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, duration_minutes) VALUES (?, ?, 'service', 'Consulta', 100, 60)`).run(svc, A);
  const pid = PRO.upsertIdentity({ name: "Vet", council: "CRMV-SP", registrationNumber: "12345" }, A).id;
  const rel = REL.invite(A, { professionalId: pid, permissions: { services: [svc] } }).id;
  REL.accept(A, rel);
  CFG.setOffering(A, rel, { serviceId: svc, durationMin: 60 });
  // Segunda 2026-08-24, janela 09:00–12:00 → slots 09:00, 10:00, 11:00 (UTC).
  CFG.setWindows(A, rel, [{ dayOfWeek: 1, start: "09:00", end: "12:00", bufferMin: 0 }]);
  const NOW = "2026-08-24T08:00:00.000Z";
  const times = (slots: any[]) => slots.map((s) => s.start.slice(11, 16));

  // 1. Núcleo puro: externalBusy 10:00–11:00 exclui o slot das 10:00.
  const busy1000 = [{ start: new Date("2026-08-24T10:00:00Z").getTime(), end: new Date("2026-08-24T11:00:00Z").getTime() }];
  const pure = AV.availableSlots(A, rel, "2026-08-24", { serviceId: svc, nowISO: NOW, externalBusy: busy1000 });
  check("1.1 externalBusy remove o slot das 10:00", !times(pure).includes("10:00") && times(pure).includes("09:00") && times(pure).includes("11:00"));

  // baseline sem busy: 3 slots.
  const base = AV.availableSlots(A, rel, "2026-08-24", { serviceId: svc, nowISO: NOW });
  check("1.2 baseline sem busy tem os 3 slots", times(base).join(",") === "09:00,10:00,11:00");

  // 2. Conecta o Google (busy 10:00–11:00) → getAvailability tira o 10:00.
  G.deps.fetchFn = makeFetch({});
  const url = G.authUrl(pid, A); const state = new URL(url).searchParams.get("state") || "";
  await G.handleCallback("code", state);
  const withG = await BOOK.getAvailability(A, rel, "2026-08-24", { serviceId: svc, nowISO: NOW });
  check("2.1 getAvailability subtrai o Google busy (10:00 fora)", !times(withG).includes("10:00"));
  check("2.2 slots livres do Google permanecem", times(withG).includes("09:00") && times(withG).includes("11:00"));

  // 3. Sem conexão → 0-regressão (todos os slots).
  G.disconnect(pid);
  const noG = await BOOK.getAvailability(A, rel, "2026-08-24", { serviceId: svc, nowISO: NOW });
  check("3.1 sem Google conectado → 3 slots (0-regressão)", times(noG).join(",") === "09:00,10:00,11:00");

  // 4. Best-effort: erro no freeBusy não derruba a disponibilidade.
  G.deps.fetchFn = makeFetch({ throwOnFreeBusy: true });
  const url2 = G.authUrl(pid, A); await G.handleCallback("code", new URL(url2).searchParams.get("state") || "");
  const boom = await BOOK.getAvailability(A, rel, "2026-08-24", { serviceId: svc, nowISO: NOW });
  check("4.1 falha no Google → agenda segue (todos os slots)", times(boom).join(",") === "09:00,10:00,11:00");

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} professional-availability-google: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
