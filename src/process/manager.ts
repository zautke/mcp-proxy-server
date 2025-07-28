import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { processLogger as logger } from '../utils/logger.js';
import type { ServerConfig, ProcessInfo } from '../types/index.js';

export interface ProcessManagerEvents {
  'process:started': (processId: string, info: ProcessInfo) => void;
  'process:stopped': (processId: string, code: number | null) => void;
  'process:crashed': (processId: string, error: Error) => void;
  'process:restarted': (processId: string, attempt: number) => void;
  'stdout:data': (processId: string, data: string) => void;
  'stderr:data': (processId: string, data: string) => void;
}

export class ProcessManager extends EventEmitter {
  private processes: Map<string, ManagedProcess>;
  private restartAttempts: Map<string, number>;
  private readonly maxRestartAttempts: number;
  private readonly restartDelay: number;

  constructor(
    maxRestartAttempts = 3,
    restartDelay = 1000
  ) {
    super();
    this.processes = new Map();
    this.restartAttempts = new Map();
    this.maxRestartAttempts = maxRestartAttempts;
    this.restartDelay = restartDelay;
  }

  async spawnProcess(
    processId: string,
    config: ServerConfig
  ): Promise<ManagedProcess> {
    // Check if process already exists
    if (this.processes.has(processId)) {
      throw new Error(`Process ${processId} already exists`);
    }

    logger.info({ processId, config }, 'Spawning new process');

    const managedProcess = new ManagedProcess(processId, config);
    
    // Set up event handlers
    this.setupProcessHandlers(managedProcess);
    
    // Start the process
    await managedProcess.start();
    
    // Store the process
    this.processes.set(processId, managedProcess);
    
    // Emit started event
    this.emit('process:started', processId, managedProcess.getInfo());
    
    return managedProcess;
  }

  private setupProcessHandlers(managedProcess: ManagedProcess): void {
    const processId = managedProcess.id;

    managedProcess.on('stdout', (data: string) => {
      this.emit('stdout:data', processId, data);
    });

    managedProcess.on('stderr', (data: string) => {
      this.emit('stderr:data', processId, data);
    });

    managedProcess.on('error', (error: Error) => {
      logger.error({ processId, err: error }, 'Process error');
      this.emit('process:crashed', processId, error);
      this.handleProcessCrash(processId);
    });

    managedProcess.on('exit', (code: number | null) => {
      logger.info({ processId, exitCode: code }, 'Process exited');
      this.emit('process:stopped', processId, code);
      
      if (code !== 0) {
        this.handleProcessCrash(processId);
      }
    });
  }

  private async handleProcessCrash(processId: string): Promise<void> {
    const attempts = this.restartAttempts.get(processId) || 0;
    
    if (attempts >= this.maxRestartAttempts) {
      logger.error({ processId, attempts }, 'Max restart attempts reached');
      this.killProcess(processId);
      return;
    }

    logger.info({ processId, attempt: attempts + 1 }, 'Attempting to restart process');
    
    // Increment restart counter
    this.restartAttempts.set(processId, attempts + 1);
    
    // Wait before restarting
    await new Promise(resolve => setTimeout(resolve, this.restartDelay));
    
    // Restart the process
    const managedProcess = this.processes.get(processId);
    if (managedProcess) {
      try {
        await managedProcess.restart();
        this.emit('process:restarted', processId, attempts + 1);
      } catch (error) {
        logger.error({ processId, err: error }, 'Failed to restart process');
        this.handleProcessCrash(processId);
      }
    }
  }

  killProcess(processId: string): void {
    const managedProcess = this.processes.get(processId);
    if (!managedProcess) {
      logger.warn({ processId }, 'Process not found');
      return;
    }

    logger.info({ processId }, 'Killing process');
    managedProcess.kill();
    this.processes.delete(processId);
    this.restartAttempts.delete(processId);
  }

  killAllProcesses(): void {
    logger.info('Killing all processes');
    for (const [processId] of this.processes) {
      this.killProcess(processId);
    }
  }

  getProcess(processId: string): ManagedProcess | undefined {
    return this.processes.get(processId);
  }

  getAllProcesses(): ProcessInfo[] {
    return Array.from(this.processes.values()).map(p => p.getInfo());
  }

  isProcessRunning(processId: string): boolean {
    const process = this.processes.get(processId);
    return process?.isRunning() || false;
  }
}

export class ManagedProcess extends EventEmitter {
  public readonly id: string;
  private config: ServerConfig;
  private process?: ChildProcess;
  private startedAt?: Date;
  private restarts: number;
  private status: 'stopped' | 'running' | 'crashed';
  private stdoutBuffer: string;
  private stderrBuffer: string;

  constructor(id: string, config: ServerConfig) {
    super();
    this.id = id;
    this.config = config;
    this.restarts = 0;
    this.status = 'stopped';
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
  }

  async start(): Promise<void> {
    if (this.process && this.status === 'running') {
      throw new Error('Process is already running');
    }

    const spawnOptions: SpawnOptions = {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...this.config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    };

    logger.debug({ 
      id: this.id, 
      command: this.config.command, 
      args: this.config.args 
    }, 'Starting process');

    this.process = spawn(this.config.command, this.config.args, spawnOptions);
    this.startedAt = new Date();
    this.status = 'running';

    // Handle stdout
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      this.stdoutBuffer += text;
      
      // Process complete lines
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          this.emit('stdout', line);
        }
      }
    });

    // Handle stderr (for logging)
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      this.stderrBuffer += text;
      
      // Process complete lines
      const lines = this.stderrBuffer.split('\n');
      this.stderrBuffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.trim()) {
          this.emit('stderr', line);
        }
      }
    });

    // Handle process errors
    this.process.on('error', (error) => {
      logger.error({ id: this.id, err: error }, 'Process error');
      this.status = 'crashed';
      this.emit('error', error);
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      logger.info({ 
        id: this.id, 
        exitCode: code, 
        signal 
      }, 'Process exited');
      
      this.status = code === 0 ? 'stopped' : 'crashed';
      this.emit('exit', code);
    });

    // Wait a bit to ensure process started successfully
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.status === 'running') {
          resolve();
        } else {
          reject(new Error('Process failed to start'));
        }
      }, 500);

      this.process?.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async restart(): Promise<void> {
    logger.info({ id: this.id }, 'Restarting process');
    
    this.kill();
    this.restarts++;
    await this.start();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.process && this.status === 'running') {
      logger.debug({ id: this.id, signal }, 'Killing process');
      this.process.kill(signal);
      this.status = 'stopped';
    }
  }

  sendToStdin(data: string): void {
    if (!this.process || this.status !== 'running') {
      throw new Error('Process is not running');
    }

    if (!this.process.stdin) {
      throw new Error('Process stdin is not available');
    }

    this.process.stdin.write(data);
    if (!data.endsWith('\n')) {
      this.process.stdin.write('\n');
    }
  }

  isRunning(): boolean {
    return this.status === 'running' && this.process !== undefined;
  }

  getInfo(): ProcessInfo {
    return {
      pid: this.process?.pid || -1,
      command: this.config.command,
      args: this.config.args,
      startedAt: this.startedAt || new Date(),
      restarts: this.restarts,
      status: this.status,
    };
  }

  getConfig(): ServerConfig {
    return { ...this.config };
  }
}
