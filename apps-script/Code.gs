/**
 * On-call rota — Google Sheets backend.
 *
 * Paste this into the sheet's Apps Script editor (Extensions → Apps Script), run `setup` once,
 * then deploy it as a web app (Execute as: Me, Who has access: Anyone). See README.md.
 *
 * Storage: a hidden "_data" tab holds one row per record (path, JSON, updated time):
 *   settings/team                  team names, shift names/times, planner options, fortnight start
 *   availability/<YYYY-MM>_<id>    one person's availability for one calendar month
 *   rotas/<YYYY-MM-DD>             one fortnight's rota
 * Readable copies are kept in an "Availability" tab and one "Rota …" tab per fortnight.
 * Every request must carry the team key, which `setup` creates and shows on the "Setup" tab.
 */

const DATA_SHEET = "_data";
const PATH_RE = /^(settings\/team|availability\/[A-Za-z0-9_.-]{1,80}|rotas\/\d{4}-\d{2}-\d{2})$/;

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = ss.getSheetByName(DATA_SHEET) || ss.insertSheet(DATA_SHEET);
  data.getRange(1, 1, 1, 3).setValues([["path", "json", "updated"]]);
  data.hideSheet();

  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty("TEAM_KEY");
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
    props.setProperty("TEAM_KEY", key);
  }

  const s = ss.getSheetByName("Setup") || ss.insertSheet("Setup", 0);
  s.clear();
  s.getRange("A1:B5").setValues([
    ["Team key", key],
    ["", ""],
    ["Rota website", ""],
    ["Team link", '=IF(B3="","Paste your GitHub Pages address into B3",B3&IF(RIGHT(B3,1)="/","","/")&"#k="&B1)'],
    ["", "Send the team link to everyone on the rota. Anyone with it can view and edit the rota, so keep it within the team."],
  ]);
  s.getRange("A1:A4").setFontWeight("bold");
  s.setColumnWidth(1, 120);
  s.setColumnWidth(2, 640);
  Logger.log("Setup done. Team key: " + key);
}

/** Run this only if the team link has leaked: it makes a new key, and the old link stops working. */
function resetTeamKey() {
  PropertiesService.getScriptProperties().deleteProperty("TEAM_KEY");
  setup();
}

function doGet() {
  return json_({ ok: true, service: "on-call-rota" });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) { return json_({ ok: false, error: "bad_request" }); }
  const key = PropertiesService.getScriptProperties().getProperty("TEAM_KEY");
  if (!key) return json_({ ok: false, error: "not_set_up" });
  if (req.k !== key) return json_({ ok: false, error: "bad_key" });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    if (req.action === "load") return json_(Object.assign({ ok: true }, load_(req.months)));
    if (req.action === "set" || req.action === "delete") {
      if (!PATH_RE.test(String(req.path || ""))) return json_({ ok: false, error: "bad_path" });
      if (req.action === "set" && (typeof req.data !== "object" || req.data === null || Array.isArray(req.data))) return json_({ ok: false, error: "bad_data" });
      const text = req.action === "set" ? JSON.stringify(req.data) : null;
      if (text && text.length > 45000) return json_({ ok: false, error: "too_big" });
      put_(req.path, text);
      afterWrite_(req);
      return json_({ ok: true });
    }
    return json_({ ok: false, error: "bad_action" });
  } catch (err) {
    return json_({ ok: false, error: "server", message: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function dataSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DATA_SHEET);
  if (!sh) { setup(); sh = ss.getSheetByName(DATA_SHEET); }
  return sh;
}

/** All records as {path: {row, data}}. */
function readAll_() {
  const sh = dataSheet_();
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return out;
  const values = sh.getRange(2, 1, last - 1, 2).getValues();
  values.forEach((v, i) => {
    if (!v[0]) return;
    try { out[v[0]] = { row: i + 2, data: JSON.parse(v[1]) }; } catch (err) {}
  });
  return out;
}

function put_(path, text) {
  const sh = dataSheet_();
  const rec = readAll_()[path];
  if (text === null) { if (rec) sh.deleteRow(rec.row); return; }
  const row = [path, text, new Date()];
  if (rec) sh.getRange(rec.row, 1, 1, 3).setValues([row]);
  else sh.appendRow(row);
}

function load_(monthsCsv) {
  const months = String(monthsCsv || "").split(",").filter(Boolean);
  const all = readAll_();
  const availability = [], rotas = [];
  Object.keys(all).forEach(p => {
    const d = all[p].data;
    if (p.indexOf("availability/") === 0 && d && months.indexOf(d.month) >= 0) availability.push(d);
    if (p.indexOf("rotas/") === 0 && d) rotas.push(d);
  });
  return {
    team: all["settings/team"] ? all["settings/team"].data : null,
    availability: availability,
    rotas: rotas,
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
  };
}

function afterWrite_(req) {
  const p = String(req.path);
  if (p === "settings/team" || p.indexOf("availability/") === 0) rebuildAvailability_();
  if (p.indexOf("rotas/") === 0 && req.sheet) writeRotaSheet_(req.sheet, req.action === "delete");
}

/** Readable "Availability" tab: one row per date, one column per person. */
function rebuildAvailability_() {
  const all = readAll_();
  const team = all["settings/team"] ? all["settings/team"].data : null;
  const members = (team && team.members) || [];
  const shift = (team && team.shift) || {};
  const label = {
    full: "Full shift",
    half: "Half (either)",
    am: (shift.amName || "Day") + " half",
    pm: (shift.pmName || "Night") + " half",
  };
  const byDate = {};
  Object.keys(all).forEach(p => {
    const d = all[p].data;
    if (p.indexOf("availability/") !== 0 || !d || !d.days) return;
    Object.keys(d.days).forEach(dt => { (byDate[dt] = byDate[dt] || {})[d.memberId] = d.days[dt]; });
  });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rows = [["Date", "Day"].concat(members.map(m => m.name))];
  Object.keys(byDate).sort().forEach(dt => {
    const parts = dt.split("-").map(Number);
    const wd = days[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
    rows.push([dt, wd].concat(members.map(m => label[byDate[dt][m.id]] || "")));
  });
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("Availability") || ss.insertSheet("Availability");
  sh.clear();
  sh.getRange(1, 1, rows.length, rows[0].length).setNumberFormat("@").setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight("bold");
  sh.setFrozenRows(1);
}

/** Readable "Rota …" tab for one fortnight, laid out by the page. */
function writeRotaSheet_(sheet, remove) {
  const name = String(sheet.name || "").replace(/[\[\]\*\?\/\\:]/g, "-").slice(0, 90);
  if (!name) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (remove) { if (sh) ss.deleteSheet(sh); return; }
  const rows = Array.isArray(sheet.rows) ? sheet.rows.filter(r => Array.isArray(r)) : [];
  if (!rows.length) return;
  const width = Math.max.apply(null, rows.map(r => r.length));
  const grid = rows.map(r => { const x = r.map(v => String(v == null ? "" : v)); while (x.length < width) x.push(""); return x; });
  if (!sh) sh = ss.insertSheet(name, 1);
  sh.clear();
  sh.getRange(1, 1, grid.length, width).setNumberFormat("@").setValues(grid);
  sh.getRange(1, 1, 1, width).setFontWeight("bold");
  sh.setFrozenRows(1);
}
