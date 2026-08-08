/**
 * TEST — injeção do grimoire no prompt VIVO de recuperação (ADR-155, fecha o
 * loop F1.4 em runtime).
 *
 * Prova que o `SalesRecoveryMessageGenerator` injeta o bloco do grimoire
 * (rubrica `sales-recovery` + lições do pós-mortem F3.2 + contexto de marca) no
 * system prompt do LLM — gated por brand_voice, best-effort, sem quebrar a
 * geração. Usa o mock de chat pra capturar o `system` enviado ao modelo.
 *
 * Uso: npm run test:sales-recovery-grimoire-injection
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-srgi-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-srgi-1234567890";
process.env.OPENAI_API_KEY = "test-key-para-alcancar-o-chat"; // sem isso o generator cai no fallback template

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { GrimoireService } = await import("../src/server/GrimoireService.js");
  const { generate, __setGeneratorChatForTests } = await import("../src/server/SalesRecoveryMessageGenerator.js");

  const mkOrg = (brandVoice: boolean) => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, brand_voice_enabled) VALUES (?, ?, 'Loja', 'active', 'servicos', ?)`).run(randomUUID(), orgId, brandVoice ? 1 : 0);
    return orgId;
  };

  // Mock de chat que captura o `system` recebido e devolve um JSON válido.
  let capturedSystem = "";
  __setGeneratorChatForTests(async (_userText: string, opts: any) => {
    capturedSystem = String(opts?.system || "");
    return '{"text":"Oi, Ana! 🙂 Quer retomar?"}';
  });

  const genInput = { stage: "proposta", daysStalled: 5, contactName: "Ana", attemptNumber: 1 as const };

  // ===== 1. brand voice ON + lição na rubrica sales-recovery → injeta grimoire =====
  const orgOn = mkOrg(true);
  await GrimoireService.recordLesson(orgOn, "sales-recovery", { lesson: "Evitar 2 perguntas na mesma mensagem.", source: "sales_recovery_ab_result", dedupeKey: "kx" });
  const g1 = await generate({ orgId: orgOn, ...genInput });
  check("gera via LLM (mock) → source llm", g1.source === "llm");
  check("system carrega a rubrica sales-recovery", capturedSystem.includes('id="sales-recovery"'));
  check("system carrega o bloco <licoes>", capturedSystem.includes("<licoes>"));
  check("system carrega a lição do pós-mortem", capturedSystem.includes("Evitar 2 perguntas na mesma mensagem."));
  check("system mantém o prompt base (não substitui)", capturedSystem.includes("RETOMAR") || capturedSystem.includes("REABRIR"));

  // ===== 2. brand voice OFF → zero injeção (só o prompt base) =====
  capturedSystem = "";
  const orgOff = mkOrg(false);
  await GrimoireService.recordLesson(orgOff, "sales-recovery", { lesson: "lição da org off", dedupeKey: "ky" });
  await generate({ orgId: orgOff, ...genInput });
  check("brand voice OFF → sem <licoes>", !capturedSystem.includes("<licoes>"));
  check("brand voice OFF → sem rubrica injetada", !capturedSystem.includes('id="sales-recovery"'));
  check("brand voice OFF → prompt base intacto", capturedSystem.includes("RETOMAR") || capturedSystem.includes("REABRIR"));

  // ===== 3. sem orgId → prompt base, sem grimoire, sem crash (retrocompat) =====
  capturedSystem = "";
  const g3 = await generate({ ...genInput });
  check("sem orgId → gera sem crash", g3.source === "llm");
  check("sem orgId → sem injeção de grimoire", !capturedSystem.includes("<licoes>") && !capturedSystem.includes('id="sales-recovery"'));

  // ===== 4. ISOLAMENTO: lição de uma org não vaza pra outra =====
  capturedSystem = "";
  const orgOther = mkOrg(true); // brand voice ON, mas SEM lição própria
  await generate({ orgId: orgOther, ...genInput });
  check("ISOLAMENTO: org sem lição não herda a de orgOn", !capturedSystem.includes("Evitar 2 perguntas na mesma mensagem."));

  __setGeneratorChatForTests(null);

  console.log("\n=== Sales Recovery — injeção do grimoire no prompt vivo ===");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checagens ok`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s)`); process.exit(1); }
  console.log("\n✅ injeção do grimoire no prompt vivo íntegra");
}

main();
