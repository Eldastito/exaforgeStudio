/**
 * TEST — ADR-206 F5.10: mapa FalaTu → SkillOS (3 ações → capacidades reais) + plano pelo Planner.
 * Determinístico, isolado por tmpDir. Uso: npm run test:falatu-skill-map
 */
import os from "os";
import path from "path";
import fs from "fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-skillmap-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-skillmap-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuSkillMapService: SVC, FALATU_SKILL_MAP } = await import("../src/server/FalaTuSkillMapService.js");
  const { SkillOsRegistryService: REG } = await import("../src/server/SkillOsRegistryService.js");
  const { SkillOsRolloutService: RO } = await import("../src/server/SkillOsRolloutService.js");
  const TODAY = "2026-10-12";
  const owner = { userId: "u-owner", id: "u-owner", role: "owner" };
  const vend = { userId: "u-vend", id: "u-vend", role: "agent" };
  const ORG = "org-fsm";
  const counts = () => ({
    actions: (db.prepare("SELECT COUNT(*) c FROM decision_actions").get() as any).c,
    audit: (db.prepare("SELECT COUNT(*) c FROM auth_audit_logs").get() as any).c,
    signals: (db.prepare("SELECT COUNT(*) c FROM business_signals").get() as any).c,
  });

  // ── mapa ──
  check("mapa tem exatamente 3 ações", FALATU_SKILL_MAP.length === 3 && SVC.mapping().length === 3);
  check("mapa: contato, compromisso e despesa", ["record_contact", "record_appointment", "record_expense"].every((k) => SVC.mapping().some((m) => m.kind === k)));
  check("despesa é risco medium; contato/compromisso low", SVC.mapping().find((m) => m.kind === "record_expense")!.riskLevel === "medium" && SVC.mapping().find((m) => m.kind === "record_contact")!.riskLevel === "low");
  check("venda e recebível NÃO foram mapeados (não inventa)", !SVC.mapping().some((m) => m.kind === "record_sale" || m.kind === "record_receivable"));

  // ── antes de registrar: honesto, nunca "pronto" ──
  const pre = SVC.plan(ORG, owner, "cadastra o cliente João Silva", { today: TODAY });
  check("sem registro: passo unresolved e plano blocked", pre.plan?.status === "blocked" && pre.plan.unresolvedCapabilities.includes("falatu.record_contact"));

  // ── registro ──
  const before = REG.listCapabilities({}).length;
  const r1 = SVC.register();
  const r2 = SVC.register();
  check("registra 3 capacidades e 3 skills", r1.capabilities === 3 && r1.skills === 3);
  check("idempotente: 2× não duplica", REG.listCapabilities({}).length === before + 3 && JSON.stringify(r1.stages) === JSON.stringify(r2.stages));
  check("estágio inicial shadow nas 3", FALATU_SKILL_MAP.every((e) => RO.get(e.skillId).stage === "shadow"));
  RO.setStage("falatu-record-contact-v1", "pilot");
  SVC.register();
  check("re-registrar NÃO clobera a decisão do operador", RO.get("falatu-record-contact-v1").stage === "pilot");
  RO.setStage("falatu-record-contact-v1", "shadow");
  check("skill aponta p/ capacidade existente e exige a permissão do módulo", REG.getSkill("falatu-record-expense-v1")?.requiredPermissions?.[0] === "financeiro" && !!REG.getCapability("falatu.record_expense"));

  // ── plano: o exemplo do dono ──
  const c0 = counts();
  const p = SVC.plan(ORG, owner, "cadastra o cliente João Silva e marca reunião com ele amanhã às 10h", { today: TODAY });
  check("2 passos mapeados e plano pronto", p.items.length === 2 && p.plan?.status === "ready" && p.plan.steps.every((s) => s.resolution === "resolved"));
  check("capacidades certas por ação", p.items[0].capabilityId === "falatu.record_contact" && p.items[1].capabilityId === "falatu.record_appointment");
  const apptStep = p.plan!.steps.find((s) => s.capabilityId === "falatu.record_appointment")!;
  check("compromisso depende do cadastro do cliente (mesma regra do multi-ação)", p.items[1].dependsOn === p.items[0].id && apptStep.dependsOn.includes(p.items[0].id) && p.items[1].dependsName === "João Silva");
  check("riscos agregados e fio (correlationId) presentes", p.plan!.riskLevel === "low" && !!p.plan!.correlationId);
  check("executes:false e ZERO escrita (ações/audit/sinais)", p.executes === false && JSON.stringify(counts()) === JSON.stringify(c0));

  // ── despesa + dinheiro role-gated ──
  const e1 = SVC.plan(ORG, owner, "lança despesa de R$ 200 com fornecedor Alfa", { today: TODAY });
  check("despesa mapeada p/ dono, risco medium", e1.items[0]?.capabilityId === "falatu.record_expense" && e1.plan?.riskLevel === "medium" && !e1.items[0].blocked);
  const e2 = SVC.plan(ORG, vend, "lança despesa de R$ 200 com fornecedor Alfa", { today: TODAY });
  check("despesa p/ quem não vê dinheiro: blocked e fora do plano", e2.items[0].blocked !== null && e2.plan === null);

  // ── o que NÃO é mapeado ──
  const s1 = SVC.plan(ORG, owner, "registra a venda de R$ 300 para Maria", { today: TODAY });
  check("venda aparece em notMapped, sem plano e sem chute", s1.notMapped.length === 1 && s1.notMapped[0].kind === "record_sale" && s1.plan === null && s1.items.length === 0);
  const q = SVC.plan(ORG, owner, "quanto vendi hoje?", { today: TODAY });
  check("pergunta não é ação: notActions, sem plano", q.notActions.length === 1 && q.plan === null && q.notMapped.length === 0);
  const emp = SVC.plan(ORG, owner, "   ", { today: TODAY });
  check("texto vazio: nada, sem plano", emp.plan === null && emp.items.length === 0 && emp.notMapped.length === 0 && emp.notActions.length === 0);
  const mix = SVC.plan(ORG, owner, "cadastra o cliente Pedro Alves; registra a venda de R$ 300 para Maria", { today: TODAY });
  check("mistura: mapeada entra no plano, não mapeada fica à parte", mix.items.length === 1 && mix.notMapped.length === 1 && mix.plan?.status === "ready");

  // ── limites do plano ──
  check("summary diz que nada foi executado", /Nada foi executado/.test(p.summary));
  check("zero escrita também nos casos extremos", JSON.stringify(counts()) === JSON.stringify(c0));

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
