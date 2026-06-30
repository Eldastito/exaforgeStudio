/**
 * Google Places API (New) — fonte PREMIUM de descoberta. Diferente do
 * OpenStreetMap, traz telefone, site e AVALIAÇÕES (estrelas + nº de avaliações),
 * que viram o sinal de dor real ("reputação a melhorar"). Cobrado por busca na
 * conta Google Cloud do cliente (chave por organização). Sem scraping: API oficial.
 */

export interface DiscoveryResult {
  name: string; osmRef: string; segment: string; phone: string; website: string;
  street: string; city: string; state: string; lat?: number; lon?: number;
  rating?: number; ratingCount?: number;
}

const ENDPOINT = "https://places.googleapis.com/v1/places:searchNearby";
const FIELD_MASK = [
  "places.id", "places.displayName", "places.primaryTypeDisplayName", "places.primaryType",
  "places.formattedAddress", "places.shortFormattedAddress", "places.nationalPhoneNumber",
  "places.internationalPhoneNumber", "places.websiteUri", "places.rating",
  "places.userRatingCount", "places.location", "places.addressComponents",
].join(",");

export class GooglePlacesService {
  /**
   * Busca lugares num raio (Nearby Search New). `types` = tipos do Google
   * (vazio = amplo). Retorna no formato comum de descoberta.
   */
  static async searchNearby(lat: number, lon: number, radiusKm: number, types: string[], apiKey: string): Promise<DiscoveryResult[]> {
    if (!apiKey) throw new Error("Chave da Google Places API não configurada.");
    const radius = Math.min(50000, Math.max(50, Math.round((Number(radiusKm) || 1) * 1000)));
    const body: any = {
      maxResultCount: 20,
      languageCode: "pt-BR",
      regionCode: "BR",
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius } },
    };
    if (types && types.length) body.includedTypes = types.slice(0, 50);

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 30000);
    let json: any;
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Google Places: ${json?.error?.message || `HTTP ${r.status}`}`);
    } finally { clearTimeout(t); }

    const comp = (p: any, type: string) => {
      const c = (p.addressComponents || []).find((x: any) => (x.types || []).includes(type));
      return c ? String(c.shortText || c.longText || "").trim() : "";
    };
    const out: DiscoveryResult[] = [];
    for (const p of (json?.places || [])) {
      const name = String(p?.displayName?.text || "").trim();
      if (!name) continue;
      out.push({
        name,
        osmRef: `gplace:${p.id}`,
        segment: String(p?.primaryTypeDisplayName?.text || p?.primaryType || "").replace(/_/g, " ").trim(),
        phone: String(p?.nationalPhoneNumber || p?.internationalPhoneNumber || "").trim(),
        website: String(p?.websiteUri || "").trim(),
        street: String(p?.shortFormattedAddress || p?.formattedAddress || "").trim(),
        city: comp(p, "administrative_area_level_2") || comp(p, "locality"),
        state: comp(p, "administrative_area_level_1"),
        lat: p?.location?.latitude,
        lon: p?.location?.longitude,
        rating: typeof p?.rating === "number" ? p.rating : undefined,
        ratingCount: typeof p?.userRatingCount === "number" ? p.userRatingCount : undefined,
      });
    }
    return out;
  }
}
