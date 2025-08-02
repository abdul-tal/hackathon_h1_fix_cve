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

// Schema for raise PR request
const raisePrSchema = Joi.object({
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
    }),
  title: Joi.string()
    .min(1)
    .max(100)
    .required()
    .messages({
      'string.min': 'PR title cannot be empty',
      'string.max': 'PR title cannot exceed 100 characters',
      'any.required': 'PR title is required'
    }),
  head: Joi.string()
    .min(1)
    .required()
    .messages({
      'string.min': 'Head branch cannot be empty',
      'any.required': 'Head branch is required'
    }),
  base: Joi.string()
    .min(1)
    .default('main')
    .messages({
      'string.min': 'Base branch cannot be empty'
    }),
  body: Joi.string()
    .allow('')
    .default('')
    .max(1000)
    .messages({
      'string.max': 'PR body cannot exceed 1000 characters'
    }),
  draft: Joi.boolean()
    .default(false)
});

// Schema for create branch request
const createBranchSchema = Joi.object({
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
    }),
  branch_name: Joi.string()
    .min(1)
    .max(255)
    .pattern(/^[a-zA-Z0-9._/-]+$/)
    .required()
    .messages({
      'string.min': 'Branch name cannot be empty',
      'string.max': 'Branch name cannot exceed 255 characters',
      'string.pattern.base': 'Branch name can only contain letters, numbers, dots, underscores, hyphens, and forward slashes',
      'any.required': 'Branch name is required'
    }),
  base_branch: Joi.string()
    .min(1)
    .default('main')
    .messages({
      'string.min': 'Base branch cannot be empty'
    })
});

// Schema for create branch and PR request (combined action)
const createBranchAndPrSchema = Joi.object({
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
    }),
  branch_name: Joi.string()
    .min(1)
    .max(255)
    .pattern(/^[a-zA-Z0-9._/-]+$/)
    .required()
    .messages({
      'string.min': 'Branch name cannot be empty',
      'string.max': 'Branch name cannot exceed 255 characters',
      'string.pattern.base': 'Branch name can only contain letters, numbers, dots, underscores, hyphens, and forward slashes',
      'any.required': 'Branch name is required'
    }),
  base_branch: Joi.string()
    .min(1)
    .default('main')
    .messages({
      'string.min': 'Base branch cannot be empty'
    }),
  title: Joi.string()
    .min(1)
    .max(100)
    .required()
    .messages({
      'string.min': 'PR title cannot be empty',
      'string.max': 'PR title cannot exceed 100 characters',
      'any.required': 'PR title is required'
    }),
  body: Joi.string()
    .allow('')
    .default('')
    .max(1000)
    .messages({
      'string.max': 'PR body cannot exceed 1000 characters'
    }),
  draft: Joi.boolean()
    .default(false)
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

// Validate raise PR request
const validateRaisePrRequest = (req, res, next) => {
  const { error, value } = raisePrSchema.validate(req.body);
  
  if (error) {
    req.logger.warn('Raise PR request validation failed', {
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

// Validate create branch request
const validateCreateBranchRequest = (req, res, next) => {
  const { error, value } = createBranchSchema.validate(req.body);
  
  if (error) {
    req.logger.warn('Create branch request validation failed', {
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

// Validate create branch and PR request (combined action)
const validateCreateBranchAndPrRequest = (req, res, next) => {
  const { error, value } = createBranchAndPrSchema.validate(req.body);
  
  if (error) {
    req.logger.warn('Create branch and PR request validation failed', {
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
  validateRaisePrRequest,
  validateCreateBranchRequest,
  validateCreateBranchAndPrRequest,
  validateGitHubToken,
  validateDockerfileExists,
  sanitizeInput
}; 
