/**
 * Mandi-Sync profit arbitrage engine.
 *
 * GrossRevenue  = effectivePricePerQuintal × cropYieldQuintals
 * TransportCost = drivingDistanceKm × transportCostPerKm
 * NetProfit     = GrossRevenue − TransportCost
 */

import { createClient } from "@/lib/supabase/server";
import {
  getRouteAndDistance,
  type LatLng,
  type RouteGeometry,
} from "@/lib/geo/routing";
import type { MandiWithinRadius } from "@/types/database";

export type FarmLocation = LatLng & {
  /** Agmarknet commodity name, e.g. "Onion" */
  commodity: string;
  /** Search radius in km (default: DEFAULT_RADIUS_KM or 100) */
  radiusKm?: number;
};

export type ArbitrageResult = {
  mandiId: string;
  state: string;
  district: string;
  marketName: string;
  lat: number;
  lng: number;
  /** Crow-fly distance from PostGIS RPC (km) */
  crowFlyDistanceKm: number;
  /** Driving distance from OpenRouteService (km) */
  drivingDistanceKm: number;
  durationMins: number;
  /** ₹ / quintal used for revenue (forecast preferred) */
  effectivePrice: number;
  priceIsForecasted: boolean;
  priceDate: string;
  variety: string | null;
  grossRevenue: number;
  transportCost: number;
  netProfit: number;
  /** ORS GeoJSON LineString [lng, lat][] for map polylines */
  routeGeometry: RouteGeometry | null;
};

export class ArbitrageEmptyError extends Error {
  readonly code: "NO_MANDIS" | "NO_PRICES";

  constructor(code: "NO_MANDIS" | "NO_PRICES", message: string) {
    super(message);
    this.name = "ArbitrageEmptyError";
    this.code = code;
  }
}

type PriceRow = {
  mandi_id: string;
  modal_price: number;
  variety: string | null;
  price_date: string;
  is_forecasted: boolean;
};

function tomorrowIsoDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function defaultRadiusKm(): number {
  const raw = process.env.DEFAULT_RADIUS_KM;
  const parsed = raw ? Number(raw) : 100;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

/**
 * Pick the best (highest) predicted/modal price row for a mandi.
 */
function pickBestPrice(rows: PriceRow[]): PriceRow | null {
  if (rows.length === 0) return null;
  return rows.reduce((best, row) =>
    row.modal_price > best.modal_price ? row : best
  );
}

async function fetchPredictedPrices(
  mandiIds: string[],
  commodity: string
): Promise<Map<string, PriceRow>> {
  const supabase = await createClient();
  const tomorrow = tomorrowIsoDate();
  const byMandi = new Map<string, PriceRow>();

  if (mandiIds.length === 0) return byMandi;

  // Prefer Prophet forecast rows for tomorrow.
  const { data: forecasts, error: forecastError } = await supabase
    .from("mandi_prices")
    .select("mandi_id, modal_price, variety, price_date, is_forecasted")
    .in("mandi_id", mandiIds)
    .eq("commodity", commodity)
    .eq("is_forecasted", true)
    .eq("price_date", tomorrow);

  if (forecastError) {
    throw new Error(`Failed to load forecasts: ${forecastError.message}`);
  }

  const forecastRows = (forecasts ?? []) as PriceRow[];
  const groupedForecast = new Map<string, PriceRow[]>();
  for (const row of forecastRows) {
    const list = groupedForecast.get(row.mandi_id) ?? [];
    list.push(row);
    groupedForecast.set(row.mandi_id, list);
  }
  for (const [mandiId, rows] of groupedForecast) {
    const best = pickBestPrice(rows);
    if (best) byMandi.set(mandiId, best);
  }

  // Fallback: latest observed (non-forecast) modal price for mandis missing a forecast.
  const missing = mandiIds.filter((id) => !byMandi.has(id));
  if (missing.length === 0) return byMandi;

  const { data: observed, error: observedError } = await supabase
    .from("mandi_prices")
    .select("mandi_id, modal_price, variety, price_date, is_forecasted")
    .in("mandi_id", missing)
    .eq("commodity", commodity)
    .eq("is_forecasted", false)
    .order("price_date", { ascending: false });

  if (observedError) {
    throw new Error(`Failed to load observed prices: ${observedError.message}`);
  }

  const seen = new Set<string>();
  for (const row of (observed ?? []) as PriceRow[]) {
    if (seen.has(row.mandi_id)) continue;
    seen.add(row.mandi_id);
    byMandi.set(row.mandi_id, row);
  }

  return byMandi;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Rank nearby mandis by net profit after transport costs.
 *
 * @param farmLocation - Farm lat/lng + commodity (+ optional radiusKm)
 * @param cropYieldQuintals - Quantity to sell (quintals)
 * @param transportCostPerKm - Truck fuel/cost rate (₹ / km)
 */
export async function calculateArbitrage(
  farmLocation: FarmLocation,
  cropYieldQuintals: number,
  transportCostPerKm: number
): Promise<ArbitrageResult[]> {
  if (!Number.isFinite(cropYieldQuintals) || cropYieldQuintals <= 0) {
    throw new Error("cropYieldQuintals must be a positive number");
  }
  if (!Number.isFinite(transportCostPerKm) || transportCostPerKm < 0) {
    throw new Error("transportCostPerKm must be a non-negative number");
  }

  const radiusKm = farmLocation.radiusKm ?? defaultRadiusKm();
  const supabase = await createClient();

  const { data: nearby, error: rpcError } = await supabase.rpc(
    "get_mandis_within_radius",
    {
      lat: farmLocation.lat,
      lng: farmLocation.lng,
      radius_km: radiusKm,
    }
  );

  if (rpcError) {
    throw new Error(`get_mandis_within_radius failed: ${rpcError.message}`);
  }

  const mandis = (nearby ?? []) as MandiWithinRadius[];
  if (mandis.length === 0) {
    throw new ArbitrageEmptyError(
      "NO_MANDIS",
      `No mandis found within ${radiusKm} km of your farm.`
    );
  }

  const prices = await fetchPredictedPrices(
    mandis.map((m) => m.id),
    farmLocation.commodity
  );

  const candidates = mandis.filter((m) => prices.has(m.id));
  if (candidates.length === 0) {
    throw new ArbitrageEmptyError(
      "NO_PRICES",
      `Found ${mandis.length} mandi(s) nearby, but none have ${farmLocation.commodity} price data yet.`
    );
  }

  const scored = await mapPool(candidates, 4, async (mandi) => {
    const price = prices.get(mandi.id)!;
    const route = await getRouteAndDistance(
      { lat: farmLocation.lat, lng: farmLocation.lng },
      { lat: mandi.lat, lng: mandi.lng }
    );

    const effectivePrice = Number(price.modal_price);
    const grossRevenue = effectivePrice * cropYieldQuintals;
    const transportCost = route.distanceKm * transportCostPerKm;
    const netProfit = grossRevenue - transportCost;

    const result: ArbitrageResult = {
      mandiId: mandi.id,
      state: mandi.state,
      district: mandi.district,
      marketName: mandi.market_name,
      lat: mandi.lat,
      lng: mandi.lng,
      crowFlyDistanceKm: mandi.distance_km,
      drivingDistanceKm: route.distanceKm,
      durationMins: route.durationMins,
      effectivePrice,
      priceIsForecasted: price.is_forecasted,
      priceDate: price.price_date,
      variety: price.variety,
      grossRevenue,
      transportCost,
      netProfit,
      routeGeometry: route.geometry ?? null,
    };
    return result;
  });

  return scored.sort((a, b) => b.netProfit - a.netProfit);
}
