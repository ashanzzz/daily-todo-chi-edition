/**
 * Daily Todo - Local Data Server (Zero-Dependency Node.js & PowerShell compatible)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const ROOT = path.resolve(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DATA_PATH = path.join(DATA_DIR, 'daily-todo-data.json');
const SERVER_TOKEN = crypto.randomUUID().replace(/-/g, '');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function addApiHeaders(res) {
  res.setHeader('X-Daily-Todo-Local', 'true');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendText(res, code, msg, isApi = false) {
  if (isApi) addApiHeaders(res);
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

function sendJson(res, code, payload) {
  addApiHeaders(res);
  const json = JSON.stringify(payload, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function isAllowedHost(req) {
  const host = (req.headers.host || '').split(':')[0];
  return host === 'localhost' || host === '127.0.0.1';
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

function writeAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.daily-todo-${crypto.randomUUID().replace(/-/g, '')}.tmp`);
  fs.writeFileSync(tempPath, content, 'utf8');
  try {
    fs.renameSync(tempPath, targetPath);
  } catch {
    fs.copyFileSync(tempPath, targetPath);
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function testSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.tasks) || typeof snapshot.prefs !== 'object' || Array.isArray(snapshot.prefs)) {
    return false;
  }
  if (snapshot.tasks.length > 10000) return false;
  for (const t of snapshot.tasks) {
    if (!t || typeof t !== 'object') return false;
    if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(t.id)) return false;
    if (typeof t.title !== 'string' || t.title.length > 2000) return false;
    if (typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return false;
    if (t.time && (typeof t.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time))) return false;
    if (t.repeat && !['none', 'daily', 'weekdays', 'weekly'].includes(t.repeat)) return false;
    if (typeof t.important !== 'boolean' || typeof t.completed !== 'boolean') return false;
    if (t.notes && typeof t.notes !== 'string') return false;
    if (t.notes && t.notes.length > 20000) return false;
  }
  return true;
}

function readEnvelope() {
  if (!fs.existsSync(DATA_PATH)) return null;
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const val = JSON.parse(raw);
  if (!val.tasks || !val.prefs) throw new Error('Invalid format');
  return {
    schemaVersion: 1,
    revision: Number.isInteger(val.revision) ? val.revision : 0,
    savedAt: val.savedAt || '',
    tasks: val.tasks,
    prefs: val.prefs,
  };
}

function saveDailyBackup(content) {
  const today = new Date().toISOString().slice(0, 10);
  writeAtomic(path.join(BACKUP_DIR, `daily-todo-backup-${today}.json`), content);
}

function clearExpiredBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 89);
  cutoff.setHours(0, 0, 0, 0);

  const files = fs.readdirSync(BACKUP_DIR);
  for (const f of files) {
    const m = f.match(/^daily-todo-backup-(\d{4}-\d{2}-\d{2})\.json$/);
    if (m) {
      const fileDate = new Date(m[1] + 'T00:00:00Z');
      if (fileDate < cutoff) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
      }
    }
  }
}

const server = http.createServer((req, res) => {
  if (!isAllowedHost(req)) {
    return sendText(res, 403, 'Forbidden', true);
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // API Endpoints
  if (pathname === '/api/config') {
    return sendJson(res, 200, {
      token: SERVER_TOKEN,
      dataPath: 'data/daily-todo-data.json',
      retentionDays: 90,
    });
  }

  if (pathname === '/api/data') {
    if (req.method === 'GET') {
      if (!fs.existsSync(DATA_PATH)) {
        return sendText(res, 404, 'No local data file yet.', true);
      }
      try {
        const env = readEnvelope();
        const today = new Date().toISOString().slice(0, 10);
        const snapPath = path.join(BACKUP_DIR, `daily-todo-backup-${today}.json`);
        let snapshotSaved = false;
        if (fs.existsSync(snapPath)) {
          try {
            const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
            snapshotSaved = String(snap.revision) === String(env.revision);
          } catch {}
        }
        env.snapshotSaved = snapshotSaved;
        return sendJson(res, 200, env);
      } catch {
        return sendText(res, 500, 'The local data file could not be read.', true);
      }
    }

    if (req.method === 'POST') {
      if (!isAllowedOrigin(req)) return sendText(res, 403, 'Invalid origin.', true);
      const ct = req.headers['content-type'] || '';
      if (!ct.toLowerCase().startsWith('application/json')) {
        return sendText(res, 415, 'Content-Type must be application/json.', true);
      }
      if (req.headers['x-daily-todo-token'] !== SERVER_TOKEN) {
        return sendText(res, 403, 'Invalid token.', true);
      }

      let body = '';
      let receivedBytes = 0;
      req.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_BYTES) {
          req.destroy();
          return sendText(res, 413, 'Payload too large.', true);
        }
        body += chunk;
      });

      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (typeof payload.baseRevision !== 'number' || !testSnapshot(payload.snapshot)) {
            return sendText(res, 400, 'Invalid data payload.', true);
          }

          const current = readEnvelope();
          const currentRev = current ? current.revision : 0;
          if (payload.baseRevision !== currentRev) {
            return sendJson(res, 409, { conflict: true, current });
          }

          const newRev = currentRev + 1;
          const envelope = {
            schemaVersion: 1,
            revision: newRev,
            savedAt: new Date().toISOString(),
            tasks: payload.snapshot.tasks,
            prefs: payload.snapshot.prefs,
          };
          const json = JSON.stringify(envelope, null, 2);
          writeAtomic(DATA_PATH, json);

          let snapshotSaved = false;
          let retentionCleaned = false;
          try { saveDailyBackup(json); snapshotSaved = true; } catch {}
          try { clearExpiredBackups(); retentionCleaned = true; } catch {}

          return sendJson(res, 200, {
            activeSaved: true,
            snapshotSaved,
            retentionCleaned,
            revision: newRev,
          });
        } catch {
          return sendText(res, 400, 'Unable to save local data.', true);
        }
      });
      return;
    }

    return sendText(res, 405, 'Method not allowed.', true);
  }

  // Static File Serving
  if (req.method !== 'GET') {
    return sendText(res, 405, 'Method not allowed.');
  }

  let relPath = decodeURIComponent(pathname.replace(/^\/+/, ''));
  if (!relPath) relPath = 'index.html';

  const candidate = path.resolve(ROOT, relPath);

  // Security: deny access to data directory or outside root
  if (candidate === DATA_DIR || candidate.startsWith(DATA_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }
  if (!candidate.startsWith(ROOT + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return sendText(res, 404, 'Not found');
  }

  const ext = path.extname(candidate).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fs.statSync(candidate).size,
  });
  fs.createReadStream(candidate).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\x1b[32mDaily Todo running at ${url}\x1b[0m`);
  console.log(`\x1b[36mVisible data file: ${DATA_PATH}\x1b[0m`);
  console.log('Keep this terminal open while using the app. Press Ctrl+C to stop.');
});
