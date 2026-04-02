import { execFileSync } from 'child_process';

const NICE_BIN = process.env.NICE_BIN ?? 'nice';

let _niceAvailable: boolean | null = null;

export function isNiceAvailable(): boolean {
  if (_niceAvailable != null) return _niceAvailable;
  try {
    execFileSync('/bin/sh', ['-lc', `command -v ${JSON.stringify(NICE_BIN)} >/dev/null 2>&1`], {
      stdio: 'pipe',
      timeout: 3000,
    });
    _niceAvailable = true;
  } catch {
    _niceAvailable = false;
  }
  return _niceAvailable;
}

export function buildNiceSpawn(binary: string, args: string[]): { command: string; args: string[] } {
  if (!isNiceAvailable()) {
    return { command: binary, args };
  }
  return { command: NICE_BIN, args: ['-n', '10', binary, ...args] };
}

export function wrapExecLineWithNice(execLine: string): string {
  if (!isNiceAvailable()) return execLine;
  return execLine.startsWith('exec ')
    ? `exec ${JSON.stringify(NICE_BIN)} -n 10 ${execLine.slice(5)}`
    : `${JSON.stringify(NICE_BIN)} -n 10 ${execLine}`;
}

export function _resetForTest(): void {
  _niceAvailable = null;
}
