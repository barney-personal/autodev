import * as fs from 'fs';
export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function statusFromLog(logPath: string): 'done' | 'failed' | null {
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'result') return ev.is_error ? 'failed' : 'done';
        if (ev.type === 'turn.completed') return 'done';
        if (ev.type === 'turn.failed') return 'failed';
      } catch { /* skip */ }
    }
  } catch { /* log file may not exist */ }
  return null;
}
export function killProcess(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  try { process.kill(pid, 'SIGTERM'); } catch {}
}
