/**
 * Utilitários de geografia — distância entre coordenadas (haversine).
 * Usado para sugerir a transferência entre as lojas MAIS PRÓXIMAS (ADR-083 Fase G).
 */

const R_KM = 6371; // raio médio da Terra em km
const toRad = (deg: number) => (Number(deg) * Math.PI) / 180;

/** Coordenada válida? (lat/lng numéricos e dentro do intervalo terrestre). */
export function hasCoords(lat: any, lng: any): boolean {
  const a = Number(lat), b = Number(lng);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0);
}

/** Distância em km entre dois pontos (haversine). NaN se alguma coord é inválida. */
export function haversineKm(lat1: any, lng1: any, lat2: any, lng2: any): number {
  if (!hasCoords(lat1, lng1) || !hasCoords(lat2, lng2)) return NaN;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R_KM * c * 100) / 100;
}
