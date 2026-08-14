import crypto from "crypto";
import fs from "fs";
import path from "path";

// Segredo único de assinatura/verificação de JWT, resolvido UMA vez no boot.
// Ordem de resolução:
//   1) env JWT_SECRET (recomendado, obrigatório para deploys MULTI-INSTÂNCIA).
//   2) segredo PERSISTIDO em DATA_DIR/.jwt_secret — o mesmo volume do banco,
//      que sobrevive a reinícios e deploys. Sem isto, um segredo aleatório por
//      processo invalidaria TODAS as sessões a cada restart do container (o
//      supervisor respawna o core; cada deploy reinicia) — foi exatamente a
//      causa do "Sessão inválida ou expirada" logo após o cadastro no Provador
//      Virtual, que cadastra e valida o token em sequência.
//   3) só se não der para persistir (disco somente-leitura): aleatório efêmero.
export function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const dir = process.env.DATA_DIR || process.cwd();
  const file = path.join(dir, ".jwt_secret");

  // Já persistido? usa.
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing.length >= 32) return existing;
  } catch { /* ainda não existe */ }

  const generated = crypto.randomBytes(48).toString("hex");
  try {
    fs.mkdirSync(dir, { recursive: true });
    // "wx": cria só se não existir — resolve a corrida entre processos (core +
    // vision sobem juntos): quem cria primeiro vence; o outro relê o do disco.
    try {
      fs.writeFileSync(file, generated, { flag: "wx", mode: 0o600 });
    } catch {
      const persisted = fs.readFileSync(file, "utf-8").trim();
      if (persisted.length >= 32) return persisted;
    }
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[SECURITY] JWT_SECRET não configurado — usando um segredo PERSISTIDO em " +
        "DATA_DIR/.jwt_secret (as sessões sobrevivem a reinícios). Para deploys " +
        "multi-instância, defina JWT_SECRET no ambiente."
      );
    }
    return generated;
  } catch (e) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[SECURITY] JWT_SECRET não configurado e não foi possível persistir o segredo " +
        "(disco somente-leitura?) — as sessões serão invalidadas a cada restart. " +
        "Defina JWT_SECRET no ambiente.", e
      );
    }
    return generated;
  }
}

export const JWT_SECRET = resolveJwtSecret();

// Tempo de vida do token de SESSÃO (achado A13). Antes fixo em "24h";
// agora configurável via env `JWT_TTL` para o operador poder ENCURTAR a janela de
// exposição de um token vazado (ex.: "8h", "30m", "3600" segundos). Default "24h"
// (0-regressão). Formato aceito: inteiro de segundos, ou `<n><s|m|h|d|w>`. Valor
// malformado é IGNORADO (cai no default + aviso) — nunca quebra o `jwt.sign`.
// Retorna number (SEGUNDOS) para entrada só-dígitos, ou string (`ms`-parseável, ex.
// "8h") para o formato com unidade. Importante: `jwt.sign({expiresIn})` interpreta uma
// STRING só-dígitos como MILISSEGUNDOS (via `ms`), mas um NUMBER como segundos — então
// "3600" precisa virar Number(3600) para significar 1h, não 3,6s.
export function resolveSessionJwtTtl(env: Record<string, string | undefined> = process.env): string | number {
  const raw = String(env.JWT_TTL || "").trim();
  if (!raw) return "24h";
  if (/^\d+$/.test(raw)) return Number(raw); // segundos
  if (/^\d+[smhdw]$/.test(raw)) return raw;   // ex. "8h", "30m", "7d"
  console.warn(`[SECURITY] JWT_TTL="${raw}" inválido (use segundos ou <n><s|m|h|d|w>, ex. "8h"). Usando o default 24h.`);
  return "24h";
}

export const SESSION_JWT_TTL = resolveSessionJwtTtl();

// E-mail do administrador master (super-admin entre organizações). Configurável,
// com fallback para o dono original para não quebrar instalações existentes.
export const MASTER_ADMIN_EMAIL = process.env.MASTER_ADMIN_EMAIL || "eldastito@gmail.com";
