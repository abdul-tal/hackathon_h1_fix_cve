const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');
const middleware = require('./api/middleware');
const routes = require('./api/routes');

// Create Express app
const app = express();

// Trust proxy for proper IP addresses
app.set('trust proxy', true);

// Apply middleware in order
app.use(middleware.requestId);
app.use(middleware.requestLogger);
app.use(middleware.timeout()); // 5 minute timeout
app.use(middleware.cors);
app.use(middleware.bodyParser);

// API routes
app.use('/api', routes);

// Root endpoint redirect
app.get('/', (req, res) => {
  res.redirect('/api/health');
});

// 404 handler
app.use(middleware.notFoundHandler);

// Error handler (must be last)
app.use(middleware.errorHandler);

// Get orchestrator instance for cleanup
let orchestratorInstance = null;
app.use((req, res, next) => {
  if (!orchestratorInstance && req.baseUrl === '/api') {
    // Get orchestrator from routes for cleanup purposes
    const routes = require('./api/routes');
    orchestratorInstance = routes.orchestrator;
  }
  next();
});

// Start server
const startServer = async () => {
  try {
    // Ensure required environment variables
    if (!config.openai.apiKey) {
      logger.warn('OPENAI_API_KEY not set - Langchain functionality will be limited');
    }

    const server = app.listen(config.port, () => {
      logger.info('CVE Fix Automation Tool started', {
        port: config.port,
        nodeEnv: config.nodeEnv,
        version: require('../package.json').version
      });
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal) => {
      logger.info(`${signal} received, shutting down gracefully`);
      
      // Close server first
      server.close(async () => {
        try {
          // Cleanup orchestrator resources
          if (orchestratorInstance) {
            logger.info('Cleaning up orchestrator resources');
            await orchestratorInstance.cleanup();
          }
          
          logger.info('Graceful shutdown completed');
          process.exit(0);
        } catch (error) {
          logger.error('Error during graceful shutdown', {
            error: error.message
          });
          process.exit(1);
        }
      });

      // Force shutdown after timeout
      setTimeout(() => {
        logger.warn('Forcing shutdown due to timeout');
        process.exit(1);
      }, 30000); // 30 seconds
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', {
        error: error.message,
        stack: error.stack
      });
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection', {
        reason: reason,
        promise: promise
      });
      gracefulShutdown('UNHANDLED_REJECTION');
    });

    return server;
  } catch (error) {
    logger.error('Failed to start server', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
};

// Start the server if this file is run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer }; 