import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { serverLogger as logger, requestLogger } from '../utils/logger.js';
import { MCPProxyServer } from '../proxy/server.js';
import { StreamableHTTPTransport } from '../transport/streamable-http.js';
import type { ProxyConfig, AuthenticatedRequest } from '../types/index.js';
import { 
  createParseError,
  createInvalidRequest,
  createServerError
} from '../validation/schemas.js';

export class HTTPServer {
  private app: Application;
  private proxy: MCPProxyServer;
  private transport: StreamableHTTPTransport;
  private config: ProxyConfig;
  private server?: ReturnType<Application['listen']>;

  constructor(config: ProxyConfig) {
    this.config = config;
    this.app = express();
    
    // Initialize proxy and transport
    this.proxy = new MCPProxyServer(config);
    this.transport = new StreamableHTTPTransport({
      batchTimeout: config.batchTimeout,
    });
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandler();
  }

  private setupMiddleware(): void {
    // CORS configuration
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) {
          return callback(null, true);
        }
        
        // Check against allowed origins
        const allowed = this.config.cors.origins.includes('*') ||
                       this.config.cors.origins.includes(origin);
        
        if (allowed) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: this.config.cors.credentials,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id'],
      exposedHeaders: ['Mcp-Session-Id'],
    }));
    
    // JSON body parser with size limit
    this.app.use(express.json({
      limit: '10mb',
      strict: true,
    }));
    
    // Request logging
    this.app.use(requestLogger);
    
    // Authentication middleware
    if (this.config.auth?.type === 'bearer') {
      this.app.use(this.authMiddleware.bind(this));
    }
    
    // Health check endpoint (before auth)
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString(),
        sessions: this.proxy.getStats().sessions.totalSessions,
      });
    });
  }

  private authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    // Skip auth for health endpoint
    if (req.path === '/health') {
      return next();
    }
    
    if (!this.config.auth || this.config.auth.type === 'none') {
      return next();
    }
    
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }
    
    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      res.status(401).json({ error: 'Invalid authorization format' });
      return;
    }
    
    if (this.config.auth.type === 'bearer' && !this.config.auth.tokens.includes(token)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }
    
    next();
  }

  private setupRoutes(): void {
    // Stats endpoint
    this.app.get('/stats', (req, res) => {
      res.json(this.proxy.getStats());
    });
    
    // MCP server endpoints (dynamic based on config)
    for (const server of this.config.servers) {
      const endpoint = server.endpoint || `/${server.name}`;
      
      logger.info({ endpoint, server: server.name }, 'Registering MCP endpoint');
      
      // POST - Handle JSON-RPC requests
      this.app.post(endpoint, this.handleMCPRequest.bind(this, endpoint));
      
      // GET - SSE stream for server-initiated messages
      this.app.get(endpoint, this.handleSSERequest.bind(this, endpoint));
      
      // DELETE - Terminate session
      this.app.delete(endpoint, this.handleDeleteSession.bind(this));
    }
    
    // Default MCP endpoint (if no specific server requested)
    if (this.config.servers.length === 1) {
      const defaultServer = this.config.servers[0];
      const defaultEndpoint = defaultServer?.endpoint || `/${defaultServer?.name}`;
      
      this.app.post('/mcp', this.handleMCPRequest.bind(this, defaultEndpoint!));
      this.app.get('/mcp', this.handleSSERequest.bind(this, defaultEndpoint!));
      this.app.delete('/mcp', this.handleDeleteSession.bind(this));
    }
  }

  private async handleMCPRequest(
    serverEndpoint: string,
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      // Validate request
      if (!this.transport.validateContentType(req, res)) return;
      if (!this.transport.validateAcceptHeader(req, res)) return;
      
      // Get session ID
      const sessionId = this.transport.getSessionId(req);
      
      // Parse request body
      const message = this.transport.parseRequest(req.body);
      if (!message) {
        this.transport.sendError(res, createParseError());
        return;
      }
      
      // Handle batch or single request
      const isBatch = Array.isArray(message);
      const response = isBatch
        ? await this.proxy.handleBatch(sessionId, message, serverEndpoint)
        : await this.proxy.handleRequest(sessionId, message, serverEndpoint);
      
      // Check if this was an initialize request
      const isInitialize = this.transport.isInitializeRequest(
        isBatch ? message[0] : message
      );
      
      // Send response based on type and accept header
      if (response === null) {
        // Notification or response - send 202 Accepted
        this.transport.sendAccepted(res, sessionId);
      } else if (this.transport.acceptsSSE(req) && !isBatch) {
        // Stream response via SSE
        this.transport.initSSE(res, sessionId || undefined);
        
        // Create async generator for responses
        const responseGenerator = async function* () {
          yield response as any;
        };
        
        await this.transport.streamResponses(res, responseGenerator());
      } else {
        // Send JSON response
        if (isInitialize && !Array.isArray(response) && 'id' in response) {
          // Extract session ID from successful initialize
          const session = this.findSessionFromResponse(response);
          if (session) {
            this.transport.setSessionId(res, session);
          }
        }
        
        this.transport.sendJSON(res, response);
      }
      
    } catch (error) {
      logger.error({ err: error, endpoint: serverEndpoint }, 'Error handling MCP request');
      this.transport.sendError(res, createServerError(String(error)), 500);
    }
  }

  private async handleSSERequest(
    serverEndpoint: string,
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      // Validate accept header
      if (!this.transport.acceptsSSE(req)) {
        res.status(406).json({ 
          error: 'Not Acceptable',
          message: 'Accept: text/event-stream required'
        });
        return;
      }
      
      // Get session ID
      const sessionId = this.transport.getSessionId(req);
      if (!sessionId) {
        res.status(400).json({ 
          error: 'Session ID required for SSE connection'
        });
        return;
      }
      
      // Verify session exists
      const session = this.proxy['sessionManager'].getSession(sessionId);
      if (!session) {
        res.status(404).json({ 
          error: 'Session not found'
        });
        return;
      }
      
      // Initialize SSE
      this.transport.initSSE(res, sessionId);
      
      // Register connection with session
      this.proxy['sessionManager'].addSSEConnection(sessionId, res);
      
      // Send any queued messages
      const queued = this.proxy['sessionManager'].dequeueMessages(sessionId);
      for (const message of queued) {
        this.transport.sendSSEMessage(res, message as any);
      }
      
      logger.info({ sessionId, endpoint: serverEndpoint }, 'SSE connection established');
      
    } catch (error) {
      logger.error({ err: error }, 'Error handling SSE request');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  private async handleDeleteSession(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = this.transport.getSessionId(req);
      if (!sessionId) {
        res.status(400).json({ 
          error: 'Session ID required'
        });
        return;
      }
      
      // Destroy session
      this.proxy['sessionManager'].destroySession(sessionId);
      
      res.status(204).end();
      
    } catch (error) {
      logger.error({ err: error }, 'Error deleting session');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  private findSessionFromResponse(response: unknown): string | null {
    // This is a placeholder - in a real implementation, we'd need to
    // track which session was created for the initialize request
    return null;
  }

  private setupErrorHandler(): void {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ 
        error: 'Not Found',
        path: req.path,
        method: req.method,
      });
    });
    
    // Global error handler
    this.app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
      logger.error({ err, url: req.url }, 'Unhandled error');
      
      if (res.headersSent) {
        return;
      }
      
      res.status(500).json({ 
        error: 'Internal Server Error',
        message: process.env['NODE_ENV'] === 'development' ? err.message : undefined,
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.config.port, this.config.host, () => {
          logger.info({ 
            port: this.config.port, 
            host: this.config.host 
          }, 'HTTP server started');
          resolve();
        });
        
        this.server.on('error', (error) => {
          logger.error({ err: error }, 'Server error');
          reject(error);
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<void> {
    logger.info('Stopping HTTP server');
    
    // Shutdown proxy
    await this.proxy.shutdown();
    
    // Close server
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      
      this.server.close((error) => {
        if (error) {
          logger.error({ err: error }, 'Error closing server');
          reject(error);
        } else {
          logger.info('HTTP server stopped');
          resolve();
        }
      });
    });
  }
}
