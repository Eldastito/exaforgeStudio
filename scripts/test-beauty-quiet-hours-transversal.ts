/**
 * TEST — BEAUTY-011b (ADR-169 F5-transversal-B): janela silenciosa transversal
 * no SINK canônico `MessageProviderService.sendMessage`.
 *
 * Prova o guardrail RN-BS-12 aplicado no sink: pra QUALQUER envio outbound
 * (WA Cloud, Evolution, Instagram, disparado por Cadence/Playbook/Reminder/
 * Radar/... — os 30+ callers de sendMessage no repo), quando o dono liga
 * `client_quiet_hours_enforced=1`, o guard consulta a hora SP e recusa envio
 * dentro da janela silenciosa (default 22h→8h). Sem consent → passa da F5-A
 * antes; o quiet guard é DEPOIS do consent guard.
 *
 * Testabilidade: `evaluate(orgId, now?)` aceita `now` fixo pra testar cada hora
 * do dia sem depender do momento real do CI. O sink `sendMessage` NÃO aceita
 * `now` — pra testar via sink usamos hora corrente + janela custom que engloba
 * (ou não) a hora corrente.
 *
 * Checks-âncora:
 *  - Flag OFF (default) → SEMPRE PERMITE (0-regressão dura).
 *  - Flag ON + hora dentro da janela default (22→8) → BLOQUEIA (com hora SP + janela).
 *  - Flag ON + hora fora da janela → PERMITE.
 *  - Janela cruzando meia-noite (22→8): 23h e 3h dentro; 12h fora.
 *  - Janela DIURNA (8→22): 12h dentro (silêncio); 23h e 3h fora.
 *  - start == end: 24h dentro (silêncio total).
 *  - Custom start/end respeitado; null volta pro default.
 *  - Cross-tenant: janela da orgB não afeta orgA.
 *  - OutboundQuietHoursError.code === "outbound_blocked:quiet_hours".
 *  - Integração REAL com sendMessage — usando janela custom que garante bloqueio
 *    NA HORA ATUAL do teste (evita flakiness).
 *  - Read-only: guard NÃO muta organization_settings sozinho (só via setEnabled/setWindow).
 *
 * Uso: npm run test:beauty-quiet-hours-transversal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-quiet-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-quiet-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; note?: string }[] = [];
function check(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  if (!ok) failures++;
}

/** Constrói um `Date` cuja hora SP é `h` (aproximado — SP é UTC−3 sem DST em 2026). */
function dateAtSpHour(h: number): Date {
  // SP = UTC−3 (assumindo sem DST — Brasil aboliu horário de verão desde 2019).
  // Se h=10 SP, UTC=h+3=13. Constrói UTC pra hoje.
  const nowUtc = new Date();
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth();
  const d = nowUtc.getUTCDate();
  return new Date(Date.UTC(y, m, d, h + 3, 0, 0));
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));

  const {
    ClientQuietHoursGuardService,
    OutboundQuietHoursError,
    CLIENT_QUIET_DEFAULT_START_HOUR,
    CLIENT_QUIET_DEFAULT_END_HOUR,
  } = await import("../src/server/ClientQuietHoursGuardService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  const seedOrg = (name = "Salão X") => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`,
    ).run(randomUUID(), orgId, name);
    return orgId;
  };
  const seedChannel = (orgId: string) => {
    const id = `chn_${randomUUID().slice(0, 8)}`;
    db.prepare(
      `INSERT INTO channels (id, organization_id, name, provider, identifier, token_encrypted, status) VALUES (?, ?, 'canal', 'whatsapp_cloud', '5511999999999', 'dummy', 'active')`,
    ).run(id, orgId);
    return id;
  };

  // ===== 1. Constantes =====
  check(
    "CLIENT_QUIET_DEFAULT_START_HOUR === 22",
    CLIENT_QUIET_DEFAULT_START_HOUR === 22,
  );
  check(
    "CLIENT_QUIET_DEFAULT_END_HOUR === 8",
    CLIENT_QUIET_DEFAULT_END_HOUR === 8,
  );

  // ===== 2. Flag OFF default (0-regressão) =====
  const orgA = seedOrg();
  check(
    "isEnabled(nova org) === false (default 0-regressão)",
    ClientQuietHoursGuardService.isEnabled(orgA) === false,
  );

  const dec3h = ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(3));
  check(
    "flag OFF + 3h SP (madrugada) → allow=true, reason='flag_off'",
    dec3h.allow === true && (dec3h as any).reason === "flag_off",
  );

  // ===== 3. Liga flag → default 22→8 =====
  ClientQuietHoursGuardService.setEnabled(orgA, true);
  check(
    "setEnabled(true) → isEnabled=true",
    ClientQuietHoursGuardService.isEnabled(orgA) === true,
  );

  const eff = ClientQuietHoursGuardService.effectiveWindow(orgA);
  check(
    "effectiveWindow sem custom → default 22→8 (source='default')",
    eff.startHour === 22 && eff.endHour === 8 && eff.source === "default",
  );

  // Dentro da janela default
  const flagOnHours = [22, 23, 0, 1, 3, 5, 7];
  for (const h of flagOnHours) {
    const d = ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(h));
    check(
      `flag ON + ${h}h SP (dentro de 22→8) → allow=false`,
      d.allow === false && (d as any).reason === "within_quiet_window",
    );
  }
  // Fora da janela default
  const flagOffHours = [8, 9, 12, 15, 17, 21];
  for (const h of flagOffHours) {
    const d = ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(h));
    check(
      `flag ON + ${h}h SP (fora de 22→8) → allow=true, reason='outside_quiet_window'`,
      d.allow === true && (d as any).reason === "outside_quiet_window",
    );
  }

  // Payload de bloqueio inclui hora + janela
  const bloqueio = ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(23));
  check(
    "bloqueio inclui hourSP=23",
    (bloqueio as any).hourSP === 23,
  );
  check(
    "bloqueio inclui startHour=22, endHour=8",
    (bloqueio as any).startHour === 22 && (bloqueio as any).endHour === 8,
  );

  // ===== 4. Janela DIURNA (8→22) — quiet DURANTE o dia =====
  ClientQuietHoursGuardService.setWindow(orgA, { startHour: 8, endHour: 22 });
  check(
    "8h SP dentro de janela DIURNA 8→22 → bloqueia",
    ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(8)).allow === false,
  );
  check(
    "12h SP dentro de janela DIURNA 8→22 → bloqueia",
    ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(12)).allow === false,
  );
  check(
    "22h SP FORA de janela DIURNA 8→22 (end é exclusivo) → permite",
    ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(22)).allow === true,
  );
  check(
    "3h SP FORA de janela DIURNA 8→22 → permite",
    ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(3)).allow === true,
  );

  // ===== 5. start == end → 24h silêncio =====
  ClientQuietHoursGuardService.setWindow(orgA, { startHour: 10, endHour: 10 });
  for (const h of [0, 3, 8, 10, 15, 22]) {
    check(
      `start==end (10→10) + ${h}h SP → BLOQUEIA (24h silêncio)`,
      ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(h)).allow === false,
    );
  }

  // ===== 6. setWindow com null volta pro default =====
  ClientQuietHoursGuardService.setWindow(orgA, { startHour: null, endHour: null });
  const back = ClientQuietHoursGuardService.effectiveWindow(orgA);
  check(
    "setWindow(null,null) → volta pra default 22→8 (source='default')",
    back.startHour === 22 && back.endHour === 8 && back.source === "default",
  );

  // Custom parcial (só start)
  ClientQuietHoursGuardService.setWindow(orgA, { startHour: 20 });
  const part = ClientQuietHoursGuardService.effectiveWindow(orgA);
  check(
    "setWindow só startHour → source='custom', start=20, end=default(8)",
    part.startHour === 20 && part.endHour === 8 && part.source === "custom",
  );

  // Restaura pra default pros próximos testes
  ClientQuietHoursGuardService.setWindow(orgA, { startHour: null, endHour: null });

  // ===== 7. Validação de horas =====
  let threwInvalid = false;
  try {
    ClientQuietHoursGuardService.setWindow(orgA, { startHour: 25 });
  } catch {
    threwInvalid = true;
  }
  check("setWindow(startHour=25) lança (0-23 requerido)", threwInvalid);

  let threwNeg = false;
  try {
    ClientQuietHoursGuardService.setWindow(orgA, { endHour: -1 });
  } catch {
    threwNeg = true;
  }
  check("setWindow(endHour=-1) lança", threwNeg);

  // ===== 8. Cross-tenant DURO =====
  const orgB = seedOrg("Salão B");
  ClientQuietHoursGuardService.setEnabled(orgB, true);
  ClientQuietHoursGuardService.setWindow(orgB, { startHour: 10, endHour: 10 }); // 24h silêncio
  // orgA agora tem default 22→8; janela do orgB (silêncio total) NÃO afeta.
  const cross = ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(12));
  check(
    "cross-tenant: 12h SP orgA (fora de 22→8) permite mesmo com orgB em silêncio total",
    cross.allow === true,
  );
  const crossB = ClientQuietHoursGuardService.evaluate(orgB, dateAtSpHour(12));
  check(
    "cross-tenant: 12h SP orgB (silêncio 24h) bloqueia",
    crossB.allow === false,
  );

  // ===== 9. OutboundQuietHoursError shape =====
  const e = new OutboundQuietHoursError(23, 22, 8);
  check(
    "OutboundQuietHoursError.code === 'outbound_blocked:quiet_hours'",
    e.code === "outbound_blocked:quiet_hours",
  );
  check(
    "OutboundQuietHoursError.name === 'OutboundQuietHoursError'",
    e.name === "OutboundQuietHoursError",
  );
  check(
    "OutboundQuietHoursError carrega hourSP + janela",
    e.hourSP === 23 && e.startHour === 22 && e.endHour === 8,
  );
  check(
    "OutboundQuietHoursError mensagem em pt-BR humana",
    e.message.includes("silenciosa") && e.message.includes("23h"),
  );

  // ===== 10. Integração REAL com sendMessage =====
  // Janela custom que INCLUI a hora atual → bloqueia.
  const spNow = spHourNow();
  const chnA = seedChannel(orgA);
  ClientQuietHoursGuardService.setEnabled(orgA, true);
  // Janela [spNow, spNow+1) — cobre exatamente 1 hora contendo a atual.
  ClientQuietHoursGuardService.setWindow(orgA, {
    startHour: spNow,
    endHour: (spNow + 1) % 24,
  });
  let quietErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnA, "5511911111111", "Oi!");
  } catch (err: any) {
    quietErr = err;
  }
  check("sendMessage dentro da janela silenciosa LANÇA erro", quietErr != null);
  check(
    "erro lançado é OutboundQuietHoursError",
    quietErr && quietErr.name === "OutboundQuietHoursError",
  );
  check(
    "erro.code === 'outbound_blocked:quiet_hours'",
    quietErr && quietErr.code === "outbound_blocked:quiet_hours",
  );

  // Janela fora da hora atual → passa do guard (erro subsequente é OK — não é o quiet).
  ClientQuietHoursGuardService.setWindow(orgA, {
    startHour: (spNow + 2) % 24,
    endHour: (spNow + 3) % 24,
  });
  let passedQuietErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnA, "5511922222222", "Oi de novo!");
  } catch (err: any) {
    passedQuietErr = err;
  }
  check(
    "sendMessage fora da janela silenciosa NÃO lança OutboundQuietHoursError",
    !passedQuietErr || passedQuietErr.name !== "OutboundQuietHoursError",
  );

  // Flag OFF em outra org → passa direto
  const orgC = seedOrg();
  const chnC = seedChannel(orgC);
  let orgCErr: any = null;
  try {
    await MessageProviderService.sendMessage(chnC, "5511933333333", "Oi orgC!");
  } catch (err: any) {
    orgCErr = err;
  }
  check(
    "orgC com flag OFF: sendMessage NÃO lança OutboundQuietHoursError (0-regressão)",
    !orgCErr || orgCErr.name !== "OutboundQuietHoursError",
  );

  // ===== 11. Read-only: evaluate NÃO muta settings =====
  const rowBefore = db
    .prepare(`SELECT client_quiet_hours_enforced, client_quiet_hours_start_hour, client_quiet_hours_end_hour FROM organization_settings WHERE organization_id = ?`)
    .get(orgA) as any;
  ClientQuietHoursGuardService.evaluate(orgA);
  ClientQuietHoursGuardService.evaluate(orgA, dateAtSpHour(3));
  ClientQuietHoursGuardService.effectiveWindow(orgA);
  const rowAfter = db
    .prepare(`SELECT client_quiet_hours_enforced, client_quiet_hours_start_hour, client_quiet_hours_end_hour FROM organization_settings WHERE organization_id = ?`)
    .get(orgA) as any;
  check(
    "evaluate/effectiveWindow NÃO mutam organization_settings",
    JSON.stringify(rowBefore) === JSON.stringify(rowAfter),
  );

  // ===== 12. Zero hardcoded Studio Márcia =====
  const forbiddenNeedles = [
    "studio_marcia",
    "studio de beleza márcia",
    "marcia_studio",
    "\"marcia\"",
    "'marcia'",
  ];
  let hardcoded: string | null = null;
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(f.name)) {
        try {
          const s = fs.readFileSync(p, "utf8").toLowerCase();
          for (const n of forbiddenNeedles) if (s.includes(n)) { hardcoded = `${p}: ${n}`; return; }
        } catch { /* skip */ }
      }
    }
  };
  try {
    walk(path.join(process.cwd(), "src", "server"));
    if (!hardcoded) walk(path.join(process.cwd(), "src", "features"));
  } catch { /* skip */ }
  check(
    "nenhum hardcoded do Studio Márcia em src/server ou src/features (§17/§65)",
    hardcoded === null,
    hardcoded || undefined,
  );

  // --- Relatório ---
  console.log("\n=== TEST: Janela silenciosa transversal no sink outbound (ADR-169 F5-transversal-B) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.note ? "  [" + r.note + "]" : ""}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Gate de quiet-hours ligado ao sink canônico — aditivo, opt-in, 0-regressão.");
}

function spHourNow(): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value || 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
