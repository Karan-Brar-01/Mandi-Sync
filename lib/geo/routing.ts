/**
 * OpenRouteService driving-route helpers.
 * Requires OPENROUTESERVICE_API_KEY (server-side only).
 */

export type LatLng = {
  lat: number;
  lng: number;
};

export type RouteGeometry = {
  type: "LineString";
  coordinates: [number, number][];
};

export type RouteDistance = {
  /** Road distance in kilometres */
  distanceKm: number;
  /** Estimated driving duration in minutes */
  durationMins: number;
  /** Optional GeoJSON LineString for map rendering (Phase 5) */
  geometry?: RouteGeometry | null;
};

const ORS_DIRECTIONS_URL =
  "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

function getOrsApiKey(): string {
  const key = process.env.OPENROUTESERVICE_API_KEY;
  if (!key) {
    throw new Error("Missing OPENROUTESERVICE_API_KEY");
  }
  return key;
}

/**
 * Fetch driving distance (km) and duration (mins) between two WGS84 points.
 * ORS expects coordinates as [longitude, latitude].
 */
export async function getRouteAndDistance(
  farmCoords: LatLng,
  mandiCoords: LatLng
): Promise<RouteDistance> {
  const apiKey = getOrsApiKey();

  const response = await fetch(ORS_DIRECTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json, application/geo+json",
    },
    body: JSON.stringify({
      coordinates: [
        [farmCoords.lng, farmCoords.lat],
        [mandiCoords.lng, mandiCoords.lat],
      ],
      instructions: false,
      elevation: false,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 429) {
      throw new Error(
        "OpenRouteService rate limit reached. Wait a minute and try again, or upgrade your ORS quota."
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "OpenRouteService rejected the API key. Check OPENROUTESERVICE_API_KEY."
      );
    }
    throw new Error(
      `OpenRouteService ${response.status}: ${body.slice(0, 240)}`
    );
  }

  const payload = (await response.json()) as {
    features?: Array<{
      properties?: {
        summary?: { distance?: number; duration?: number };
      };
      geometry?: RouteGeometry;
    }>;
    routes?: Array<{
      summary?: { distance?: number; duration?: number };
    }>;
  };

  const feature = payload.features?.[0];
  const summary =
    feature?.properties?.summary ?? payload.routes?.[0]?.summary;

  const distanceM = summary?.distance;
  const durationS = summary?.duration;

  if (
    typeof distanceM !== "number" ||
    typeof durationS !== "number" ||
    !Number.isFinite(distanceM) ||
    !Number.isFinite(durationS)
  ) {
    throw new Error("OpenRouteService response missing route summary");
  }

  return {
    distanceKm: distanceM / 1000,
    durationMins: durationS / 60,
    geometry: feature?.geometry ?? null,
  };
}
