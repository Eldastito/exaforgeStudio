/**
 * TEST — PRD 1 (Fala Tu), Fase 2 (artefatos): fundação. Cobre o util de
 * assinatura compartilhado (`fileSigning`) + o `ArtifactService` (fonte de
 * verdade dos artefatos: hash, isolamento, entrega assinada, expiração).
 *
 * Prova (determinístico):
 *   fileSigning: roundtrip válido, expirado→false, adulterado→false, ISOLAMENTO
 *     de escopo (sig de um escopo não vale em outro), safeStorageKey barra path
 *     traversal;
 *   ArtifactService: create grava binário+sha256+size; tenant isolation; read
 *     devolve conteúdo/mime/filename; list não vaza storage path; URL assinada
 *     entrega (e nega sig errada / expirada / cross-tenant); TTL expira o read;
 *     integridade do hash.
 *
 * Uso: npm run test:artifacts
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-artifacts-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-artifacts-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  await import("../src/server/db.js");
  const { signKey, verifyKey, safeStorageKey } = await import("../src/server/fileSigning.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");

  // ===== 1. fileSigning =====
  const key = "orgA/abc123";
  const { exp, sig } = signKey("artifact", key, 60_000, 1_000_000);
  check("1.1 roundtrip válido", verifyKey("artifact", key, exp, sig, 1_000_000) === true);
  check("1.2 expirado → false", verifyKey("artifact", key, exp, sig, exp + 1) === false);
  check("1.3 sig adulterada → false", verifyKey("artifact", key, exp, sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a"), 1_000_000) === false);
  check("1.4 ISOLAMENTO de escopo (sig 'artifact' não vale em 'clinical')", verifyKey("clinical_document", key, exp, sig, 1_000_000) === false);
  check("1.5 key adulterada → false", verifyKey("artifact", "orgA/outra", exp, sig, 1_000_000) === false);
  let traversalBlocked = 0;
  for (const bad of ["orgA/../etc", "a/b/c", "orgA/", "/x", "orgA/a b", "../secret"]) { try { safeStorageKey(bad); } catch { traversalBlocked++; } }
  check("1.6 safeStorageKey barra path traversal / chaves inválidas", traversalBlocked === 6);
  check("1.7 safeStorageKey aceita chave válida", safeStorageKey("orgA/abc.pdf") === "orgA/abc.pdf");

  // ===== 2. ArtifactService.create =====
  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const pdf = Buffer.from("%PDF-1.4 conteúdo de teste");
  const art = AS.create(orgA, { kind: "report", title: "Fluxo de Caixa Julho", mimeType: "application/pdf", content: pdf, origin: "report", createdBy: "u1", correlationId: "corr-1" });
  check("2.1 create devolve id + metadados", !!art.id && art.kind === "report" && art.mimeType === "application/pdf");
  check("2.2 size_bytes + sha256 gravados", art.sizeBytes === pdf.length && typeof art.sha256 === "string" && art.sha256.length === 64);
  const crypto = await import("crypto");
  check("2.3 sha256 corresponde ao conteúdo (integridade)", art.sha256 === crypto.createHash("sha256").update(pdf).digest("hex"));
  check("2.4 binário existe no disco privado", fs.existsSync(path.join(tmpDir, "private_media", "artifacts", art.storageKey)));
  check("2.5 correlationId ligado à interação", art.correlationId === "corr-1");

  // ===== 3. Isolamento multi-tenant =====
  check("3.1 org B não enxerga artefato de A", AS.get(orgB, art.id) == null);
  check("3.2 org A enxerga o próprio", AS.get(orgA, art.id)?.id === art.id);

  // ===== 4. read =====
  const r = AS.read(orgA, art.id);
  check("4.1 read devolve o conteúdo exato", !!r && Buffer.compare(r.buffer, pdf) === 0);
  check("4.2 read: mime + filename seguro", r?.mime === "application/pdf" && r?.filename === "Fluxo de Caixa Julho.pdf");
  check("4.3 read cross-tenant → null", AS.read(orgB, art.id) == null);

  // ===== 5. list não vaza storage path =====
  AS.create(orgA, { kind: "export", mimeType: "text/csv", content: "a,b\n1,2", createdBy: "u2" });
  const listA = AS.list(orgA, {});
  check("5.1 list traz os 2 artefatos de A", listA.length === 2);
  check("5.2 list NÃO expõe storageKey (path interno)", listA.every((a: any) => a.storageKey === undefined));
  check("5.3 list filtra por kind", AS.list(orgA, { kind: "export" }).length === 1);
  check("5.4 list filtra por createdBy (mine)", AS.list(orgA, { createdBy: "u1" }).length === 1);

  // ===== 6. URL assinada: entrega + negações =====
  const url = AS.signedUrl(orgA, art.id)!;
  const q = new URLSearchParams(url.split("?")[1]);
  const gExp = q.get("exp")!, gSig = q.get("sig")!;
  check("6.1 signedUrl aponta pra rota pública com exp+sig", url.startsWith(`/api/public/artifacts/${orgA}/${art.id}`) && !!gExp && !!gSig);
  const ok = AS.resolveSigned(orgA, art.id, gExp, gSig);
  check("6.2 resolveSigned com sig válida entrega o conteúdo", !!ok && Buffer.compare(ok.buffer, pdf) === 0);
  check("6.3 resolveSigned com sig errada → null", AS.resolveSigned(orgA, art.id, gExp, "deadbeef") == null);
  check("6.4 resolveSigned expirado → null", AS.resolveSigned(orgA, art.id, gExp, gSig, Number(gExp) + 1) == null);
  check("6.5 resolveSigned cross-tenant (orgB) → null", AS.resolveSigned(orgB, art.id, gExp, gSig) == null);

  // ===== 7. TTL / expiração do artefato =====
  const eph = AS.create(orgA, { kind: "export", mimeType: "text/plain", content: "efêmero", ttlMs: 1000 });
  check("7.1 read antes do TTL entrega", !!AS.read(orgA, eph.id, Date.now()));
  check("7.2 read após o TTL → null (expirado)", AS.read(orgA, eph.id, Date.now() + 5000) == null);

  console.log("\n=== TEST: Artefatos — fundação (PRD 1 Fase 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Artefatos — fundação (Fase 2) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
