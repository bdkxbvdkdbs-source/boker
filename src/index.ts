import { Master } from 'boardgame.io/master';
import { getFilterPlayerView } from 'boardgame.io/internal';
import { DurableMatchStorage } from './boardgame-storage';
import { createPokerGame, type PokerState, type Variant } from './poker';

export interface Env {
  DB: D1Database;
  POKER_TABLE: DurableObjectNamespace;
  SESSION_KV: KVNamespace;
  ALLOWED_ORIGINS?: string;
  ALLOWED_ORIGIN?: string;
  ADMIN_TOKEN?: string;
}

type SessionRecord = {
  id: string;
  displayName: string;
  createdAt: number;
  lastActiveAt: number;
  lastTableId: string | null;
};

type TableConfig = {
  name: string;
  variant: Variant;
  capacity: number;
  blinds: string;
  buyInMin: number;
  buyInMax: number;
};

type Identity = { id: string; name: string; seat: number; ready: boolean };
type SeatRecord = { seat: number; name: string };
type RoomRecord = { seats: Record<string, SeatRecord>; usedActions: string[] };
type BgState = { G: PokerState; ctx: { currentPlayer: string; numPlayers: number }; _stateID: number; [key: string]: any };
type BoardgameMaster = InstanceType<typeof Master>;

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const tableConfig: Record<string, TableConfig> = {
  'berlin-9max': { name: 'طاولة بوكر تكساس', variant: 'texas', capacity: 9, blinds: '5 / 10', buyInMin: 350, buyInMax: 5000 },
  'london-5max': { name: 'طاولة بوكر أوماها', variant: 'omaha', capacity: 5, blinds: '5 / 10', buyInMin: 500, buyInMax: 5000 },
};

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || 'https://appassets.androidplatform.net')
    .split(',').map((value) => value.trim()).filter(Boolean);
}

function responseHeaders(origin = '*'): Headers {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'vary': 'Origin',
    'cache-control': 'no-store',
  });
  return headers;
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
    const requestOrigin = request.headers.get('Origin');
    const origins = allowedOrigins(env);
    if (requestOrigin && !origins.includes(requestOrigin)) return json({ error: 'origin_not_allowed' }, 403, 'null');
    const origin = requestOrigin || origins[0] || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(origin) });
    const url = new URL(request.url);

    try {
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, service: 'bokerr-api', engine: 'boardgame.io' }, 200, origin);
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
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly connections = new Map<WebSocket, Identity>();
  private readonly seats: Record<string, SeatRecord> = {};
  private readonly usedActions = new Set<string>();
  private tableId = '';
  private config: TableConfig | null = null;
  private game: ReturnType<typeof createPokerGame> | null = null;
  private storage: DurableMatchStorage | null = null;
  private master: BoardgameMaster | null = null;
  private filterPlayerView: ReturnType<typeof getFilterPlayerView> | null = null;
  private lastState: BgState | null = null;
  private ready: Promise<void>;
  private serial: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => {
      const stored = await state.storage.get<RoomRecord>('boardgameRoom');
      if (stored) {
        Object.assign(this.seats, stored.seats || {});
        for (const actionId of stored.usedActions || []) this.usedActions.add(actionId);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/state') {
      const state = await this.loadState();
      const seated = new Set(Array.from(this.connections.values(), (player) => player.id)).size;
      return Response.json({
        seated,
        stage: state?.G.stage || 'waiting',
        board: state?.G.board || [],
        variant: this.config?.variant,
        capacity: this.config?.capacity,
      });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });

    const tableId = request.headers.get('x-bokerr-table-id') || '';
    const playerId = request.headers.get('x-bokerr-player-id');
    if (!Object.hasOwn(tableConfig, tableId) || !playerId) return new Response('Session required', { status: 401 });
    let playerName = 'لاعب';
    try { playerName = decodeURIComponent(request.headers.get('x-bokerr-player-name') || 'لاعب').slice(0, 24) || 'لاعب'; } catch { /* fallback */ }

    try {
      return await this.enqueue(() => this.acceptConnection(request, tableId, playerId, playerName));
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'table_unavailable', { status: 409 });
    }
  }

  private async acceptConnection(request: Request, tableId: string, playerId: string, playerName: string): Promise<Response> {
    this.configure(tableId);
    const seat = await this.assignSeat(playerId, playerName);
    for (const [socket, identity] of this.connections) {
      if (identity.id === playerId) {
        this.connections.delete(socket);
        try { socket.close(4001, 'reconnected'); } catch { /* already closed */ }
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const identity: Identity = { id: playerId, name: playerName, seat, ready: false };
    this.connections.set(server, identity);
    server.addEventListener('close', () => {
      void this.enqueue(async () => {
        this.connections.delete(server);
        if (Array.from(this.connections.values()).some((connected) => connected.id === identity.id)) return;
        const master = this.master;
        if (master) {
          await master.onConnectionChange(tableId, String(seat), undefined, false);
          const state = await this.loadState();
          if (state && ['waiting', 'showdown'].includes(state.G.stage)) {
            await this.runInternalMove('serverDisconnected', [seat], state);
          }
        }
        this.broadcastPresence();
        const state = await this.loadState();
        if (state) this.broadcastState(state);
      });
    });
    server.addEventListener('message', (event) => {
      void this.enqueue(() => this.handle(server, identity, String(event.data)));
    });

    const master = this.ensureMaster();
    const syncResult = await master.onSync(tableId, String(seat), undefined, this.config!.capacity);
    if (syncResult && 'error' in syncResult) throw new Error(syncResult.error);
    await master.onConnectionChange(tableId, String(seat), undefined, true);
    const state = await this.loadState();
    if (!state) throw new Error('game_initialization_failed');
    if (['waiting', 'showdown'].includes(state.G.stage)) {
      await this.runInternalMove('serverSeat', [seat, playerId, playerName], state);
    }

    identity.ready = true;
    const current = await this.loadState();
    this.send(server, { type: 'ready', playerId, playerIndex: seat, turnSeconds: 30, stateID: current?._stateID ?? 0 });
    this.broadcastPresence();
    if (current) this.broadcastState(current);
    const headers = new Headers({ 'Sec-WebSocket-Protocol': 'bokerr-v1' });
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private configure(tableId: string) {
    if (this.master) {
      if (this.tableId !== tableId) throw new Error('table_mismatch');
      return;
    }
    const config = tableConfig[tableId];
    if (!config) throw new Error('unknown_table');
    this.tableId = tableId;
    this.config = config;
    this.game = createPokerGame(config.variant, config.capacity);
    this.storage = new DurableMatchStorage(this.state.storage, tableId);
    this.filterPlayerView = getFilterPlayerView(this.game as any);
    const transport = { send: () => {}, sendAll: () => {} };
    this.master = new Master(this.game as any, this.storage as any, transport as any);
    this.master.subscribe(({ state, matchID }) => {
      if (matchID === this.tableId) this.lastState = state as BgState;
    });
  }

  private ensureMaster(): BoardgameMaster {
    if (!this.master) throw new Error('table_not_configured');
    return this.master;
  }

  private async assignSeat(playerId: string, name: string): Promise<number> {
    const existing = this.seats[playerId];
    if (existing) {
      existing.name = name;
      await this.persistRoom();
      return existing.seat;
    }
    const state = await this.loadState();
    const inHandSeats = state && !['waiting', 'showdown'].includes(state.G.stage)
      ? state.G.players.filter((player) => player.inHand && !player.folded).map((player) => player.seat)
      : [];
    const connectedSeats = new Set(Array.from(this.connections.values(), (player) => player.seat));
    const capacity = this.config!.capacity;
    let seat = -1;
    for (let candidate = 0; candidate < capacity; candidate += 1) {
      if (connectedSeats.has(candidate) || inHandSeats.includes(candidate)) continue;
      seat = candidate;
      break;
    }
    if (seat < 0) throw new Error('table_full');
    for (const [otherId, record] of Object.entries(this.seats)) {
      if (record.seat === seat) delete this.seats[otherId];
    }
    this.seats[playerId] = { seat, name };
    await this.persistRoom();
    return seat;
  }

  private async handle(socket: WebSocket, identity: Identity, raw: string): Promise<void> {
    let message: { type?: unknown; actionId?: unknown; stateID?: unknown; amount?: unknown };
    try { message = JSON.parse(raw); } catch { this.send(socket, { type: 'error', error: 'malformed_message' }); return; }
    if (typeof message.actionId !== 'string' || message.actionId.length < 8 || message.actionId.length > 80) {
      this.send(socket, { type: 'error', error: 'invalid_action_id' });
      return;
    }
    if (this.usedActions.has(message.actionId)) {
      this.send(socket, { type: 'error', error: 'replayed_action', actionId: message.actionId });
      return;
    }
    this.usedActions.add(message.actionId);
    while (this.usedActions.size > 512) this.usedActions.delete(this.usedActions.values().next().value as string);
    await this.persistRoom();

    const master = this.ensureMaster();
    const state = await this.loadState();
    if (!state) { this.send(socket, { type: 'error', error: 'game_not_ready', actionId: message.actionId }); return; }
    if (message.stateID !== undefined && (!Number.isInteger(message.stateID) || message.stateID !== state._stateID)) {
      this.send(socket, { type: 'error', error: 'stale_state', actionId: message.actionId });
      this.sendState(socket, identity, state);
      return;
    }

    if (message.type === 'start' || message.type === 'startNextHand') {
      if (!['waiting', 'showdown'].includes(state.G.stage)) {
        this.send(socket, { type: 'error', error: 'round_in_progress', actionId: message.actionId });
        return;
      }
      const participants = Array.from(new Map(Array.from(this.connections.values(), (p) => [p.id, p])).values())
        .map((player) => ({ seat: player.seat, id: player.id, name: player.name }));
      if (participants.length < 2) {
        this.send(socket, { type: 'error', error: 'need_two_players', actionId: message.actionId });
        return;
      }
      const beforeStage = state.G.stage;
      const after = await this.runInternalMove('serverStartHand', [participants], state);
      if (!after || after._stateID === state._stateID) {
        this.send(socket, { type: 'error', error: 'could_not_start_hand', actionId: message.actionId });
        return;
      }
      this.broadcast({ type: 'round_started', stage: after.G.stage, handNumber: after.G.handNumber, resumed: beforeStage === 'showdown' });
      this.broadcastState(after);
      this.broadcastPresence();
      return;
    }

    const allowed = new Set(['fold', 'check', 'call', 'bet', 'raise', 'allIn']);
    if (typeof message.type !== 'string' || !allowed.has(message.type)) {
      this.send(socket, { type: 'error', error: 'unsupported_action', actionId: message.actionId });
      return;
    }
    if (!['preflop', 'flop', 'turn', 'river'].includes(state.G.stage)) {
      this.send(socket, { type: 'error', error: 'round_not_started', actionId: message.actionId });
      return;
    }
    if (state.ctx.currentPlayer !== String(identity.seat)) {
      this.send(socket, { type: 'error', error: 'not_your_turn', actionId: message.actionId });
      return;
    }
    if ((message.type === 'bet' || message.type === 'raise') && (!Number.isSafeInteger(message.amount) || (message.amount as number) <= 0)) {
      this.send(socket, { type: 'error', error: 'invalid_amount', actionId: message.actionId });
      return;
    }

    const args = message.type === 'bet' || message.type === 'raise' ? [message.amount] : [];
    const after = await this.runPlayerMove(identity, message.type, args, state, message.stateID as number | undefined);
    if (!after || after._stateID === state._stateID) {
      this.send(socket, { type: 'error', error: 'invalid_action', actionId: message.actionId });
      this.sendState(socket, identity, await this.loadState() || state);
      return;
    }
    this.broadcast({ type: 'action', action: message.type, stage: after.G.stage, pot: after.G.pot, actionId: message.actionId });
    if (after.G.stage === 'showdown' && state.G.stage !== 'showdown') {
      this.broadcast({ type: 'showdown', pot: after.G.pot, winners: after.G.result?.winners || [], winningSeats: after.G.result?.winningSeats || [], resultMessage: after.G.result?.description || '' });
    }
    this.broadcastState(after);
    this.broadcastPresence();
  }

  private async runInternalMove(name: string, args: unknown[], state: BgState): Promise<BgState | null> {
    const actor = state.ctx.currentPlayer;
    return this.runMove(name, args, actor, state._stateID);
  }

  private async runPlayerMove(identity: Identity, name: string, args: unknown[], state: BgState, stateID?: number): Promise<BgState | null> {
    return this.runMove(name, args, String(identity.seat), stateID ?? state._stateID);
  }

  private async runMove(name: string, args: unknown[], playerID: string, stateID: number): Promise<BgState | null> {
    const result = await this.ensureMaster().onUpdate({
      type: 'MAKE_MOVE',
      payload: { type: name, args, playerID },
    } as any, stateID, this.tableId, playerID);
    if (result && 'error' in result) return null;
    return this.loadState();
  }

  private async loadState(): Promise<BgState | null> {
    if (!this.storage) return null;
    const result = await this.storage.fetch(this.tableId, { state: true } as const) as { state?: BgState };
    return result.state || null;
  }

  private async persistRoom() {
    await this.state.storage.put('boardgameRoom', {
      seats: this.seats,
      usedActions: Array.from(this.usedActions),
    } satisfies RoomRecord);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.serial.then(operation);
    this.serial = task.then(() => undefined, () => undefined);
    return task;
  }

  private sendState(socket: WebSocket, identity: Identity, state: BgState) {
    const filter = this.filterPlayerView;
    const filtered = filter
      ? (filter(String(identity.seat), { type: 'update', args: [this.tableId, state] } as any) as any).args[1] as BgState
      : state;
    const G = filtered.G;
    const currentSeat = Number(filtered.ctx.currentPlayer);
    const own = G.players[identity.seat];
    const players = G.players.filter((player) => player.sessionId || player.inHand).map((player) => ({
      id: player.sessionId || `seat-${player.seat}`,
      name: player.name,
      seat: player.seat,
      stack: player.chips,
      bet: player.streetBet,
      folded: player.folded,
      allIn: player.allIn,
      isConnected: this.isSeatConnected(player.seat),
      isTurn: player.seat === currentSeat && ['preflop', 'flop', 'turn', 'river'].includes(G.stage),
    }));
    const message = {
      type: 'state',
      stateID: state._stateID,
      stage: G.stage,
      variant: G.variant,
      board: G.board,
      pot: G.pot,
      currentPlayerId: G.players[currentSeat]?.sessionId || null,
      currentPlayerIndex: currentSeat,
      yourCards: own?.holeCards || [],
      players,
      dealerId: G.players[G.buttonSeat]?.sessionId || null,
      dealerSeat: G.buttonSeat,
      smallBlind: G.smallBlind,
      bigBlind: G.bigBlind,
      currentBet: G.currentBet,
      toCall: own ? Math.max(0, G.currentBet - own.streetBet) : 0,
      minRaise: G.minRaise,
      winners: G.result?.winners || [],
      winningSeats: G.result?.winningSeats || [],
      resultMessage: G.result?.description || '',
      payouts: G.result?.payouts || {},
      lastAction: G.lastAction,
      handNumber: G.handNumber,
    };
    this.send(socket, message);
  }

  private broadcastState(state: BgState) {
    for (const [socket, identity] of this.connections) {
      if (identity.ready) this.sendState(socket, identity, state);
    }
  }

  private broadcastPresence() {
    const state = this.lastState;
    const seats = Array.from(new Map(Array.from(this.connections.values(), (player) => [player.seat, player])).values())
      .map((player) => ({
        id: player.id,
        name: player.name,
        seat: player.seat,
        isConnected: true,
        stack: state?.G.players[player.seat]?.chips ?? 1000,
        folded: state?.G.players[player.seat]?.folded ?? false,
        allIn: state?.G.players[player.seat]?.allIn ?? false,
        isTurn: state?.ctx.currentPlayer === String(player.seat),
      }));
    this.broadcast({ type: 'presence', seated: seats.length, players: seats });
  }

  private broadcast(data: unknown) {
    for (const [socket, identity] of this.connections) if (identity.ready) this.send(socket, data);
  }

  private isSeatConnected(seat: number) {
    return Array.from(this.connections.values()).some((identity) => identity.seat === seat);
  }

  private send(socket: WebSocket, data: unknown) {
    try { socket.send(JSON.stringify(data)); } catch { /* disconnected */ }
  }
}
