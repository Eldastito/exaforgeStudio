/**
 * TEST — Channel Adaptation (PRD 11 / ADR-168 F5). Determinístico (transform puro, sem DB).
 * Prova: reescrita por canal (limite de legenda, hashtags, formato, CTA, tom); changes log;
 * canal desconhecido rejeitado (RN-CG-09 grounded); adaptMany + skipped.
 *
 * Uso: npm run test:channel-adaptation
 */
process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-chadapt-1";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { ChannelAdaptationService: CH } = await import("../src/server/ChannelAdaptationService.js");

  const longCaption = "Camisa de linho premium ".repeat(20).trim(); // ~480 chars
  const manyTags = ["#linho", "#moda", "#conforto", "#verao", "#estilo", "#lookdodia"];

  // ── 1. Catálogo de canais ──
  const chans = CH.channels();
  check("1.1 lista 6 canais", chans.length === 6);
  check("1.2 X tem captionMax 280", chans.find((c: any) => c.channel === "x")!.captionMax === 280);

  // ── 2. X: trunca legenda a 280 + clampeia hashtags a 2 ──
  const x = CH.adapt({ caption: longCaption, hashtags: manyTags, format: "reels", channel: "x" });
  check("2.1 X legenda <= 280", x.caption.length <= 280);
  check("2.2 X registrou truncagem", x.changes.some((c: string) => /truncada/.test(c)));
  check("2.3 X hashtags clampeadas a 2", x.hashtags.length === 2);
  check("2.4 X CTA idiomática", x.cta === "Detalhes no link.");

  // ── 3. Instagram: legenda curta cabe, mantém até 5 hashtags ──
  const ig = CH.adapt({ caption: "Novidade fresquinha!", hashtags: manyTags, format: "reels", channel: "instagram" });
  check("3.1 IG não trunca legenda curta", ig.caption === "Novidade fresquinha!" && ig.changes.every((c: string) => !/truncada/.test(c)));
  check("3.2 IG mantém 5 hashtags (do 6)", ig.hashtags.length === 5);
  check("3.3 IG reels → reel", ig.format === "reel");

  // ── 4. TikTok: só reel; story/post mapeia pra reel ──
  const tk = CH.adapt({ caption: "oi", format: "story", channel: "tiktok" });
  check("4.1 TikTok mapeia story→reel", tk.format === "reel" && tk.changes.some((c: string) => /formato/.test(c)));
  check("4.2 TikTok captionMax 150", CH.channels().find((c: any) => c.channel === "tiktok")!.captionMax === 150);

  // ── 5. LinkedIn: tom profissional + CTA diferente (não "link na bio") ──
  const li = CH.adapt({ caption: "Reflexão sobre linho.", format: "post", channel: "linkedin" });
  check("5.1 LinkedIn tom profissional", li.tone === "profissional");
  check("5.2 LinkedIn CTA nos comentários (não bio)", li.cta === "Link nos comentários." && String(ig.cta) === "Link na bio." && li.cta !== ig.cta);

  // ── 6. Hashtags abaixo do mínimo → caveat (não inventa) ──
  const li2 = CH.adapt({ caption: "x", hashtags: [], channel: "linkedin" });
  check("6.1 poucas hashtags → caveat", li2.caveats.some((c: string) => /hashtags/.test(c)));
  check("6.2 não inventa hashtags", li2.hashtags.length === 0);

  // ── 7. Canal desconhecido rejeitado (grounded) ──
  let threw = false;
  try { CH.adapt({ caption: "x", channel: "orkut" as any }); } catch { threw = true; }
  check("7.1 canal desconhecido lança", threw);

  // ── 8. adaptMany + skipped ──
  const many = CH.adaptMany({ caption: longCaption, hashtags: manyTags, format: "reels" }, ["instagram", "x", "tiktok", "orkut"]);
  check("8.1 adaptMany adapta os 3 conhecidos", many.adaptations.length === 3);
  check("8.2 adaptMany pula o desconhecido", many.skipped.length === 1 && many.skipped[0].channel === "orkut");
  check("8.3 cada canal respeita seu limite", many.adaptations.every((a: any) => a.caption.length <= CH.channels().find((c: any) => c.channel === a.channel)!.captionMax));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} channel-adaptation: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
