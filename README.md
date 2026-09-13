# MTMatrix

View Montana Cadastral property **additions** (decks, porches, garages, and other features) using real appraisal data from the state's cadastral API.

Type a geocode and the app fetches that property's real features from Montana and shows them in the table — grouped by dwelling additions, buildings & improvements, commercial buildings, and ag/forest land. It works for **any property type**. The map, multiple-select, and hosting come later; the data path is proven and complete.

## How it works

The browser can't call Montana directly — the state's server blocks cross-site browser requests (CORS). So requests go through a small local proxy:

```
browser  →  MTMatrix server (server.js)  →  https://svc.mt.gov/msl/cadastralapi
```

The server fetches from Montana, reshapes the response into a clean, stable format, and hands that to the page. When Montana's (undocumented) API shifts, only `server.js` changes — the frontend keeps working.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## Try it (the golden test)

In the app, enter geocode **`03-0926-11-4-09-28-0D18`** with tax year **2026** and click **Look up**. You should see:

- Address: **3390 CANYON DR D18 UNIT, BILLINGS, MT 59102**
- Type: **Condominium**
- Additions: **Deck, Wood** — 220 sf, $6,288 · **Porch, Frame, Open** — 15 sf, $890

Those are real, verified values. If they show up, the data path works.

Try other property types too:

- `03-1032-34-1-08-10-0000` — an improved/commercial parcel (concrete paving improvements + the "Apple Creek Apartments" commercial buildings)
- `01-1095-16-3-11-06-0000` — a vacant parcel that still has one improvement (a pole-frame building)

You can look up several geocodes in a row — each one stacks in the table, with running totals at the bottom. A parcel with nothing on record shows a clean "no features on record" instead of an error.

## Project layout

```
MTMatrixRepo/
├─ server.js          the proxy + /api/slice endpoint
├─ public/
│  └─ index.html      the frontend (glossy dark UI, search-driven)
├─ package.json
└─ .gitignore
```

## The API endpoint

```
GET /api/slice?geocode=<geocode>&taxYear=<year>
```

Returns:

```jsonc
{
  "property": { "geocode", "taxYear", "propertyType", "cls", "address", "cityStateZip", "category", "subCategory" },
  "dwelling": { "yearBuilt", "age", "sfla", "grade", "rcnld", "pctGood" },  // null for non-residential
  "features": [ { "group", "description", "area", "areaUnit", "cost", "year" } ],
  "warnings": [ "…" ]
}
```

`group` is one of `Dwelling Additions`, `Buildings & Improvements`, `Commercial Buildings`, or `Ag / Forest Land`. `cost` is the best available dollar figure per source (addition cost; commercial depreciated value; buildings estimated as RCN × %good; ag/forest land value) — treat the running total as a rough estimate, not an appraisal.

`taxYear` is optional in the request — if you omit it, the server asks Montana for the parcel's newest tax year and uses that.

## What's next

- **The map** — a real interactive parcel map with click / box-select (the mockup's map is a schematic stand-in). Needs parcel geometry from the ArcGIS layer.
- **Multiple parcels at once** — the actual "matrix": pull and compare features across many properties in one view (batch lookups, e.g. by neighborhood or area).
- **Deploy** — mirror the old GeocodeApp and put the proxy on Vercel as a serverless function for production.

Done: real end-to-end data path (all property types — dwelling additions, buildings/improvements, commercial, ag/forest).

## Notes

- Be a good citizen with Montana's server: the proxy caches results for 5 minutes and sets a custom User-Agent. If you later add batch lookups, cap concurrency (~10) and keep caching.
- This is not an official public API contract — it backs an internal state web app and could change without notice. The code tolerates missing fields and empty arrays; keep it that way.
