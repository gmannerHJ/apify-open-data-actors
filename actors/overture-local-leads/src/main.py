"""Overture Local Leads: local-business leads from the public Overture Maps Places release on S3.

Reads the places theme of an Overture release with DuckDB (anonymous S3, httpfs), restricted to a
bounding box so only the parquet row groups that overlap the area are downloaded.
"""

from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone
from typing import Any

import duckdb
from apify import Actor

DEFAULT_RELEASE = '2026-09-23.1'
RELEASE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}\.\d+$')
PLACES_GLOB = 's3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*'
MAX_AREA_DEG2 = 10.0  # about 330 km x 330 km at the equator; larger areas should be split
MAX_RESULTS_CAP = 100_000
BATCH = 500
EVENT_START = 'actor-start'
EVENT_LEAD = 'lead'

SELECT_COLUMNS = """
    id,
    names.primary                      AS name,
    taxonomy.primary                   AS category,
    taxonomy.hierarchy                 AS category_hierarchy,
    taxonomy.alternates                AS alt_categories,
    basic_category,
    operating_status,
    confidence,
    websites,
    phones,
    emails,
    socials,
    brand.names.primary                AS brand,
    addresses[1].freeform              AS street,
    addresses[1].locality              AS city,
    addresses[1].region                AS region,
    addresses[1].postcode              AS postcode,
    addresses[1].country               AS country,
    (bbox.xmin + bbox.xmax) / 2        AS lon,
    (bbox.ymin + bbox.ymax) / 2        AS lat,
    list_transform(sources, s -> s.dataset) AS source_datasets
"""


class InputError(ValueError):
    pass


def _num(value: Any, name: str) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise InputError(f'{name} must be a number, got {value!r}') from None
    if math.isnan(f) or math.isinf(f):
        raise InputError(f'{name} must be a finite number')
    return f


def parse_area(inp: dict) -> tuple[float, float, float, float]:
    """Return (west, south, east, north) from either `bbox` or center + radius."""
    bbox = inp.get('bbox')
    if bbox not in (None, ''):
        parts = [p for p in re.split(r'[,\s]+', str(bbox).strip()) if p]
        if len(parts) != 4:
            raise InputError('bbox must be "west,south,east,north" in decimal degrees, e.g. "-97.75,30.26,-97.73,30.28"')
        west, south, east, north = (_num(p, 'bbox') for p in parts)
    elif inp.get('centerLat') is not None and inp.get('centerLon') is not None:
        lat = _num(inp['centerLat'], 'centerLat')
        lon = _num(inp['centerLon'], 'centerLon')
        radius_km = _num(inp.get('radiusKm', 2), 'radiusKm')
        if not 0.05 <= radius_km <= 150:
            raise InputError('radiusKm must be between 0.05 and 150')
        dlat = radius_km / 111.32
        dlon = radius_km / (111.32 * max(math.cos(math.radians(lat)), 0.05))
        west, south, east, north = lon - dlon, lat - dlat, lon + dlon, lat + dlat
    else:
        raise InputError('Provide either bbox ("west,south,east,north") or centerLat + centerLon (+ radiusKm).')

    if not (-180 <= west <= 180 and -180 <= east <= 180):
        raise InputError('Longitudes must be between -180 and 180')
    if not (-90 <= south <= 90 and -90 <= north <= 90):
        raise InputError('Latitudes must be between -90 and 90')
    if west >= east:
        raise InputError(f'west ({west}) must be smaller than east ({east}); areas crossing the antimeridian are not supported')
    if south >= north:
        raise InputError(f'south ({south}) must be smaller than north ({north})')
    area = (east - west) * (north - south)
    if area > MAX_AREA_DEG2:
        raise InputError(
            f'The area is {area:.1f} square degrees; the maximum is {MAX_AREA_DEG2}. '
            'Split it into several runs (one per city or county) to keep each run fast.'
        )
    return west, south, east, north


def normalize_category(value: str) -> str:
    return re.sub(r'[^a-z0-9]+', '_', str(value).strip().lower()).strip('_')


def build_query(inp: dict, area: tuple[float, float, float, float], release: str, max_results: int) -> tuple[str, list[Any]]:
    west, south, east, north = area
    where = [
        'bbox.xmin >= ?', 'bbox.xmax <= ?', 'bbox.ymin >= ?', 'bbox.ymax <= ?',
    ]
    params: list[Any] = [west, east, south, north]

    categories = [normalize_category(c) for c in (inp.get('categories') or []) if str(c).strip()]
    if categories:
        clauses = []
        for cat in categories:
            clauses.append('(taxonomy.primary = ? OR basic_category = ? OR list_contains(taxonomy.hierarchy, ?) OR list_contains(taxonomy.alternates, ?))')
            params.extend([cat, cat, cat, cat])
        where.append('(' + ' OR '.join(clauses) + ')')

    website_filter = inp.get('websiteFilter') or 'any'
    if website_filter == 'without_website':
        where.append('(websites IS NULL OR len(websites) = 0)')
    elif website_filter == 'with_website':
        where.append('(websites IS NOT NULL AND len(websites) > 0)')
    elif website_filter != 'any':
        raise InputError('websiteFilter must be one of any, without_website, with_website')

    if inp.get('requirePhone'):
        where.append('(phones IS NOT NULL AND len(phones) > 0)')

    min_conf = inp.get('minConfidence')
    if min_conf not in (None, ''):
        min_conf = _num(min_conf, 'minConfidence')
        if not 0 <= min_conf <= 1:
            raise InputError('minConfidence must be between 0 and 1')
        if min_conf > 0:
            where.append('confidence >= ?')
            params.append(min_conf)

    countries = [str(c).strip().upper() for c in (inp.get('countries') or []) if str(c).strip()]
    if countries:
        for c in countries:
            if not re.fullmatch(r'[A-Z]{2}', c):
                raise InputError(f'countries must be ISO 3166-1 alpha-2 codes such as US, GB, DE; got {c!r}')
        where.append('addresses[1].country IN (' + ','.join('?' for _ in countries) + ')')
        params.extend(countries)

    if inp.get('excludeClosed', True):
        where.append("(operating_status IS NULL OR operating_status <> 'permanently_closed')")

    name_contains = (inp.get('nameContains') or '').strip()
    if name_contains:
        where.append('names.primary ILIKE ?')
        params.append(f'%{name_contains}%')

    sql = (
        f'SELECT {SELECT_COLUMNS} FROM read_parquet(?, hive_partitioning = 1) '
        f'WHERE {" AND ".join(where)} '
        f'ORDER BY confidence DESC NULLS LAST, id LIMIT {int(max_results)}'
    )
    params.insert(0, PLACES_GLOB.format(release=release))
    return sql, params


def to_row(rec: dict, release: str, scraped_at: str) -> dict:
    websites = list(rec.get('websites') or [])
    phones = list(rec.get('phones') or [])
    lat = rec.get('lat')
    lon = rec.get('lon')
    conf = rec.get('confidence')
    return {
        'id': rec['id'],
        'name': rec.get('name'),
        'category': rec.get('category'),
        'categoryHierarchy': list(rec.get('category_hierarchy') or []),
        'altCategories': list(rec.get('alt_categories') or []),
        'basicCategory': rec.get('basic_category'),
        'operatingStatus': rec.get('operating_status'),
        'confidence': round(conf, 4) if conf is not None else None,
        'hasWebsite': bool(websites),
        'website': websites[0] if websites else None,
        'websites': websites,
        'phone': phones[0] if phones else None,
        'phones': phones,
        'emails': list(rec.get('emails') or []),
        'socials': list(rec.get('socials') or []),
        'brand': rec.get('brand'),
        'street': rec.get('street'),
        'city': rec.get('city'),
        'region': rec.get('region'),
        'postcode': rec.get('postcode'),
        'country': rec.get('country'),
        'lat': round(lat, 6) if lat is not None else None,
        'lon': round(lon, 6) if lon is not None else None,
        'googleMapsUrl': f'https://www.google.com/maps/search/?api=1&query={lat:.6f},{lon:.6f}' if lat is not None and lon is not None else None,
        'sourceDatasets': sorted(set(rec.get('source_datasets') or [])),
        'overtureRelease': release,
        'scrapedAt': scraped_at,
    }


class Charger:
    def __init__(self) -> None:
        self.enabled = False
        if Actor.is_at_home():
            try:
                info = Actor.get_charging_manager().get_pricing_info()
                self.enabled = bool(getattr(info, 'is_pay_per_event', False))
            except Exception:  # noqa: BLE001 - charging manager unavailable means no PPE
                self.enabled = False
        if not self.enabled:
            Actor.log.info('Pay-per-event charging is inactive (local run or non-PPE pricing); no events will be charged.')

    async def charge(self, event_name: str, count: int) -> tuple[int, bool]:
        """Return (number of events actually charged, limit reached)."""
        if not self.enabled or count <= 0:
            return count, False
        result = await Actor.charge(event_name=event_name, count=count)
        charged = getattr(result, 'charged_count', count)
        limit = bool(getattr(result, 'event_charge_limit_reached', False))
        return min(count, charged), limit


def open_duckdb(threads: int, memory_limit: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs;')
    con.execute(f"SET threads = {int(threads)}; SET memory_limit = '{memory_limit}';")
    con.execute("SET s3_region = 'us-west-2'; SET s3_access_key_id = ''; SET s3_secret_access_key = '';")
    con.execute('SET enable_object_cache = true; SET http_keep_alive = true; SET http_retries = 4; SET http_retry_wait_ms = 1000;')
    return con


async def main() -> None:
    async with Actor:
        started = time.time()
        inp = await Actor.get_input() or {}

        area = parse_area(inp)
        release = str(inp.get('release') or DEFAULT_RELEASE).strip()
        if not RELEASE_RE.match(release):
            raise InputError(f'release must look like 2026-09-23.1, got {release!r}')
        max_results = inp.get('maxResults', 1000)
        if not isinstance(max_results, int) or isinstance(max_results, bool) or not 1 <= max_results <= MAX_RESULTS_CAP:
            raise InputError(f'maxResults must be an integer between 1 and {MAX_RESULTS_CAP}')

        sql, params = build_query(inp, area, release, max_results)
        charger = Charger()
        _, limit_hit = await charger.charge(EVENT_START, 1)
        if limit_hit:
            raise RuntimeError('The run\'s maximum charge is below the actor-start price; raise the limit and retry.')

        Actor.log.info(
            f'Querying Overture {release} places for bbox west={area[0]} south={area[1]} east={area[2]} north={area[3]} '
            f'(maxResults={max_results}, websiteFilter={inp.get("websiteFilter") or "any"}, categories={inp.get("categories") or []})'
        )

        con = open_duckdb(threads=int(inp.get('threads') or 4), memory_limit=str(inp.get('memoryLimit') or '768MB'))
        scraped_at = datetime.now(timezone.utc).isoformat(timespec='seconds')
        pushed = 0
        stop_reason = 'completed'
        try:
            cursor = con.execute(sql, params)
            columns = [d[0] for d in cursor.description]
            Actor.log.info(f'Query planned; streaming results after {time.time() - started:.1f}s')
            while True:
                chunk = cursor.fetchmany(BATCH)
                if not chunk:
                    break
                rows = [to_row(dict(zip(columns, rec)), release, scraped_at) for rec in chunk]
                allowed, limit_hit = await charger.charge(EVENT_LEAD, len(rows))
                rows = rows[:allowed]
                if rows:
                    await Actor.push_data(rows)
                    pushed += len(rows)
                if limit_hit or allowed < len(chunk):
                    stop_reason = 'maximum charge reached'
                    break
                if pushed and pushed % 5000 == 0:
                    Actor.log.info(f'{pushed} leads so far ({time.time() - started:.0f}s)')
        except duckdb.Error as exc:
            message = str(exc)
            if 'HTTP' in message or '403' in message or '404' in message:
                raise RuntimeError(
                    f'Could not read the Overture release {release} from S3 ({message.splitlines()[0]}). '
                    'Check the release name at https://docs.overturemaps.org/release/ and retry.'
                ) from exc
            raise
        finally:
            con.close()

        if pushed >= max_results:
            stop_reason = f'maxResults ({max_results}) reached'
        duration = round(time.time() - started, 1)
        summary = {
            'release': release,
            'bbox': {'west': area[0], 'south': area[1], 'east': area[2], 'north': area[3]},
            'leads': pushed,
            'durationSecs': duration,
            'stopReason': stop_reason,
            'filters': {
                'categories': inp.get('categories') or [],
                'websiteFilter': inp.get('websiteFilter') or 'any',
                'requirePhone': bool(inp.get('requirePhone')),
                'minConfidence': inp.get('minConfidence'),
                'countries': inp.get('countries') or [],
                'excludeClosed': inp.get('excludeClosed', True),
                'nameContains': inp.get('nameContains'),
            },
        }
        await Actor.set_value('SUMMARY', summary)
        await Actor.set_status_message(f'{pushed} leads in {duration}s ({stop_reason})')
        Actor.log.info(f'Done: {pushed} leads in {duration}s ({stop_reason})')
        if pushed == 0:
            Actor.log.warning('No places matched. Widen the bbox, drop category filters, or check category names (for example restaurant, dentist, plumber, hair_salon).')
