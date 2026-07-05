/**
 * TESTE — durabilidade do JWT_SECRET (corrige "Sessão inválida" do Provador)
 * -------------------------------------------------------------------------
 * Sem a env JWT_SECRET, o segredo era ALEATÓRIO por processo — todo restart/
 * deploy invalidava as sessões (causa do erro logo após o cadastro no
 * provador, que assina e valida o token em sequência). Agora o segredo é
 * PERSISTIDO em DATA_DIR/.jwt_secret e sobrevive a reinícios.
 *
 * Uso: npm run test:jwt-secret-persist
 */
import os from "os";
import path from "path";
import fs from "fs";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const { resolveJwtSecret } = await import("../src/server/config/secret.js");

  // ---- com a env definida: usa a env, não escreve arquivo ----
  const dirEnv = fs.mkdtempSync(path.join(os.tmpdir(), "zf-jwt-env-"));
  process.env.DATA_DIR = dirEnv;
  process.env.JWT_SECRET = "env-secret-fixo-para-teste-1234567890";
  check("Com JWT_SECRET na env: usa a env", resolveJwtSecret() === "env-secret-fixo-para-teste-1234567890");
  check("Com env: NÃO cria o arquivo persistido", !fs.existsSync(path.join(dirEnv, ".jwt_secret")));

  // ---- sem a env: gera e PERSISTE; segunda chamada (simula restart) reusa ----
  const dirPersist = fs.mkdtempSync(path.join(os.tmpdir(), "zf-jwt-persist-"));
  process.env.DATA_DIR = dirPersist;
  delete process.env.JWT_SECRET;

  const first = resolveJwtSecret();
  check("Sem env: gera um segredo forte", typeof first === "string" && first.length >= 32);
  check("Sem env: persiste em DATA_DIR/.jwt_secret", fs.existsSync(path.join(dirPersist, ".jwt_secret")));

  // Segunda chamada = novo boot do processo apontando pro mesmo volume.
  const second = resolveJwtSecret();
  check("Após 'restart' (mesmo DATA_DIR): REUSA o mesmo segredo (sessões sobrevivem)", second === first);

  // Terceira, para garantir estabilidade.
  check("Estável em chamadas repetidas", resolveJwtSecret() === first);

  // ---- arquivo corrompido/curto: regenera em vez de usar lixo ----
  const dirCorrupt = fs.mkdtempSync(path.join(os.tmpdir(), "zf-jwt-corrupt-"));
  fs.writeFileSync(path.join(dirCorrupt, ".jwt_secret"), "curto");
  process.env.DATA_DIR = dirCorrupt;
  const regen = resolveJwtSecret();
  check("Arquivo curto/corrompido é ignorado (gera segredo forte novo)", regen.length >= 32 && regen !== "curto");

  fs.rmSync(dirEnv, { recursive: true, force: true });
  fs.rmSync(dirPersist, { recursive: true, force: true });
  fs.rmSync(dirCorrupt, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? "🎉 durabilidade do JWT_SECRET confirmada." : `⚠️ ${failures} falha(s).`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("Erro fatal:", e); process.exit(1); });
