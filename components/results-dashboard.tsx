"use client";

import dynamic from "next/dynamic";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ArbitrageResult } from "@/lib/analytics/arbitrage";

const MapOverlay = dynamic(() => import("@/components/MapOverlay"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const km = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 1,
});

type ResultsDashboardProps = {
  farm: { lat: number; lng: number };
  results: ArbitrageResult[];
};

export function ResultsDashboard({ farm, results }: ResultsDashboardProps) {
  const top3 = results.slice(0, 3);

  if (top3.length === 0) return null;

  const bestRoute = top3[0]?.routeGeometry ?? null;

  return (
    <section
      id="results"
      aria-labelledby="results-heading"
      className="mx-auto w-full max-w-lg space-y-4 px-4 pb-16 sm:max-w-2xl sm:px-6"
    >
      <div className="space-y-1">
        <h2
          id="results-heading"
          className="text-xl font-semibold tracking-tight sm:text-2xl"
        >
          Top profitable mandis
        </h2>
        <p className="text-muted-foreground text-sm">
          Ranked by net profit after driving costs — best first.
        </p>
      </div>

      <MapOverlay farm={farm} mandis={top3} routeGeometry={bestRoute} />

      <ol className="grid gap-4">
        {top3.map((mandi, index) => (
          <li key={mandi.mandiId}>
            <Card className="bg-card/90 backdrop-blur-sm">
              <CardHeader className="border-b">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <CardTitle className="truncate text-base sm:text-lg">
                      {mandi.marketName}
                    </CardTitle>
                    <CardDescription>
                      {mandi.district}, {mandi.state} ·{" "}
                      {km.format(mandi.drivingDistanceKm)} km drive
                      {mandi.durationMins > 0
                        ? ` · ~${Math.round(mandi.durationMins)} min`
                        : ""}
                    </CardDescription>
                  </div>
                  <Badge variant={index === 0 ? "default" : "secondary"}>
                    #{index + 1}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3 pt-(--card-spacing)">
                <MetricRow
                  label="Gross expected revenue"
                  value={inr.format(mandi.grossRevenue)}
                  hint={`${inr.format(mandi.effectivePrice)}/qtl${
                    mandi.priceIsForecasted ? " · forecast" : ""
                  }`}
                />
                <MetricRow
                  label="Transport cost penalty"
                  value={`− ${inr.format(mandi.transportCost)}`}
                  muted
                />
                <div className="rounded-lg bg-emerald-50 px-3 py-3 ring-1 ring-emerald-200/80 dark:bg-emerald-950/40 dark:ring-emerald-900">
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Final net profit
                  </p>
                  <p className="mt-0.5 text-2xl font-semibold tracking-tight text-emerald-700 tabular-nums dark:text-emerald-400">
                    {inr.format(mandi.netProfit)}
                  </p>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ResultsSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading arbitrage results"
      className="mx-auto w-full max-w-lg space-y-4 px-4 pb-16 sm:max-w-2xl sm:px-6"
    >
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <MapSkeleton />
      {[0, 1, 2].map((i) => (
        <Card key={i} className="bg-card/90">
          <CardHeader className="border-b space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </CardHeader>
          <CardContent className="grid gap-3 pt-(--card-spacing)">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function MapSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      <Skeleton className="h-64 w-full rounded-none sm:h-80" />
      <div className="bg-card px-3 py-2">
        <Skeleton className="h-3 w-56" />
      </div>
    </div>
  );
}

function MetricRow({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <div className="min-w-0">
        <p className="text-muted-foreground text-sm">{label}</p>
        {hint ? (
          <p className="text-muted-foreground/80 truncate text-xs">{hint}</p>
        ) : null}
      </div>
      <p
        className={
          muted
            ? "text-muted-foreground shrink-0 font-medium tabular-nums"
            : "shrink-0 font-medium tabular-nums"
        }
      >
        {value}
      </p>
    </div>
  );
}
