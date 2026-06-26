import db from "./db.js";

/**
 * Rede ZappFlow (Fase 3 do Supply). Cada organização pode se oferecer como
 * fornecedora na rede (opt-in com lista pública: nome, categorias e cidade
 * visíveis; preço/estoque só aparecem ao receber cotação).
 *
 * Geo: cidade + raio em km. Geocoding via Nominatim (OSM, gratuito), com cache.
 * Distância calculada por Haversine.
 */
export class SupplyNetworkService {
  /** Distância (km) entre dois pontos via fórmula de Haversine. */
  static distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // km
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10;
  }

  /**
   * Geocoda "cidade, estado, Brasil" via Nominatim (OpenStreetMap). Resultado
   * vai pro cache (geocode_cache) — Nominatim pede 1 req/s e não-comercial,
   * o cache evita rate limit e custo.
   */
  static async geocodeCity(city: string, state?: string): Promise<{ lat: number; lng: number } | null> {
    const c = (city || "").trim();
    if (!c) return null;
    const s = (state || "").trim();
    const key = `${c.toLowerCase()}|${s.toLowerCase()}|br`;
    try {
      const cached = db.prepare(`SELECT lat, lng FROM geocode_cache WHERE key = ?`).get(key) as any;
      if (cached && cached.lat != null && cached.lng != null) return { lat: cached.lat, lng: cached.lng };
    } catch (e) { /* tabela pode não existir ainda */ }

    try {
      const q = encodeURIComponent([c, s, "Brasil"].filter(Boolean).join(", "));
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=${q}`;
      const res = await fetch(url, { headers: { "User-Agent": "ZappFlow/1.0 (supply-network)" } } as any);
      if (!res.ok) return null;
      const arr = await res.json() as any[];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      try { db.prepare(`INSERT OR REPLACE INTO geocode_cache (key, lat, lng) VALUES (?, ?, ?)`).run(key, lat, lng); } catch (e) { /* noop */ }
      return { lat, lng };
    } catch (e) {
      console.error("[SupplyNetwork] Falha no geocoding", e);
      return null;
    }
  }

  /** Settings de rede da org (perfil de fornecedora). */
  static profile(orgId: string): any {
    const o = db.prepare(`
      SELECT business_name, is_network_supplier, network_categories,
             address_city, address_state, address_lat, address_lng,
             network_delivery_radius_km, network_min_order_amount, phone
      FROM organization_settings WHERE organization_id = ?
    `).get(orgId) as any || {};
    return {
      orgId,
      name: o.business_name || "",
      enabled: !!o.is_network_supplier,
      categories: o.network_categories || "",
      city: o.address_city || "",
      state: o.address_state || "",
      lat: o.address_lat ?? null,
      lng: o.address_lng ?? null,
      radiusKm: o.network_delivery_radius_km || 50,
      minOrderAmount: o.network_min_order_amount || 0,
      phone: o.phone || "",
    };
  }

  /** Salva o perfil de rede (geocoda em background se mudou a cidade). */
  static async saveProfile(orgId: string, patch: {
    enabled?: boolean; categories?: string; city?: string; state?: string;
    radiusKm?: number; minOrderAmount?: number;
  }): Promise<void> {
    const cur = this.profile(orgId);
    const enabled = patch.enabled != null ? patch.enabled : cur.enabled;
    const categories = patch.categories != null ? String(patch.categories || "").trim() : cur.categories;
    const city = patch.city != null ? String(patch.city || "").trim() : cur.city;
    const state = patch.state != null ? String(patch.state || "").trim() : cur.state;
    const radiusKm = Math.min(2000, Math.max(1, parseInt(String(patch.radiusKm ?? cur.radiusKm), 10) || 50));
    const minOrderAmount = Math.max(0, Number(patch.minOrderAmount ?? cur.minOrderAmount) || 0);

    // Geocoding quando a cidade muda (ou nunca foi geocodada).
    let lat = cur.lat, lng = cur.lng;
    if (city && (city !== cur.city || state !== cur.state || lat == null || lng == null)) {
      const g = await this.geocodeCity(city, state);
      if (g) { lat = g.lat; lng = g.lng; }
    }

    db.prepare(`
      UPDATE organization_settings SET
        is_network_supplier = ?, network_categories = ?,
        address_city = ?, address_state = ?, address_lat = ?, address_lng = ?,
        network_delivery_radius_km = ?, network_min_order_amount = ?
      WHERE organization_id = ?
    `).run(enabled ? 1 : 0, categories || null, city || null, state || null, lat, lng, radiusKm, minOrderAmount, orgId);
  }

  /**
   * Lista fornecedores DA REDE elegíveis para um comprador, filtrando por
   * categoria e raio (entrega máxima do fornecedor — ele decide até onde
   * entrega). Devolve já com distância calculada (se ambos têm geo).
   */
  static listSuppliers(buyerOrgId: string, opts: { categories?: string[]; maxDistanceKm?: number; query?: string } = {}): any[] {
    const buyer = this.profile(buyerOrgId);
    const rows = db.prepare(`
      SELECT organization_id AS org_id, business_name AS name, network_categories AS categories,
             address_city AS city, address_state AS state, address_lat AS lat, address_lng AS lng,
             network_delivery_radius_km AS radius_km, network_min_order_amount AS min_order
      FROM organization_settings
      WHERE COALESCE(is_network_supplier,0) = 1 AND organization_id != ?
    `).all(buyerOrgId) as any[];

    const wantCats = (opts.categories || []).map(c => String(c).toLowerCase().trim()).filter(Boolean);
    const q = (opts.query || "").toLowerCase().trim();

    const out: any[] = [];
    for (const r of rows) {
      const cats = String(r.categories || "").toLowerCase().split(",").map((x: string) => x.trim()).filter(Boolean);
      if (wantCats.length > 0 && cats.length > 0 && !wantCats.some(c => cats.includes(c))) continue;
      if (q && !`${(r.name || "").toLowerCase()} ${cats.join(" ")} ${(r.city || "").toLowerCase()}`.includes(q)) continue;

      let distance: number | null = null;
      if (buyer.lat != null && buyer.lng != null && r.lat != null && r.lng != null) {
        distance = this.distanceKm(buyer.lat, buyer.lng, r.lat, r.lng);
        // Respeita o raio que o FORNECEDOR atende (ele decide até onde entrega).
        if (distance > (r.radius_km || 0)) continue;
        // Respeita o filtro de distância pedido pelo comprador (se houver).
        if (opts.maxDistanceKm && distance > opts.maxDistanceKm) continue;
      }
      out.push({
        orgId: r.org_id,
        name: r.name || "Fornecedor",
        categories: r.categories || "",
        city: r.city || "",
        state: r.state || "",
        deliveryRadiusKm: r.radius_km || 0,
        minOrderAmount: r.min_order || 0,
        distanceKm: distance,
      });
    }
    // Ordena por distância (sem geo vai pro fim).
    out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    return out;
  }
}
