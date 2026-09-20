/**
 * TESTE — F5 do Diretor IA com ferramentas: lacunas viram backlog
 * (docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md).
 * -----------------------------------------------------------------------------
 * Prova, offline (LLM do roteador desligado → força o miss):
 *  - pergunta de consulta de negócio SEM ferramenta que cubra registra
 *    DIRETOR_QUERY_MISS no audit; gaps() agrega por texto (mais frequente/
 *    recente primeiro);
 *  - pergunta COBERTA (vira ferramenta) NÃO vira gap;
 *  - pergunta analítica ("por que…") e saudação NÃO viram gap (é do panorama);
 *  - LGPD: telefone/CPF/cartão/e-mail são minimizados no que é gravado;
 *  - isolamento multi-tenant (gaps de A não aparecem pra B).
 *
 * Uso: npm run test:diretor-tools-gaps
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dirgaps-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dirgaps-1234567890";

let failures = 0; const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutiveQueryRouterService: R } = await import("../src/server/ExecutiveQueryRouterService.js");

  const mkOrg = (tag: string) => {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgId, `Rede ${tag}`);
    return orgId;
  };
  const A = mkOrg("A");
  const B = mkOrg("B");

  // LLM de seleção sempre devolve tool null → nenhuma ferramenta cobre além do
  // que o detect determinístico pegar.
  R.llmFn = async () => JSON.stringify({ tool: null, args: {} });

  // ── 1) Consulta de negócio sem ferramenta → vira gap. ──
  await R.answer(A, "qual o ticket médio por vendedor esse mês?", { canSeeMoney: true, actorId: "u1" });
  await R.answer(A, "qual o ticket médio por vendedor esse mês?", { canSeeMoney: true, actorId: "u1" }); // repete → count 2
  await R.answer(A, "quantos clientes novos entraram essa semana?", { canSeeMoney: true, actorId: "u1" });
  const g1 = R.gaps(A);
  check("1.1 lacunas registradas e agregadas", g1.items.length === 2, JSON.stringify(g1.items.map((i) => i.count)));
  const top = g1.items[0];
  check("1.2 a mais frequente vem primeiro (count 2)", top?.count === 2 && top.question.includes("ticket medio") || top?.question.includes("ticket médio"), JSON.stringify(top));
  check("1.3 totalMisses conta cada ocorrência", g1.totalMisses === 3, String(g1.totalMisses));

  // ── 2) Pergunta COBERTA não vira gap. ──
  const before = R.gaps(A).totalMisses;
  await R.answer(A, "metas do mes", { canSeeMoney: true, actorId: "u1" }); // detect → metas_progresso
  check("2.1 pergunta coberta (metas) não vira gap", R.gaps(A).totalMisses === before);

  // ── 3) Analítica e saudação não viram gap. ──
  const b2 = R.gaps(A).totalMisses;
  await R.answer(A, "por que as vendas cairam?", { canSeeMoney: true, actorId: "u1" });
  await R.answer(A, "oi, bom dia", { canSeeMoney: true, actorId: "u1" });
  check("3.1 analítica/saudação não poluem o backlog", R.gaps(A).totalMisses === b2, String(R.gaps(A).totalMisses - b2));

  // ── 4) LGPD: minimização. ──
  const mm = R.minimizeQuestion("vendas do cliente 5521999947477 cpf 123.456.789-00 email a@b.com");
  check("4.1 telefone/cpf/email minimizados", !mm.includes("5521999947477") && !mm.includes("123.456.789-00") && !mm.includes("a@b.com"), mm);
  await R.answer(A, "quanto o produto do cartao 4111 1111 1111 1111 rendeu?", { canSeeMoney: true, actorId: "u1" });
  const leak = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND metadata_json LIKE '%4111 1111%'`).get(A) as any;
  check("4.2 cartão não vaza no audit do gap", Number(leak?.n) === 0, String(leak?.n));

  // ── 5) Isolamento. ──
  check("5.1 gaps de A não aparecem pra B", R.gaps(B).totalMisses === 0);

  console.log("\n=== TEST: F5 — lacunas viram backlog ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
