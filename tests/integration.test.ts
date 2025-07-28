import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { HTTPServer } from '../src/server/http.js';
import type { ProxyConfig } from '../src/types/index.js';
import fetch from 'node-fetch';

describe('MCP Proxy Server Integration Tests', () => {
  let server: HTTPServer;
  const testPort = 18080;
  const baseUrl = `http://127.0.0.1:${testPort}`;
  
  const config: ProxyConfig = {
    port: testPort,
    host: '127.0.0.1',
    sessionTimeout: 60000,
    batchTimeout: 1000,
    cors: {
      origins: ['*'],
      credentials: false,
    },
    auth: {
      type: 'none',
    },
    servers: [
      {
        name: 'test-echo',
        command: 'node',
        args: ['./tests/fixtures/echo-server.js'],
        env: {},
      },
    ],
  };

  beforeAll(async () => {
    server = new HTTPServer(config);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data).toHaveProperty('status', 'ok');
      expect(data).toHaveProperty('timestamp');
      expect(data).toHaveProperty('sessions');
    });
  });

  describe('Stats Endpoint', () => {
    it('should return server statistics', async () => {
      const response = await fetch(`${baseUrl}/stats`);
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data).toHaveProperty('sessions');
      expect(data).toHaveProperty('processes');
      expect(data).toHaveProperty('servers');
    });
  });

  describe('MCP Initialize Request', () => {
    it('should handle initialize request', async () => {
      const initRequest = {
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: true,
            resources: true,
          },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      };

      const response = await fetch(`${baseUrl}/test-echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(initRequest),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
      
      const data = await response.json();
      expect(data).toHaveProperty('jsonrpc', '2.0');
      expect(data).toHaveProperty('id', 'init-1');
      expect(data).toHaveProperty('result');
    });
  });

  describe('SSE Stream', () => {
    it('should establish SSE connection with session', async () => {
      // First initialize a session
      const initRequest = {
        jsonrpc: '2.0',
        id: 'init-2',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      };

      const initResponse = await fetch(`${baseUrl}/test-echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(initRequest),
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      // Try to establish SSE connection
      const sseResponse = await fetch(`${baseUrl}/test-echo`, {
        method: 'GET',
        headers: {
          'Accept': 'text/event-stream',
          'Mcp-Session-Id': sessionId!,
        },
      });

      expect(sseResponse.status).toBe(200);
      expect(sseResponse.headers.get('content-type')).toContain('text/event-stream');
    });
  });

  describe('Session Management', () => {
    it('should delete session', async () => {
      // Create a session
      const initRequest = {
        jsonrpc: '2.0',
        id: 'init-3',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      };

      const initResponse = await fetch(`${baseUrl}/test-echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(initRequest),
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      // Delete the session
      const deleteResponse = await fetch(`${baseUrl}/test-echo`, {
        method: 'DELETE',
        headers: {
          'Mcp-Session-Id': sessionId!,
        },
      });

      expect(deleteResponse.status).toBe(204);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await fetch(`${baseUrl}/unknown`);
      expect(response.status).toBe(404);
    });

    it('should return 415 for invalid content type', async () => {
      const response = await fetch(`${baseUrl}/test-echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'Accept': 'application/json',
        },
        body: 'invalid',
      });

      expect(response.status).toBe(415);
    });

    it('should return parse error for invalid JSON', async () => {
      const response = await fetch(`${baseUrl}/test-echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: 'not json',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toHaveProperty('error');
    });
  });

  describe('Batch Requests', () => {
    it('should handle batch requests', async () => {
      const batchRequest = [
        {
          jsonrpc: '2.0',
          id: 'batch-1',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {},
        },
      ];

      const response = await fetch(`${baseUrl}/test-echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(batchRequest),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });
  });
});
