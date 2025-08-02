const CVEFixAgent = require('../agents/CVEFixAgent');
const config = require('../config/config');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');

class CVEFixOrchestrator {
  constructor() {
    this.agent = null;
    this.activeRequests = new Map(); // Track active requests
    this.initializeAgent();
  }

  // Initialize the CVE Fix Agent
  async initializeAgent() {
    try {
      logger.info('Initializing CVE Fix Orchestrator');
      
      this.agent = new CVEFixAgent();
      
      logger.info('CVE Fix Orchestrator initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize CVE Fix Orchestrator', {
        error: error.message
      });
      throw new Error(`Failed to initialize orchestrator: ${error.message}`);
    }
  }

  // Main entry point for CVE fixing requests
  async processCVEFix(request) {
    const requestId = uuidv4();
    const startTime = Date.now();

    try {
      logger.info('Processing CVE fix request', {
        requestId,
        cveId: request.cve_id
      });

      // Validate request
      const validation = await this.validateRequest(request);
      if (!validation.isValid) {
        const processingTime = Date.now() - startTime;
        const errorResponse = this.createErrorResponse(requestId, 'validation_failed', validation.error);
        errorResponse.processingTime = `${processingTime}ms`;
        return errorResponse;
      }

      // Track active request
      this.activeRequests.set(requestId, {
        cveId: request.cve_id,
        startTime,
        status: 'processing'
      });

      // Execute the CVE fixing workflow
      const result = await this.executeWorkflow(request.cve_id, requestId);

      // Calculate processing time
      const processingTime = Date.now() - startTime;

      // Remove from active requests
      this.activeRequests.delete(requestId);

      // Ensure result has all required fields for consistency
      const finalResult = {
        status: result.status || 'failure',
        message: result.message || 'CVE fix completed',
        original_version: result.original_version || null,
        fixed_version: result.fixed_version || null,
        cve_details: result.cve_details || {
          severity: 'UNKNOWN',
          description: 'No details available'
        },
        requestId,
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString()
      };

      logger.info('CVE fix request completed', {
        requestId,
        cveId: request.cve_id,
        status: finalResult.status,
        processingTime
      });

      return finalResult;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      logger.error('CVE fix request failed', {
        requestId,
        cveId: request.cve_id,
        error: error.message,
        stack: error.stack,
        processingTime
      });

      // Remove from active requests
      this.activeRequests.delete(requestId);

      // Create comprehensive error response
      const errorResponse = this.createErrorResponse(
        requestId, 
        error.message.includes('timeout') ? 'timeout' : 'processing_failed', 
        `CVE fix failed: ${error.message}`
      );
      errorResponse.processingTime = `${processingTime}ms`;

      return errorResponse;
    }
  }

  // Validate incoming request
  async validateRequest(request) {
    const validation = {
      isValid: true,
      error: null
    };

    try {
      // Validate CVE ID format
      if (!request.cve_id) {
        validation.isValid = false;
        validation.error = 'CVE ID is required';
        return validation;
      }

      const cvePattern = /^CVE-\d{4}-\d{4,}$/;
      if (!cvePattern.test(request.cve_id)) {
        validation.isValid = false;
        validation.error = 'CVE ID must be in format CVE-YYYY-NNNN';
        return validation;
      }

      // Validate Dockerfile exists at project root
      const fs = require('fs-extra');
      const dockerfilePath = config.dockerfile.path;
      
      if (!await fs.pathExists(dockerfilePath)) {
        validation.isValid = false;
        validation.error = `Dockerfile not found at ${dockerfilePath}`;
        return validation;
      }

      // Additional validation can be added here
      logger.debug('Request validation passed', {
        cveId: request.cve_id,
        dockerfilePath
      });

    } catch (error) {
      validation.isValid = false;
      validation.error = `Validation error: ${error.message}`;
    }

    return validation;
  }

  // Execute the complete CVE fixing workflow
  async executeWorkflow(cveId, requestId) {
    const workflowLogger = logger.child({ requestId, cveId });
    const startTime = Date.now();
    
    try {
      workflowLogger.info('Starting CVE fix workflow');

      // Update request status
      if (this.activeRequests.has(requestId)) {
        this.activeRequests.get(requestId).status = 'executing';
      }

      // Set up workflow timeout (3.5 minutes to leave buffer for API response)
      const workflowTimeout = new Promise((_, reject) => {
        setTimeout(() => {
          workflowLogger.warn('CVE fix workflow timeout');
          reject(new Error('CVE fix workflow timed out after 3.5 minutes'));
        }, 210000); // 3.5 minutes
      });

      // Race between the actual workflow and timeout
      const result = await Promise.race([
        this.agent.fixCVE(cveId, config.dockerfile.path),
        workflowTimeout
      ]);

      const processingTime = Date.now() - startTime;
      workflowLogger.info('CVE fix workflow completed', {
        status: result.status,
        originalVersion: result.original_version,
        fixedVersion: result.fixed_version,
        processingTime: `${processingTime}ms`
      });

      return result;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      workflowLogger.error('CVE fix workflow failed', {
        error: error.message,
        stack: error.stack,
        processingTime: `${processingTime}ms`
      });
      
      // Clean up request tracking
      if (this.activeRequests.has(requestId)) {
        this.activeRequests.get(requestId).status = 'failed';
      }
      
      throw error;
    }
  }

  // Create error response
  createErrorResponse(requestId, errorType, errorMessage) {
    return {
      status: 'failure',
      message: errorMessage || 'CVE fix operation failed',
      original_version: null,
      fixed_version: null,
      cve_details: {
        severity: 'UNKNOWN',
        description: errorType === 'timeout' ? 'Request timeout' : 
                     errorType === 'validation_failed' ? 'Validation failed' : 
                     'Processing failed'
      },
      requestId: requestId || 'unknown',
      timestamp: new Date().toISOString(),
      errorType: errorType || 'unknown_error'
    };
  }

  // Get current processing status
  getProcessingStatus() {
    const activeCount = this.activeRequests.size;
    const activeRequests = Array.from(this.activeRequests.entries()).map(([id, info]) => ({
      requestId: id,
      cveId: info.cveId,
      status: info.status,
      runtime: Date.now() - info.startTime
    }));

    return {
      activeRequestCount: activeCount,
      activeRequests,
      agentStatus: this.agent ? this.agent.getStatus() : null
    };
  }

  // Health check for the orchestrator
  async healthCheck() {
    try {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        components: {}
      };

      // Check agent status
      if (this.agent) {
        const agentStatus = this.agent.getStatus();
        health.components.agent = {
          status: agentStatus.toolsInitialized ? 'healthy' : 'degraded',
          details: agentStatus
        };
      } else {
        health.components.agent = {
          status: 'unhealthy',
          details: { error: 'Agent not initialized' }
        };
        health.status = 'degraded';
      }

      // Check Dockerfile accessibility
      const fs = require('fs-extra');
      const dockerfilePath = config.dockerfile.path;
      
      health.components.dockerfile = {
        status: await fs.pathExists(dockerfilePath) ? 'healthy' : 'unhealthy',
        path: dockerfilePath
      };

      if (health.components.dockerfile.status === 'unhealthy') {
        health.status = 'degraded';
      }

      // Check Docker daemon accessibility
      try {
        const DockerBuildTool = require('../tools/DockerBuildTool');
        const dockerTool = new DockerBuildTool();
        await dockerTool.checkDockerAccess();
        
        health.components.docker = {
          status: 'healthy',
          details: 'Docker daemon accessible'
        };
      } catch (error) {
        health.components.docker = {
          status: 'unhealthy',
          details: { error: error.message }
        };
        health.status = 'degraded';
      }

      logger.debug('Health check completed', {
        status: health.status,
        components: Object.keys(health.components)
      });

      return health;

    } catch (error) {
      logger.error('Health check failed', {
        error: error.message
      });

      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  }

  // Get metrics and statistics
  getMetrics() {
    const agentStatus = this.agent ? this.agent.getStatus() : null;
    
    return {
      timestamp: new Date().toISOString(),
      activeRequests: this.activeRequests.size,
      agentMetrics: agentStatus,
      systemInfo: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        memory: process.memoryUsage(),
        uptime: process.uptime()
      }
    };
  }

  // Cleanup orchestrator resources
  async cleanup() {
    try {
      logger.info('Cleaning up CVE Fix Orchestrator');

      // Wait for active requests to complete (with timeout)
      const timeout = 30000; // 30 seconds
      const startTime = Date.now();
      
      while (this.activeRequests.size > 0 && (Date.now() - startTime) < timeout) {
        logger.info('Waiting for active requests to complete', {
          activeCount: this.activeRequests.size
        });
        await this.delay(1000); // Wait 1 second
      }

      if (this.activeRequests.size > 0) {
        logger.warn('Forcefully terminating remaining requests', {
          remainingCount: this.activeRequests.size
        });
        this.activeRequests.clear();
      }

      // Cleanup agent resources
      if (this.agent) {
        await this.agent.cleanup();
      }

      logger.info('CVE Fix Orchestrator cleanup completed');

    } catch (error) {
      logger.error('Orchestrator cleanup failed', {
        error: error.message
      });
    }
  }

  // Cancel a specific request
  async cancelRequest(requestId) {
    if (this.activeRequests.has(requestId)) {
      logger.info('Cancelling request', { requestId });
      
      this.activeRequests.delete(requestId);
      
      return {
        success: true,
        message: `Request ${requestId} cancelled`
      };
    } else {
      return {
        success: false,
        message: `Request ${requestId} not found or already completed`
      };
    }
  }

  // Get detailed request information
  getRequestInfo(requestId) {
    const request = this.activeRequests.get(requestId);
    
    if (request) {
      return {
        requestId,
        cveId: request.cveId,
        status: request.status,
        startTime: request.startTime,
        runtime: Date.now() - request.startTime,
        active: true
      };
    } else {
      return {
        requestId,
        active: false,
        message: 'Request not found or completed'
      };
    }
  }

  // Helper delay function
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Validate system requirements
  async validateSystemRequirements() {
    const requirements = {
      valid: true,
      checks: [],
      errors: []
    };

    try {
      // Check Node.js version
      const nodeVersion = process.version;
      const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
      
      requirements.checks.push({
        name: 'Node.js Version',
        required: '>=18.0.0',
        current: nodeVersion,
        passed: majorVersion >= 18
      });

      if (majorVersion < 18) {
        requirements.valid = false;
        requirements.errors.push('Node.js version 18 or higher is required');
      }

      // Check Docker availability
      try {
        const DockerBuildTool = require('../tools/DockerBuildTool');
        const dockerTool = new DockerBuildTool();
        await dockerTool.checkDockerAccess();
        
        requirements.checks.push({
          name: 'Docker Daemon',
          required: 'accessible',
          current: 'accessible',
          passed: true
        });
      } catch (error) {
        requirements.checks.push({
          name: 'Docker Daemon',
          required: 'accessible',
          current: 'not accessible',
          passed: false,
          error: error.message
        });
        
        requirements.valid = false;
        requirements.errors.push('Docker daemon is not accessible');
      }

      // Check Dockerfile existence
      const fs = require('fs-extra');
      const dockerfilePath = config.dockerfile.path;
      const dockerfileExists = await fs.pathExists(dockerfilePath);
      
      requirements.checks.push({
        name: 'Dockerfile',
        required: dockerfilePath,
        current: dockerfileExists ? 'exists' : 'not found',
        passed: dockerfileExists
      });

      if (!dockerfileExists) {
        requirements.valid = false;
        requirements.errors.push(`Dockerfile not found at ${dockerfilePath}`);
      }

      logger.info('System requirements validation completed', {
        valid: requirements.valid,
        checksCount: requirements.checks.length,
        errorsCount: requirements.errors.length
      });

    } catch (error) {
      requirements.valid = false;
      requirements.errors.push(`System validation failed: ${error.message}`);
      
      logger.error('System requirements validation failed', {
        error: error.message
      });
    }

    return requirements;
  }
}

module.exports = CVEFixOrchestrator; 