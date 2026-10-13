import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIT_ENABLED_FEEDS,
  TRANSIT_FEED_REGISTRY,
  TRANSIT_FEED_ID_PATTERN,
  TRANSIT_MODES,
  getRegisteredTransitFeed,
  getTransitFeed,
  haversineKm,
  publicTransitCatalog,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';

test('every registered feed is keyless, https, licensed, and uniquely identified', () => {
  const ids = new Set();
  for (const feed of TRANSIT_FEED_REGISTRY) {
    assert.match(
      feed.id,
      TRANSIT_FEED_ID_PATTERN,
      `${feed.id} is a valid path segment`,
    );
    assert.equal(ids.has(feed.id), false, `${feed.id} is unique`);
    ids.add(feed.id);
    const url = new URL(feed.url);
    assert.equal(url.protocol, 'https:', `${feed.id} fetches over https`);
    assert.equal(
      url.search.includes('key='),
      false,
      `${feed.id} carries no key in its URL`,
    );
    assert.ok(
      feed.license && feed.licenseUrl && feed.attribution,
      `${feed.id} names its license`,
    );
    assert.ok(
      feed.loadRadiusKm > 0 && feed.loadRadiusKm <= 1000,
      `${feed.id} radius is sane`,
    );
    assert.ok(
      Math.abs(feed.center.lat) <= 90 && Math.abs(feed.center.lon) <= 180,
    );
    assert.ok(
      TRANSIT_MODES.includes(feed.defaultMode),
      `${feed.id} default mode is known`,
    );
    assert.ok(Object.isFrozen(feed), `${feed.id} is immutable`);
  }
});

test('getTransitFeed is the only door to an upstream URL and refuses anything unregistered', () => {
  assert.equal(
    getTransitFeed('mbta')?.url,
    'https://cdn.mbta.com/realtime/VehiclePositions.pb',
  );
  assert.equal(getTransitFeed('MBTA'), null);
  assert.equal(getTransitFeed('../etc/passwd'), null);
  assert.equal(getTransitFeed('https://evil.example'), null);
  assert.equal(getTransitFeed(''), null);
  assert.equal(getTransitFeed(null), null);
  assert.equal(getTransitFeed(42), null);
});

test('haversine matches known city distances', () => {
  const bostonToNyc = haversineKm(42.3601, -71.0589, 40.7128, -74.006);
  assert.ok(
    Math.abs(bostonToNyc - 306) < 5,
    `Boston–NYC ≈ 306 km, got ${bostonToNyc}`,
  );
  assert.equal(haversineKm(0, 0, 0, 0), 0);
});

test('feeds in range are nearest-first and honor slack as hysteresis', () => {
  // Camera over Cambridge, MA → MBTA only.
  const boston = transitFeedsInRange(42.37, -71.11);
  assert.deepEqual(
    boston.map((f) => f.id),
    ['mbta'],
  );
  // Mid-Atlantic: nothing.
  assert.deepEqual(transitFeedsInRange(40, -40), []);
  // Just outside MBTA's 70 km circle (≈ 80 km south) — out without slack, in with 20 km slack.
  const farLat = 42.3601 - 80 / 111;
  assert.deepEqual(transitFeedsInRange(farLat, -71.0589), []);
  assert.deepEqual(
    transitFeedsInRange(farLat, -71.0589, 20).map((f) => f.id),
    ['mbta'],
  );
  // Bad input never throws.
  assert.deepEqual(transitFeedsInRange(NaN, 1), []);
  // A national feed covers its own cities and not the neighbour's capital.
  for (const [city, lat, lon] of [
    ['Oslo', 59.91, 10.75],
    ['Bergen', 60.39, 5.32],
    ['Tromsø', 69.65, 18.96],
  ]) {
    assert.ok(
      transitFeedsInRange(lat, lon).some((f) => f.id === 'entur-norway'),
      `${city} is covered by Entur`,
    );
  }
  assert.deepEqual(
    transitFeedsInRange(60.17, 24.94).map((f) => f.id),
    ['hsl-helsinki'],
    'Helsinki polls HSL only',
  );
});

test('Denver and Boulder activate one shared RTD regional feed', () => {
  for (const [city, lat, lon] of [
    ['Denver', 39.7392, -104.9903],
    ['North Boulder', 40.06, -105.28],
  ]) {
    assert.deepEqual(
      transitFeedsInRange(lat, lon).map((feed) => feed.id),
      ['rtd-denver'],
      `${city} polls RTD once rather than separate city feeds`,
    );
  }
});

test('RTD catalog admits one canonical live feed without proxy history', () => {
  const feed = getTransitFeed('rtd-denver');
  assert.equal(
    TRANSIT_FEED_REGISTRY.filter((entry) => entry.id === 'rtd-denver').length,
    1,
  );
  assert.equal(feed, getRegisteredTransitFeed('rtd-denver'));
  assert.equal(feed.defaultEnabled, true);
  assert.equal(
    feed.url,
    'https://open-data.rtd-denver.com/files/gtfs-rt/rtd/VehiclePosition.pb',
  );
  assert.deepEqual(feed.center, { lat: 39.7392, lon: -104.9903 });
  assert.equal(feed.loadRadiusKm, 70);
  assert.equal(feed.license, 'RTD GTFS Realtime License Agreement');
  assert.equal(
    feed.licenseUrl,
    'https://www.rtd-denver.com/open-records/open-spatial-information/gtfs-realtime-license-agreement',
  );
  assert.equal(feed.attribution, 'Regional Transportation District (RTD)');
  assert.match(feed.terms.quote, /limited and revocable rights/);
  for (const value of [feed, feed.center, feed.terms]) {
    assert.ok(Object.isFrozen(value));
  }
  const entries = publicTransitCatalog().filter(
    (entry) => entry.id === feed.id,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].historyRetention, false);
  assert.equal(entries[0].attribution, feed.attribution);
  assert.equal(entries[0].licenseUrl, feed.licenseUrl);
  assert.equal('url' in entries[0], false);
  assert.equal('headers' in entries[0], false);
});

test('RTD coverage uses a 70 km cold radius and existing 40 km warm hysteresis', () => {
  for (const [city, lat, lon] of [
    ['Boulder', 40.015, -105.2705],
    ['Longmont', 40.1672, -105.1019],
    ['Nederland', 39.9614, -105.5108],
    ['Denver airport', 39.8561, -104.6737],
  ]) {
    assert.deepEqual(
      transitFeedsInRange(lat, lon).map((feed) => feed.id),
      ['rtd-denver'],
      city,
    );
  }
  for (const [city, lat, lon] of [
    ['Fort Collins', 40.5853, -105.0844],
    ['Colorado Springs', 38.8339, -104.8214],
  ]) {
    assert.deepEqual(transitFeedsInRange(lat, lon), [], `${city}: cold`);
    assert.deepEqual(
      transitFeedsInRange(lat, lon, 40).map((feed) => feed.id),
      ['rtd-denver'],
      `${city}: warm`,
    );
  }
  assert.deepEqual(transitFeedsInRange(41.14, -104.8202, 40), [], 'Cheyenne');
  const feed = getTransitFeed('rtd-denver');
  for (const slack of [0, 40]) {
    for (const delta of [-0.01, 0.01]) {
      const lat =
        feed.center.lat + ((70 + slack + delta) / 6371) * (180 / Math.PI);
      assert.equal(
        transitFeedsInRange(lat, feed.center.lon, slack).includes(feed),
        delta < 0,
      );
    }
  }
  for (const [lat, lon] of [
    [NaN, -105],
    [40, NaN],
    [Infinity, -105],
    [40, -Infinity],
  ]) {
    assert.deepEqual(transitFeedsInRange(lat, lon), []);
  }
});

// RTD routes.txt from https://www.rtd-denver.com/files/gtfs/google_transit.zip,
// feed version Sep26-37243-12-13-20261009-141920. Exact route_id, not short names.
test('RTD resolves only the exact route IDs in its static GTFS mode table', () => {
  const feed = getTransitFeed('rtd-denver');
  const routes = {
    tram: ['101C', '101D', '101E', '101T', '103W', '107R'],
    rail: ['113B', '113G', '117N', 'A'],
    bus: [
      '0',
      '0B',
      '0L',
      '1',
      '10',
      '100',
      '104L',
      '105',
      '11',
      '112',
      '116X',
      '12',
      '120',
      '120L',
      '120X',
      '121',
      '130',
      '133',
      '135',
      '139',
      '14',
      '145X',
      '15',
      '153',
      '15L',
      '16',
      '169',
      '169L',
      '17',
      '19',
      '20',
      '204',
      '205',
      '206',
      '208',
      '21',
      '22',
      '225',
      '225D',
      '225T',
      '228A',
      '228F',
      '23',
      '24',
      '28',
      '287',
      '3',
      '30',
      '31',
      '32',
      '323',
      '324',
      '326',
      '327',
      '35',
      '36',
      '37',
      '38',
      '3L',
      '4',
      '40',
      '402L',
      '42',
      '43',
      '44',
      '45',
      '46',
      '48',
      '483',
      '49',
      '51',
      '52',
      '520',
      '53',
      '59',
      '6',
      '65',
      '66',
      '7',
      '72',
      '73',
      '76',
      '8',
      '80',
      '83D',
      '83L',
      '88',
      '88L',
      '9',
      '92',
      '93L',
      '99',
      'AB1',
      'AB2',
      'AB3',
      'AL',
      'ART',
      'AT',
      'ATA',
      'BOLT',
      'BOND',
      'CV',
      'DASH',
      'EV',
      'FF1',
      'FF2',
      'FF3',
      'FF4',
      'FF5',
      'FMR',
      'FREE',
      'GS',
      'JUMP',
      'LD1',
      'LX2',
      'NB1',
      'NB2',
      'PD',
      'RX',
      'SKIP',
    ],
  };
  assert.equal(new Set(Object.values(routes).flat()).size, 130);
  for (const [mode, ids] of Object.entries(routes)) {
    for (const id of ids) {
      assert.equal(transitModeFor(feed, id), mode, id);
      assert.equal(transitModeResolved(feed, id), true, id);
    }
  }
  assert.equal(feed.defaultMode, 'unknown');
  for (const id of [
    null,
    undefined,
    '',
    ' ',
    'NEW',
    '101Z',
    '113Z',
    'C',
    'D',
    'E',
    'T',
    'W',
    'R',
    'B',
    'G',
    'N',
    'BOUND',
    'bond',
    ' BOND ',
    0,
  ]) {
    assert.equal(transitModeFor(feed, id), 'unknown', String(id));
    assert.equal(transitModeResolved(feed, id), false, String(id));
  }
});

test('route hints refine a feed default and never escape the known modes', () => {
  const mbta = getTransitFeed('mbta');
  assert.equal(transitModeFor(mbta, 'Red'), 'subway');
  assert.equal(transitModeFor(mbta, 'Green-B'), 'tram');
  assert.equal(transitModeFor(mbta, 'CR-Fitchburg'), 'rail');
  assert.equal(transitModeFor(mbta, 'Boat-F1'), 'ferry');
  assert.equal(transitModeFor(mbta, '66'), 'bus');
  assert.equal(transitModeFor(mbta, null), 'bus');
  const hsl = getTransitFeed('hsl-helsinki');
  assert.equal(transitModeFor(hsl, '31M1'), 'subway');
  assert.equal(transitModeFor(hsl, '1006'), 'tram');
  assert.equal(transitModeFor(hsl, '9982'), 'bus');
  const msp = getTransitFeed('metrotransit-msp');
  assert.equal(transitModeFor(msp, '901'), 'tram');
  assert.equal(transitModeFor(msp, '17'), 'bus');
  const entur = getTransitFeed('entur-norway');
  assert.equal(transitModeFor(entur, 'VYG:Line:R10'), 'rail');
  assert.equal(transitModeFor(entur, 'TRO:Line:1_310'), 'bus');
  assert.equal(transitModeFor({ defaultMode: 'spaceship' }, 'x'), 'unknown');
  assert.equal(transitModeFor(null, 'x'), 'unknown');
});

test('the public catalog exposes coverage and credit, never the upstream URL or headers', () => {
  const catalog = publicTransitCatalog();
  assert.equal(catalog.length, TRANSIT_ENABLED_FEEDS.length);
  for (const entry of catalog) {
    assert.equal('url' in entry, false);
    assert.equal('headers' in entry, false);
    assert.ok(entry.id && entry.name && entry.region && entry.attribution);
    assert.ok(
      Number.isFinite(entry.center.lat) && Number.isFinite(entry.loadRadiusKm),
    );
  }
});

test('the enabled set is a gate on the registry, not a copy of it', () => {
  // Every registered feed is switched on today. The gate still has to be the
  // thing that decides that, because the moment an operator's terms change the
  // owner flips one flag and expects the feed to become unreachable — not to
  // stay routable because the filter had quietly become a no-op.
  assert.deepEqual(
    TRANSIT_ENABLED_FEEDS.map((feed) => feed.id),
    TRANSIT_FEED_REGISTRY.filter((feed) => feed.defaultEnabled === true).map(
      (feed) => feed.id,
    ),
  );
  for (const feed of TRANSIT_FEED_REGISTRY) {
    assert.equal(
      typeof feed.defaultEnabled,
      'boolean',
      `${feed.id} states whether it ships on`,
    );
    assert.equal(
      Boolean(getTransitFeed(feed.id)),
      feed.defaultEnabled,
      `${feed.id} is routable exactly when it is enabled`,
    );
    assert.ok(getRegisteredTransitFeed(feed.id), `${feed.id} stays documented`);
  }
});

test('a mode the route id established is resolved; a feed default is only a guess', () => {
  // TransLink publishes rail in a feed whose default is bus. A consumer that
  // judges physical plausibility must know the difference, or a 140 km/h
  // train is refused as an impossible bus.
  const translink = getTransitFeed('translink-seq');
  assert.equal(transitModeFor(translink, '600'), 'bus');
  assert.equal(transitModeResolved(translink, '600'), false, 'defaulted');
  const mbta = getTransitFeed('mbta');
  assert.equal(transitModeResolved(mbta, 'Red'), true);
  assert.equal(
    transitModeResolved(mbta, '66'),
    true,
    'a numeric MBTA route is a bus by rule, not by default',
  );
  assert.equal(transitModeResolved(mbta, null), false);
  assert.equal(transitModeResolved({ defaultMode: 'bus' }, 'x'), false);
  assert.equal(
    transitModeResolved({ routeMode: () => 'spaceship' }, 'x'),
    false,
    'an unknown hint resolves nothing',
  );
});

test('only MBTA retains proxy history while every other registered feed stays live-enabled', () => {
  assert.deepEqual(
    publicTransitCatalog()
      .filter((feed) => feed.historyRetention)
      .map((feed) => feed.id),
    ['mbta'],
  );
  assert.equal(getTransitFeed('capmetro-austin').defaultEnabled, true);
  assert.equal(getTransitFeed('mbta').attribution, 'MBTA / MassDOT');
});

test('published transit history scope agrees with the catalog capability', () => {
  const retained = publicTransitCatalog().filter(
    (feed) => feed.historyRetention,
  );
  assert.deepEqual(
    retained.map((feed) => feed.id),
    ['mbta'],
  );
  const sources = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  );
  const row = sources
    .split('\n')
    .find((line) => line.startsWith('| **MBTA / MassDOT**'));
  assert.match(
    row,
    /live vehicles and up to 15 minutes of recently observed positions/,
  );
  assert.match(row, /MBTA \/ MassDOT.*courtesy/);
  assert.match(sources, /other feeds have no proxy retention/);
  const state = readFileSync(
    new URL('../../docs/CURRENT-STATE.md', import.meta.url),
    'utf8',
  );
  const transit = state.slice(
    state.indexOf('Transit is off by default'),
    state.indexOf('`src/data/militaryAwareness.js` remains'),
  );
  assert.match(transit, /Restart clears it/);
  assert.doesNotMatch(
    transit,
    /four fixes|0\.95x|guaranteed lower|one poll interval behind/,
  );
});
