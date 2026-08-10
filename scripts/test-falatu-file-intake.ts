/**
 * TEST — PRD 1 Fase 2.4 (CA7 / §17-18): o Fala Tu RECEBE documentos. Fecha o
 * ciclo entrada↔saída de arquivos.
 *
 * Prova (determinístico, sem IA):
 *   - detecta o formato REAL por magic-byte (confia no conteúdo, NUNCA no tipo
 *     declarado — segurança H4); rejeita o que não é PNG/JPG/WEBP/PDF;
 *   - persiste como artefato canônico (origin 'intake', sha256, correlation),
 *     devolve LINK assinado + classificação + sugestão determinística (§27);
 *   - round-trip: o arquivo recebido é recuperável via URL assinada;
 *   - valida tamanho (vazio / grande demais);
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:falatu-file-intake
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-intake-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-intake-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("conteúdo de teste da nota")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);
const JUNK = Buffer.from("isto não é um arquivo suportado, só texto solto");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuFileIntakeService: FI } = await import("../src/server/FalaTuFileIntakeService.js");
  const { ArtifactService: AS } = await import("../src/server/ArtifactService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // ===== 1. PDF válido =====
  const rPdf = FI.intake(orgA, "u1", { filename: "nota-julho.pdf", buffer: PDF, correlationId: "corr-intake-1" });
  check("1.1 detecta PDF + kind document", rPdf.mime === "application/pdf" && rPdf.artifact.kind === "document");
  check("1.2 devolve link assinado + sugestão determinística", rPdf.url!.startsWith(`/api/public/artifacts/${orgA}/${rPdf.artifact.id}`) && /nota|comprovante/i.test(rPdf.suggestion));
  check("1.3 domínio provável = procurement (nota→compras)", rPdf.likelyDomain === "procurement");
  const stored = AS.get(orgA, rPdf.artifact.id);
  check("1.4 artefato origin 'intake' + correlation + sha256", stored?.origin === "intake" && stored?.correlationId === "corr-intake-1" && !!stored?.sha256);

  // ===== 2. Round-trip: o arquivo recebido volta pela URL assinada =====
  const q = new URLSearchParams(rPdf.url!.split("?")[1]);
  const back = AS.resolveSigned(orgA, rPdf.artifact.id, q.get("exp")!, q.get("sig")!);
  check("2.1 conteúdo recuperado é idêntico ao recebido", !!back && Buffer.compare(back.buffer, PDF) === 0);

  // ===== 3. Imagem válida =====
  const rPng = FI.intake(orgA, "u1", { filename: "foto.png", buffer: PNG });
  check("3.1 detecta PNG + kind image", rPng.mime === "image/png" && rPng.artifact.kind === "image");

  // ===== 4. Segurança H4: conteúdo manda, não o nome/tipo declarado =====
  const rTrick = FI.intake(orgA, "u1", { filename: "malicioso.pdf", buffer: PNG });
  check("4.1 buffer PNG com nome .pdf → detectado image/png (conteúdo vence)", rTrick.mime === "image/png");

  // ===== 5. Rejeições =====
  let junkRejected = false, emptyRejected = false, bigRejected = false;
  try { FI.intake(orgA, "u1", { buffer: JUNK }); } catch { junkRejected = true; }
  try { FI.intake(orgA, "u1", { buffer: Buffer.alloc(0) }); } catch { emptyRejected = true; }
  try { FI.intake(orgA, "u1", { buffer: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(16 * 1024 * 1024, 1)]) }); } catch { bigRejected = true; }
  check("5.1 formato não suportado → rejeitado", junkRejected);
  check("5.2 arquivo vazio → rejeitado", emptyRejected);
  check("5.3 arquivo grande demais → rejeitado", bigRejected);

  // ===== 6. Isolamento multi-tenant =====
  const orgB = mkOrg();
  check("6.1 artefato de A não é visível em B", AS.get(orgB, rPdf.artifact.id) == null);
  check("6.2 URL assinada de A não resolve sob tenant B", AS.resolveSigned(orgB, rPdf.artifact.id, q.get("exp")!, q.get("sig")!) == null);

  console.log("\n=== TEST: Fala Tu recebe documentos (PRD 1 Fase 2.4, CA7) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Fala Tu recebe documentos (2.4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
