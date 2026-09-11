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
/**
 * Fetch a task with caller-chosen opt_fields.
 *
 * getTask() below asks for a fixed list of sub-fields, which silently omits
 * anything Asana has added since - notably the newer relationship/reference
 * field types. Requesting `custom_fields` wholesale returns each field's
 * full object instead, which is what diagnostics need.
 */
async function getTaskRaw(taskGid, optFields) {
  const headers = authHeaders();
  if (!headers || !taskGid) return null;
  const opt = `opt_fields=${encodeURIComponent(optFields || 'name,custom_fields')}`;
  const res = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}?${opt}`, { headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Asana returned ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = await res.json();
  return body.data || null;
}

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
/**
 * Attachments on one comment (story) of a task.
 *
 * Asana's attachment download URLs are short-lived signed links, so they're
 * fetched and used immediately rather than stored. Passing no commentGid
 * returns the task's own attachments instead.
 */
async function getCommentAttachments(taskGid, commentGid) {
  const headers = authHeaders();
  if (!headers || !taskGid) return [];

  /* Attachments belong to the TASK, not to a comment - passing a story GID
   * as parent returns 400 ("`parent` does not refer to a task, project, or
   * project brief"). Asana exposes no story->attachment association either.
   *
   * But a handoff link points at ONE comment, and the task usually carries
   * attachments from several. So the comment's timestamp is used to select
   * the ones uploaded with it: images posted in a comment share its
   * created_at within a few seconds. If the story can't be read, every task
   * attachment is returned rather than none - over-importing is recoverable,
   * silently importing nothing is not. */
  const res = await fetch(
    `${ASANA_API_BASE}/attachments?parent=${encodeURIComponent(taskGid)}` +
    '&opt_fields=name,download_url,view_url,resource_subtype,size,created_at', { headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Asana returned ${res.status} listing attachments: ${detail.slice(0, 200)}`);
  }
  const all = (await res.json()).data || [];
  if (!commentGid || !all.length) return all;

  let storyTime = null;
  try {
    const sres = await fetch(
      `${ASANA_API_BASE}/stories/${encodeURIComponent(commentGid)}?opt_fields=created_at,text`,
      { headers });
    if (sres.ok) {
      const sd = (await sres.json()).data || {};
      storyTime = sd.created_at ? new Date(sd.created_at).getTime() : null;
    }
  } catch (err) {
    console.warn('Asana: could not read the comment timestamp, importing all task attachments:',
      err.message || err);
  }
  if (!storyTime) return all;

  const WINDOW_MS = 10 * 60 * 1000; // generous: a big upload takes a while
  const near = all.filter((a) => {
    if (!a.created_at) return false;
    return Math.abs(new Date(a.created_at).getTime() - storyTime) <= WINDOW_MS;
  });
  // If the window matches nothing, the heuristic has failed - fall back
  // rather than reporting an empty import.
  return near.length ? near : all;
}

/** Fetch an Asana-hosted attachment's bytes. */
async function downloadAttachment(att) {
  if (!att || !att.download_url) return null;
  const res = await fetch(att.download_url);
  if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
  return { name: att.name || 'attachment', buffer: Buffer.from(await res.arrayBuffer()) };
}

/** Subtasks of a task, with the fields the handoff import needs. */
async function getSubtasks(taskGid) {
  const headers = authHeaders();
  if (!headers || !taskGid) return [];
  const opt = 'opt_fields=name,notes,completed';
  const res = await fetch(
    `${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}/subtasks?${opt}`, { headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Asana returned ${res.status} listing subtasks: ${detail.slice(0, 200)}`);
  }
  const body = await res.json();
  return body.data || [];
}

/** Add a new option to an enum custom field, returning the created option. */
async function createEnumOption(customFieldGid, name) {
  const headers = authHeaders();
  if (!headers || !customFieldGid || !name) return null;
  try {
    const res = await fetch(
      `${ASANA_API_BASE}/custom_fields/${encodeURIComponent(customFieldGid)}/enum_options`,
      { method: 'POST', headers, body: JSON.stringify({ data: { name: String(name) } }) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`Asana sync: could not add option "${name}": ${res.status} ${detail.slice(0, 200)}`);
      return null;
    }
    const body = await res.json();
    return body.data || null;
  } catch (err) {
    console.warn(`Asana sync: could not add option "${name}":`, err.message || err);
    return null;
  }
}

async function setFieldByName(taskGid, fieldName, value, taskCache, opts = {}) {
  const headers = authHeaders();
  if (!headers || !taskGid || !fieldName) return false;
  const task = taskCache || await getTask(taskGid);
  if (!task) return false;
  /* Field names are not unique in Asana - this workspace has two fields
   * called "Sourcer", one people and one enum. Without a tiebreak the sync
   * writes to whichever happens to come first, which is how a value can be
   * "written" and still appear blank on the field people actually look at. */
  const matches = (task.custom_fields || []).filter(
    (f) => String(f.name || '').trim().toLowerCase() === String(fieldName).trim().toLowerCase());
  let field = matches[0];
  if (matches.length > 1) {
    const preferred = opts.preferType && matches.find((f) => f.type === opts.preferType);
    if (preferred) {
      field = preferred;
    } else {
      console.warn(
        `Asana sync: ${matches.length} fields named "${fieldName}" (types: ` +
        `${matches.map((f) => f.type).join(', ')}). Using the first - set preferFieldType ` +
        'in config/asanaPoSync.json to choose.');
    }
  }
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
      if (!opt && opts.createMissingOption) {
        /* Some dropdowns are registries that grow over time - factory codes
         * get a new entry whenever a supplier is onboarded. Refusing to
         * write just leaves the field blank, so the option is created. */
        const created = await createEnumOption(field.gid, value);
        if (created) {
          console.log(`Asana sync: added "${value}" as a new option on "${fieldName}".`);
          payload = created.gid;
        }
      }
      if (!payload) {
        if (!opt) {
          // Loud on purpose: this is the most common reason a field appears
          // not to sync. Listing the real options makes the fix obvious.
          const available = (field.enum_options || []).map((o) => o.name).join(' | ');
          console.warn(
            `Asana sync: field "${fieldName}" has no option named "${value}" - skipping. ` +
            `Available options: ${available}. Fix the mapping in config/asanaPoSync.json.`);
          return false;
        }
        payload = opt.gid;
      }
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
async function setFieldsByName(taskGid, values, fieldOpts = {}) {
  const task = await getTask(taskGid);
  if (!task) return { ok: false, written: [], skipped: Object.keys(values || {}) };
  const written = [];
  const skipped = [];
  for (const [name, value] of Object.entries(values || {})) {
    if (value === undefined) continue; // undefined = "don't touch"; null = "clear"
    /* eslint-disable no-await-in-loop */
    const ok = await setFieldByName(taskGid, name, value, task, fieldOpts[name] || {});
    (ok ? written : skipped).push(name);
  }
  return { ok: true, written, skipped };
}

module.exports = {
  getTaskRaw,
  setEnumCustomField, setTextCustomField, attachFileToTask,
  getTask, findTaskByPoNumber, readCustomFields, setFieldByName, setFieldsByName, createEnumOption, getSubtasks, getCommentAttachments, downloadAttachment
};
