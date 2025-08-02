const express = require('express');
const { validateFixCveRequest, validateRaisePrRequest, validateCreateBranchRequest, validateCreateBranchAndPrRequest, validateDockerfileExists, sanitizeInput, validateGitHubToken } = require('./validation');
const CVEFixOrchestrator = require('../utils/CVEFixOrchestrator');
const GitHubAPI = require('../tools/GitHubAPI');
const logger = require('../utils/logger');

const router = express.Router();

// Initialize orchestrator and GitHub API
const orchestrator = new CVEFixOrchestrator();
const githubAPI = new GitHubAPI();

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

// Create branch and PR endpoint (combined action)
router.post('/create-branch-and-pr', [
  validateCreateBranchAndPrRequest,
  validateGitHubToken,
  sanitizeInput
], async (req, res) => {
  const { github_repo, github_token, branch_name: originalBranchName, base_branch, title, body, draft } = req.validatedBody;
  
  // Add timestamp suffix to make branch name unique
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, -5);
  const branch_name = `${originalBranchName}-${timestamp}`;
  const startTime = Date.now();
  
  req.logger.info('Create branch and PR request received', {
    githubRepo: github_repo,
    branchName: branch_name,
    baseBranch: base_branch,
    prTitle: title
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

  // Set up a fail-safe timeout (45 seconds for combined operation)
  const failsafeTimeout = setTimeout(() => {
    req.logger.warn('Create branch and PR request approaching timeout', {
      githubRepo: github_repo,
      elapsedTime: Date.now() - startTime
    });
    
    sendResponse(408, {
      status: 'failure',
      message: 'Branch and PR creation request timed out. Please try again.',
      processingTime: `${Date.now() - startTime}ms`,
      errorType: 'timeout'
    });
  }, 45000); // 45 seconds

  let branchResult = null;

  try {
    // Validate token first
    const tokenValidation = await githubAPI.validateToken(github_token);
    
    if (!tokenValidation.valid) {
      clearTimeout(failsafeTimeout);
      req.logger.warn('Invalid GitHub token for branch and PR creation', {
        githubRepo: github_repo,
        error: tokenValidation.error
      });
      
      return sendResponse(401, {
        status: 'failure',
        message: `GitHub token validation failed: ${tokenValidation.error}`,
        processingTime: `${Date.now() - startTime}ms`,
        errorType: 'authentication_failed'
      });
    }

    // Step 1: Create the branch
    req.logger.info('Creating branch', {
      githubRepo: github_repo,
      branchName: branch_name,
      baseBranch: base_branch
    });

    branchResult = await githubAPI.createBranch(github_repo, github_token, branch_name, base_branch);

    req.logger.info('Branch created successfully, now creating dummy commit', {
      githubRepo: github_repo,
      branchName: branch_name,
      sha: branchResult.branch.sha
    });

    // Step 2: Create a dummy commit to make the branch differ from base
    const commitResult = await githubAPI.createDummyCommit(
      github_repo, 
      github_token, 
      branch_name, 
      `feat: initialize ${branch_name} for automated changes`
    );

    req.logger.info('Dummy commit created, now creating PR', {
      githubRepo: github_repo,
      branchName: branch_name,
      commitSha: commitResult.commit.sha
    });

    // Step 3: Create the pull request with the new branch
    const prResult = await githubAPI.createPullRequest(github_repo, github_token, {
      title,
      head: branch_name,
      base: base_branch,
      body,
      draft
    });

    clearTimeout(failsafeTimeout);

    req.logger.info('Branch and PR created successfully', {
      githubRepo: github_repo,
      branchName: branch_name,
      baseBranch: base_branch,
      prNumber: prResult.pr.number,
      prUrl: prResult.pr.url,
      processingTime: `${Date.now() - startTime}ms`
    });

    sendResponse(201, {
      status: 'success',
      message: 'Branch and Pull Request created successfully',
      branch: branchResult.branch,
      commit: commitResult.commit,
      pr: prResult.pr,
      processingTime: `${Date.now() - startTime}ms`
    });

  } catch (error) {
    clearTimeout(failsafeTimeout);
    
    req.logger.error('Failed to create branch and/or PR', {
      githubRepo: github_repo,
      branchName: branch_name,
      baseBranch: base_branch,
      prTitle: title,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`,
      branchCreated: !!branchResult
    });

    const isTimeout = error.message.includes('timeout') || error.message.includes('Timeout');
    const statusCode = isTimeout ? 408 : 500;
    const errorType = isTimeout ? 'timeout' : 'branch_and_pr_creation_failed';
    
    sendResponse(statusCode, {
      status: 'failure',
      message: `Failed to create ${branchResult ? 'pull request' : 'branch'}: ${error.message}`,
      processingTime: `${Date.now() - startTime}ms`,
      errorType,
      branch: branchResult ? branchResult.branch : null
    });
  }
});

// Create branch endpoint
router.post('/create-branch', [
  validateCreateBranchRequest,
  validateGitHubToken,
  sanitizeInput
], async (req, res) => {
  const { github_repo, github_token, branch_name, base_branch } = req.validatedBody;
  const startTime = Date.now();
  
  req.logger.info('Create branch request received', {
    githubRepo: github_repo,
    branchName: branch_name,
    baseBranch: base_branch
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

  // Set up a fail-safe timeout (30 seconds)
  const failsafeTimeout = setTimeout(() => {
    req.logger.warn('Create branch request approaching timeout', {
      githubRepo: github_repo,
      elapsedTime: Date.now() - startTime
    });
    
    sendResponse(408, {
      status: 'failure',
      message: 'Branch creation request timed out. Please try again.',
      processingTime: `${Date.now() - startTime}ms`,
      errorType: 'timeout'
    });
  }, 30000); // 30 seconds

  try {
    // Validate token first
    const tokenValidation = await githubAPI.validateToken(github_token);
    
    if (!tokenValidation.valid) {
      clearTimeout(failsafeTimeout);
      req.logger.warn('Invalid GitHub token for branch creation', {
        githubRepo: github_repo,
        error: tokenValidation.error
      });
      
      return sendResponse(401, {
        status: 'failure',
        message: `GitHub token validation failed: ${tokenValidation.error}`,
        processingTime: `${Date.now() - startTime}ms`,
        errorType: 'authentication_failed'
      });
    }

    // Create the branch
    const branchResult = await githubAPI.createBranch(github_repo, github_token, branch_name, base_branch);

    clearTimeout(failsafeTimeout);

    req.logger.info('Branch created successfully', {
      githubRepo: github_repo,
      branchName: branch_name,
      baseBranch: base_branch,
      sha: branchResult.branch.sha,
      processingTime: `${Date.now() - startTime}ms`
    });

    sendResponse(201, {
      status: 'success',
      message: 'Branch created successfully',
      branch: branchResult.branch,
      processingTime: `${Date.now() - startTime}ms`
    });

  } catch (error) {
    clearTimeout(failsafeTimeout);
    
    req.logger.error('Failed to create branch', {
      githubRepo: github_repo,
      branchName: branch_name,
      baseBranch: base_branch,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`
    });

    const isTimeout = error.message.includes('timeout') || error.message.includes('Timeout');
    const statusCode = isTimeout ? 408 : 500;
    const errorType = isTimeout ? 'timeout' : 'branch_creation_failed';
    
    sendResponse(statusCode, {
      status: 'failure',
      message: `Failed to create branch: ${error.message}`,
      processingTime: `${Date.now() - startTime}ms`,
      errorType
    });
  }
});

// Raise PR endpoint
router.post('/raise-pr', [
  validateRaisePrRequest,
  validateGitHubToken,
  sanitizeInput
], async (req, res) => {
  const { github_repo, github_token, title, head, base, body, draft } = req.validatedBody;
  const startTime = Date.now();
  
  req.logger.info('Raise PR request received', {
    githubRepo: github_repo,
    title,
    head,
    base
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

  // Set up a fail-safe timeout (30 seconds)
  const failsafeTimeout = setTimeout(() => {
    req.logger.warn('Raise PR request approaching timeout', {
      githubRepo: github_repo,
      elapsedTime: Date.now() - startTime
    });
    
    sendResponse(408, {
      status: 'failure',
      message: 'PR creation request timed out. Please try again.',
      processingTime: `${Date.now() - startTime}ms`,
      errorType: 'timeout'
    });
  }, 30000); // 30 seconds

  try {
    // Validate token first
    const tokenValidation = await githubAPI.validateToken(github_token);
    
    if (!tokenValidation.valid) {
      clearTimeout(failsafeTimeout);
      req.logger.warn('Invalid GitHub token for PR creation', {
        githubRepo: github_repo,
        error: tokenValidation.error
      });
      
      return sendResponse(401, {
        status: 'failure',
        message: `GitHub token validation failed: ${tokenValidation.error}`,
        processingTime: `${Date.now() - startTime}ms`,
        errorType: 'authentication_failed'
      });
    }

    // Create the pull request
    const prResult = await githubAPI.createPullRequest(github_repo, github_token, {
      title,
      head,
      base,
      body,
      draft
    });

    clearTimeout(failsafeTimeout);

    req.logger.info('Pull request created successfully', {
      githubRepo: github_repo,
      prNumber: prResult.pr.number,
      prUrl: prResult.pr.url,
      title: prResult.pr.title,
      processingTime: `${Date.now() - startTime}ms`
    });

    sendResponse(201, {
      status: 'success',
      message: 'Pull request created successfully',
      pr: prResult.pr,
      processingTime: `${Date.now() - startTime}ms`
    });

  } catch (error) {
    clearTimeout(failsafeTimeout);
    
    req.logger.error('Failed to create pull request', {
      githubRepo: github_repo,
      error: error.message,
      stack: error.stack,
      processingTime: `${Date.now() - startTime}ms`
    });

    const isTimeout = error.message.includes('timeout') || error.message.includes('Timeout');
    const statusCode = isTimeout ? 408 : 500;
    const errorType = isTimeout ? 'timeout' : 'pr_creation_failed';
    
    sendResponse(statusCode, {
      status: 'failure',
      message: `Failed to create pull request: ${error.message}`,
      processingTime: `${Date.now() - startTime}ms`,
      errorType
    });
  }
});

// Main CVE fix endpoint
router.post('/fix-cve', [
  validateFixCveRequest,
  validateGitHubToken,
  validateDockerfileExists,
  sanitizeInput
], async (req, res) => {
  const { github_repo, github_token } = req.validatedBody;
  const startTime = Date.now();
  
  req.logger.info('CVE fix request received', {
    githubRepo: github_repo
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
      githubRepo: github_repo,
      elapsedTime: Date.now() - startTime
    });
    
    sendResponse(408, {
      status: 'failure',
      message: 'CVE fix request timed out. Please try again with a simpler repository or check system load.',
      original_version: null,
      fixed_version: null,
      cve_summary: {
        total_found: 0,
        total_fixed: 0,
        unfixable: 0,
        severity_breakdown: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
      },
      github_info: {
        repository: github_repo,
        dockerfile_path: null
      },
      processingTime: `${Date.now() - startTime}ms`,
      errorType: 'timeout'
    });
  }, 270000); // 4.5 minutes

  try {
    // Process CVE fix using orchestrator with timeout wrapper
    const result = await Promise.race([
      orchestrator.processCVEFix({ github_repo, github_token }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Operation timeout')), 240000); // 4 minutes
      })
    ]);

    clearTimeout(failsafeTimeout);

    req.logger.info('CVE fix request completed', {
      githubRepo: github_repo,
      status: result.status,
      totalCVEs: result.cve_summary?.total_found || 0,
      fixedCVEs: result.cve_summary?.total_fixed || 0,
      processingTime: result.processingTime
    });

    // Set appropriate HTTP status code based on result
    let statusCode = 200;
    if (result.status === 'failure') {
      statusCode = 500;
    } else if (result.status === 'no_fix_available') {
      statusCode = 200; // Not an error, just no fix available
    } else if (result.status === 'no_action_needed') {
      statusCode = 200; // No CVEs found, which is good
    }

    sendResponse(statusCode, result);

  } catch (error) {
    clearTimeout(failsafeTimeout);
    
    req.logger.error('CVE fix request failed', {
      githubRepo: github_repo,
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
      cve_summary: {
        total_found: 0,
        total_fixed: 0,
        unfixable: 0,
        severity_breakdown: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
      },
      github_info: {
        repository: github_repo,
        dockerfile_path: null
      },
      processingTime: `${Date.now() - startTime}ms`,
      errorType
    });
  }
});

module.exports = router;
module.exports.orchestrator = orchestrator; 
