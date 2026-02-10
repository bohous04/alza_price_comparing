export interface AlzaAccount {
  email: string;
  password: string;
  label: string;
}

export interface PriceResult {
  label: string;
  price: number;
  priceFormatted: string;
  available: true;
}

export interface PriceError {
  label: string;
  price: null;
  priceFormatted: null;
  available: false;
  error: string;
}

export type AccountResult = PriceResult | PriceError;

export interface CompareResponse {
  product: string;
  url: string;
  accounts: AccountResult[];
  cheapest: string | null;
  difference: number | null;
  differenceFormatted: string | null;
}

export interface ErrorResponse {
  error: string;
  message: string;
}

export interface ScrapedData {
  product: string;
  price: number;
  priceFormatted: string;
}

export type SessionStatus = "logged_in" | "verification_required" | "failed" | "not_started";

export interface AccountSessionStatus {
  label: string;
  status: SessionStatus;
  phone?: string;
  error?: string;
}

export interface AuthInitResponse {
  accounts: AccountSessionStatus[];
}

export interface AuthVerifyRequest {
  label: string;
  code: string;
}
