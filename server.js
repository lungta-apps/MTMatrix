/**
 * MTMatrix — vertical slice backend
 * ---------------------------------
 * A small proxy that sits between the browser and Montana's cadastral API.
 * The browser CANNOT call Montana directly (CORS blocks it), so every request
 * goes:  browser  ->  this server  ->  https://svc.mt.gov/msl/cadastralapi
 *
 * This slice proves the real data path for one residential geocode at a time.
 * It intentionally does NOT do the map, batch lookups, or commercial/ag detail
 * yet — those come after the data path is proven.
 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = "https://svc.mt.gov/msl/cadastralapi/api";
const USER_AGENT = "MTMatrix/0.1 (property-additions viewer)";
const FETCH_TIMEOUT_MS = 30000;

// --- tiny in-memory cache (keyed by url) so re-searching a parcel is instant ---
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// One well-behaved fetch to the cadastral API.
// Custom User-Agent + a hard timeout, exactly like the old GeocodeApp did.
// ---------------------------------------------------------------------------
async function cadastralFetch(endpoint, params) {
  const url = new URL(API_BASE + endpoint);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const key = url.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`Montana API returned ${res.status} for ${endpoint}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Accept letters, digits + hyphens, 5–25 chars. Montana geocodes are
// alphanumeric — condo/unit parcels include letters (e.g. ...-0D18).
function cleanGeocode(raw) {
  if (typeof raw !== "string") return null;
  const g = raw.trim();
  if (!/^[0-9A-Za-z-]{5,25}$/.test(g)) return null;
  return g;
}

// Coarse property class from Summary value fields — drives the colored chip.
function classifyProperty(summary) {
  if ((summary.dwellingValue || 0) > 0 || (summary.mobileValue || 0) > 0) return "res";
  if ((summary.commercialValue || 0) > 0) return "comm";
  if ((summary.totalAgValue || 0) > 0 || (summary.totalForestValue || 0) > 0) return "ag";
  return "vac";
}

// "3390 CANYON DR   D18 UNIT" -> collapsed, trimmed
function buildAddress(summary) {
  const line = [summary.situsAddressLine1, summary.situsAddressLine2]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return line || "(no situs address on record)";
}

// Strip a leading code prefix like "33 - " or "CPA2 - " for display.
function stripCode(s) {
  return String(s || "").replace(/^\s*[A-Za-z0-9]+\s*-\s*/, "").trim();
}

// Fetch an endpoint but never throw — return [] and record a warning instead,
// so one missing/500 endpoint can't sink the whole lookup.
async function safeArray(endpoint, params, label, warnings) {
  try {
    const data = await cadastralFetch(endpoint, params);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    warnings.push(`Couldn't load ${label} (${err.status || err.message}).`);
    return [];
  }
}

// ---- feature normalizers: every source becomes the SAME shape ----
// { group, description, area, areaUnit, cost, year }

function dwellingAdditionFeatures(dwellings) {
  const feats = [];
  (dwellings || []).forEach((d) => {
    (Array.isArray(d.additions) ? d.additions : []).forEach((a) => {
      feats.push({
        group: "Dwelling Additions",
        description: stripCode(a.firstDescription || a.first) || "(unlabeled)",
        area: a.area ?? null,
        areaUnit: "sf",
        cost: a.cost ?? null,
        year: a.year || null,
      });
    });
  });
  return feats;
}

function buildingFeatures(items) {
  return (items || []).map((b) => {
    const pct = typeof b.pctGood === "number" ? b.pctGood : null;
    const rcn = typeof b.rcn === "number" ? b.rcn : null;
    // depreciated estimate when we have pctGood; otherwise fall back to RCN
    const cost = rcn == null ? null : pct == null ? rcn : Math.round(rcn * pct);
    let desc = stripCode(b.improvementDescription || b.improvementCode) || "(improvement)";
    if (b.qty && b.qty > 1) desc += ` (×${b.qty})`;
    return {
      group: "Buildings & Improvements",
      description: desc,
      area: b.area || null,
      areaUnit: "sf",
      cost,
      year: b.yearBlt || null,
    };
  });
}

function commercialFeatures(items) {
  return (items || []).map((c) => {
    const d = c.buildingDetail || c;
    const desc =
      [d.buildingName, stripCode(d.structureTypeDescription)].filter(Boolean).join(" — ") ||
      "Commercial building";
    return {
      group: "Commercial Buildings",
      description: desc,
      area: d.totalArea || null,
      areaUnit: "sf",
      cost: d.rcnld ?? null,
      year: d.yearBuilt || null,
    };
  });
}

// Ag/forest land features come straight from the Summary value fields
// (verified present), so no separate endpoint call is needed.
function agForestFeatures(s) {
  const pairs = [
    ["Grazing", s.grazingAcres, s.grazingValue],
    ["Irrigated", s.irrigatedAcres, s.irrigatedValue],
    ["Continuous crop", s.continuousCropAcres, s.continuousCropValue],
    ["Wild hay", s.wildHayAcres, s.wildHayValue],
    ["Fallow", s.fallowAcres, s.fallowValue],
    ["Farm site", s.farmSiteAcres, s.farmSiteValue],
    ["ROW", s.rowAcres, s.rowValue],
    ["Forest", s.totalForestAcres, s.totalForestValue],
  ];
  const feats = [];
  pairs.forEach(([name, acres, value]) => {
    if ((acres || 0) > 0 || (value || 0) > 0) {
      feats.push({
        group: "Ag / Forest Land",
        description: `${name} land`,
        area: acres || null,
        areaUnit: "acres",
        cost: value ?? null,
        year: null,
      });
    }
  });
  return feats;
}

// ---------------------------------------------------------------------------
// THE endpoint:  GET /api/slice?geocode=...&taxYear=...
// Returns a normalized shape so the frontend never sees Montana's raw payload.
// ---------------------------------------------------------------------------
app.get("/api/slice", async (req, res) => {
  const geocode = cleanGeocode(req.query.geocode);
  if (!geocode) {
    return res.status(400).json({
      error: "Invalid geocode. Expected 5–25 characters: letters, digits, and hyphens.",
    });
  }

  const warnings = [];

  try {
    // 1) Resolve tax year (REQUIRED by the detail endpoints — no 'latest' default).
    let taxYear = req.query.taxYear;
    if (!taxYear) {
      const years = await cadastralFetch("/v1/TaxYear", { geocode });
      if (!Array.isArray(years) || years.length === 0) {
        return res.status(404).json({ error: "No tax years found for that geocode. Check the number." });
      }
      taxYear = years[0]; // newest-first
    }

    // 2) Summary — property type, address, and which detail endpoints have data.
    const summary = await cadastralFetch("/v1/Properties/Summary", { geocode, taxYear });
    if (!summary || !summary.geoCode) {
      return res.status(404).json({ error: "No property found for that geocode and tax year." });
    }

    const property = {
      geocode,
      taxYear: Number(taxYear),
      propertyType: summary.propertyType || summary.subCategoryDescription || "Unknown",
      cls: classifyProperty(summary),
      address: buildAddress(summary),
      cityStateZip: (summary.situsCityStateZip || "").trim(),
      category: summary.category || null,
      subCategory: summary.subCategoryDescription || summary.subCategory || null,
    };

    // 3) Decide which detail endpoints to call from the Summary value fields,
    //    then fetch them in parallel. Each call is failure-tolerant.
    const wantDwelling = (summary.dwellingValue || 0) > 0;
    const wantCommercial = (summary.commercialValue || 0) > 0;

    const [dwellings, buildings, commercial] = await Promise.all([
      wantDwelling
        ? safeArray("/Dwelling", { geocode, taxYear }, "dwelling", warnings)
        : Promise.resolve([]),
      // Always check Buildings — detached improvements (paving, sheds, fences)
      // show up on residential, commercial, and even "vacant" parcels.
      safeArray("/v1/Buildings", { geocode, taxYear }, "buildings", warnings),
      wantCommercial
        ? safeArray("/CommercialBuilding", { geocode, taxYear }, "commercial buildings", warnings)
        : Promise.resolve([]),
    ]);

    // 4) Residential dwelling detail (for the header card), when present.
    let dwelling = null;
    if (dwellings.length > 0) {
      const d = dwellings[0];
      const det = Array.isArray(d.details) && d.details[0] ? d.details[0] : d;
      dwelling = {
        yearBuilt: det.yearBuilt ?? null,
        age: det.age ?? null,
        sfla: det.sfla ?? null,
        grade: det.grade ?? null,
        rcnld: det.rcnld ?? null,
        pctGood: det.pctGood ?? null,
      };
    }

    // 5) Everything becomes ONE unified feature list, behind the same contract.
    const features = [
      ...dwellingAdditionFeatures(dwellings),
      ...buildingFeatures(buildings),
      ...commercialFeatures(commercial),
      ...agForestFeatures(summary),
    ];

    if (features.length === 0) {
      warnings.push("No features or improvements on record for this parcel.");
    }

    return res.json({ property, dwelling, features, warnings });
  } catch (err) {
    const status = err.name === "AbortError" ? 504 : err.status || 502;
    const msg =
      status === 504
        ? "Montana's server took too long to respond. Try again."
        : `Couldn't reach Montana's cadastral API (${err.message}).`;
    return res.status(status).json({ error: msg });
  }
});

// ===========================================================================
// MAP: parcel geometry from Montana's public ArcGIS parcels layer.
// cadastralapi has NO geometry; this is the same layer the old GeocodeApp used.
// (gisservicemt.gov now redirects to gisservice.mt.gov.)
// ===========================================================================
// MT State Library moved its GIS services in 2026: the old gisservicemt.gov /
// MSDI_Framework/Parcels path now serves a "Services Have Moved" HTML page.
// Parcels are layer 1 of msdi_cadastral_map_v1 (field is still PARCELID).
// Confirmed against the Nov-2025 working copy of GeocodeApp.
const ARCGIS_QUERY =
  "https://gisservice.mt.gov/arcgis/rest/services/msdi_cadastral_map_v1/MapServer/1/query";

async function arcgisFetch(params) {
  const url = new URL(ARCGIS_QUERY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    if (!res.ok) { const e = new Error(`ArcGIS returned ${res.status}`); e.status = res.status; throw e; }
    const data = await res.json();
    if (data && data.error) { const e = new Error(data.error.message || "ArcGIS query error"); e.status = 502; throw e; }
    cache.set(key, { at: Date.now(), data });
    return data;
  } finally { clearTimeout(timer); }
}

// ArcGIS polygon rings -> GeoJSON FeatureCollection (Leaflet reads this directly).
function arcgisToGeoJSON(features) {
  return {
    type: "FeatureCollection",
    features: (features || [])
      .filter((f) => f.geometry && Array.isArray(f.geometry.rings))
      .map((f) => ({
        type: "Feature",
        properties: { PARCELID: f.attributes && (f.attributes.PARCELID || f.attributes.parcelid) },
        geometry: { type: "Polygon", coordinates: f.geometry.rings },
      })),
  };
}

// One parcel by geocode — tries PARCELID formatting variants (formatting is
// inconsistent in the layer, so we try as-is, hyphen-stripped, and upper-case).
app.get("/api/parcel", async (req, res) => {
  const geocode = cleanGeocode(req.query.geocode);
  if (!geocode) return res.status(400).json({ error: "Invalid geocode." });
  const variants = [...new Set([
    geocode,
    geocode.replace(/-/g, ""),
    geocode.toUpperCase(),
    geocode.replace(/-/g, "").toUpperCase(),
  ])];
  try {
    for (const v of variants) {
      const data = await arcgisFetch({
        where: `PARCELID='${v}'`,
        outFields: "PARCELID",
        returnGeometry: "true",
        outSR: "4326",
        f: "json",
      });
      if (Array.isArray(data.features) && data.features.length > 0) {
        return res.json(arcgisToGeoJSON(data.features));
      }
    }
    return res.json({ type: "FeatureCollection", features: [] });
  } catch (err) {
    return res.status(err.status || 502).json({ error: `Parcel geometry lookup failed (${err.message}).` });
  }
});

// All parcels intersecting a map view. bbox = west,south,east,north (lng/lat).
app.get("/api/parcels", async (req, res) => {
  const bbox = String(req.query.bbox || "").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some((x) => !isFinite(x))) {
    return res.status(400).json({ error: "bbox must be 'west,south,east,north'." });
  }
  const [w, s, e, n] = bbox;
  // Simplify geometry proportional to the view width so payloads stay small and fast
  // regardless of zoom (outlines look identical at map zoom; avoids the 30s timeout on
  // heavy full-geometry responses when ArcGIS is slow).
  const maxOffset = Math.abs(e - w) / 4000;
  try {
    const data = await arcgisFetch({
      geometry: `${w},${s},${e},${n}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "PARCELID",
      returnGeometry: "true",
      outSR: "4326",
      maxAllowableOffset: String(maxOffset),
      geometryPrecision: "6",
      resultRecordCount: "1000",
      f: "json",
    });
    const fc = arcgisToGeoJSON(data.features);
    fc.exceededTransferLimit = !!data.exceededTransferLimit;
    return res.json(fc);
  } catch (err) {
    return res.status(err.status || 502).json({ error: `Parcel map lookup failed (${err.message}).` });
  }
});

// Serve the frontend
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n  MTMatrix slice running:  http://localhost:${PORT}\n`);
});
