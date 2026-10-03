/**
 * TESTE — Fase 2 / F2.4 (ADR-203): "Executando" em 4 etapas (ExecutingBoardService + GET /api/ux/executing-board).
 * Prova: (1) org vazia → 4 lanes vazias, honesto; (2) ação aguardando aprovação que o usuário PODE aprovar → "Precisa de você";
 * ação falha → "Precisa de você" (falha é de 1ª classe); aprovada → "Em andamento"; (3) executada com confirmação pendente →
 * "Aguardando" (nunca "Concluído"); concluída → "Concluído" com a garantia dita (DONE ≠ RESULTADO: sem prova = "resultado ainda
 * não confirmado"); (4) missão e tarefa são o MESMO cartão, nas lanes certas; missões só gestor + Mission Layer ligado;
 * (5) tarefa de outra pessoa só para gestor; (6) dinheiro role-gated (vendedor: restricted, nunca o valor); (7) cada lane
 * traz no máximo 8 itens e o `total` real; (8) isolamento por org; (9) rota e tela ligadas. Determinístico, sem LLM.
 * Uso:  npm run test:executing-board
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-f24-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-executing-board-1234567890";

let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ExecutingBoardService: E, LANE_LIMIT } = await import("../src/server/ExecutingBoardService.js");
  const { MissionService: M } = await import("../src/server/MissionService.js");
  const { PermissionService: P } = await import("../src/server/PermissionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?,?,?,?)`).run(randomUUID(), id, id, "active"); P.seedSystemProfiles(id); return id; };
  const A = mkOrg(), EMPTY = mkOrg(), OTHER = mkOrg();
  const userFor = (org: string, key: string) => ({ userId: randomUUID(), id: randomUUID(), role_profile_id: (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id, role: key });
  const owner = userFor(A, "owner"), vendedor = userFor(A, "vendedor");

  // ── (1) vazia ──
  const empty = E.build(EMPTY, userFor(EMPTY, "owner"));
  check("org vazia: 4 lanes vazias e sem missões", (["needsYou", "running", "waiting", "done"] as const).every(k => empty.lanes[k].total === 0 && empty.lanes[k].items.length === 0) && empty.missionsAvailable === false);

  // ── ações ──
  const act = (org: string, title: string, status: string, o: { corr?: string; amount?: number; completed?: string } = {}) => { const id = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, title, status, approval_policy, created_by, priority_score, expected_impact, impact_unit, correlation_id, completed_at) VALUES (?,?, 'sales', 'refund', ?, ?, 'single', 'rule', 10, ?, 'BRL', ?, ?)`).run(id, org, title, status, o.amount ?? null, o.corr ?? null, o.completed ?? null); return id; };
  const aAprov = act(A, "Aprovar reembolso do pedido 41", "awaiting_approval", { amount: 800 });
  const aFail = act(A, "Cobrança enviada falhou", "failed");
  const aApproved = act(A, "Enviar campanha de reativação", "approved");
  const aWait = act(A, "Cobrar boleto da Maria", "done", { completed: new Date().toISOString().replace("T", " ").slice(0, 19) });
  db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status) VALUES (?,?,?, 'asaas_payment_webhook', 'pending')`).run(randomUUID(), A, aWait);
  const aDone = act(A, "Reajustar preço da coleção", "done", { completed: new Date().toISOString().replace("T", " ").slice(0, 19) });
  const aOld = act(A, "Ação antiga", "done", { completed: "2020-01-01 10:00:00" });
  void aOld;

  let b = E.build(A, owner);
  const titles = (l: keyof typeof b.lanes) => b.lanes[l].items.map(i => i.title);
  check("decisão que o dono pode aprovar → 'Precisa de você'", titles("needsYou").includes("Aprovar reembolso do pedido 41"), JSON.stringify(titles("needsYou")));
  const failedItem = b.lanes.needsYou.items.find(i => i.title === "Cobrança enviada falhou");
  check("falha é de 1ª classe: vai pra 'Precisa de você' com estado 'Falhou'", failedItem?.state === "Falhou" && failedItem?.tone === "failed");
  check("aprovada → 'Em andamento' (Aprovado — pronto)", b.lanes.running.items.some(i => i.title === "Enviar campanha de reativação" && /Aprovado/.test(i.state)));
  check("executada com confirmação pendente → 'Aguardando', NUNCA 'Concluído'", titles("waiting").includes("Cobrar boleto da Maria") && !titles("done").includes("Cobrar boleto da Maria"));
  const dn = b.lanes.done.items.find(i => i.title === "Reajustar preço da coleção");
  check("concluída sem prova de resultado: diz 'resultado ainda não confirmado' (DONE ≠ RESULTADO)", !!dn && /não confirmado|sem como confirmar/.test(dn.assurance?.label || ""), JSON.stringify(dn?.assurance));
  check("concluída há mais de 7 dias fica fora de 'Concluído'", !titles("done").includes("Ação antiga"));
  void aAprov; void aFail; void aApproved; void aDone;

  // ── processo por objetivo (running) + dedupe da ação aprovada do mesmo fio ──
  const cid = `corr-${randomUUID().slice(0, 6)}`;
  act(A, "Plano de recuperação de clientes", "approved", { corr: cid });
  db.prepare(`INSERT INTO process_instances (id, organization_id, process_definition_id, process_type, status, expected_value, correlation_id, started_at) VALUES (?,?, 'def', 'cobranca', 'executing', 500, ?, CURRENT_TIMESTAMP)`).run(randomUUID(), A, cid);
  b = E.build(A, owner);
  check("objetivo com processo ativo aparece em andamento; a ação aprovada do MESMO fio não duplica", b.lanes.running.items.some(i => i.kind === "objective") && b.lanes.running.items.filter(i => i.title === "Plano de recuperação de clientes").length === 1 && !b.lanes.running.items.some(i => i.kind === "action" && i.title === "Plano de recuperação de clientes"));

  // ── missão + tarefa: mesmo cartão ──
  check("sem Mission Layer: missões não aparecem", b.missionsAvailable === false && !b.lanes.running.items.some(i => i.kind === "mission"));
  M.setEnabled(A, true);
  const m1 = M.create(A, { title: "Reativar 50 clientes inativos", desiredState: "50 clientes voltam a comprar" }); M.setStatus(A, m1.id, "running");
  const m2 = M.create(A, { title: "Abrir loja nova em Bangu" }); M.setStatus(A, m2.id, "waiting_approval");
  const m3 = M.create(A, { title: "Bater meta de outubro" }); M.setStatus(A, m3.id, "blocked");
  b = E.build(A, owner);
  check("Mission Layer ligado + dono: missões nas lanes certas (andamento / precisa de você / aguardando)",
    b.missionsAvailable === true && b.lanes.running.items.some(i => i.title === "Reativar 50 clientes inativos" && i.kind === "mission") && b.lanes.needsYou.items.some(i => i.title === "Abrir loja nova em Bangu") && b.lanes.waiting.items.some(i => i.title === "Bater meta de outubro"));
  const tk = (title: string, status: string, who: string | null, due: string | null = null) => db.prepare(`INSERT INTO tasks (id, organization_id, title, assigned_to, status, due_at) VALUES (?,?,?,?,?,?)`).run(randomUUID(), A, title, who, status, due);
  tk("Ligar para o fornecedor", "fazendo", owner.userId); tk("Conferir estoque da Bangu", "a_fazer", vendedor.userId, "2020-01-01 10:00:00"); tk("Tarefa de outra pessoa", "a_fazer", randomUUID());
  b = E.build(A, owner);
  check("tarefa 'fazendo' → Em andamento; 'a fazer' → Aguardando (Na fila) com 'Prazo vencido'", b.lanes.running.items.some(i => i.title === "Ligar para o fornecedor" && i.kind === "task") && b.lanes.waiting.items.some(i => i.title === "Conferir estoque da Bangu" && /vencido/i.test(i.detail || "")));
  check("missão e tarefa usam o MESMO formato de cartão (mesmos campos)", JSON.stringify(Object.keys(b.lanes.running.items.find(i => i.kind === "task")!).sort()) === JSON.stringify(Object.keys(b.lanes.running.items.find(i => i.kind === "mission")!).sort()));

  // ── (5)(6) papel ──
  const sv = E.build(A, vendedor);
  check("vendedor: só as tarefas DELE; sem missões; sem a tarefa de outra pessoa", sv.missionsAvailable === false && !sv.lanes.running.items.some(i => i.kind === "mission") && sv.lanes.waiting.items.some(i => i.title === "Conferir estoque da Bangu") && !sv.lanes.waiting.items.some(i => i.title === "Tarefa de outra pessoa" || i.title === "Ligar para o fornecedor"));
  check("dono vê a tarefa de outra pessoa", b.lanes.waiting.items.some(i => i.title === "Tarefa de outra pessoa"));
  const money = b.lanes.needsYou.items.find(i => i.title === "Aprovar reembolso do pedido 41")?.impact;
  check("dono vê o impacto em R$", money?.restricted === false && money?.amount === 800, JSON.stringify(money));
  const svMoney = sv.lanes.needsYou.items.concat(sv.lanes.waiting.items).find(i => i.title === "Aprovar reembolso do pedido 41")?.impact;
  check("vendedor nunca recebe o valor (se vê o item, vem 'restricted')", !svMoney || (svMoney.restricted === true && svMoney.amount === null), JSON.stringify(svMoney));

  // ── (7) teto por lane ──
  for (let i = 0; i < 12; i++) tk(`Tarefa extra ${i}`, "a_fazer", owner.userId);
  b = E.build(A, owner);
  check(`cada lane traz no máx ${LANE_LIMIT} itens e o total real`, b.lanes.waiting.items.length === LANE_LIMIT && b.lanes.waiting.total > LANE_LIMIT, `${b.lanes.waiting.items.length}/${b.lanes.waiting.total}`);

  // ── (8) isolamento ──
  const ot = E.build(OTHER, userFor(OTHER, "owner"));
  check("isolamento: outra org não vê nada da org A", (["needsYou", "running", "waiting", "done"] as const).every(k => ot.lanes[k].total === 0));

  // ── (9) fiação ──
  const ux = fs.readFileSync("src/server/routes/ux.ts", "utf8");
  check("rota GET /api/ux/executing-board montada", /router\.get\("\/executing-board"/.test(ux));
  check("App renderiza ExecutingView no viewMode 'executando'", /viewMode === 'executando' && <ExecutingView \/>/.test(fs.readFileSync("src/App.tsx", "utf8")));

  console.log(failures === 0 ? "\nTODOS OS CHECKS PASSARAM" : `\n${failures} FALHA(S)`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
