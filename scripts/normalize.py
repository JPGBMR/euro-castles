#!/usr/bin/env python3
"""
Normalize Wikidata + OSM raw dumps into the application schema.
Usage: python scripts/normalize.py data/raw/wd_castles_raw.json data/raw/osm_castles_raw.json data/castles.min.json
"""

from __future__ import annotations

import json
import math
import sys
from datetime import date
from pathlib import Path


def load_wikidata(path: Path) -> dict[str, dict]:
  rows = json.loads(path.read_text(encoding="utf-8"))
  result = {}
  for row in rows:
    result[row["id"]] = {
      "id": row["id"],
      "name": row["name"],
      "country": row.get("country"),
      "coords": row.get("coords"),
      "wikidata": row.get("wikidata"),
      "image": row.get("image"),
      "style": row.get("style"),
    }
  return result


def main():
  if len(sys.argv) < 4:
    print("Usage: python scripts/normalize.py <wd_json> <osm_json> <output_json>")
    raise SystemExit(1)
  wd = load_wikidata(Path(sys.argv[1]))
  osm_raw = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
  output = []
  today = date.today().isoformat()
  for element in osm_raw.get("elements", []):
    tags = element.get("tags", {})
    if "historic" not in tags:
      continue
    coords = element.get("center") or {"lat": element.get("lat"), "lon": element.get("lon")}
    osm_id = f"{element['type']}/{element['id']}"
    candidate = None
    wd_id = tags.get("wikidata")
    if wd_id and wd_id in wd:
      candidate = wd[wd_id]
    record = {
      "id": wd_id or f"osm-{osm_id}",
      "name": tags.get("name", candidate["name"] if candidate else "Unknown castle"),
      "alt_names": tags.get("alt_name", "").split(";") if tags.get("alt_name") else [],
      "country": candidate["country"] if candidate else tags.get("addr:country", "XX"),
      "coords": coords,
      "osm": {"type": element["type"], "id": str(element["id"])},
      "wikidata": candidate["wikidata"] if candidate else wd_id,
      "wikipedia": tags.get("wikipedia"),
      "type": tags.get("castle_type") or tags.get("historic"),
      "era": candidate.get("style") if candidate else None,
      "condition": tags.get("condition") or ("ruins" if tags.get("ruins") else "standing"),
      "opening_hours": tags.get("opening_hours"),
      "website": tags.get("website"),
      "image": {
        "thumb_url": candidate.get("image") if candidate else None,
        "page_url": tags.get("image"),
        "license": None,
      },
      "tags": [tag for tag in ["public", "museum", "unesco"] if tag in tags.get("description", "").lower()],
      "source": "wikidata+osm" if candidate else "osm",
      "last_verified": today,
    }
    output.append(record)
  Path(sys.argv[3]).write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
  print(f"Normalized {len(output)} castles -> {sys.argv[3]}")


if __name__ == "__main__":
  main()
