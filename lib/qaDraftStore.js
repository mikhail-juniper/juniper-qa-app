/**
 * Storage for photos belonging to an in-progress QA report.
 *
 * WHY THIS EXISTS
 * Photos used to be held as browser File objects and only uploaded when the
 * report was submitted. That made save-and-resume impossible - File objects
 * cannot be serialised, so any attempt to store a half-finished report would
 * silently drop every photo taken so far. It also meant an inspector who
 * filled in six steps on a factory floor and lost their phone battery lost the
 * lot.
 *
 * Photos are now uploaded the moment they are taken, into a per-draft folder,
 * and the report holds lightweight references. Submission resolves those
 * references off disk instead of re-uploading megabytes the server already has.
 *
 * Drafts are disposable by design: once a report is submitted its photos are
 * copied into the submission, and the draft folder can be swept up.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

let ROOT = null;

function init(dataDir) {
  ROOT = path.join(dataDir, 'qa-drafts');
  fs.mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

/** Draft ids come from the client, so they are validated rather than trusted -
 *  without this, "../../config" would be a path traversal into the config
 *  directory. */
function safeId(id) {
  const v = String(id || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

function draftDir(draftId, create = false) {
  const id = safeId(draftId);
  if (!id) return null;
  const dir = path.join(ROOT, id);
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Store one uploaded photo or video and return the reference the report holds. */
function savePhoto(draftId, file) {
  const dir = draftDir(draftId, true);
  if (!dir) return null;
  const ext = path.extname(file.originalname || '') || '';
  const id = uuidv4() + ext;
  fs.writeFileSync(path.join(dir, id), file.buffer);
  return {
    id,
    name: file.originalname || id,
    type: file.mimetype || 'application/octet-stream',
    size: file.size || (file.buffer ? file.buffer.length : 0),
    url: `/qa-draft-files/${encodeURIComponent(draftId)}/${encodeURIComponent(id)}`
  };
}

/** Read one back in the shape the PDF builder already expects from multer. */
function readPhoto(draftId, ref) {
  const dir = draftDir(draftId);
  if (!dir || !ref || !ref.id) return null;
  // Same reasoning as safeId: the stored name is client-supplied.
  if (!/^[A-Za-z0-9_.-]+$/.test(String(ref.id))) return null;
  const p = path.join(dir, ref.id);
  if (!fs.existsSync(p)) return null;
  return {
    fieldname: ref.field || '',
    originalname: ref.name || ref.id,
    mimetype: ref.type || 'application/octet-stream',
    buffer: fs.readFileSync(p),
    size: fs.statSync(p).size
  };
}

/**
 * The saved state of an in-progress report.
 *
 * Stored beside that draft's photos, so removing the draft removes both and
 * there is no way to end up with orphaned state pointing at deleted images.
 */
function stateFile(draftId) {
  const dir = draftDir(draftId, true);
  return dir ? path.join(dir, '_state.json') : null;
}

function saveState(draftId, data) {
  const f = stateFile(draftId);
  if (!f) return false;
  fs.writeFileSync(f, JSON.stringify({ savedAt: new Date().toISOString(), data }, null, 2));
  return true;
}

function loadState(draftId) {
  const f = stateFile(draftId);
  if (!f || !fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    // A corrupt draft must not block starting the report over.
    console.error('Could not read draft state, ignoring it:', err.message || err);
    return null;
  }
}

function deletePhoto(draftId, photoId) {
  const dir = draftDir(draftId);
  if (!dir || !/^[A-Za-z0-9_.-]+$/.test(String(photoId || ''))) return false;
  const p = path.join(dir, photoId);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

function removeDraft(draftId) {
  const dir = draftDir(draftId);
  if (!dir || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Delete draft folders older than `days`.
 *
 * Abandoned drafts would otherwise accumulate on a per-GB disk forever - an
 * inspector who opens a report and walks away leaves their photos behind, and
 * nothing else ever cleans them up.
 */
function sweepOldDrafts(days = 30) {
  if (!ROOT || !fs.existsSync(ROOT)) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(ROOT)) {
    const dir = path.join(ROOT, name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch (e) { /* mid-delete or unreadable - skip it */ }
  }
  return removed;
}

module.exports = {
  init, savePhoto, readPhoto, deletePhoto, removeDraft, sweepOldDrafts,
  saveState, loadState,
  get root() { return ROOT; }
};
