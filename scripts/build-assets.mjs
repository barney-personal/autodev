import { copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
copyFileSync('src/server/db/schema.sql', 'dist/server/db/schema.sql');
let revision = 'unknown';
try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* source archive */ }
writeFileSync('dist/build-info.json', JSON.stringify({ revision, builtAt: new Date().toISOString() }) + '\n');
