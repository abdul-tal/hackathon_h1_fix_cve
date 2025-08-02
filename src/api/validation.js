const Joi = require('joi');
const fs = require('fs-extra');
const path = require('path');

// GitHub repository validation pattern (owner/repo)
const githubRepoPattern = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

// Schema for fix CVE request with GitHub integration
const fixCveSchema = Joi.object({
  github_repo: Joi.string()
    .pattern(githubRepoPattern)
    .required()
    .messages({
      'string.pattern.base': 'GitHub repository must be in format owner/repo (e.g., user/my-project)',
      'any.required': 'GitHub repository is required'
    }),
  github_token: Joi.string()
    .min(10)
    .required()
    .messages({
      'string.min': 'GitHub token must be at least 10 characters long',
      'any.required': 'GitHub token is required'
    })
});

// Validate fix CVE request
const validateFixCveRequest = (req, res, next) => {
  const { error, value } = fixCveSchema.validate(req.body);
  
  if (error) {
    req.logger.warn('Request validation failed', {
      error: error.details[0].message,
      body: req.body
    });
    
    return res.status(400).json({
      status: 'failure',
      message: error.details[0].message,
      requestId: req.id
    });
  }
  
  req.validatedBody = value;
  next();
};

// Validate GitHub token format (basic validation)
const validateGitHubToken = (req, res, next) => {
  const { github_token } = req.validatedBody;
  
  // Basic token format validation
  if (!github_token || typeof github_token !== 'string') {
    req.logger.warn('Invalid GitHub token format', {
      tokenPresent: !!github_token,
      tokenType: typeof github_token
    });
    
    return res.status(400).json({
      status: 'failure',
      message: 'GitHub token must be a valid string',
      requestId: req.id
    });
  }

  // Check for common token prefixes
  const validPrefixes = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
  const hasValidPrefix = validPrefixes.some(prefix => github_token.startsWith(prefix));
  
  if (!hasValidPrefix && github_token.length < 40) {
    req.logger.warn('GitHub token appears to be invalid format', {
      tokenLength: github_token.length,
      hasValidPrefix
    });
    
    return res.status(400).json({
      status: 'failure',
      message: 'GitHub token appears to be invalid. Please check your token format.',
      requestId: req.id
    });
  }

  next();
};

// Check if Dockerfile exists at project root (keeping this for backward compatibility)
const validateDockerfileExists = (req, res, next) => {
  // Since we're now downloading from GitHub, we'll skip this validation
  // and let the GitHub download process handle Dockerfile existence
  next();
};

// Sanitize input to prevent injection attacks
const sanitizeInput = (req, res, next) => {
  const { github_repo, github_token } = req.validatedBody;
  
  // Remove any potential malicious characters from repo name
  if (github_repo) {
    const sanitizedRepo = github_repo.replace(/[^\w\-\.\/]/g, '');
    if (sanitizedRepo !== github_repo) {
      req.logger.warn('GitHub repository name contained invalid characters', {
        original: github_repo,
        sanitized: sanitizedRepo
      });
      
      return res.status(400).json({
        status: 'failure',
        message: 'GitHub repository name contains invalid characters',
        requestId: req.id
      });
    }
  }

  // Basic sanitization for token (just ensure it's clean)
  if (github_token && github_token.includes(' ')) {
    req.logger.warn('GitHub token contains spaces', {
      tokenLength: github_token.length
    });
    
    return res.status(400).json({
      status: 'failure',
      message: 'GitHub token should not contain spaces',
      requestId: req.id
    });
  }

  next();
};

module.exports = {
  validateFixCveRequest,
  validateGitHubToken,
  validateDockerfileExists,
  sanitizeInput
}; 