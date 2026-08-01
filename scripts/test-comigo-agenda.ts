/**
 * TEST — Comigo/Agenda (arquétipo agenda: unhas, cabelo, etc — ADR-088 D1).
 *
 * Uso: npm run test:comigo-agenda
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-agenda-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-agenda-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoAgendaService: A } = await import("../src/server/ComigoAgendaService.js");
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");

  // ===== Setup: 2 organizações (isolamento) + serviços =====
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Salão A', 'active')`).run(randomUUID(), orgId);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Salão B', 'active')`).run(randomUUID(), other);

  // Serviço com ficha de preço (labor_minutes=45) — a agenda deve herdar duração.
  const svcId = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'service', 'Corte + escova', 60, 1)`).run(svcId, orgId);
  const recipeId = randomUUID();
  db.prepare(`INSERT INTO comigo_recipes (id, organization_id, product_id, name, kind, labor_minutes) VALUES (?, ?, ?, 'Corte + escova', 'servico', 45)`).run(recipeId, orgId, svcId);

  // Serviço SEM ficha — usa duração default (30 min).
  const svcNoRecipe = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'service', 'Manicure', 45, 1)`).run(svcNoRecipe, orgId);

  // ===== 1. defaultDuration =====
  check("defaultDuration usa labor_minutes da recipe", A.defaultDuration(orgId, svcId) === 45);
  check("defaultDuration cai no piso (30) quando não há recipe", A.defaultDuration(orgId, svcNoRecipe) === 30);
  check("defaultDuration cai no piso quando produto não existe", A.defaultDuration(orgId, "nao_existe") === 30);
  check("defaultDuration sem product retorna piso", A.defaultDuration(orgId) === 30);

  // ===== 2. ensureContact reusa o canal do Balcão =====
  const cid = A.ensureContact(orgId, "Maria da Silva", "5511988887777");
  check("ensureContact criou contato", !!cid);
  const cid2 = A.ensureContact(orgId, "Maria da Silva", "5511988887777");
  check("ensureContact é idempotente por telefone", cid === cid2);
  // O Balcão vê o mesmo contato (canal sintético 'balcao' compartilhado).
  const cidBalcao = B.ensureFiadoContact(orgId, "Maria da Silva", "5511988887777");
  check("ensureContact compartilha canal com o Balcão", cid === cidBalcao);

  // ===== 3. Criação — happy path =====
  const dateISO = "2026-09-01";
  const startISO = `${dateISO}T14:00:00.000Z`;
  const r1 = A.create(orgId, {
    contact_name: "Ana Bela", contact_phone: "5511900001111",
    product_service_id: svcId, scheduled_start: startISO,
  }) as any;
  check("create ok", r1.ok === true && !!r1.id);

  const one = A.get(orgId, r1.id);
  check("get retorna o agendamento", !!one);
  check("duração herdada da ficha (45 min)", one?.duration_minutes === 45);
  check("status inicial = 'confirmed'", one?.status === "confirmed");
  check("título default vem do produto", one?.title === "Corte + escova");
  check("product_name hidratado", one?.product_name === "Corte + escova");
  check("contact_name hidratado", one?.contact_name === "Ana Bela");

  // ===== 4. Sem cliente identificado falha =====
  const rNoContact = A.create(orgId, { scheduled_start: startISO } as any) as any;
  check("sem contato falha", rNoContact.ok === false && rNoContact.error === "contact_required");

  // ===== 5. scheduled_start inválido falha =====
  const rBadStart = A.create(orgId, { contact_name: "X", contact_phone: "1", scheduled_start: "não-é-data" } as any) as any;
  check("start inválido falha", rBadStart.ok === false && rBadStart.error === "invalid_scheduled_start");

  // ===== 6. Conflito de horário =====
  // Novo agendamento sobrepondo o primeiro (14:00 + 45min → 14:45; 14:30 colide).
  const overlapISO = `${dateISO}T14:30:00.000Z`;
  const rConflict = A.create(orgId, {
    contact_name: "Bia", contact_phone: "5511900002222",
    product_service_id: svcId, scheduled_start: overlapISO,
  }) as any;
  check("conflito detectado", rConflict.ok === false && rConflict.error === "CONFLICT");
  check("conflict traz o agendamento colidente", Array.isArray(rConflict.conflicts) && rConflict.conflicts[0]?.id === r1.id);

  // ===== 7. force=true bypassa o conflito =====
  const rForced = A.create(orgId, {
    contact_name: "Bia", contact_phone: "5511900002222",
    product_service_id: svcId, scheduled_start: overlapISO, force: true,
  }) as any;
  check("force=true cria mesmo com conflito", rForced.ok === true && !!rForced.id);

  // ===== 8. Sem sobreposição = sem conflito =====
  const laterISO = `${dateISO}T16:00:00.000Z`;
  const rLater = A.create(orgId, {
    contact_name: "Carla", contact_phone: "5511900003333",
    product_service_id: svcNoRecipe, scheduled_start: laterISO,
  }) as any;
  check("horário livre → ok", rLater.ok === true);
  const later = A.get(orgId, rLater.id);
  check("duração default (30) quando sem recipe", later?.duration_minutes === 30);

  // ===== 9. listForDay traz só o dia certo =====
  const items = A.listForDay(orgId, dateISO);
  check("listForDay traz os 3 agendamentos do dia", items.length === 3);
  check("listForDay ordena por scheduled_start ASC", items[0].id === r1.id && items[items.length - 1].id === rLater.id);
  const outraData = A.listForDay(orgId, "2026-09-02");
  check("outro dia = vazio", outraData.length === 0);

  // ===== 10. counts =====
  const c = A.counts(orgId, dateISO);
  check("counts.today = 3", c.today === 3);

  // ===== 11. Cancelamento preserva histórico =====
  check("cancel ok", A.cancel(orgId, rLater.id, "cliente pediu") === true);
  const laterCanc = A.get(orgId, rLater.id);
  check("status virou 'cancelled'", laterCanc?.status === "cancelled");
  check("motivo persistido", laterCanc?.cancellation_reason === "cliente pediu");
  check("cancel idempotente", A.cancel(orgId, rLater.id, "de novo") === true);
  // Cancelado sai da fila de conflitos, então dá pra remarcar no mesmo horário.
  const rRebook = A.create(orgId, {
    contact_name: "Dani", contact_phone: "5511900004444",
    product_service_id: svcNoRecipe, scheduled_start: laterISO,
  }) as any;
  check("cancelado libera o horário", rRebook.ok === true);

  // ===== 12. Completar =====
  check("complete ok", A.complete(orgId, r1.id) === true);
  const done = A.get(orgId, r1.id);
  check("status = 'completed'", done?.status === "completed");
  check("complete depois de cancelado falha", A.complete(orgId, rLater.id) === false);

  // ===== 13. No-show =====
  check("markNoShow ok", A.markNoShow(orgId, rForced.id) === true);
  check("status = 'no_show'", A.get(orgId, rForced.id)?.status === "no_show");
  check("no-show em cancelado falha", A.markNoShow(orgId, rLater.id) === false);

  // ===== 14. Isolamento multi-tenant =====
  // Cria agendamento na outra org no MESMO horário — não conflita.
  const rOther = A.create(other, {
    contact_name: "Fulano Salão B", contact_phone: "5511911112222",
    scheduled_start: startISO,
  }) as any;
  check("outra org não vê conflito (isolamento)", rOther.ok === true);
  // listForDay da orgId NÃO devolve o da outra org.
  const isolated = A.listForDay(orgId, dateISO).map((i) => i.id);
  check("listForDay isolado por org", !isolated.includes(rOther.id));
  // get da orgId no id da outra org = null
  check("get cross-tenant devolve null", A.get(orgId, rOther.id) === null);
  // cancel cross-tenant = false
  check("cancel cross-tenant = false", A.cancel(orgId, rOther.id) === false);

  // ===== 15. contact_id direto (sem nome/telefone) =====
  const existingContact = A.ensureContact(orgId, "Recorrente", "5511922223333");
  const rByCid = A.create(orgId, {
    contact_id: existingContact,
    product_service_id: svcNoRecipe, scheduled_start: `${dateISO}T18:00:00.000Z`,
  }) as any;
  check("create por contact_id ok", rByCid.ok === true);

  // contact_id inexistente falha
  const rBadCid = A.create(orgId, { contact_id: "nao_existe", scheduled_start: startISO } as any) as any;
  check("contact_id inexistente falha", rBadCid.ok === false && rBadCid.error === "contact_not_found");

  // ===== Sumário =====
  console.log(`\n=== Comigo/Agenda ===`);
  for (const r of results) console.log(`  ${r.ok ? "✔" : "✘"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} pass`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
