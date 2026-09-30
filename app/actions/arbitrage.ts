"use server";

import {
  ArbitrageEmptyError,
  calculateArbitrage,
  type ArbitrageResult,
} from "@/lib/analytics/arbitrage";

export type ArbitrageFormInput = {
  lat: number;
  lng: number;
  commodity: string;
  cropYieldQuintals: number;
  transportCostPerKm: number;
};

export type ArbitrageActionResult =
  | { ok: true; results: ArbitrageResult[]; farm: { lat: number; lng: number } }
  | { ok: false; error: string; code?: "NO_MANDIS" | "NO_PRICES" | "RATE_LIMIT" | "VALIDATION" | "UNKNOWN" };

const ALLOWED_COMMODITIES = new Set(["Onion", "Tomato", "Potato"]);

function classifyError(message: string): "RATE_LIMIT" | "UNKNOWN" {
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "RATE_LIMIT";
  }
  return "UNKNOWN";
}

/**
 * Server Action: run the arbitrage engine and return ranked mandis + farm point.
 */
export async function runArbitrage(
  input: ArbitrageFormInput
): Promise<ArbitrageActionResult> {
  try {
    const { lat, lng, commodity, cropYieldQuintals, transportCostPerKm } =
      input;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return {
        ok: false,
        code: "VALIDATION",
        error: "Enter a valid farm latitude and longitude.",
      };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return {
        ok: false,
        code: "VALIDATION",
        error: "Farm coordinates are out of range.",
      };
    }
    if (!ALLOWED_COMMODITIES.has(commodity)) {
      return {
        ok: false,
        code: "VALIDATION",
        error: "Choose Onion, Tomato, or Potato.",
      };
    }
    if (!Number.isFinite(cropYieldQuintals) || cropYieldQuintals <= 0) {
      return {
        ok: false,
        code: "VALIDATION",
        error: "Yield must be a positive number of quintals.",
      };
    }
    if (!Number.isFinite(transportCostPerKm) || transportCostPerKm < 0) {
      return {
        ok: false,
        code: "VALIDATION",
        error: "Transport cost per km must be zero or greater.",
      };
    }

    const results = await calculateArbitrage(
      { lat, lng, commodity },
      cropYieldQuintals,
      transportCostPerKm
    );

    return { ok: true, results, farm: { lat, lng } };
  } catch (err) {
    if (err instanceof ArbitrageEmptyError) {
      return { ok: false, code: err.code, error: err.message };
    }

    const message =
      err instanceof Error
        ? err.message
        : "Something went wrong running arbitrage.";
    const code = classifyError(message);

    return { ok: false, code, error: message };
  }
}
