/**
 * TEST — Fala Tu "Conversar com o negócio" via WhatsApp (FalaTuWhatsAppService F2).
 * Prova que o gatilho explícito "pergunta/pergunte" roteia pro FalaTuAskService
 * e responde no canal interno, com o gate de dinheiro passando pela identidade
 * resolvida por número:
 *   - sem gatilho / falatu desligado → handled=false (não sequestra mensagem).
 *   - owner pergunta dinheiro → responde o valor exato.
 *   - owner pergunta folga → responde a lista.
 *   - número desconhecido + "pergunta" → aviso de cadastro.
 *   - colaborador (falatu read, sem privilégio de dinheiro) → dinheiro barrado
 *     com aviso honesto (não vaza o número); gerente → liberado.
 *   - "pergunta" sem conteúdo → pede a pergunta.
 *
 * Uso: npm run test:falatu-ask-whatsapp
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-ask-wa-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-falatu-ask-wa-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuWhatsAppService } = await import("../src/server/FalaTuWhatsAppService.js");

  const mkOrg = (enable = true) => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status, vertical) VALUES (?, 'Toulon', 'active', 'moda')`).run(o);
    if (enable) FalaTuService.setOrgEnabled(o, true);
    return o;
  };
  const mkUser = (org: string, phone: string, role: string, roleProfileId: string | null = null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, role_profile_id, global_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`)
      .run(id, org, `U-${phone}`, `${id}@toulon.com`, phone, role, roleProfileId);
    return id;
  };
  const profile = (org: string, name: string, systemKey: string, isSystem: number, falatuLevel?: string) => {
    const id = `prof_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO role_profiles (id, organization_id, name, system_key, is_system) VALUES (?, ?, ?, ?, ?)`).run(id, org, name, systemKey, isSystem);
    if (falatuLevel) db.prepare(`INSERT INTO role_permissions (role_profile_id, module, level) VALUES (?, 'falatu', ?)`).run(id, falatuLevel);
    return id;
  };
  const closing = (org: string, storeId: string, date: string, total: number, items: Record<string, number>) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, informed_total, status) VALUES (?, ?, ?, ?, ?, 'reconciled')`).run(id, org, storeId, date, total);
    for (const [pm, amt] of Object.entries(items)) db.prepare(`INSERT INTO retail_daily_closing_items (id, organization_id, closing_id, payment_method, informed_amount) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), org, id, pm, amt);
  };
  const store = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name) VALUES (?, ?, ?)`).run(id, org, name); return id; };
  const off = (org: string, storeId: string, key: string, name: string, date: string) => db.prepare(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, seller_key, seller_name, work_date, status) VALUES (?, ?, ?, ?, ?, ?, 'off')`).run(randomUUID(), org, storeId, key, name, date);

  const A = mkOrg(true);
  const s1 = store(A, "Loja Centro");
  closing(A, s1, "2025-08-31", 1250, { dinheiro: 1000, pix: 250 });
  off(A, s1, "ana", "Ana", "2025-09-01");
  off(A, s1, "bruno", "Bruno", "2025-09-01");

  const ownerPhone = "5511900000001";
  mkUser(A, ownerPhone, "owner");

  // ── 1. sem gatilho → não é nosso ──
  const r1 = await FalaTuWhatsAppService.handle(A, ownerPhone, "bom dia");
  check("1.1 sem gatilho → handled=false", r1.handled === false);

  // ── 2. falatu desligado → não é nosso ──
  const OFF = mkOrg(false);
  mkUser(OFF, "5511900000099", "owner");
  const r2 = await FalaTuWhatsAppService.handle(OFF, "5511900000099", "pergunta quanto vendi em dinheiro hoje");
  check("2.1 falatu desligado → handled=false", r2.handled === false);

  // ── 3. owner pergunta dinheiro → valor exato ──
  const r3 = await FalaTuWhatsAppService.handle(A, ownerPhone, "pergunta quanto a loja fez em dinheiro no dia 31 de agosto de 2025?");
  check("3.1 owner cash → handled", r3.handled === true);
  check("3.2 owner cash → responde 1.000,00 (só dinheiro)", /1\.000,00/.test(r3.reply));
  check("3.3 owner cash → não vaza pix no total", !/1\.250/.test(r3.reply));

  // ── 4. owner pergunta folga ──
  const r4 = await FalaTuWhatsAppService.handle(A, ownerPhone, "pergunte quem está de folga em 01/09/2025");
  check("4.1 folga → handled", r4.handled === true);
  check("4.2 folga → cita Ana e Bruno", /Ana/.test(r4.reply) && /Bruno/.test(r4.reply));

  // ── 5. número desconhecido + pergunta → aviso de cadastro ──
  const r5 = await FalaTuWhatsAppService.handle(A, "5511911111111", "pergunta quanto vendi hoje");
  check("5.1 desconhecido → handled com aviso de cadastro", r5.handled === true && /não reconheço/i.test(r5.reply));

  // ── 6. colaborador (falatu read, sem privilégio de dinheiro) ──
  const collabProf = profile(A, "Atendente", "atendente_custom", 0, "read");
  const collabPhone = "5511922222222";
  mkUser(A, collabPhone, "agent", collabProf);
  const r6 = await FalaTuWhatsAppService.handle(A, collabPhone, "pergunta quanto vendi em dinheiro no dia 31 de agosto de 2025?");
  check("6.1 colaborador dinheiro → handled", r6.handled === true);
  check("6.2 colaborador dinheiro → barrado (não vaza número)", /restrit/i.test(r6.reply) && !/1\.000/.test(r6.reply));
  // 6c. colaborador PODE perguntar folga
  const r6b = await FalaTuWhatsAppService.handle(A, collabPhone, "pergunta quem está de folga em 01/09/2025");
  check("6.3 colaborador folga → liberado", r6b.handled === true && /Ana/.test(r6b.reply));

  // ── 7. gerente → dinheiro liberado ──
  const gerProf = profile(A, "Gerente", "gerente", 1, "full");
  const gerPhone = "5511933333333";
  mkUser(A, gerPhone, "agent", gerProf);
  const r7 = await FalaTuWhatsAppService.handle(A, gerPhone, "pergunta quanto vendi em dinheiro no dia 31 de agosto de 2025?");
  check("7.1 gerente dinheiro → liberado com valor", r7.handled === true && /1\.000,00/.test(r7.reply));

  // ── 8. "pergunta" sem conteúdo → pede a pergunta ──
  const r8 = await FalaTuWhatsAppService.handle(A, ownerPhone, "pergunta");
  check("8.1 pergunta vazia → pede a pergunta", r8.handled === true && /manda a pergunta/i.test(r8.reply));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} falatu-ask-whatsapp: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
