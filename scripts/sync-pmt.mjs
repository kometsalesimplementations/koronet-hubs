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

/**
 * Upfront validation of every required secret. Prints a consolidated list of
 * what's missing so a single run tells you everything you need to fix.
 */
function validateSecrets() {
  const required = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_USERNAME', 'SF_PASSWORD', 'SF_SECURITY_TOKEN'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('MISSING GITHUB SECRETS');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`The following ${missing.length} secret(s) are not set on the repo:`);
    missing.forEach((k) => console.error(`  · ${k}`));
    console.error('');
    console.error('Fix: https://github.com/kometsalesimplementations/koronet-hubs/settings/secrets/actions');
    console.error('Click "New repository secret" for each missing name above.');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(1);
  }
  const report = required.map((k) => `  ${k}: set (${process.env[k].length} chars)`).join('\n');
  console.log('secrets present:\n' + report);
}

/**
 * Translate common Salesforce OAuth errors into actionable instructions.
 */
function explainOAuthError(status, bodyText) {
  let parsed = {};
  try { parsed = JSON.parse(bodyText); } catch { /* ignore */ }
  const code = parsed.error || '';
  const desc = parsed.error_description || bodyText;
  const lines = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `SALESFORCE OAUTH FAILED — HTTP ${status}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `error: ${code}`,
    `detail: ${desc}`,
    '',
  ];
  if (code === 'invalid_grant') {
    lines.push('LIKELY CAUSES (try in this order):');
    lines.push('');
    lines.push('1. Security token is stale. It regenerates every time the password changes.');
    lines.push('   → Salesforce → Settings → My Personal Information → Reset My Security Token');
    lines.push('   → Check email for the new token, update secret SF_SECURITY_TOKEN.');
    lines.push('');
    lines.push('2. Password is wrong in the secret.');
    lines.push('   → Try logging in at https://login.salesforce.com with SF_USERNAME + SF_PASSWORD to verify.');
    lines.push('');
    lines.push('3. Connected App restricts IPs and GitHub Actions runner IP is blocked.');
    lines.push('   → Salesforce Setup → App Manager → "Koronet Hub" → Manage → Edit Policies');
    lines.push('   → IP Relaxation: "Relax IP restrictions"');
    lines.push('   → Permitted Users: "All users may self-authorize"');
    lines.push('');
    lines.push('4. User profile does not have "API Enabled" permission.');
    lines.push('   → Ask your Salesforce admin to enable API access for SF_USERNAME.');
  } else if (code === 'invalid_client_id' || code === 'invalid_client') {
    lines.push('The Consumer Key or Secret in SF_CLIENT_ID / SF_CLIENT_SECRET does not match the Connected App.');
    lines.push('→ Salesforce Setup → App Manager → "Koronet Hub" → View → copy the consumer key/secret again.');
  } else if (code === 'inactive_user') {
    lines.push('The user SF_USERNAME is inactive or locked out.');
  } else if (code === 'unsupported_grant_type') {
    lines.push('The Connected App has username-password flow disabled.');
    lines.push('→ Salesforce Setup → App Manager → "Koronet Hub" → Edit → OAuth Policies → enable "Username-Password Flow" (OAuth and OpenID Connect Settings).');
  } else {
    lines.push('Check the error description above. If unclear, open a Salesforce case with the error code.');
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  return lines.join('\n');
}

async function authenticate() {
  const loginUrl = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
  console.log(`attempting OAuth @ ${loginUrl}/services/oauth2/token ...`);
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
    const errText = await res.text();
    console.error(explainOAuthError(res.status, errText));
    throw new Error(`OAuth failed ${res.status}`);
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
  validateSecrets();
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
