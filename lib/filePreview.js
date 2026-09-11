/**
 * Preview images for uploaded documents.
 *
 * The team was screenshotting hang tags, washing tags and packaging PDFs by
 * hand to get a picture they could show in PD approval and on the
 * sub-component PO. This does that automatically: the first page of a PDF
 * is rendered to a PNG once, cached beside the original, and served
 * wherever a thumbnail is wanted.
 *
 * mupdf is used rather than a poppler/canvas binding because it ships as
 * WASM - no native build step, which matters on Render where a failed
 * node-gyp compile would take the whole deploy down. It's ESM-only with a
 * top-level await, hence the dynamic import from this CommonJS module.
 */
const fs = require('fs');
const path = require('path');

/** Extensions we can turn into a preview. */
const PDF_RE = /\.(pdf|ai)(\?|#|$)/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i;

let mupdfPromise = null;
function getMupdf() {
  // Loaded once, lazily: a PO panel that never opens a preview shouldn't
  // pay for instantiating the WASM module.
  if (!mupdfPromise) mupdfPromise = import('mupdf');
  return mupdfPromise;
}

function canPreview(nameOrPath) {
  const s = String(nameOrPath || '');
  return PDF_RE.test(s) || IMAGE_RE.test(s);
}

/** True when the file itself is already a displayable image. */
function isImage(nameOrPath) {
  return IMAGE_RE.test(String(nameOrPath || ''));
}

/**
 * Render the first page of a PDF to a PNG.
 *
 * Illustrator files are included deliberately: a .ai saved with PDF
 * compatibility - which is Illustrator's default - opens as a PDF, so the
 * artwork previews without any extra handling. One that isn't throws, and
 * the caller treats it as "no preview" rather than failing the upload.
 */
async function renderPdfFirstPage(srcPath, destPath, scale = 0.6) {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(fs.readFileSync(srcPath), 'application/pdf');
  try {
    if (!doc.countPages()) throw new Error('PDF has no pages');
    const page = doc.loadPage(0);
    const pix = page.toPixmap(
      mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    fs.writeFileSync(destPath, Buffer.from(pix.asPNG()));
    return destPath;
  } finally {
    // Free the document rather than waiting on GC - these run in batches
    // during an import, and the memory profile is what broke the importer
    // before.
    if (typeof doc.destroy === 'function') doc.destroy();
  }
}

/**
 * Preview path for a stored file, generating it on first request.
 *
 * Returns null when the type can't be previewed, so callers can fall back
 * to a "View file" link instead of showing a broken image.
 */
async function ensurePreview(srcPath, cacheDir, key) {
  if (!fs.existsSync(srcPath)) return null;
  if (!canPreview(srcPath)) return null;
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, `${key}.png`);
  if (fs.existsSync(dest)) return dest;
  if (isImage(srcPath)) return srcPath;   // already viewable; no render needed
  await renderPdfFirstPage(srcPath, dest);
  return dest;
}

/**
 * Generate a preview during an import, without ever failing the import.
 *
 * Size-capped on purpose. mupdf reads the whole document into memory, and
 * an Illustrator file can be tens of megabytes - this runs inside the same
 * sequential loop that previously exhausted the process by buffering
 * downloads, so it must not reintroduce that. Anything over the cap is
 * skipped here and rendered on demand later instead, where it's one file
 * on its own rather than one of fifteen.
 */
const MAX_PREVIEW_BYTES = 40 * 1024 * 1024;

async function tryGeneratePreview(srcPath, cacheDir, key) {
  try {
    if (!fs.existsSync(srcPath) || !canPreview(srcPath)) return null;
    if (isImage(srcPath)) return null;          // nothing to render
    const { size } = fs.statSync(srcPath);
    if (size > MAX_PREVIEW_BYTES) {
      console.log(`Preview skipped for ${path.basename(srcPath)}: ${Math.round(size / 1048576)}MB `
        + 'exceeds the inline cap; it will render on first view instead.');
      return null;
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    const dest = path.join(cacheDir, `${key}.png`);
    if (fs.existsSync(dest)) return dest;
    await renderPdfFirstPage(srcPath, dest);
    return dest;
  } catch (err) {
    // A file that won't render is not a reason to fail an import.
    console.warn(`Preview generation failed for ${path.basename(srcPath)}:`, err.message || err);
    return null;
  }
}

module.exports = {
  canPreview, isImage, renderPdfFirstPage, ensurePreview, tryGeneratePreview, MAX_PREVIEW_BYTES
};
