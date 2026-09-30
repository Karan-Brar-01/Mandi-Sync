"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Crosshair, Loader2, MapPinned } from "lucide-react";

import { runArbitrage } from "@/app/actions/arbitrage";
import {
  ResultsDashboard,
  ResultsSkeleton,
} from "@/components/results-dashboard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ArbitrageResult } from "@/lib/analytics/arbitrage";

const COMMODITIES = ["Onion", "Tomato", "Potato"] as const;

type UiError = {
  message: string;
  code?: "NO_MANDIS" | "NO_PRICES" | "RATE_LIMIT" | "VALIDATION" | "UNKNOWN";
};

export function ArbitrageWorkbench() {
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [commodity, setCommodity] =
    useState<(typeof COMMODITIES)[number]>("Onion");
  const [yieldQuintals, setYieldQuintals] = useState("50");
  const [costPerKm, setCostPerKm] = useState("25");
  const [geoStatus, setGeoStatus] = useState<string | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [results, setResults] = useState<ArbitrageResult[] | null>(null);
  const [farm, setFarm] = useState<{ lat: number; lng: number } | null>(null);
  const [pending, startTransition] = useTransition();

  function useMyLocation() {
    setGeoStatus(null);
    setError(null);

    if (!navigator.geolocation) {
      setGeoStatus("Geolocation is not supported in this browser.");
      return;
    }

    setGeoStatus("Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(5));
        setLng(pos.coords.longitude.toFixed(5));
        setGeoStatus("Location captured from your device.");
      },
      (err) => {
        setGeoStatus(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied — enter coordinates manually."
            : "Could not read location — enter coordinates manually."
        );
      },
      { enableHighAccuracy: true, timeout: 12_000 }
    );
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResults(null);
    setFarm(null);

    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    const parsedYield = Number(yieldQuintals);
    const parsedCost = Number(costPerKm);

    startTransition(async () => {
      const outcome = await runArbitrage({
        lat: parsedLat,
        lng: parsedLng,
        commodity,
        cropYieldQuintals: parsedYield,
        transportCostPerKm: parsedCost,
      });

      if (!outcome.ok) {
        setResults(null);
        setFarm(null);
        setError({ message: outcome.error, code: outcome.code });
        return;
      }

      setFarm(outcome.farm);
      setResults(outcome.results);
      requestAnimationFrame(() => {
        document.getElementById("results")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    });
  }

  return (
    <>
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_oklch(0.92_0.04_145)_0%,_transparent_55%),linear-gradient(180deg,_oklch(0.97_0.02_145)_0%,_oklch(0.99_0.01_100)_45%,_oklch(1_0_0)_100%)]"
        />
        <div className="relative mx-auto flex w-full max-w-lg flex-col gap-8 px-4 pt-10 pb-10 sm:max-w-2xl sm:px-6 sm:pt-14">
          <header className="space-y-3">
            <div className="flex items-center gap-2 text-emerald-800">
              <MapPinned className="size-7 shrink-0" aria-hidden />
              <p className="font-[family-name:var(--font-geist-sans)] text-2xl font-semibold tracking-tight sm:text-3xl">
                Mandi-Sync
              </p>
            </div>
            <h1 className="max-w-xl text-balance text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Sell where the road still pays
            </h1>
            <p className="text-muted-foreground max-w-md text-pretty text-base">
              Compare nearby mandis by net profit after fuel — not just the
              sticker price at the gate.
            </p>
          </header>

          <Card className="bg-card/95 shadow-sm backdrop-blur-sm">
            <CardHeader>
              <CardTitle>Find your best mandi</CardTitle>
              <CardDescription>
                Use your farm location, crop, yield, and truck cost per km.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} className="grid gap-5">
                <div className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="farm-lat">Farm location</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={useMyLocation}
                      disabled={pending}
                    >
                      <Crosshair data-icon="inline-start" />
                      Use my location
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1.5">
                      <Label
                        htmlFor="farm-lat"
                        className="text-muted-foreground text-xs font-normal"
                      >
                        Latitude
                      </Label>
                      <Input
                        id="farm-lat"
                        name="lat"
                        inputMode="decimal"
                        placeholder="20.01120"
                        value={lat}
                        onChange={(e) => setLat(e.target.value)}
                        required
                        className="h-10"
                        autoComplete="off"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label
                        htmlFor="farm-lng"
                        className="text-muted-foreground text-xs font-normal"
                      >
                        Longitude
                      </Label>
                      <Input
                        id="farm-lng"
                        name="lng"
                        inputMode="decimal"
                        placeholder="73.79080"
                        value={lng}
                        onChange={(e) => setLng(e.target.value)}
                        required
                        className="h-10"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  {geoStatus ? (
                    <p className="text-muted-foreground text-xs">{geoStatus}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Tip: Nashik belt often works with 20.01, 73.79
                    </p>
                  )}
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="commodity">Commodity</Label>
                  <Select
                    value={commodity}
                    onValueChange={(value) => {
                      if (
                        value === "Onion" ||
                        value === "Tomato" ||
                        value === "Potato"
                      ) {
                        setCommodity(value);
                      }
                    }}
                  >
                    <SelectTrigger
                      id="commodity"
                      className="h-10 w-full min-w-0"
                    >
                      <SelectValue placeholder="Select crop" />
                    </SelectTrigger>
                    <SelectContent align="start" className="w-(--anchor-width)">
                      {COMMODITIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="yield">Total yield (quintals)</Label>
                    <Input
                      id="yield"
                      name="yield"
                      type="number"
                      min={0.1}
                      step="any"
                      inputMode="decimal"
                      value={yieldQuintals}
                      onChange={(e) => setYieldQuintals(e.target.value)}
                      required
                      className="h-10"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="cost">Transport cost per km (₹)</Label>
                    <Input
                      id="cost"
                      name="cost"
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      value={costPerKm}
                      onChange={(e) => setCostPerKm(e.target.value)}
                      required
                      className="h-10"
                    />
                  </div>
                </div>

                {error ? <ErrorBanner error={error} /> : null}

                <Button
                  type="submit"
                  size="lg"
                  className="h-11 w-full bg-emerald-800 text-white hover:bg-emerald-800/90"
                  disabled={pending}
                >
                  {pending ? (
                    <>
                      <Loader2
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                      Calculating…
                    </>
                  ) : (
                    "Rank mandis by net profit"
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>

      {pending ? <ResultsSkeleton /> : null}
      {!pending && results && farm ? (
        <ResultsDashboard farm={farm} results={results} />
      ) : null}
    </>
  );
}

function ErrorBanner({ error }: { error: UiError }) {
  const title =
    error.code === "RATE_LIMIT"
      ? "Routing API limit hit"
      : error.code === "NO_MANDIS"
        ? "No mandis in range"
        : error.code === "NO_PRICES"
          ? "No price data nearby"
          : "Couldn’t calculate arbitrage";

  const hint =
    error.code === "RATE_LIMIT"
      ? "OpenRouteService throttled this request. Wait a minute, then try again."
      : error.code === "NO_MANDIS"
        ? "Try a location closer to known markets, or expand DEFAULT_RADIUS_KM after seeding more mandis."
        : error.code === "NO_PRICES"
          ? "Run the data_pipeline sync for this commodity, then retry."
          : null;

  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg bg-destructive/10 px-3 py-3 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <p className="text-destructive/90">{error.message}</p>
        {hint ? <p className="text-destructive/80 text-xs">{hint}</p> : null}
      </div>
    </div>
  );
}
