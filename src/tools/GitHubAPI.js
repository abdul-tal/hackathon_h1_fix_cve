const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');

class GitHubAPI {
  constructor() {
    this.baseURL = 'https://api.github.com';
    this.timeout = 30000; // 30 seconds
    this.rateLimit = {
      remaining: null,
      reset: null
    };
  }

  // Create axios instance with auth token
  createAxiosInstance(token) {
    return axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CVE-Fix-Tool/1.0'
      }
    });
  }

  // Download Dockerfile from GitHub repository
  async downloadDockerfile(githubRepo, githubToken, targetPath = './Dockerfile') {
    try {
      logger.info('Downloading Dockerfile from GitHub', {
        repo: githubRepo,
        targetPath
      });

      // Validate repo format (owner/repo)
      if (!this.validateRepoFormat(githubRepo)) {
        throw new Error('Invalid repository format. Expected: owner/repo');
      }

      const api = this.createAxiosInstance(githubToken);
      
      // First, try to get the Dockerfile from the root
      let dockerfileContent;
      let dockerfilePath = 'Dockerfile';
      
      try {
        dockerfileContent = await this.getFileContent(api, githubRepo, dockerfilePath);
      } catch (error) {
        // If not found in root, try common locations
        const commonPaths = [
          'docker/Dockerfile',
          'Docker/Dockerfile',
          '.docker/Dockerfile',
          'build/Dockerfile',
          'deployment/Dockerfile'
        ];

        let found = false;
        for (const altPath of commonPaths) {
          try {
            dockerfileContent = await this.getFileContent(api, githubRepo, altPath);
            dockerfilePath = altPath;
            found = true;
            break;
          } catch (e) {
            // Continue searching
          }
        }

        if (!found) {
          throw new Error('Dockerfile not found in repository. Searched in root and common directories.');
        }
      }

      // Ensure target directory exists
      await fs.ensureDir(path.dirname(targetPath));

      // Write Dockerfile to target path
      await fs.writeFile(targetPath, dockerfileContent, 'utf8');

      logger.info('Dockerfile downloaded successfully', {
        repo: githubRepo,
        sourcePath: dockerfilePath,
        targetPath,
        size: dockerfileContent.length
      });

      return {
        success: true,
        sourcePath: dockerfilePath,
        targetPath,
        content: dockerfileContent,
        size: dockerfileContent.length
      };

    } catch (error) {
      logger.error('Failed to download Dockerfile from GitHub', {
        repo: githubRepo,
        targetPath,
        error: error.message
      });

      // Handle specific GitHub API errors
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.message || error.message;

        if (status === 401) {
          throw new Error('GitHub authentication failed. Please check your token.');
        } else if (status === 403) {
          throw new Error('GitHub API rate limit exceeded or insufficient permissions.');
        } else if (status === 404) {
          throw new Error(`Repository '${githubRepo}' not found or not accessible.`);
        } else {
          throw new Error(`GitHub API error (${status}): ${message}`);
        }
      }

      throw new Error(`Failed to download Dockerfile: ${error.message}`);
    }
  }

  // Get file content from GitHub API
  async getFileContent(api, repo, filePath) {
    try {
      const response = await api.get(`/repos/${repo}/contents/${filePath}`);
      
      // Update rate limit info
      this.updateRateLimit(response.headers);

      if (response.data.type !== 'file') {
        throw new Error(`'${filePath}' is not a file`);
      }

      // Decode base64 content
      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      
      return content;

    } catch (error) {
      if (error.response?.status === 404) {
        throw new Error(`File '${filePath}' not found in repository`);
      }
      throw error;
    }
  }

  // Get repository information
  async getRepositoryInfo(githubRepo, githubToken) {
    try {
      const api = this.createAxiosInstance(githubToken);
      const response = await api.get(`/repos/${githubRepo}`);
      
      this.updateRateLimit(response.headers);

      return {
        name: response.data.name,
        fullName: response.data.full_name,
        description: response.data.description,
        defaultBranch: response.data.default_branch,
        private: response.data.private,
        language: response.data.language,
        size: response.data.size,
        updatedAt: response.data.updated_at
      };

    } catch (error) {
      logger.error('Failed to get repository info', {
        repo: githubRepo,
        error: error.message
      });
      throw error;
    }
  }

  // List files in repository directory
  async listFiles(githubRepo, githubToken, dirPath = '') {
    try {
      const api = this.createAxiosInstance(githubToken);
      const response = await api.get(`/repos/${githubRepo}/contents/${dirPath}`);
      
      this.updateRateLimit(response.headers);

      if (!Array.isArray(response.data)) {
        throw new Error('Expected directory listing, got single file');
      }

      return response.data.map(item => ({
        name: item.name,
        path: item.path,
        type: item.type,
        size: item.size,
        sha: item.sha
      }));

    } catch (error) {
      logger.error('Failed to list repository files', {
        repo: githubRepo,
        dirPath,
        error: error.message
      });
      throw error;
    }
  }

  // Validate GitHub repository format
  validateRepoFormat(repo) {
    if (!repo || typeof repo !== 'string') {
      return false;
    }

    const parts = repo.split('/');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
  }

  // Update rate limit tracking
  updateRateLimit(headers) {
    this.rateLimit.remaining = headers['x-ratelimit-remaining'];
    this.rateLimit.reset = headers['x-ratelimit-reset'];
    
    if (this.rateLimit.remaining < 10) {
      logger.warn('GitHub API rate limit running low', {
        remaining: this.rateLimit.remaining,
        reset: new Date(this.rateLimit.reset * 1000).toISOString()
      });
    }
  }

  // Get rate limit status
  getRateLimit() {
    return {
      remaining: this.rateLimit.remaining,
      reset: this.rateLimit.reset ? new Date(this.rateLimit.reset * 1000) : null
    };
  }

  // Validate GitHub token
  async validateToken(githubToken) {
    try {
      const api = this.createAxiosInstance(githubToken);
      const response = await api.get('/user');
      
      this.updateRateLimit(response.headers);

      return {
        valid: true,
        user: {
          login: response.data.login,
          name: response.data.name,
          email: response.data.email
        },
        scopes: response.headers['x-oauth-scopes']?.split(', ') || []
      };

    } catch (error) {
      logger.error('GitHub token validation failed', {
        error: error.message
      });

      return {
        valid: false,
        error: error.message
      };
    }
  }
}

module.exports = GitHubAPI; 