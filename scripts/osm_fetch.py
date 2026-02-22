#!/usr/bin/env python3
"""
Download castle features from the Overpass API into data/raw/osm_castles_raw.json.
Usage: python scripts/osm_fetch.py data/raw/osm_castles_raw.json
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests

OVERPASS = "https://overpass-api.de/api/interpreter"
QUERY = """
[out:json][timeout:180];
area["name"="Europe"]->.searchArea;
(
  nwr["historic"="castle"](area.searchArea);
  nwr["historic"="ruins"]["ruins"="castle"](area.searchArea);
  nwr["tourism"="attraction"]["historic"="castle"](area.searchArea);
);
out center;
>;
out skel qt;
"""


def fetch() -> dict:
  resp = requests.post(OVERPASS, data={"data": QUERY}, timeout=240)
  resp.raise_for_status()
  return resp.json()


def main():
  if len(sys.argv) < 2:
    print("Usage: python scripts/osm_fetch.py <output_json>")
    raise SystemExit(1)
  out_path = Path(sys.argv[1])
  raw = fetch()
  print(f"Fetched {len(raw.get('elements', []))} elements", file=sys.stderr)
  out_path.parent.mkdir(parents=True, exist_ok=True)
  out_path.write_text(json.dumps(raw), encoding="utf-8")


if __name__ == "__main__":
  main()
