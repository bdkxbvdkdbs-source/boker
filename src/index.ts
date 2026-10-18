import { advance, bestScore, startRound, visibleBoard, type Round, type Variant } from './poker';

export interface Env {
  DB: D1Database;
  POKER_TABLE: DurableObjectNamespace;
  SESSION_KV: KVNamespace;
  ALLOWED_ORIGIN: string;
  ADMIN_TOKEN?: string;
}

type SessionRecord = {
  id: string;
  displayName: string;
  createdAt: number;
  lastActiveAt: number;
  lastTableId: string | null;
};

type StoredGame = {
  round: Round | null;
  usedActions: string[];
  playerNames: Record<string, string>;
};

type TableConfig = {
  name: string;
  variant: Variant;
  capacity: number;
  blinds: string;
};

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const tableConfig: Record<string, TableConfig> = {
  'berlin-9max': { name: 'طاولة بوكر تكساس', variant: 'texas', capacity: 9, blinds: '5 / 10' },
  'london-5max': { name: 'طاولة بوكر أوماها', variant: 'omaha', capacity: 5, blinds: '5 / 10' },
};

function responseHeaders(origin: string): Headers {
  return new Headers({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'vary': 'Origin',
    'cache-control': 'no-store',
  });
}

function json(data: unknown, status = 200, origin = '*'): Response {
  return new Response(JSON.stringify(data), { status, headers: responseHeaders(origin) });
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.get('authorization') || '');
  return match?.[1]?.toLowerCase() || null;
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function findSession(token: string, env: Env): Promise<{ key: string; record: SessionRecord } | null> {
  const key = `session:${await hashToken(token)}`;
  const value = await env.SESSION_KV.get(key, 'json');
  if (!value || typeof value !== 'object') return null;
  const record = value as SessionRecord;
  if (typeof record.id !== 'string' || typeof record.displayName !== 'string') return null;
  return { key, record };
}

async function sessionApi(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method === 'POST') {
    let body: { displayName?: unknown } = {};
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400, origin); }
    const id = crypto.randomUUID();
    const requestedName = typeof body.displayName === 'string' ? body.displayName.trim().replace(/\s+/g, ' ') : '';
    const displayName = requestedName.slice(0, 24) || `لاعب ${id.slice(0, 4)}`;
    const token = newSessionToken();
    const key = `session:${await hashToken(token)}`;
    const now = Date.now();
    const record: SessionRecord = { id, displayName, createdAt: now, lastActiveAt: now, lastTableId: null };
    await env.SESSION_KV.put(key, JSON.stringify(record), { expirationTtl: SESSION_TTL_SECONDS });
    return json({ token, session: record }, 201, origin);
  }

  const token = bearerToken(request);
  if (!token) return json({ error: 'session_required' }, 401, origin);
  const found = await findSession(token, env);
  if (!found) return json({ error: 'session_expired' }, 401, origin);

  if (request.method === 'GET') return json({ session: found.record }, 200, origin);
  if (request.method === 'PUT') {
    let body: { displayName?: unknown; lastTableId?: unknown } = {};
    try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400, origin); }
    const updated = { ...found.record, lastActiveAt: Date.now() };
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string') return json({ error: 'invalid_display_name' }, 400, origin);
      const name = body.displayName.trim().replace(/\s+/g, ' ');
      if (!name || name.length > 24) return json({ error: 'invalid_display_name' }, 400, origin);
      updated.displayName = name;
    }
    if (body.lastTableId !== undefined) {
      if (body.lastTableId !== null && (typeof body.lastTableId !== 'string' || !Object.hasOwn(tableConfig, body.lastTableId))) {
        return json({ error: 'invalid_table' }, 400, origin);
      }
      updated.lastTableId = body.lastTableId as string | null;
    }
    await env.SESSION_KV.put(found.key, JSON.stringify(updated), { expirationTtl: SESSION_TTL_SECONDS });
    return json({ session: updated }, 200, origin);
  }
  if (request.method === 'DELETE') {
    await env.SESSION_KV.delete(found.key);
    return json({ ok: true }, 200, origin);
  }
  return json({ error: 'method_not_allowed' }, 405, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(origin) });
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'bokerr-api' }, 200, origin);
      if (url.pathname === '/api/tables' && request.method === 'GET') return json(await listTables(env), 200, origin);
      if (url.pathname === '/api/session') return await sessionApi(request, env, origin);

      if (url.pathname.startsWith('/ws/')) {
        const tableId = url.pathname.slice('/ws/'.length);
        if (!Object.hasOwn(tableConfig, tableId)) return json({ error: 'unknown_table' }, 404, origin);
        const protocols = (request.headers.get('sec-websocket-protocol') || '').split(',').map((item) => item.trim());
        const token = protocols.find((item) => /^[a-f0-9]{64}$/i.test(item));
        if (!protocols.includes('bokerr-v1') || !token) return json({ error: 'session_required' }, 401, origin);
        const found = await findSession(token, env);
        if (!found) return json({ error: 'session_expired' }, 401, origin);

        const headers = new Headers(request.headers);
        headers.set('sec-websocket-protocol', 'bokerr-v1');
        headers.set('x-bokerr-player-id', found.record.id);
        headers.set('x-bokerr-player-name', encodeURIComponent(found.record.displayName));
        headers.set('x-bokerr-table-id', tableId);
        const authenticatedRequest = new Request(request, { headers });
        return env.POKER_TABLE.get(env.POKER_TABLE.idFromName(tableId)).fetch(authenticatedRequest);
      }

      if (url.pathname.startsWith('/api/admin/')) {
        if (!isAdmin(request, env)) return json({ error: 'forbidden' }, 403, origin);
        return json(await admin(url.pathname, request, env), 200, origin);
      }
      return json({ error: 'not_found' }, 404, origin);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'internal_error' }, 500, origin);
    }
  },
};

async function listTables(env: Env) {
  return Promise.all(Object.entries(tableConfig).map(async ([id, config]) => {
    const response = await env.POKER_TABLE.get(env.POKER_TABLE.idFromName(id)).fetch('https://table/state');
    const state = await response.json<{ seated: number; stage: string }>();
    return { id, ...config, seated: state.seated, stage: state.stage };
  }));
}

function isAdmin(request: Request, env: Env): boolean {
  return Boolean(env.ADMIN_TOKEN) && request.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`;
}

async function admin(path: string, request: Request, env: Env): Promise<unknown> {
  if (path === '/api/admin/overview' && request.method === 'GET') {
    const users = await env.DB.prepare('SELECT id,username,status FROM users ORDER BY created_at DESC').all();
    return { users: users.results, tables: Object.entries(tableConfig).map(([id, config]) => ({ id, name: config.name, capacity: config.capacity })) };
  }
  if (request.method !== 'POST') throw new Error('method_not_allowed');
  const body = await request.json<Record<string, unknown>>();
  if (path === '/api/admin/freeze') {
    if (typeof body.userId !== 'string') throw new Error('invalid_user');
    await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(body.frozen ? 'frozen' : 'active', body.userId).run();
    return { ok: true };
  }
  throw new Error('unknown_admin_action');
}

export class PokerTable {
  state: DurableObjectState;
  env: Env;
  connections = new Map<WebSocket, { id: string; name: string }>();
  round: Round | null = null;
  usedActions = new Set<string>();
  playerNames: Record<string, string> = {};
  tableId = '';
  ready: Promise<void>;
  serial: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<StoredGame>('gameState');
      if (stored) {
        this.round = stored.round;
        this.usedActions = new Set(stored.usedActions || []);
        this.playerNames = stored.playerNames || {};
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/state') {
      return Response.json({
        seated: new Set(Array.from(this.connections.values(), (player) => player.id)).size,
        stage: this.round?.stage || 'waiting',
        board: this.round ? visibleBoard(this.round) : [],
      });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });

    const tableId = request.headers.get('x-bokerr-table-id') || '';
    const config = tableConfig[tableId];
    const playerId = request.headers.get('x-bokerr-player-id');
    if (!config || !playerId) return new Response('Session required', { status: 401 });
    let playerName = 'لاعب';
    try { playerName = decodeURIComponent(request.headers.get('x-bokerr-player-name') || 'لاعب').slice(0, 24) || 'لاعب'; } catch { /* use fallback */ }

    if (this.round && this.round.stage !== 'showdown' && !this.round.players.some((player) => player.id === playerId)) {
      return new Response('Round already started', { status: 409 });
    }
    for (const [socket, identity] of this.connections) {
      if (identity.id === playerId) {
        this.connections.delete(socket);
        try { socket.close(4001, 'reconnected'); } catch { /* already closed */ }
      }
    }
    const seatedIds = new Set(Array.from(this.connections.values(), (player) => player.id));
    if (!seatedIds.has(playerId) && seatedIds.size >= config.capacity) return new Response('Table is full', { status: 409 });

    this.tableId = tableId;
    this.playerNames[playerId] = playerName;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const identity = { id: playerId, name: playerName };
    this.connections.set(server, identity);
    server.addEventListener('close', () => {
      this.connections.delete(server);
      this.broadcastPresence();
    });
    server.addEventListener('message', (event) => {
      this.serial = this.serial.then(() => this.handle(server, identity, String(event.data))).catch((error) => {
        this.send(server, { type: 'error', error: error instanceof Error ? error.message : 'internal_error' });
      });
    });
    server.send(JSON.stringify({ type: 'ready', playerId, turnSeconds: 20 }));
    this.broadcastPresence();
    if (this.round && this.round.stage !== 'showdown') this.sendState(server, playerId);
    await this.persist();

    const headers = new Headers({ 'Sec-WebSocket-Protocol': 'bokerr-v1' });
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  async handle(socket: WebSocket, identity: { id: string; name: string }, raw: string): Promise<void> {
    let message: { type?: unknown; actionId?: unknown };
    try { message = JSON.parse(raw); } catch { this.send(socket, { type: 'error', error: 'malformed_message' }); return; }
    if (typeof message.actionId !== 'string' || message.actionId.length < 8 || message.actionId.length > 80) {
      this.send(socket, { type: 'error', error: 'invalid_action_id' });
      return;
    }
    if (this.usedActions.has(message.actionId)) {
      this.send(socket, { type: 'error', error: 'replayed_action' });
      return;
    }
    this.usedActions.add(message.actionId);
    while (this.usedActions.size > 256) this.usedActions.delete(this.usedActions.values().next().value as string);

    if (message.type === 'start') {
      if (this.round && this.round.stage !== 'showdown') { this.send(socket, { type: 'error', error: 'round_in_progress' }); return; }
      const config = tableConfig[this.tableId];
      const players = Array.from(new Map(Array.from(this.connections.values(), (player) => [player.id, player])).values());
      if (!config || players.length < 2 || players.length > config.capacity) { this.send(socket, { type: 'error', error: 'need_two_players' }); return; }
      for (const player of players) this.playerNames[player.id] = player.name;
      this.round = startRound(config.variant, players.map((player) => player.id));
      this.usedActions.clear();
      this.usedActions.add(message.actionId);
      await this.persist();
      this.broadcast({ type: 'round_started', stage: this.round.stage });
      this.broadcastState();
      return;
    }

    if (!this.round || this.round.stage === 'showdown') { this.send(socket, { type: 'error', error: 'round_not_started' }); return; }
    const player = this.round.players[this.round.turnIndex];
    if (player.id !== identity.id) { this.send(socket, { type: 'error', error: 'not_your_turn' }); return; }
    if (!['fold', 'check', 'call', 'bet'].includes(String(message.type))) { this.send(socket, { type: 'error', error: 'unsupported_action' }); return; }

    if (message.type === 'fold') player.folded = true;
    else {
      const amount = message.type === 'bet' ? 10 : 5;
      player.committed += amount;
      this.round.pot += amount;
    }
    this.round = advance(this.round);
    await this.persist();
    if (this.round.stage === 'showdown') {
      const winners = this.round.players.filter((item) => !item.folded)
        .sort((a, b) => compare(bestScore(this.round as Round, b), bestScore(this.round as Round, a)))
        .slice(0, 1).map((item) => item.id);
      this.broadcast({ type: 'showdown', pot: this.round.pot, winners });
    } else {
      this.broadcast({ type: 'action', action: message.type, stage: this.round.stage, pot: this.round.pot });
    }
    this.broadcastState();
  }

  async persist(): Promise<void> {
    await this.state.storage.put('gameState', {
      round: this.round,
      usedActions: Array.from(this.usedActions),
      playerNames: this.playerNames,
    } satisfies StoredGame);
  }

  sendState(socket: WebSocket, playerId: string): void {
    if (!this.round) return;
    const own = this.round.players.find((player) => player.id === playerId);
    this.send(socket, {
      type: 'state',
      stage: this.round.stage,
      variant: this.round.variant,
      board: visibleBoard(this.round),
      pot: this.round.pot,
      currentPlayerId: this.round.players[this.round.turnIndex]?.id,
      yourCards: own?.hole || [],
      players: this.round.players.map((player) => ({
        id: player.id,
        name: this.playerNames[player.id] || 'لاعب',
        folded: player.folded,
        committed: player.committed,
        isTurn: player.id === this.round?.players[this.round.turnIndex]?.id,
      })),
    });
  }

  broadcastState(): void {
    for (const [socket, identity] of this.connections) this.sendState(socket, identity.id);
  }

  broadcastPresence(): void {
    const players = Array.from(new Map(Array.from(this.connections.values(), (player) => [player.id, player])).values())
      .map((player) => ({ id: player.id, name: player.name }));
    this.broadcast({ type: 'presence', seated: players.length, players });
  }

  broadcast(data: unknown): void {
    for (const socket of this.connections.keys()) this.send(socket, data);
  }

  send(socket: WebSocket, data: unknown): void {
    try { socket.send(JSON.stringify(data)); } catch { /* disconnected */ }
  }
}

function compare(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}
