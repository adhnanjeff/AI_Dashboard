import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The secret that separates "a person decided" from "something claimed a person decided".
 * Taken from ORCH_DECISION_TOKEN if set, otherwise created once and kept in a file (owner-only where the OS supports it)
 * that the dashboard server reads. Agent processes do not inherit ORCH_* variables.
 *
 * Honest limit: this is a local file. A process running as the same OS user with file access could read it. Agents are
 * only given file tools inside their own workspace and no shell unless a person approved one; for stronger isolation
 * run agents in a container or another OS account.
 */
export function loadDecisionToken(file: string): string {
  const fromEnv = process.env.ORCH_DECISION_TOKEN?.trim(); if (fromEnv) return fromEnv;
  if (existsSync(file)) { const t = readFileSync(file, 'utf8').trim(); if (t.length >= 32) return t; }
  mkdirSync(dirname(file), { recursive: true });
  const t = randomBytes(32).toString('hex'); writeFileSync(file, `${t}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows: ACLs of the profile directory apply */ }
  return t;
}
