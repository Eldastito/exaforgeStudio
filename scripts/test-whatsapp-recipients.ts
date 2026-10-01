/**
 * TESTE — destinatários dos envios por WhatsApp + dinheiro em pt-BR (auditoria de 01/10/2026).
 * Achados: (1) o Tutor, sem número configurado, caía no 1º usuário com telefone de QUALQUER papel (vendedor inclusive) e mandava o
 * resumo da empresa (caixa, estoque, prioridades) pra ele; (2) o Coordenador IA aceitava usuário SUSPENSO com telefone;
 * (3) vários serviços formatavam dinheiro sem milhar ("R$ 13428,60") nos textos que o dono lê.
 * Decisão do dono: o gerente PODE ver a rede toda — então o gerente (admin) segue podendo ser o fallback; o que sai é papel sem relação.
 * Uso:  npm run test:whatsapp-recipients
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-wa-recipients-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-wa-recipients-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { BusinessTutorService: T } = await import("../src/server/BusinessTutorService.js");
  const { CoordenadorService: C } = await import("../src/server/CoordenadorService.js");
  const { brl } = await import("../src/server/brlFormat.js");

  const org = (tag: string) => { const id = `org_${tag}_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const user = (o: string, role: string, phone: string | null, status = "active", at = "2026-01-01 10:00:00") =>
    db.prepare(`INSERT INTO users (id, organization_id, name, email, role, phone, global_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), o, `${role}-${phone}`, `${randomUUID().slice(0, 8)}@x.com`, role, phone, status, at);

  // ── (1) fallback do Tutor ──
  const A = org("A"); user(A, "agent", "5521911110001", "active", "2025-01-01 10:00:00"); user(A, "owner", "5521911110002", "active", "2026-01-01 10:00:00");
  check("dono tem telefone: o fallback é o dono, mesmo com vendedor mais antigo cadastrado", T.ownerPhone(A) === "5521911110002");
  const B = org("B"); user(B, "agent", "5521922220001"); user(B, "owner", null);
  check("dono SEM telefone e só vendedor com telefone: NÃO cai no vendedor (vazio → o Tutor não envia)", T.ownerPhone(B) === "", T.ownerPhone(B));
  const D = org("D"); user(D, "agent", "5521933330001"); user(D, "admin", "5521933330002");
  check("dono sem telefone, admin com telefone: usa o admin (decisão do dono: gerente pode ver a rede)", T.ownerPhone(D) === "5521933330002");
  const E = org("E"); user(E, "owner", "5521944440001", "suspended"); user(E, "admin", "5521944440002");
  check("dono suspenso não recebe: usa o admin ativo", T.ownerPhone(E) === "5521944440002");
  const F = org("F"); user(F, "owner", "5521955550001"); db.prepare(`UPDATE organization_settings SET tutor_wa_phone = '21966660001' WHERE organization_id = ?`).run(F);
  check("número configurado no card do Tutor continua mandando (e ganha o 55)", T.ownerPhone(F) === "5521966660001");

  // o envio de verdade: sem número, o passe da manhã não manda pra ninguém
  db.prepare(`UPDATE organization_settings SET tutor_wa_enabled = 1 WHERE organization_id = ?`).run(B);
  const sent: string[] = [];
  const r = await T.runMorningPass(B, { now: new Date(Date.UTC(2026, 8, 24, 11, 0, 0)), send: (p: string) => { sent.push(p); } } as any);
  check("passe da manhã sem destinatário válido não envia nada (nem pro vendedor)", sent.length === 0 && (r as any).sent === false, JSON.stringify(r));

  // ── (2) Coordenador IA: usuário suspenso ──
  const G = org("G"); const act = "5521977770001", susp = "5521977770002";
  user(G, "agent", act); user(G, "agent", susp, "suspended");
  const who = (n: string) => (C as any).resolveUser(G, n);
  check("Coordenador reconhece o usuário ativo pelo telefone", !!who(act));
  check("Coordenador NÃO reconhece usuário suspenso (antes aceitava)", who(susp) === null);

  // ── (3) dinheiro pt-BR com milhar ──
  check("brl: 13428.6 → R$ 13.428,60; 1426635.58 → R$ 1.426.635,58; 5700 → R$ 5.700,00", brl(13428.6) === "R$ 13.428,60" && brl(1426635.58) === "R$ 1.426.635,58" && brl(5700) === "R$ 5.700,00", [brl(13428.6), brl(1426635.58), brl(5700)].join(" | "));
  check("brl: centavos e pequenos valores (0, 999,99, 1000) e negativo", brl(0) === "R$ 0,00" && brl(999.99) === "R$ 999,99" && brl(1000) === "R$ 1.000,00" && brl(-1234.5) === "R$ -1.234,50");
  check("brl: lixo/ausente vira R$ 0,00 sem estourar", brl(undefined) === "R$ 0,00" && brl("abc") === "R$ 0,00" && brl(null) === "R$ 0,00");
  const users = ["BusinessHealthService", "SurvivalIndexService", "DecisionEngine", "DecisionSimulatorService", "RecoveryScenarioService", "ResultProjectionService", "ConnectedFinancialsService", "HealthyReserveService", "ComigoCollectionService", "BusinessTutorService"];
  const stale = users.filter((f) => { const t = fs.readFileSync(path.join(process.cwd(), `src/server/${f}.ts`), "utf8"); return !/from "\.\/brlFormat\.js"/.test(t) || /(const brl = |function brl\()/.test(t); });
  check("os 10 serviços que montam texto de dinheiro usam o formatador único (nenhum brl próprio sem milhar)", stale.length === 0, stale.join(", "));

  const pass = results.filter((x) => x.ok).length;
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${!x.ok && x.detail ? `\n      ↳ ${x.detail}` : ""}`);
  console.log(failures ? `\n${failures} FALHA(S) (${pass}/${results.length} ok)` : `\n${pass}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
