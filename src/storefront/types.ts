// Tipos compartilhados da vitrine pública (Glass Toggle).

export type SaleMode = 'unit' | 'slice' | 'size' | 'weight' | 'volume';
export type Mode = 'day' | 'night';

export interface SaleOptions {
  sizes?: string[];
  steps?: number[];
}

export interface Product {
  id: string;
  slug?: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  sale_mode: SaleMode;
  sale_options: SaleOptions;
  featured: boolean;
  available: boolean;
  images: string[];
}

export interface Store {
  slug: string;
  title: string;
  subtitle: string;
  logo_url: string | null;
  banner_url: string | null;
  accent_color: string;
  default_mode: Mode;
}

export interface Customer {
  name: string;
}

export interface StoreCollection {
  id: string;
  title: string;
  productIds: string[];
}

export interface ReservableResource {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  capacity: number;
  reservation_unit: string; // night | day | hour | slot
}

export interface StoreResponse {
  store: Store;
  customer: Customer | null;
  products: Product[];
  collections?: StoreCollection[];
  resources?: ReservableResource[];
}

// Opção escolhida pelo cliente para um item.
export type ChosenOption =
  | { type: 'size'; value: string }
  | { type: 'weight'; grams: number }
  | { type: 'volume'; ml: number }
  | null;

export interface CartItem {
  // Chave única por produto + opção (para permitir variações distintas).
  key: string;
  productId: string;
  name: string;
  image: string | null;
  // preço unitário já calculado (considerando peso/volume).
  unitPrice: number;
  quantity: number;
  optionLabel: string;
  option: ChosenOption;
}

export interface OrderPayment {
  method: 'mercadopago' | 'pix_manual' | 'none';
  pix?: { qrCode: string; qrCodeBase64: string; ticketUrl: string };
  manual?: { key: string; name: string; instructions: string };
}

export interface OrderResponse {
  ok: boolean;
  orderId: string;
  total: number;
  whatsappUrl: string | null;
  payment?: OrderPayment;
}
