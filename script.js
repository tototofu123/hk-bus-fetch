const KMB_API_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=hk&addressdetails=1';
const REQUEST_TIMEOUT_MS = 5000;
const AUTOCOMPLETE_DELAY_MS = 500;

// I keep all DOM refs at the top so I do not keep querying document all the time.
const locationInput = document.getElementById('start-point');
const busInput = document.getElementById('bus-to-take');
const directionSelect = document.getElementById('direction-choice');
const speedInput = document.getElementById('walking-speed');
const enterButton = document.getElementById('enter');
const locationButton = document.getElementById('use-my-location');
const resetButton = document.getElementById('reset-all');
const outputBox = document.getElementById('output-txt');
const locationDatalist = document.getElementById('location-suggestions');
const busDatalist = document.getElementById('bus-suggestions');
const gpsStatus = document.getElementById('gps-status');

let routeCache = [];
let routeVariantCache = new Map();
let stopMap = new Map();
let locationTimer = null;
let busTimer = null;
let currentUserPoint = null;

function showError(message) {
    // Put the error message on the screen so the user can see what went wrong.
    outputBox.classList.remove('hidden');
    outputBox.innerHTML = `<span class="error">${message}</span>`;
}

async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
    // This fetch has a timer, so slow requests stop instead of hanging forever.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } finally {
        clearTimeout(timeoutId);
    }
}

function toMetersPerMinute(speedKmH) {
    return (speedKmH * 1000) / 60;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    // This is the distance formula we use to estimate how far two points are.
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadius = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadius * c;
}

function updateDatalist(datalist, values) {
    datalist.innerHTML = values.map((value) => `<option value="${value}"></option>`).join('');
}

function shortenLocationLabel(displayName) {
    if (!displayName) {
        return '';
    }

    const parts = displayName.split(',').map((part) => part.trim()).filter(Boolean);
    return parts.slice(0, 3).join(', ');
}

function normalizeRoute(route) {
    return route.trim().toUpperCase();
}

function toRouteStopDirection(boundCode) {
    if (boundCode === 'I') {
        return 'inbound';
    }
    if (boundCode === 'O') {
        return 'outbound';
    }
    return null;
}

function getVariantDestination(variant) {
    return variant.dest_en || variant.dest_tc || variant.dest_sc || 'Unknown destination';
}

function getVariantOrigin(variant) {
    return variant.orig_en || variant.orig_tc || variant.orig_sc || 'Unknown origin';
}

function getVariantKey(variant) {
    return `${variant.bound}|${variant.service_type}`;
}

function resetDirectionOptions() {
    // Reset the dropdown back to the default choice.
    directionSelect.innerHTML = '<option value="auto">Auto (both directions)</option>';
    directionSelect.value = 'auto';
}

function populateDirectionOptions(routeVariants) {
    // Build the direction list from the real route data so the user can choose properly.
    const seen = new Set();
    const uniqueVariants = [];
    const options = ['<option value="auto">Auto (both directions)</option>'];

    for (const variant of routeVariants) {
        const key = getVariantKey(variant);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        uniqueVariants.push(variant);
    }

    const hasManyChoices = uniqueVariants.length > 1;

    for (const variant of uniqueVariants) {
        const key = getVariantKey(variant);
        const destination = getVariantDestination(variant);
        const origin = getVariantOrigin(variant);
        const serviceType = variant.service_type || '1';

        const label = hasManyChoices
            ? `Toward ${destination} (from ${origin}, S${serviceType})`
            : `Toward ${destination}`;

        options.push(`<option value="${key}">${label}</option>`);
    }

    directionSelect.innerHTML = options.join('');
    directionSelect.value = 'auto';
}

function getCurrentPositionPromise() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject(new Error('Geolocation is not supported by this browser.'));
            return;
        }

        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: REQUEST_TIMEOUT_MS,
            maximumAge: 60000
        });
    });
}

async function reverseGeocodeLocation(lat, lon) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=16`;
    const payload = await fetchWithTimeout(url);
    return payload?.display_name || '';
}

async function loadRoutes() {
    // Get all bus route names once and reuse them later to avoid extra fetches.
    if (routeCache.length > 0) {
        return routeCache;
    }

    const payload = await fetchWithTimeout(`${KMB_API_BASE}/route/`);
    const allRoutes = (payload.data || [])
        .map((item) => (item.route || '').toUpperCase())
        .filter(Boolean);

    routeCache = [...new Set(allRoutes)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    return routeCache;
}

async function loadRouteVariantsForRoute(route) {
    // Pull the full route data for one bus number, then keep the matching entries only.
    if (routeVariantCache.has(route)) {
        return routeVariantCache.get(route);
    }

    const routePayload = await fetchWithTimeout(`${KMB_API_BASE}/route/`, REQUEST_TIMEOUT_MS);
    const variants = (routePayload.data || []).filter((item) => (item.route || '').toUpperCase() === route);
    routeVariantCache.set(route, variants);
    return variants;
}

async function loadStops() {
    // Load the stop list once so distance checks can use the same data again and again.
    if (stopMap.size > 0) {
        return stopMap;
    }

    const payload = await fetchWithTimeout(`${KMB_API_BASE}/stop/`);
    stopMap = new Map((payload.data || []).map((stop) => [stop.stop, stop]));
    return stopMap;
}

async function geocodeLocation(text, limit = 3) {
    // Turn the typed place name into coordinates using the location search API.
    const url = `${NOMINATIM_BASE}&limit=${limit}&q=${encodeURIComponent(text)}`;
    try {
        const payload = await fetchWithTimeout(url);
        return Array.isArray(payload) ? payload : [];
    } catch (error) {
        if (error.message === 'HTTP 422') {
            return [];
        }
        throw error;
    }
}

function etaTop3(etaData, route, bound, serviceType) {
    // Keep only the next few bus arrivals for the selected stop and direction.
    const now = Date.now();

    return etaData
        .filter((item) =>
            item.route?.toUpperCase() === route &&
            item.dir === bound &&
            Number(item.service_type) === Number(serviceType) &&
            item.eta
        )
        .map((item) => {
            const etaMs = new Date(item.eta).getTime();
            const minutes = Math.max(0, Math.ceil((etaMs - now) / 60000));
            return {
                minutes,
                clock: new Date(etaMs).toLocaleTimeString('en-HK', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                })
            };
        })
        .filter((entry) => Number.isFinite(entry.minutes))
        .sort((a, b) => a.minutes - b.minutes)
        .slice(0, 3);
}

function formatEtaList(entries) {
    if (!entries.length) {
        return 'N/A';
    }
    return entries.map((entry) => `${entry.clock} (in ${entry.minutes} min)`).join(', ');
}

function validateInputs(hasLocation, busRaw, speedRaw) {
    // Basic checks before doing any heavy API work.
    if (!hasLocation || !busRaw || !speedRaw) {
        return 'Error: Please fill in all the blanks!';
    }

    if (!/^[A-Za-z0-9]{1,6}$/.test(busRaw)) {
        return 'Error: Bus route must be letters/numbers only, max 6 chars.';
    }

    const speed = Number(speedRaw);
    if (!Number.isFinite(speed) || speed <= 1 || speed >= 30) {
        return 'Error: Walking speed must be greater than 1 and less than 30 km/h.';
    }

    return null;
}

function getWalkRecommendation(walkMinutes, destination) {
    // If the walk is too long, suggest another transport option.
    if (walkMinutes > 20) {
        return `Tip: Walking is over 20 minutes. You may want to take another transport option toward ${destination}.`;
    }
    return '';
}

async function findTwoClosestStopsForRoute(route, userPoint, routeVariants) {
    // Compare the user location with all stop locations and keep the closest two.
    const stopsById = await loadStops();
    const candidates = [];

    for (const variant of routeVariants) {
        const bound = variant.bound;
        const routeStopDirection = toRouteStopDirection(bound);
        const serviceType = variant.service_type;

        if (!routeStopDirection) {
            continue;
        }

        const routeStopPayload = await fetchWithTimeout(
            `${KMB_API_BASE}/route-stop/${encodeURIComponent(route)}/${routeStopDirection}/${serviceType}`
        );

        for (const entry of routeStopPayload.data || []) {
            const stop = stopsById.get(entry.stop);
            if (!stop) {
                continue;
            }

            const stopLat = Number(stop.lat);
            const stopLong = Number(stop.long);
            if (!Number.isFinite(stopLat) || !Number.isFinite(stopLong)) {
                continue;
            }

            const distanceMeters = haversineMeters(userPoint.lat, userPoint.lon, stopLat, stopLong);
            candidates.push({
                stopId: stop.stop,
                stopName: stop.name_en || stop.name_tc || stop.stop,
                destination: getVariantDestination(variant),
                bound,
                serviceType,
                distanceMeters
            });
        }
    }

    const deduped = new Map();
    for (const row of candidates.sort((a, b) => a.distanceMeters - b.distanceMeters)) {
        if (!deduped.has(row.stopId)) {
            deduped.set(row.stopId, row);
        }
        if (deduped.size >= 2) {
            break;
        }
    }

    return Array.from(deduped.values());
}

async function getStopEtaTop3(route, stopId, bound, serviceType) {
    const etaPayload = await fetchWithTimeout(
        `${KMB_API_BASE}/eta/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}/${serviceType}`
    );

    return etaTop3(etaPayload.data || [], route, bound, serviceType);
}

async function updateLocationSuggestions() {
    // Show a few likely location matches while the user is typing.
    const query = locationInput.value.trim();
    if (query.length < 2) {
        updateDatalist(locationDatalist, []);
        return;
    }

    try {
        const matches = await geocodeLocation(query, 3);
        const labels = matches.map((item) => shortenLocationLabel(item.display_name)).slice(0, 3);
        updateDatalist(locationDatalist, labels);
    } catch (error) {
        updateDatalist(locationDatalist, []);
        console.error(error.message);
    }
}

async function updateBusSuggestions() {
    // Show matching route numbers while the user types the bus code.
    const query = normalizeRoute(busInput.value);
    if (!query) {
        updateDatalist(busDatalist, []);
        return;
    }

    try {
        const routes = await loadRoutes();
        const suggestions = routes
            .filter((route) => route.startsWith(query))
            .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
            .slice(0, 8);

        updateDatalist(busDatalist, suggestions);
    } catch (error) {
        updateDatalist(busDatalist, []);
        console.error(error.message);
    }
}

locationInput.addEventListener('input', () => {
    currentUserPoint = null;
    locationInput.classList.remove('gps-active');
    gpsStatus.classList.add('hidden');
    clearTimeout(locationTimer);
    locationTimer = setTimeout(updateLocationSuggestions, AUTOCOMPLETE_DELAY_MS);
});

locationInput.addEventListener('change', () => {
    updateDatalist(locationDatalist, []);
});

busInput.addEventListener('input', () => {
    clearTimeout(busTimer);
    busTimer = setTimeout(updateBusSuggestions, AUTOCOMPLETE_DELAY_MS);
});

busInput.addEventListener('change', () => {
    updateDatalist(busDatalist, []);
});

busInput.addEventListener('blur', async () => {
    const bus = normalizeRoute(busInput.value);
    if (!bus) {
        resetDirectionOptions();
        return;
    }

    try {
        const allRoutes = await loadRoutes();
        if (!allRoutes.includes(bus)) {
            resetDirectionOptions();
            return;
        }

        const variants = await loadRouteVariantsForRoute(bus);
        populateDirectionOptions(variants);
    } catch (error) {
        resetDirectionOptions();
        console.error(error.message);
    }
});

[locationInput, busInput, speedInput].forEach((inputEl) => {
    inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            enterButton.click();
        }
    });
});

async function setUserLocationFromGPS(showErrors = true) {
    // Ask the browser for the current position and fill the input if it works.
    try {
        const pos = await getCurrentPositionPromise();
        currentUserPoint = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude
        };

        const rawLabel = await reverseGeocodeLocation(currentUserPoint.lat, currentUserPoint.lon);
        locationInput.value = shortenLocationLabel(rawLabel) || 'Current location';
        locationInput.classList.add('gps-active');
        gpsStatus.classList.remove('hidden');
        updateDatalist(locationDatalist, []);
        return true;
    } catch (error) {
        currentUserPoint = null;
        locationInput.classList.remove('gps-active');
        gpsStatus.classList.add('hidden');
        if (showErrors) {
            showError('Location permission denied. Fallback to typed location.');
        }
        return false;
    }
}

locationButton.addEventListener('click', async () => {
    outputBox.classList.remove('hidden');
    outputBox.innerHTML = 'Getting your current location...';
    const ok = await setUserLocationFromGPS(true);
    if (ok) {
        outputBox.innerHTML = 'Using your current location for next search.';
    }
});

window.addEventListener('load', async () => {
    await setUserLocationFromGPS(false);
});

// This reset is plain and boring on purpose: just put everything back to start.
resetButton.addEventListener('click', () => {
    locationInput.value = '';
    busInput.value = '';
    resetDirectionOptions();
    speedInput.value = '5';
    currentUserPoint = null;
    locationInput.classList.remove('gps-active');
    gpsStatus.classList.add('hidden');
    updateDatalist(locationDatalist, []);
    updateDatalist(busDatalist, []);
    outputBox.classList.add('hidden');
});

// Main click handler. This is the part where we gather data and print the result.
enterButton.addEventListener('click', async () => {
    // Read the values first so the rest of the code can work with clean strings.
    const startPoint = locationInput.value.trim();
    const busRaw = busInput.value.trim();
    const speedRaw = speedInput.value.trim();

    const hasLocation = Boolean(currentUserPoint || startPoint);
    const validationError = validateInputs(hasLocation, busRaw, speedRaw);

    if (validationError) {
        showError(validationError);
        return;
    }

    const bus = normalizeRoute(busRaw);
    const speed = Number(speedRaw);

    outputBox.classList.remove('hidden');
    outputBox.innerHTML = 'Calculating... Please wait.';

    try {
        const allRoutes = await loadRoutes();
        if (!allRoutes.includes(bus)) {
            showError('Error: invalid bus route');
            return;
        }

        const routeVariants = await loadRouteVariantsForRoute(bus);
        if (!routeVariants.length) {
            showError('Error: invalid bus route');
            return;
        }

        if (directionSelect.options.length <= 1) {
            populateDirectionOptions(routeVariants);
        }

        const chosenDirection = directionSelect.value;
        const selectedVariants = chosenDirection === 'auto'
            ? routeVariants
            : routeVariants.filter((variant) => getVariantKey(variant) === chosenDirection);

        if (!selectedVariants.length) {
            showError('Error: selected direction is not available for this route.');
            return;
        }

        let userPoint = currentUserPoint;
        if (!userPoint) {
            const geocodeMatches = await geocodeLocation(startPoint, 1);
            if (!geocodeMatches.length) {
                showError('Error: cannot find that location in Hong Kong.');
                return;
            }

            userPoint = {
                lat: Number(geocodeMatches[0].lat),
                lon: Number(geocodeMatches[0].lon)
            };
        }

        const closestStops = await findTwoClosestStopsForRoute(bus, userPoint, selectedVariants);
        if (!closestStops.length) {
            showError('Error: no nearby stops found for this route.');
            return;
        }

        const enrichedStops = await Promise.all(
            closestStops.map(async (stop) => {
                const etaEntries = await getStopEtaTop3(bus, stop.stopId, stop.bound, stop.serviceType);
                return { ...stop, etaEntries };
            })
        );

        const primaryStop = enrichedStops[0];
        const walkMinutes = Math.ceil(primaryStop.distanceMeters / toMetersPerMinute(speed));
        const walkAdvice = getWalkRecommendation(walkMinutes, primaryStop.destination);
        const firstArrival = primaryStop.etaEntries.length
            ? `${primaryStop.etaEntries[0].clock} (in ${primaryStop.etaEntries[0].minutes} min)`
            : 'N/A';

        const secondStop = enrichedStops[1] || {
            stopName: 'N/A',
            destination: 'N/A',
            etaEntries: []
        };

        outputBox.innerHTML = `
            The bus <strong>${bus}</strong> towards <strong>${primaryStop.destination}</strong> is coming to <strong>${primaryStop.stopName}</strong> at <strong>${firstArrival}</strong>.<br><br>
            It will take you <strong>${walkMinutes}</strong> minutes to walk to the bus stop, which is <strong>${Math.round(primaryStop.distanceMeters)}</strong> meters away.<br>
            ${walkAdvice ? `<br><strong>${walkAdvice}</strong><br>` : '<br>'}
            Closest 2 stops:<br>
            1) <strong>${primaryStop.stopName}</strong> - toward <strong>${primaryStop.destination}</strong> - ETA top 3: <strong>${formatEtaList(primaryStop.etaEntries)}</strong><br>
            2) <strong>${secondStop.stopName}</strong> - toward <strong>${secondStop.destination}</strong> - ETA top 3: <strong>${formatEtaList(secondStop.etaEntries)}</strong>
        `;
    } catch (error) {
        if (error.name === 'AbortError') {
            showError('Timeout: error message = timeout');
            return;
        }

        console.error(error);
        showError(`Error: ${error.message}`);
    }
});

