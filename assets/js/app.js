/* eslint-disable no-console */
// app.js - Europe Castles MVP

const AppState = {
  castles: [],
  countryChunks: new Map(),
  visibleCastles: [],
  fuse: null,
  filters: {
    country: '',
    type: '',
    era: '',
    condition: '',
    opening: false,
    access: false,
    search: '',
  },
  planner: {
    selection: [],
    order: [],
    routing: {
      mode: 'car',
      engine: 'osrm',
      daily_drive_hours: 5,
    },
  },
  totals: {
    km: 0,
    hours: 0,
    days: [],
  },
  preferences: {
    highContrast: false,
    reducedMotion: false,
  },
  config: {
    dataVersion: '2025.11.m1',
    osrmEndpoint: 'https://router.project-osrm.org',
    haversineSpeeds: { car: 70, bike: 18, walk: 5 },
    stopOverheadHours: 0.25,
    map: {
      center: [51.0, 10.0],
      zoom: 5,
      tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '(c) OpenStreetMap contributors | (c) Natural Earth',
    },
  },
};

const ImageHelper = {
  placeholder(castle) {
    const seed = encodeURIComponent((castle.id || castle.name || 'castle').toLowerCase());
    return `https://picsum.photos/seed/${seed}/800/600`;
  },
  url(castle) {
    return castle.image?.thumb_url || this.placeholder(castle);
  },
};

const Storage = {
  save() {
    const snapshot = {
      planner: AppState.planner,
      preferences: AppState.preferences,
      filters: AppState.filters,
      dataVersion: AppState.config.dataVersion,
    };
    localStorage.setItem('eu-castles-state', JSON.stringify(snapshot));
  },
  load() {
    try {
      const saved = JSON.parse(localStorage.getItem('eu-castles-state'));
      if (saved?.dataVersion === AppState.config.dataVersion) {
        Object.assign(AppState.filters, saved.filters);
        Object.assign(AppState.preferences, saved.preferences);
        Object.assign(AppState.planner, saved.planner);
      }
    } catch (err) {
      console.warn('Skipping corrupt state', err);
    }
  },
};

const DataStore = {
  async init() {
    Storage.load();
    await this.loadBase();
  },
  async loadBase() {
    // Step 1: Load base dataset
    const response = await fetch('data/castles.min.json');
    if (!response.ok) throw new Error('Failed to load castles data');
    const payload = await response.json();
    AppState.castles = payload;
    this.buildCountryIndex();
    this.setupFuse(payload);
  },
  setupFuse(list) {
    // Step 2: Build Fuse index for fuzzy search
    AppState.fuse = new Fuse(list, {
      includeScore: true,
      threshold: 0.35,
      keys: [
        { name: 'name', weight: 0.5 },
        { name: 'alt_names', weight: 0.2 },
        { name: 'country', weight: 0.1 },
        { name: 'tags', weight: 0.2 },
      ],
    });
  },
  buildCountryIndex() {
    const select = document.getElementById('countryFilter');
    const countries = [...new Set(AppState.castles.map((c) => c.country))].sort();
    const fragment = document.createDocumentFragment();
    countries.forEach((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code;
      fragment.appendChild(opt);
    });
    select.appendChild(fragment);
  },
  async loadCountryChunk(code) {
    if (!code || AppState.countryChunks.has(code)) return;
    try {
      const resp = await fetch(`data/eu/${code}.json`);
      if (resp.ok) {
        const data = await resp.json();
        AppState.countryChunks.set(code, data);
        AppState.castles.push(...data);
        this.setupFuse(AppState.castles);
      }
    } catch (err) {
      console.warn('Country chunk load failed', code, err);
    }
  },
  getFiltered() {
    // Step 3: Apply search and filters
    let working = [...AppState.castles];
    const { search, country, type, era, condition, opening, access } = AppState.filters;

    if (country) working = working.filter((c) => c.country === country);
    if (type) working = working.filter((c) => c.type === type);
    if (era) working = working.filter((c) => (c.era || '').includes(era));
    if (condition) working = working.filter((c) => c.condition === condition);
    if (opening) working = working.filter((c) => Boolean(c.opening_hours));
    if (access) working = working.filter((c) => c.tags?.includes('public'));

    if (search && AppState.fuse) {
      const results = AppState.fuse.search(search).slice(0, 200);
      const ids = new Set(results.map((r) => r.item.id));
      working = working.filter((c) => ids.has(c.id));
    }
    return working;
  },
};

const MapView = {
  map: null,
  markerLayer: null,
  selectionLayer: new Map(),
  defaultIcon: null,
  async init() {
    // Step 4: Initialize Leaflet map & layers
    this.map = L.map('map', {
      center: AppState.config.map.center,
      zoom: AppState.config.map.zoom,
      zoomControl: false,
    });
    L.tileLayer(AppState.config.map.tileUrl, {
      attribution: AppState.config.map.attribution,
      minZoom: 3,
      maxZoom: 19,
    }).addTo(this.map);
    L.control.zoom({ position: 'topright' }).addTo(this.map);

    this.markerLayer = L.markerClusterGroup({
      chunkedLoading: true,
      disableClusteringAtZoom: 11,
    });
    this.markerLayer.on('clusterclick', (event) => {
      event.layer.spiderfy();
    });
    this.markerLayer.addTo(this.map);
    this.defaultIcon = new L.Icon.Default();
  },
  setMarkers(castles) {
    // Step 5: Sync markers with filtered dataset
    this.markerLayer.clearLayers();
    this.selectionLayer.clear();
    castles.forEach((castle) => {
      const marker = L.marker([castle.coords.lat, castle.coords.lon], {
        title: castle.name,
      });
      marker.on('click', () => UIController.openDrawer(castle));
      marker.on('dblclick', () => TrailsPlanner.toggleCastle(castle.id));
      this.markerLayer.addLayer(marker);
      this.selectionLayer.set(castle.id, marker);
    });
  },
  highlightSelection(ids) {
    // Indicate selection on markers
    ids.forEach((id) => {
      const marker = this.selectionLayer.get(id);
      if (marker) marker.setIcon(this.selectedIcon());
    });
  },
  clearSelectionIcons() {
    this.selectionLayer.forEach((marker) => marker.setIcon(this.defaultIcon));
  },
  selectedIcon() {
    return L.divIcon({
      className: 'selected-marker',
      html: '<div class="selected-dot"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  },
  fitToSelection(ids) {
    const bounds = [];
    ids.forEach((id) => {
      const castle = AppState.castles.find((c) => c.id === id);
      if (castle) bounds.push([castle.coords.lat, castle.coords.lon]);
    });
    if (bounds.length > 1) this.map.fitBounds(bounds);
  },
};

const UIController = {
  cardGrid: document.getElementById('cardsGrid'),
  filtersPanel: document.getElementById('filtersPanel'),
  drawer: document.getElementById('detailsDrawer'),
  drawerContent: document.getElementById('drawerContent'),
  plannerList: document.getElementById('plannerList'),
  summary: document.getElementById('plannerSummary'),

  init() {
    // Wire UI events
    this.bindFilters();
    this.bindButtons();
    this.syncPreferences();
    this.renderPlanner();
    this.hydrateFilterInputs();
  },

  hydrateFilterInputs() {
    document.getElementById('countryFilter').value = AppState.filters.country || '';
    document.getElementById('typeFilter').value = AppState.filters.type || '';
    document.getElementById('eraFilter').value = AppState.filters.era || '';
    document.getElementById('conditionFilter').value = AppState.filters.condition || '';
    document.getElementById('openingFilter').checked = AppState.filters.opening;
    document.getElementById('accessFilter').checked = AppState.filters.access;
    document.getElementById('searchInput').value = AppState.filters.search || '';
    document.getElementById('modeSelect').value = AppState.planner.routing.mode;
    document.getElementById('engineSelect').value = AppState.planner.routing.engine;
    document.getElementById('dailyHours').value = AppState.planner.routing.daily_drive_hours;
  },

  bindFilters() {
    const updates = ['countryFilter', 'typeFilter', 'eraFilter', 'conditionFilter'];
    updates.forEach((id) => {
      document.getElementById(id).addEventListener('change', async (event) => {
        AppState.filters[id.replace('Filter', '').toLowerCase()] = event.target.value;
        if (id === 'countryFilter') {
          await DataStore.loadCountryChunk(event.target.value);
        }
        this.refreshView();
      });
    });
    document.getElementById('openingFilter').addEventListener('change', (event) => {
      AppState.filters.opening = event.target.checked;
      this.refreshView();
    });
    document.getElementById('accessFilter').addEventListener('change', (event) => {
      AppState.filters.access = event.target.checked;
      this.refreshView();
    });
    document.getElementById('searchInput').addEventListener('input', (event) => {
      AppState.filters.search = event.target.value.trim();
      this.refreshView();
    });
  },

  bindButtons() {
    document.getElementById('filtersToggle').addEventListener('click', () => {
      this.filtersPanel.classList.toggle('open');
    });
    document.getElementById('contrastToggle').addEventListener('click', () => {
      AppState.preferences.highContrast = !AppState.preferences.highContrast;
      this.syncPreferences();
    });
    document.getElementById('motionToggle').addEventListener('click', () => {
      AppState.preferences.reducedMotion = !AppState.preferences.reducedMotion;
      this.syncPreferences();
    });
    document.getElementById('refreshData').addEventListener('click', () => OfflineCache.refresh());
    document.getElementById('drawerClose').addEventListener('click', () => this.closeDrawer());
    document.getElementById('optimizeRoute').addEventListener('click', () => TrailsPlanner.optimizeOrder());
    document.getElementById('clearRoute').addEventListener('click', () => TrailsPlanner.clear());
    document.getElementById('modeSelect').addEventListener('change', (event) => {
      AppState.planner.routing.mode = event.target.value;
      TrailsPlanner.recompute();
      Storage.save();
    });
    document.getElementById('engineSelect').addEventListener('change', (event) => {
      AppState.planner.routing.engine = event.target.value;
      TrailsPlanner.recompute();
      Storage.save();
    });
    document.getElementById('dailyHours').addEventListener('change', (event) => {
      AppState.planner.routing.daily_drive_hours = Number(event.target.value) || 5;
      TrailsPlanner.splitDays();
      Storage.save();
    });
    document.getElementById('exportGpx').addEventListener('click', () => Exporter.download('gpx'));
    document.getElementById('exportKml').addEventListener('click', () => Exporter.download('kml'));
    document.getElementById('exportIcs').addEventListener('click', () => Exporter.download('ics'));
    document.getElementById('exportCsv').addEventListener('click', () => Exporter.download('csv'));
    document.getElementById('shareUrl').addEventListener('click', () => Exporter.shareState());
    document.getElementById('printPlan').addEventListener('click', () => window.print());
  },

  syncPreferences() {
    document.body.classList.toggle('high-contrast', AppState.preferences.highContrast);
    document.body.style.setProperty('--motion-scale', AppState.preferences.reducedMotion ? 0 : 1);
    Storage.save();
  },

  refreshView() {
    AppState.visibleCastles = DataStore.getFiltered();
    MapView.setMarkers(AppState.visibleCastles);
    this.renderCards(AppState.visibleCastles);
    this.updateCardButtons();
    Storage.save();
  },

  renderCards(castles) {
    this.cardGrid.innerHTML = '';
    const template = document.getElementById('cardTemplate');
    castles.forEach((castle) => {
      const node = template.content.cloneNode(true);
      const thumb = node.querySelector('.card-thumb');
      const imageUrl = ImageHelper.url(castle);
      thumb.style.backgroundImage = `url('${imageUrl}')`;
      thumb.setAttribute('aria-label', `${castle.name} thumbnail`);
      node.querySelector('.card-title').textContent = castle.name;
      node.querySelector('.card-meta').textContent = `${castle.country} - ${castle.era || 'Era unknown'}`;
      const chips = node.querySelector('.chip-row');
      [castle.type, castle.condition, castle.tags?.[0]].filter(Boolean).forEach((chipText) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = chipText;
        chips.appendChild(chip);
      });
      const selectBtn = node.querySelector('.card-select');
      selectBtn.dataset.id = castle.id;
      selectBtn.addEventListener('click', () => TrailsPlanner.toggleCastle(castle.id));
      const detailsLink = node.querySelector('[data-action="details"]');
      if (detailsLink) {
        detailsLink.addEventListener('click', (event) => {
          event.preventDefault();
          this.openDrawer(castle);
        });
      }
      node.querySelector('.castle-card').addEventListener('click', (event) => {
        if (event.target.matches('.card-select')) return;
        this.openDrawer(castle);
      });
      this.cardGrid.appendChild(node);
    });
  },

  updateCardButtons() {
    const selected = new Set(AppState.planner.selection);
    this.cardGrid.querySelectorAll('.card-select').forEach((button) => {
      const id = button.dataset.id;
      const isSelected = selected.has(id);
      button.dataset.state = isSelected ? 'selected' : 'idle';
      button.textContent = isSelected ? 'Remove' : 'Add';
    });
    MapView.clearSelectionIcons();
    MapView.highlightSelection(AppState.planner.selection);
  },

  renderPlanner() {
    this.plannerList.innerHTML = '';
    AppState.planner.order.forEach((id, index) => {
      const castle = AppState.castles.find((c) => c.id === id);
      if (!castle) return;
      const li = document.createElement('li');
      li.className = 'planner-item';
      li.innerHTML = `
        <span>${index + 1}. ${castle.name}</span>
        <div>
          <button data-action="up" aria-label="Move up">Up</button>
          <button data-action="down" aria-label="Move down">Down</button>
          <button data-action="remove" aria-label="Remove from plan">Remove</button>
        </div>
      `;
      li.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          if (action === 'up') TrailsPlanner.move(index, -1);
          if (action === 'down') TrailsPlanner.move(index, 1);
          if (action === 'remove') TrailsPlanner.remove(id);
        });
      });
      this.plannerList.appendChild(li);
    });
    this.updateSummary();
    this.updateCardButtons();
  },

  updateSummary() {
    document.getElementById('totalDistance').textContent = `${AppState.totals.km.toFixed(1)} km`;
    document.getElementById('totalTime').textContent = `${AppState.totals.hours.toFixed(1)} h`;
    const daySplit = document.getElementById('daySplit');
    daySplit.innerHTML = '';
    AppState.totals.days.forEach((day, idx) => {
      const div = document.createElement('div');
      div.textContent = `Day ${idx + 1}: ${day.castles.length} stops - ${day.hours.toFixed(1)} h`;
      daySplit.appendChild(div);
    });
  },

  openDrawer(castle) {
    this.drawer.setAttribute('aria-hidden', 'false');
    const heroImage = ImageHelper.url(castle);
    const hasRealImage = Boolean(castle.image?.thumb_url);
    const heroLabel = hasRealImage ? `${castle.name} hero image` : `${castle.name} placeholder image`;
    this.drawerContent.innerHTML = `
      <div class="drawer-hero" role="img" aria-label="${heroLabel}" style="background-image:url('${heroImage}')"></div>
      <div class="drawer-section">
        <h2 class="text-2xl font-bold">${castle.name}</h2>
        <p class="text-slate-400 text-sm">${castle.country} - ${castle.era || 'Era unknown'}</p>
        <div class="chip-row mt-2">
          ${[castle.type, castle.condition].filter(Boolean).map((chip) => `<span class="chip">${chip}</span>`).join('')}
        </div>
        <div class="mt-4 flex gap-2">
          <button class="btn primary" id="drawerAdd">Add to route</button>
          ${castle.wikipedia ? `<a class="btn ghost" href="https://${
            castle.wikipedia
          }" target="_blank" rel="noreferrer">Wikipedia</a>` : ''}
          ${castle.wikidata ? `<button class="btn subtle" id="copyQid">Copy ${castle.wikidata}</button>` : ''}
        </div>
      </div>
      <div class="drawer-section text-sm">
        <p><strong>Condition:</strong> ${castle.condition || 'Unknown'}</p>
        <p><strong>Opening hours:</strong> ${castle.opening_hours || 'Not listed'}</p>
        <p><strong>Website:</strong> ${castle.website ? `<a href="${castle.website}" target="_blank" rel="noreferrer">${castle.website}</a>` : 'Not provided'}</p>
        <p><strong>Source:</strong> ${castle.source}</p>
        <p><strong>Verified:</strong> ${castle.last_verified}</p>
      </div>
      <div class="drawer-section text-xs text-slate-500">
        Image credit: ${castle.image?.license || 'Commons or public domain'}
      </div>
    `;
    document.getElementById('drawerAdd').addEventListener('click', () => TrailsPlanner.toggleCastle(castle.id));
    const copyBtn = document.getElementById('copyQid');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(castle.wikidata);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = `Copy ${castle.wikidata}`), 1500);
      });
    }
  },

  closeDrawer() {
    this.drawer.setAttribute('aria-hidden', 'true');
  },
};

const TrailsPlanner = {
  toggleCastle(id) {
    const exists = AppState.planner.selection.includes(id);
    if (exists) {
      this.remove(id);
    } else {
      AppState.planner.selection.push(id);
      AppState.planner.order.push(id);
      this.recompute();
    }
    UIController.renderPlanner();
    Storage.save();
  },
  remove(id) {
    AppState.planner.selection = AppState.planner.selection.filter((c) => c !== id);
    AppState.planner.order = AppState.planner.order.filter((c) => c !== id);
    this.recompute();
    UIController.renderPlanner();
    Storage.save();
  },
  move(index, delta) {
    const next = index + delta;
    if (next < 0 || next >= AppState.planner.order.length) return;
    const list = AppState.planner.order;
    [list[index], list[next]] = [list[next], list[index]];
    this.recompute();
    UIController.renderPlanner();
    Storage.save();
  },
  clear() {
    AppState.planner.selection = [];
    AppState.planner.order = [];
    this.recompute();
    UIController.renderPlanner();
    Storage.save();
  },
  async recompute() {
    if (AppState.planner.order.length < 2) {
      AppState.totals = { km: 0, hours: 0, days: [] };
      UIController.updateSummary();
      return;
    }
    if (AppState.planner.routing.engine === 'osrm' && navigator.onLine) {
      await this.computeOsrm();
    } else {
      this.computeHaversine();
    }
    this.splitDays();
  },
  getCoordsSequence() {
    return AppState.planner.order
      .map((id) => AppState.castles.find((c) => c.id === id))
      .filter(Boolean)
      .map((castle) => [castle.coords.lon, castle.coords.lat]);
  },
  async computeOsrm() {
    // Step 6: Request OSRM table for matrix
    const coords = this.getCoordsSequence();
    if (coords.length < 2) return;
    const coordinatesParam = coords.map((c) => c.join(',')).join(';');
    const url = `${AppState.config.osrmEndpoint}/table/v1/driving/${coordinatesParam}?annotations=distance,duration`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('OSRM unavailable');
      const data = await resp.json();
      const km = [];
      const hours = [];
      for (let i = 0; i < coords.length - 1; i += 1) {
        const distance = data.distances[i][i + 1] / 1000;
        const durationHours = data.durations[i][i + 1] / 3600;
        km.push(distance);
        hours.push(durationHours);
      }
      AppState.totals.km = km.reduce((a, b) => a + b, 0);
      AppState.totals.hours = hours.reduce((a, b) => a + b, 0);
    } catch (err) {
      console.warn('OSRM failed, fallback to offline', err);
      this.computeHaversine();
    }
  },
  computeHaversine() {
    // Step 7: Offline fallback using straight-line distance
    const coords = AppState.planner.order
      .map((id) => AppState.castles.find((c) => c.id === id))
      .filter(Boolean);
    const kmSegments = [];
    for (let i = 0; i < coords.length - 1; i += 1) {
      const a = coords[i];
      const b = coords[i + 1];
      kmSegments.push(Metrics.haversineKm(a.coords, b.coords));
    }
    const kmTotal = kmSegments.reduce((a, b) => a + b, 0);
    const mode = AppState.planner.routing.mode;
    const perLegOverhead = AppState.config.stopOverheadHours;
    const hoursTotal = kmSegments.reduce(
      (sum, km) => sum + Metrics.etaHoursForKm(km, mode, perLegOverhead),
      0,
    );
    AppState.totals.km = kmTotal;
    AppState.totals.hours = hoursTotal;
  },
  splitDays() {
    const dailyTarget = AppState.planner.routing.daily_drive_hours || 5;
    const allowed = { min: dailyTarget * 0.9, max: dailyTarget * 1.1 };
    const orders = AppState.planner.order.map((id) => AppState.castles.find((c) => c.id === id)).filter(Boolean);
    const result = [];
    let bucket = [];
    let bucketHours = 0;

    orders.forEach((castle, idx) => {
      bucket.push(castle);
      if (idx === orders.length - 1) {
        result.push({ castles: bucket, hours: bucketHours });
        return;
      }
      const nextCastle = orders[idx + 1];
      const legKm = Metrics.haversineKm(castle.coords, nextCastle.coords);
      const legHours = Metrics.etaHoursForKm(
        legKm,
        AppState.planner.routing.mode,
        AppState.config.stopOverheadHours,
      );
      bucketHours += legHours;
      if (bucketHours >= allowed.min && bucketHours <= allowed.max) {
        result.push({ castles: bucket, hours: bucketHours });
        bucket = [];
        bucketHours = 0;
      }
    });
    if (bucket.length && result[result.length - 1] !== bucket) {
      result.push({ castles: bucket, hours: bucketHours });
    }
    AppState.totals.days = result.slice(0, 3);
    UIController.updateSummary();
  },
  optimizeOrder() {
    // Step 8: Nearest Neighbor + 2-opt refinement
    const castles = AppState.planner.order.map((id) => AppState.castles.find((c) => c.id === id));
    if (castles.length < 3) return;

    const remaining = castles.slice(1);
    const ordered = [castles[0]];
    while (remaining.length) {
      const last = ordered[ordered.length - 1];
      let nearestIdx = 0;
      let minDist = Infinity;
      remaining.forEach((candidate, idx) => {
        const dist = Metrics.haversineKm(last.coords, candidate.coords);
        if (dist < minDist) {
          minDist = dist;
          nearestIdx = idx;
        }
      });
      ordered.push(remaining.splice(nearestIdx, 1)[0]);
    }

    const ids = ordered.map((c) => c.id);
    // Simple 2-opt
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 1; i < ids.length - 2; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const newOrder = ids.slice();
          newOrder.splice(i, j - i, ...ids.slice(i, j).reverse());
          if (Metrics.routeLength(newOrder) < Metrics.routeLength(ids)) {
            ids.splice(0, ids.length, ...newOrder);
            improved = true;
          }
        }
      }
    }
    AppState.planner.order = ids;
    this.recompute();
    UIController.renderPlanner();
    Storage.save();
  },
};

const Metrics = {
  toRad(deg) {
    return (deg * Math.PI) / 180;
  },
  speedForMode(mode) {
    return AppState.config.haversineSpeeds[mode] || 50;
  },
  etaHoursForKm(km, mode, stopOverheadHours = 0) {
    return km / this.speedForMode(mode) + stopOverheadHours;
  },
  haversineKm(a, b) {
    const R = 6371;
    const dLat = this.toRad(b.lat - a.lat);
    const dLon = this.toRad(b.lon - a.lon);
    const lat1 = this.toRad(a.lat);
    const lat2 = this.toRad(b.lat);
    const sinLat = Math.sin(dLat / 2) ** 2;
    const sinLon = Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.asin(Math.sqrt(sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon));
    return R * c;
  },
  routeLength(ids) {
    let total = 0;
    for (let i = 0; i < ids.length - 1; i += 1) {
      const a = AppState.castles.find((c) => c.id === ids[i]);
      const b = AppState.castles.find((c) => c.id === ids[i + 1]);
      if (!a || !b) continue;
      total += this.haversineKm(a.coords, b.coords);
    }
    return total;
  },
};

const Exporter = {
  currentRoute() {
    return AppState.planner.order
      .map((id) => AppState.castles.find((c) => c.id === id))
      .filter(Boolean);
  },
  download(type) {
    const data = this.build(type);
    if (!data) return;
    const blob = new Blob([data.content], { type: data.mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = data.filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  },
  build(type) {
    const route = this.currentRoute();
    if (!route.length) return null;
    switch (type) {
      case 'gpx':
        return {
          filename: 'europe-castles.gpx',
          mime: 'application/gpx+xml',
          content: this.toGpx(route),
        };
      case 'kml':
        return {
          filename: 'europe-castles.kml',
          mime: 'application/vnd.google-earth.kml+xml',
          content: this.toKml(route),
        };
      case 'ics':
        return {
          filename: 'europe-castles.ics',
          mime: 'text/calendar',
          content: this.toIcs(route),
        };
      case 'csv':
        return {
          filename: 'europe-castles.csv',
          mime: 'text/csv',
          content: this.toCsv(route),
        };
      default:
        return null;
    }
  },
  toGpx(route) {
    const segs = route
      .map(
        (castle) =>
          `<trkpt lat="${castle.coords.lat}" lon="${castle.coords.lon}"><name>${castle.name}</name></trkpt>`,
      )
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="europe-castles">
  <trk>
    <name>Europe Castles Route</name>
    <trkseg>${segs}</trkseg>
  </trk>
</gpx>`;
  },
  toKml(route) {
    const coords = route.map((castle) => `${castle.coords.lon},${castle.coords.lat}`).join(' ');
    const placemarks = route
      .map(
        (castle) => `<Placemark>
  <name>${castle.name}</name>
  <Point><coordinates>${castle.coords.lon},${castle.coords.lat}</coordinates></Point>
</Placemark>`,
      )
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Europe Castles Route</name>
    ${placemarks}
    <Placemark>
      <LineString><coordinates>${coords}</coordinates></LineString>
    </Placemark>
  </Document>
</kml>`;
  },
  toIcs(route) {
    const events = route
      .map((castle, idx) => {
        const start = new Date(Date.now() + idx * 3600 * 1000).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        return `BEGIN:VEVENT
UID:${castle.id}@europe-castles
DTSTAMP:${start}
DTSTART:${start}
SUMMARY:${castle.name}
LOCATION:${castle.coords.lat},${castle.coords.lon}
DESCRIPTION:${castle.website || ''} ${castle.wikipedia || ''}
END:VEVENT`;
      })
      .join('\n');
    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//europe-castles//EN
${events}
END:VCALENDAR`;
  },
  toCsv(route) {
    const rows = [
      ['id', 'name', 'country', 'lat', 'lon', 'type', 'condition', 'website'].join(','),
      ...route.map((c) =>
        [c.id, c.name, c.country, c.coords.lat, c.coords.lon, c.type || '', c.condition || '', c.website || '']
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(','),
      ),
    ];
    return rows.join('\n');
  },
  shareState() {
    const payload = {
      planner: AppState.planner,
      timestamp: Date.now(),
    };
    const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
    const shareUrl = `${location.origin}${location.pathname}#${compressed}`;
    navigator.clipboard.writeText(shareUrl);
    alert('Share URL copied to clipboard');
  },
  hydrateFromHash() {
    if (!location.hash) return;
    try {
      const raw = LZString.decompressFromEncodedURIComponent(location.hash.slice(1));
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data?.planner) {
        AppState.planner = data.planner;
        UIController.renderPlanner();
        TrailsPlanner.recompute();
        Storage.save();
      }
    } catch (err) {
      console.warn('Failed to load state from URL', err);
    }
  },
};

const OfflineCache = {
  async register() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('sw.js');
      console.log('Service worker registered');
    } catch (err) {
      console.warn('SW registration failed', err);
    }
  },
  async refresh() {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.update();
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
    await DataStore.loadBase();
    UIController.refreshView();
  },
};

async function bootstrap() {
  try {
    await DataStore.init();
    await MapView.init();
    UIController.init();
    UIController.refreshView();
    TrailsPlanner.recompute();
    Exporter.hydrateFromHash();
    OfflineCache.register();
  } catch (err) {
    console.error('Bootstrap failed', err);
    document.getElementById('cardsGrid').textContent = 'Failed to initialize application.';
  }
}

document.addEventListener('DOMContentLoaded', bootstrap);


