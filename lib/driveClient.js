/**
 * Minimal read-only Google Drive client, used by the PO handoff import.
 *
 * Scope is `drive.readonly`, granted per user through the same incremental
 * consent flow as Gmail. Tokens are stored encrypted on the user record and
 * exchanged for a short-lived access token per request - see lib/gmailSend,
 * which owns that plumbing.
 *
 * Deliberately small: list a folder, download a file. Anything more would be
 * speculative, and a narrower surface is easier to reason about for a
 * restricted scope.
 */
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const DRIVE_FILES = process.env.DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3/files';

/** Files directly inside a folder. Shared drives included, trash excluded. */
async function listFolder(accessToken, folderId) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const url = `${DRIVE_FILES}?q=${q}`
    + '&fields=files(id,name,mimeType,size,modifiedTime)'
    + '&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body.error && body.error.message) || `Drive list failed (${res.status})`);
  }
  return body.files || [];
}

/** Metadata for a single file. */
async function getFile(accessToken, fileId) {
  const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}`
    + '?fields=id,name,mimeType,size&supportsAllDrives=true';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* Name the file ID and what a 404 actually means here. A folder and a
     * single file are separately shared in Drive: being able to read the
     * folder says nothing about a file that lives elsewhere, and "Drive
     * metadata failed (404)" gave no hint that sharing was the issue. */
    const detail = (body.error && body.error.message) || `HTTP ${res.status}`;
    const hint = res.status === 404
      ? ' - the file may not be shared with the connected Google account, or the link may point at a deleted file'
      : res.status === 403
        ? ' - the connected Google account does not have permission to read it'
        : '';
    throw new Error(`Drive file ${fileId}: ${detail}${hint}`);
  }
  return body;
}

/**
 * Download a file's bytes.
 *
 * Google-native files (Docs, Sheets, Slides) have no bytes to download and
 * must be exported instead, so they're converted to PDF. Without this the
 * download fails with a confusing "Only files with binary content can be
 * downloaded" error.
 */
/**
 * Stream a file straight to disk.
 *
 * downloadFile() below buffers the whole thing in memory, which is fine for
 * one file but not for a handoff: thirteen camera photos plus two 8.6 MB
 * PDFs plus a zipped folder, all held as Buffers in one sequential loop,
 * is enough to exhaust the process. That failed silently partway through -
 * the early items imported, the later ones simply never happened, and the
 * summary that would have reported it never ran either.
 */
async function downloadFileToPath(accessToken, file, destPath) {
  const native = String(file.mimeType || '').startsWith('application/vnd.google-apps');
  const url = native
    ? `${DRIVE_FILES}/${encodeURIComponent(file.id)}/export?mimeType=application%2Fpdf&supportsAllDrives=true`
    : `${DRIVE_FILES}/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Drive download of "${file.name || file.id}" failed (${res.status}): `
      + detail.slice(0, 200));
  }
  // Node's fetch gives a web stream; Readable.fromWeb bridges it so the
  // bytes go to disk without ever all being resident.
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  const name = native && !/\.pdf$/i.test(file.name || '') ? `${file.name}.pdf` : file.name;
  return { name: name || 'file', path: destPath, size: fs.statSync(destPath).size };
}

async function downloadFile(accessToken, file) {
  const native = String(file.mimeType || '').startsWith('application/vnd.google-apps');
  const url = native
    ? `${DRIVE_FILES}/${encodeURIComponent(file.id)}/export?mimeType=application%2Fpdf&supportsAllDrives=true`
    : `${DRIVE_FILES}/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Drive download of "${file.name || file.id}" failed (${res.status}): `
      + detail.slice(0, 200));
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const name = native && !/\.pdf$/i.test(file.name || '') ? `${file.name}.pdf` : file.name;
  return { name: name || 'file', buffer };
}

module.exports = { listFolder, getFile, downloadFile, downloadFileToPath };
