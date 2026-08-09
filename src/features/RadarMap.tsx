import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * RadarMap — mapa Leaflet do Radar B2B (Fatia 2). Plota o ponto/raio da busca e
 * um marcador por empresa (coordenada herdada do CEP, vinda da Fatia 1). Clicar
 * num marcador foca a empresa (sincroniza com a lista via onFocus); mudar o foco
 * de fora (clique na lista) destaca e centraliza o marcador.
 *
 * Leaflet PURO (sem react-leaflet) de propósito: o app é React 19 e o binding
 * declarativo traria fricção de peer-deps. Usamos divIcon (HTML inline) em vez
 * dos PNGs padrão do Leaflet — assim não há problema de bundling de asset no Vite.
 *
 * Tiles: OpenStreetMap público (grátis). Para volume alto de produção, trocar por
 * um provedor com plano dedicado (MapTiler/Stadia/Carto) é só mudar a URL abaixo.
 */

export interface RadarMapEmpresa {
  cnpj: string;
  razaoSocial: string;
  lat: number | null;
  lon: number | null;
  distanciaKm: number | null;
}

interface Props {
  center: { lat: number; lon: number; display?: string } | null;
  radiusKm: number;
  empresas: RadarMapEmpresa[];
  focusedCnpj: string | null;
  onFocus: (cnpj: string) => void;
  // Overlay de fibra (Fatia 3). GeoJSON do traçado da rede do provedor, servido
  // por /api/radar-b2b/fiber. Fica numa camada separada (não é limpa quando as
  // empresas são redesenhadas) e sob os marcadores (overlayPane < markerPane),
  // então os pontos das empresas seguem clicáveis por cima da fibra.
  fiber?: any | null;
  showFiber?: boolean;
}

const FIBER_COLOR = '#22d3ee';

const escapeHtml = (s: string) =>
  String(s || '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]));

const dotIcon = (active: boolean) => {
  const d = active ? 16 : 11;
  return L.divIcon({
    className: 'radar-dot',
    html: `<span style="display:block;width:${d}px;height:${d}px;border-radius:50%;background:${active ? '#f59e0b' : '#10b981'};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></span>`,
    iconSize: [d, d],
    iconAnchor: [d / 2, d / 2],
  });
};

const centerIcon = L.divIcon({
  className: 'radar-center',
  html: `<span style="display:block;width:14px;height:14px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#6366f1;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.35)"></span>`,
  iconSize: [14, 14],
  iconAnchor: [7, 14],
});

export function RadarMap({ center, radiusKm, empresas, focusedCnpj, onFocus, fiber, showFiber = true }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fiberLayerRef = useRef<L.GeoJSON | null>(null);
  const markersRef = useRef<Record<string, L.Marker>>({});
  // onFocus via ref pra o handler de clique não recriar o mapa a cada render.
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  // Inicializa o mapa uma vez.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true }).setView([-22.92, -43.2], 11);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => {
      clearTimeout(t);
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      fiberLayerRef.current = null;
      markersRef.current = {};
    };
  }, []);

  // Overlay de fibra: reconstrói a camada quando o GeoJSON muda. Não entra no
  // redraw das empresas de propósito — o traçado é fixo e não deve piscar a cada
  // busca. Fica no overlayPane (abaixo dos marcadores) por padrão do Leaflet.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (fiberLayerRef.current) { map.removeLayer(fiberLayerRef.current); fiberLayerRef.current = null; }
    if (!fiber || !fiber.features?.length) return;
    const layer = L.geoJSON(fiber, {
      style: (feat: any) => ({
        color: feat?.properties?.color || FIBER_COLOR,
        weight: 3,
        opacity: 0.85,
        fillColor: feat?.properties?.color || FIBER_COLOR,
        fillOpacity: 0.12,
      }),
      pointToLayer: (feat: any, latlng: any) =>
        L.circleMarker(latlng, { radius: 4, color: feat?.properties?.color || FIBER_COLOR, weight: 2, fillColor: '#0891b2', fillOpacity: 0.9 }),
      onEachFeature: (feat: any, lyr: any) => {
        const n = feat?.properties?.name;
        if (n) lyr.bindPopup(`<b>Rede de fibra</b><br>${escapeHtml(String(n))}`);
      },
    });
    fiberLayerRef.current = layer;
    if (showFiber) layer.addTo(map);
    // showFiber é aplicado aqui na criação e no efeito de toggle abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fiber]);

  // Toggle mostrar/esconder fibra sem reconstruir a camada.
  useEffect(() => {
    const map = mapRef.current, layer = fiberLayerRef.current;
    if (!map || !layer) return;
    if (showFiber) { if (!map.hasLayer(layer)) layer.addTo(map); }
    else if (map.hasLayer(layer)) map.removeLayer(layer);
  }, [showFiber, fiber]);

  // Redesenha ponto/raio/empresas quando os dados mudam.
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markersRef.current = {};
    const pts: L.LatLngExpression[] = [];

    if (center) {
      const c: L.LatLngExpression = [center.lat, center.lon];
      L.circle(c, { radius: radiusKm * 1000, color: '#6366f1', weight: 1, fillColor: '#6366f1', fillOpacity: 0.07 }).addTo(layer);
      L.marker(c, { icon: centerIcon, zIndexOffset: 1000 })
        .addTo(layer)
        .bindPopup(`<b>Ponto da busca</b>${center.display ? `<br>${escapeHtml(center.display)}` : ''}`);
      pts.push(c);
    }
    for (const e of empresas) {
      if (e.lat == null || e.lon == null) continue;
      const ll: L.LatLngExpression = [e.lat, e.lon];
      const m = L.marker(ll, { icon: dotIcon(e.cnpj === focusedCnpj) }).addTo(layer);
      m.bindPopup(`<b>${escapeHtml(e.razaoSocial)}</b>${e.distanciaKm != null ? `<br>${e.distanciaKm} km` : ''}`);
      m.on('click', () => onFocusRef.current(e.cnpj));
      markersRef.current[e.cnpj] = m;
      pts.push(ll);
    }
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 16 });
    const t = setTimeout(() => map.invalidateSize(), 60);
    return () => clearTimeout(t);
    // focusedCnpj de fora do redraw: o destaque é tratado no efeito abaixo (não
    // queremos redesenhar tudo a cada clique de foco).

  }, [center, radiusKm, empresas]);

  // Mudança de foco (clique na lista ou no marcador): re-estiliza e centraliza.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const cnpj of Object.keys(markersRef.current)) markersRef.current[cnpj].setIcon(dotIcon(cnpj === focusedCnpj));
    if (focusedCnpj) {
      const m = markersRef.current[focusedCnpj];
      if (m) { map.panTo(m.getLatLng()); m.openPopup(); }
    }
  }, [focusedCnpj]);

  return <div ref={elRef} className="w-full h-full" style={{ minHeight: 320 }} />;
}
