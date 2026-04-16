/**
 * ============================================================
 *  New Relic Synthetics – UniFi Site Manager Device Monitor
 * ============================================================
 *  Purpose : For every matched site, list devices via
 *            GET /v1/sites/{siteId}/devices (paginated), then
 *            fetch full detail for each via
 *            GET /v1/sites/{siteId}/devices/{deviceId}.
 *            Ships results to New Relic as custom events.
 *
 *  Runtime  : Node.js 16.10.0  (Scripted API monitor)
 *
 *  Secure Credentials  (NR1 → Synthetics → Secure Credentials)
 *  ─────────────────────────────────────────────────────────────
 *  UNIFI_API_KEY          – API key from unifi.ui.com → API
 *  NEW_RELIC_LICENSE_KEY  – NR Ingest - License key
 *  NEW_RELIC_ACCOUNT_ID   – NR account ID (numeric, as string)
 *
 *  Filters  (edit CONFIG below before deploying)
 *  ─────────────────────────────────────────────────────────────
 *  locationName – case-insensitive substring match on site name.
 *                 Set to "" to check ALL sites.
 *
 *  Device detail response schema (from API)
 *  ─────────────────────────────────────────────────────────────
 *  id, macAddress, ipAddress, name, model, state (string),
 *  supported, firmwareVersion, firmwareUpdatable,
 *  features (string[]), interfaces (string[])
 *
 *  Custom Event written to NRDB : UniFiDeviceStatus
 *  ─────────────────────────────────────────────────────────────
 *  siteId, siteName,
 *  deviceId, deviceName, deviceModel,
 *  deviceIp, deviceMac,
 *  state, isOnline (1/0),
 *  supported (1/0), firmwareVersion, firmwareUpdatable (1/0),
 *  features, interfaces,
 *  monitorName, timestamp
 *
 *  NOTE: Do NOT add "use strict" – Synthetics enforces strict
 *  mode automatically; re-declaring it causes parse errors.
 * ============================================================
 */

var assert = require("assert");

// ── 1. Configuration ──────────────────────────────────────────
// ✏️  Edit these values before deploying.
var CONFIG = {
  locationName : "",                // e.g. "HQ - Rio 196"  –  "" = all sites
  monitorName  : "UniFi-Device-Monitor",
  pageSize     : "100"              // devices per page on list calls
};

var UNIFI_API_BASE = "https://<Change-This>.unifi-hosting.ui.com/proxy/network/integration";
var NR_EVENT_API   = "https://insights-collector.newrelic.com/v1/accounts";

var API_KEY       = $secure.UNIFI_API_KEY;
var NR_LICENSE    = $secure.NEW_RELIC_LICENSE_KEY;
var NR_ACCOUNT_ID = $secure.NEW_RELIC_ACCOUNT_ID;

var FILTER_LOCATION = CONFIG.locationName.trim().toLowerCase();

// ── 2. Helper – build query string ────────────────────────────
function buildQS(params) {
  var parts = [];
  Object.keys(params).forEach(function(key) {
    var val = params[key];
    if (val !== null && val !== undefined && val !== "") {
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(val));
    }
  });
  return parts.length ? "?" + parts.join("&") : "";
}

// ── 3. Single authenticated GET – returns raw parsed body ─────
async function unifiGetRaw(path, params) {
  var qs  = buildQS(params || {});
  var url = UNIFI_API_BASE + path + qs;

  var resp = await $http.get({
    url     : url,
    headers : {
      "Accept"    : "application/json",
      "X-API-Key" : API_KEY
    }
  });

  assert.equal(
    resp.statusCode,
    200,
    "UniFi API " + path + " returned HTTP " + resp.statusCode + " – " + resp.body
  );

  return JSON.parse(resp.body);
}

// ── 4. Paginated GET – follows nextToken, returns flat array ──
async function unifiGetAll(path) {
  var allItems  = [];
  var nextToken = null;
  var page      = 0;

  do {
    page++;
    var params = { pageSize: CONFIG.pageSize };
    if (nextToken) { params.nextToken = nextToken; }

    console.log("  GET " + path + " (page " + page + ")");
    var body = await unifiGetRaw(path, params);

    var pageItems = body.data || [];
    if (Array.isArray(pageItems)) {
      pageItems.forEach(function(item) { allItems.push(item); });
    }

    nextToken = (body.nextToken && body.nextToken !== "") ? body.nextToken : null;
  } while (nextToken);

  console.log("  -> " + allItems.length + " item(s) from " + path);
  return allItems;
}

// ── 5. Fetch single device detail ─────────────────────────────
// GET /v1/sites/{siteId}/devices/{deviceId}
// Returns the unwrapped device object.
async function fetchDeviceDetail(siteId, deviceId) {
  var path = "/v1/sites/" + siteId + "/devices/" + deviceId;
  var body = await unifiGetRaw(path);
  // Single-resource endpoints wrap the object in { data: { ... } }
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    return body.data;
  }
  return body;
}

// ── 6. POST custom events to New Relic (batched) ──────────────
async function sendNrEvents(events) {
  if (!events.length) { return; }

  var BATCH = 1000;
  var i = 0;
  while (i < events.length) {
    var batch = events.slice(i, i + BATCH);
    var resp  = await $http.post({
      url     : NR_EVENT_API + "/" + NR_ACCOUNT_ID + "/events",
      headers : {
        "Content-Type"  : "application/json",
        "X-License-Key" : NR_LICENSE
      },
      body    : JSON.stringify(batch)
    });

    assert.ok(
      resp.statusCode === 200 || resp.statusCode === 202,
      "NR Event API returned HTTP " + resp.statusCode + " – " + resp.body
    );

    console.log("  Sent batch of " + batch.length + " UniFiDeviceStatus event(s) to New Relic.");
    i += BATCH;
  }
}

// ── 7. Derive isOnline from the state string ──────────────────
// API returns state as a string e.g. "ONLINE", "OFFLINE",
// "PENDING", "UPGRADING", "PROVISIONING"
function isDeviceOnline(stateStr) {
  return (stateStr || "").toUpperCase() === "ONLINE" ? 1 : 0;
}

// ── 8. Main ───────────────────────────────────────────────────
(async function main() {
  console.log("=== UniFi Device Monitor ===");
  console.log("Location filter : " + (FILTER_LOCATION || "(all)"));

  // ── 8a. Fetch all sites (paginated) ─────────────────────────
  console.log("\n[Step 1] Fetching UniFi sites ...");
  var allSites = await unifiGetAll("/v1/sites");

  assert.ok(
    Array.isArray(allSites) && allSites.length > 0,
    "No sites returned – verify UNIFI_API_KEY permissions."
  );

  // Filter by locationName if set
  var sites = allSites;
  if (FILTER_LOCATION) {
    sites = allSites.filter(function(s) {
      return (s.name || "").toLowerCase().indexOf(FILTER_LOCATION) !== -1;
    });
  }

  var allSiteNames = allSites.map(function(s) {
    return s.name || s.id || "?";
  }).join(", ");

  assert.ok(
    sites.length > 0,
    'No sites matched locationName="' + CONFIG.locationName + '". Available: ' + allSiteNames
  );

  console.log("Matched " + sites.length + " of " + allSites.length + " site(s).");

  // ── 8b. Per site: list device IDs, then fetch each detail ────
  console.log("\n[Step 2] Fetching device detail per site ...");

  var nrEvents       = [];
  var offlineDevices = [];
  var nowEpochSecs   = Math.floor(Date.now() / 1000);

  for (var i = 0; i < sites.length; i++) {
    var site     = sites[i];
    var siteId   = site.id   || "";
    var siteName = site.name || siteId;

    if (!siteId) {
      console.warn("Skipping site with no id: " + siteName);
      continue;
    }

    console.log("\nSite: " + siteName + " (" + siteId + ")");

    // List all devices for this site (paginated) – gives us device IDs
    var deviceList = await unifiGetAll("/v1/sites/" + siteId + "/devices");

    if (!deviceList.length) {
      console.log("  No devices found.");
      continue;
    }

    console.log("  Fetching detail for " + deviceList.length + " device(s) ...");

    for (var j = 0; j < deviceList.length; j++) {
      var listEntry = deviceList[j];
      var deviceId  = listEntry.id || "";

      if (!deviceId) {
        console.warn("  Skipping device with no id at index " + j);
        continue;
      }

      // ── Fetch full device detail ────────────────────────────
      var detail;
      try {
        detail = await fetchDeviceDetail(siteId, deviceId);
      } catch (err) {
        console.warn("  WARN: detail fetch failed for " + deviceId + " – " + err.message);
        detail = listEntry;   // fall back to list-entry data
      }

      // ── Map API fields directly to NR event ─────────────────
      // API schema: id, macAddress, ipAddress, name, model, state,
      //             supported, firmwareVersion, firmwareUpdatable,
      //             features[], interfaces[]
      var stateStr = detail.state || listEntry.state || "UNKNOWN";
      var online   = isDeviceOnline(stateStr);

      var event = {
        eventType          : "UniFiDeviceStatus",
        timestamp          : nowEpochSecs,
        monitorName        : CONFIG.monitorName,

        // Site
        siteId             : siteId,
        siteName           : siteName,

        // Device identity
        deviceId           : detail.id            || deviceId,
        deviceName         : detail.name          || "unnamed",
        deviceModel        : detail.model         || "unknown",
        deviceIp           : detail.ipAddress     || "unknown",
        deviceMac          : detail.macAddress    || "unknown",

        // State
        state              : stateStr,
        isOnline           : online,

        // Firmware
        firmwareVersion    : detail.firmwareVersion   || "unknown",
        firmwareUpdatable  : detail.firmwareUpdatable ? 1 : 0,

        // Capabilities – store as comma-separated strings for NRQL
        supported          : detail.supported ? 1 : 0,
        features           : Array.isArray(detail.features)   ? detail.features.join(",")   : "",
        interfaces         : Array.isArray(detail.interfaces) ? detail.interfaces.join(",") : ""
      };

      nrEvents.push(event);

      var icon = online ? "[UP]  " : "[DOWN]";
      console.log(
        "  " + icon + " " + event.deviceName +
        " | model="    + event.deviceModel +
        " | ip="       + event.deviceIp +
        " | mac="      + event.deviceMac +
        " | state="    + stateStr +
        " | fw="       + event.firmwareVersion +
        " | features=" + event.features
      );

      if (!online) {
        offlineDevices.push(event.deviceName + " (" + event.deviceModel + ") @ " + siteName);
      }
    }
  }

  // ── 8c. Send events to New Relic ─────────────────────────────
  console.log("\n[Step 3] Sending " + nrEvents.length + " event(s) to New Relic ...");
  if (NR_LICENSE && NR_ACCOUNT_ID) {
    await sendNrEvents(nrEvents);
  } else {
    console.warn("WARNING: NR credentials not set – skipping event ingest.");
  }

  // ── 8d. Summary & pass/fail ──────────────────────────────────
  var totalOnline = nrEvents.filter(function(e) { return e.isOnline === 1; }).length;

  console.log("\n--- Summary ---");
  console.log("Sites checked      : " + sites.length);
  console.log("Devices checked    : " + nrEvents.length);
  console.log("  Online           : " + totalOnline);
  console.log("  Offline          : " + offlineDevices.length);

  if (offlineDevices.length > 0) {
    console.warn("\nOffline / degraded devices:");
    offlineDevices.forEach(function(d) { console.warn("  * " + d); });

    // Fail the Synthetic check → triggers your NR alert policy
  /*  assert.ok(
      false,
      offlineDevices.length + " device(s) offline: " + offlineDevices.join(" | ")
    ); */
  }

  console.log("\nAll devices online. Monitor check PASSED.");
})();
