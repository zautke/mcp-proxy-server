import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { ProxyConfigSchema, type ProxyConfig } from '../validation/schemas.js';
import { logger } from '../utils/logger.js';

// Load environment variables
dotenv.config();

export function loadConfiguration(): ProxyConfig {
  // Try to load from file first
  const configPath = process.env['CONFIG_PATH'] || './config/proxy.json';
  const resolvedPath = resolve(process.cwd(), configPath);
  
  if (existsSync(resolvedPath)) {
    logger.info({ path: resolvedPath }, 'Loading configuration from file');
    try {
      const fileContent = readFileSync(resolvedPath, 'utf-8');
      const parsed = JSON.parse(fileContent);
      const validated = ProxyConfigSchema.parse(parsed);
      return applyEnvironmentOverrides(validated);
    } catch (error) {
      logger.error({ err: error, path: resolvedPath }, 'Failed to load configuration file');
      throw error;
    }
  }
  
  // Fall back to environment variables
  logger.info('Loading configuration from environment variables');
  return loadFromEnvironment();
}

function loadFromEnvironment(): ProxyConfig {
  const config = {
    port: parseInt(process.env['PORT'] || '8080', 10),
    host: process.env['HOST'] || '127.0.0.1',
    sessionTimeout: parseInt(process.env['SESSION_TIMEOUT'] || '3600000', 10),
    batchTimeout: parseInt(process.env['BATCH_TIMEOUT'] || '5000', 10),
    cors: {
      origins: (process.env['CORS_ORIGINS'] || '*').split(',').map(s => s.trim()),
      credentials: process.env['CORS_CREDENTIALS'] === 'true',
    },
    auth: parseAuthConfig(),
    servers: parseServerConfigs(),
  };
  
  return ProxyConfigSchema.parse(config);
}

function parseAuthConfig() {
  const authType = process.env['AUTH_TYPE'] || 'none';
  
  if (authType === 'none') {
    return { type: 'none' as const };
  }
  
  if (authType === 'bearer') {
    const tokens = (process.env['AUTH_TOKENS'] || '').split(',')
      .map(s => s.trim())
      .filter(Boolean);
    
    if (tokens.length === 0) {
      throw new Error('AUTH_TOKENS required when AUTH_TYPE is bearer');
    }
    
    return { type: 'bearer' as const, tokens };
  }
  
  throw new Error(`Unknown AUTH_TYPE: ${authType}`);
}

function parseServerConfigs() {
  const servers = [];
  
  // Check for individual server configs (SERVER_0_*, SERVER_1_*, etc.)
  for (let i = 0; i < 10; i++) {
    const name = process.env[`SERVER_${i}_NAME`];
    if (!name) break;
    
    const command = process.env[`SERVER_${i}_COMMAND`];
    if (!command) {
      throw new Error(`SERVER_${i}_COMMAND is required`);
    }
    
    const args = (process.env[`SERVER_${i}_ARGS`] || '')
      .split(' ')
      .filter(Boolean);
    
    const env: Record<string, string> = {};
    const envPrefix = `SERVER_${i}_ENV_`;
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(envPrefix) && value) {
        const envKey = key.substring(envPrefix.length);
        env[envKey] = value;
      }
    }
    
    servers.push({
      name,
      command,
      args,
      env: Object.keys(env).length > 0 ? env : undefined,
      cwd: process.env[`SERVER_${i}_CWD`],
      endpoint: process.env[`SERVER_${i}_ENDPOINT`],
    });
  }
  
  // If no servers configured, add default examples
  if (servers.length === 0) {
    logger.warn('No servers configured, using default examples');
    servers.push(
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
      {
        name: 'memory',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      }
    );
  }
  
  return servers;
}

function applyEnvironmentOverrides(config: ProxyConfig): ProxyConfig {
  // Apply environment overrides to file-based config
  if (process.env['PORT']) {
    config.port = parseInt(process.env['PORT'], 10);
  }
  
  if (process.env['HOST']) {
    config.host = process.env['HOST'];
  }
  
  if (process.env['SESSION_TIMEOUT']) {
    config.sessionTimeout = parseInt(process.env['SESSION_TIMEOUT'], 10);
  }
  
  if (process.env['BATCH_TIMEOUT']) {
    config.batchTimeout = parseInt(process.env['BATCH_TIMEOUT'], 10);
  }
  
  if (process.env['CORS_ORIGINS']) {
    config.cors.origins = process.env['CORS_ORIGINS'].split(',').map(s => s.trim());
  }
  
  if (process.env['CORS_CREDENTIALS']) {
    config.cors.credentials = process.env['CORS_CREDENTIALS'] === 'true';
  }
  
  if (process.env['AUTH_TYPE']) {
    config.auth = parseAuthConfig();
  }
  
  return config;
}

// Export example configuration
export const exampleConfig: ProxyConfig = {
  port: 8080,
  host: '127.0.0.1',
  sessionTimeout: 3600000, // 1 hour
  batchTimeout: 5000, // 5 seconds
  cors: {
    origins: ['http://localhost:3000'],
    credentials: true,
  },
  auth: {
    type: 'bearer',
    tokens: ['your-secret-token-here'],
  },
  servers: [
    {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}',
      },
    },
    {
      name: 'slack',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: {
        SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}',
        SLACK_TEAM_ID: '${SLACK_TEAM_ID}',
      },
    },
  ],
};

// Helper to generate example config file
export function generateExampleConfig(outputPath = './config/proxy.example.json'): void {
  const content = JSON.stringify(exampleConfig, null, 2);
  const fs = require('fs');
  const path = require('path');
  
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  fs.writeFileSync(outputPath, content);
  console.log(`Example configuration written to ${outputPath}`);
}
