#!/usr/bin/env node
/**
 * Koronet Hubs — Salesforce PMT sync (Salesforce CLI edition)
 *
 * Uses `sf` (Salesforce CLI) to authenticate and query PMT records.
 * This sidesteps REST API permission issues that blocked the Connected App path.
 *
 * Credentials (GitHub Secrets):
 *   SF_AUTH_URL   — the `sfdxAuthUrl` Valentina pulled locally via:
 *                   sf org login web
 *                   sf org display --target-org <user> --verbose --json
 *                   → copy the "sfdxAuthUrl": "force://..." value.
 *
 * Flow:
 *   1. Write SF_AUTH_URL to a temp file.
 *   2. `sf org login sfdx-url --sfdx-url-file <tmp>` — authenticates the CLI.
 *   3. `sf data query --query "SELECT ... FROM inov8__PMT_Project__c WHERE Id='...'" --json`
 *      per hub, parse the result, write data/{slug}/pmt.json.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ORG_ALIAS = 'koronet-hub-sync';

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
  if (!process.env.SF_AUTH_URL) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('MISSING GITHUB SECRET: SF_AUTH_URL');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('Get it locally (once) with:');
    console.error('  sf org login web');
    console.error('  sf org list  (note your username)');
    console.error('  sf org display --target-org <username> --verbose --json');
    console.error('Then copy the "sfdxAuthUrl" value (starts with "force://...").');
    console.error('Add it at:');
    console.error('  https://github.com/kometsalesimplementations/koronet-hubs/settings/secrets/actions');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(1);
  }
  console.log(`SF_AUTH_URL: set (${process.env.SF_AUTH_URL.length} chars)`);
}

async function authenticateCli() {
  const tmpFile = path.join(os.tmpdir(), `sfdx-auth-${Date.now()}.txt`);
  await fs.writeFile(tmpFile, requireEnv('SF_AUTH_URL').trim() + '\n', 'utf8');
  try {
    const out = execSync(
      `sf org login sfdx-url --sfdx-url-file "${tmpFile}" --alias ${ORG_ALIAS} --set-default --json`,
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(out);
    if (parsed.status !== 0) {
      throw new Error(`sf login failed: ${parsed.message || out}`);
    }
    console.log(`sf CLI authenticated · org alias "${ORG_ALIAS}"`);
  } finally {
    // Always remove the temp file with the auth URL.
    try { await fs.unlink(tmpFile); } catch { /* ignore */ }
  }
}

function runSoqlQuery(soql) {
  const out = execSync(
    `sf data query --query "${soql.replace(/"/g, '\\"')}" --target-org ${ORG_ALIAS} --json`,
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(out);
  if (parsed.status !== 0) {
    throw new Error(`sf query failed: ${parsed.message || out}`);
  }
  return parsed.result;
}

/**
 * Normalize raw PMT record into the shape the hub consumes.
 * Field names are assumed — if a field doesn't exist in the org, it comes back
 * missing and we leave it null. The `raw` block is kept for debugging and for
 * discovering the real field names on the first run.
 */
function normalize(raw) {
  if (!raw) return null;
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
  await authenticateCli();

  const { hubs } = await readJson('config/hubs.json');

  for (const hub of hubs) {
    try {
      console.log(`--- ${hub.slug} (${hub.pmt_id}) ---`);
      // Use FIELDS(ALL) to grab every standard and custom field at once.
      // LIMIT 200 is required when using FIELDS(ALL).
      const soql = `SELECT FIELDS(ALL) FROM inov8__PMT_Project__c WHERE Id = '${hub.pmt_id}' LIMIT 200`;
      const result = runSoqlQuery(soql);
      const record = result?.records?.[0];
      if (!record) {
        console.warn(`  no PMT record returned for Id=${hub.pmt_id}`);
        continue;
      }
      const normalized = normalize(record);
      await writeJson(`data/${hub.slug}/pmt.json`, normalized);
    } catch (err) {
      console.error(`ERROR syncing ${hub.slug}: ${err.message}`);
      // Keep going so one bad record does not break the whole run.
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
