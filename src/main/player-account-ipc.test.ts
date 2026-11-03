import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { AccountRefresh, parseAccount } from './account-refresh.js';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const extract = (...names: string[]) => parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)).map(node => node.getText(parsed)).join('\n');
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const stored = (username: string) => ({ code: 0, output: JSON.stringify({ stored: true, username }) });

function authFixture(capabilities: Record<string, boolean> = { externalAuth: true, playerAccount: true }) {
  const start = source.indexOf("  ipcMain.handle('login', async (_event");
  expect(start).toBeGreaterThan(0);
  const routes = source.slice(start, source.indexOf("  ipcMain.handle('offline-permissions', async", start));
  const handlers = new Map<string, Function>();
  const done = () => ({ child: {}, result: Promise.resolve({ code: 0, output: '' }) });
  const transport = vi.fn(done), spawn = vi.fn(done), revokeOffline = vi.fn(async () => {});
  const context: any = {
    ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) },
    initialAuth: { running: false, stored: true, username: 'store@example.test', note: '' },
    backend: { current: { capabilities } }, shutdownStarted: false, mainWindow: undefined, operations: new Map(),
    nativeSocialBeforeAuth: [], resetNativeSocial: vi.fn(), ensureIdle: vi.fn(), requireBackend: () => '/fixture/cli', randomUUID: () => 'fixture',
    accountRefresh: { invalidate: vi.fn() }, accountLibrary: { reset: vi.fn() }, gameActivities: { select: vi.fn() }, gameAchievements: { select: vi.fn() },
    xboxSocial: { close: vi.fn() }, emitSnapshot: vi.fn(), prepareSystemWallet: vi.fn(async () => {}), accountProfile: { select: vi.fn(async () => {}) },
    fallbackAuthViewFactory: () => 'view', authViewFactory: vi.fn(), browserAuthViewFactory: vi.fn(), nativeText: (text: string) => text,
    startAuthTransport: transport, spawnTracked: spawn, emitLog: vi.fn(), revokeOffline, refreshAccount: vi.fn(async () => {}),
  };
  runInNewContext(compile(`let authState = globalThis.initialAuth, authJob;\n${extract('runAuth', 'requestAuth')}\n${routes}`), context);
  return { transport, spawn, revokeOffline, call: (name: string, ...args: unknown[]) => handlers.get(name)!(undefined, ...args) };
}

it('signs a separate Xbox player in and out without touching the Store account or offline data', async () => {
  const f = authFixture();
  await f.call('login', true);
  expect(f.transport).toHaveBeenCalledOnce(); expect(f.transport.mock.calls[0][4]).toBe(true);
  await f.call('logout', true);
  expect(f.spawn.mock.calls[0][1]).toEqual(['logout', '--player']);
  expect(f.revokeOffline).not.toHaveBeenCalled();
});

it('keeps the full Store sign-in and sign-out unchanged', async () => {
  const f = authFixture();
  await f.call('login', false); expect(f.transport.mock.calls[0][4]).toBe(false);
  await f.call('logout');
  expect(f.spawn.mock.calls[0][1]).toEqual(['logout', '--device']);
  expect(f.revokeOffline).toHaveBeenCalledWith('sign-out');
});

it('refuses malformed requests and backends without a player account before spawning anything', async () => {
  const f = authFixture(), old = authFixture({ externalAuth: true });
  await expect(f.call('login', 'true')).rejects.toThrow('Invalid');
  await expect(f.call('logout', 1)).rejects.toThrow('Invalid');
  await expect(old.call('login', true)).rejects.toThrow('Update the Nexus backend');
  await expect(old.call('logout', true)).rejects.toThrow('Update the Nexus backend');
  for (const fixture of [f, old]) { expect(fixture.transport).not.toHaveBeenCalled(); expect(fixture.spawn).not.toHaveBeenCalled(); }
});

function refreshFixture(capabilities: Record<string, boolean>, accounts: Record<'store' | 'player', { code: number; output: string }>) {
  const context: any = {
    initialAuth: { running: false, stored: true, username: 'old-store@example.test', player: 'old-player@example.test', note: '' },
    backend: { current: { available: true, binaryPath: '/fixture/cli', source: 'managed', capabilities: { account: true, library: true, gameActivity: true, achievements: true, profile: true, ...capabilities } } },
    accountRefresh: new AccountRefresh(), parseAccount, structuredClone,
    readAccount: vi.fn(async (_binary: string, _signal: AbortSignal, player = false) => accounts[player ? 'player' : 'store']),
    runtime: { current: { name: 'nexus' } }, currentMarket: () => 'US', emitSnapshot: vi.fn(), xboxSocial: { close: vi.fn() }, resetNativeSocial: vi.fn(),
    accountLibrary: { select: vi.fn() }, gameActivities: { select: vi.fn() }, gameAchievements: { select: vi.fn() }, accountProfile: { select: vi.fn(async () => {}) },
  };
  runInNewContext(compile(`let authState = globalThis.initialAuth;\n${extract('accountRefreshKey', 'refreshAccount', 'xboxAccount')}\nglobalThis.refresh = refreshAccount; globalThis.readAuth = () => authState;`), context);
  return context;
}

it('keeps the library on the Store account and Xbox features on the player account', async () => {
  const f = refreshFixture({ playerAccount: true }, { store: stored('store@example.test'), player: stored('player@example.test') });
  await f.refresh();
  expect(f.readAuth()).toMatchObject({ stored: true, username: 'store@example.test', player: 'player@example.test' });
  expect(f.accountLibrary.select.mock.calls[0][0]).toBe('store@example.test');
  for (const service of [f.gameActivities, f.gameAchievements, f.accountProfile]) expect(service.select.mock.calls[0][0]).toBe('player@example.test');
  expect(f.xboxSocial.close).toHaveBeenCalled();
});

it('uses the Store account everywhere without a player account or capability', async () => {
  for (const [capabilities, player, reads] of [[{ playerAccount: true }, { code: 0, output: '{"stored":false}' }, 2], [{}, stored('ignored@example.test'), 1]] as const) {
    const f = refreshFixture(capabilities, { store: stored('store@example.test'), player });
    await f.refresh();
    expect(f.readAuth().player).toBeUndefined();
    expect(f.readAccount).toHaveBeenCalledTimes(reads);
    for (const service of [f.accountLibrary, f.gameActivities, f.gameAchievements, f.accountProfile]) expect(service.select.mock.calls[0][0]).toBe('store@example.test');
  }
});

it('reports an unreadable player record instead of guessing which account Xbox features use', async () => {
  const f = refreshFixture({ playerAccount: true }, { store: stored('store@example.test'), player: { code: 1, output: '' } });
  await f.refresh();
  expect(f.readAuth()).toMatchObject({ stored: null, username: undefined, player: undefined });
});

it('forgets the player when the Store account is signed out', async () => {
  const f = refreshFixture({ playerAccount: true }, { store: { code: 0, output: '{"stored":false}' }, player: stored('player@example.test') });
  await f.refresh();
  expect(f.readAuth()).toMatchObject({ stored: false, player: undefined });
});

it('connects Xbox social features as the player account', () => {
  const context: any = { initialAuth: { running: false, stored: true, username: 'store@example.test', player: 'player@example.test' }, demoMode: false,
    backend: { current: { available: true, binaryPath: '/fixture/cli', capabilities: { nativeSocial: true } } } };
  runInNewContext(compile(`let authState = globalThis.initialAuth;\n${extract('nativeSocialConnection', 'xboxAccount')}\nglobalThis.connection = nativeSocialConnection;`), context);
  expect(context.connection()).toEqual({ account: 'player@example.test', binary: '/fixture/cli' });
});
