import { z } from 'zod';

// JSON-RPC base schemas
export const JSONRPCVersionSchema = z.literal('2.0');

export const JSONRPCIdSchema = z.union([
  z.string(),
  z.number(),
  z.null(),
]);

export const JSONRPCErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const JSONRPCRequestSchema = z.object({
  jsonrpc: JSONRPCVersionSchema,
  id: JSONRPCIdSchema.optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

export const JSONRPCResponseSchema = z.object({
  jsonrpc: JSONRPCVersionSchema,
  id: JSONRPCIdSchema,
  result: z.unknown().optional(),
  error: JSONRPCErrorSchema.optional(),
}).refine(
  (data) => Boolean(data.result) !== Boolean(data.error),
  { message: 'Response must have either result or error, but not both' }
);

export const JSONRPCNotificationSchema = z.object({
  jsonrpc: JSONRPCVersionSchema,
  method: z.string(),
  params: z.unknown().optional(),
});

export const JSONRPCBatchSchema = z.array(
  z.union([JSONRPCRequestSchema, JSONRPCNotificationSchema])
).min(1);

export const JSONRPCMessageSchema = z.union([
  JSONRPCRequestSchema,
  JSONRPCResponseSchema,
  JSONRPCNotificationSchema,
  JSONRPCBatchSchema,
]);

// MCP specific schemas
export const MCPCapabilitiesSchema = z.object({
  tools: z.boolean().optional(),
  resources: z.boolean().optional(),
  prompts: z.boolean().optional(),
  sampling: z.boolean().optional(),
  roots: z.boolean().optional(),
});

export const MCPClientInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export const MCPServerInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export const MCPInitializeRequestSchema = z.object({
  jsonrpc: JSONRPCVersionSchema,
  id: JSONRPCIdSchema,
  method: z.literal('initialize'),
  params: z.object({
    protocolVersion: z.string(),
    capabilities: MCPCapabilitiesSchema,
    clientInfo: MCPClientInfoSchema,
  }),
});

export const MCPInitializeResponseSchema = z.object({
  jsonrpc: JSONRPCVersionSchema,
  id: JSONRPCIdSchema,
  result: z.object({
    protocolVersion: z.string(),
    capabilities: MCPCapabilitiesSchema,
    serverInfo: MCPServerInfoSchema,
  }),
});

export const MCPInitializedNotificationSchema = z.object({
  jsonrpc: JSONRPCVersionSchema,
  method: z.literal('notifications/initialized'),
  params: z.object({}).optional(),
});

// Configuration schemas
export const ServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  endpoint: z.string().optional(),
});

export const CorsConfigSchema = z.object({
  origins: z.array(z.string()).default(['*']),
  credentials: z.boolean().default(true),
});

export const AuthConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('none'),
  }),
  z.object({
    type: z.literal('bearer'),
    tokens: z.array(z.string()).min(1),
  }),
]);

export const ProxyConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8080),
  host: z.string().default('127.0.0.1'),
  sessionTimeout: z.number().min(0).default(3600000), // 1 hour
  batchTimeout: z.number().min(0).default(5000), // 5 seconds
  cors: CorsConfigSchema.default({
    origins: ['*'],
    credentials: true,
  }),
  auth: AuthConfigSchema.optional(),
  servers: z.array(ServerConfigSchema).min(1),
});

// HTTP request/response schemas
export const HTTPHeadersSchema = z.record(z.string());

export const StreamableHTTPRequestSchema = z.object({
  method: z.enum(['POST', 'GET', 'DELETE']),
  headers: HTTPHeadersSchema,
  body: z.unknown().optional(),
  sessionId: z.string().uuid().optional(),
});

// Session schema
export const SessionStateSchema = z.enum([
  'initializing',
  'ready',
  'error',
  'terminated',
]);

// Validation helpers
export function validateJSONRPC(data: unknown): z.infer<typeof JSONRPCMessageSchema> {
  return JSONRPCMessageSchema.parse(data);
}

export function validateProxyConfig(data: unknown): z.infer<typeof ProxyConfigSchema> {
  return ProxyConfigSchema.parse(data);
}

export function validateServerConfig(data: unknown): z.infer<typeof ServerConfigSchema> {
  return ServerConfigSchema.parse(data);
}

// Type exports
export type JSONRPCRequest = z.infer<typeof JSONRPCRequestSchema>;
export type JSONRPCResponse = z.infer<typeof JSONRPCResponseSchema>;
export type JSONRPCNotification = z.infer<typeof JSONRPCNotificationSchema>;
export type JSONRPCBatch = z.infer<typeof JSONRPCBatchSchema>;
export type JSONRPCMessage = z.infer<typeof JSONRPCMessageSchema>;

export type MCPInitializeRequest = z.infer<typeof MCPInitializeRequestSchema>;
export type MCPInitializeResponse = z.infer<typeof MCPInitializeResponseSchema>;
export type MCPCapabilities = z.infer<typeof MCPCapabilitiesSchema>;

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type CorsConfig = z.infer<typeof CorsConfigSchema>;

// Error creation helpers
export function createJSONRPCError(
  code: number,
  message: string,
  data?: unknown
): z.infer<typeof JSONRPCErrorSchema> {
  return {
    code,
    message,
    ...(data !== undefined && { data }),
  };
}

export function createParseError(data?: unknown) {
  return createJSONRPCError(-32700, 'Parse error', data);
}

export function createInvalidRequest(data?: unknown) {
  return createJSONRPCError(-32600, 'Invalid Request', data);
}

export function createMethodNotFound(method: string) {
  return createJSONRPCError(-32601, 'Method not found', { method });
}

export function createInvalidParams(data?: unknown) {
  return createJSONRPCError(-32602, 'Invalid params', data);
}

export function createInternalError(data?: unknown) {
  return createJSONRPCError(-32603, 'Internal error', data);
}

export function createServerError(message: string, data?: unknown) {
  return createJSONRPCError(-32000, message, data);
}
