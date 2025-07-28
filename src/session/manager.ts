import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { sessionLogger as logger } from '../utils/logger.js';
import type { Session, ServerConfig } from '../types/index.js';
import type { Response } from 'express';
import type { ManagedProcess } from '../process/manager.js';

export interface SessionManagerOptions {
  sessionTimeout: number;
  cleanupInterval?: number;
  maxSessions?: number;
}

export interface SessionEvents {
  'session:created': (session: Session) => void;
  'session:initialized': (sessionId: string) => void;
  'session:expired': (sessionId: string) => void;
  'session:destroyed': (sessionId: string) => void;
  'session:activity': (sessionId: string) => void;
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session>;
  private readonly sessionTimeout: number;
  private readonly maxSessions: number;
  private cleanupTimer?: NodeJS.Timer;

  constructor(options: SessionManagerOptions) {
    super();
    this.sessions = new Map();
    this.sessionTimeout = options.sessionTimeout;
    this.maxSessions = options.maxSessions || 100;
    
    // Start cleanup timer if timeout is set
    if (this.sessionTimeout > 0) {
      const interval = options.cleanupInterval || Math.min(60000, this.sessionTimeout / 2);
      this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), interval);
    }

    logger.info({
      sessionTimeout: this.sessionTimeout,
      maxSessions: this.maxSessions,
    }, 'Session manager initialized');
  }

  createSession(serverConfig: ServerConfig, process?: ManagedProcess): Session {
    // Check session limit
    if (this.sessions.size >= this.maxSessions) {
      // Try to clean up expired sessions first
      this.cleanupExpiredSessions();
      
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Maximum session limit (${this.maxSessions}) reached`);
      }
    }

    const sessionId = randomUUID();
    const now = new Date();
    
    const session: Session = {
      id: sessionId,
      createdAt: now,
      lastActivityAt: now,
      serverConfig,
      stdioProcess: process,
      messageQueue: [],
      isInitialized: false,
      sseConnections: new Set(),
    };

    this.sessions.set(sessionId, session);
    
    logger.info({ 
      sessionId, 
      serverName: serverConfig.name 
    }, 'Session created');
    
    this.emit('session:created', session);
    
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    
    if (session) {
      // Check if session has expired
      if (this.isSessionExpired(session)) {
        this.destroySession(sessionId);
        return undefined;
      }
      
      // Update last activity
      this.updateSessionActivity(sessionId);
    }
    
    return session;
  }

  updateSessionActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
      this.emit('session:activity', sessionId);
    }
  }

  setSessionInitialized(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isInitialized = true;
      logger.info({ sessionId }, 'Session initialized');
      this.emit('session:initialized', sessionId);
    }
  }

  attachProcess(sessionId: string, process: ManagedProcess): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.stdioProcess = process;
      logger.debug({ sessionId, processId: process.id }, 'Process attached to session');
    }
  }

  addSSEConnection(sessionId: string, response: Response): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sseConnections.add(response);
      
      // Remove connection when closed
      response.on('close', () => {
        session.sseConnections.delete(response);
        logger.debug({ 
          sessionId, 
          activeConnections: session.sseConnections.size 
        }, 'SSE connection closed');
      });
      
      logger.debug({ 
        sessionId, 
        activeConnections: session.sseConnections.size 
      }, 'SSE connection added');
    }
  }

  removeSSEConnection(sessionId: string, response: Response): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sseConnections.delete(response);
    }
  }

  getActiveSSEConnections(sessionId: string): Set<Response> {
    const session = this.sessions.get(sessionId);
    return session?.sseConnections || new Set();
  }

  queueMessage(sessionId: string, message: unknown): void {
    const session = this.sessions.get(sessionId);
    if (session && typeof message === 'object' && message !== null) {
      session.messageQueue.push(message as any);
      logger.debug({ 
        sessionId, 
        queueSize: session.messageQueue.length 
      }, 'Message queued');
    }
  }

  dequeueMessages(sessionId: string): unknown[] {
    const session = this.sessions.get(sessionId);
    if (session) {
      const messages = [...session.messageQueue];
      session.messageQueue = [];
      return messages;
    }
    return [];
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Close all SSE connections
    for (const connection of session.sseConnections) {
      try {
        connection.end();
      } catch (error) {
        logger.warn({ sessionId, err: error }, 'Error closing SSE connection');
      }
    }

    // Clear connections
    session.sseConnections.clear();

    // Remove session
    this.sessions.delete(sessionId);
    
    logger.info({ sessionId }, 'Session destroyed');
    this.emit('session:destroyed', sessionId);
  }

  private isSessionExpired(session: Session): boolean {
    if (this.sessionTimeout <= 0) {
      return false;
    }
    
    const now = Date.now();
    const lastActivity = session.lastActivityAt.getTime();
    return (now - lastActivity) > this.sessionTimeout;
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const expired: string[] = [];
    
    for (const [sessionId, session] of this.sessions) {
      if (this.isSessionExpired(session)) {
        expired.push(sessionId);
      }
    }
    
    if (expired.length > 0) {
      logger.info({ count: expired.length }, 'Cleaning up expired sessions');
      
      for (const sessionId of expired) {
        this.emit('session:expired', sessionId);
        this.destroySession(sessionId);
      }
    }
  }

  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  shutdown(): void {
    logger.info('Shutting down session manager');
    
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    
    // Destroy all sessions
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      this.destroySession(sessionId);
    }
    
    // Clear event listeners
    this.removeAllListeners();
  }

  // Statistics and monitoring
  getStats(): SessionStats {
    const sessions = Array.from(this.sessions.values());
    const now = Date.now();
    
    return {
      totalSessions: sessions.length,
      initializedSessions: sessions.filter(s => s.isInitialized).length,
      activeSessions: sessions.filter(s => 
        (now - s.lastActivityAt.getTime()) < 60000
      ).length,
      totalSSEConnections: sessions.reduce(
        (sum, s) => sum + s.sseConnections.size, 
        0
      ),
      averageQueueSize: sessions.reduce(
        (sum, s) => sum + s.messageQueue.length, 
        0
      ) / (sessions.length || 1),
      oldestSession: sessions.reduce(
        (oldest, s) => s.createdAt < oldest ? s.createdAt : oldest,
        new Date()
      ),
      newestSession: sessions.reduce(
        (newest, s) => s.createdAt > newest ? s.createdAt : newest,
        new Date(0)
      ),
    };
  }
}

export interface SessionStats {
  totalSessions: number;
  initializedSessions: number;
  activeSessions: number;
  totalSSEConnections: number;
  averageQueueSize: number;
  oldestSession: Date;
  newestSession: Date;
}

// Helper class for session-scoped operations
export class SessionContext {
  constructor(
    private manager: SessionManager,
    private sessionId: string
  ) {}

  get session(): Session | undefined {
    return this.manager.getSession(this.sessionId);
  }

  get isValid(): boolean {
    return this.manager.hasSession(this.sessionId);
  }

  get isInitialized(): boolean {
    return this.session?.isInitialized || false;
  }

  updateActivity(): void {
    this.manager.updateSessionActivity(this.sessionId);
  }

  setInitialized(): void {
    this.manager.setSessionInitialized(this.sessionId);
  }

  queueMessage(message: unknown): void {
    this.manager.queueMessage(this.sessionId, message);
  }

  dequeueMessages(): unknown[] {
    return this.manager.dequeueMessages(this.sessionId);
  }

  addSSEConnection(response: Response): void {
    this.manager.addSSEConnection(this.sessionId, response);
  }

  destroy(): void {
    this.manager.destroySession(this.sessionId);
  }
}
