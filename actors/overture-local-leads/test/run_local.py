"""Local end-to-end test against the live Overture S3 release (no Apify account needed).

Runs the Actor as a subprocess with the SDK's local file storage, then asserts the dataset rows.
Usage:  .venv/Scripts/python test/run_local.py   (from the actor folder)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ACTOR_DIR = Path(__file__).resolve().parents[1]
STORAGE = ACTOR_DIR / 'storage'
REQUIRED_FIELDS = [
    'id', 'name', 'category', 'categoryHierarchy', 'basicCategory', 'operatingStatus', 'confidence',
    'hasWebsite', 'website', 'websites', 'phone', 'phones', 'emails', 'socials', 'brand',
    'street', 'city', 'region', 'postcode', 'country', 'lat', 'lon', 'googleMapsUrl',
    'sourceDatasets', 'overtureRelease', 'scrapedAt',
]
failures = 0
results = []


def check(cond: bool, message: str) -> None:
    global failures
    if not cond:
        failures += 1
        print(f'  ASSERTION FAILED: {message}')


def run_actor(name: str, actor_input: dict) -> tuple[int, list[dict], dict | None, float]:
    shutil.rmtree(STORAGE, ignore_errors=True)
    kv = STORAGE / 'key_value_stores' / 'default'
    kv.mkdir(parents=True)
    (kv / 'INPUT.json').write_text(json.dumps(actor_input), encoding='utf-8')
    env = {
        **os.environ,
        'APIFY_LOCAL_STORAGE_DIR': str(STORAGE),
        'CRAWLEE_STORAGE_DIR': str(STORAGE),
        'APIFY_LOG_LEVEL': 'INFO',
        'PYTHONUTF8': '1',
    }
    t0 = time.time()
    proc = subprocess.run([sys.executable, '-m', 'src'], cwd=ACTOR_DIR, env=env)
    secs = round(time.time() - t0, 1)
    rows: list[dict] = []
    ds = STORAGE / 'datasets' / 'default'
    if ds.exists():
        for f in sorted(ds.glob('*.json')):
            if f.stem.isdigit():
                rows.append(json.loads(f.read_text(encoding='utf-8')))
    summary = None
    for candidate in (kv / 'SUMMARY', kv / 'SUMMARY.json'):  # the SDK writes the record without an extension
        if candidate.exists():
            summary = json.loads(candidate.read_text(encoding='utf-8'))
            break
    results.append({'name': name, 'exit': proc.returncode, 'rows': len(rows), 'secs': secs, 'stop': summary and summary.get('stopReason')})
    print(f'\n=== {name}: exit {proc.returncode}, {len(rows)} rows in {secs}s, stop={summary and summary.get("stopReason")}')
    return proc.returncode, rows, summary, secs


# 1. Small downtown bbox (Austin, TX, about 2 km x 2 km), all businesses, capped.
code, rows, summary, secs = run_actor('austin-all-200', {'bbox': '-97.75,30.26,-97.73,30.28', 'maxResults': 200})
check(code == 0, 'exit code 0')
check(len(rows) == 200, f'200 rows expected, got {len(rows)}')
check(secs < 120, f'first run under 2 minutes, took {secs}s')
if rows:
    check(all(all(k in r for k in REQUIRED_FIELDS) for r in rows), 'all documented fields present on every row')
    check(all(isinstance(r['hasWebsite'], bool) for r in rows), 'hasWebsite boolean')
    check(all(-97.75 <= r['lon'] <= -97.73 and 30.26 <= r['lat'] <= 30.28 for r in rows), 'coordinates inside bbox')
    check(all(r['overtureRelease'] == '2026-09-23.1' for r in rows), 'release tagged')
    check(sum(1 for r in rows if r['phone']) > 100, 'most rows have a phone')
    confs = [r['confidence'] for r in rows if r['confidence'] is not None]
    check(confs == sorted(confs, reverse=True), 'ordered by confidence desc')
    print('  sample row:', json.dumps(rows[0])[:700])

# 2. Filtered: food and drink businesses without a website, phone required.
code, rows, summary, secs = run_actor('austin-no-website-food', {
    'bbox': '-97.75,30.26,-97.73,30.28', 'categories': ['restaurant', 'cafe', 'bar'],
    'websiteFilter': 'without_website', 'requirePhone': True, 'maxResults': 50, 'minConfidence': '0.5',
})
check(code == 0, 'exit code 0')
check(0 < len(rows) <= 50, f'1..50 rows expected, got {len(rows)}')
if rows:
    check(all(r['hasWebsite'] is False and r['website'] is None for r in rows), 'no websites')
    check(all(r['phone'] for r in rows), 'phone present')
    check(all(r['confidence'] >= 0.5 for r in rows), 'confidence filter')
    cats = {'restaurant', 'cafe', 'bar'}
    check(all(cats & set([r['category'], r['basicCategory'], *r['categoryHierarchy'], *r['altCategories']]) for r in rows), 'category filter')
    print('  sample row:', json.dumps(rows[0])[:500])

# 3. Center + radius input and an invalid bbox error.
code, rows, summary, secs = run_actor('center-radius', {'centerLat': '51.5074', 'centerLon': '-0.1278', 'radiusKm': '0.5', 'maxResults': 30, 'countries': ['GB']})
check(code == 0 and len(rows) == 30, f'London center run: exit {code}, rows {len(rows)}')
if rows:
    check(all(r['country'] == 'GB' for r in rows), 'country filter')
code, rows, summary, secs = run_actor('invalid-bbox', {'bbox': '10,20,5,30'})
check(code != 0 and not rows, 'invalid bbox fails the run')

print('\nRESULTS')
for r in results:
    print(' ', r)
print('ALL ASSERTIONS PASSED' if failures == 0 else f'{failures} ASSERTION(S) FAILED')
sys.exit(0 if failures == 0 else 1)
