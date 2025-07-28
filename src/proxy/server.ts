import { EventEmitter } from 'node:events';
import { proxyLogger as logger } from '../utils/logger.js';
import { ProcessManager, ManagedProcess } from '../process/manager.js';
import { SessionManager, SessionContext } from '../session/manager.js';
import { StreamableHTTPTransport } from '../transport/streamable-http.js';
import type { 
  ProxyConfig, 
  ServerConfig, 
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  Session
} from '../types/index.js';
import {
  validateJSONRPC,
  createInternalError,
  createServerError,
  createMethodNotFound,
  MCPInitializeRequestSchema
} from '../validation/schemas.js';

export interface ProxyServerOptions extends ProxyConfig {
  maxRestartAttempts?: number;
  restartDelay?: number;
}

export class MCPProxyServer extends EventEmitter {
  private processManager: ProcessManager;
  private sessionManager: SessionManager;
  private transport: StreamableHTTPTransport;
  private config: ProxyConfig;
  private serverConfigs: Map<string, ServerConfig>;
  private isShuttingDown: boolean;

  constructor(options: ProxyServerOptions) {
    super();
    this.config = options;
    this.isShuttingDown = false;
    
    // Initialize server configs map
    this.serverConfigs = new Map();
    for (const server of options.servers) {
      const endpoint = server.endpoint || `/${server.name}`;
      this.serverConfigs.set(endpoint, server);
    }
    
    // Initialize components
    this.processManager = new ProcessManager(
      options.maxRestartAttempts,
      options.restartDelay
    );
    
    this.sessionManager = new SessionManager({
      sessionTimeout: options.sessionTimeout,
      cleanupInterval: 60000, // 1 minute
      maxSessions: 100,
    });
    
    this.transport = new StreamableHTTPTransport({
      batchTimeout: options.batchTimeout,
      sessionHeader: 'Mcp-Session-Id',
    });
    
    this.setupEventHandlers();
    
    logger.info({ 
      servers: Array.from(this.serverConfigs.keys()) 
    }, 'MCP Proxy Server initialized');
  }

  private setupEventHandlers(): void {
    // Process events
    this.processManager.on('stdout:data', (processId, data) => {
      this.handleProcessOutput(processId, data);
    });
    
    this.processManager.on('stderr:data', (processId, data) => {
      logger.debug({ processId, data }, 'Process stderr output');
    });
    
    this.processManager.on('process:crashed', (processId, error) => {
      logger.error({ processId, err: error }, 'Process crashed');
      // Session cleanup handled by session manager
    });
    
    // Session events
    this.sessionManager.on('session:expired', (sessionId) => {
      this.handleSessionExpired(sessionId);
    });
    
    this.sessionManager.on('session:destroyed', (sessionId) => {
      // Find and kill associated process
      const session = this.sessionManager.getSession(sessionId);
      if (session?.stdioProcess) {
        this.processManager.killProcess(session.stdioProcess.id);
      }
    });
  }

  private handleProcessOutput(processId: string, data: string): void {
    try {
      // Parse JSON-RPC message
      const message = JSON.parse(data);
      const validated = validateJSONRPC(message);
      
      // Find session for this process
      const session = this.findSessionByProcessId(processId);
      if (!session) {
        logger.warn({ processId }, 'No session found for process output');
        return;
      }
      
      // Handle the message based on type
      this.routeProcessMessage(session.id, validated);
      
    } catch (error) {
      logger.error({ 
        processId, 
        data, 
        err: error 
      }, 'Failed to parse process output');
    }
  }

  private findSessionByProcessId(processId: string): Session | undefined {
    const sessions = this.sessionManager.getAllSessions();
    return sessions.find(s => s.stdioProcess?.id === processId);
  }

  private routeProcessMessage(sessionId: string, message: JSONRPCMessage): void {
    const context = new SessionContext(this.sessionManager, sessionId);
    
    if (!context.isValid) {
      logger.warn({ sessionId }, 'Invalid session for process message');
      return;
    }
    
    // Check if this is an initialization response
    if (this.isInitializeResponse(message)) {
      context.setInitialized();
    }
    
    // Queue message for delivery
    context.queueMessage(message);
    
    // Send to active SSE connections
    const connections = this.sessionManager.getActiveSSEConnections(sessionId);
    for (const connection of connections) {
      this.transport.sendSSEMessage(connection, message);
    }
  }

  private isInitializeResponse(message: unknown): boolean {
    return (
      typeof message === 'object' &&
      message !== null &&
      'result' in message &&
      typeof (message as any).result === 'object' &&
      'serverInfo' in (message as any).result
    );
  }

  private handleSessionExpired(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (session?.stdioProcess) {
      this.processManager.killProcess(session.stdioProcess.id);
    }
  }

  /**
   * Handle incoming JSON-RPC request
   */
  async handleRequest(
    sessionId: string | undefined,
    message: JSONRPCMessage,
    serverEndpoint: string
  ): Promise<JSONRPCMessage | JSONRPCMessage[] | null> {
    try {
      // Get or create session
      let session: Session;
      const isInitialize = this.transport.isInitializeRequest(message);
      
      if (isInitialize) {
        // Create new session for initialize request
        const serverConfig = this.serverConfigs.get(serverEndpoint);
        if (!serverConfig) {
          throw new Error(`Unknown server endpoint: ${serverEndpoint}`);
        }
        
        session = await this.createSessionWithProcess(serverConfig);
        sessionId = session.id;
      } else {
        // Existing session required
        if (!sessionId) {
          throw new Error('Session ID required for non-initialize requests');
        }
        
        session = this.sessionManager.getSession(sessionId) || 
          (() => { throw new Error(`Session not found: ${sessionId}`); })();
      }
      
      // Forward to STDIO process
      if (!session.stdioProcess) {
        throw new Error('No process attached to session');
      }
      
      // Send message to process
      const messageStr = JSON.stringify(message);
      session.stdioProcess.sendToStdin(messageStr);
      
      // For requests that need responses, wait for them
      if (this.transport.requiresResponse(message)) {
        return await this.waitForResponse(sessionId, message as JSONRPCRequest);
      }
      
      return null;
      
    } catch (error) {
      logger.error({ 
        sessionId, 
        err: error 
      }, 'Error handling request');
      
      if ('id' in message) {
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: createInternalError(String(error)),
        };
      }
      
      throw error;
    }
  }

  private async createSessionWithProcess(serverConfig: ServerConfig): Promise<Session> {
    // Create session
    const session = this.sessionManager.createSession(serverConfig);
    
    try {
      // Spawn process
      const process = await this.processManager.spawnProcess(
        `session-${session.id}`,
        serverConfig
      );
      
      // Attach process to session
      this.sessionManager.attachProcess(session.id, process);
      session.stdioProcess = process;
      
      logger.info({ 
        sessionId: session.id, 
        server: serverConfig.name 
      }, 'Session created with process');
      
      return session;
      
    } catch (error) {
      // Clean up session on failure
      this.sessionManager.destroySession(session.id);
      throw error;
    }
  }

  private async waitForResponse(
    sessionId: string,
    request: JSONRPCRequest,
    timeout = 30000
  ): Promise<JSONRPCMessage> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = 100;
      
      const checkForResponse = () => {
        // Check if session still exists
        const context = new SessionContext(this.sessionManager, sessionId);
        if (!context.isValid) {
          reject(new Error('Session terminated while waiting for response'));
          return;
        }
        
        // Check message queue
        const messages = context.dequeueMessages();
        for (const msg of messages) {
          // Check if this is the response we're waiting for
          if (this.isResponseFor(msg, request)) {
            resolve(msg as JSONRPCMessage);
            return;
          }
          // Re-queue other messages
          context.queueMessage(msg);
        }
        
        // Check timeout
        if (Date.now() - startTime > timeout) {
          reject(new Error(`Response timeout for request ${request.id}`));
          return;
        }
        
        // Continue checking
        setTimeout(checkForResponse, checkInterval);
      };
      
      checkForResponse();
    });
  }

  private isResponseFor(message: unknown, request: JSONRPCRequest): boolean {
    return (
      typeof message === 'object' &&
      message !== null &&
      'id' in message &&
      (message as any).id === request.id &&
      ('result' in message || 'error' in message)
    );
  }

  /**
   * Handle batch requests
   */
  async handleBatch(
    sessionId: string | undefined,
    messages: JSONRPCMessage[],
    serverEndpoint: string
  ): Promise<JSONRPCMessage[]> {
    const responses: JSONRPCMessage[] = [];
    
    for (const message of messages) {
      try {
        const response = await this.handleRequest(sessionId, message, serverEndpoint);
        if (response && !Array.isArray(response)) {
          responses.push(response);
        }
      } catch (error) {
        logger.error({ err: error }, 'Error handling batch message');
        
        if ('id' in message) {
          responses.push({
            jsonrpc: '2.0',
            id: message.id,
            error: createInternalError(String(error)),
          });
        }
      }
    }
    
    return responses;
  }

  /**
   * Get server statistics
   */
  getStats(): ProxyStats {
    return {
      sessions: this.sessionManager.getStats(),
      processes: this.processManager.getAllProcesses(),
      servers: Array.from(this.serverConfigs.entries()).map(([endpoint, config]) => ({
        endpoint,
        name: config.name,
        command: config.command,
      })),
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    
    this.isShuttingDown = true;
    logger.info('Shutting down MCP Proxy Server');
    
    // Stop accepting new sessions
    this.sessionManager.shutdown();
    
    // Kill all processes
    this.processManager.killAllProcesses();
    
    // Remove all event listeners
    this.removeAllListeners();
    
    logger.info('MCP Proxy Server shutdown complete');
  }
}

export interface ProxyStats {
  sessions: ReturnType<SessionManager['getStats']>;
  processes: ReturnType<ProcessManager['getAllProcesses']>;
  servers: Array<{
    endpoint: string;
    name: string;
    command: string;
  }>;
}
