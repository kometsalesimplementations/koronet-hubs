#!/usr/bin/env node
/**
 * Koronet Hubs — Salesforce PMT sync (Salesforce CLI edition)
 *
 * Queries the Inov8 PMT project + its child phases and writes a normalized
 * JSON per hub for the static hub pages to fetch.
 *
 * Credentials: SF_AUTH_URL (sfdxAuthUrl value from `sf org display --json`).
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commitAndPush } from './commit-helper.mjs';

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
    console.error('Get it locally with:');
    console.error('  sf org login web');
    console.error('  sf org display --target-org <username> --verbose --json');
    console.error('Copy the "sfdxAuthUrl" value (starts with "force://...").');
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
    if (parsed.status !== 0) throw new Error(`sf login failed: ${parsed.message || out}`);
    console.log(`sf CLI authenticated · org alias "${ORG_ALIAS}"`);
  } finally {
    try { await fs.unlink(tmpFile); } catch { /* ignore */ }
  }
}

function runSoql(soql) {
  try {
    const out = execSync(
      `sf data query --query "${soql.replace(/"/g, '\\"')}" --target-org ${ORG_ALIAS} --json`,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    );
    const parsed = JSON.parse(out);
    if (parsed.status !== 0) throw new Error(`sf query failed: ${parsed.message || out}`);
    return parsed.result;
  } catch (err) {
    // Capture CLI stderr which often contains the real Salesforce error.
    const msg = err.stdout?.toString() || err.stderr?.toString() || err.message;
    throw new Error(msg);
  }
}

/**
 * Try a list of child-object names (Inov8 PMT has rebranded over versions).
 * Returns the first one that responds, or null if none exist.
 */
function findPhaseObject(projectId) {
  const candidates = [
    'inov8__Project_Phase__c',
    'inov8__Phase__c',
    'inov8__PMT_Project_Phase__c',
    'inov8__PMT_Phase__c',
  ];
  for (const obj of candidates) {
    try {
      const result = runSoql(
        `SELECT FIELDS(ALL) FROM ${obj} WHERE inov8__Project__c = '${projectId}' LIMIT 200`
      );
      if (result?.records) {
        console.log(`  phase object found: ${obj} (${result.records.length} phases)`);
        return { obj, records: result.records };
      }
    } catch (err) {
      // Try next candidate. Typical error = object doesn't exist or no permission.
    }
  }
  console.warn('  no phase child object matched — phases will be empty');
  return { obj: null, records: [] };
}

/**
 * Normalize raw PMT record. Field names below match what actually exists in
 * the Koronet org (discovered from live data on 2026-04-20).
 */
function normalize(raw, phases) {
  if (!raw) return null;
  return {
    fetched_at: new Date().toISOString(),
    id: raw.Id,
    name: raw.Name,
    overall: {
      completion_pct: raw.inov8__Percentage_Completion__c ?? null,
      status: raw.inov8__Project_Status__c ?? null,
      health: raw.inov8__Project_Health__c ?? null,
      level_of_effort: raw.inov8__Level_of_Effort__c ?? null,
      health_comment: raw.inov8__Health_Comment__c ?? null,
    },
    dates: {
      start: raw.inov8__Start_Date_Rollup__c ?? null,
      kickoff: raw.Kickoff_Date__c ?? raw.inov8__Kickoff_formula__c ?? null,
      deadline: raw.inov8__Deadline__c ?? null,
      estimated_go_live: raw.Estimated_Go_Live_Date__c ?? null,
      days_to_go_live: raw.Days_to_Estimated_Go_Live__c ?? raw.inov8__Days_to_go__c ?? null,
    },
    team: {
      project_lead: raw.inov8__Project_Lead__c ?? null,
      project_owner: raw.inov8__Project_Owner__c ?? null,
    },
    phases: (phases || []).map((p) => ({
      id: p.Id,
      name: p.Name,
      // Use Koronet's custom override first, fallback to PMT standard.
      completion_pct:
        p.Phase_Completion_Custom__c ??
        p.inov8__Phase_Completion__c ??
        p.inov8__Percentage_Completion_without_child__c ??
        null,
      health: p.inov8__Phase_Health__c ?? null,
      start_date: p.inov8__Start_Date_Rollup__c ?? p.inov8__Kickoff_formula__c ?? null,
      end_date: p.inov8__End_Date_Rollup__c ?? p.inov8__Deadline_formula__c ?? null,
      days_to_go: p.inov8__Days_to_go__c ?? null,
      task_count: p.inov8__Task_Count__c ?? null,
      daily_progress: p.inov8__Daily_progress__c ?? null,
      raw: p,
    })),
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
      if (!hub.pmt_id) {
        console.warn(`  skipping ${hub.slug}: no pmt_id configured`);
        continue;
      }
      const projectResult = runSoql(
        `SELECT FIELDS(ALL) FROM inov8__PMT_Project__c WHERE Id = '${hub.pmt_id}' LIMIT 200`
      );
      const project = projectResult?.records?.[0];
      if (!project) {
        console.warn(`  no PMT record for Id=${hub.pmt_id}`);
        continue;
      }
      const { records: phases } = findPhaseObject(hub.pmt_id);
      const normalized = normalize(project, phases);
      await writeJson(`data/${hub.slug}/pmt.json`, normalized);
    } catch (err) {
      console.error(`ERROR syncing ${hub.slug}: ${err.message}`);
    }
  }
}

main()
  .then(() => commitAndPush('chore(pmt): sync from Salesforce'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
