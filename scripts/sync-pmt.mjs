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
 * Upfront validation of every required secret. Client Credentials Flow only
 * needs the app's Consumer Key/Secret — no user password or security token.
 */
function validateSecrets() {
  const required = ['SF_CLIENT_ID', 'SF_CLIENT_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('MISSING GITHUB SECRETS');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`The following ${missing.length} secret(s) are not set on the repo:`);
    missing.forEach((k) => console.error(`  · ${k}`));
    console.error('');
    console.error('Fix: https://github.com/kometsalesimplementations/koronet-hubs/settings/secrets/actions');
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
    const desc2 = (desc || '').toLowerCase();
    if (desc2.includes('not supported on this domain')) {
      lines.push('CAUSE: You are calling the generic login.salesforce.com endpoint.');
      lines.push('Client Credentials Flow must be called against the org\'s My Domain URL.');
      lines.push('');
      lines.push('FIX: Set the SF_LOGIN_URL secret to your My Domain URL.');
      lines.push('     For Koronet this is:  https://kometsales.my.salesforce.com');
      lines.push('     Or confirm by: Salesforce Setup → My Domain → see "Current My Domain URL"');
    } else {
      lines.push('LIKELY CAUSES for Client Credentials Flow (try in this order):');
      lines.push('');
      lines.push('1. Client Credentials Flow not enabled on the External Client App.');
      lines.push('   → Setup → App Manager → "Koronet Hubs Automation" → Settings →');
      lines.push('   → Flow Enablement → check "Enable Client Credentials Flow" → Save');
      lines.push('');
      lines.push('2. Run As user not configured or inactive.');
      lines.push('   → Policies → Edit → Enable Client Credentials Flow →');
      lines.push('   → Run As (Username): valentina.espinel@koronet.com');
      lines.push('');
      lines.push('3. IP Relaxation is still "Enforce IP restrictions".');
      lines.push('   → Policies → Edit → IP Relaxation: "Relax IP restrictions"');
      lines.push('');
      lines.push('4. App was just created or policies saved recently (< 10 min).');
      lines.push('   → Wait 10 minutes for Salesforce to propagate and retry.');
    }
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
  // Client Credentials Flow requires the org's My Domain URL, NOT login.salesforce.com.
  // Default to Koronet's My Domain. Override via SF_LOGIN_URL secret if needed.
  const loginUrl = process.env.SF_LOGIN_URL || 'https://kometsales.my.salesforce.com';
  console.log(`attempting Client Credentials OAuth @ ${loginUrl}/services/oauth2/token ...`);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: requireEnv('SF_CLIENT_ID'),
    client_secret: requireEnv('SF_CLIENT_SECRET'),
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
