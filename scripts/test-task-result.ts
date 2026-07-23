/**
 * TEST — Tarefa com RESULTADO medido + EVIDÊNCIA (ADR-134 Fatia 1).
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:task-result
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-taskres-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-taskres-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { TaskService: T } = await import("../src/server/TaskService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // ===== 1. Tarefa nasce com o PROBLEMA (resultado a medir + baseline) =====
  const t = T.create(orgA, { title: "Conferir estoque A, B e C", resultLabel: "Divergência de estoque (R$)", resultBaseline: 3200 }, "user-1");
  check("tarefa guarda o resultado a medir e o valor inicial", t.result && t.result.label === "Divergência de estoque (R$)" && t.result.baseline === 3200);
  check("antes de concluir, resultado final e delta ficam vazios", t.result.final === null && t.result.delta === null);

  // ===== 2. Concluir REGISTRANDO o resultado (antes → depois) + evidência =====
  const done = T.recordResult(orgA, t.id, { resultFinal: 420, evidenceUrl: "/media/foto-estoque.jpg" }, "user-1");
  check("concluir marca a tarefa como feito", done.status === "feito" && !!done.completed_at);
  check("resultado medido: final e delta (3200 - 420 = 2780)", done.result.final === 420 && done.result.delta === 2780);
  check("evidência anexada", done.result.evidenceUrl === "/media/foto-estoque.jpg");
  const upd = (done.updates || []).find((u: any) => u.kind === "result");
  check("registro do resultado narra antes → depois", !!upd && /3200/.test(upd.text) && /420/.test(upd.text) && /evid/i.test(upd.text));

  // ===== 3. Tarefa comum (sem resultado) continua funcionando =====
  const t2 = T.create(orgA, { title: "Ligar para fornecedor" }, "user-1");
  check("tarefa sem resultado não cria o bloco de resultado", t2.result === null);
  const d2 = T.recordResult(orgA, t2.id, { evidenceUrl: "/media/print.jpg" }, "user-1");
  check("concluir só com evidência funciona (sem número)", d2.status === "feito" && d2.result.evidenceUrl === "/media/print.jpg" && d2.result.final === null);

  // ===== 4. Isolamento =====
  const orgB = mkOrg();
  let threw = false;
  try { T.recordResult(orgB, t.id, { resultFinal: 1 }); } catch { threw = true; }
  check("isolamento: não conclui tarefa de outra org", threw);

  console.log("\n=== TEST: Tarefa com resultado + evidência (ADR-134) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Tarefa com resultado + evidência OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
