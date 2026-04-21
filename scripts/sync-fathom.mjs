#!/usr/bin/env node
/**
 * Koronet Hubs — Fathom sync
 *
 * Pulls meetings + transcripts from Fathom, filters per hub, matches the content
 * against the 42 static training topics using a keyword rule, and writes:
 *   /data/{slug}/status.json     → status per topic (Done / Partial / Not started)
 *   /data/{slug}/recordings.json → list of session recordings for the hub
 *
 * Credentials (GitHub Secrets):
 *   FATHOM_API_KEY
 *
 * Matching rule (deterministic, no LLM):
 *   - Concatenate transcript text of all meetings matched to the hub.
 *   - For each topic: count distinct keyword hits in the combined text.
 *     0 hits        → "not_started"
 *     1 hit         → "partial"
 *     2+ hits       → "done"
 *   - Criteria lives here and is versioned in git. Same input → same output.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FATHOM_BASE = 'https://api.fathom.ai/external/v1';

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8'));
}

async function writeJson(rel, data) {
  const abs = path.join(ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`wrote ${rel}`);
}

function requireEnv(key) {
  const v = process.env[key];
  if (!v) throw new Error(`missing env var: ${key}`);
  return v;
}

function validateSecrets() {
  if (!process.env.FATHOM_API_KEY) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('MISSING GITHUB SECRET: FATHOM_API_KEY');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Add at: https://github.com/kometsalesimplementations/koronet-hubs/settings/secrets/actions');
    process.exit(1);
  }
  console.log(`FATHOM_API_KEY: set (${process.env.FATHOM_API_KEY.length} chars)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fathomGet(pathname, params = {}, attempt = 1) {
  const url = new URL(FATHOM_BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'X-Api-Key': requireEnv('FATHOM_API_KEY') },
  });
  if (res.status === 429) {
    // Respect Retry-After header; fall back to exponential backoff.
    const retryAfter = Number(res.headers.get('retry-after')) || Math.min(60, 2 ** attempt);
    if (attempt > 5) {
      throw new Error(`GET ${url} → 429 (rate limited, gave up after ${attempt} retries)`);
    }
    console.log(`  rate limited · sleeping ${retryAfter}s and retrying (attempt ${attempt + 1})`);
    await sleep(retryAfter * 1000);
    return fathomGet(pathname, params, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 || res.status === 403) {
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error(`FATHOM AUTH FAILED — HTTP ${res.status}`);
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('FATHOM_API_KEY is invalid or has been revoked.');
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } else if (res.status === 404) {
      console.error(`Fathom returned 404 for ${pathname}. Endpoint may have changed.`);
    }
    throw new Error(`GET ${url} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function listAllMeetings() {
  // Only pull recent meetings (last 90 days). Paginating through years of
  // history triggers Fathom rate limits and wastes time — the hub only
  // cares about the current implementation.
  const CUTOFF_DAYS = 90;
  const cutoff = new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000);
  const out = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 20;
  do {
    // include_transcript=true asks Fathom to populate the transcript field
    // inline in the listing response rather than returning null.
    const params = cursor
      ? { cursor, include_transcript: 'true' }
      : { include_transcript: 'true' };
    const page = await fathomGet('/meetings', params);
    const items = page.items || page.data || [];
    out.push(...items);
    pages += 1;
    // Stop if the oldest item on this page is older than our cutoff,
    // since the API returns meetings newest-first.
    const oldest = items[items.length - 1];
    const oldestDate = oldest && new Date(oldest.scheduled_start_time || oldest.start_time || oldest.created_at || 0);
    if (oldestDate && oldestDate < cutoff) {
      console.log(`  reached cutoff date (${CUTOFF_DAYS}d) after ${pages} page(s) · ${out.length} meetings`);
      break;
    }
    if (pages >= MAX_PAGES) {
      console.log(`  hit MAX_PAGES safety limit (${MAX_PAGES}) · ${out.length} meetings`);
      break;
    }
    cursor = page.next_cursor || page.cursor_next || null;
  } while (cursor);
  return out;
}

/**
 * Fathom returns the transcript inline on the /meetings listing response
 * (field: `transcript`). No second API call needed. Also falls back to
 * default_summary + action_items if the transcript is missing so the
 * keyword matcher still has text to work with.
 */
function extractText(meeting) {
  const parts = [];
  if (typeof meeting.transcript === 'string') parts.push(meeting.transcript);
  else if (Array.isArray(meeting.transcript)) {
    parts.push(meeting.transcript.map((t) => t.text || t.utterance || '').join('\n'));
  } else if (meeting.transcript && typeof meeting.transcript === 'object') {
    parts.push(JSON.stringify(meeting.transcript));
  }
  if (meeting.default_summary) parts.push(String(meeting.default_summary));
  if (Array.isArray(meeting.action_items)) {
    parts.push(meeting.action_items.map((a) => a.text || a.description || '').join('\n'));
  }
  return parts.filter(Boolean).join('\n\n');
}

function matchesHub(meeting, filter) {
  const f = filter.toLowerCase();
  const haystack = [
    meeting.title,
    meeting.meeting_title,
    meeting.name,
    meeting.client_name,
    meeting.customer_name,
    ...(meeting.invitees || []).map((i) => i.name || i.email || ''),
    ...(meeting.attendees || []).map((i) => i.name || i.email || ''),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(f);
}

function countHits(text, keywords) {
  const t = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (t.includes(kw.toLowerCase())) hits++;
  }
  return hits;
}

function statusForHits(hits) {
  if (hits === 0) return 'not_started';
  if (hits === 1) return 'partial';
  return 'done';
}

async function main() {
  validateSecrets();
  const { hubs } = await readJson('config/hubs.json');
  const { topics } = await readJson('config/training-topics.json');

  console.log('fetching all meetings from Fathom...');
  const meetings = await listAllMeetings();
  console.log(`got ${meetings.length} meetings`);

  for (const hub of hubs) {
    console.log(`--- ${hub.slug} · filter="${hub.fathom_client_filter}" ---`);
    // Load per-hub exclude list (recording IDs that should never appear in this hub).
    let excludedIds = new Set();
    try {
      const ex = await readJson(`data/${hub.slug}/recordings_excludes.json`);
      excludedIds = new Set((ex.excluded_ids || []).map(String));
      if (excludedIds.size) console.log(`  ${excludedIds.size} excluded ID(s) for this hub`);
    } catch { /* no excludes file is fine */ }
    const hubMeetings = meetings
      .filter((m) => matchesHub(m, hub.fathom_client_filter))
      .filter((m) => !excludedIds.has(String(m.recording_id || m.id)));
    console.log(`  ${hubMeetings.length} meetings match (after excludes)`);

    // If the listing returned transcript=null, try fetching each meeting by
    // id to get the full record. Fathom's single-meeting endpoint tends to
    // include the transcript even when the list doesn't.
    const withTranscripts = [];
    for (const m of hubMeetings) {
      let full = m;
      if (!m.transcript && m.recording_id) {
        try {
          full = await fathomGet(`/meetings/${m.recording_id}`);
        } catch {
          // fall back to listing row
        }
      }
      const transcript = extractText(full);
      const durMins = full.recording_start_time && full.recording_end_time
        ? Math.round((new Date(full.recording_end_time) - new Date(full.recording_start_time)) / 60000)
        : null;
      console.log(`  "${full.title}" — transcript ${transcript.length} chars`);
      withTranscripts.push({
        id: full.recording_id || null,
        title: full.title || full.meeting_title || 'Untitled',
        url: full.share_url || full.url || null,
        date: full.scheduled_start_time || full.recording_start_time || full.created_at || null,
        duration_minutes: durMins,
        host: full.recorded_by?.name || full.recorded_by?.email || null,
        transcript,
      });
    }

    // Status per topic
    const combined = withTranscripts.map((m) => m.transcript).join('\n\n');
    const statuses = topics.map((t) => ({
      id: t.id,
      text: t.text,
      status: statusForHits(countHits(combined, t.keywords)),
      hits: countHits(combined, t.keywords),
    }));

    await writeJson(`data/${hub.slug}/status.json`, {
      updated_at: new Date().toISOString(),
      statuses,
    });

    // Recordings list (don't leak transcript into committed file)
    await writeJson(`data/${hub.slug}/recordings.json`, {
      updated_at: new Date().toISOString(),
      recordings: withTranscripts
        .map(({ transcript, ...rest }) => rest)
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)),
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
