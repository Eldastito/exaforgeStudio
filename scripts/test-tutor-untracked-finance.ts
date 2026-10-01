/**
 * TESTE — Tutor: dado que ninguém registra não vira "R$ 0,00" (null≠zero) + "Entrou no caixa" lia o objeto errado.
 * Achados (01/10/2026, print da produção TOULON): "Caixa R$ … · a receber R$ 0,00 · a pagar R$ 0,00" e, à noite, "Nada a receber em aberto".
 * "A receber/pagar" só somam contas CADASTRADAS no financeiro do ZappFlow (a loja vive de PDV/fechamento/cartão): zero ali é "ninguém cadastra
 * isso aqui", não "não há dívida". E "Entrou no caixa" passava o OBJETO {inflow,outflow,net} ao formatador → saía SEMPRE R$ 0,00.
 * Uso:  npm run test:tutor-untracked-finance
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-tutor-untracked-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-tutor-untracked-1234567890abcdef";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  await new Promise((r) => setTimeout(r, 200));
  const { BusinessTutorService: T } = await import("../src/server/BusinessTutorService.js");
  const { FinancialLedgerService: L } = await import("../src/server/FinancialLedgerService.js");
  const { FinanceSnapshotAdapter } = await import("../src/server/FinanceSnapshotAdapter.js");

  const org = (tag: string) => { const id = `org_${tag}_${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const kpiLine = (o: string) => (T.morningBrief(o).text.split("\n").find((l) => l.startsWith("💰")) || "");
  const night = (o: string) => T.eveningBrief(o).text;

  // ── (1) org sem NENHUM registro financeiro (a situação da loja que vive de PDV) ──
  const A = org("A");
  const trA = L.tracking(A);
  check("tracking: nada cadastrado → receivables/payables/cashEvents todos false", !trA.receivables && !trA.payables && !trA.cashEvents, JSON.stringify(trA));
  const kA = kpiLine(A);
  check("manhã: 'a receber —' e 'a pagar —' (não R$ 0,00)", /a receber —/.test(kA) && /a pagar —/.test(kA) && !/a (receber|pagar) R\$ 0,00/.test(kA), kA);
  check("manhã: Caixa '—' quando não há NENHUM lançamento e o saldo é 0", /Caixa —/.test(kA), kA);
  check("manhã: a linha explica o '—' (não significa zero)", /não significa zero/.test(T.morningBrief(A).text));
  const nA = night(A);
  check("noite: 'Entrou no caixa' é '—' (o financeiro não recebe as vendas da loja), nunca R$ 0,00", /Entrou no caixa: —/.test(nA) && !/Entrou no caixa: R\$ 0,00/.test(nA), nA);
  check("noite: NÃO afirma 'Nada a receber/Nada em aberto' — diz que não há contas cadastradas", !/Nada a receber em aberto|Nada em aberto por hoje/.test(nA) && /não há contas a receber cadastradas/i.test(nA), nA);

  // ── (2) só contas a pagar cadastradas: a pagar vira número, a receber continua '—' ──
  const B = org("B");
  L.addPayable(B, { description: "Aluguel", amount: 100, dueDate: "2026-10-30" } as any);
  const kB = kpiLine(B);
  check("com conta a pagar cadastrada: 'a pagar R$ 100,00' e 'a receber —'", /a pagar R\$ 100,00/.test(kB) && /a receber —/.test(kB), kB);

  // ── (3) usa o financeiro e não deve nada: zero é FATO ──
  const C = org("C");
  const rc: any = L.addReceivable(C, { description: "Venda a prazo", amount: 50, dueDate: "2026-09-01" });
  L.receiveReceivable(C, rc.id, { date: "2026-09-02" });
  L.addPayable(C, { description: "Luz", amount: 80, dueDate: "2026-09-01" } as any);
  const pays: any[] = (db.prepare(`SELECT id FROM payables WHERE organization_id = ?`).all(C) as any[]);
  L.payPayable(C, pays[0].id, { date: "2026-09-02" } as any);
  const kC = kpiLine(C);
  check("org que usa o financeiro e quitou tudo: 'a receber R$ 0,00 · a pagar R$ 0,00' (zero é fato)", /a receber R\$ 0,00/.test(kC) && /a pagar R\$ 0,00/.test(kC), kC);
  check("e a linha NÃO traz o aviso de '—'", !/não significa zero/.test(T.morningBrief(C).text));
  check("noite dessa org: segue 'Nada em aberto por hoje' (0-regressão)", /Nada em aberto por hoje/.test(night(C)), night(C));

  // ── (4) 'Entrou no caixa' lia o objeto errado ──
  const D = org("D");
  L.recordEvent(D, { direction: "in", amount: 250, sourceType: "manual", sourceId: randomUUID() } as any);
  check("entrou dinheiro hoje (R$ 250): mostra R$ 250,00 (antes saía R$ 0,00); sem saída lançada o rótulo é 'Entradas registradas hoje' (ver test-honest-cash)", /(Entrou no caixa|Entradas registradas hoje): R\$ 250,00/.test(night(D)), night(D));
  const E = org("E");
  L.recordEvent(E, { direction: "in", amount: 70, eventDate: "2026-01-10", sourceType: "manual", sourceId: randomUUID() } as any);
  check("há lançamentos, mas nenhum hoje: 'R$ 0,00' (zero é fato)", /(Entrou no caixa|Entradas registradas hoje): R\$ 0,00/.test(night(E)), night(E));
  const snapD: any = (FinanceSnapshotAdapter as any).build ? (FinanceSnapshotAdapter as any).build(D) : null;
  const entrou = snapD?.finance?.entrouHoje?.value ?? snapD?.entrouHoje?.value;
  check("snapshot de decisão: entrouHoje também lê o inflow (250), não o objeto", entrou === 250, JSON.stringify(entrou));

  // ── (5) isolamento ──
  const trD = L.tracking(D), trA2 = L.tracking(A);
  check("isolamento: registro da org D não faz a org A 'acompanhar' nada", trD.cashEvents && !trA2.cashEvents && !trA2.receivables && !trA2.payables);

  const pass = results.filter((x) => x.ok).length;
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${!x.ok && x.detail ? `\n      ↳ ${x.detail}` : ""}`);
  console.log(failures ? `\n${failures} FALHA(S) (${pass}/${results.length} ok)` : `\n${pass}/${results.length} verificações OK`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
