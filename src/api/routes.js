const express = require('express');
const { validateFixCveRequest, validateFixCveRepoRequest, validateDockerfileExists, sanitizeInput } = require('./validation');
const CVEFixOrchestrator = require('../utils/CVEFixOrchestrator');
const GitRepoTool = require('../tools/GitRepoTool');
const PRCreatorTool = require('../tools/PRCreatorTool');
const logger = require('../utils/logger');

const router = express.Router();

// Initialize orchestrator and tools
const orchestrator = new CVEFixOrchestrator();
const gitRepoTool = new GitRepoTool();
const prCreatorTool = new PRCreatorTool();

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

// Fix CVE in external repository endpoint
router.post('/fix-cve-repo', [
  validateFixCveRepoRequest,
  sanitizeInput
], async (req, res) => {
  const { repo_url, github_token, branch, dockerfile_path } = req.validatedBody;
  
  // Hardcode CVE for testing purposes
  const cve_id = 'CVE-2020-1751';
  
  const startTime = Date.now();
  
  req.logger.info('CVE repo fix request received', {
    repoUrl: gitRepoTool.sanitizeUrl(repo_url),
    cveId: cve_id,
    branch: branch || 'default'
  });

  // Ensure we always respond, even if something goes wrong
  let hasResponded = false;
  let cloneId = null;
  
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
    req.logger.warn('CVE repo fix request approaching timeout', {
      repoUrl: gitRepoTool.sanitizeUrl(repo_url),
      cveId: cve_id,
      cloneId,
      elapsedTime: Date.now() - startTime
    });
    
    sendResponse(408, {
      status: 'failure',
      message: 'CVE repo fix request timed out. Repository cloning or processing took too long.',
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
    // Step 1: Clone the repository
    req.logger.info('Cloning repository', {
      repoUrl: gitRepoTool.sanitizeUrl(repo_url)
    });

    const cloneResult = await gitRepoTool.cloneRepository(repo_url, github_token, {
      branch,
      dockerfilePath: dockerfile_path
    });
    
    cloneId = cloneResult.cloneId;

    // Step 2: Find Dockerfile in the repository
    req.logger.info('Searching for Dockerfile in repository', {
      cloneId,
      clonePath: cloneResult.clonePath
    });

    const dockerfileResult = await gitRepoTool.findDockerfile(cloneResult.clonePath, {
      dockerfilePath: dockerfile_path
    });

    // Step 3: Get repository information
    const repoInfo = await gitRepoTool.getRepositoryInfo(cloneResult.clonePath);

    // Step 4: Process CVE fix using existing orchestrator
    req.logger.info('Starting CVE fix process for repository', {
      cloneId,
      dockerfilePath: dockerfileResult.primary.fullPath,
      cveId: cve_id
    });

    // Create a modified orchestrator request for the external Dockerfile
    const result = await Promise.race([
      orchestrator.processCVEFixForPath({ 
        cve_id, 
        dockerfile_path: dockerfileResult.primary.fullPath 
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Operation timeout')), 240000); // 4 minutes
      })
    ]);

    clearTimeout(failsafeTimeout);

    req.logger.info('CVE repo fix request completed', {
      repoUrl: gitRepoTool.sanitizeUrl(repo_url),
      cveId: cve_id,
      cloneId,
      status: result.status,
      processingTime: result.processingTime
    });

    // Step 5: Create PR if CVE fix was successful
    let prResult = null;
    if (result.status === 'success' && result.original_version && result.fixed_version) {
      try {
        req.logger.info('Creating pull request for CVE fix', {
          cloneId,
          originalVersion: result.original_version,
          fixedVersion: result.fixed_version
        });

        prResult = await prCreatorTool.createCVEFixPR({
          clonePath: cloneResult.clonePath,
          repoUrl: repo_url,
          githubToken: github_token,
          cveId: cve_id,
          originalVersion: result.original_version,
          fixedVersion: result.fixed_version,
          branch: branch || repoInfo.branch || 'main'
        });

        if (prResult.success) {
          req.logger.info('Pull request created successfully', {
            prNumber: prResult.prNumber,
            prUrl: prResult.prUrl,
            branchName: prResult.branchName
          });
        } else {
          req.logger.warn('Pull request creation failed', {
            error: prResult.error
          });
        }
      } catch (prError) {
        req.logger.error('Pull request creation failed', {
          error: prError.message
        });
        prResult = {
          success: false,
          error: prError.message
        };
      }
    }

    // Cleanup repository
    await gitRepoTool.cleanupRepository(cloneId);

    // Set appropriate HTTP status code based on result
    let statusCode = 200;
    if (result.status === 'failure') {
      statusCode = 500;
    } else if (result.status === 'no_fix_available') {
      statusCode = 200; // Not an error, just no fix available
    }

    sendResponse(statusCode, {
      ...result,
      repository: {
        url: gitRepoTool.sanitizeUrl(repo_url),
        branch: branch || repoInfo.branch || 'default',
        commit: repoInfo.commit?.substring(0, 8),
        dockerfilePath: dockerfileResult.primary.path,
        dockerfileSize: dockerfileResult.primary.size,
        cloneId: cloneId
      },
      pullRequest: prResult ? {
        success: prResult.success,
        ...(prResult.success ? {
          prNumber: prResult.prNumber,
          prUrl: prResult.prUrl,
          branchName: prResult.branchName
        } : {
          error: prResult.error
        })
      } : null
    });

  } catch (error) {
    clearTimeout(failsafeTimeout);
    
    req.logger.error('CVE repo fix request failed', {
      repoUrl: gitRepoTool.sanitizeUrl(repo_url),
      cveId: cve_id,
      cloneId,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`
    });

    // Cleanup repository on error
    if (cloneId) {
      await gitRepoTool.cleanupRepository(cloneId).catch(() => {});
    }

    const isTimeout = error.message.includes('timeout') || error.message.includes('Timeout');
    const isGitError = error.message.includes('Git clone failed') || error.message.includes('clone');
    const statusCode = isTimeout ? 408 : isGitError ? 422 : 500;
    const errorType = isTimeout ? 'timeout' : isGitError ? 'git_error' : 'processing_failed';
    
    sendResponse(statusCode, {
      status: 'failure',
      message: isTimeout 
        ? 'CVE repo fix request timed out. The repository cloning or processing may be too complex.'
        : isGitError
          ? `Repository cloning failed: ${error.message}`
          : `CVE repo fix failed: ${error.message}`,
      original_version: null,
      fixed_version: null,
      cve_details: {
        severity: 'UNKNOWN',
        description: isTimeout ? 'Request timeout' : isGitError ? 'Git error' : 'Processing failed'
      },
      processingTime: `${Date.now() - startTime}ms`,
      errorType,
      repository: cloneId ? { cloneId } : null
    });
  }
});

module.exports = router;
module.exports.orchestrator = orchestrator;
module.exports.gitRepoTool = gitRepoTool;
module.exports.prCreatorTool = prCreatorTool; 