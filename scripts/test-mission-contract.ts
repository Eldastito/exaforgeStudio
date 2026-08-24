/**
 * TEST — Mission Contract (ADR-189 F1, Mission OS). DB-backed, determinístico.
 * Prova: entidade própria (não é linha de goal), flag opt-in, create/validação (título obrigatório,
 * métrica conhecida × qualitativa, autopilot proibido no nascimento — shadow-first), humanStatus,
 * update parcial, setStatus, setAutonomy (autopilot recusado), cancel preserva histórico, isolamento.
 *
 * Uso: npm run test:mission-contract
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-mission-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-mission-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { MissionService: M } = await import("../src/server/MissionService.js");

  const mkOrg = (flag = 1) => {
    const o = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, mission_layer_enabled) VALUES (?, ?, 'O', 'active', ?)`).run(randomUUID(), o, flag);
    return o;
  };

  const A = mkOrg(1);
  const B = mkOrg(0);

  // 1. Flag opt-in.
  check("1.1 isEnabled reflete a flag (A on, B off)", M.isEnabled(A) === true && M.isEnabled(B) === false);

  // 2. create — título obrigatório; nasce draft/off/user.
  check("2.1 título vazio → erro", throws(() => M.create(A, { title: "  " })));
  const m1 = M.create(A, { title: "Recuperar R$20k de inadimplência", targetMetric: "revenue", targetValue: 20000, targetUnit: "BRL", deadline: "2026-09-30", desiredState: "inadimplência zerada", source: "user" });
  check("2.2 nasce draft + off + user", m1.status === "draft" && m1.autonomyLevel === "off" && m1.source === "user");
  check("2.3 humanStatus traduz (draft → Rascunho)", m1.humanStatus === "Rascunho");
  check("2.4 alvo inline carregado", m1.targetMetric === "revenue" && m1.targetValue === 20000 && m1.targetUnit === "BRL");

  // 3. Métrica: conhecida ok; desconhecida → erro; qualitativa (null) permitida.
  check("3.1 métrica desconhecida → erro (não inventa)", throws(() => M.create(A, { title: "x", targetMetric: "nao_existe" })));
  const mQual = M.create(A, { title: "Reduzir tempo de resposta pra menos de 5 min" });
  check("3.2 missão qualitativa (sem métrica) permitida", mQual.targetMetric === null);

  // 4. Shadow-first (RN-MOL-4): autopilot proibido no nascimento e no setAutonomy.
  check("4.1 create com autopilot → erro", throws(() => M.create(A, { title: "x", autonomyLevel: "autopilot" })));
  check("4.2 autonomia intermediária ok (shadow)", M.create(A, { title: "y", autonomyLevel: "shadow" }).autonomyLevel === "shadow");
  check("4.3 setAutonomy autopilot → erro", throws(() => M.setAutonomy(A, m1.id, "autopilot")));
  check("4.4 setAutonomy approval ok", M.setAutonomy(A, m1.id, "approval").autonomyLevel === "approval");

  // 5. update parcial.
  const u = M.update(A, m1.id, { description: "foco em 45-75 dias", confidence: 1.7 });
  check("5.1 update parcial + confidence clampado a [0,1]", u.description === "foco em 45-75 dias" && u.confidence === 1);
  check("5.2 update título vazio → erro", throws(() => M.update(A, m1.id, { title: "" })));
  check("5.3 update métrica desconhecida → erro", throws(() => M.update(A, m1.id, { targetMetric: "nope" })));

  // 6. setStatus — enum válido; inválido recusado.
  check("6.1 setStatus inválido → erro", throws(() => M.setStatus(A, m1.id, "banana")));
  const at = M.setStatus(A, m1.id, "at_risk");
  check("6.2 setStatus at_risk + humanStatus '⚠️ Em risco'", at.status === "at_risk" && at.humanStatus.includes("Em risco"));

  // 7. cancel preserva histórico (status, nunca DELETE).
  const c = M.cancel(A, mQual.id);
  check("7.1 cancel → status cancelled, linha ainda existe", c.status === "cancelled" && !!M.get(A, mQual.id));

  // 8. list — ativas antes das encerradas; isolamento.
  const listA = M.list(A);
  check("8.1 list só da org A (isolamento)", listA.every((m) => m.organizationId === A) && M.list(B).length === 0);
  const idxCancelled = listA.findIndex((m) => m.id === mQual.id);
  const idxActive = listA.findIndex((m) => m.status !== "cancelled" && m.status !== "achieved" && m.status !== "failed");
  check("8.2 encerradas ordenadas após ativas", idxActive < idxCancelled);

  // 9. get de outra org não vaza.
  check("9.1 get cross-org retorna null", M.get(B, m1.id) === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} mission-contract: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
