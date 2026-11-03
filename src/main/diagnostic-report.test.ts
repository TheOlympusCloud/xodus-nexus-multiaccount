import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoSnapshot } from '../shared/demo-data.js';
import { createDiagnosticReport, redactDiagnosticText, reportSystemInfo, REPORT_LIMIT, saveDiagnosticReport } from './diagnostic-report.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-report-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const backendLog = async () => ({ name: 'backend.log', content: 'operation=library status=401 code=1', truncated: false });
const base = () => ({ snapshot: demoSnapshot(), launcherVersion: '0.3.10', systemInfo: 'Test system', backendLog, logsRoot: root });

describe('reviewable diagnostic reports', () => {
  it('keeps useful error codes but removes sensitive records, URLs, names, keys and paths', () => {
    const report = redactDiagnosticText([
      'HTTP 401 CONTENT_NOT_ENTITLED status=200',
      'Authorization: Bearer shortsecret', 'Cookie: session=secretcookie', 'refresh_token=private-refresh',
      'user_hash=12345', 'accountId=private-id', 'xuid: 1234567891234567',
      '{"username":"secret-user","displayName":"real-name"}',
      '\x1b[31mAuthori\x1b[0mzation: hidden-auth',
      'https://example.test/package?unfamiliar=secret-signature', 'https://example.test/?email_token=secret-notification',
      'contact person@example.com', 'abcdefghijk.abcdefghijklmnop.abcdefghijk',
      'abcdefghijk..abcdefghijkl.abcdefghijkl.abcdefghijk', 'x'.repeat(120),
      '/home/secret-user/Games/Forza5/pfx', 'C:\\users\\WindowsName\\AppData', '/run/user/1000/session',
      'Cool Gamer used /custom/private-home', '-----BEGIN RSA PRIVATE KEY-----\nprivate-key\n-----END RSA PRIVATE KEY-----',
    ].join('\n'), ['Cool Gamer', '/custom/private-home']);
    for (const secret of ['shortsecret', 'secretcookie', 'private-refresh', '12345', 'private-id', 'real-name', 'hidden-auth', 'secret-signature', 'secret-notification', 'person@example.com', 'abcdefghijk', 'secret-user', 'WindowsName', '/1000/', 'Cool Gamer', 'private-home', 'private-key', 'x'.repeat(100)]) expect(report).not.toContain(secret);
    expect(report).toContain('HTTP 401 CONTENT_NOT_ENTITLED status=200');
    expect(report).toContain('/home/[user]/Games/Forza5/pfx');
  });

  it('includes exact versions, safe backend failures and only the newest five download logs', async () => {
    const input = base();
    input.snapshot.backend.available = false;
    input.snapshot.backend.version = '0.2.10'; input.snapshot.runtime.name = 'runtime-test';
    input.snapshot.downloads = Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: `Title ${i}`, productId: `Product${i}`, destination: '/secret/game', status: 'failed' as const, progress: null, phase: 'Downloading', log: [`line ${i}`, 'access_token=private-download'], startedAt: 'today', error: 'HTTP 503', exitCode: 1 }));
    const { content, name } = await createDiagnosticReport(input);
    expect(name).toMatch(/^nexus-diagnostics-.*\.txt$/);
    for (const value of ['Launcher: 0.3.10', 'Backend: 0.2.10; available: false', 'Runtime: runtime-test', 'status=401', 'Error: HTTP 503', 'Title 0', 'Title 4', '[No game selected]']) expect(content).toContain(value);
    expect(content).not.toContain('Title 5'); expect(content).not.toContain('private-download'); expect(content).not.toContain('/secret/game');
    expect(content).not.toContain(input.snapshot.auth.username);
  });

  it('redacts the separate Xbox player account as well as the Store account', async () => {
    const input = base();
    input.snapshot.auth.player = 'partner-handle';
    input.snapshot.downloads = [{ ...input.snapshot.downloads[0], title: 'Queued for partner-handle', status: 'failed' as const }];
    const { content } = await createDiagnosticReport(input);
    expect(content).not.toContain('partner-handle');
  });

  it('reports missing backend and logs honestly without requiring a running backend', async () => {
    const input = base(); input.snapshot.games = [{ ...input.snapshot.games[0], id: '0123456789abcdef' }];
    const { content } = await createDiagnosticReport({ ...input, gameId: '0123456789abcdef', backendLog: async () => { throw Error('/secret/backend'); } });
    expect(content.match(/Log missing/g)).toHaveLength(3);
    expect(content).not.toContain('/secret/backend');
  });

  it('reads only selected launcher log snapshots, never game/prefix contents', async () => {
    const input = base(), id = '0123456789abcdef';
    input.snapshot.games = [{ ...input.snapshot.games[0], id, path: path.join(root, 'original-game') }];
    await fs.mkdir(path.join(root, 'original-game')); await fs.writeFile(path.join(root, 'original-game', 'secret'), 'do-not-read');
    await fs.writeFile(path.join(root, `${id}-latest.log`), 'game failure 0xc0000005\nhttps://test/?sig=private\n');
    await fs.writeFile(path.join(root, `${id}-vc-runtime.log`), 'VC exit 0');
    const before = await fs.stat(path.join(root, `${id}-latest.log`));
    const { content } = await createDiagnosticReport({ ...input, gameId: id });
    expect(content).toContain('game failure 0xc0000005'); expect(content).toContain('VC exit 0');
    expect(content).not.toContain('do-not-read'); expect(content).not.toContain('?sig=private');
    const after = await fs.stat(path.join(root, `${id}-latest.log`));
    expect(after.mtimeMs).toBe(before.mtimeMs); expect(after.size).toBe(before.size);
  });

  it.each(['symlink', 'hardlink', 'directory'])('refuses a %s in place of a game log', async kind => {
    const input = base(), id = '0123456789abcdef'; input.snapshot.games = [{ ...input.snapshot.games[0], id }];
    const target = path.join(root, `${id}-latest.log`), secret = path.join(root, 'not-a-log');
    await fs.writeFile(secret, 'private-file-contents');
    if (kind === 'symlink') await fs.symlink(secret, target);
    if (kind === 'hardlink') await fs.link(secret, target);
    if (kind === 'directory') await fs.mkdir(target);
    const { content } = await createDiagnosticReport({ ...input, gameId: id });
    expect(content).not.toContain('private-file-contents'); expect(content).toContain('unavailable for safe reading');
  });

  it('bounds huge logs and marks truncation instead of presenting a tail as a complete file', async () => {
    const input = base(), id = '0123456789abcdef'; input.snapshot.games = [{ ...input.snapshot.games[0], id }];
    await fs.writeFile(path.join(root, `${id}-latest.log`), 'old header\n' + 'log line\n'.repeat(200_000) + 'last failure 70\n');
    const { content } = await createDiagnosticReport({ ...input, gameId: id });
    expect(content).toContain('[TRUNCATED'); expect(content).toContain('last failure 70');
    expect(content).not.toContain('old header'); expect(Buffer.byteLength(content)).toBeLessThan(2 * 1024 * 1024);
  });

  it('bounds in-memory backend output and redacts long opaque lines without unbounded work', async () => {
    const { content } = await createDiagnosticReport({ ...base(), backendLog: async () => ({ name: 'backend.log', truncated: false, content: 'old header\n' + 'x'.repeat(2 * 1024 * 1024) + '\nHTTP 503\n' }) });
    expect(content).toContain('[TRUNCATED'); expect(content).toContain('HTTP 503');
    expect(content).not.toContain('old header'); expect(content).not.toContain('x'.repeat(100));
  });

  it('rejects path traversal or games not in the library', async () => {
    await expect(createDiagnosticReport({ ...base(), gameId: '../private' })).rejects.toThrow('Game not found');
    const input = base(); input.snapshot.games = [{ ...input.snapshot.games[0], id: '../private' }];
    await expect(createDiagnosticReport({ ...input, gameId: '../private' })).rejects.toThrow('Game not found');
  });

  it('saves only reviewed text to a new private file, never overwrites or follows links', async () => {
    const file = path.join(root, 'report.txt');
    await saveDiagnosticReport(file, 'edited report');
    expect(await fs.readFile(file, 'utf8')).toBe('edited report'); expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(saveDiagnosticReport(file, 'replaced')).rejects.toThrow();
    await fs.symlink(file, path.join(root, 'link.txt'));
    await expect(saveDiagnosticReport(path.join(root, 'link.txt'), 'replaced')).rejects.toThrow();
    for (const value of ['', '\0bad', 'x'.repeat(REPORT_LIMIT + 1), { content: 'bad' }]) await expect(saveDiagnosticReport(path.join(root, 'new.txt'), value)).rejects.toThrow('Invalid');
    await expect(saveDiagnosticReport(path.join(root, 'report.html'), 'bad')).rejects.toThrow('.txt');
    expect(await fs.readFile(file, 'utf8')).toBe('edited report');
  });

  it('collects only allowlisted OS, session and GPU fields', async () => {
    const release = path.join(root, 'os-release'), drm = path.join(root, 'drm');
    await fs.writeFile(release, 'PRETTY_NAME="Test Linux"\nID=test\nVERSION_ID=42\nPRIVATE_SECRET=not-public\n');
    const device = path.join(drm, 'card0', 'device'); await fs.mkdir(device, { recursive: true });
    await fs.writeFile(path.join(device, 'vendor'), '0x1002\n'); await fs.writeFile(path.join(device, 'device'), '0x1234\n');
    await fs.writeFile(path.join(device, 'serial'), 'serial-not-public'); await fs.symlink('/drivers/amdgpu', path.join(device, 'driver'));
    const content = await reportSystemInfo({ XDG_CURRENT_DESKTOP: 'gamescope:KDE:private-session', XDG_SESSION_TYPE: 'wayland', SteamGameId: 'private-steam-id', SECRET: 'env-not-public' }, { osRelease: release, drm });
    for (const value of ['PRETTY_NAME: Test Linux', 'Desktop: gamescope:kde', 'Session: wayland', 'Steam launch: true', '0x1002:0x1234, driver amdgpu', 'CPU:', 'RAM:']) expect(content).toContain(value);
    for (const value of ['not-public', 'private-session', 'private-steam-id', 'SECRET']) expect(content).not.toContain(value);
  });
});
