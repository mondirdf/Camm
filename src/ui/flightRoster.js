import * as Cesium from 'cesium';

const REFRESH_MS = 3000;
const MAX_ROWS = 150;
const MAX_PATH_POINTS = 400;
const PATH_COLORS = ['#00d4ff', '#ffbe5c', '#a98bff', '#5dffbd', '#ff718e', '#f4f56e'];

function clean(value) {
  return String(value ?? '').trim();
}

function searchableText(flight) {
  return [
    flight.callsign,
    flight.registration,
    flight.icao24,
    flight.operator,
    flight.routeOrigin,
    flight.routeDestination,
    flight.originName,
    flight.destinationName,
    flight.typeName,
    flight.typeCode,
    flight.aircraftClass,
    flight.originCountry,
  ]
    .map(clean)
    .join(' ')
    .toUpperCase();
}

function queryTokens(query) {
  return clean(query)
    .toUpperCase()
    .replace(/\b(FROM|TO)\b/g, ' ')
    .split(/[\s,→>\-/]+/)
    .filter(Boolean);
}

/** Search and multi-select the live aircraft already loaded by the Flights layer. */
export class FlightRoster {
  constructor({ root, layer, viewer }) {
    this.root = root;
    this.layer = layer;
    this.viewer = viewer;
    this.search = root?.querySelector('#flight-roster-search');
    this.list = root?.querySelector('[data-flight-list]');
    this.count = root?.querySelector('[data-flight-count]');
    this.selectedCount = root?.querySelector('[data-flight-selected]');
    this.focusButton = root?.querySelector('[data-flight-focus]');
    this.empty = root?.querySelector('[data-flight-empty]');
    this.selected = new Set();
    this.flights = [];
    this.paths = new Map();
    this.pathEntities = new Map();
    this.historyLoaded = new Set();
    this.historyQueue = Promise.resolve();
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.search?.addEventListener('input', () => this.render(), { signal });
    this.focusButton?.addEventListener(
      'click',
      () => this.focusSelected(),
      { signal },
    );
    this.list?.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-flight-id]');
      if (!checkbox) return;
      if (checkbox.checked) {
        this.selected.add(checkbox.dataset.flightId);
        this.layer?.enrichRosterFlight?.(checkbox.dataset.flightId);
        this.loadHistoricalTrack(checkbox.dataset.flightId);
      }
      else {
        this.selected.delete(checkbox.dataset.flightId);
        this.removePath(checkbox.dataset.flightId);
        this.historyLoaded.delete(checkbox.dataset.flightId);
      }
      this.refreshSelectedPaths();
      this.render();
    }, { signal });
    this.list?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-focus-id]');
      if (!button) return;
      this.focusFlight(button.dataset.focusId);
    }, { signal });
    this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  refresh() {
    if (!this.root || this.root.closest('[hidden]')) return;
    try {
      this.flights = this.layer?.getAnalystRecords?.(5000) || [];
      this.refreshSelectedPaths();
      this.render();
    } catch {
      this.flights = [];
      this.render('Flight data is temporarily unavailable.');
    }
  }

  refreshSelectedPaths() {
    if (!this.selected.size || !this.layer?.getRosterDetails) return;
    const selectedIds = [...this.selected];
    const details = this.layer.getRosterDetails(selectedIds);
    const present = new Set(details.map((flight) => flight.icao24));
    for (const flight of details) {
      const points = this.paths.get(flight.icao24) || [];
      const known = new Set(points.map((point) => point.epochMs));
      for (const fix of flight.fixes || []) {
        if (known.has(fix.epochMs)) continue;
        points.push(fix);
        known.add(fix.epochMs);
      }
      points.sort((a, b) => a.epochMs - b.epochMs);
      this.paths.set(flight.icao24, points.slice(-MAX_PATH_POINTS));
      this.upsertPath(flight.icao24, this.paths.get(flight.icao24));
    }
    // Keep a selected flight's last path visible through brief feed gaps.
    for (const id of selectedIds) {
      if (!present.has(id) && this.pathEntities.has(id)) continue;
      if (!present.has(id)) this.removePath(id);
    }
  }

  loadHistoricalTrack(id) {
    if (this.historyLoaded.has(id) || !this.layer?.getHistoricalTrack) return;
    this.historyLoaded.add(id);
    this.historyQueue = this.historyQueue
      .then(async () => {
        if (!this.selected.has(id)) return;
        const fixes = await this.layer.getHistoricalTrack(id);
        if (!this.selected.has(id) || !fixes?.length) return;
        const points = this.paths.get(id) || [];
        const known = new Set(points.map((point) => point.epochMs));
        for (const fix of fixes) {
          if (known.has(fix.epochMs)) continue;
          points.push(fix);
          known.add(fix.epochMs);
        }
        points.sort((a, b) => a.epochMs - b.epochMs);
        this.paths.set(id, points.slice(-MAX_PATH_POINTS));
        this.upsertPath(id, this.paths.get(id));
        this.render();
      })
      .catch(() => {
        // The roster continues with locally accumulated live fixes if the
        // provider has no historical track or its endpoint is unavailable.
      });
  }

  upsertPath(id, points) {
    if (!this.viewer || points.length < 2) return;
    const positions = points.map((point) =>
      Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.altitudeM ?? 0),
    );
    const existing = this.pathEntities.get(id);
    if (existing) {
      existing.polyline.positions = positions;
      return;
    }
    const index = [...this.selected].indexOf(id) % PATH_COLORS.length;
    const color = Cesium.Color.fromCssColorString(PATH_COLORS[index]);
    const entity = this.viewer.entities.add({
      id: `flight-roster-path:${id}`,
      polyline: {
        positions,
        width: 2.5,
        material: color.withAlpha(0.86),
        depthFailMaterial: color.withAlpha(0.46),
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
    this.pathEntities.set(id, entity);
  }

  removePath(id) {
    const entity = this.pathEntities.get(id);
    if (entity) this.viewer?.entities?.remove(entity);
    this.pathEntities.delete(id);
    this.paths.delete(id);
  }

  static routeLabel(flight) {
    const origin = [clean(flight.originName), clean(flight.routeOrigin)]
      .filter(Boolean).join(' ');
    const destination = [clean(flight.destinationName), clean(flight.routeDestination)]
      .filter(Boolean).join(' ');
    if (!origin && !destination) return 'Route unavailable';
    return `${origin || 'Unknown origin'} → ${destination || 'Unknown destination'}`;
  }

  static formatAltitude(meters, onGround) {
    if (onGround) return 'GROUND';
    if (!Number.isFinite(meters)) return 'ALT —';
    const feet = Math.round(meters * 3.28084);
    return `ALT BARO ${Math.round(meters).toLocaleString()} m / ${feet.toLocaleString()} ft`;
  }

  static formatSpeed(mps, label) {
    return Number.isFinite(mps)
      ? `${label} ${Math.round(mps * 1.94384).toLocaleString()} kt`
      : `${label} —`;
  }

  static formatVerticalRate(mps) {
    if (!Number.isFinite(mps)) return 'V/S —';
    const fpm = Math.round(mps * 196.8504);
    const sign = fpm > 0 ? '+' : '';
    return `V/S ${sign}${fpm.toLocaleString()} ft/min`;
  }

  static formatPosition(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'POS —';
    return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  }

  static formatContactTime(epochMs, stale, now = Date.now()) {
    if (!Number.isFinite(epochMs)) return stale ? 'STALE' : 'TIME —';
    const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
    return `${stale ? 'STALE · ' : ''}${seconds}s ago`;
  }

  render(message = '') {
    if (!this.list) return;
    const query = queryTokens(this.search?.value);
    const rows = this.flights
      .filter((flight) => {
        if (!query.length) return true;
        const text = searchableText(flight);
        return query.every((token) => text.includes(token));
      })
      .sort((a, b) => {
        const aName = clean(a.callsign || a.registration || a.icao24);
        const bName = clean(b.callsign || b.registration || b.icao24);
        return aName.localeCompare(bName);
      });

    this.count.textContent = query.length
      ? `${rows.length} / ${this.flights.length}`
      : String(this.flights.length);
    this.selectedCount.textContent = `${this.selected.size} selected`;
    this.focusButton.disabled = this.selected.size === 0;
    this.list.replaceChildren();

    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'flight-roster-empty';
      empty.textContent = message || (query.length
        ? 'No loaded flights match that callsign or route.'
        : 'No live aircraft loaded. Enable Live Flights and wait for a feed update.');
      this.list.append(empty);
      return;
    }

    const visible = rows.slice(0, MAX_ROWS);
    for (const flight of visible) this.list.append(this.createRow(flight));
    if (rows.length > visible.length) {
      const more = document.createElement('p');
      more.className = 'flight-roster-empty';
      more.textContent = `Showing ${MAX_ROWS} of ${rows.length}. Refine the search to narrow results.`;
      this.list.append(more);
    }
  }

  createRow(flight) {
    const id = clean(flight.icao24 || flight.id);
    const label = clean(flight.callsign || flight.registration || id) || 'Unknown flight';
    const route = FlightRoster.routeLabel(flight);
    const pathCount = this.paths.get(id)?.length || 0;
    const row = document.createElement('div');
    row.className = 'flight-roster-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(this.selected.has(id)));

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.flightId = id;
    checkbox.checked = this.selected.has(id);
    checkbox.setAttribute('aria-label', `Select ${label}`);

    const details = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = label;
    const subtitle = document.createElement('small');
    subtitle.textContent = [
      route,
      FlightRoster.formatAltitude(flight.altitudeM, flight.onGround),
      FlightRoster.formatSpeed(flight.groundSpeedMps ?? flight.speedMps, 'GS'),
      FlightRoster.formatSpeed(flight.airSpeedMps, 'AS'),
      FlightRoster.formatVerticalRate(flight.verticalRateMps),
      Number.isFinite(flight.heading) ? `HDG ${Math.round(flight.heading)}°` : 'HDG —',
      FlightRoster.formatPosition(flight.lat, flight.lon),
      `${pathCount} path fixes · ${clean(flight.source) || 'unknown source'}`,
      [clean(flight.operator), clean(flight.typeName || flight.typeCode || flight.aircraftClass)]
        .filter(Boolean).join(' · ') || 'Operator / type —',
      FlightRoster.formatContactTime(flight.lastContactEpochMs, flight.stale),
      ].join('\n');
    details.append(title, subtitle);

    const focus = document.createElement('button');
    focus.type = 'button';
    focus.dataset.focusId = id;
    focus.textContent = 'FOCUS';
    focus.setAttribute('aria-label', `Focus ${label}`);
    row.append(checkbox, details, focus);
    return row;
  }

  focusSelected() {
    const match = this.flights.find((flight) =>
      this.selected.has(clean(flight.icao24 || flight.id)),
    );
    if (match) this.focusFlight(clean(match.icao24 || match.id));
  }

  focusFlight(id) {
    this.layer?.trackById?.(id, { origin: 'user' });
  }

  destroy() {
    this.abort.abort();
    clearInterval(this.timer);
    this.list?.replaceChildren();
    for (const entity of this.pathEntities.values())
      this.viewer?.entities?.remove(entity);
    this.pathEntities.clear();
    this.paths.clear();
    this.historyLoaded.clear();
    this.selected.clear();
  }
}
