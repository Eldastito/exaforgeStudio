/**
 * VpsSpecProfileService — PRD 7 / ADR-164 F2 (fatia HOST/INFRA, §9/§68/§69): o VPS Spec
 * Profile que a auditoria F0 registrou como PENDÊNCIA DE AMBIENTE.
 *
 * O GitHub prova o código; os NÚMEROS reais da infra (vCPU/RAM/storage/banda/SO,
 * orquestração, limites de container, onde o `.db` mora) não estão no repo — eles vêm do
 * operador. Este serviço é a porta de ENTRADA desses fatos: o Admin Master registra o perfil
 * uma vez, e os motores de capacidade (F7 headroom) passam a usar limites REAIS em vez dos
 * provisórios. Enquanto o perfil não é preenchido, tudo segue honesto (`configured:false`)
 * — nunca inventa spec (§59/RN-PRC-6).
 *
 * PLATFORM-GLOBAL (RN-PRC-4/§46): o perfil vive em `platform_settings` (KV global), nunca
 * em `organization_settings`. Não expõe segredo. Determinístico.
 */
import db from "./db.js";

const KEY = "platform_vps_spec_profile";

export interface VpsSpecInput {
  vcpu?: number | null;               // nº de vCPUs da VPS
  ramMb?: number | null;              // RAM total (MB)
  storageGb?: number | null;          // disco total (GB)
  bandwidthMbps?: number | null;      // banda, se conhecida
  os?: string | null;                 // ex.: "Ubuntu 22.04"
  orchestration?: string | null;      // docker | coolify | bare | other
  containerCpuLimit?: number | null;  // limite de CPU do container (cores), se houver
  containerMemMb?: number | null;     // limite de RAM do container (MB), se houver
  dbPath?: string | null;             // onde o SQLite mora
  dbSizeBytes?: number | null;        // tamanho atual do .db (informado)
  metricsEndpoint?: string | null;    // endpoint de métricas do host (Prometheus/Coolify), se houver
}

const NUM_FIELDS: (keyof VpsSpecInput)[] = ["vcpu", "ramMb", "storageGb", "bandwidthMbps", "containerCpuLimit", "containerMemMb", "dbSizeBytes"];
const STR_FIELDS: (keyof VpsSpecInput)[] = ["os", "orchestration", "dbPath", "metricsEndpoint"];

export class VpsSpecProfileService {
  /** Perfil corrente. Sem perfil → configured:false (honesto). */
  static get(): any {
    const row = db.prepare("SELECT value, updated_at FROM platform_settings WHERE key = ?").get(KEY) as any;
    if (!row?.value) return { configured: false, reason: "not_configured" };
    let p: any; try { p = JSON.parse(row.value); } catch { return { configured: false, reason: "corrupt" }; }
    return { configured: true, updatedAt: row.updated_at, ...p };
  }

  /**
   * Registra/atualiza o perfil (Admin Master). Valida forma (números positivos finitos,
   * strings curtas); campos ausentes ficam null. Retorna o perfil salvo.
   */
  static set(input: VpsSpecInput = {}): any {
    const clean: any = {};
    for (const f of NUM_FIELDS) {
      const v = (input as any)[f];
      if (v == null || v === "") { clean[f] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${f} deve ser número positivo.`);
      clean[f] = n;
    }
    for (const f of STR_FIELDS) {
      const v = (input as any)[f];
      clean[f] = v == null || v === "" ? null : String(v).slice(0, 200);
    }
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(KEY, JSON.stringify(clean));
    return this.get();
  }

  /** Limpa o perfil (volta ao estado honesto não-configurado). */
  static clear(): void {
    db.prepare("DELETE FROM platform_settings WHERE key = ?").run(KEY);
  }

  /**
   * Nº de cores a usar como base do load-por-core: limite do container tem precedência
   * (é o que o processo realmente pode usar), depois vCPU da VPS. null quando não configurado
   * — o chamador cai no que o Node vê (`os.cpus()`), que sob container costuma mentir.
   */
  static effectiveCpuCount(): number | null {
    const p = this.get();
    if (!p.configured) return null;
    return p.containerCpuLimit ?? p.vcpu ?? null;
  }
}

export default VpsSpecProfileService;
