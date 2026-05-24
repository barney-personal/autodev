import * as fs from 'fs';

/**
 * Tails a NDJSON log file by byte offset.
 * Emits complete lines via onLine(raw, seq) as they arrive.
 * The caller owns child process lifecycle — this class only reads the file.
 */
export class AgentLogTailer {
  private filePos = 0;
  private lineBuf = '';
  private skipped = 0;
  private seq: number;
  private watcher?: fs.FSWatcher;
  private interval: NodeJS.Timeout;
  private stopped = false;

  /**
   * @param logPath   Absolute path to the NDJSON log file.
   * @param skipLines Number of lines already stored from a previous session (reattach).
   * @param onLine    Called for each new, non-skipped line with (rawLine, seqNumber).
   * @param isReady   Guard called before reading; if false the read is deferred to next tick.
   *                  Defaults to always-ready. Pass `isDbInitialized` from database.ts.
   */
  constructor(
    private logPath: string,
    private skipLines: number,
    private onLine: (raw: string, seq: number) => void,
    private isReady: () => boolean = () => true,
  ) {
    this.seq = skipLines;
    this.readAndFlush();

    try {
      let debounce: NodeJS.Timeout | null = null;
      this.watcher = fs.watch(logPath, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => this.readAndFlush(), 50);
      });
    } catch { /* log file may not exist yet; the interval will catch up */ }

    this.interval = setInterval(() => this.readAndFlush(), 2000);
  }

  /** Read any new content from the log file and emit complete lines. */
  readAndFlush(): void {
    if (this.stopped) return;
    if (!this.isReady()) return;

    let size: number;
    try {
      size = fs.statSync(this.logPath).size;
    } catch {
      return; // file not created yet
    }
    if (size <= this.filePos) return;

    let buf: Buffer;
    let bytesRead: number;
    try {
      buf = Buffer.alloc(size - this.filePos);
      const fd = fs.openSync(this.logPath, 'r');
      try {
        bytesRead = fs.readSync(fd, buf, 0, buf.length, this.filePos);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    this.filePos += bytesRead;

    this.lineBuf += buf.toString('utf8');
    const parts = this.lineBuf.split('\n');
    this.lineBuf = parts.pop() ?? '';

    for (const line of parts) {
      if (!line.trim()) continue;
      if (this.skipped < this.skipLines) {
        this.skipped++;
        continue;
      }
      this.onLine(line, this.seq++);
    }
  }

  /** Stop the watcher and polling interval. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher?.close();
    clearInterval(this.interval);
  }
}
