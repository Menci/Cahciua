import * as fs from 'node:fs';
import * as path from 'node:path';

const SESSION_DIR = 'data';
const SESSION_FILE = path.join(SESSION_DIR, 'session');

export function loadSession(envValue: string): string {
  if (envValue) {
    return envValue;
  }

  try {
    return fs.readFileSync(SESSION_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function saveSession(sessionString: string): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, sessionString, 'utf-8');
}
