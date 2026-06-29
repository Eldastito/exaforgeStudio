/**
 * Categorias do Prospect AI — fonte única de verdade compartilhada entre a
 * descoberta (que monta a query do OpenStreetMap) e o score (que mede o encaixe
 * da conta com o ICP). Traduz termos comuns em PT-BR para etiquetas OSM, para o
 * empresário não precisar saber nada de OpenStreetMap.
 */

// Conjunto padrão (quando não há categoria nem ICP que defina segmento): cobre a
// maioria dos negócios locais — lojas, escritórios, serviços, saúde, alimentação.
export const DEFAULT_CATS = [
  "shop", "office", "craft", "healthcare",
  "amenity=restaurant", "amenity=cafe", "amenity=bar", "amenity=fast_food",
  "amenity=pharmacy", "amenity=clinic", "amenity=doctors", "amenity=dentist",
  "amenity=veterinary", "amenity=bank", "amenity=fuel", "amenity=school",
  "amenity=driving_school", "amenity=gym", "tourism=hotel", "tourism=guest_house",
  "leisure=fitness_centre",
];

// Chaves OSM válidas que o usuário pode digitar direto.
export const OSM_KEYS = new Set(["shop", "office", "craft", "amenity", "healthcare", "leisure", "tourism", "club"]);

// Termos comuns em PT-BR → etiquetas OSM.
export const PT_CATEGORY_MAP: Record<string, string[]> = {
  clinica: ["amenity=clinic", "amenity=doctors", "healthcare"],
  consultorio: ["amenity=doctors", "amenity=dentist", "healthcare"],
  medico: ["amenity=doctors", "healthcare"],
  dentista: ["amenity=dentist"],
  hospital: ["amenity=hospital"],
  laboratorio: ["healthcare=laboratory", "amenity=clinic"],
  farmacia: ["amenity=pharmacy"],
  drogaria: ["amenity=pharmacy"],
  veterinaria: ["amenity=veterinary"], veterinario: ["amenity=veterinary"],
  petshop: ["shop=pet"], pet: ["shop=pet"],
  restaurante: ["amenity=restaurant"], lanchonete: ["amenity=fast_food"],
  cafe: ["amenity=cafe"], bar: ["amenity=bar"], padaria: ["shop=bakery"],
  hotel: ["tourism=hotel"], pousada: ["tourism=guest_house"],
  academia: ["leisure=fitness_centre", "amenity=gym"],
  salao: ["shop=hairdresser", "shop=beauty"], barbearia: ["shop=hairdresser"],
  estetica: ["shop=beauty", "amenity=clinic"],
  escritorio: ["office"], advogado: ["office=lawyer"], contador: ["office=accountant"],
  imobiliaria: ["office=estate_agent"], escola: ["amenity=school"],
  autoescola: ["amenity=driving_school"], oficina: ["shop=car_repair", "craft"],
  loja: ["shop"], mercado: ["shop=supermarket", "shop=convenience"], supermercado: ["shop=supermarket"],
};

export function norm(s: any): string {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

/**
 * Traduz "categorias" (texto livre PT-BR) → etiquetas OSM. Aceita chave OSM
 * (shop), par chave=valor (amenity=restaurant) e termos comuns (clínica…).
 * Termos desconhecidos são ignorados (não viram filtro morto).
 */
export function resolveCategories(raw: string): string[] {
  const out = new Set<string>();
  for (const term of String(raw || "").split(",").map(norm).filter(Boolean)) {
    if (term.includes("=")) { out.add(term); continue; }
    if (OSM_KEYS.has(term)) { out.add(term); continue; }
    const mapped = PT_CATEGORY_MAP[term] || PT_CATEGORY_MAP[term.replace(/s$/, "")];
    if (mapped) mapped.forEach(m => out.add(m));
  }
  return [...out];
}

/**
 * Segmentos esperados de um ICP/campanha (para medir encaixe da conta): pega o
 * VALOR de cada etiqueta resolvida (amenity=clinic → "clinic"; healthcare →
 * "healthcare"), normalizado com "_". Vazio = sem segmento definido (neutro).
 */
export function expectedSegments(raw: string): Set<string> {
  const set = new Set<string>();
  for (const cat of resolveCategories(raw)) {
    const val = cat.includes("=") ? cat.split("=").slice(1).join("=") : cat;
    const token = norm(val).replace(/\s+/g, "_");
    if (token) set.add(token);
  }
  return set;
}
