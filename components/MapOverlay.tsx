"use client";

import { useEffect, useMemo } from "react";
import L from "leaflet";
import {
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";

import type { ArbitrageResult } from "@/lib/analytics/arbitrage";
import type { RouteGeometry } from "@/lib/geo/routing";

import "leaflet/dist/leaflet.css";

export type MapOverlayProps = {
  farm: { lat: number; lng: number };
  mandis: ArbitrageResult[];
  /** ORS geometry for the #1 route; falls back to first mandi's routeGeometry */
  routeGeometry?: RouteGeometry | null;
};

const HOME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

const STORE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5"/><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.312l1.826-3.348A2.5 2.5 0 0 1 6.4 2h11.2a2.5 2.5 0 0 1 2.218 1.25l1.826 3.348a2.5 2.5 0 0 1-3.77 3.312"/><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05"/></svg>`;

function divIcon(html: string) {
  return L.divIcon({
    className: "mandi-sync-marker",
    html,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -34],
  });
}

function markerHtml(iconMarkup: string, tone: "farm" | "best" | "other") {
  const bg =
    tone === "farm" ? "#065f46" : tone === "best" ? "#047857" : "#334155";
  return `<div style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9999px;background:${bg};color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.28);border:2px solid #fff">${iconMarkup}</div>`;
}

function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap();

  useEffect(() => {
    if (positions.length === 0) return;
    const bounds = L.latLngBounds(positions);
    map.fitBounds(bounds.pad(0.18), { animate: false });
  }, [map, positions]);

  return null;
}

/**
 * Client-only map: farm, top mandis, and polyline to the #1 market.
 * Import via next/dynamic with `{ ssr: false }`.
 */
export default function MapOverlay({
  farm,
  mandis,
  routeGeometry,
}: MapOverlayProps) {
  const top = useMemo(() => mandis.slice(0, 3), [mandis]);
  const best = top[0];

  const homeIcon = useMemo(
    () => divIcon(markerHtml(HOME_SVG, "farm")),
    []
  );

  const bestIcon = useMemo(
    () => divIcon(markerHtml(STORE_SVG, "best")),
    []
  );

  const otherIcon = useMemo(
    () => divIcon(markerHtml(STORE_SVG, "other")),
    []
  );

  const geometry = routeGeometry ?? best?.routeGeometry ?? null;

  const routeLatLngs: [number, number][] = useMemo(() => {
    if (!geometry?.coordinates?.length) {
      if (!best) return [];
      return [
        [farm.lat, farm.lng],
        [best.lat, best.lng],
      ];
    }
    return geometry.coordinates.map(
      ([lng, lat]) => [lat, lng] as [number, number]
    );
  }, [geometry, farm.lat, farm.lng, best]);

  const fitKey = useMemo(
    () =>
      [
        farm.lat,
        farm.lng,
        ...top.map((m) => `${m.mandiId}:${m.lat}:${m.lng}`),
        routeLatLngs.length,
      ].join("|"),
    [farm.lat, farm.lng, top, routeLatLngs.length]
  );

  const fitPositions: [number, number][] = useMemo(() => {
    const pts: [number, number][] = [[farm.lat, farm.lng]];
    for (const m of top) pts.push([m.lat, m.lng]);
    for (const p of routeLatLngs) pts.push(p);
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fitKey captures identity
  }, [fitKey]);

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <MapContainer
        center={[farm.lat, farm.lng]}
        zoom={9}
        scrollWheelZoom={false}
        className="z-0 h-64 w-full sm:h-80"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds positions={fitPositions} />

        <Marker position={[farm.lat, farm.lng]} icon={homeIcon}>
          <Popup>Your farm</Popup>
        </Marker>

        {top.map((mandi, index) => (
          <Marker
            key={mandi.mandiId}
            position={[mandi.lat, mandi.lng]}
            icon={index === 0 ? bestIcon : otherIcon}
          >
            <Popup>
              #{index + 1} {mandi.marketName}
            </Popup>
          </Marker>
        ))}

        {routeLatLngs.length >= 2 ? (
          <Polyline
            positions={routeLatLngs}
            pathOptions={{
              color: "#047857",
              weight: 4,
              opacity: 0.9,
              lineJoin: "round",
            }}
          />
        ) : null}
      </MapContainer>
      <p className="text-muted-foreground bg-card px-3 py-2 text-xs">
        Green line = drive to #
        {best ? `1 ${best.marketName}` : "best mandi"}
        {geometry ? " (OpenRouteService)" : " (straight-line fallback)"}
      </p>
    </div>
  );
}
