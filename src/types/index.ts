import type { ChildProcess } from 'node:child_process';
import type { Request, Response } from 'express';
import type { z } from 'zod';

// JSON-RPC types
export interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: string | number;
}

export interface JSONRPCRequest extends JSONRPCMessage {
  method: string;
  params?: unknown;
}

export interface JSONRPCResponse extends JSONRPCMessage {
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// Session types
export interface Session {
  id: string;
  createdAt: Date;
  lastActivityAt: Date;
  stdioProcess?: ChildProcess;
  serverConfig: ServerConfig;
  messageQueue: JSONRPCMessage[];
  isInitialized: boolean;
  sseConnections: Set<Response>;
}

// Server configuration
export interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  endpoint?: string;  // Custom endpoint path
}

// Proxy configuration
export interface ProxyConfig {
  port: number;
  host: string;
  sessionTimeout: number;
  batchTimeout: number;
  cors: {
    origins: string[];
    credentials: boolean;
  };
  auth?: {
    type: 'bearer' | 'none';
    tokens?: string[];
  };
  servers: ServerConfig[];
}

// Transport types
export type TransportMode = 'batch' | 'stream';

export interface TransportOptions {
  mode: TransportMode;
  batchTimeout: number;
}

// Request extensions
export interface AuthenticatedRequest extends Request {
  session?: Session;
  sessionId?: string;
}

// SSE Event
export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

// Process manager types
export interface ProcessManagerOptions {
  restartOnCrash: boolean;
  maxRestarts: number;
  restartDelay: number;
}

export interface ProcessInfo {
  pid: number;
  command: string;
  args: string[];
  startedAt: Date;
  restarts: number;
  status: 'running' | 'stopped' | 'crashed';
}

// Error codes (following JSON-RPC spec)
export enum ErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  ServerError = -32000,
  SessionNotFound = -32001,
  ProcessCrashed = -32002,
  AuthenticationRequired = -32003,
  Unauthorized = -32004,
  SessionTimeout = -32005,
}

// MCP specific types
export interface MCPInitializeRequest extends JSONRPCRequest {
  method: 'initialize';
  params: {
    protocolVersion: string;
    capabilities: {
      tools?: boolean;
      resources?: boolean;
      prompts?: boolean;
      sampling?: boolean;
      roots?: boolean;
    };
    clientInfo: {
      name: string;
      version: string;
    };
  };
}

export interface MCPInitializeResponse extends JSONRPCResponse {
  result: {
    protocolVersion: string;
    capabilities: {
      tools?: boolean;
      resources?: boolean;
      prompts?: boolean;
      sampling?: boolean;
      roots?: boolean;
    };
    serverInfo: {
      name: string;
      version: string;
    };
  };
}

// Utility types
export type Promisable<T> = T | Promise<T>;
export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;

// Event types for internal communication
export interface ProxyEvents {
  'session:created': (session: Session) => void;
  'session:destroyed': (sessionId: string) => void;
  'process:started': (session: Session) => void;
  'process:crashed': (session: Session, error: Error) => void;
  'message:received': (session: Session, message: JSONRPCMessage) => void;
  'message:sent': (session: Session, message: JSONRPCMessage) => void;
  'error': (error: Error, context?: unknown) => void;
}

// Response helpers
export type JSONResponse = {
  statusCode: number;
  headers?: Record<string, string>;
  body: unknown;
};

export type SSEResponse = {
  headers?: Record<string, string>;
  stream: AsyncGenerator<SSEEvent>;
};

export type ProxyResponse = JSONResponse | SSEResponse;

// Type guards
export function isJSONRPCRequest(msg: unknown): msg is JSONRPCRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'jsonrpc' in msg &&
    'method' in msg &&
    !('result' in msg || 'error' in msg)
  );
}

export function isJSONRPCResponse(msg: unknown): msg is JSONRPCResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'jsonrpc' in msg &&
    'id' in msg &&
    ('result' in msg || 'error' in msg)
  );
}

export function isJSONRPCNotification(msg: unknown): msg is JSONRPCNotification {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'jsonrpc' in msg &&
    'method' in msg &&
    !('id' in msg)
  );
}

export function isBatch(msg: unknown): msg is JSONRPCMessage[] {
  return Array.isArray(msg) && msg.length > 0;
}
