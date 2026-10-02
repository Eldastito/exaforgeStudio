/**
 * TESTE — PRD Fase 1 §25 (bug): "Quanto vendemos em dinheiro hoje?" NÃO é pergunta de SALDO. A regex do atalho tratava
 * "dinheiro"/"caixa"/"quanto tenho" como saldo e respondia "Caixa atual: R$ …" (outro número). Prova: frases de VENDA/faturamento
 * saem do atalho e, pro gestor, viram `pergunta_negocio` (Diretor IA) SEM resposta de caixa; os atalhos de saldo de verdade
 * ("saldo", "quanto tenho em caixa", "dinheiro" solto) seguem iguais (0-regressão); colaborador comum não vai pro Diretor IA.
 * Uso:  npm run test:gestor-sales-routing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gestsales-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-gestsales-1234567890";

let failures = 0;
function check(name: string, ok: boolean) { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { GestorCommandService: G } = await import("../src/server/GestorCommandService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  // ── parser: frases de venda NÃO são saldo ──
  for (const t of ["Quanto vendemos em dinheiro hoje?", "quanto vendemos hoje?", "quanto vendeu no caixa hoje", "qual o faturamento de hoje", "quanto faturamos em dinheiro?", "vendas em dinheiro de ontem", "receita de hoje"]) {
    check(`'${t}' não vira saldo`, G.parse(t).intent === "desconhecido");
  }
  // ── 0-regressão: o que sempre foi saldo continua ──
  for (const t of ["saldo", "Saldo do caixa", "quanto tenho em caixa?", "quanto tenho", "dinheiro", "caixa", "qual o saldo de vendas?"]) {
    check(`'${t}' continua saldo`, G.parse(t).intent === "saldo");
  }
  check("os outros atalhos não mudaram (a receber / a pagar / prioridades)", G.parse("a receber").intent === "a_receber" && G.parse("contas a pagar").intent === "a_pagar" && G.parse("o que devo atacar hoje").intent === "prioridades");

  // ── fluxo completo ──
  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, wa_gestor_enabled) VALUES (?, ?, 'X', 'active', 1)`).run(randomUUID(), org);
  P.seedSystemProfiles(org);
  const user = (role: string, phone: string) => db.prepare("INSERT INTO users (id, organization_id, name, email, phone, role, global_status) VALUES (?, ?, ?, ?, ?, ?, 'active')").run(randomUUID(), org, `U ${role}`, `${randomUUID()}@x.com`, phone, role);
  user("owner", "11999990001"); user("agent", "11999990002");

  const own = await G.handle(org, "11999990001", "Quanto vendemos em dinheiro hoje?");
  check("gestor: pergunta de venda vira pergunta_negocio (Diretor IA), roteada, sem resposta de caixa", own.handled && own.intent === "pergunta_negocio" && own.reply === "" && G.shouldRoute(own));
  const sal = await G.handle(org, "11999990001", "saldo");
  check("gestor: 'saldo' segue respondendo o caixa", sal.intent === "saldo" && /Caixa atual/.test(sal.reply));
  const col = await G.handle(org, "11999990002", "Quanto vendemos em dinheiro hoje?");
  check("colaborador comum: nunca vai pro Diretor IA nem recebe caixa", col.intent === "desconhecido" && !/Caixa atual/.test(col.reply));

  console.log(failures ? `\n${failures} FALHA(S)` : "\nTodas as verificações OK");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
