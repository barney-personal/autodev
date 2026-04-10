export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export function execErrMsg(err: unknown): string {
  if (err != null && typeof err === 'object') {
    const e = err as { stderr?: Buffer | string; message?: string };
    if (e.stderr != null) {
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr.toString();
      if (stderr.length > 0) return stderr;
    }
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}
