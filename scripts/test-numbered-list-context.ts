/**
 * TEST — F3.4 (RF-06 / CA-06): contexto durável da lista numerada.
 *
 * Prova, offline (tmp db), que NumberedListContextService guarda a ORDEM
 * mostrada e a resolve de forma estável — o que fecha o CA-06 (a resposta "2"
 * não muda de alvo, e sobrevive a restart porque vive no SQLite, não num Map):
 *  - remember + resolveIndex (1-based) + limites fora da lista → null.
 *  - resolvedIds devolve o array; desconhecido → null.
 *  - durabilidade: o valor lido vem do banco (não de memória de processo).
 *  - upsert substitui a lista anterior.
 *  - TTL: expira e limpa; clear apaga.
 *  - isolamento por org / usuário / escopo.
 *
 * Uso: npm run test:numbered-list-context
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-numlist-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-numlist-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { NumberedListContextService: N } = await import("../src/server/NumberedListContextService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  const u1 = "user_1"; const u2 = "user_2";
  const scope = "gestor_approvals" as const;

  // ── 1. remember + resolveIndex (1-based) ──
  N.remember(A, u1, scope, ["a", "b", "c"]);
  check("1.1 índice 1 → a", N.resolveIndex(A, u1, scope, 1) === "a");
  check("1.2 índice 2 → b", N.resolveIndex(A, u1, scope, 2) === "b");
  check("1.3 índice 3 → c", N.resolveIndex(A, u1, scope, 3) === "c");
  check("1.4 índice 0 → null", N.resolveIndex(A, u1, scope, 0) === null);
  check("1.5 índice 4 (fora) → null", N.resolveIndex(A, u1, scope, 4) === null);
  check("1.6 índice negativo → null", N.resolveIndex(A, u1, scope, -1) === null);

  // ── 2. resolvedIds ──
  check("2.1 resolvedIds devolve a lista", JSON.stringify(N.resolvedIds(A, u1, scope)) === JSON.stringify(["a", "b", "c"]));
  check("2.2 usuário sem lista → null", N.resolvedIds(A, u2, scope) === null);

  // ── 3. Durabilidade: o valor está no BANCO (não em memória de processo) ──
  const row = db.prepare(`SELECT item_ids_json FROM numbered_list_contexts WHERE organization_id = ? AND user_id = ? AND scope = ?`).get(A, u1, scope) as any;
  check("3.1 persistido no SQLite (sobrevive a restart)", !!row && JSON.parse(row.item_ids_json)[1] === "b");

  // ── 4. Upsert substitui a lista anterior ──
  N.remember(A, u1, scope, ["x", "y", "z", "w"]);
  check("4.1 nova lista substitui", N.resolveIndex(A, u1, scope, 1) === "x");
  check("4.2 tamanho novo", (N.resolvedIds(A, u1, scope) || []).length === 4);

  // ── 5. TTL expira e limpa ──
  N.remember(A, u1, scope, ["p", "q"], { ttlMin: 30, now: new Date() });
  const later = new Date(Date.now() + 31 * 60_000);
  check("5.1 expirado → null", N.resolveIndex(A, u1, scope, 1, later) === null);
  check("5.2 linha limpa após expirar", !db.prepare(`SELECT 1 FROM numbered_list_contexts WHERE organization_id = ? AND user_id = ? AND scope = ?`).get(A, u1, scope));

  // ── 6. clear ──
  N.remember(A, u1, scope, ["k"]);
  N.clear(A, u1, scope);
  check("6.1 após clear → null", N.resolvedIds(A, u1, scope) === null);

  // ── 7. Isolamento org / usuário / escopo ──
  N.remember(A, u1, "gestor_approvals", ["ga"]);
  N.remember(A, u1, "coordenador_tasks", ["ct"]);
  N.remember(B, u1, "gestor_approvals", ["gb"]);
  check("7.1 escopos isolados no mesmo usuário", N.resolveIndex(A, u1, "gestor_approvals", 1) === "ga" && N.resolveIndex(A, u1, "coordenador_tasks", 1) === "ct");
  check("7.2 orgs isoladas", N.resolveIndex(B, u1, "gestor_approvals", 1) === "gb");
  check("7.3 org B não vê a lista de A no coordenador", N.resolvedIds(B, u1, "coordenador_tasks") === null);
  check("7.4 usuário sem lista naquele escopo → null", N.resolvedIds(A, u2, "coordenador_tasks") === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} numbered-list-context: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
