/**
 * TEST — Security config boot validation (SEC-F2 / SEC-04). Puro/determinístico (sem DB).
 *
 * Prova o validador fail-closed OPT-IN: detecta segredo crítico faltando/fraco, marca
 * `degraded`/`hasCritical`, respeita `SECURITY_STRICT_BOOT`, e o relatório NUNCA vaza o valor
 * do segredo. A decisão de abortar o boot (produção + strict + crítico) é do server.ts.
 *
 * Uso: npm run test:security-config
 */
const HEX32A = "a".repeat(64);
const HEX32B = "b".repeat(64);

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
function has(r: any, code: string): boolean { return r.issues.some((i: any) => i.code === code); }

async function main() {
  const { SecurityConfigurationService: SC } = await import("../src/server/SecurityConfigurationService.js");

  // ── 1. Config saudável (chaves distintas, longas) → ok ──
  const good = SC.validateBoot({ NODE_ENV: "production", ENCRYPTION_KEY: HEX32A, JWT_SECRET: HEX32B });
  check("1.1 config saudável → ok, sem issues", good.ok && good.issues.length === 0);
  check("1.2 config saudável → não degradado / sem crítico", !good.degraded && !good.hasCritical);

  // ── 2. ENCRYPTION_KEY ausente mas JWT presente → warning (derivado), não crítico ──
  const derived = SC.validateBoot({ NODE_ENV: "production", JWT_SECRET: HEX32B });
  check("2.1 sem ENCRYPTION_KEY → warning encryption_key_derived", has(derived, "encryption_key_derived"));
  check("2.2 derivado é degradado mas NÃO crítico", derived.degraded && !derived.hasCritical);

  // ── 3. PIOR CASO: nem ENCRYPTION_KEY nem JWT → chave hardcoded conhecida → CRÍTICO ──
  const fallback = SC.validateBoot({ NODE_ENV: "production" });
  check("3.1 nenhum segredo → encryption_key_fallback", has(fallback, "encryption_key_fallback"));
  check("3.2 fallback é CRÍTICO", fallback.hasCritical);

  // ── 4. ENCRYPTION_KEY === JWT_SECRET → warning (não distintos) ──
  const same = SC.validateBoot({ NODE_ENV: "production", ENCRYPTION_KEY: HEX32A, JWT_SECRET: HEX32A });
  check("4.1 chaves iguais → encryption_key_equals_jwt", has(same, "encryption_key_equals_jwt"));

  // ── 5. Placeholder → CRÍTICO ──
  const ph = SC.validateBoot({ NODE_ENV: "production", ENCRYPTION_KEY: "changeme", JWT_SECRET: HEX32B });
  check("5.1 placeholder → weak_encryption_key_placeholder + crítico", has(ph, "weak_encryption_key_placeholder") && ph.hasCritical);

  // ── 6. Chave curta → warning ──
  const short = SC.validateBoot({ NODE_ENV: "production", ENCRYPTION_KEY: "abc123", JWT_SECRET: HEX32B });
  check("6.1 chave curta → encryption_key_short", has(short, "encryption_key_short"));

  // ── 7. Flag strict é parseada; decisão de abortar = produção + strict + crítico ──
  const strictCrit = SC.validateBoot({ NODE_ENV: "production", SECURITY_STRICT_BOOT: "1" });
  check("7.1 SECURITY_STRICT_BOOT=1 → strict true", strictCrit.strict === true);
  check("7.2 strict + crítico em prod → aborta (decisão do server)", strictCrit.production && strictCrit.strict && strictCrit.hasCritical);
  const strictOff = SC.validateBoot({ NODE_ENV: "production" });
  check("7.3 sem a flag → strict false (não aborta, degrada)", strictOff.strict === false && strictOff.degraded);

  // ── 8. Não-produção nunca marca produção (server não aborta em dev) ──
  const dev = SC.validateBoot({ NODE_ENV: "development" });
  check("8.1 dev → production false", dev.production === false);

  // ── 9. REDAÇÃO: o relatório NUNCA contém o valor do segredo ──
  const secretVal = "TOPSECRET-VALUE-should-not-appear";
  const red = SC.report({ NODE_ENV: "production", ENCRYPTION_KEY: secretVal, JWT_SECRET: HEX32B });
  check("9.1 relatório não vaza o valor do segredo", !JSON.stringify(red).includes(secretVal));

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-config: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
