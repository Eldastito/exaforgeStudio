/**
 * TEST — GestorCommandService / WhatsApp gestão (Epic 3, fatia 1).
 * Autenticação do número + parser + RBAC (só leitura); ações são diferidas.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:gestor-command
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gestor-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-gestor-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { GestorCommandService: G } = await import("../src/server/GestorCommandService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const mkUser = (org: string, phone: string, role: string, profileKey?: string) => {
    const id = randomUUID();
    const profId = profileKey ? (db.prepare("SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?").get(org, profileKey) as any)?.id : null;
    db.prepare("INSERT INTO users (id, organization_id, name, email, phone, role, role_profile_id, global_status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')")
      .run(id, org, `U ${role}`, `${id}@x.com`, phone, role, profId);
    return id;
  };
  const sigCount = (org: string, type: string) => (db.prepare("SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?").get(org, type) as any).n;

  const orgA = mkOrg();
  P.seedSystemProfiles(orgA);

  // ===== 1. Opt-in: desligado → não trata =====
  check("desligado: handled=false (webhook segue normal)", G.handle(orgA, "11999990001", "saldo").handled === false);
  db.prepare("UPDATE organization_settings SET wa_gestor_enabled = 1 WHERE organization_id = ?").run(orgA);
  check("isEnabled reflete o flag", G.isEnabled(orgA) === true);

  // ===== 2. Parser determinístico =====
  check("parse 'saldo'", G.parse("saldo").intent === "saldo");
  check("parse 'quanto tenho em caixa?'", G.parse("quanto tenho em caixa?").intent === "saldo");
  check("parse 'a receber'", G.parse("a receber").intent === "a_receber");
  check("parse 'contas a pagar'", G.parse("contas a pagar").intent === "a_pagar");
  check("parse 'o que devo atacar hoje'", G.parse("o que devo atacar hoje").intent === "prioridades");
  check("parse 'aprovar 1' = intent aprovar (índice 1)", G.parse("aprovar 1").intent === "aprovar" && G.parse("aprovar 1").index === 1);
  check("parse 'delegar 2' = ação diferida", G.parse("delegar 2").intent === "acao_diferida");
  check("parse 'oi' = menu", G.parse("oi").intent === "menu");
  check("parse 'asdf' = desconhecido", G.parse("asdf").intent === "desconhecido");

  // ===== 3. Número desconhecido é recusado =====
  const unk = G.handle(orgA, "11888880000", "saldo");
  check("número desconhecido: recusado, sem usuário", unk.handled === true && unk.user === null && /não reconhe/i.test(unk.reply));

  // ===== 4. Owner (perfil) consulta finanças — autenticação por DDI/9º dígito =====
  mkUser(orgA, "11999990001", "owner", "owner");
  const saldo = G.handle(orgA, "5511999990001", "saldo"); // com DDI 55 → casa pelo phoneMatch
  check("owner: 'saldo' autentica por DDI e responde caixa", saldo.handled === true && !saldo.denied && saldo.intent === "saldo" && /Caixa atual/.test(saldo.reply));
  check("comando do gestor é auditado (WA_GESTOR_COMMAND)", sigCount(orgA, "WA_GESTOR_COMMAND") >= 1);

  // ===== 5. RBAC: vendedor NÃO vê finanças (aceite do PRD) =====
  mkUser(orgA, "11999990002", "agent", "vendedor");
  const deny = G.handle(orgA, "11999990002", "saldo");
  check("vendedor: consulta financeira NEGADA", deny.handled === true && deny.denied === true && /permiss/i.test(deny.reply));
  check("negação financeira é auditada (WA_FINANCE_DENIED)", sigCount(orgA, "WA_FINANCE_DENIED") >= 1);
  check("vendedor: prioridades também negadas", G.handle(orgA, "11999990002", "prioridades").denied === true);

  // ===== 6. Fallback legado (sem perfil): papel decide =====
  const orgB = mkOrg();
  db.prepare("UPDATE organization_settings SET wa_gestor_enabled = 1 WHERE organization_id = ?").run(orgB);
  mkUser(orgB, "11777770001", "owner");            // sem perfil → fallback owner = full
  mkUser(orgB, "11777770002", "agent");            // sem perfil → fallback atendente = none
  check("legado owner vê saldo", G.handle(orgB, "11777770001", "saldo").denied !== true);
  check("legado agent NÃO vê saldo", G.handle(orgB, "11777770002", "saldo").denied === true);

  // ===== 7. Delegar/adiar/explicar ainda são DIFERIDAS =====
  const acao = G.handle(orgA, "11999990001", "delegar 2 para Ana");
  check("delegar ainda diferido: aponta o Plano de Ação", acao.intent === "acao_diferida" && /Plano de Ação/i.test(acao.reply));

  // ===== 8. Menu / desconhecido =====
  check("owner: 'oi' devolve o menu do Controller", /Controller IA/.test(G.handle(orgA, "11999990001", "oi").reply));
  check("owner: 'prioridades' responde (sem sinais → aviso)", G.handle(orgA, "11999990001", "prioridades").intent === "prioridades");

  // ===== 9. Roteamento no webhook (shouldRoute) — Fatia 2 =====
  check("roteia 'saldo' de gestor conhecido p/ o Controller", G.shouldRoute(G.handle(orgA, "11999990001", "saldo")) === true);
  check("roteia 'aprovar 1' (ação diferida)", G.shouldRoute(G.handle(orgA, "11999990001", "aprovar 1")) === true);
  check("NÃO roteia 'oi' (menu → Coordenador/tarefas)", G.shouldRoute(G.handle(orgA, "11999990001", "oi")) === false);
  check("NÃO roteia desconhecido (→ Coordenador)", G.shouldRoute(G.handle(orgA, "11999990001", "qualquer coisa")) === false);
  check("NÃO roteia número desconhecido (sem user)", G.shouldRoute(G.handle(orgA, "11888880000", "saldo")) === false);
  check("roteia denial de vendedor (Controller responde a negação)", G.shouldRoute(G.handle(orgA, "11999990002", "saldo")) === true);
  // 'prioridades' não sequestra pergunta de tarefas do colaborador.
  check("'o que tenho pra fazer hoje' NÃO vira prioridades", G.parse("o que tenho pra fazer hoje").intent === "desconhecido");
  check("desligado: shouldRoute=false (webhook segue p/ Coordenador)", G.shouldRoute(G.handle(mkOrg(), "11999990001", "saldo")) === false);

  // ===== 10. Ações governadas por WhatsApp (Fatia 3) =====
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  // owner (admin role) na orgA já existe (11999990001, role 'owner').
  const c1 = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar R$ 4.200", expectedImpact: 4200 });
  const c2 = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar R$ 800", expectedImpact: 800 });
  const listReply = G.handle(orgA, "11999990001", "aprovações");
  check("aprovações: lista numerada as pendências", listReply.intent === "aprovacoes" && /1\..*4\.200/.test(listReply.reply) && /2\./.test(listReply.reply));
  check("roteia 'aprovações' no webhook", G.shouldRoute(listReply) === true);
  const okApprove = G.handle(orgA, "11999990001", "aprovar 1");
  check("aprovar 1: single aprova a ação", okApprove.intent === "aprovar" && /Aprovada/.test(okApprove.reply) && D.get(orgA, c1.id).status === "approved");
  check("aprovar de novo: já resolvida → aviso, nada muda", /não está mais disponível/i.test(G.handle(orgA, "11999990001", "aprovar 1").reply));
  const okReject = G.handle(orgA, "11999990001", "dispensar 2");
  check("dispensar 2: rejeita a ação", /Dispensada/.test(okReject.reply) && D.get(orgA, c2.id).status === "rejected");
  check("índice inválido → aviso sem efeito", /Não achei/i.test(G.handle(orgA, "11999990001", "aprovar 9").reply));

  // Vendedor (agent) NÃO opera aprovações.
  check("vendedor não vê aprovações", G.handle(orgA, "11999990002", "aprovações").denied === true);
  check("vendedor não aprova", G.handle(orgA, "11999990002", "aprovar 1").denied === true);

  // two_step: 1ª aprovação do owner ainda aguarda 2º aprovador distinto.
  const sup = D.propose(orgA, { domain: "procurement", actionType: "choose_supplier", title: "Fornecedor X", expectedImpact: 30000 });
  G.handle(orgA, "11999990001", "aprovações");
  const twoStep = G.handle(orgA, "11999990001", `aprovar ${D.list(orgA, { status: "awaiting_approval" }).findIndex((a: any) => a.id === sup.id) + 1}`);
  check("two_step: 1ª aprovação registra mas ainda aguarda", /falta outra aprova/i.test(twoStep.reply) && D.get(orgA, sup.id).status === "awaiting_approval");

  // approval_role: change_price exige owner; admin não aprova.
  const orgR = mkOrg();
  db.prepare("UPDATE organization_settings SET wa_gestor_enabled = 1 WHERE organization_id = ?").run(orgR);
  mkUser(orgR, "11666660001", "admin");
  const cp = D.propose(orgR, { domain: "sales", actionType: "change_price", title: "Mudar preço" });
  G.handle(orgR, "11666660001", "aprovações");
  check("admin NÃO aprova change_price (exige owner)", G.handle(orgR, "11666660001", "aprovar 1").denied === true && D.get(orgR, cp.id).status === "awaiting_approval");

  // Roteamento inclui os novos intents.
  check("roteia 'aprovar 1' e 'dispensar 2'", G.shouldRoute(G.handle(orgA, "11999990001", "aprovar 1")) === true && G.shouldRoute(G.handle(orgA, "11999990001", "dispensar 1")) === true);

  // ===== 11. Isolamento por organização =====
  check("isolamento: número de A não é reconhecido em B", G.handle(orgB, "11999990001", "saldo").user === null);

  console.log("\n=== TEST: GestorCommandService (Epic 3 — fatia 1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Gestor Command OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
