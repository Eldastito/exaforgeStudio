/**
 * TEST — F2.3: migração das preferências existentes → bindings (RF-03 §9).
 *
 * Prova, offline (tmp db):
 *  - dryRun (default) só PLANEJA, não grava;
 *  - deriva SÓ gestao (kind='internal') e atendimento (cliente) do que existe;
 *  - NÃO habilita finalidades novas (campanhas/cobranca ausentes);
 *  - apply grava com origin='migration'; idempotente (2ª vez → skip_existing);
 *  - NÃO sobrescreve binding manual: finalidade já em outro canal → conflict;
 *  - canal desabilitado é ignorado; isolamento entre orgs.
 *
 * Uso: npm run test:channel-binding-migration
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cfb-mig-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-cfb-mig-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ChannelBindingMigrationService } = await import("../src/server/ChannelBindingMigrationService.js");
  const { ChannelBindingService } = await import("../src/server/ChannelBindingService.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkChannel = (org: string, name: string, kind: string, status = "connected") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status, kind) VALUES (?, ?, 'evolution', ?, ?, ?, ?)`).run(id, org, name, name, status, kind);
    return id;
  };
  const bindingCount = (org: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM channel_feature_bindings WHERE organization_id = ?`).get(org) as any).n);

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const chInt = mkChannel(A, "equipe", "internal");
  const chCli = mkChannel(A, "loja", "client");
  const chOff = mkChannel(A, "morto", "client", "disabled");

  // ── 1. dryRun (default) planeja mas NÃO grava ──
  const dry = ChannelBindingMigrationService.migrate(A, "op1");
  check("1.1 dryRun default", dry.dryRun === true);
  check("1.2 planeja 2 creates (gestao + atendimento)", dry.planned.filter(p => p.action === "create").length === 2);
  check("1.3 nada gravado no dry-run", bindingCount(A) === 0);
  check("1.4 canal desabilitado fora do plano", !dry.planned.some(p => p.channelId === chOff));
  check("1.5 features do plano são só gestao/atendimento", dry.planned.every(p => p.feature === "gestao" || p.feature === "atendimento"));

  // ── 2. apply grava com origin migration ──
  const ap = ChannelBindingMigrationService.migrate(A, "op1", { dryRun: false });
  check("2.1 created=2", ap.created === 2);
  check("2.2 gravou 2 bindings", bindingCount(A) === 2);
  const gestao = ChannelBindingService.resolve(A, "gestao");
  const atend = ChannelBindingService.resolve(A, "atendimento");
  check("2.3 gestao → canal interno", gestao.channelId === chInt);
  check("2.4 atendimento → canal cliente", atend.channelId === chCli);
  check("2.5 origin=migration", ChannelBindingService.list(A).every((b: any) => b.origin === "migration"));

  // ── 3. NÃO habilita finalidade nova ──
  check("3.1 campanhas continua sem binding", ChannelBindingService.resolve(A, "campanhas").code === "no_binding");
  check("3.2 cobranca continua sem binding", ChannelBindingService.resolve(A, "cobranca").code === "no_binding");

  // ── 4. idempotente: 2ª aplicação → skip_existing, nada novo ──
  const ap2 = ChannelBindingMigrationService.migrate(A, "op1", { dryRun: false });
  check("4.1 2ª vez: 0 created", ap2.created === 0);
  check("4.2 2ª vez: 2 skip_existing", ap2.skippedExisting === 2);
  check("4.3 total de bindings segue 2", bindingCount(A) === 2);

  // ── 5. NÃO sobrescreve manual: finalidade já em outro canal → conflict ──
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);
  const bCli = mkChannel(B, "lojaB", "client");
  const bCli2 = mkChannel(B, "lojaB2", "client");
  // binding MANUAL de atendimento no bCli2
  ChannelBindingService.upsert(B, "op", { channelId: bCli2, featureKey: "atendimento" });
  const apB = ChannelBindingMigrationService.migrate(B, "op", { dryRun: false });
  // bCli quer atendimento, mas já existe manual em bCli2 → conflict; bCli2 mesmo canal → skip_existing
  check("5.1 conflito reportado (não sobrescreve manual)", apB.conflicts >= 1);
  check("5.2 não criou binding novo em B", bindingCount(B) === 1);

  // ── 6. isolamento ──
  check("6.1 migração de B não tocou A", bindingCount(A) === 2);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} channel-binding-migration: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
