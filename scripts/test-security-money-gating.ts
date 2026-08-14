/**
 * TEST — Visibilidade de dinheiro por papel (SEC-F25 / FE3 / RN-CG-06 / §73). Determinístico.
 *
 * Prova as regras puras que as rotas de relatório financeiro usam:
 *   - só owner/admin veem dinheiro (receita/custo/lucro/margem/fiado);
 *   - FAIL CLOSED: sem user, papel desconhecido, agent/atendente → não vê;
 *   - redactMoney devolve o valor pra quem pode e `null` (nunca 0) pra quem não pode.
 *
 * As próprias rotas (dre/analytics-profit/loss/comigo-summary) levam `requireRole("owner","admin")`
 * — middleware padrão do repo; aqui cobrimos a regra de decisão reutilizável.
 *
 * Uso: npm run test:security-money-gating
 */
import { canSeeOrgMoney, redactMoney } from "../src/server/moneyVisibility.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function main() {
  // ── 1. Quem vê dinheiro ──
  check("1.1 owner vê", canSeeOrgMoney({ role: "owner" }) === true);
  check("1.2 admin vê", canSeeOrgMoney({ role: "admin" }) === true);

  // ── 2. FAIL CLOSED: quem NÃO vê ──
  check("2.1 agent não vê", canSeeOrgMoney({ role: "agent" }) === false);
  check("2.2 atendente/vendedor não vê", canSeeOrgMoney({ role: "vendedor" }) === false);
  check("2.3 papel desconhecido não vê", canSeeOrgMoney({ role: "qualquer" }) === false);
  check("2.4 sem user não vê", canSeeOrgMoney(null) === false && canSeeOrgMoney(undefined) === false);
  check("2.5 user sem role não vê", canSeeOrgMoney({}) === false);

  // ── 3. redactMoney ──
  check("3.1 owner recebe o valor", redactMoney(1234.5, { role: "owner" }) === 1234.5);
  check("3.2 admin recebe o valor", redactMoney(0, { role: "admin" }) === 0); // 0 legítimo não é redigido
  check("3.3 agent recebe null (redigido)", redactMoney(1234.5, { role: "agent" }) === null);
  check("3.4 sem user recebe null", redactMoney(999, null) === null);
  check("3.5 redação é null, NUNCA 0 (não inventa)", redactMoney(500, { role: "x" }) === null);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log("  x " + r.name);
  console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-money-gating: " + passed + "/" + results.length + " checks");
  process.exit(failures === 0 ? 0 : 1);
}
main();
