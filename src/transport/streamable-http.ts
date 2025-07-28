import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { transportLogger as logger } from '../utils/logger.js';
import type { 
  JSONRPCMessage, 
  JSONRPCRequest, 
  JSONRPCResponse, 
  SSEEvent 
} from '../types/index.js';
import { 
  JSONRPCMessageSchema,
  JSONRPCBatchSchema,
  createParseError,
  createInternalError
} from '../validation/schemas.js';

export interface StreamableHTTPOptions {
  batchTimeout: number;
  sessionHeader?: string;
  maxEventSize?: number;
}

export class StreamableHTTPTransport extends EventEmitter {
  private readonly batchTimeout: number;
  private readonly sessionHeader: string;
  private readonly maxEventSize: number;
  private eventCounter: number;

  constructor(options: StreamableHTTPOptions) {
    super();
    this.batchTimeout = options.batchTimeout;
    this.sessionHeader = options.sessionHeader || 'Mcp-Session-Id';
    this.maxEventSize = options.maxEventSize || 1024 * 64; // 64KB default
    this.eventCounter = 0;
  }

  /**
   * Parse incoming JSON-RPC message from request body
   */
  parseRequest(body: unknown): JSONRPCMessage | JSONRPCMessage[] | null {
    try {
      // Validate against schema
      const result = JSONRPCMessageSchema.safeParse(body);
      
      if (!result.success) {
        logger.warn({ error: result.error }, 'Invalid JSON-RPC message');
        return null;
      }
      
      return result.data;
    } catch (error) {
      logger.error({ err: error }, 'Failed to parse JSON-RPC message');
      return null;
    }
  }

  /**
   * Check if request accepts SSE
   */
  acceptsSSE(req: Request): boolean {
    const accept = req.headers['accept'];
    return accept?.includes('text/event-stream') || false;
  }

  /**
   * Check if request accepts JSON
   */
  acceptsJSON(req: Request): boolean {
    const accept = req.headers['accept'];
    return accept?.includes('application/json') !== false;
  }

  /**
   * Get session ID from request headers
   */
  getSessionId(req: Request): string | undefined {
    const sessionId = req.headers[this.sessionHeader.toLowerCase()];
    return typeof sessionId === 'string' ? sessionId : undefined;
  }

  /**
   * Set session ID in response headers
   */
  setSessionId(res: Response, sessionId: string): void {
    res.setHeader(this.sessionHeader, sessionId);
  }

  /**
   * Send JSON response
   */
  sendJSON(res: Response, data: unknown, statusCode = 200): void {
    res.status(statusCode)
       .setHeader('Content-Type', 'application/json')
       .json(data);
  }

  /**
   * Send empty accepted response
   */
  sendAccepted(res: Response, sessionId?: string): void {
    if (sessionId) {
      this.setSessionId(res, sessionId);
    }
    res.status(202).end();
  }

  /**
   * Send error response
   */
  sendError(
    res: Response, 
    error: JSONRPCResponse['error'], 
    statusCode = 400
  ): void {
    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id: null,
      error,
    };
    this.sendJSON(res, response, statusCode);
  }

  /**
   * Initialize SSE stream
   */
  initSSE(res: Response, sessionId?: string): void {
    // Set headers for SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering
      ...(sessionId && { [this.sessionHeader]: sessionId }),
    });

    // Send initial comment to establish connection
    res.write(':ok\n\n');
    
    // Keep connection alive with periodic comments
    const keepAlive = setInterval(() => {
      res.write(':keepalive\n\n');
    }, 30000);

    // Clean up on close
    res.on('close', () => {
      clearInterval(keepAlive);
      logger.debug({ sessionId }, 'SSE connection closed');
    });
  }

  /**
   * Send SSE event
   */
  sendSSEEvent(res: Response, event: SSEEvent): void {
    try {
      const eventData = this.formatSSEEvent(event);
      
      // Check event size
      if (eventData.length > this.maxEventSize) {
        logger.warn({ 
          size: eventData.length, 
          maxSize: this.maxEventSize 
        }, 'SSE event exceeds maximum size');
      }
      
      res.write(eventData);
    } catch (error) {
      logger.error({ err: error }, 'Failed to send SSE event');
    }
  }

  /**
   * Send JSON-RPC message as SSE event
   */
  sendSSEMessage(res: Response, message: JSONRPCMessage): void {
    const event: SSEEvent = {
      id: String(++this.eventCounter),
      event: 'message',
      data: JSON.stringify(message),
    };
    this.sendSSEEvent(res, event);
  }

  /**
   * Format SSE event according to spec
   */
  private formatSSEEvent(event: SSEEvent): string {
    let output = '';
    
    if (event.id) {
      output += `id: ${event.id}\n`;
    }
    
    if (event.event) {
      output += `event: ${event.event}\n`;
    }
    
    if (event.retry) {
      output += `retry: ${event.retry}\n`;
    }
    
    // Split data by newlines and send each line separately
    const lines = event.data.split('\n');
    for (const line of lines) {
      output += `data: ${line}\n`;
    }
    
    // End of event
    output += '\n';
    
    return output;
  }

  /**
   * Handle batch responses with timeout
   */
  async collectBatchResponses(
    responses: AsyncGenerator<JSONRPCMessage>
  ): Promise<JSONRPCMessage[]> {
    const collected: JSONRPCMessage[] = [];
    const deadline = Date.now() + this.batchTimeout;
    
    try {
      for await (const response of responses) {
        collected.push(response);
        
        // Check timeout
        if (Date.now() >= deadline) {
          logger.warn('Batch timeout reached, returning partial results');
          break;
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error collecting batch responses');
    }
    
    return collected;
  }

  /**
   * Stream responses via SSE
   */
  async streamResponses(
    res: Response,
    responses: AsyncGenerator<JSONRPCMessage>
  ): Promise<void> {
    try {
      for await (const response of responses) {
        this.sendSSEMessage(res, response);
      }
    } catch (error) {
      logger.error({ err: error }, 'Error streaming responses');
      
      // Send error event if still connected
      if (!res.writableEnded) {
        const errorResponse: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: null,
          error: createInternalError(String(error)),
        };
        this.sendSSEMessage(res, errorResponse);
      }
    } finally {
      // Close the stream
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

  /**
   * Check if message requires response
   */
  requiresResponse(message: JSONRPCMessage): boolean {
    return 'id' in message && message.id !== null && message.id !== undefined;
  }

  /**
   * Check if this is an initialization request
   */
  isInitializeRequest(message: unknown): boolean {
    return (
      typeof message === 'object' &&
      message !== null &&
      'method' in message &&
      message.method === 'initialize'
    );
  }

  /**
   * Check if this is an initialized notification
   */
  isInitializedNotification(message: unknown): boolean {
    return (
      typeof message === 'object' &&
      message !== null &&
      'method' in message &&
      message.method === 'notifications/initialized' &&
      !('id' in message)
    );
  }

  /**
   * Create error response for request
   */
  createErrorResponse(
    request: JSONRPCRequest,
    error: JSONRPCResponse['error']
  ): JSONRPCResponse {
    return {
      jsonrpc: '2.0',
      id: request.id || null,
      error,
    };
  }

  /**
   * Validate HTTP method
   */
  validateMethod(req: Request, res: Response): boolean {
    const method = req.method;
    
    if (method === 'POST' || method === 'GET' || method === 'DELETE') {
      return true;
    }
    
    res.status(405)
       .setHeader('Allow', 'POST, GET, DELETE')
       .json({ error: 'Method not allowed' });
    
    return false;
  }

  /**
   * Validate content type for POST requests
   */
  validateContentType(req: Request, res: Response): boolean {
    if (req.method !== 'POST') {
      return true;
    }
    
    const contentType = req.headers['content-type'];
    if (!contentType?.includes('application/json')) {
      res.status(415).json({ 
        error: 'Unsupported Media Type',
        expected: 'application/json'
      });
      return false;
    }
    
    return true;
  }

  /**
   * Validate Accept header
   */
  validateAcceptHeader(req: Request, res: Response): boolean {
    const accept = req.headers['accept'];
    
    if (!accept) {
      res.status(406).json({ 
        error: 'Not Acceptable',
        message: 'Accept header required'
      });
      return false;
    }
    
    const validTypes = ['application/json', 'text/event-stream', '*/*'];
    const hasValidType = validTypes.some(type => accept.includes(type));
    
    if (!hasValidType) {
      res.status(406).json({ 
        error: 'Not Acceptable',
        supported: validTypes
      });
      return false;
    }
    
    return true;
  }
}

// Helper function to check if a message is a batch
export function isBatch(message: unknown): message is JSONRPCMessage[] {
  return Array.isArray(message);
}

// Helper function to ensure message is array
export function ensureArray(
  message: JSONRPCMessage | JSONRPCMessage[]
): JSONRPCMessage[] {
  return Array.isArray(message) ? message : [message];
}
