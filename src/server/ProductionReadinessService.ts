import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { TelephonyService } from "./TelephonyService.js";
import { SkillOsRolloutService } from "./SkillOsRolloutService.js";

/**
 * ProductionReadinessService (ADR-154 F10.1 — infra de produção "na prateleira").
 *
 * Fonte ÚNICA da resposta "este deploy está pronto pra vender?". Inspeciona a
 * configuração real de cada dependência (env + disco) e devolve um relatório
 * estruturado, sem segredo nenhum no payload — só o ESTADO (configurado/faltando)
 * e a dica de como resolver.
 *
 * Três níveis:
 *   - blocker     → sem isso o produto não funciona pra ninguém (ex.: OpenAI).
 *   - recommended → funciona, mas degrada ou arrisca produção (JWT no env pra
 *                   multi-instância, APP_URL pros links, backup gravável).
 *   - optional    → recurso opt-in; ausência só desliga aquele canal.
 *
 * Consumido por:
 *   - GET /api/health/ready (probe público 200/503 — só blockers, barato, sem fs)
 *   - GET /api/admin/production-readiness (relatório completo, master admin)
 *
 * IMPORTANTE: lê env A CADA chamada (nunca cacheia no import) — o operador
 * configura no painel do deploy e o relatório tem que refletir na hora.
 */

export type CheckLevel = "blocker" | "recommended" | "optional";

export interface ReadinessCheck {
  key: string;
  label: string;
  level: CheckLevel;
  ok: boolean;
  detail: string;   // estado atual, legível
  hint?: string;    // como configurar (nomes de env), sem valores
}

export interface ReadinessReport {
  status: "ready" | "degraded" | "blocked";
  generatedAt: string;
  summary: {
    blockersFailing: number;
    recommendedFailing: number;
    optionalConfigured: number;
    optionalTotal: number;
  };
  checks: ReadinessCheck[];
}

function has(name: string): boolean {
  const v = process.env[name];
  return !!(v && v.trim().length > 0);
}

export class ProductionReadinessService {
  /** Diretório de backup — mesma regra do BackupService (não importa pra evitar ciclo). */
  private static backupsDir(): string {
    return process.env.BACKUPS_DIR || path.join(process.env.DATA_DIR || process.cwd(), "backups");
  }

  /** Backup gravável? Testa mkdir + escrita + unlink de um probe (barato, isolado). */
  private static backupWritable(): boolean {
    const dir = ProductionReadinessService.backupsDir();
    const probe = path.join(dir, `.readiness-probe-${randomUUID()}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Checagens de BLOCKER apenas — puras (só env, sem fs). Usadas pelo probe
   * /ready, que um load balancer bate a cada poucos segundos.
   */
  static blockersOk(): boolean {
    return has("OPENAI_API_KEY");
  }

  /** Relatório completo. */
  static report(): ReadinessReport {
    const checks: ReadinessCheck[] = [];

    // ---- Blockers ----
    checks.push({
      key: "openai",
      label: "IA (OpenAI)",
      level: "blocker",
      ok: has("OPENAI_API_KEY"),
      detail: has("OPENAI_API_KEY")
        ? "Chave configurada — transcrição (Whisper) e interpretação (GPT) ativas."
        : "Sem OPENAI_API_KEY: captura por voz/texto não é interpretada. O FalaTu não funciona.",
      hint: "OPENAI_API_KEY",
    });

    // ---- Recommended ----
    checks.push({
      key: "jwt_secret",
      label: "Segredo JWT",
      level: "recommended",
      ok: has("JWT_SECRET") && (process.env.JWT_SECRET || "").length >= 16,
      detail: has("JWT_SECRET")
        ? "JWT_SECRET no ambiente — sessões estáveis inclusive em multi-instância."
        : "Sem JWT_SECRET: o segredo é persistido em DATA_DIR/.jwt_secret (sobrevive a restart numa instância só), mas multi-instância derruba sessões.",
      hint: "JWT_SECRET (openssl rand -hex 32)",
    });
    checks.push({
      key: "app_url",
      label: "URL pública (APP_URL)",
      level: "recommended",
      ok: has("APP_URL"),
      detail: has("APP_URL")
        ? "APP_URL configurada — URLs assinadas e links de e-mail/WhatsApp saem corretos."
        : "Sem APP_URL: links em e-mail/WhatsApp e URLs assinadas podem sair quebrados.",
      hint: "APP_URL (ex.: https://falatu.seudominio.com.br)",
    });
    checks.push({
      key: "backups",
      label: "Backup automático",
      level: "recommended",
      ok: ProductionReadinessService.backupWritable(),
      detail: ProductionReadinessService.backupWritable()
        ? `Diretório de backup gravável (${ProductionReadinessService.backupsDir()}).`
        : "Diretório de backup não gravável — o backup automático (ADR-097) vai falhar.",
      hint: "BACKUPS_DIR / DATA_DIR (volume persistente com escrita)",
    });
    checks.push({
      key: "billing",
      label: "Cobrança (Asaas)",
      level: "recommended",
      ok: has("ASAAS_API_KEY"),
      detail: has("ASAAS_API_KEY")
        ? "Asaas configurado — assinatura e top-up podem cobrar de verdade."
        : "Sem ASAAS_API_KEY: assinatura e pacote extra não cobram (necessário para VENDER).",
      hint: "ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN",
    });

    // ---- Optional (canais opt-in) ----
    checks.push({
      key: "telephony",
      label: "Telefonia (Protocolos)",
      level: "optional",
      ok: TelephonyService.configured(),
      detail: TelephonyService.configured()
        ? "Twilio configurado — a chamada de resgate dos Protocolos (F8.7) sai de verdade."
        : "Sem Twilio: a aba Protocolos funciona, mas a ligação de resgate não é feita.",
      hint: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER",
    });
    checks.push({
      key: "whatsapp",
      label: "WhatsApp (Evolution)",
      level: "optional",
      ok: has("EVOLUTION_API_KEY") && has("EVOLUTION_BASE_URL"),
      detail: has("EVOLUTION_API_KEY") && has("EVOLUTION_BASE_URL")
        ? "Evolution configurado — captura e briefing por WhatsApp disponíveis."
        : "Sem Evolution: o app funciona 100% pelo navegador; só o canal WhatsApp fica off.",
      hint: "EVOLUTION_BASE_URL, EVOLUTION_API_KEY",
    });
    checks.push({
      key: "push",
      label: "Web Push (briefing)",
      level: "optional",
      ok: true, // VAPID é auto-gerado e persistido no DB (FalaTuPushService) — sem env.
      detail: "Pronto — as chaves VAPID são geradas e persistidas automaticamente (sem env).",
    });
    const emailPlatform = has("RESEND_API_KEY") && has("FALATU_EMAIL_FROM");
    checks.push({
      key: "email",
      label: "E-mail (briefing)",
      level: "optional",
      ok: emailPlatform, // F11.1: remetente de plataforma (Resend) via env.
      detail: emailPlatform
        ? "Remetente de plataforma (Resend) configurado — orgs sem conexão Google também recebem o briefing por e-mail."
        : "Sem remetente de plataforma: só orgs com conexão Google enviam o briefing por e-mail; orgs Solo ficam sem esse canal.",
      hint: "RESEND_API_KEY, FALATU_EMAIL_FROM",
    });

    // ---- SkillOS operacional (PRD 4 F12) — nível `optional`: SkillOS é opt-in e
    // aditivo, então nunca derruba o status geral sozinho; só informa. Derivado do
    // rollout/eval/health (RN-004), sem custo (§30-safe).
    try {
      const r = SkillOsRolloutService.readiness();
      checks.push({
        key: "skillos",
        label: "SkillOS (rollout/evals)",
        level: "optional",
        ok: r.ok,
        detail: r.ok
          ? "SkillOS operacional — sem kill switch, sem eval regredido, sem provider aberto."
          : `Atenção: ${r.issues.join(" ")}`,
      });
    } catch { /* SkillOS inerte/tabelas ausentes — não quebra o relatório. */ }

    const blockersFailing = checks.filter((c) => c.level === "blocker" && !c.ok).length;
    const recommendedFailing = checks.filter((c) => c.level === "recommended" && !c.ok).length;
    const optional = checks.filter((c) => c.level === "optional");
    const status: ReadinessReport["status"] =
      blockersFailing > 0 ? "blocked" : recommendedFailing > 0 ? "degraded" : "ready";

    return {
      status,
      generatedAt: new Date().toISOString(),
      summary: {
        blockersFailing,
        recommendedFailing,
        optionalConfigured: optional.filter((c) => c.ok).length,
        optionalTotal: optional.length,
      },
      checks,
    };
  }
}
