# MCP Proxy Server

A high-performance proxy server that bridges locally-running STDIO MCP (Model Context Protocol) servers to expose them externally as Streamable HTTP transport, enabling HTTP-only clients to access MCP servers without native HTTP support.

## Features

- 🚀 **Full MCP Specification Support** - Tools, resources, prompts, samples, and root
- 🔄 **Streamable HTTP Transport** - Modern protocol (2025-03-26 spec)
- 🐳 **Docker-First Design** - Alpine Linux containers for minimal footprint
- 🔐 **Security** - Bearer token auth, CORS, process isolation
- 📊 **Monitoring** - Health checks, statistics, structured logging
- ⚡ **High Performance** - Stream-based processing, connection pooling
- 🔁 **Reliability** - Automatic restart, session management, graceful shutdown

## Quick Start

### Using Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/zautke/mcp-proxy-server.git
cd mcp-proxy-server

# Start with Docker Compose
docker compose up

# Or for development with hot reload
docker compose -f compose.dev.yml up
```

### Local Installation

```bash
# Install dependencies (requires Node.js 20+ and pnpm)
pnpm install

# Build the project
pnpm run build

# Start the server
pnpm start
```

## Configuration

The proxy server can be configured via environment variables or a JSON configuration file.

### Environment Variables

```bash
# Server configuration
PORT=8080
HOST=0.0.0.0
SESSION_TIMEOUT=3600000  # 1 hour
BATCH_TIMEOUT=5000       # 5 seconds

# CORS
CORS_ORIGINS=http://localhost:3000,http://localhost:8000
CORS_CREDENTIALS=true

# Authentication
AUTH_TYPE=bearer
AUTH_TOKENS=secret-token-1,secret-token-2

# MCP Server configuration
SERVER_0_NAME=filesystem
SERVER_0_COMMAND=npx
SERVER_0_ARGS=-y @modelcontextprotocol/server-filesystem /data
SERVER_0_ENV_NODE_ENV=production

SERVER_1_NAME=github
SERVER_1_COMMAND=npx
SERVER_1_ARGS=-y @modelcontextprotocol/server-github
SERVER_1_ENV_GITHUB_TOKEN=${GITHUB_TOKEN}
```

### JSON Configuration

Create a `config/proxy.json` file:

```json
{
  "port": 8080,
  "host": "127.0.0.1",
  "sessionTimeout": 3600000,
  "batchTimeout": 5000,
  "cors": {
    "origins": ["http://localhost:3000"],
    "credentials": true
  },
  "auth": {
    "type": "bearer",
    "tokens": ["your-secret-token"]
  },
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  ]
}
```

## API Endpoints

### Health Check
```
GET /health
```

### Statistics
```
GET /stats
```

### MCP Server Endpoints

Each configured server gets its own endpoint:

```
POST /{server-name}  - Send JSON-RPC requests
GET /{server-name}   - Establish SSE stream
DELETE /{server-name} - Terminate session
```

### Default Endpoint

If only one server is configured:
```
POST /mcp
GET /mcp
DELETE /mcp
```

## Usage Examples

### Initialize Session

```bash
curl -X POST http://localhost:8080/filesystem \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "init-1",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {
        "tools": true,
        "resources": true
      },
      "clientInfo": {
        "name": "my-client",
        "version": "1.0.0"
      }
    }
  }'
```

### List Tools

```bash
curl -X POST http://localhost:8080/filesystem \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id>" \
  -d '{
    "jsonrpc": "2.0",
    "id": "tools-1",
    "method": "tools/list"
  }'
```

### Establish SSE Stream

```bash
curl -N http://localhost:8080/filesystem \
  -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: <session-id>"
```

## Architecture

```
┌─────────────────┐      ┌──────────────────┐      ┌────────────────┐
│  HTTP Client    │ ←──→ │   Proxy Server   │ ←──→ │  STDIO Server  │
│  (External)     │ HTTP │   (Container)    │ STDIO│  (Container)   │
└─────────────────┘      └──────────────────┘      └────────────────┘
                         ↑                    ↑
                    Session Manager      Process Manager
```

## Development

### Project Structure

```
mcp-proxy-server/
├── src/
│   ├── config/        # Configuration management
│   ├── process/       # STDIO process management
│   ├── proxy/         # Core proxy logic
│   ├── server/        # HTTP server
│   ├── session/       # Session management
│   ├── transport/     # Streamable HTTP transport
│   ├── types/         # TypeScript types
│   ├── utils/         # Utilities and logging
│   └── validation/    # Zod schemas
├── tests/            # Test suites
├── docs/             # Documentation
└── config/           # Configuration examples
```

### Testing

```bash
# Run tests
pnpm test

# Run with coverage
pnpm run test:coverage

# Run tests in watch mode
pnpm run test:watch
```

### Building

```bash
# Build TypeScript
pnpm run build

# Build Docker image
docker build -t mcp-proxy-server .

# Build with Docker Compose
docker compose build
```

## Security Considerations

1. **Process Isolation**: Each STDIO server runs in a separate process
2. **Authentication**: Bearer token support for API access
3. **CORS**: Configurable origin restrictions
4. **Input Validation**: All inputs validated with Zod schemas
5. **Session Timeout**: Automatic session cleanup
6. **Rate Limiting**: Built-in connection limits
7. **Non-root Container**: Runs as non-root user in Docker

## Performance

- Stream-based message processing
- Connection pooling for SSE
- Efficient message queuing
- Minimal memory footprint (~50MB container)
- Automatic process restart on crash
- Graceful shutdown handling

## Monitoring

### Health Check
Monitor `/health` endpoint for service availability.

### Statistics
The `/stats` endpoint provides:
- Active sessions count
- Process information
- SSE connections
- Message queue sizes

### Logging
Structured JSON logging with Pino:
- Request/response logging
- Process lifecycle events
- Error tracking with context
- Performance metrics

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests to our repository.

## License

MIT License - See LICENSE file for details

## Author

Luke Zautke (@zautke)

## Acknowledgments

- Anthropic for the MCP specification
- OpenAI for MCP adoption
- The MCP community for server implementations
