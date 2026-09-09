/**
 * TEST — F1.2c: eventos de conexão Evolution resolvem canal por IDENTIFIER único
 * e NUNCA inventam `default_org` (PRD WhatsApp Unificado — achados A8/A9, INV-01).
 *
 * Antes, o connect legado e o connection.update criavam/atualizavam canal sob
 * `organization_id='default_org'` (org inventada) ou confiavam no header
 * x-organization-id (spoofável). Agora `markEvolutionChannelStatusByIdentifier`:
 *  - acha o canal pelo identifier (único entre orgs) e atualiza o status;
 *  - NÃO cria canal quando não existe (nunca inventa default_org);
 *  - isola: atualiza só o canal daquele identifier, não os de outra org.
 *
 * Uso: npm run test:evolution-channel-status
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ev-chstatus-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ev-chstatus-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { markEvolutionChannelStatusByIdentifier } = await import("../src/server/evolutionChannelStatus.js");

  const mkOrg = (id: string) => db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'T', 'active')`).run(id);
  const mkChannel = (org: string, identifier: string, status = "disconnected") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', 'Ev', ?, ?)`).run(id, org, identifier, status);
    return id;
  };
  const statusOf = (id: string) => (db.prepare(`SELECT status FROM channels WHERE id = ?`).get(id) as any)?.status;
  const countDefaultOrg = () => Number((db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE organization_id = 'default_org'`).get() as any).n);
  const countByIdentifier = (idf: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE identifier = ?`).get(idf) as any).n);

  const A = `org_A_${randomUUID().slice(0, 6)}`; mkOrg(A);
  const B = `org_B_${randomUUID().slice(0, 6)}`; mkOrg(B);

  // ── 1. acha pelo identifier e atualiza o status ──
  const chA = mkChannel(A, "inst_alpha", "disconnected");
  const r1 = markEvolutionChannelStatusByIdentifier("inst_alpha", "connected");
  check("1.1 retorna true (achou e atualizou)", r1 === true);
  check("1.2 status virou connected", statusOf(chA) === "connected");

  // ── 2. NÃO inventa default_org quando o identifier não existe ──
  const r2 = markEvolutionChannelStatusByIdentifier("inst_inexistente", "connected");
  check("2.1 retorna false (não achou)", r2 === false);
  check("2.2 NÃO criou canal (nenhum com esse identifier)", countByIdentifier("inst_inexistente") === 0);
  check("2.3 NÃO criou nenhum canal em default_org", countDefaultOrg() === 0);

  // ── 3. isolamento: dois canais de orgs diferentes, atualiza só o do identifier ──
  const chB = mkChannel(B, "inst_beta", "disconnected");
  markEvolutionChannelStatusByIdentifier("inst_alpha", "disconnected"); // volta o de A
  check("3.1 atualizou só o identifier alvo (A voltou a disconnected)", statusOf(chA) === "disconnected");
  check("3.2 canal de B intacto (segue disconnected, não foi tocado)", statusOf(chB) === "disconnected");
  markEvolutionChannelStatusByIdentifier("inst_beta", "connected");
  check("3.3 agora só B mudou", statusOf(chB) === "connected" && statusOf(chA) === "disconnected");

  // ── 4. identifier vazio → false, sem efeito ──
  check("4.1 identifier vazio → false", markEvolutionChannelStatusByIdentifier("", "connected") === false);
  check("4.2 default_org segue 0", countDefaultOrg() === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} evolution-channel-status: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
