#!/usr/bin/env node

import { HTTPServer } from './server/http.js';
import { loadConfiguration } from './config/loader.js';
import { 
  logger, 
  setupProcessLogging, 
  logInfo, 
  logError, 
  logFatal 
} from './utils/logger.js';

// Setup process-wide error handling and logging
setupProcessLogging();

// ASCII Art Banner
const banner = `
╔═══════════════════════════════════════════════╗
║        MCP Proxy Server v1.0.0                ║
║   Bridge STDIO MCP servers to HTTP transport  ║
╚═══════════════════════════════════════════════╝
`;

async function main(): Promise<void> {
  console.log(banner);
  
  try {
    // Load configuration
    logInfo('Loading configuration...');
    const config = loadConfiguration();
    
    logInfo('Configuration loaded', {
      port: config.port,
      host: config.host,
      servers: config.servers.map(s => s.name),
      auth: config.auth?.type || 'none',
      corsOrigins: config.cors.origins,
    });
    
    // Create and start HTTP server
    const server = new HTTPServer(config);
    
    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logInfo(`Received ${signal}, starting graceful shutdown...`);
      
      try {
        await server.stop();
        logInfo('Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        logError('Error during shutdown', error);
        process.exit(1);
      }
    };
    
    // Register shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
    // Start the server
    await server.start();
    
    logInfo('MCP Proxy Server is ready', {
      url: `http://${config.host}:${config.port}`,
      endpoints: config.servers.map(s => ({
        name: s.name,
        url: `http://${config.host}:${config.port}${s.endpoint || `/${s.name}`}`,
      })),
    });
    
    // Log available endpoints
    console.log('\n📍 Available endpoints:');
    console.log(`  Health: http://${config.host}:${config.port}/health`);
    console.log(`  Stats:  http://${config.host}:${config.port}/stats`);
    
    for (const server of config.servers) {
      const endpoint = server.endpoint || `/${server.name}`;
      console.log(`  ${server.name}: http://${config.host}:${config.port}${endpoint}`);
    }
    
    if (config.servers.length === 1) {
      console.log(`  Default: http://${config.host}:${config.port}/mcp`);
    }
    
    console.log('\n✅ Server is running. Press Ctrl+C to stop.\n');
    
  } catch (error) {
    logFatal('Failed to start server', error);
  }
}

// Run the main function
main().catch((error) => {
  logFatal('Unhandled error in main', error);
});

// Export for testing
export { HTTPServer, loadConfiguration };
