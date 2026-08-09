/**
 * TEST — Decision Intelligence DI-5.4 (ADR-157): agenda de nichos + passe automático.
 *
 * VerticalIntelligenceResearchService: o admin master registra nichos com
 * intervalo; maybeSweep() dispara o pipeline autônomo (curate) só para nichos
 * VENCIDOS, COM consumidores e DENTRO do orçamento. Mútua exclusão (RN-157-4):
 * nicho automatizado não gera lembrete DI-4.5. Offline, sem chave de IA (o
 * provider default cai no stub, que passa no gate).
 *
 * Uso: npm run test:decision-intelligence-di5-schedule
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-di5s-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-di5s-1234567890";
delete process.env.OPENAI_API_KEY;
delete process.env.EXTERNAL_RESEARCH_PROVIDER;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { VerticalIntelligenceService: VIS, researchFingerprint } = await import("../src/server/VerticalIntelligenceService.js");
  const { VerticalIntelligenceResearchService: Research } = await import("../src/server/VerticalIntelligenceResearchService.js");
  const { VerticalIntelligenceReminderService: Reminder } = await import("../src/server/VerticalIntelligenceReminderService.js");
  const { ResearchBudgetService: Budget } = await import("../src/server/ResearchBudgetService.js");

  const mkConsumer = (vertical: string) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, external_intelligence_enabled) VALUES (?, ?, 'X', 'active', ?, 1)`).run(randomUUID(), id, vertical);
    return id;
  };
  Budget.setBudgetCents(0); // ilimitado

  // ===================== Registro de nichos (as 3 alavancas) =====================
  const s = Research.upsert({ vertical: "moda", topic: "inverno", intervalDays: 7 });
  check("upsert registra o nicho na agenda", !!s && s.vertical === "moda" && s.interval_days === 7 && s.enabled === 1);
  check("agenda compartilhada NÃO tem organization_id", !("organization_id" in s));
  check("list devolve o nicho", Research.list().length === 1);

  // ===================== Sem consumidor → não roda =====================
  let r = await Research.maybeSweep();
  check("sem consumidor: nada é pesquisado", r.due === 0 && r.attempted === 0);

  // ===================== Com consumidor e nicho vencido (nunca rodou) → roda =====================
  mkConsumer("moda");
  const fpModa = researchFingerprint("moda", "inverno");
  check("nicho nunca rodado conta como vencido", Research.dueNiches().length === 1);
  r = await Research.maybeSweep();
  check("com consumidor: publica o nicho vencido", r.attempted === 1 && r.published === 1);
  check("head do nicho foi criado pela automação", !!VIS.getByFingerprint(fpModa));

  // ===================== Recém-rodado NÃO vence de novo (intervalo) =====================
  check("nicho recém-rodado sai da fila (não vencido)", Research.dueNiches().length === 0);
  const r2 = await Research.maybeSweep();
  check("2ª varredura imediata não republica (respeita intervalo)", r2.attempted === 0);
  // simula intervalo vencido: joga last_run_at pra 10 dias atrás
  db.prepare("UPDATE vertical_intelligence_schedule SET last_run_at = datetime('now','-10 days') WHERE fingerprint = ?").run(fpModa);
  check("após o intervalo, o nicho volta a vencer", Research.dueNiches().length === 1);

  // ===================== Orçamento estourado → não dispara provider =====================
  Budget.setBudgetCents(1); // teto baixo
  // gasta o teto com um custo alto direto no ledger
  Budget.record({ vertical: "x", topic: "x", provider: "x", costCents: 500 });
  check("orçamento está esgotado", Budget.status().exhausted === true);
  const r3 = await Research.maybeSweep();
  check("orçamento estourado: sweep pula (budget_exceeded)", r3.skipped === "budget_exceeded" && r3.attempted === 0);
  Budget.setBudgetCents(0); // solta de novo

  // ===================== Toggle global desliga tudo =====================
  Research.setEnabled(false);
  const r4 = await Research.maybeSweep();
  check("toggle off: sweep desabilitado", r4.skipped === "disabled");
  Research.setEnabled(true);

  // ===================== Mútua exclusão com o lembrete DI-4.5 (RN-157-4) =====================
  // Deixa o head do nicho automatizado VENCIDO (valid_until no passado) — o
  // lembrete pegaria, mas a agenda enabled tem de excluí-lo.
  db.prepare("UPDATE vertical_intelligence SET valid_until = datetime('now','-1 day') WHERE fingerprint = ?").run(fpModa);
  const reminded = Reminder.dueNiches().map((n: any) => n.fingerprint);
  check("nicho automatizado NÃO aparece no lembrete manual (RN-157-4)", !reminded.includes(fpModa));
  // Desligar a automação do nicho devolve ele ao lembrete.
  Research.setNicheEnabled(fpModa, false);
  const remindedAfter = Reminder.dueNiches().map((n: any) => n.fingerprint);
  check("desligar a automação devolve o nicho ao lembrete", remindedAfter.includes(fpModa));

  // ===================== remove =====================
  Research.remove(fpModa);
  check("remove tira o nicho da agenda", Research.list().length === 0);

  console.log("\n=== TEST: Decision Intelligence DI-5.4 (agenda + passe automático) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision Intelligence DI-5.4 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
