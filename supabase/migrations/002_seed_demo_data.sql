-- Sample Maharashtra onion mandis + prices so the app works without data.gov.in.
-- Run in Supabase SQL Editor AFTER 001_initial_schema.sql

insert into public.mandis (state, district, market_name, location_geom)
values
  ('Maharashtra', 'Nashik', 'Lasalgaon', st_setsrid(st_makepoint(74.2390, 20.1450), 4326)::geography),
  ('Maharashtra', 'Nashik', 'Pimpalgaon', st_setsrid(st_makepoint(73.9920, 20.1640), 4326)::geography),
  ('Maharashtra', 'Nashik', 'Nashik', st_setsrid(st_makepoint(73.7898, 19.9975), 4326)::geography),
  ('Maharashtra', 'Ahmednagar', 'Ahmednagar', st_setsrid(st_makepoint(74.7480, 19.0948), 4326)::geography),
  ('Maharashtra', 'Pune', 'Pune', st_setsrid(st_makepoint(73.8567, 18.5204), 4326)::geography),
  ('Maharashtra', 'Solapur', 'Solapur', st_setsrid(st_makepoint(75.9064, 17.6599), 4326)::geography)
on conflict (state, district, market_name) do update
set location_geom = excluded.location_geom,
    is_active = true,
    updated_at = now();

-- Observed prices (today) + forecast (tomorrow) for Onion
with m as (
  select id, market_name from public.mandis where state = 'Maharashtra'
),
prices (market_name, modal_price) as (
  values
    ('Lasalgaon', 1850::numeric),
    ('Pimpalgaon', 1920::numeric),
    ('Nashik', 1780::numeric),
    ('Ahmednagar', 1690::numeric),
    ('Pune', 2100::numeric),
    ('Solapur', 1750::numeric)
)
insert into public.mandi_prices (
  mandi_id, commodity, variety, min_price, max_price, modal_price, price_date, is_forecasted
)
select
  m.id,
  'Onion',
  'Other',
  p.modal_price - 80,
  p.modal_price + 100,
  p.modal_price,
  current_date,
  false
from m
join prices p on p.market_name = m.market_name
on conflict (mandi_id, commodity, variety, price_date, is_forecasted) do update
set modal_price = excluded.modal_price,
    min_price = excluded.min_price,
    max_price = excluded.max_price;

with m as (
  select id, market_name from public.mandis where state = 'Maharashtra'
),
prices (market_name, modal_price) as (
  values
    ('Lasalgaon', 1880::numeric),
    ('Pimpalgaon', 1960::numeric),
    ('Nashik', 1810::numeric),
    ('Ahmednagar', 1720::numeric),
    ('Pune', 2150::numeric),
    ('Solapur', 1785::numeric)
)
insert into public.mandi_prices (
  mandi_id, commodity, variety, min_price, max_price, modal_price, price_date, is_forecasted
)
select
  m.id,
  'Onion',
  'Other',
  null,
  null,
  p.modal_price,
  current_date + 1,
  true
from m
join prices p on p.market_name = m.market_name
on conflict (mandi_id, commodity, variety, price_date, is_forecasted) do update
set modal_price = excluded.modal_price;
