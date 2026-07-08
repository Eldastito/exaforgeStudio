/**
 * Smoke test do S3 (ADR-078).
 *
 * Verifica se a configuração de S3 (S3_ENABLED + S3_BUCKET + credenciais)
 * está OK antes de subir uma versão que espera espelhar backup/PDF pra lá.
 * Faz PUT + GET + DELETE de um objeto de teste; não toca em nada real.
 *
 * Uso (defina as envs primeiro):
 *   S3_ENABLED=true S3_BUCKET=meu-bucket S3_REGION=us-east-1 \
 *     S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *     tsx scripts/s3-smoke-test.ts
 *
 * Compatível com R2/B2/MinIO via S3_ENDPOINT + S3_FORCE_PATH_STYLE=true.
 *
 * Saída:
 *   ✅ tudo verde → seguro para promover S3_ENABLED em produção.
 *   ❌ falha em qualquer passo → NÃO promover; investigar credenciais/permissões.
 */

async function main() {
  const need = ["S3_ENABLED", "S3_BUCKET"];
  const miss = need.filter((k) => !process.env[k]);
  if (miss.length) {
    console.error(`❌ Faltam envs: ${miss.join(", ")}`);
    process.exit(1);
  }
  if (process.env.S3_ENABLED !== "true") {
    console.error("❌ S3_ENABLED=true é obrigatório para o smoke test.");
    process.exit(1);
  }

  const bucket = process.env.S3_BUCKET!;
  const region = process.env.S3_REGION || "auto";
  const endpoint = process.env.S3_ENDPOINT || undefined;
  console.log(`\n🔎 Smoke test S3 — bucket=${bucket} region=${region} ${endpoint ? `endpoint=${endpoint}` : ""}`);

  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: process.env.S3_ACCESS_KEY_ID
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "" }
      : undefined,
  });

  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

  // 1) HeadBucket — checa acesso mínimo ao bucket
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    check("1. HeadBucket — bucket acessível", true);
  } catch (e: any) {
    check("1. HeadBucket — bucket acessível", false, e?.name || String(e));
  }

  // 2) PUT — grava um objeto de teste
  const key = `zappflow-smoke-test/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const body = `smoke-test-${new Date().toISOString()}`;
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" }));
    check(`2. PUT ${key.slice(0, 40)}...`, true);
  } catch (e: any) {
    check("2. PUT (gravou objeto de teste)", false, e?.name || String(e));
  }

  // 3) GET — lê o objeto de volta
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const c of (r.Body as any as AsyncIterable<Uint8Array>)) chunks.push(Buffer.from(c));
    const round = Buffer.concat(chunks).toString("utf-8");
    check("3. GET — round-trip íntegro", round === body, `esperado='${body.slice(0, 30)}...', lido='${round.slice(0, 30)}...'`);
  } catch (e: any) {
    check("3. GET — round-trip íntegro", false, e?.name || String(e));
  }

  // 4) DELETE — limpa o objeto de teste
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    check("4. DELETE — cleanup do objeto de teste", true);
  } catch (e: any) {
    check("4. DELETE — cleanup do objeto de teste", false, e?.name || String(e));
  }

  console.log("\n=========================================");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("=========================================");
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.log(`❌ ${failed} falha(s). NÃO promover S3_ENABLED em produção antes de resolver.`);
    process.exit(1);
  }
  console.log("✅ Smoke test verde. Configuração pronta para produção.");
  process.exit(0);
}

main().catch((e) => {
  console.error("💥 Smoke test explodiu:", e);
  process.exit(1);
});
