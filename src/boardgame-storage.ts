type MatchMetadata = {
  gameName: string;
  unlisted: boolean;
  players: Record<string, { id: number; name?: string; isConnected?: boolean; credentials?: string }>;
  createdAt: number;
  updatedAt: number;
  gameover?: unknown;
  setupData?: unknown;
};

type FetchOptions = { state?: boolean; log?: boolean; metadata?: boolean; initialState?: boolean };

type MatchState = {
  G: unknown;
  ctx: unknown;
  plugins: unknown;
  _undo: unknown[];
  _redo: unknown[];
  _stateID: number;
  deltalog?: unknown[];
};

type DurableStorage = DurableObjectStorage;

/** Async boardgame.io StorageAPI backed by one room's Durable Object storage. */
export class DurableMatchStorage {
  private readonly storage: DurableStorage;
  private readonly prefix: string;

  constructor(storage: DurableStorage, tableId: string) {
    this.storage = storage;
    this.prefix = `bgio:${tableId}:`;
  }

  type() {
    // boardgame.io StorageAPI.Type.ASYNC
    return 1;
  }

  async connect() {}

  async createMatch(_matchID: string, opts: { initialState: MatchState; metadata: MatchMetadata }) {
    await this.storage.put(this.key('state'), opts.initialState);
    await this.storage.put(this.key('initialState'), opts.initialState);
    await this.storage.put(this.key('metadata'), opts.metadata);
    await this.storage.put(this.key('log'), []);
  }

  async setState(_matchID: string, state: MatchState, deltalog: unknown[] = []) {
    const { deltalog: _transientLog, ...durableState } = state;
    await this.storage.put(this.key('state'), durableState);
    if (deltalog.length > 0) {
      const previous = (await this.storage.get<unknown[]>(this.key('log'))) || [];
      await this.storage.put(this.key('log'), [...previous, ...deltalog].slice(-2000));
    }
  }

  async setMetadata(_matchID: string, metadata: MatchMetadata) {
    await this.storage.put(this.key('metadata'), metadata);
  }

  async fetch<T extends FetchOptions>(_matchID: string, opts: T): Promise<Partial<Record<keyof FetchOptions, unknown>>> {
    const result: Partial<Record<keyof FetchOptions, unknown>> = {};
    if (opts.state) result.state = await this.storage.get<MatchState>(this.key('state'));
    if (opts.log) result.log = (await this.storage.get<unknown[]>(this.key('log'))) || [];
    if (opts.metadata) result.metadata = await this.storage.get<MatchMetadata>(this.key('metadata'));
    if (opts.initialState) result.initialState = await this.storage.get<MatchState>(this.key('initialState'));
    return result;
  }

  async wipe(_matchID: string) {
    await this.storage.delete([
      this.key('state'),
      this.key('initialState'),
      this.key('metadata'),
      this.key('log'),
    ]);
  }

  private key(suffix: string) {
    return `${this.prefix}${suffix}`;
  }
}
