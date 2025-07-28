import pino from 'pino';
import type { Logger } from 'pino';

// Logger configuration based on environment
const isDevelopment = process.env['NODE_ENV'] === 'development';
const logLevel = process.env['LOG_LEVEL'] || (isDevelopment ? 'debug' : 'info');

// Create base logger configuration
const baseConfig: pino.LoggerOptions = {
  level: logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    bindings: (bindings) => ({
      pid: bindings.pid,
      hostname: bindings.hostname,
      node_version: process.version,
    }),
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: (req) => ({
      method: req.method,
      url: req.url,
      path: req.path,
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'x-session-id': req.headers['mcp-session-id'],
      },
    }),
    res: (res) => ({
      statusCode: res.statusCode,
      headers: {
        'content-type': res.getHeader('content-type'),
      },
    }),
  },
  // Redact sensitive information
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.password',
      '*.token',
      '*.secret',
      '*.env.GITHUB_TOKEN',
      '*.env.AUTH_TOKENS',
    ],
    censor: '[REDACTED]',
  },
};

// Development-specific configuration
const devConfig: pino.LoggerOptions = {
  ...baseConfig,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      errorProps: 'stack',
      messageFormat: '{msg} [{context}]',
    },
  },
};

// Production configuration - structured JSON logs
const prodConfig: pino.LoggerOptions = {
  ...baseConfig,
  messageKey: 'message',
  errorKey: 'error',
};

// Create the main logger
export const logger: Logger = pino(isDevelopment ? devConfig : prodConfig);

// Create child loggers for different components
export const createLogger = (component: string): Logger => {
  return logger.child({ component });
};

// Specific component loggers
export const serverLogger = createLogger('server');
export const proxyLogger = createLogger('proxy');
export const sessionLogger = createLogger('session');
export const processLogger = createLogger('process');
export const transportLogger = createLogger('transport');

// Utility functions for consistent logging
export interface LogContext {
  sessionId?: string;
  serverId?: string;
  requestId?: string;
  method?: string;
  [key: string]: unknown;
}

export function logInfo(message: string, context?: LogContext): void {
  logger.info(context || {}, message);
}

export function logError(message: string, error?: Error | unknown, context?: LogContext): void {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  logger.error({ ...context, err: errorObj }, message);
}

export function logWarn(message: string, context?: LogContext): void {
  logger.warn(context || {}, message);
}

export function logDebug(message: string, context?: LogContext): void {
  logger.debug(context || {}, message);
}

export function logFatal(message: string, error?: Error | unknown, context?: LogContext): void {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  logger.fatal({ ...context, err: errorObj }, message);
  // Fatal errors should terminate the process
  process.exit(1);
}

// Request/Response logging middleware for Express
import type { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestId = req.headers['x-request-id'] as string || `req-${Date.now()}`;
  
  // Attach request ID to request object
  (req as any).requestId = requestId;
  
  // Log incoming request
  serverLogger.info({
    req,
    requestId,
    sessionId: req.headers['mcp-session-id'],
  }, 'Incoming request');

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'error' : res.statusCode >= 300 ? 'warn' : 'info';
    
    serverLogger[level]({
      res,
      requestId,
      sessionId: req.headers['mcp-session-id'],
      duration,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
    }, 'Request completed');
  });

  next();
}

// Process lifecycle logging
export function setupProcessLogging(): void {
  process.on('uncaughtException', (error) => {
    logFatal('Uncaught exception', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logError('Unhandled rejection', reason, { promise: String(promise) });
  });

  process.on('SIGTERM', () => {
    logInfo('Received SIGTERM, shutting down gracefully');
  });

  process.on('SIGINT', () => {
    logInfo('Received SIGINT, shutting down gracefully');
  });

  process.on('exit', (code) => {
    logInfo('Process exiting', { exitCode: code });
  });
}

// Performance logging helpers
export class PerformanceTimer {
  private startTime: number;
  private marks: Map<string, number>;

  constructor(private context: LogContext = {}) {
    this.startTime = performance.now();
    this.marks = new Map();
  }

  mark(name: string): void {
    this.marks.set(name, performance.now());
  }

  logDuration(message: string, level: 'debug' | 'info' = 'debug'): void {
    const duration = performance.now() - this.startTime;
    const marks: Record<string, number> = {};
    
    for (const [name, time] of this.marks) {
      marks[name] = time - this.startTime;
    }

    logger[level]({
      ...this.context,
      duration,
      marks: Object.keys(marks).length > 0 ? marks : undefined,
    }, message);
  }
}

// Export logger type for use in other modules
export type { Logger };
