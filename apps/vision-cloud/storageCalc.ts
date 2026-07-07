/**
 * Calculadora de armazenamento de vídeo — PRD-VISION-VMS §16.2 (marcado
 * "NÃO EXISTE" no docs/PRD-VISION-VMS-RECONCILIACAO.md e agora implementado
 * como função pura, sem dependência de infraestrutura). Retorna quantos GB
 * a operação exige para gravar por N dias em modo contínuo — para o lojista
 * dimensionar o disco do Vision Edge Gateway ANTES de comprar hardware.
 *
 * Fórmula:
 *   Volume_GB = (bitrate_Mbps × 0.125 × 3600 × horas_dia × dias × câmeras) / 1024
 *
 * A conversão sai bem direta: bitrate em Mbps × 0.125 = MB/s; × 3600 = MB/h;
 * × horas × dias × câmeras = MB total; ÷ 1024 = GB. Ratio de codec (H.265 ~
 * metade do H.264; MJPEG ~5×) aplicado como escalar sobre o bitrate base.
 *
 * Bitrates de referência (Mbps) medidos em H.264, câmera IP típica @ 15 fps
 * — números conservadores, o PRD reforça que "não são promessa" e devem ser
 * validados no laboratório físico (PRD §14):
 *   720p → 1.5    |    1080p → 3.0    |    2K → 5.0    |    4K → 8.0
 * Escala linear com fps (fps/15). Para movimento contínuo em varejo/portaria
 * é agressivo; câmeras com CBR real podem chegar a 1.5× isso.
 */

export type Codec = "h264" | "h265" | "mjpeg";
export type Resolution = "720p" | "1080p" | "2k" | "4k";

const BASE_BITRATE_MBPS_H264_15FPS: Record<Resolution, number> = {
  "720p": 1.5,
  "1080p": 3.0,
  "2k": 5.0,
  "4k": 8.0,
};
const CODEC_RATIO: Record<Codec, number> = {
  h264: 1,
  h265: 0.5,
  mjpeg: 5,
};

export interface StorageCalcInput {
  cameras: number;
  resolution: Resolution;
  fps?: number;              // default 15
  codec?: Codec;             // default h264
  hoursPerDay?: number;      // default 24 (gravação contínua)
  retentionDays: number;
  motionOnlyFactor?: number; // 0-1: se gravar só com movimento, estimativa do "ligado"
}

export interface StorageCalcOutput {
  bitrateMbpsPerCamera: number;
  perCameraGbPerDay: number;
  totalGb: number;
  totalTb: number;
  assumptions: {
    codec: Codec;
    resolution: Resolution;
    fps: number;
    hoursPerDay: number;
    retentionDays: number;
    cameras: number;
    motionOnlyFactor: number;
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Núcleo puro — sem I/O, sem env, sem DB. Retorna o resumo do cálculo mais
 * as premissas ecoadas de volta (para a UI mostrar "o cálculo assumiu X").
 */
export function calculateStorage(input: StorageCalcInput): StorageCalcOutput {
  const cameras = Math.max(1, Math.floor(Number(input.cameras) || 0));
  const codec: Codec = input.codec && CODEC_RATIO[input.codec] ? input.codec : "h264";
  const resolution: Resolution = input.resolution && BASE_BITRATE_MBPS_H264_15FPS[input.resolution]
    ? input.resolution : "1080p";
  const fps = clamp(Number(input.fps) || 15, 1, 60);
  const hoursPerDay = clamp(Number(input.hoursPerDay) || 24, 0.1, 24);
  const retentionDays = Math.max(1, Math.floor(Number(input.retentionDays) || 0));
  const motionOnlyFactor = clamp(Number(input.motionOnlyFactor) || 1, 0.05, 1);

  const baseBitrate = BASE_BITRATE_MBPS_H264_15FPS[resolution] * (fps / 15);
  const bitrateMbpsPerCamera = baseBitrate * CODEC_RATIO[codec];

  const mbPerSecondPerCamera = bitrateMbpsPerCamera * 0.125;
  const secondsPerDayEffective = hoursPerDay * 3600 * motionOnlyFactor;
  const perCameraMbPerDay = mbPerSecondPerCamera * secondsPerDayEffective;
  const perCameraGbPerDay = perCameraMbPerDay / 1024;

  const totalGb = perCameraGbPerDay * cameras * retentionDays;
  const totalTb = totalGb / 1024;

  return {
    bitrateMbpsPerCamera: Number(bitrateMbpsPerCamera.toFixed(2)),
    perCameraGbPerDay: Number(perCameraGbPerDay.toFixed(2)),
    totalGb: Number(totalGb.toFixed(1)),
    totalTb: Number(totalTb.toFixed(2)),
    assumptions: { codec, resolution, fps, hoursPerDay, retentionDays, cameras, motionOnlyFactor },
  };
}
