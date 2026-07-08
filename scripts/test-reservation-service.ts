/**
 * TEST — ReservationService (ADR-061).
 *
 * Reservas é onde overbooking dói fisicamente: cliente chega ao hotel com o
 * PIX pago e não tem quarto. Um bug no availability = churn instantâneo.
 * Um bug no isolamento por org = reserva de A aparece na agenda de B.
 * Um bug em ratedTotal com override de PMS = preço na conversa ≠ na cobrança.
 *
 * Cobertura:
 *  - Recursos: create, get, list, importResources idempotente, matchResource fuzzy.
 *  - periods: cálculo por unidade (night/day/hour/slot).
 *  - daysInRange: range de datas em TZ SP para diárias.
 *  - availability: capacidade, sobreposição, check-out mesmo instante NÃO conflita,
 *    período inválido, resource_availability override reduz teto.
 *  - create atômico: transação previne overbooking, respeita units, calcula
 *    total considerando override de preço por data.
 *  - Fluxo: markPaid confirma, updateStatus com whitelist.
 *  - Isolamento por org em TODAS as queries.
 *
 * Uso: npm run test:reservation-service
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-reservation-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-reservation-1234567890ab";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ReservationService } = await import("../src/server/ReservationService.js");

  // Setup
  const orgA = `org_A_${randomUUID().slice(0, 6)}`;
  const orgB = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, reservation_deposit_percent) VALUES (?, ?, ?, 'active', 20)`).run(randomUUID(), orgA, "Pousada A");
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), orgB, "Pousada B");
  const chA = randomUUID();
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, status) VALUES (?, ?, 'evolution', 'canal A', 'active')`).run(chA, orgA);
  const contactA = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(contactA, orgA, chA, "Alice", "5511911110000");

  // ==== 1. createResource + getResource + listResources ====
  console.log("\n=== 1. Recursos — create/get/list ===");
  const suite = ReservationService.createResource(orgA, { name: "Suite Master", price: 500, capacity: 2, reservationUnit: "night" });
  check("1.1 createResource retorna id", typeof suite.id === "string" && suite.id.length >= 32);
  const suiteRow = ReservationService.getResource(orgA, suite.id);
  check("1.2 getResource devolve o recurso", !!suiteRow && suiteRow.name === "Suite Master" && suiteRow.capacity === 2);

  // Unit inválida cai para night
  const bogus = ReservationService.createResource(orgA, { name: "Bogus", reservationUnit: "invalid" });
  const bogusRow = ReservationService.getResource(orgA, bogus.id);
  check("1.3 unit inválida normaliza para 'night'", bogusRow.reservation_unit === "night");

  // Capacity <= 0 normaliza para 1
  const cap0 = ReservationService.createResource(orgA, { name: "Cap0", capacity: 0 });
  const cap0Row = ReservationService.getResource(orgA, cap0.id);
  check("1.4 capacity <= 0 normaliza para 1", cap0Row.capacity === 1);

  const list = ReservationService.listResources(orgA);
  check("1.5 listResources devolve os recursos criados", list.length === 3);

  check("1.6 orgB não vê recursos de orgA (isolamento)", ReservationService.listResources(orgB).length === 0);
  check("1.7 getResource cross-org retorna null", ReservationService.getResource(orgB, suite.id) === null);

  // ==== 2. periods ====
  console.log("\n=== 2. periods (cálculo por unidade) ===");
  check("2.1 2 diárias (14h→14h no próximo dia +1)", ReservationService.periods("2027-05-01T14:00:00-03:00", "2027-05-03T14:00:00-03:00", "night") === 2);
  check("2.2 hourly (3h)", ReservationService.periods("2027-05-01T14:00:00-03:00", "2027-05-01T17:00:00-03:00", "hour") === 3);
  check("2.3 slot = 1", ReservationService.periods("2027-05-01T14:00:00-03:00", "2027-05-01T15:00:00-03:00", "slot") === 1);
  check("2.4 end <= start retorna 0", ReservationService.periods("2027-05-03T14:00:00-03:00", "2027-05-01T14:00:00-03:00", "night") === 0);

  // ==== 3. daysInRange (TZ SP) ====
  console.log("\n=== 3. daysInRange ===");
  const days = ReservationService.daysInRange("2027-05-01T14:00:00-03:00", "2027-05-03T12:00:00-03:00");
  check("3.1 range 3 dias cobre 2 diárias (01, 02)", Array.isArray(days) && days.length === 2 && days[0] === "2027-05-01" && days[1] === "2027-05-02");
  const dayUse = ReservationService.daysInRange("2027-05-01T10:00:00-03:00", "2027-05-01T18:00:00-03:00");
  check("3.2 day-use no mesmo dia retorna [dia]", dayUse.length === 1 && dayUse[0] === "2027-05-01");
  check("3.3 range inválido retorna []", ReservationService.daysInRange("2027-05-03", "2027-05-01").length === 0);

  // ==== 4. availability ====
  console.log("\n=== 4. availability ===");
  const av0 = ReservationService.availability(orgA, suite.id, "2027-05-01T14:00:00-03:00", "2027-05-03T12:00:00-03:00");
  check("4.1 sem reservas: capacity=2 livres=2 bookable=true", av0.capacity === 2 && av0.livres === 2 && av0.bookable === true);

  const badPeriod = ReservationService.availability(orgA, suite.id, "2027-05-03", "2027-05-01");
  check("4.2 período inválido retorna reason=invalid_period", badPeriod.ok === false && badPeriod.reason === "invalid_period");

  const noResource = ReservationService.availability(orgA, "nope", "2027-05-01", "2027-05-02");
  check("4.3 recurso inexistente retorna resource_not_found", noResource.reason === "resource_not_found");

  const cross = ReservationService.availability(orgB, suite.id, "2027-05-01T14:00:00-03:00", "2027-05-03T12:00:00-03:00");
  check("4.4 cross-org: recurso invisível", cross.reason === "resource_not_found");

  // ==== 5. create (atômica) + sobreposição ====
  console.log("\n=== 5. create + sobreposição ===");
  const r1 = ReservationService.create(orgA, {
    resourceId: suite.id, contactId: contactA,
    startAt: "2027-05-01T14:00:00-03:00", endAt: "2027-05-03T12:00:00-03:00",
    units: 1, adults: 2, children: 0
  });
  check("5.1 primeira reserva ok", typeof r1.id === "string");

  const av1 = ReservationService.availability(orgA, suite.id, "2027-05-01T14:00:00-03:00", "2027-05-03T12:00:00-03:00");
  check("5.2 após 1 unidade: ocupadas=1 livres=1", av1.ocupadas === 1 && av1.livres === 1);

  // Segunda reserva ainda cabe (capacity=2)
  const r2 = ReservationService.create(orgA, {
    resourceId: suite.id, contactId: contactA,
    startAt: "2027-05-01T14:00:00-03:00", endAt: "2027-05-03T12:00:00-03:00",
    units: 1
  });
  check("5.3 segunda reserva ok (dentro da capacity)", typeof r2.id === "string");

  const av2 = ReservationService.availability(orgA, suite.id, "2027-05-01T14:00:00-03:00", "2027-05-03T12:00:00-03:00");
  check("5.4 lotado: livres=0 bookable=false", av2.livres === 0 && av2.bookable === false);

  // Terceira tenta e falha (overbooking prevention)
  let overbookThrew = false;
  try {
    ReservationService.create(orgA, {
      resourceId: suite.id, startAt: "2027-05-01T14:00:00-03:00", endAt: "2027-05-03T12:00:00-03:00"
    });
  } catch (e: any) { overbookThrew = e.message === "no_availability"; }
  check("5.5 overbooking prevenido (throw no_availability)", overbookThrew);

  // Reserva CANCELADA libera vaga
  ReservationService.updateStatus(orgA, r2.id, "cancelled");
  const avAfterCancel = ReservationService.availability(orgA, suite.id, "2027-05-01T14:00:00-03:00", "2027-05-03T12:00:00-03:00");
  check("5.6 reserva cancelada libera vaga", avAfterCancel.livres === 1);

  // ==== 6. check-out no mesmo instante NÃO conflita ====
  console.log("\n=== 6. Check-out mesmo instante ===");
  // r1 vai até 2027-05-03T12:00:00-03:00. Nova reserva começa exatamente às 12:00 mesmo dia.
  const rBack = ReservationService.create(orgA, {
    resourceId: suite.id, startAt: "2027-05-03T12:00:00-03:00", endAt: "2027-05-05T12:00:00-03:00"
  });
  check("6.1 nova reserva começando na hora do checkout anterior é aceita", typeof rBack.id === "string");

  // ==== 7. Total = preço × diárias × unidades ====
  console.log("\n=== 7. Total e sinal ===");
  const rBase = db.prepare(`SELECT total_amount, deposit_amount FROM reservations WHERE id = ?`).get(r1.id) as any;
  // 2 diárias × 500 × 1 unidade = 1000
  check("7.1 total = preço × diárias × unidades = 1000", rBase.total_amount === 1000);
  // sinal 20% do total = 200
  check("7.2 sinal calculado (20% da org)", rBase.deposit_amount === 200);

  // ==== 8. Override de preço por data ====
  console.log("\n=== 8. Override PMS (price + availability) ===");
  const rPromo = ReservationService.createResource(orgA, { name: "Promo Room", price: 400, capacity: 1, reservationUnit: "night" });
  ReservationService.setAvailability(orgA, [
    { resource: rPromo.id, date: "2027-06-01", price: 250 },     // preço promocional
    { resource: rPromo.id, date: "2027-06-02", price: 250 },     // preço promocional
  ]);
  const rPromoRow = ReservationService.getResource(orgA, rPromo.id);
  const total = ReservationService.ratedTotal(orgA, rPromoRow, "2027-06-01T14:00:00-03:00", "2027-06-03T12:00:00-03:00", 1);
  check("8.1 ratedTotal usa override de preço por data (250 × 2 = 500)", total === 500);

  // Override de disponibilidade reduz capacity: dia bloqueado (available=0)
  ReservationService.setAvailability(orgA, [{ resource: rPromo.id, date: "2027-06-01", available: 0 }]);
  const avBlocked = ReservationService.availability(orgA, rPromo.id, "2027-06-01T14:00:00-03:00", "2027-06-03T12:00:00-03:00");
  check("8.2 override available=0 força bookable=false", avBlocked.capacity === 0 && avBlocked.bookable === false);

  // ==== 9. importResources idempotente ====
  console.log("\n=== 9. importResources ===");
  const importRes1 = ReservationService.importResources(orgA, [
    { name: "Chalé Beira Rio", price: 300, capacity: 3, unit: "night" },
    { name: "Chalé Mata", price: 250, capacity: 2, unit: "night" },
  ]);
  check("9.1 primeira importação cria 2", importRes1.created === 2 && importRes1.updated === 0);

  const importRes2 = ReservationService.importResources(orgA, [
    { name: "Chalé Beira Rio", price: 350, capacity: 3, unit: "night" }, // update preço
    { name: "Chalé Novo", price: 200, capacity: 1, unit: "night" },       // novo
  ]);
  check("9.2 segunda: 1 update + 1 create (idempotente)", importRes2.updated === 1 && importRes2.created === 1);
  const beiraRio = db.prepare(`SELECT price FROM products_services WHERE organization_id = ? AND lower(name) = 'chalé beira rio'`).get(orgA) as any;
  check("9.3 update aplicou novo preço", beiraRio.price === 350);

  check("9.4 rows vazias retorna zeros", ReservationService.importResources(orgA, []).created === 0);
  const withEmpty = ReservationService.importResources(orgA, [{ name: "  " }, { name: "Valid Item" }]);
  check("9.5 nome vazio é skipped", withEmpty.skipped === 1 && withEmpty.created === 1);

  // ==== 10. matchResource fuzzy ====
  console.log("\n=== 10. matchResource ===");
  const mExact = ReservationService.matchResource(orgA, "Suite Master");
  check("10.1 match exato", !!mExact && mExact.id === suite.id);
  const mPartial = ReservationService.matchResource(orgA, "master");
  check("10.2 match parcial ('master' → 'Suite Master')", !!mPartial && mPartial.id === suite.id);
  check("10.3 nome inexistente retorna null", ReservationService.matchResource(orgA, "não existe") === null);
  check("10.4 vazio retorna null", ReservationService.matchResource(orgA, "") === null);

  // ==== 11. markPaid + updateStatus ====
  console.log("\n=== 11. markPaid + updateStatus ===");
  check("11.1 markPaid retorna true", ReservationService.markPaid(orgA, r1.id) === true);
  const paidRow = db.prepare(`SELECT status, payment_status FROM reservations WHERE id = ?`).get(r1.id) as any;
  check("11.2 status vira 'confirmed' + payment_status 'paid'", paidRow.status === "confirmed" && paidRow.payment_status === "paid");
  check("11.3 markPaid de reserva inexistente retorna false", ReservationService.markPaid(orgA, "nope") === false);
  check("11.4 markPaid cross-org retorna false", ReservationService.markPaid(orgB, r1.id) === false);

  let statusThrew = false;
  try { ReservationService.updateStatus(orgA, r1.id, "bogus"); } catch { statusThrew = true; }
  check("11.5 updateStatus rejeita status fora da whitelist", statusThrew);

  // ==== 12. list ====
  console.log("\n=== 12. list ===");
  const allList = ReservationService.list(orgA);
  check("12.1 list da orgA devolve reservas", allList.length >= 3);
  check("12.2 filtro status=confirmed", ReservationService.list(orgA, { status: "confirmed" }).length >= 1);
  check("12.3 filtro por resource", ReservationService.list(orgA, { resourceId: suite.id }).length >= 2);
  check("12.4 orgB tem 0 reservas", ReservationService.list(orgB).length === 0);

  // ==== Relatório ====
  console.log("\n=========================================");
  console.log("RELATÓRIO — ReservationService (ADR-061)");
  console.log("=========================================");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  console.log("=========================================");
  console.log(`${results.length - failures}/${results.length} passaram`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.log(`❌ ${failures} falhas`); process.exit(1); }
  console.log("✅ Todos os testes passaram");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Teste explodiu:", e);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
