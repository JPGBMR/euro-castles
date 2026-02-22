#!/usr/bin/env python3
"""
Fetch castle metadata from Wikidata using the approved SPARQL query.
Usage: python scripts/wd_fetch.py data/raw/wd_castles_raw.json
"""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import requests

SPARQL = """
SELECT ?item ?itemLabel ?coord ?image ?countryCode ?style ?styleLabel WHERE {
  ?item wdt:P31/wdt:P279* wd:Q23413;
        wdt:P625 ?coord.
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?item wdt:P149 ?style. }
  OPTIONAL { ?item wdt:P17 ?country. ?country wdt:P297 ?countryCode. }
  FILTER(BOUND(?coord)).
  BIND(xsd:float(STRBEFORE(STRAFTER(STR(?coord), "Point("), " ")) AS ?lat)
  BIND(xsd:float(STRAFTER(STR(?coord), "Point(")) AS ?long)
  FILTER(?lat > 35 && ?lat < 70 && ?long > -10 && ?long < 40)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de,fr,es,it". }
}
"""

ENDPOINT = "https://query.wikidata.org/sparql"
HEADERS = {"User-Agent": "europe-castles/1.0 (contact: data@europe-castles.example)"}


def fetch_chunk(limit: int, offset: int) -> list[dict]:
  resp = requests.get(
    ENDPOINT,
    params={"format": "json", "query": f"{SPARQL}\nLIMIT {limit} OFFSET {offset}"},
    headers=HEADERS,
    timeout=60,
  )
  resp.raise_for_status()
  data = resp.json()["results"]["bindings"]
  castles = []
  for row in data:
    coord = row["coord"]["value"]
    lon_str, lat_str = coord.split("Point(")[1].rstrip(")").split()
    castles.append(
      {
        "id": row["item"]["value"].rpartition("/")[-1],
        "name": row["itemLabel"]["value"],
        "country": row.get("countryCode", {}).get("value"),
        "coords": {"lat": float(lat_str), "lon": float(lon_str)},
        "wikidata": row["item"]["value"],
        "image": row.get("image", {}).get("value"),
        "style": row.get("styleLabel", {}).get("value"),
      }
    )
  return castles


def main():
  if len(sys.argv) < 2:
    print("Usage: python scripts/wd_fetch.py <output_json>")
    raise SystemExit(1)
  out_path = Path(sys.argv[1])
  limit = 5000
  offset = 0
  rows: list[dict] = []
  while True:
    chunk = fetch_chunk(limit, offset)
    if not chunk:
      break
    rows.extend(chunk)
    offset += limit
    print(f"Fetched {len(rows)} rows...", file=sys.stderr)
    time.sleep(1)  # be polite
    if offset >= 25000:
      break
  out_path.parent.mkdir(parents=True, exist_ok=True)
  out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
  print(f"Wrote {len(rows)} records to {out_path}")


if __name__ == "__main__":
  main()
