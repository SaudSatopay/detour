#!/usr/bin/env bash
# Downloads the public MTA datasets Detour is built from into data/raw/.
# Run from the repository root: bash scripts/fetch-mta.sh
set -euo pipefail

mkdir -p data/raw/gtfs data/raw/stations data/raw/od

# MTA GTFS static, subway (regular schedule). https://www.mta.info/developers
curl -sL --fail -o data/raw/gtfs/google_transit.zip \
  "http://web.mta.info/developers/data/nyct/subway/google_transit.zip"
(cd data/raw/gtfs && unzip -o -q google_transit.zip)

# MTA Subway Stations (GTFS stop -> station complex, ADA, borough, CBD). data.ny.gov 39hk-dx4f
curl -s --fail -o data/raw/stations/stations.json \
  'https://data.ny.gov/resource/39hk-dx4f.json?$limit=5000'

# MTA Subway Stations and Complexes. data.ny.gov 5f5g-n3cz
curl -s --fail -o data/raw/stations/complexes.json \
  'https://data.ny.gov/resource/5f5g-n3cz.json?$limit=5000'

# MTA Subway Origin-Destination Ridership Estimate 2025. data.ny.gov y2qv-fytt
# Slice: October 2025, Wednesday, 8:00-8:59 a.m.
curl -s --fail -o data/raw/od/od-2025-10-wed-08.csv \
  "https://data.ny.gov/resource/y2qv-fytt.csv?\$select=origin_station_complex_id,destination_station_complex_id,estimated_average_ridership&\$where=year=2025%20AND%20month=10%20AND%20hour_of_day=8%20AND%20day_of_week='Wednesday'&\$limit=200000"

echo "MTA data downloaded to data/raw/"
