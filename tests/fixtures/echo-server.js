#!/usr/bin/env node

/**
 * Simple Echo MCP Server for Testing
 * Responds to stdin with appropriate JSON-RPC responses
 */

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Log to stderr
function log(message) {
  process.stderr.write(`[echo-server] ${message}\n`);
}

// Send response to stdout
function send(response) {
  process.stdout.write(JSON.stringify(response) + '\n');
}

// Handle incoming messages
rl.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    log(`Received: ${message.method || 'response'}`);
    
    // Handle different message types
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {
            tools: true,
            resources: true,
            prompts: true,
            samples: true,
            roots: true,
          },
          serverInfo: {
            name: 'echo-server',
            version: '1.0.0',
          },
        },
      });
    } else if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echoes back the input',
              inputSchema: {
                type: 'object',
                properties: {
                  message: {
                    type: 'string',
                    description: 'Message to echo',
                  },
                },
                required: ['message'],
              },
            },
          ],
        },
      });
    } else if (message.method === 'tools/call') {
      const params = message.params || {};
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [
            {
              type: 'text',
              text: `Echo: ${params.arguments?.message || 'no message'}`,
            },
          ],
        },
      });
    } else if (message.method === 'resources/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          resources: [
            {
              uri: 'echo://test',
              name: 'Test Resource',
              description: 'A test resource',
              mimeType: 'text/plain',
            },
          ],
        },
      });
    } else if (message.method === 'resources/read') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          contents: [
            {
              uri: message.params?.uri || 'echo://test',
              mimeType: 'text/plain',
              text: 'This is test content',
            },
          ],
        },
      });
    } else if (message.method === 'prompts/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          prompts: [
            {
              name: 'test-prompt',
              description: 'A test prompt',
              arguments: [
                {
                  name: 'input',
                  description: 'Input text',
                  required: true,
                },
              ],
            },
          ],
        },
      });
    } else if (message.method === 'prompts/get') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          description: 'Test prompt',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Test prompt with input: ${message.params?.arguments?.input || 'none'}`,
              },
            },
          ],
        },
      });
    } else if (message.method === 'sampling/createMessage') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          role: 'assistant',
          content: {
            type: 'text',
            text: 'Sample response from echo server',
          },
        },
      });
    } else if (message.method === 'roots/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          roots: [
            {
              uri: 'echo://root',
              name: 'Echo Root',
            },
          ],
        },
      });
    } else if (message.method === 'notifications/initialized') {
      // Notification - no response needed
      log('Received initialized notification');
    } else if (message.method) {
      // Unknown method
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: 'Method not found',
          data: { method: message.method },
        },
      });
    }
  } catch (error) {
    log(`Error: ${error.message}`);
    send({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
        data: error.message,
      },
    });
  }
});

// Handle process termination
process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down');
  process.exit(0);
});

log('Echo server started, waiting for input...');
