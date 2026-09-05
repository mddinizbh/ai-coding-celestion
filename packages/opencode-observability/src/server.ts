import http from 'node:http';

import type { HistoryQueryService } from './history-query';
import type { SessionHistoryEvent } from './history-domain';
import { handleRouteRequest, type RouteRequest, type RouteResponse } from './server-routes';
import type { DashboardAssetProvider } from './server-assets';
import { checkBearerAuthorization, checkOrigin, securityHeaders, type TokenFactory } from './server-security';
import { createDashboardStreamHandler, createDashboardStreamRegistry, type DashboardStreamRegistry } from './server-sse';

export type ServerDiagnosticCode = 'SERVER_BIND_FAILED' | 'REQUEST_HANDLER_FAILED';

export interface ServerDescriptor {
  readonly port: number;
  readonly origin: string;
  readonly launchURL: string;
}

export type DashboardStreamHandler = (
  request: RouteRequest,
  raw: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse },
  runtime: DashboardRouteRuntime
) => boolean | Promise<boolean>;

export interface DashboardServerDeps {
  readonly queryService: HistoryQueryService;
  readonly tokenFactory: TokenFactory;
  readonly assets: DashboardAssetProvider;
  readonly onDiagnostic?: (code: ServerDiagnosticCode) => void;
  readonly createServer?: (handler: http.RequestListener) => http.Server;
  readonly now?: () => number;
  readonly subscribe?: (listener: (event: SessionHistoryEvent) => void) => () => void;
  readonly streamRegistry?: DashboardStreamRegistry;
  /** Task 9 plugs SSE here before the Task 7 `/events/stream` 501 fallback. */
  readonly streamHandler?: DashboardStreamHandler;
}

export interface DashboardServer {
  start(): Promise<ServerDescriptor>;
  setActiveSession(sessionID: string | null): void;
  descriptor(): ServerDescriptor;
  stop(): Promise<void>;
}

export interface DashboardRouteRuntime {
  readonly queryService: HistoryQueryService;
  readonly getActiveSessionID: () => string | null;
}

const HOST = '127.0.0.1';
const INITIAL_DESCRIPTOR: ServerDescriptor = Object.freeze({ port: 0, origin: `http://${HOST}:0`, launchURL: `http://${HOST}:0/#` });
const NOT_FOUND: RouteResponse = Object.freeze({ status: 404, contentType: 'application/json', body: '{"error":"NOT_FOUND"}' });
const UNAUTHORIZED: RouteResponse = Object.freeze({ status: 401, contentType: 'application/json', body: '{"error":"UNAUTHORIZED"}' });
const FORBIDDEN: RouteResponse = Object.freeze({ status: 403, contentType: 'application/json', body: '{"error":"FORBIDDEN"}' });
const INTERNAL_ERROR: RouteResponse = Object.freeze({ status: 500, contentType: 'application/json', body: '{"error":"INTERNAL_ERROR"}' });

interface TransportResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export function createDashboardServer(deps: DashboardServerDeps): DashboardServer {
  const createServer = deps.createServer ?? http.createServer;
  let activeSessionID: string | null = null;
  let server: http.Server | null = null;
  let descriptor: ServerDescriptor = INITIAL_DESCRIPTOR;
  let token: string | null = null;
  let startPromise: Promise<ServerDescriptor> | null = null;
  const streamRegistry = deps.streamRegistry ?? createDashboardStreamRegistry();

  const runtime: DashboardRouteRuntime = {
    queryService: deps.queryService,
    getActiveSessionID: () => activeSessionID
  };

  const streamHandler = deps.streamHandler ?? (deps.subscribe === undefined
    ? undefined
    : createDashboardStreamHandler({ queryService: deps.queryService, subscribe: deps.subscribe, registry: streamRegistry }));

  const report = (code: ServerDiagnosticCode): void => {
    try {
      deps.onDiagnostic?.(code);
    } catch {
      return;
    }
  };

  const handle = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    void respond(request, response, runtime, deps, streamHandler, () => descriptor, () => token, report);
  };

  return {
    start: () => {
      if (startPromise !== null) return startPromise;
      startPromise = startLoopback(createServer, handle, report).then((started) => {
        if (started === null) return descriptor;
        server = started.server;
        token = token ?? deps.tokenFactory.generateToken();
        descriptor = descriptorFromPort(started.port, token);
        return descriptor;
      });
      return startPromise;
    },
    setActiveSession: (sessionID) => {
      activeSessionID = sessionID;
    },
    descriptor: () => descriptor,
    stop: async () => {
      const current = server;
      if (current === null) return;
      server = null;
      startPromise = Promise.resolve(descriptor);
      await streamRegistry.closeAll();
      await closeServer(current);
    }
  };
}

async function startLoopback(
  createServer: (handler: http.RequestListener) => http.Server,
  handler: http.RequestListener,
  report: (code: ServerDiagnosticCode) => void
): Promise<{ readonly server: http.Server; readonly port: number } | null> {
  let instance: http.Server;
  try {
    instance = createServer(handler);
  } catch {
    report('SERVER_BIND_FAILED');
    return null;
  }

  return await new Promise((resolve) => {
    instance.once('error', () => {
      report('SERVER_BIND_FAILED');
      resolve(null);
    });
    instance.listen(0, HOST, () => {
      const address = instance.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server: instance, port });
    });
  });
}

async function respond(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  runtime: DashboardRouteRuntime,
  deps: DashboardServerDeps,
  streamHandler: DashboardStreamHandler | undefined,
  getDescriptor: () => ServerDescriptor,
  getToken: () => string | null,
  report: (code: ServerDiagnosticCode) => void
): Promise<void> {
  try {
    const routeResponse = await buildResponse(request, response, runtime, deps, streamHandler, getDescriptor(), getToken());
    if (routeResponse === null) return;
    writeRouteResponse(response, routeResponse);
  } catch {
    report('REQUEST_HANDLER_FAILED');
    if (!response.headersSent) writeRouteResponse(response, INTERNAL_ERROR);
    if (!response.writableEnded) response.end();
  }
}

async function buildResponse(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  runtime: DashboardRouteRuntime,
  deps: DashboardServerDeps,
  streamHandler: DashboardStreamHandler | undefined,
  descriptor: ServerDescriptor,
  token: string | null
): Promise<TransportResponse | null> {
  const origin = request.headers.origin;
  const originCheck = checkOrigin(Array.isArray(origin) ? origin[0] : origin, descriptor.origin);
  if (!originCheck.ok) return FORBIDDEN;

  const url = new URL(request.url ?? '/', descriptor.origin);
  if (deps.assets.isStaticPath(url.pathname)) {
    const asset = await deps.assets.get(url.pathname);
    return asset === null ? NOT_FOUND : { status: 200, contentType: asset.contentType, body: asset.content };
  }

  const authorization = request.headers.authorization;
  const auth = token === null ? { ok: false as const, status: 401 as const } : checkBearerAuthorization(Array.isArray(authorization) ? authorization[0] : authorization, token);
  if (!auth.ok) return UNAUTHORIZED;

  const routeRequest: RouteRequest = { method: request.method ?? 'GET', pathname: url.pathname, query: [...url.searchParams] };
  if (url.pathname === '/events/stream' && streamHandler !== undefined) {
    const taken = await streamHandler(routeRequest, { req: request, res: response }, runtime);
    if (taken) return null;
  }
  return handleRouteRequest(routeRequest, runtime);
}

function writeRouteResponse(response: http.ServerResponse, routeResponse: TransportResponse): void {
  const headers = { ...routeResponse.headers, ...securityHeaders(), 'Content-Type': routeResponse.contentType };
  response.writeHead(routeResponse.status, headers);
  response.end(routeResponse.body);
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      resolve();
    });
  });
}

function descriptorFromPort(port: number, token: string): ServerDescriptor {
  const origin = `http://${HOST}:${port}`;
  return { port, origin, launchURL: `${origin}/#${token}` };
}
