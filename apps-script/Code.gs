// Google Apps Script web app: free backend for the map.
// Secrets live in Script Properties (Project Settings > Script Properties), never in code:
//   WAZE_URL, KML_URL                      - the two feed URLs
//   MVD_CLIENT_ID, MVD_CLIENT_SECRET       - Intendencia de Montevideo API credentials (live buses)
//   MVD_TOKEN_URL, BUS_API_URL             - optional overrides of the two Montevideo endpoints
// Usage from the page: <web app url>?src=waze | kml | bus
// Each feed is cached for a few seconds so any number of viewers causes few upstream calls.

const CHUNK_SIZE = 90000;   // CacheService limits a value to 100 KB, so long feeds are split.
const CACHE_SECONDS = { waze: 55, kml: 55, bus: 12 };
const DEFAULT_MVD_TOKEN_URL = "https://mvdapi-auth.montevideo.gub.uy/token";
const DEFAULT_BUS_API_URL = "https://api.montevideo.gub.uy/api/transportepublico/buses";

function doGet(event) {
  const sourceName = event.parameter.src;
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
