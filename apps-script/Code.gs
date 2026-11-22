// Google Apps Script web app: free backend for the map.
// Secrets live in Script Properties (Project Settings > Script Properties), never in code:
//   WAZE_URL, KML_URL                      - the two feed URLs
//   MVD_CLIENT_ID, MVD_CLIENT_SECRET       - Intendencia de Montevideo API credentials (live buses)
//   MVD_TOKEN_URL, BUS_API_URL             - optional overrides of the two Montevideo endpoints
//   ACYCLICA_API_KEY                       - Acyclica API token (travel times); ACYCLICA_BASE optional (default https://go.acyclica.com)
// Usage from the page: <web app url>?src=waze | kml | bus | tt&day=YYYY-MM-DD[&refresh=1]
// Each feed is cached for a few seconds so any number of viewers causes few upstream calls.

const CHUNK_SIZE = 90000;   // CacheService limits a value to 100 KB, so long feeds are split.
const CACHE_SECONDS = { waze: 55, kml: 55, bus: 8 };   // shorter than the 10 s page polling, so every poll sees fresh data
const DEFAULT_MVD_TOKEN_URL = "https://mvdapi-auth.montevideo.gub.uy/token";
const DEFAULT_BUS_API_URL = "https://api.montevideo.gub.uy/api/transportepublico/buses";

function doGet(event) {
  const sourceName = event.parameter.src;
  if (sourceName === "tt") {   // travel-time table: own cache rules, own parameters
    try { return textOutput(handleTravelTimes(event)); } catch (error) { return textOutput("ERROR: " + error.message); }
  }
  if (!CACHE_SECONDS[sourceName]) return textOutput("unknown source");

  let body = readCache(sourceName);
  if (body === null) {
    try {
      body = sourceName === "bus" ? fetchBuses() : fetchPlainFeed(sourceName);
    } catch (error) {
      return textOutput("ERROR: " + error.message);   // plain text so the page can show it
    }
    writeCache(sourceName, body, CACHE_SECONDS[sourceName]);
  }
  return textOutput(body);
}

function textOutput(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

// ---- Waze and My Maps ------------------------------------------------------
function fetchPlainFeed(sourceName) {
  const targetUrl = PropertiesService.getScriptProperties().getProperty(sourceName === "waze" ? "WAZE_URL" : "KML_URL");
  if (!targetUrl) throw new Error("script property not set for " + sourceName);
  const upstream = UrlFetchApp.fetch(targetUrl, { muteHttpExceptions: true, followRedirects: true });
  if (upstream.getResponseCode() !== 200) throw new Error("upstream HTTP " + upstream.getResponseCode());
  return upstream.getContentText();
}

// ---- Montevideo live buses (OAuth2 client credentials) ----------------------
function getMontevideoToken(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) { const cached = cache.get("mvd_token"); if (cached) return cached; }
  const properties = PropertiesService.getScriptProperties();
  const clientId = properties.getProperty("MVD_CLIENT_ID"), clientSecret = properties.getProperty("MVD_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("MVD_CLIENT_ID / MVD_CLIENT_SECRET not set");
  const tokenUrl = properties.getProperty("MVD_TOKEN_URL") || DEFAULT_MVD_TOKEN_URL;

  // First try HTTP Basic credentials; if rejected, try credentials in the form body.
  let response = UrlFetchApp.fetch(tokenUrl, { method: "post", muteHttpExceptions: true,
    headers: { Authorization: "Basic " + Utilities.base64Encode(clientId + ":" + clientSecret) },
    payload: { grant_type: "client_credentials" } });
  if (response.getResponseCode() !== 200) {
    response = UrlFetchApp.fetch(tokenUrl, { method: "post", muteHttpExceptions: true,
      payload: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret } });
  }
  if (response.getResponseCode() !== 200) throw new Error("token HTTP " + response.getResponseCode() + " " + response.getContentText().slice(0, 120));
  const token = JSON.parse(response.getContentText());
  if (!token.access_token) throw new Error("token response without access_token");
  const lifetime = Math.max(60, Math.min(21000, (Number(token.expires_in) || 3600) - 120));
  cache.put("mvd_token", token.access_token, lifetime);
  return token.access_token;
}

function fetchBuses() {
  const busUrl = PropertiesService.getScriptProperties().getProperty("BUS_API_URL") || DEFAULT_BUS_API_URL;
  const request = (token) => UrlFetchApp.fetch(busUrl, { muteHttpExceptions: true, headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  let response = request(getMontevideoToken(false));
  if (response.getResponseCode() === 401) response = request(getMontevideoToken(true));   // token expired early
  if (response.getResponseCode() !== 200) throw new Error("buses HTTP " + response.getResponseCode() + " " + response.getContentText().slice(0, 120));
  return response.getContentText();
}

// ---- Cache helpers (chunked) -------------------------------------------------
function readCache(key) {
  const cache = CacheService.getScriptCache();
  const chunkCount = Number(cache.get(key + ":n"));
  if (!chunkCount) return null;
  const keys = [];
  for (let index = 0; index < chunkCount; index++) keys.push(key + ":" + index);
  const chunks = cache.getAll(keys);
  let body = "";
  for (const chunkKey of keys) {
    if (chunks[chunkKey] === undefined) return null;   // a chunk expired: refetch
    body += chunks[chunkKey];
  }
  return body;
}

function writeCache(key, body, seconds) {
  const entries = {};
  let chunkCount = 0;
  for (let start = 0; start < body.length; start += CHUNK_SIZE) {
    entries[key + ":" + chunkCount++] = body.substring(start, start + CHUNK_SIZE);
  }
  entries[key + ":n"] = String(chunkCount);
  try { CacheService.getScriptCache().putAll(entries, seconds); } catch (error) { /* too big: skip caching */ }
}

// ---- Acyclica travel times: one value per route per 15 minutes, for one local day -------------------
// The route names in Acyclica start with "VMS <code> ..."; the 14 codes below become the table columns.
const TT_ROUTE_CODES = ["2.1a", "2.1b", "2.2a", "2.2b", "4.1a", "4.1b", "4.2a", "4.2b", "5.1", "5.2a", "5.2b", "6.1", "6.2", "6.3"];
const TT_OFFSET_MINUTES = -180;              // Montevideo: UTC-3, no daylight saving
const TT_SLOT_MS = 15 * 60000;
const TT_HOLD_MS = 60 * 60000;               // a reading is carried forward at most one hour
const DEFAULT_ACYCLICA_BASE = "https://go.acyclica.com";

function localToday() { return new Date(Date.now() + TT_OFFSET_MINUTES * 60000).toISOString().slice(0, 10); }

function handleTravelTimes(event) {
  const day = event.parameter.day || localToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("bad day, use YYYY-MM-DD");
  const cacheKey = "tt:" + day;
  const cached = readCache(cacheKey);
  if (cached) {
    const age = Date.now() - JSON.parse(cached).generatedAt;
    if (event.parameter.refresh !== "1" || age < 60000) return cached;   // refresh is honoured at most once a minute
  }
  const text = JSON.stringify(buildTravelTimes(day));
  writeCache(cacheKey, text, day === localToday() ? 240 : 1800);
  return text;
}

function acyclicaSettings() {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty("ACYCLICA_API_KEY");
  if (!token) throw new Error("ACYCLICA_API_KEY not set in Script Properties");
  return { base: properties.getProperty("ACYCLICA_BASE") || DEFAULT_ACYCLICA_BASE, headers: { Authorization: "Token " + token } };
}

// code -> { id, name }, found by name in the route inventory (cached 6 hours)
function getAcyclicaRoutes(settings) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("acy_routes");
  if (cached) return JSON.parse(cached);
  const response = UrlFetchApp.fetch(settings.base + "/datastream/route/inventory/json", { headers: settings.headers, muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error("route inventory HTTP " + response.getResponseCode());
  const normalize = (text) => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const inventory = JSON.parse(response.getContentText());
  const found = {};
  TT_ROUTE_CODES.forEach((code) => {
    const pattern = new RegExp("(^|\\s)vms\\s*" + code.replace(".", "\\.") + "(\\s|$)");
    const match = inventory.find((route) => pattern.test(normalize(route.name)));
    if (match) found[code] = { id: match.id, name: match.name };
  });
  cache.put("acy_routes", JSON.stringify(found), 21600);
  return found;
}

function buildTravelTimes(day) {
  const settings = acyclicaSettings();
  const routes = getAcyclicaRoutes(settings);
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const dayStartMs = Date.UTC(year, month - 1, dayOfMonth) - TT_OFFSET_MINUTES * 60000;
  const startSeconds = dayStartMs / 1000, endSeconds = startSeconds + 86399;   // the API allows at most one day per call
  const slotCount = 96;
  const available = TT_ROUTE_CODES.filter((code) => routes[code]);
  const responses = UrlFetchApp.fetchAll(available.map((code) => ({
    url: `${settings.base}/datastream/route/csv/time/${routes[code].id}/${startSeconds}/${endSeconds}`, headers: settings.headers, muteHttpExceptions: true })));
  const byCode = {};
  available.forEach((code, index) => {
    const response = responses[index];
    byCode[code] = response.getResponseCode() === 200
      ? { values: slotAverages(parseStrengthCsv(response.getContentText()), dayStartMs, slotCount) }
      : { error: "HTTP " + response.getResponseCode() };
  });
  const columns = TT_ROUTE_CODES.map((code) => {
    const route = routes[code];
    if (!route) return { code, name: "", values: new Array(slotCount).fill(null), error: "route not found in Acyclica" };
    return { code, id: route.id, name: route.name, ...byCode[code], values: byCode[code].values || new Array(slotCount).fill(null) };
  });
  return { day, generatedAt: Date.now(), slotMinutes: 15, offsetMinutes: TT_OFFSET_MINUTES, columns };
}

// CSV "Timestamp,Strengths,..." (elapsed times in ms) -> [[timestampMs, strengthMs], ...] sorted by time
function parseStrengthCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(",");
  const timeIndex = header.indexOf("Timestamp"), strengthIndex = header.indexOf("Strengths");
  const points = [];
  lines.forEach((line) => {
    const cells = line.split(",");
    const time = Number(cells[timeIndex]), value = Number(cells[strengthIndex]);
    if (isFinite(time) && isFinite(value) && value > 0) points.push([time, value]);
  });
  return points.sort((a, b) => a[0] - b[0]);
}

// Time-weighted mean per 15-minute slot: each reading holds until the next one (matches the Acyclica screen,
// e.g. 17:45 -> 17:40 for VMS 2.1a on 2026-11-20). Slots without any usable reading stay null.
function slotAverages(points, dayStartMs, slotCount) {
  const result = new Array(slotCount).fill(null);
  let index = 0, currentValue = null, lastTime = null;
  for (let slot = 0; slot < slotCount; slot++) {
    const slotStart = dayStartMs + slot * TT_SLOT_MS, slotEnd = slotStart + TT_SLOT_MS;
    let cursor = slotStart, weighted = 0, covered = 0;
    const cover = (until) => {
      if (currentValue === null) return;
      const stop = Math.min(until, lastTime + TT_HOLD_MS);
      if (stop > cursor) { weighted += currentValue * (stop - cursor); covered += stop - cursor; }
    };
    while (index < points.length && points[index][0] < slotEnd) {
      const time = points[index][0];
      if (time > cursor) { cover(time); cursor = time; }
      currentValue = points[index][1]; lastTime = time; index++;
    }
    cover(slotEnd);
    result[slot] = covered > 0 ? weighted / covered : null;
  }
  return result;
}
