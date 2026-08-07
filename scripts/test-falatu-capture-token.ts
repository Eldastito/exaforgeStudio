/**
 * TEST — FalaTu F8.4 (ADR-154 Fase 8): token pessoal de captura write-only.
 *
 * Cobre: create devolve o claro UMA vez e o banco só guarda sha256 (dump não
 * vira credencial); label obrigatório; list nunca expõe hash; verify resolve
 * identidade e carimba last_used_at; token malformado/desconhecido → null;
 * fluxo e2e token → capture cria PENDENTE (RN-151 preservado: nada
 * materializa); revoke é UPDATE (linha permanece — retenção/trilha) e mata o
 * verify; anti-IDOR (revogar token alheio falha); isolamento multi-tenant no
 * list; teto de 10 tokens ativos (revogado libera vaga); auditoria de
 * create/revoke; org com falatu desligado → orgEnabled false (o 403 da rota
 * de ingestão vem daí — o gate é o MESMO da sessão, fonte única).
 *
 * Mocka FalaTuService.interpret (sem chave OpenAI) — o resto do fluxo é real.
 *
 * Uso: npm run test:falatu-capture-token
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-ctk-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-ctk-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");
  const { FalaTuCaptureTokenService } = await import("../src/server/FalaTuCaptureTokenService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const orgOff = `org_${randomUUID().slice(0, 8)}`; // falatu_enabled = 0
  const userA = randomUUID();
  const userA2 = randomUUID();
  const userB = randomUUID();
  for (const [org, name] of [[orgA, "Org A"], [orgB, "Org B"], [orgOff, "Org Off"]] as const) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  }
  db.prepare(`UPDATE organization_settings SET falatu_enabled = 1 WHERE organization_id IN (?, ?)`).run(orgA, orgB);

  (FalaTuService as any).interpret = async (input: any) => ({
    transcription: input.text || "áudio transcrito",
    summary: "Ligar pro contador",
    intent: "TASK",
    entities: { people: [], projects: [], actions: ["ligar"], listItems: [], eventDate: null, eventTime: null },
    suggestedAction: "sugestão",
    confidence: 0.9,
  });

  const auditCount = (org: string, type: string) =>
    (db.prepare(`SELECT COUNT(*) c FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(org, type) as any).c;

  // ===== 1. Create: claro uma vez, banco só com hash =====
  const created = FalaTuCaptureTokenService.create(orgA, userA, "  Atalho Siri  ");
  check("create devolve claro com prefixo ftk_", created.token.startsWith("ftk_") && created.token.length > 30);
  check("label é trimado", created.label === "Atalho Siri");
  const row = db.prepare(`SELECT * FROM falatu_capture_tokens WHERE id = ?`).get(created.id) as any;
  check("banco NÃO guarda o claro", row.token_hash !== created.token && !String(row.token_hash).startsWith("ftk_"));
  check("hash é sha256 hex (64 chars)", /^[0-9a-f]{64}$/.test(row.token_hash));
  check("auditoria CREATE", auditCount(orgA, "FALATU_CAPTURE_TOKEN_CREATE") === 1);

  // ===== 2. Label obrigatório =====
  let threw = false;
  try { FalaTuCaptureTokenService.create(orgA, userA, "   "); } catch { threw = true; }
  check("create sem label recusado", threw);

  // ===== 3. List não expõe hash; isolamento por usuário e org =====
  const listA = FalaTuCaptureTokenService.list(orgA, userA);
  check("list traz o token com metadados", listA.length === 1 && listA[0].label === "Atalho Siri");
  check("list NÃO expõe hash", !("token_hash" in listA[0]));
  check("outro usuário da MESMA org não vê", FalaTuCaptureTokenService.list(orgA, userA2).length === 0);
  check("outra org não vê", FalaTuCaptureTokenService.list(orgB, userA).length === 0);

  // ===== 4. Verify resolve identidade + last_used_at =====
  const id1 = FalaTuCaptureTokenService.verify(created.token);
  check("verify resolve org/user do token", id1?.orgId === orgA && id1?.userId === userA);
  const used = db.prepare(`SELECT last_used_at FROM falatu_capture_tokens WHERE id = ?`).get(created.id) as any;
  check("verify carimba last_used_at", !!used.last_used_at);
  check("verify token desconhecido → null", FalaTuCaptureTokenService.verify("ftk_" + "a".repeat(43)) === null);
  check("verify malformado → null", FalaTuCaptureTokenService.verify("Bearer xyz") === null && FalaTuCaptureTokenService.verify(123 as any) === null && FalaTuCaptureTokenService.verify("ftk_x") === null);

  // ===== 5. E2E: identidade do token → capture cria PENDENTE (RN-151) =====
  const cap = await FalaTuService.capture(id1!.orgId, id1!.userId, { text: "ligar pro contador", source: "siri" });
  check("capture via token cria item pending", cap?.status === "pending" && cap?.user_id === userA && cap?.organization_id === orgA);
  const taskCount = (db.prepare(`SELECT COUNT(*) c FROM falatu_tasks WHERE organization_id = ?`).get(orgA) as any).c;
  check("nada materializado sem confirm (RN-151)", taskCount === 0);

  // ===== 6. Revoke: UPDATE (linha fica), verify morre, anti-IDOR =====
  threw = false;
  try { FalaTuCaptureTokenService.revoke(orgA, userA2, created.id); } catch { threw = true; }
  check("revogar token de OUTRO usuário falha (anti-IDOR)", threw);
  threw = false;
  try { FalaTuCaptureTokenService.revoke(orgB, userA, created.id); } catch { threw = true; }
  check("revogar cross-org falha", threw);
  FalaTuCaptureTokenService.revoke(orgA, userA, created.id);
  const revoked = db.prepare(`SELECT revoked_at FROM falatu_capture_tokens WHERE id = ?`).get(created.id) as any;
  check("revoke é UPDATE — linha permanece com revoked_at", !!revoked?.revoked_at);
  check("verify de token revogado → null", FalaTuCaptureTokenService.verify(created.token) === null);
  check("auditoria REVOKE", auditCount(orgA, "FALATU_CAPTURE_TOKEN_REVOKE") === 1);
  threw = false;
  try { FalaTuCaptureTokenService.revoke(orgA, userA, created.id); } catch { threw = true; }
  check("revogar de novo falha (já revogado)", threw);

  // ===== 7. Teto de 10 ativos; revogado libera vaga =====
  for (let i = 0; i < 10; i++) FalaTuCaptureTokenService.create(orgA, userA, `plugue ${i}`);
  threw = false;
  try { FalaTuCaptureTokenService.create(orgA, userA, "11º"); } catch { threw = true; }
  check("11º token ativo recusado", threw);
  const tenth = FalaTuCaptureTokenService.list(orgA, userA).find((t: any) => t.label === "plugue 9" && !t.revoked_at);
  FalaTuCaptureTokenService.revoke(orgA, userA, tenth!.id);
  const again = FalaTuCaptureTokenService.create(orgA, userA, "vaga liberada");
  check("revogado libera vaga pro teto", !!again.token);
  check("teto não afeta outro usuário", !!FalaTuCaptureTokenService.create(orgA, userA2, "do A2").token);

  // ===== 8. Org com módulo desligado: gate único da rota de ingestão =====
  const offTok = FalaTuCaptureTokenService.create(orgOff, userB, "org desligada");
  const offId = FalaTuCaptureTokenService.verify(offTok.token);
  check("verify não decide módulo (token válido resolve)", offId?.orgId === orgOff);
  check("orgEnabled=false pra org desligada (rota nega com 403)", FalaTuService.orgEnabled(orgOff) === false);
  check("orgEnabled=true pra org ligada", FalaTuService.orgEnabled(orgA) === true);

  // ===== resumo =====
  console.log("");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
