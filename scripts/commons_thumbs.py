#!/usr/bin/env python3
"""
Fetch thumbnail + license metadata for Wikimedia Commons files referenced in wd_castles_raw.json.
Usage: python scripts/commons_thumbs.py data/raw/wd_castles_raw.json data/raw/thumbs.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import quote

import requests

API = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "europe-castles/1.0 (contact: data@europe-castles.example)"}


def fetch_thumb(filename: str) -> dict | None:
  params = {
    "action": "query",
    "prop": "imageinfo",
    "format": "json",
    "titles": filename,
    "iiprop": "url|extmetadata",
    "iiurlwidth": 320,
  }
  resp = requests.get(API, params=params, headers=HEADERS, timeout=30)
  resp.raise_for_status()
  data = resp.json()["query"]["pages"]
  page = next(iter(data.values()))
  info = page.get("imageinfo")
  if not info:
    return None
  info = info[0]
  meta = info.get("extmetadata", {})
  return {
    "thumb_url": info.get("thumburl"),
    "page_url": info.get("descriptionurl"),
    "license": meta.get("LicenseShortName", {}).get("*"),
    "credit": meta.get("Artist", {}).get("*"),
  }


def main():
  if len(sys.argv) < 3:
    print("Usage: python scripts/commons_thumbs.py <wd_json> <output_json>")
    raise SystemExit(1)
  wd_path = Path(sys.argv[1])
  out_path = Path(sys.argv[2])
  wd_items = json.loads(wd_path.read_text(encoding="utf-8"))
  results = {}
  for item in wd_items:
    filename = item.get("image")
    if not filename:
      continue
    record = fetch_thumb(filename)
    if record:
      results[item["id"]] = record
  out_path.parent.mkdir(parents=True, exist_ok=True)
  out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
  print(f"Wrote {len(results)} thumbnail records to {out_path}")


if __name__ == "__main__":
  main()
