-- Mandi-Sync initial schema: PostGIS mandis + daily/forecast prices
-- Apply via Supabase SQL editor or `supabase db push`

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- mandis: physical market locations
-- ---------------------------------------------------------------------------
create table if not exists public.mandis (
  id uuid primary key default gen_random_uuid(),
  state text not null,
  district text not null,
  market_name text not null,
  location_geom geography(point, 4326) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mandis_state_district_market_unique
    unique (state, district, market_name)
);

create index if not exists mandis_location_geom_gix
  on public.mandis using gist (location_geom);

create index if not exists mandis_state_district_idx
  on public.mandis (state, district);

comment on table public.mandis is 'Agricultural market (mandi) locations with PostGIS geography.';
comment on column public.mandis.location_geom is 'WGS84 point as geography(Point, 4326); store lon/lat via ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography.';

-- ---------------------------------------------------------------------------
-- mandi_prices: observed and forecasted commodity prices (₹ / quintal)
-- ---------------------------------------------------------------------------
create table if not exists public.mandi_prices (
  id uuid primary key default gen_random_uuid(),
  mandi_id uuid not null references public.mandis (id) on delete cascade,
  commodity text not null,
  variety text,
  min_price numeric(12, 2),
  max_price numeric(12, 2),
  modal_price numeric(12, 2) not null,
  price_date date not null,
  is_forecasted boolean not null default false,
  created_at timestamptz not null default now(),
  constraint mandi_prices_unique_quote
    unique (mandi_id, commodity, variety, price_date, is_forecasted),
  constraint mandi_prices_modal_non_negative check (modal_price >= 0)
);

create index if not exists mandi_prices_commodity_date_idx
  on public.mandi_prices (commodity, price_date desc);

create index if not exists mandi_prices_mandi_commodity_date_idx
  on public.mandi_prices (mandi_id, commodity, price_date desc);

create index if not exists mandi_prices_forecast_idx
  on public.mandi_prices (is_forecasted, price_date desc);

comment on table public.mandi_prices is 'Daily Agmarknet quotes and Prophet forecasts; forecast rows use is_forecasted = true.';

-- ---------------------------------------------------------------------------
-- updated_at trigger for mandis
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists mandis_set_updated_at on public.mandis;
create trigger mandis_set_updated_at
  before update on public.mandis
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- get_mandis_within_radius(lat, lng, radius_km)
-- Returns active mandis within radius, ordered by crow-fly distance.
-- ---------------------------------------------------------------------------
create or replace function public.get_mandis_within_radius(
  lat double precision,
  lng double precision,
  radius_km double precision default 100
)
returns table (
  id uuid,
  state text,
  district text,
  market_name text,
  lat double precision,
  lng double precision,
  distance_km double precision
)
language sql
stable
parallel safe
as $$
  with origin as (
    select st_setsrid(st_makepoint(lng, lat), 4326)::geography as geom
  )
  select
    m.id,
    m.state,
    m.district,
    m.market_name,
    st_y(m.location_geom::geometry) as lat,
    st_x(m.location_geom::geometry) as lng,
    (st_distance(m.location_geom, o.geom) / 1000.0)::double precision as distance_km
  from public.mandis m
  cross join origin o
  where m.is_active = true
    and st_dwithin(m.location_geom, o.geom, radius_km * 1000.0)
  order by st_distance(m.location_geom, o.geom);
$$;

comment on function public.get_mandis_within_radius(double precision, double precision, double precision)
  is 'Return active mandis within radius_km of (lat, lng), with distance_km via geography.';

grant execute on function public.get_mandis_within_radius(double precision, double precision, double precision)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: public read for MVP; writes via service role (pipeline)
-- ---------------------------------------------------------------------------
alter table public.mandis enable row level security;
alter table public.mandi_prices enable row level security;

drop policy if exists "Public read mandis" on public.mandis;
create policy "Public read mandis"
  on public.mandis
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Public read mandi_prices" on public.mandi_prices;
create policy "Public read mandi_prices"
  on public.mandi_prices
  for select
  to anon, authenticated
  using (true);
