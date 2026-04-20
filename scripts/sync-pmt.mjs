#!/usr/bin/env node
/**
 * Koronet Hubs — Salesforce PMT sync
 *
 * Pulls inov8__PMT_Project__c records for each hub configured in /config/hubs.json
 * and writes /data/{slug}/pmt.json so the hub HTML can fetch it and render phases.
 *
 * Credentials are read from env (GitHub Secrets):
 *   SF_LOGIN_URL         (default: https://login.salesforce.com)
 *   SF_CLIENT_ID         (Consumer Key of Connected App "Koronet Hub")
 *   SF_CLIENT_SECRET     (Consumer Secret)
 *   SF_USERNAME
 *   SF_PASSWORD
 *   SF_SECURITY_TOKEN    (appended to password in username-password flow)
 *
 * Auth: OAuth 2.0 Username-Password flow. Works for server-to-server use
 * provided the Connected App has password flow enabled and IP restrictions allow it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const API_VERSION = 'v60.0';

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

async function authenticate() {
  const loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: requireEnv('SF_CLIENT_ID'),
    client_secret: requireEnv('SF_CLIENT_SECRET'),
    username: requireEnv('SF_USERNAME'),
    password: requireEnv('SF_PASSWORD') + requireEnv('SF_SECURITY_TOKEN'),
  });
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth failed ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  console.log(`auth ok · instance ${json.instance_url}`);
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}

async function getRecord({ accessToken, instanceUrl }, pmtId) {
  const url = `${instanceUrl}/services/data/${API_VERSION}/sobjects/inov8__PMT_Project__c/${pmtId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * Normalize raw PMT record into a stable shape that the hub can consume.
 * Keeps `raw` untouched for debugging, plus a curated `phases` / `targets` section.
 * Field names come from describe() of inov8__PMT_Project__c in the Koronet org.
 * If a field is missing we leave it null rather than inventing a value.
 */
function normalize(raw) {
  const pct = (v) => (typeof v === 'number' ? Math.round(v) : null);
  return {
    fetched_at: new Date().toISOString(),
    id: raw.Id,
    name: raw.Name,
    phases: [
      { key: 'sales_handover', label: 'Sales Handover', pct: pct(raw.inov8__Sales_Handover_Progress__c) },
      { key: 'account_config', label: 'Account Configuration', pct: pct(raw.inov8__Account_Configuration_Progress__c) },
      { key: 'kickoff', label: 'Kickoff', pct: pct(raw.inov8__Kickoff_Progress__c) },
      { key: 'training', label: 'Training', pct: pct(raw.inov8__Training_Progress__c) },
      { key: 'pre_go_live', label: 'Pre Go Live', pct: pct(raw.inov8__Pre_Go_Live_Progress__c) },
      { key: 'post_go_live', label: 'Post Go Live', pct: pct(raw.inov8__Post_Go_Live_Progress__c) },
    ],
    targets: {
      go_live_date: raw.inov8__Target_Go_Live_Date__c || raw.inov8__Go_Live_Date__c || null,
      status: raw.inov8__Status__c || null,
    },
    team: {
      implementer: raw.inov8__Implementer__c || raw.inov8__Implementation_Consultant__c || null,
      sales_rep: raw.inov8__Sales_Rep__c || raw.OwnerId || null,
    },
    raw,
  };
}

async function main() {
  const { hubs } = await readJson('config/hubs.json');
  const auth = await authenticate();

  for (const hub of hubs) {
    try {
      console.log(`--- ${hub.slug} (${hub.pmt_id}) ---`);
      const raw = await getRecord(auth, hub.pmt_id);
      const normalized = normalize(raw);
      await writeJson(`data/${hub.slug}/pmt.json`, normalized);
    } catch (err) {
      console.error(`ERROR syncing ${hub.slug}: ${err.message}`);
      // Do not throw — keep going so one bad record doesn't break the whole run.
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
