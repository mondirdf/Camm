import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightRoster } from './flightRoster.js';

test('flight roster formats reported altitude, ground/air speed, climb and route', () => {
  assert.equal(
    FlightRoster.formatAltitude(10000, false),
    'ALT BARO 10,000 m / 32,808 ft',
  );
  assert.equal(FlightRoster.formatAltitude(null, true), 'GROUND');
  assert.equal(FlightRoster.formatSpeed(100, 'GS'), 'GS 194 kt');
  assert.equal(FlightRoster.formatSpeed(null, 'AS'), 'AS —');
  assert.equal(FlightRoster.formatVerticalRate(5), 'V/S +984 ft/min');
  assert.equal(
    FlightRoster.routeLabel({
      originName: 'John F Kennedy Intl',
      routeOrigin: 'JFK',
      destinationName: 'Heathrow',
      routeDestination: 'LHR',
    }),
    'John F Kennedy Intl JFK → Heathrow LHR',
  );
  assert.equal(FlightRoster.routeLabel({}), 'Route unavailable');
});

test('flight roster formats source position when coordinates are available', () => {
  assert.equal(FlightRoster.formatPosition(40.6413, -73.7781), '40.641, -73.778');
  assert.equal(FlightRoster.formatPosition(null, null), 'POS —');
  assert.equal(FlightRoster.formatContactTime(5000, false, 8000), '3s ago');
  assert.equal(FlightRoster.formatContactTime(null, true, 8000), 'STALE');
});
