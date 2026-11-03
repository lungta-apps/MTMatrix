# MTMatrix

Compare property features side by side using real appraisal data from the Montana Cadastral API.

Pick parcels on a map (or search by geocode or address) and MTMatrix pulls each one's dwelling additions, buildings and improvements, commercial buildings, ag/forest land, depreciation ratings, and appraised values into one **Feature Matrix**: one row per property, one column per feature type. It flags properties that don't match the rest, so inconsistencies across a condo or townhome series stand out.

Built for Montana DOR appraisers, not the general public.

| | |
|---|---|
| **Live app** | https://mt-matrix.vercel.app |
| **GitHub** | https://github.com/lungta-apps/MTMatrix (branch `main`) |
| **Hosting** | Vercel, auto-deploys every push to `main` (see [Deployment](#deployment)) |
| **Stack** | Node.js + Express proxy, one static HTML page (vanilla JS, Leaflet, MapLibre, SheetJS) |
| **Data** | Montana `cadastralapi` (appraisal detail) + Montana ArcGIS parcels layer (shapes, address search) |
| **Last updated** | 2026-11-01 |

---

## Features

**Finding properties**
- **Search by geocode or address.** One box does both. Geocodes work with or without hyphens. An address with one match loads right away; several matches open a picker.
- **Parcel map.** Search flies the map to the parcel. At zoom 16+ parcel outlines load and can be clicked.
- **Map selection tools.** Click a parcel to add it, right-click a listed parcel to remove it, or select an area with **Box** or **Polygon** (up to 25 parcels per area selection).
- **Basemap picker.** OpenFreeMap Dark (vector, default, sharp to zoom 20), Esri Dark Gray, or Esri World Imagery. Your choice is remembered; `?basemap=ofm|esri|imagery` in the URL overrides it.

**The Feature Matrix (table)**
- Rows are properties. Columns are Address, Geocode, Type, the three depreciation ratings (**Condition**, **Desirability**, **Location**), the total appraised value for each published tax year (e.g. **2024 Value**, **2025 Value**, **2026 Value**; years follow the appraisal history automatically), then one column per feature type (for example "Deck, Wood"), with a colored dot showing its group.
- Each cell lists the actual items: area in sq ft (or acres), or `W × L × H ft` when only dimensions exist, or ✓ when the feature is present with no size. Multiple items show as `×N`.
- **Change detection.** With 3 or more properties, a red **"N differ"** pill appears on any column where some properties don't match the rest. Click a pill to highlight those cells, or **Check all** for every column. Appraised-value columns are left out (values naturally differ). Rule of thumb: if 50%+ of properties have a feature, flag the ones missing it or with a different size than the most common one; if under 50% have it, flag the ones that do.
- **Table ↔ map link.** The locate pin on a row (or clicking a property in the side panel or on the map) flies the map to that parcel and highlights it in amber on the map and in every open table.
- **Bookmarks.** Click a row to mark it in cyan as a place-keeper.
- **Hide columns.** Header **×** or the **Columns** picker (show/hide by group). Remembered between visits.
- **Floating or pop-out window.** The table opens as a draggable, resizable panel, or **Pop out** into its own browser window for a second monitor. The pop-out stays in sync with the map page and has a **Dock** button.
- **Export.** Copy (paste into Excel), CSV, or Excel `.xlsx`. Exports follow the visible columns; geocodes stay text.

**Side panel**
- Properties list with per-property measurements, a line of total appraised values by year, and an estimated-value total (a rough sum of feature costs, not an appraisal).

---

## Data freshness (read this before trusting a number)

The public Cadastral API shows the **currently published tax year** and refreshes **nightly**.

- **January to about June/July:** matches what DOR is working on.
- **About July to December:** DOR is working the *next* year, which stays invisible here until the January roll. Only corrections and appeals to the published year show up.

In fall 2026, DOR is on 2027 and MTMatrix shows 2026. Parcel shapes follow the slower monthly MSDI cadastral update.

---

## How it works

The browser can't call Montana directly (the API sends no CORS headers), so every request goes through the Express server:

```
browser (public/index.html)
   │
   ▼
MTMatrix server (server.js, Express)
   ├──► https://svc.mt.gov/msl/cadastralapi/api          appraisal detail
   └──► https://gisservice.mt.gov/arcgis/rest/services/
            msdi_cadastral_map_v1/MapServer/1             parcel shapes + address search
```

The server reshapes Montana's responses into one stable format, so if Montana's (unofficial, undocumented) API changes, only `server.js` needs fixing.

### Project layout

```
MTMatrixRepo/
├─ server.js           Express proxy: 4 API routes + serves public/
├─ public/
│  └─ index.html       The whole frontend: map, side panel, Feature Matrix, pop-out (HTML + CSS + JS in one file)
├─ package.json        One dependency: express
├─ package-lock.json
├─ .gitignore
└─ README.md
```

There is no build step. Client libraries load from CDNs, pinned:
Leaflet 1.9.4 and SheetJS 0.18.5 (cdnjs); MapLibre GL 5.24.0 and @maplibre/maplibre-gl-leaflet 0.1.4 (jsDelivr).

### Server API

| Route | What it does | Source |
|---|---|---|
| `GET /api/slice?geocode=&taxYear=` | One property: summary, dwelling details + depreciation ratings, appraisal history (total value per year), and the unified feature list. `taxYear` is optional (defaults to the parcel's newest year). | cadastralapi |
| `GET /api/parcel?geocode=` | One parcel's shape as GeoJSON | ArcGIS |
| `GET /api/parcels?bbox=w,s,e,n` | All parcel shapes in the map view (simplified) | ArcGIS |
| `GET /api/address?q=` | Address → matching parcels (up to 25) | ArcGIS |

`/api/slice` returns:

```jsonc
{
  "property": { "geocode", "taxYear", "propertyType", "cls", "address", "cityStateZip", "category", "subCategory" },
  "dwelling": { "yearBuilt", "age", "sfla", "grade", "rcnld", "pctGood",
                "condition", "propertyDesirability", "locationDesirability" },   // null if no dwelling
  "appraisals": [ { "year", "total" } ],   // from /v1/Appraisal/History, oldest first; land/building omitted
  "features": [ { "group", "description", "area", "areaUnit", "dims", "cost", "year" } ],
  "warnings": [ "…" ]
}
```

`group` is `Dwelling Additions`, `Buildings & Improvements`, `Commercial Buildings`, or `Ag / Forest Land`. `dims` (like `"25 × 10 ft"`) is only set when there's no area.

Server behavior: 5-minute in-memory cache, custom User-Agent, 30-second timeout on every call to Montana. `taxYear` is always sent to the detail endpoints because Montana returns HTTP 400 without it.

---

## Run it locally

Needs Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Server changes need a restart (Ctrl+C, `npm start`); `index.html` changes only need a hard refresh.

### Quick check

Search **`03-0926-11-4-09-28-0D18`**. You should see 3390 Canyon Dr D18 Unit, Billings, a Condominium, with **Deck, Wood** (220 sf, $6,288) and **Porch, Frame, Open** (15 sf, $890), and Condition/Desirability/Location all **Good (8)** for tax year 2026.

Other useful test parcels:
- `03-1032-34-1-08-10-0000`: improved/commercial parcel (paving + Apple Creek Apartments commercial buildings)
- `01-1095-16-3-11-06-0000`: vacant land that still has one improvement

---

## Deployment

- **Where:** Vercel, project URL https://mt-matrix.vercel.app.
- **How:** the GitHub repo was imported through the Vercel dashboard. Every push to `main` redeploys automatically.
- **Config lives on Vercel, not in this repo.** There is no `vercel.json`, `.vercel/` folder, or `api/` serverless folder. Vercel runs `server.js` as a plain Express app with its zero-config Express support. Build, runtime, and domain settings are in the Vercel dashboard for the project.
- **Environment variables:** none. Montana's APIs are public and keyless, and the basemaps used are keyless.
- **To deploy:** commit and push to `main`. Check the Vercel dashboard if a deploy fails.

---

## Things to know

- **Not an official API.** `cadastralapi` backs the state's own web page and can change without notice. The code tolerates missing fields and empty lists; keep it that way.
- **Be a good citizen.** Results are cached for 5 minutes and area selections are capped at 25 parcels.
- **Geocode formats are mixed.** Parcels added from the map or address search use the ArcGIS hyphen-less form (`03103332101220000`); typed geocodes keep hyphens.
- **Address search is ArcGIS only.** `cadastralapi` has no address search.
- **Map building footprints** on the OpenFreeMap basemap come from OpenStreetMap and can be missing in places; switch basemaps if so.
- **Multi-part condo parcels** are matched by the center of their drawn shape, which is occasionally off.
- **Dark Reader** and similar browser extensions can hide the faint table grid lines; turn them off for this site.

## Ideas / backlog

- Normalize geocode display to the hyphenated `2-4-2-1-2-2-4` form.
- Pin the Geocode column beside Address when scrolling sideways.
- More one-value-per-property columns from data already fetched: utility rating, year built, SFLA, beds/baths, style, grade, basement, garage, heating/cooling, RCNLD, % good; plus `/v1/Appraisal`, `/MarketLand`, `/v1/Properties/Owner`.
- "Load more" past the 25-parcel area cap.
- Commit the Vercel run config to the repo so deployment is documented in code.

## History

| Date | Commit | Change |
|---|---|---|
| 2026-09 | `7350b38` | Data engine: all property types |
| | `0b4e926` | Table view, grid lines, CSV export |
| | `704befb` | Area → dimensions → ✓ fallback |
| | `90b35f1` | Search by address |
| | `2d22d1f` | Per-item cells; exports list each item |
| | `98b9cf5` | Row bookmark |
| | `27b2b86` | Credits line, floating table window |
| 2026-10-20 | `cd94100`, `51f3ca7` | Pop-out window; hide/show columns |
| 2026-10-25 | `c8e3dd4` | Depreciation columns (condition, desirability, location) |
| | `39f3d31`, `7622b84` | OpenFreeMap dark basemap; basemap picker |
| 2026-10-27 | `25139ed` | Table ↔ map link: locate pin, amber highlight |
| | `6823b90` | Change detection: red "differ" pills |
