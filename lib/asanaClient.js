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
const ASANA_API_BASE = process.env.ASANA_API_BASE || 'https://app.asana.com/api/1.0';

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


/* ------------------------------------------------------------------ *
 * Name-based field access
 *
 * The original helpers above take custom-field GIDs from
 * config/asanaFieldMap.json. That's fine for three approval fields, but the
 * full PO sync touches ~15 more, and hand-collecting every GID (plus every
 * enum option GID) is tedious and breaks whenever someone edits the field
 * in Asana.
 *
 * So everything below resolves fields by their NAME as shown in Asana
 * ("PO Status", "Factory code", ...). Asana returns each task's
 * custom_fields with name, gid, type and enum_options, so one task fetch
 * gives us everything needed to both read and write by name.
 * ------------------------------------------------------------------ */

function authHeaders() {
  const token = process.env.ASANA_ACCESS_TOKEN;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Fetch one task with the fields needed to read/write custom fields. */
async function getTask(taskGid) {
  const headers = authHeaders();
  if (!headers || !taskGid) return null;
  const opt = 'opt_fields=name,completed,custom_fields.name,custom_fields.type,' +
    'custom_fields.display_value,custom_fields.text_value,custom_fields.number_value,' +
    'custom_fields.enum_value.name,custom_fields.enum_value.gid,custom_fields.enum_options.name,' +
    'custom_fields.enum_options.gid,custom_fields.date_value.date,custom_fields.people_value.name,' +
    'custom_fields.gid,custom_fields.resource_subtype';
  try {
    const res = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}?${opt}`, { headers });
    if (!res.ok) {
      console.error(`Asana getTask failed (${res.status}) for ${taskGid}:`, await res.text().catch(() => ''));
      return null;
    }
    const body = await res.json();
    return body.data || null;
  } catch (err) {
    console.error(`Asana getTask request failed for ${taskGid}:`, err.message || err);
    return null;
  }
}

/** Find a task in the configured project whose "PO Number" field (or task
 *  name) matches. Asana has no direct "find by custom field value" on the
 *  free API tier, so this pages the project's tasks and matches locally. */
async function findTaskByPoNumber(projectGid, poNumber) {
  const headers = authHeaders();
  if (!headers || !projectGid || !poNumber) return null;
  const wanted = String(poNumber).trim().toLowerCase();
  const opt = 'opt_fields=name,custom_fields.name,custom_fields.display_value&limit=100';
  let url = `${ASANA_API_BASE}/projects/${encodeURIComponent(projectGid)}/tasks?${opt}`;
  try {
    // Walk pages until we hit a match - most PO numbers land on page 1 or 2.
    for (let page = 0; page < 20 && url; page += 1) {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.error(`Asana findTaskByPoNumber failed (${res.status}):`, await res.text().catch(() => ''));
        return null;
      }
      const body = await res.json();
      const hit = (body.data || []).find((task) => {
        if (String(task.name || '').toLowerCase().includes(wanted)) return true;
        return (task.custom_fields || []).some((f) =>
          String(f.name || '').trim().toLowerCase() === 'po number' &&
          String(f.display_value || '').trim().toLowerCase() === wanted);
      });
      if (hit) return getTask(hit.gid);
      url = body.next_page && body.next_page.uri ? body.next_page.uri : null;
    }
    return null;
  } catch (err) {
    console.error('Asana findTaskByPoNumber request failed:', err.message || err);
    return null;
  }
}

/** Read a task's custom fields into a plain { "Field Name": value } object.
 *  Values come back as display strings (or the raw date for date fields),
 *  which is what the ERP side wants for every mapped field. */
function readCustomFields(task) {
  const out = {};
  (task && task.custom_fields || []).forEach((f) => {
    const name = String(f.name || '').trim();
    if (!name) return;
    let value = null;
    if (f.type === 'enum') value = f.enum_value ? f.enum_value.name : null;
    else if (f.type === 'text') value = f.text_value || null;
    else if (f.type === 'number') value = f.number_value != null ? f.number_value : null;
    else if (f.type === 'date') value = f.date_value ? f.date_value.date : null;
    else if (f.type === 'people') value = (f.people_value || []).map((p) => p.name).join(', ') || null;
    else value = f.display_value || null;
    out[name] = value;
  });
  return out;
}

/** Write one field by name. Resolves the field's GID and type from the task
 *  itself, and for enums resolves the option GID by option name (matched
 *  case-insensitively). Best-effort like the rest of this module. */
async function setFieldByName(taskGid, fieldName, value, taskCache) {
  const headers = authHeaders();
  if (!headers || !taskGid || !fieldName) return false;
  const task = taskCache || await getTask(taskGid);
  if (!task) return false;
  const field = (task.custom_fields || []).find(
    (f) => String(f.name || '').trim().toLowerCase() === String(fieldName).trim().toLowerCase());
  if (!field) {
    console.warn(`Asana sync: no custom field named "${fieldName}" on task ${taskGid} - skipping.`);
    return false;
  }
  let payload;
  if (field.type === 'enum') {
    if (value === null || value === '') {
      payload = null; // clears the dropdown
    } else {
      const opt = (field.enum_options || []).find(
        (o) => String(o.name || '').trim().toLowerCase() === String(value).trim().toLowerCase());
      if (!opt) {
        console.warn(`Asana sync: "${fieldName}" has no option named "${value}" - skipping.`);
        return false;
      }
      payload = opt.gid;
    }
  } else if (field.type === 'number') {
    payload = value === null || value === '' ? null : Number(value);
    if (payload !== null && isNaN(payload)) return false;
  } else if (field.type === 'date') {
    payload = value ? { date: String(value).slice(0, 10) } : null;
  } else {
    payload = value === null || value === undefined ? '' : String(value);
  }
  try {
    const res = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ data: { custom_fields: { [field.gid]: payload } } })
    });
    if (!res.ok) {
      console.error(`Asana set "${fieldName}" failed (${res.status}):`, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Asana set "${fieldName}" request failed:`, err.message || err);
    return false;
  }
}

/** Write several named fields with a single task fetch shared between them. */
async function setFieldsByName(taskGid, values) {
  const task = await getTask(taskGid);
  if (!task) return { ok: false, written: [], skipped: Object.keys(values || {}) };
  const written = [];
  const skipped = [];
  for (const [name, value] of Object.entries(values || {})) {
    if (value === undefined) continue; // undefined = "don't touch"; null = "clear"
    /* eslint-disable no-await-in-loop */
    const ok = await setFieldByName(taskGid, name, value, task);
    (ok ? written : skipped).push(name);
  }
  return { ok: true, written, skipped };
}

module.exports = {
  setEnumCustomField, setTextCustomField, attachFileToTask,
  getTask, findTaskByPoNumber, readCustomFields, setFieldByName, setFieldsByName
};
