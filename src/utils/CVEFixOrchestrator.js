const CVEFixAgent = require('../agents/CVEFixAgent');
const logger = require('./logger');

const { v4: uuidv4 } = require('uuid');

class CVEFixOrchestrator {
  constructor() {
    this.agent = null;
    this.activeRequests = new Map();
    this.initializeAgent();
  }

  // Initialize the CVE fix agent
  async initializeAgent() {
    try {
      this.agent = new CVEFixAgent();
      logger.info('CVE Fix Orchestrator initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize CVE Fix Orchestrator', {
        error: error.message
      });
      throw new Error(`Orchestrator initialization failed: ${error.message}`);
    }
  }

  // Main entry point for CVE fixing requests (updated for GitHub integration)
  async processCVEFix(request) {
    const requestId = uuidv4();
    const startTime = Date.now();

    try {
      logger.info('Processing comprehensive CVE fix request', {
        requestId,
        githubRepo: request.github_repo
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
        githubRepo: request.github_repo,
        startTime,
        status: 'processing'
      });

      // Execute the comprehensive CVE fixing workflow
      const result = await this.executeGitHubWorkflow(request.github_repo, request.github_token, requestId);

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
        cve_summary: result.cve_summary || {
          total_found: 0,
          total_fixed: 0,
          unfixable: 0,
          severity_breakdown: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
        },
        github_info: result.github_info || {
          repository: request.github_repo,
          dockerfile_path: null
        },
        build_info: result.build_info || null,
        requestId,
        processingTime: `${processingTime}ms`,
        timestamp: new Date().toISOString()
      };

      logger.info('CVE fix request completed', {
        requestId,
        githubRepo: request.github_repo,
        status: finalResult.status,
        totalCVEs: finalResult.cve_summary.total_found,
        fixedCVEs: finalResult.cve_summary.total_fixed,
        processingTime
      });

      return finalResult;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      // Remove from active requests
      this.activeRequests.delete(requestId);

      logger.error('CVE fix request failed', {
        requestId,
        githubRepo: request.github_repo,
        error: error.message,
        stack: error.stack,
        processingTime
      });

      return this.createErrorResponse(requestId, 'processing_failed', error.message, {
        processingTime: `${processingTime}ms`,
        github_info: {
          repository: request.github_repo,
          dockerfile_path: null
        }
      });
    }
  }

  // Execute the GitHub-based CVE fix workflow
  async executeGitHubWorkflow(githubRepo, githubToken, requestId) {
    try {
      logger.info('Executing GitHub CVE fix workflow', {
        requestId,
        githubRepo
      });

      // Ensure agent is initialized
      if (!this.agent) {
        await this.initializeAgent();
      }

      // Execute the comprehensive CVE fix workflow
      const result = await this.agent.fixCVEsFromGitHub(githubRepo, githubToken);

      logger.info('GitHub CVE fix workflow completed', {
        requestId,
        githubRepo,
        status: result.status,
        totalCVEs: result.cve_summary?.total_found || 0,
        fixedCVEs: result.cve_summary?.total_fixed || 0
      });

      return result;

    } catch (error) {
      logger.error('GitHub CVE fix workflow failed', {
        requestId,
        githubRepo,
        error: error.message
      });
      throw new Error(`GitHub workflow failed: ${error.message}`);
    }
  }

  // Validate request (updated for GitHub parameters)
  async validateRequest(request) {
    try {
      // Check required fields
      if (!request.github_repo || !request.github_token) {
        return {
          isValid: false,
          error: 'Missing required fields: github_repo and github_token are required'
        };
      }

      // Validate GitHub repo format
      if (!this.isValidGitHubRepo(request.github_repo)) {
        return {
          isValid: false,
          error: 'Invalid GitHub repository format. Expected: owner/repo'
        };
      }

      // Basic token validation
      if (typeof request.github_token !== 'string' || request.github_token.length < 10) {
        return {
          isValid: false,
          error: 'Invalid GitHub token format'
        };
      }

      return { isValid: true };

    } catch (error) {
      logger.error('Request validation failed', {
        error: error.message
      });
      return {
        isValid: false,
        error: `Validation error: ${error.message}`
      };
    }
  }

  // Validate GitHub repository format
  isValidGitHubRepo(repo) {
    if (!repo || typeof repo !== 'string') {
      return false;
    }
    const parts = repo.split('/');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
  }

  // Create error response
  createErrorResponse(requestId, errorType, message, additionalData = {}) {
    return {
      status: 'failure',
      message: `CVE fix failed: ${message}`,
      original_version: null,
      fixed_version: null,
      cve_summary: {
        total_found: 0,
        total_fixed: 0,
        unfixable: 0,
        severity_breakdown: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
      },
      requestId,
      errorType,
      timestamp: new Date().toISOString(),
      ...additionalData
    };
  }

  // Get current processing status
  getProcessingStatus() {
    const activeCount = this.activeRequests.size;
    const activeRequests = Array.from(this.activeRequests.entries()).map(([id, info]) => ({
      requestId: id,
      githubRepo: info.githubRepo,
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
      const dockerfilePath = require('../config/config').dockerfile.path;
      
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
        githubRepo: request.githubRepo,
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
      const dockerfilePath = require('../config/config').dockerfile.path;
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