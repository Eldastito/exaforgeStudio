// CI shard runner — workaround do limite DURO de 256 jobs por matrix do
// GitHub Actions: com 325 suítes (uma por script test:* do package.json), o
// job `test` nem expandia — a matrix falhava na criação e TODO run saía
// `failure` com só o build rodando (main vermelha desde então).
//
// Em vez de 1 job por suíte, N shards fixos: o shard i roda as suítes cuja
// posição (ordem alfabética, determinística) % total == i. A lista vem do
// package.json (fonte única — a matrix antiga era espelho manual 1:1 e ainda
// exigia wiring por fatia; agora `npm run test:<nome>` novo entra sozinho).
//
// Mantém a filosofia do fail-fast=false: cada shard roda TODAS as suas
// suítes até o fim, imprime o resumo das que falharam e só então sai com 1.
//
// Uso: node scripts/ci-shard.mjs <shardIndex> <shardTotal>
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const shardIndex = Number(process.argv[2]);
const shardTotal = Number(process.argv[3]);
if (!Number.isInteger(shardIndex) || !Number.isInteger(shardTotal) || shardIndex < 0 || shardTotal < 1 || shardIndex >= shardTotal) {
  console.error("Uso: node scripts/ci-shard.mjs <shardIndex> <shardTotal>");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const suites = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:")).sort();
const mine = suites.filter((_, i) => i % shardTotal === shardIndex);

console.log(`Shard ${shardIndex}/${shardTotal}: ${mine.length} de ${suites.length} suítes\n${mine.join("\n")}\n`);

const failed = [];
for (const suite of mine) {
  console.log(`\n===== ▶ ${suite} =====`);
  const started = Date.now();
  const r = spawnSync("npm", ["run", suite], { stdio: "inherit" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.status !== 0) {
    failed.push(suite);
    console.error(`===== ❌ ${suite} (${secs}s, exit ${r.status}) =====`);
  } else {
    console.log(`===== ✅ ${suite} (${secs}s) =====`);
  }
}

console.log(`\n===== Shard ${shardIndex}/${shardTotal}: ${mine.length - failed.length}/${mine.length} suítes OK =====`);
if (failed.length > 0) {
  console.error(`Suítes com falha:\n${failed.map((s) => `  - ${s}`).join("\n")}`);
  process.exit(1);
}
