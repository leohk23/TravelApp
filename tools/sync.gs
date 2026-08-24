/**
 * The shared copy of a trip, for Travel Planner.
 *
 * Paste this into a new Google Apps Script project, deploy it as a Web App,
 * and give the /exec URL to the app under About > Sharing. Setup is in
 * SHARING.md next to this file.
 *
 * One JSON file per trip code in a Drive folder. Not a Sheet: a routed trip
 * runs to tens of kilobytes and a cell stops at fifty thousand characters,
 * which is a limit you would meet on a long holiday and not before.
 *
 * There is no login. The /exec URL and the trip code together are the whole
 * credential, so anyone you give them to can read and overwrite the trip, and
 * anyone who obtains them can too. That is the deal this makes; see SHARING.md.
 */

var FOLDER = 'TravelApp trips';

function doGet(e) {
  var code = clean(e && e.parameter && e.parameter.code);
  if (!code) return reply({ error: 'This trip has no code set.' });

  var file = find(code);
  if (!file) return reply({ rev: 0 });          // nobody has saved it yet
  return reply(JSON.parse(file.getBlob().getDataAsString()));
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); }
  catch (err) { return reply({ error: 'That was not readable JSON.' }); }

  var code = clean(body.code);
  if (!code) return reply({ error: 'This trip has no code set.' });
  if (!body.state) return reply({ error: 'Nothing to save.' });

  var rev = Number(body.rev) || 0;
  var file = find(code);
  var held = file ? JSON.parse(file.getBlob().getDataAsString()) : { rev: 0 };

  // The guard that makes last-write-wins a choice rather than an accident: a
  // save built on an older copy is refused, and the app asks before forcing it.
  if (!body.force && held.rev >= rev) {
    return reply({ conflict: true, rev: held.rev, savedAt: held.savedAt, by: held.by });
  }

  var next = {
    rev: rev,
    savedAt: new Date().toISOString(),
    by: String(body.by || '').slice(0, 40),
    state: body.state,
  };
  var json = JSON.stringify(next);
  if (file) file.setContent(json);
  else folder().createFile(name(code), json, 'application/json');

  return reply({ ok: true, rev: next.rev, savedAt: next.savedAt, by: next.by });
}

/* ---------- plumbing ---------- */

function clean(v) {
  // Codes end up in a filename, so keep them to something that cannot escape it.
  return String(v || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function name(code) { return 'trip-' + code + '.json'; }

function folder() {
  var found = DriveApp.getFoldersByName(FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER);
}

function find(code) {
  var files = folder().getFilesByName(name(code));
  return files.hasNext() ? files.next() : null;
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
