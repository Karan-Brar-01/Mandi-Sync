#!/usr/bin/env python3
"""
Mandi-Sync daily Agmarknet → Prophet → Supabase sync job.

Designed to run locally or via cron, e.g.:
  0 6 * * * cd /path/to/Mandi-Sync/data_pipeline && \\
    /path/to/venv/bin/python sync_mandi_data.py >> /var/log/mandi-sync.log 2>&1

Required env vars (see repo .env.example):
  DATA_GOV_API_KEY
  SUPABASE_URL            (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests
from prophet import Prophet
from supabase import Client, create_client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

AGMARKNET_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"
AGMARKNET_URL = f"https://api.data.gov.in/resource/{AGMARKNET_RESOURCE_ID}"

DEFAULT_STATE = "Maharashtra"
DEFAULT_COMMODITY = "Onion"
DEFAULT_LOOKBACK_DAYS = 30
DEFAULT_PAGE_SIZE = 1000
REQUEST_TIMEOUT_S = 60
MIN_PROPHET_POINTS = 7
COORDS_PATH = Path(__file__).resolve().parent / "data" / "mandi_coords.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("mandi_sync")


# ---------------------------------------------------------------------------
# Environment helpers
# ---------------------------------------------------------------------------

def _load_dotenv_if_present() -> None:
    """Best-effort load of nearby .env files without requiring python-dotenv."""
    root = Path(__file__).resolve().parents[1]
    candidates = [
        root / ".env.local",
        root / ".env",
        Path(__file__).resolve().parent / ".env",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip("'").strip('"')
            os.environ.setdefault(key, value)


def require_env(*keys: str) -> dict[str, str]:
    missing = [k for k in keys if not os.environ.get(k)]
    # Allow NEXT_PUBLIC_SUPABASE_URL as alias for SUPABASE_URL
    if "SUPABASE_URL" in missing and os.environ.get("NEXT_PUBLIC_SUPABASE_URL"):
        os.environ["SUPABASE_URL"] = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
        missing = [k for k in keys if not os.environ.get(k)]
    if missing:
        raise SystemExit(f"Missing required environment variables: {', '.join(missing)}")
    return {k: os.environ[k] for k in keys}


# ---------------------------------------------------------------------------
# 1. Extract — Agmarknet / data.gov.in
# ---------------------------------------------------------------------------

def fetch_agmarknet_prices(
    api_key: str,
    state: str,
    commodity: str,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> list[dict[str, Any]]:
    """
    Paginate the Agmarknet daily prices resource filtered by state + commodity.
    Client-side filter keeps rows whose arrival_date falls within lookback_days.
    """
    cutoff = date.today() - timedelta(days=lookback_days)
    records: list[dict[str, Any]] = []
    offset = 0

    log.info(
        "Fetching Agmarknet prices state=%s commodity=%s lookback=%sd",
        state,
        commodity,
        lookback_days,
    )

    while True:
        params = {
            "api-key": api_key,
            "format": "json",
            "offset": offset,
            "limit": page_size,
            # Prefer keyword filter used by current OGD swagger; fallback handled below.
            "filters[state.keyword]": state,
            "filters[commodity]": commodity,
        }
        response = requests.get(AGMARKNET_URL, params=params, timeout=REQUEST_TIMEOUT_S)

        # Some deployments reject state.keyword — retry with filters[state].
        if response.status_code >= 400:
            params.pop("filters[state.keyword]", None)
            params["filters[state]"] = state
            response = requests.get(AGMARKNET_URL, params=params, timeout=REQUEST_TIMEOUT_S)

        response.raise_for_status()
        payload = response.json()
        batch = payload.get("records") or []
        if not batch:
            break

        records.extend(batch)
        log.info("Fetched %s records (offset=%s, total=%s)", len(batch), offset, len(records))

        total = payload.get("total") or payload.get("count")
        offset += len(batch)
        if len(batch) < page_size:
            break
        if total is not None and offset >= int(total):
            break

        # Be polite to the public API.
        time.sleep(0.35)

    if not records:
        log.warning("API returned zero records for %s / %s", state, commodity)
        return []

    # Narrow to lookback window (arrival_date formats vary: DD/MM/YYYY or YYYY-MM-DD).
    kept: list[dict[str, Any]] = []
    for row in records:
        parsed = _parse_arrival_date(row.get("arrival_date"))
        if parsed is None:
            continue
        if parsed >= cutoff:
            row = dict(row)
            row["_price_date"] = parsed.isoformat()
            kept.append(row)

    log.info(
        "Kept %s / %s records on/after %s",
        len(kept),
        len(records),
        cutoff.isoformat(),
    )
    return kept


def _parse_arrival_date(value: Any) -> date | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    text = str(value).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# 2. Transform — clean into a Pandas DataFrame
# ---------------------------------------------------------------------------

def clean_records(records: list[dict[str, Any]], state: str, commodity: str) -> pd.DataFrame:
    """Normalize Agmarknet JSON into a typed DataFrame ready for forecasting + load."""
    if not records:
        return pd.DataFrame(
            columns=[
                "state",
                "district",
                "market_name",
                "commodity",
                "variety",
                "min_price",
                "max_price",
                "modal_price",
                "price_date",
            ]
        )

    df = pd.DataFrame(records)

    column_map = {
        "state": "state",
        "district": "district",
        "market": "market_name",
        "commodity": "commodity",
        "variety": "variety",
        "min_price": "min_price",
        "max_price": "max_price",
        "modal_price": "modal_price",
        "_price_date": "price_date",
    }
    present = {src: dst for src, dst in column_map.items() if src in df.columns}
    df = df.rename(columns=present)

    for col in column_map.values():
        if col not in df.columns:
            df[col] = None

    df["state"] = df["state"].fillna(state).astype(str).str.strip()
    df["district"] = df["district"].fillna("").astype(str).str.strip()
    df["market_name"] = df["market_name"].fillna("").astype(str).str.strip()
    df["commodity"] = df["commodity"].fillna(commodity).astype(str).str.strip()
    df["variety"] = (
        df["variety"].fillna("").astype(str).str.strip().replace({"": "Other"})
    )

    for price_col in ("min_price", "max_price", "modal_price"):
        df[price_col] = pd.to_numeric(df[price_col], errors="coerce")

    df["price_date"] = pd.to_datetime(df["price_date"], errors="coerce").dt.date

    df = df.dropna(subset=["market_name", "district", "modal_price", "price_date"])
    df = df[df["market_name"].str.len() > 0]
    df = df[df["modal_price"] >= 0]

    # One quote per mandi/commodity/variety/day (keep last).
    df = (
        df.sort_values("price_date")
        .drop_duplicates(
            subset=["state", "district", "market_name", "commodity", "variety", "price_date"],
            keep="last",
        )
        .reset_index(drop=True)
    )

    log.info(
        "Cleaned DataFrame: %s rows, %s mandis, date range %s → %s",
        len(df),
        df[["district", "market_name"]].drop_duplicates().shape[0],
        df["price_date"].min(),
        df["price_date"].max(),
    )
    return df[
        [
            "state",
            "district",
            "market_name",
            "commodity",
            "variety",
            "min_price",
            "max_price",
            "modal_price",
            "price_date",
        ]
    ]


# ---------------------------------------------------------------------------
# 3. Forecast — lightweight Prophet per Mandi (+ variety)
# ---------------------------------------------------------------------------

def forecast_tomorrow(df: pd.DataFrame) -> pd.DataFrame:
    """
    Fit a small Prophet model per (district, market_name, variety) series.
    Returns a DataFrame of forecast rows (is_forecasted semantics applied at load).
    """
    if df.empty:
        return pd.DataFrame()

    tomorrow = date.today() + timedelta(days=1)
    forecasts: list[dict[str, Any]] = []

    group_cols = ["state", "district", "market_name", "commodity", "variety"]
    for keys, group in df.groupby(group_cols, dropna=False):
        series = (
            group.groupby("price_date", as_index=False)["modal_price"]
            .mean()
            .sort_values("price_date")
        )
        if len(series) < MIN_PROPHET_POINTS:
            log.debug(
                "Skip forecast %s — only %s points (need %s)",
                keys,
                len(series),
                MIN_PROPHET_POINTS,
            )
            continue

        prophet_df = pd.DataFrame(
            {
                "ds": pd.to_datetime(series["price_date"]),
                "y": series["modal_price"].astype(float),
            }
        )

        try:
            model = Prophet(
                daily_seasonality=False,
                weekly_seasonality=True,
                yearly_seasonality=False,
                seasonality_mode="additive",
                changepoint_prior_scale=0.05,
            )
            # Keep cron logs readable (cmdstan prints progress to stdout).
            with open(os.devnull, "w", encoding="utf-8") as devnull:
                old_stdout = sys.stdout
                sys.stdout = devnull
                try:
                    model.fit(prophet_df)
                finally:
                    sys.stdout = old_stdout

            future = pd.DataFrame({"ds": [pd.Timestamp(tomorrow)]})
            pred = model.predict(future)
            yhat = max(0.0, float(pred.iloc[0]["yhat"]))
        except Exception as exc:  # noqa: BLE001 — keep the job alive per-series
            log.warning("Prophet failed for %s: %s", keys, exc)
            continue

        state, district, market_name, commodity, variety = keys
        forecasts.append(
            {
                "state": state,
                "district": district,
                "market_name": market_name,
                "commodity": commodity,
                "variety": variety,
                "min_price": None,
                "max_price": None,
                "modal_price": round(yhat, 2),
                "price_date": tomorrow,
            }
        )

    out = pd.DataFrame(forecasts)
    log.info("Generated %s tomorrow forecasts for %s", len(out), tomorrow.isoformat())
    return out


# ---------------------------------------------------------------------------
# 4. Load — resolve Mandis + upsert prices into Supabase
# ---------------------------------------------------------------------------

def get_supabase_client(url: str, service_role_key: str) -> Client:
    return create_client(url, service_role_key)


def load_mandi_coords() -> dict[str, dict[str, list[float]]]:
    if not COORDS_PATH.is_file():
        log.warning("No coords file at %s — mandis without coords will be skipped", COORDS_PATH)
        return {}
    return json.loads(COORDS_PATH.read_text(encoding="utf-8"))


def _lookup_coords(
    coords_db: dict[str, dict[str, list[float]]],
    state: str,
    district: str,
    market_name: str,
) -> tuple[float, float] | None:
    state_map = coords_db.get(state) or coords_db.get(state.title()) or {}
    key = f"{district}|{market_name}"
    if key in state_map:
        lat, lng = state_map[key]
        return float(lat), float(lng)

    # Loose match on market name only (district may differ slightly in API spelling).
    market_lower = market_name.casefold()
    for stored_key, latlng in state_map.items():
        stored_market = stored_key.split("|", 1)[-1]
        if stored_market.casefold() == market_lower:
            lat, lng = latlng
            return float(lat), float(lng)
    return None


def _point_geojson(lat: float, lng: float) -> dict[str, Any]:
    """GeoJSON Point for PostGIS geography via PostgREST (coordinates = [lng, lat])."""
    return {"type": "Point", "coordinates": [lng, lat]}


def ensure_mandis(
    client: Client,
    df: pd.DataFrame,
    coords_db: dict[str, dict[str, list[float]]],
) -> dict[tuple[str, str, str], str]:
    """
    Upsert mandi rows that have known coordinates.
    Returns mapping (state, district, market_name) → mandi uuid.
    """
    unique = (
        df[["state", "district", "market_name"]]
        .drop_duplicates()
        .itertuples(index=False, name=None)
    )

    payloads: list[dict[str, Any]] = []
    skipped = 0
    for state, district, market_name in unique:
        latlng = _lookup_coords(coords_db, state, district, market_name)
        if latlng is None:
            skipped += 1
            log.warning(
                "No coordinates for %s / %s / %s — skip mandi upsert",
                state,
                district,
                market_name,
            )
            continue
        lat, lng = latlng
        payloads.append(
            {
                "state": state,
                "district": district,
                "market_name": market_name,
                "location_geom": _point_geojson(lat, lng),
                "is_active": True,
            }
        )

    if not payloads:
        log.error("No mandis could be geocoded; aborting load")
        return {}

    # Upsert on unique (state, district, market_name).
    client.table("mandis").upsert(
        payloads,
        on_conflict="state,district,market_name",
    ).execute()

    # Re-fetch IDs for the state(s) we touched.
    states = sorted({p["state"] for p in payloads})
    id_map: dict[tuple[str, str, str], str] = {}
    for state in states:
        result = (
            client.table("mandis")
            .select("id,state,district,market_name")
            .eq("state", state)
            .execute()
        )
        for row in result.data or []:
            id_map[(row["state"], row["district"], row["market_name"])] = row["id"]

    log.info(
        "Resolved %s mandi IDs (%s skipped without coords)",
        len(id_map),
        skipped,
    )
    return id_map


def upsert_prices(
    client: Client,
    df: pd.DataFrame,
    id_map: dict[tuple[str, str, str], str],
    *,
    is_forecasted: bool,
) -> int:
    """Upsert price rows. Returns number of rows attempted."""
    if df.empty or not id_map:
        return 0

    rows: list[dict[str, Any]] = []
    for rec in df.itertuples(index=False):
        key = (rec.state, rec.district, rec.market_name)
        mandi_id = id_map.get(key)
        if not mandi_id:
            continue
        price_date = rec.price_date
        if isinstance(price_date, datetime):
            price_date = price_date.date()
        rows.append(
            {
                "mandi_id": mandi_id,
                "commodity": rec.commodity,
                "variety": rec.variety,
                "min_price": None
                if pd.isna(rec.min_price)
                else float(rec.min_price),
                "max_price": None
                if pd.isna(rec.max_price)
                else float(rec.max_price),
                "modal_price": float(rec.modal_price),
                "price_date": price_date.isoformat()
                if hasattr(price_date, "isoformat")
                else str(price_date),
                "is_forecasted": is_forecasted,
            }
        )

    if not rows:
        return 0

    # Chunk to avoid payload limits.
    chunk_size = 500
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        client.table("mandi_prices").upsert(
            chunk,
            on_conflict="mandi_id,commodity,variety,price_date,is_forecasted",
        ).execute()

    log.info(
        "Upserted %s %s price rows",
        len(rows),
        "forecast" if is_forecasted else "historical",
    )
    return len(rows)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_sync(
    state: str = DEFAULT_STATE,
    commodity: str = DEFAULT_COMMODITY,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> None:
    _load_dotenv_if_present()
    env = require_env("DATA_GOV_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")

    started = datetime.now(timezone.utc)
    log.info("=== Mandi-Sync pipeline start utc=%s ===", started.isoformat())

    raw = fetch_agmarknet_prices(
        api_key=env["DATA_GOV_API_KEY"],
        state=state,
        commodity=commodity,
        lookback_days=lookback_days,
    )
    historical = clean_records(raw, state=state, commodity=commodity)
    if historical.empty:
        log.warning("Nothing to load — exiting cleanly")
        return

    forecasts = forecast_tomorrow(historical)

    client = get_supabase_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    coords_db = load_mandi_coords()
    id_map = ensure_mandis(client, historical, coords_db)
    if not id_map:
        raise SystemExit("No mandis resolved; check data/mandi_coords.json")

    n_hist = upsert_prices(client, historical, id_map, is_forecasted=False)
    n_fcst = upsert_prices(client, forecasts, id_map, is_forecasted=True)

    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    log.info(
        "=== Done in %.1fs — historical=%s forecast=%s ===",
        elapsed,
        n_hist,
        n_fcst,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync Agmarknet prices + Prophet forecasts into Supabase."
    )
    parser.add_argument("--state", default=DEFAULT_STATE, help="Agmarknet state filter")
    parser.add_argument(
        "--commodity", default=DEFAULT_COMMODITY, help="Agmarknet commodity filter"
    )
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_LOOKBACK_DAYS,
        help="Lookback window in days (default: 30)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    try:
        run_sync(state=args.state, commodity=args.commodity, lookback_days=args.days)
    except requests.HTTPError as exc:
        log.exception("HTTP error talking to Agmarknet: %s", exc)
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        log.exception("Pipeline failed: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
