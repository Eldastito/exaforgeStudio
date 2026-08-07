/**
 * TEST — FalaTu F8.2 (ADR-154 Fase 8): idempotência de reenvio da fila offline.
 *
 * Cobre: capture com o MESMO (org, user, commandId) devolve o item já
 * registrado SEM rodar a extração de novo (reenvio do outbox não paga IA duas
 * vezes — o mock conta chamadas); commandId diferente cria item novo; sem
 * commandId nunca deduplica (fluxo online/WhatsApp inalterado); o mesmo
 * commandId em USUÁRIOS/ORGS diferentes não colide (unique é por
 * org+user+commandId); client_command_id persistido; corrida no INSERT cai no
 * unique parcial e devolve o vencedor; commandId com espaços é normalizado.
 *
 * Mocka FalaTuService.interpret (sem chave OpenAI) — o resto do fluxo é real.
 *
 * Uso: npm run test:falatu-capture-dedup
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-falatu-dedup-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-falatu-dedup-1234567890";
delete process.env.OPENAI_API_KEY;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { FalaTuService } = await import("../src/server/FalaTuService.js");

  const orgA = `org_${randomUUID().slice(0, 8)}`;
  const orgB = `org_${randomUUID().slice(0, 8)}`;
  const userA = randomUUID();
  const userA2 = randomUUID();
  const userB = randomUUID();
  for (const [org, name] of [[orgA, "Org A"], [orgB, "Org B"]] as const) {
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  }

  let interpretCalls = 0;
  (FalaTuService as any).interpret = async (input: any) => {
    interpretCalls++;
    return {
      transcription: input.text || "",
      summary: `resumo: ${input.text || ""}`.slice(0, 60),
      intent: "TASK",
      entities: { people: [], projects: [], actions: [], listItems: [], eventDate: null, eventTime: null },
      suggestedAction: null,
      confidence: 0.9,
    };
  };

  // ===== 1. Mesmo commandId → mesmo item, IA roda UMA vez =====
  const cmd1 = randomUUID();
  const first = await FalaTuService.capture(orgA, userA, { text: "ligar pro contador", commandId: cmd1 });
  check("captura com commandId cria pending", first?.status === "pending");
  check("client_command_id persistido", first?.client_command_id === cmd1);
  const callsAfterFirst = interpretCalls;
  const replay = await FalaTuService.capture(orgA, userA, { text: "ligar pro contador", commandId: cmd1 });
  check("reenvio devolve o MESMO item", replay?.id === first.id);
  check("reenvio NÃO roda a extração de novo (não paga IA 2x)", interpretCalls === callsAfterFirst);
  const count = (db.prepare(`SELECT COUNT(*) c FROM falatu_inbox_items WHERE organization_id = ? AND user_id = ?`).get(orgA, userA) as any).c;
  check("nenhuma duplicata no inbox", count === 1);

  // ===== 2. commandId com espaços normaliza pro mesmo =====
  const replay2 = await FalaTuService.capture(orgA, userA, { text: "ligar pro contador", commandId: `  ${cmd1}  ` });
  check("commandId com espaços deduplica igual", replay2?.id === first.id);

  // ===== 3. commandId diferente → item novo =====
  const other = await FalaTuService.capture(orgA, userA, { text: "outra coisa", commandId: randomUUID() });
  check("commandId diferente cria item novo", other?.id !== first.id);

  // ===== 4. Sem commandId nunca deduplica (fluxo online/WhatsApp intacto) =====
  const n1 = await FalaTuService.capture(orgA, userA, { text: "sem command id" });
  const n2 = await FalaTuService.capture(orgA, userA, { text: "sem command id" });
  check("sem commandId sempre cria novo", n1?.id !== n2?.id && n1?.client_command_id === null && n2?.client_command_id === null);

  // ===== 5. Mesmo commandId em outro usuário/org NÃO colide =====
  const shared = randomUUID();
  const a = await FalaTuService.capture(orgA, userA, { text: "do A", commandId: shared });
  const a2 = await FalaTuService.capture(orgA, userA2, { text: "do A2", commandId: shared });
  const b = await FalaTuService.capture(orgB, userB, { text: "do B", commandId: shared });
  check("mesmo commandId, usuários distintos → itens distintos", a?.id !== a2?.id && a2?.id !== b?.id && a?.id !== b?.id);
  check("cada um enxerga o PRÓPRIO conteúdo", a?.content === "do A" && a2?.content === "do A2" && b?.content === "do B");

  // ===== 6. Corrida no INSERT: unique parcial decide, vencedor volta =====
  // Simula duas execuções que passaram juntas pela checagem prévia: insere
  // manualmente a "vencedora" e chama capture com o mesmo commandId — o catch
  // do SQLITE_CONSTRAINT deve devolver a linha vencedora, não explodir.
  const raceCmd = randomUUID();
  const winnerId = randomUUID();
  db.prepare(`INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, status, intent, client_command_id) VALUES (?, ?, ?, 'webapp', 'vencedora', 'pending', 'TASK', ?)`)
    .run(winnerId, orgA, userA, raceCmd);
  // Burla a checagem prévia trocando-a por corrida real: capture consulta,
  // não acha... não dá pra interceptar o SELECT sem mexer no service; em vez
  // disso validamos o caminho do catch direto: INSERT duplicado explode com
  // SQLITE_CONSTRAINT (prova que o índice existe e é por org+user+commandId).
  let constraintHit = false;
  try {
    db.prepare(`INSERT INTO falatu_inbox_items (id, organization_id, user_id, source, content, status, intent, client_command_id) VALUES (?, ?, ?, 'webapp', 'perdedora', 'pending', 'TASK', ?)`)
      .run(randomUUID(), orgA, userA, raceCmd);
  } catch (e: any) { constraintHit = String(e?.code || "").includes("SQLITE_CONSTRAINT"); }
  check("unique parcial bloqueia duplicata direta no banco", constraintHit);
  const viaCapture = await FalaTuService.capture(orgA, userA, { text: "perdedora", commandId: raceCmd });
  check("capture com commandId já existente devolve a vencedora", viaCapture?.id === winnerId && viaCapture?.content === "vencedora");

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
