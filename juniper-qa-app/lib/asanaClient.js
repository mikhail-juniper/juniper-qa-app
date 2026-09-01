/**
 * Minimal Asana API client: updates one enum ("dropdown") custom field on
 * one task. Used to mirror this app's approval decisions onto the Asana
 * task's Sample/PP/Bulk Approval fields automatically.
 *
 * Requires ASANA_ACCESS_TOKEN in the environment (a Personal Access Token
 * from Asana: My Settings -> Apps -> Manage Developer Apps -> Personal
 * Access Tokens). Keep this in .env / the server's environment - never in
 * a config file that gets committed to git.
 *
 * "Best effort" by design: if the token isn't set, the task has no Asana
 * link, or Asana's API returns an error, this logs a warning and returns
 * without throwing - a hiccup updating Asana should never block or fail
 * someone's actual approval submission in this app.
 */
const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

/**
 * @param {string} taskGid - the Asana task's numeric ID (see poStore ->
 *   extractAsanaTaskGid, which pulls this from the pasted task URL).
 * @param {string} fieldGid - the custom field's GID (see config/asanaFieldMap.json).
 * @param {string} enumOptionGid - the specific dropdown option's GID to select.
 */
async function setEnumCustomField(taskGid, fieldGid, enumOptionGid) {
  if (!taskGid || !fieldGid || !enumOptionGid) return;
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) {
    console.warn('Asana sync skipped: ASANA_ACCESS_TOKEN is not set.');
    return;
  }
  try {
    const res = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: { custom_fields: { [fieldGid]: enumOptionGid } } })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Asana sync failed (${res.status}) for task ${taskGid}, field ${fieldGid}, option ${enumOptionGid}:`, body);
    }
  } catch (err) {
    console.error(`Asana sync request failed for task ${taskGid}:`, err.message || err);
  }
}

/**
 * @param {string} taskGid
 * @param {string} fieldGid - a text-type custom field's GID (not an enum
 *   field - use setEnumCustomField for dropdowns).
 * @param {string} textValue
 */
async function setTextCustomField(taskGid, fieldGid, textValue) {
  if (!taskGid || !fieldGid) return;
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) {
    console.warn('Asana sync skipped: ASANA_ACCESS_TOKEN is not set.');
    return;
  }
  try {
    const res = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: { custom_fields: { [fieldGid]: textValue } } })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Asana sync failed (${res.status}) for task ${taskGid}, field ${fieldGid}, value ${textValue}:`, body);
    }
  } catch (err) {
    console.error(`Asana sync request failed for task ${taskGid}:`, err.message || err);
  }
}

/**
 * Uploads a file as an attachment on a task - shows up in the task's
 * activity feed as an attachment, the same as if someone had dragged a
 * file onto the task in Asana's own UI.
 * @param {string} taskGid
 * @param {Buffer} fileBuffer
 * @param {string} filename
 * @param {string} mimeType
 */
async function attachFileToTask(taskGid, fileBuffer, filename, mimeType) {
  if (!taskGid || !fileBuffer) return;
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) {
    console.warn('Asana sync skipped: ASANA_ACCESS_TOKEN is not set.');
    return;
  }
  try {
    const form = new FormData();
    form.append('file', new Blob([fileBuffer], { type: mimeType || 'application/pdf' }), filename);

    const res = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}/attachments`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: form
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Asana attachment upload failed (${res.status}) for task ${taskGid}:`, body);
    }
  } catch (err) {
    console.error(`Asana attachment upload request failed for task ${taskGid}:`, err.message || err);
  }
}

module.exports = { setEnumCustomField, setTextCustomField, attachFileToTask };
