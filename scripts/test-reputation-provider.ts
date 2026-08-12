/**
 * TEST — ReputationProvider contract + StubReputationProvider (PRD 5 / ADR-162 F1).
 * PURO, sem rede, sem DB, determinístico. Prova:
 *
 *   - registry resolve por nome → env `REPUTATION_PROVIDER` → 'stub' (default seguro);
 *   - o stub declara `capabilities` e a lista muda quando `canPublish=false` (§6);
 *   - listNewItems é incremental (respeita `since`), pagina por cursor e devolve
 *     `nextCursor` (§70) — nunca varre histórico inteiro;
 *   - getItem/getStatus/getReplies (réplica de consumidor no mesmo item — §31/Golden 6);
 *   - publishReply é idempotente (mesma idempotencyKey → duplicate, nunca 2× — §30/§71);
 *   - DEGRADAÇÃO explícita: provider sem capacidade de publicar → manual_required,
 *     NUNCA finge que publicou (§6/§8);
 *   - determinismo: mesma entrada → mesma saída.
 *
 * Uso: npm run test:reputation-provider
 */
let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const mod = await import("../src/server/ReputationProvider.js");
  const { getReputationProvider, StubReputationProvider } = mod;

  // ═══════════════ 1. registry / resolução ═══════════════
  check("1.1 default resolve pro stub", getReputationProvider().name === "stub");
  check("1.2 nome desconhecido cai no stub (default seguro)", getReputationProvider("nao_existe").name === "stub");
  process.env.REPUTATION_PROVIDER = "stub";
  check("1.3 env REPUTATION_PROVIDER respeitado", getReputationProvider().name === "stub");
  delete process.env.REPUTATION_PROVIDER;

  const p = new StubReputationProvider();

  // ═══════════════ 2. capabilities (§6) ═══════════════
  const caps = p.capabilities;
  check("2.1 stub declara as 5 capacidades", ["list", "getItem", "publishReply", "getReplies", "getStatus"].every((c) => caps.includes(c as any)));
  const ro = new StubReputationProvider({ canPublish: false });
  check("2.2 canPublish=false remove 'publishReply' das capacidades", !ro.capabilities.includes("publishReply") && ro.capabilities.includes("list"));

  // ═══════════════ 3. listNewItems incremental + cursor (§70) ═══════════════
  const all = await p.listNewItems({});
  check("3.1 lista os 3 itens do dataset", all.items.length === 3);
  // RA-1002 tem updatedAt 08-07, RA-1003 08-08 → ordem por updatedAt: 1001,1002,1003.
  check("3.2 ordem por updatedAt asc", all.items.map((i: any) => i.externalId).join(",") === "RA-1001,RA-1002,RA-1003");
  check("3.3 sem nextCursor quando cabe tudo", all.nextCursor == null);
  const inc = await p.listNewItems({ since: "2026-08-06T00:00:00Z" });
  check("3.4 since filtra incremental (só itens atualizados depois)", inc.items.map((i: any) => i.externalId).join(",") === "RA-1002,RA-1003");
  const page1 = await p.listNewItems({ limit: 2 });
  check("3.5 paginação: página 1 tem 2 itens + nextCursor", page1.items.length === 2 && page1.nextCursor === "2");
  const page2 = await p.listNewItems({ limit: 2, cursor: page1.nextCursor });
  check("3.6 paginação: página 2 completa e encerra (nextCursor null)", page2.items.length === 1 && page2.items[0].externalId === "RA-1003" && page2.nextCursor == null);

  // ═══════════════ 4. getItem / getStatus ═══════════════
  const item = await p.getItem("RA-1001");
  check("4.1 getItem devolve o item verbatim (com orderRef pra identity)", !!item && item.orderRef === "48391" && item.content.includes("48391"));
  check("4.2 getItem inexistente → null", (await p.getItem("RA-9999")) === null);
  check("4.3 getStatus conhecido", (await p.getStatus("RA-1002")) === "answered");
  check("4.4 getStatus inexistente → unknown", (await p.getStatus("RA-9999")) === "unknown");

  // ═══════════════ 5. getReplies (réplica de consumidor — §31 / Golden 6) ═══════════════
  const replies = await p.getReplies("RA-1002");
  check("5.1 item tem resposta da empresa + réplica do consumidor", replies.length === 2 && replies[0].authorType === "company" && replies[1].authorType === "consumer");
  check("5.2 item sem réplica → []", (await p.getReplies("RA-1001")).length === 0);

  // ═══════════════ 6. publishReply idempotente (§30/§71) ═══════════════
  const r1 = await p.publishReply({ itemExternalId: "RA-1001", content: "Vamos reenviar seu pedido.", idempotencyKey: "case-1:reply-1" });
  check("6.1 1ª publicação: published + externalReplyId determinístico", r1.status === "published" && r1.externalReplyId === "stub-reply:RA-1001:case-1:reply-1");
  const r2 = await p.publishReply({ itemExternalId: "RA-1001", content: "Vamos reenviar seu pedido.", idempotencyKey: "case-1:reply-1" });
  check("6.2 mesma idempotencyKey → duplicate (nunca publica 2×)", r2.status === "duplicate");

  // ═══════════════ 7. degradação explícita quando falta capacidade (§6/§8) ═══════════════
  const deg = await ro.publishReply({ itemExternalId: "RA-1001", content: "x", idempotencyKey: "k" });
  check("7.1 provider sem publishReply → manual_required (não finge publicar)", deg.status === "manual_required" && !deg.externalReplyId);

  // ═══════════════ 8. determinismo (mesma entrada → mesma saída) ═══════════════
  const a = await new StubReputationProvider().listNewItems({ since: "2026-08-06T00:00:00Z" });
  const b = await new StubReputationProvider().listNewItems({ since: "2026-08-06T00:00:00Z" });
  check("8.1 listNewItems determinístico", JSON.stringify(a) === JSON.stringify(b));

  console.log("\n=== TEST: ReputationProvider (PRD 5 F1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ ReputationProvider F1 OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
