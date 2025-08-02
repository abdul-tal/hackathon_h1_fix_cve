const express = require('express');
const { validateFixCveRequest, validateDockerfileExists, sanitizeInput } = require('./validation');
const CVEFixOrchestrator = require('../utils/CVEFixOrchestrator');
const logger = require('../utils/logger');

const router = express.Router();

// Initialize orchestrator
const orchestrator = new CVEFixOrchestrator();

// Health check endpoint
router.get('/health', async (req, res) => {
  req.logger.info('Health check requested');
  
  try {
    const health = await orchestrator.healthCheck();
    const statusCode = health.status === 'healthy' ? 200 : 503;
    
    res.status(statusCode).json({
      ...health,
      version: require('../../package.json').version,
      requestId: req.id
    });
  } catch (error) {
    req.logger.error('Health check failed', { error: error.message });
    
    res.status(503).json({
      status: 'unhealthy',
      message: 'Health check failed',
      error: error.message,
      timestamp: new Date().toISOString(),
      requestId: req.id
    });
  }
});

// System status endpoint
router.get('/status', (req, res) => {
  req.logger.info('Status check requested');
  
  const status = orchestrator.getProcessingStatus();
  
  res.json({
    ...status,
    version: require('../../package.json').version,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

// Metrics endpoint
router.get('/metrics', (req, res) => {
  req.logger.info('Metrics requested');
  
  const metrics = orchestrator.getMetrics();
  
  res.json({
    ...metrics,
    requestId: req.id
  });
});

// System requirements check
router.get('/requirements', async (req, res) => {
  req.logger.info('System requirements check requested');
  
  try {
    const requirements = await orchestrator.validateSystemRequirements();
    const statusCode = requirements.valid ? 200 : 503;
    
    res.status(statusCode).json({
      ...requirements,
      timestamp: new Date().toISOString(),
      requestId: req.id
    });
  } catch (error) {
    req.logger.error('Requirements check failed', { error: error.message });
    
    res.status(500).json({
      valid: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      requestId: req.id
    });
  }
});

// Main CVE fix endpoint
router.post('/fix-cve', [
  validateFixCveRequest,
  validateDockerfileExists,
  sanitizeInput
], async (req, res) => {
  const { cve_id } = req.validatedBody;
  const startTime = Date.now();
  
  req.logger.info('CVE fix request received', {
    cveId: cve_id
  });

  // Ensure we always respond, even if something goes wrong
  let hasResponded = false;
  
  const sendResponse = (statusCode, responseData) => {
    if (!hasResponded && !res.headersSent) {
      hasResponded = true;
      res.status(statusCode).json({
        ...responseData,
        requestId: req.id,
        timestamp: new Date().toISOString()
      });
    }
  };

  // Set up a fail-safe timeout (4.5 minutes, shorter than middleware timeout)
  const failsafeTimeout = setTimeout(() => {
    req.logger.warn('CVE fix request approaching timeout', {
      cveId: cve_id,
      elapsedTime: Date.now() - startTime
    });
    
    sendResponse(408, {
      status: 'failure',
      message: 'CVE fix request timed out. Please try again with a simpler CVE or check system load.',
      original_version: null,
      fixed_version: null,
      cve_details: {
        severity: 'UNKNOWN',
        description: 'Request timeout'
      },
      processingTime: `${Date.now() - startTime}ms`,
      errorType: 'timeout'
    });
  }, 270000); // 4.5 minutes

  try {
    // Process CVE fix using orchestrator with timeout wrapper
    const result = await Promise.race([
      orchestrator.processCVEFix({ cve_id }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Operation timeout')), 240000); // 4 minutes
      })
    ]);

    clearTimeout(failsafeTimeout);

    req.logger.info('CVE fix request completed', {
      cveId: cve_id,
      status: result.status,
      processingTime: result.processingTime
    });

    // Set appropriate HTTP status code based on result
    let statusCode = 200;
    if (result.status === 'failure') {
      statusCode = 500;
    } else if (result.status === 'no_fix_available') {
      statusCode = 200; // Not an error, just no fix available
    }

    sendResponse(statusCode, result);

  } catch (error) {
    clearTimeout(failsafeTimeout);
    
    req.logger.error('CVE fix request failed', {
      cveId: cve_id,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`
    });

    const isTimeout = error.message.includes('timeout') || error.message.includes('Timeout');
    const statusCode = isTimeout ? 408 : 500;
    const errorType = isTimeout ? 'timeout' : 'processing_failed';
    
    sendResponse(statusCode, {
      status: 'failure',
      message: isTimeout 
        ? 'CVE fix request timed out. The operation may be too complex or system resources are limited.'
        : `CVE fix failed: ${error.message}`,
      original_version: null,
      fixed_version: null,
      cve_details: {
        severity: 'UNKNOWN',
        description: isTimeout ? 'Request timeout' : 'Processing failed'
      },
      processingTime: `${Date.now() - startTime}ms`,
      errorType
    });
  }
});

module.exports = router;
module.exports.orchestrator = orchestrator; 