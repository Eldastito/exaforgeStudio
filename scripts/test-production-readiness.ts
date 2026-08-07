// ADR-154 F10.1 — prontidão de produção ("infra completa" pra colocar na
// prateleira). Testa o ProductionReadinessService sob diferentes configs de
// ambiente + guarda o wiring das rotas (probe público + endpoint master admin).
//
// Sem DB, sem rede — manipula process.env e lê arquivos do repo.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProductionReadinessService } from "../src/server/ProductionReadinessService.js";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}`);
  if (!ok) failures++;
}

// Backup gravável de forma determinística: aponta BACKUPS_DIR pra um tmp.
const tmpBackups = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-"));
const ENV_KEYS = [
  "OPENAI_API_KEY", "JWT_SECRET", "APP_URL", "ASAAS_API_KEY",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
  "EVOLUTION_API_KEY", "EVOLUTION_BASE_URL", "BACKUPS_DIR",
  "RESEND_API_KEY", "FALATU_EMAIL_FROM",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
function reset() { for (const k of ENV_KEYS) delete process.env[k]; process.env.BACKUPS_DIR = tmpBackups; }
const get = (checks: any[], key: string) => checks.find((c) => c.key === key);

// --- Caso A: tudo configurado → ready ---
reset();
process.env.OPENAI_API_KEY = "sk-test";
process.env.JWT_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_URL = "https://falatu.exemplo.com.br";
process.env.ASAAS_API_KEY = "asa-test";
process.env.TWILIO_ACCOUNT_SID = "AC123";
process.env.TWILIO_AUTH_TOKEN = "tok";
process.env.TWILIO_FROM_NUMBER = "+5511999999999";
process.env.EVOLUTION_API_KEY = "evo";
process.env.EVOLUTION_BASE_URL = "https://evo.exemplo.com.br";
process.env.RESEND_API_KEY = "re-test";
process.env.FALATU_EMAIL_FROM = "FalaTu <briefing@exemplo.com.br>";
let r = ProductionReadinessService.report();
check("A: status ready quando tudo configurado", r.status === "ready");
check("A: blockersOk() true", ProductionReadinessService.blockersOk() === true);
check("A: openai ok", get(r.checks, "openai").ok === true);
check("A: telephony ok (Twilio completo)", get(r.checks, "telephony").ok === true);
check("A: whatsapp ok (Evolution completo)", get(r.checks, "whatsapp").ok === true);
check("A: billing ok (Asaas)", get(r.checks, "billing").ok === true);
check("A: backups ok (dir gravável)", get(r.checks, "backups").ok === true);
check("A: push sempre ok (VAPID auto)", get(r.checks, "push").ok === true);
check("A: email ok com remetente de plataforma (F11.1: Resend + FROM)", get(r.checks, "email").ok === true);
check("A: nenhum segredo vaza no payload", !JSON.stringify(r).includes("sk-test") && !JSON.stringify(r).includes("asa-test") && !JSON.stringify(r).includes("re-test"));

// --- Caso B: sem OpenAI → blocked ---
reset();
process.env.JWT_SECRET = "0123456789abcdef0123456789abcdef";
process.env.APP_URL = "https://x.y";
r = ProductionReadinessService.report();
check("B: status blocked sem OPENAI_API_KEY", r.status === "blocked");
check("B: blockersFailing >= 1", r.summary.blockersFailing >= 1);
check("B: blockersOk() false", ProductionReadinessService.blockersOk() === false);
check("B: openai.ok false", get(r.checks, "openai").ok === false);

// --- Caso C: OpenAI ok, faltam recomendados → degraded ---
reset();
process.env.OPENAI_API_KEY = "sk-test";
// sem JWT_SECRET, sem APP_URL, sem ASAAS
r = ProductionReadinessService.report();
check("C: status degraded (blocker ok, recomendado faltando)", r.status === "degraded");
check("C: blockersOk() true", ProductionReadinessService.blockersOk() === true);
check("C: recommendedFailing >= 1", r.summary.recommendedFailing >= 1);
check("C: jwt_secret.ok false sem env", get(r.checks, "jwt_secret").ok === false);
check("C: app_url.ok false sem env", get(r.checks, "app_url").ok === false);
check("C: email.ok false sem remetente de plataforma (Resend/FROM)", get(r.checks, "email").ok === false);

// --- Twilio incompleto → telephony off ---
reset();
process.env.OPENAI_API_KEY = "sk-test";
process.env.TWILIO_ACCOUNT_SID = "AC123";
process.env.TWILIO_AUTH_TOKEN = "tok"; // falta FROM_NUMBER
r = ProductionReadinessService.report();
check("Twilio parcial → telephony.ok false", get(r.checks, "telephony").ok === false);

// --- Evolution incompleto → whatsapp off ---
reset();
process.env.OPENAI_API_KEY = "sk-test";
process.env.EVOLUTION_API_KEY = "evo"; // falta BASE_URL
r = ProductionReadinessService.report();
check("Evolution parcial → whatsapp.ok false", get(r.checks, "whatsapp").ok === false);

// --- summary coerente ---
check("summary.optionalTotal === 4 (telephony/whatsapp/push/email)", r.summary.optionalTotal === 4);
check("report tem generatedAt ISO", typeof r.generatedAt === "string" && r.generatedAt.includes("T"));

// --- Wiring estático das rotas + docs ---
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const server = read("server.ts");
check("server.ts expõe GET /api/health (liveness)", /get\(["']\/api\/health["']/.test(server));
check("server.ts expõe GET /api/health/ready (readiness 200/503)", server.includes('/api/health/ready') && server.includes("503"));
check("server.ts usa ProductionReadinessService.blockersOk no /ready", server.includes("ProductionReadinessService.blockersOk"));
const admin = read("src/server/routes/admin.ts");
check("admin.ts expõe GET /production-readiness (master admin)", admin.includes('/production-readiness') && admin.includes("ProductionReadinessService.report"));
const envEx = read(".env.example");
check(".env.example documenta Twilio (Protocolos)", envEx.includes("TWILIO_ACCOUNT_SID") && envEx.includes("TWILIO_FROM_NUMBER"));
check(".env.example documenta Asaas (cobrança)", envEx.includes("ASAAS_API_KEY"));
check(".env.example documenta DATA_DIR/BACKUPS_DIR", envEx.includes("DATA_DIR") && envEx.includes("BACKUPS_DIR"));

// Restaura env + limpa tmp.
for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
try { fs.rmSync(tmpBackups, { recursive: true, force: true }); } catch { /* noop */ }

console.log(failures === 0 ? "\nOK — 100% PASS" : `\nFALHOU — ${failures} checagem(ns)`);
process.exit(failures === 0 ? 0 : 1);
