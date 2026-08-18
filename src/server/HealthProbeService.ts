/**
 * HealthProbeService — probe LEVE de saúde da API para o cliente distinguir
 * "tempo real caiu" de "API/servidor com problema" (PDR TOULON, Fatia 5 /
 * CONN-003). NÃO usa consulta pesada de negócio: só confirma que o processo
 * responde e que o SQLite está acessível (`SELECT 1`), medindo a latência.
 *
 * A rota que expõe isto é AUTENTICADA (exercita o caminho real de auth do app),
 * mas o probe em si não toca dado de tenant nem de negócio — é barato e seguro
 * de rodar em intervalo curto.
 */
import db from "./db.js";

export type HealthPing = {
  ok: boolean;
  ts: string;        // hora do servidor (ISO) — o cliente compara com a própria p/ clock skew
  db: boolean;       // SQLite respondeu ao SELECT 1
  dbMs: number;      // latência do SELECT 1 (ms) — sinal barato de banco lento
};

export class HealthProbeService {
  /** Probe barato: processo de pé + SQLite acessível + latência do banco. */
  static ping(now: string = new Date().toISOString()): HealthPing {
    let ok = true;
    let dbMs = 0;
    try {
      const t0 = process.hrtime.bigint();
      db.prepare("SELECT 1 AS ok").get();
      dbMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 100) / 100;
    } catch {
      ok = false;
    }
    return { ok, ts: now, db: ok, dbMs };
  }
}

export default HealthProbeService;
