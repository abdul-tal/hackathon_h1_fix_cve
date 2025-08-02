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
        error: error.message,
        githubApiResponse: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: {
            'x-ratelimit-remaining': error.response.headers['x-ratelimit-remaining'],
            'x-oauth-scopes': error.response.headers['x-oauth-scopes']
          }
        } : null
      });

      // Handle specific GitHub API errors
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.message || error.message;

        if (status === 401) {
          throw new Error(`GitHub authentication failed. Please check your token. GitHub says: ${message}`);
        } else if (status === 403) {
          throw new Error(`GitHub API rate limit exceeded or insufficient permissions. GitHub says: ${message}`);
        } else if (status === 404) {
          throw new Error(`Repository '${githubRepo}' not found or not accessible. GitHub says: ${message}`);
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

  // Create a Pull Request
  async createPullRequest(githubRepo, githubToken, options = {}) {
    try {
      logger.info('Creating pull request', {
        repo: githubRepo,
        title: options.title,
        head: options.head,
        base: options.base
      });

      // Validate repo format
      if (!this.validateRepoFormat(githubRepo)) {
        throw new Error('Invalid repository format. Expected: owner/repo');
      }

      const api = this.createAxiosInstance(githubToken);
      
      // Validate required options
      if (!options.title || !options.head || !options.base) {
        throw new Error('Missing required PR parameters: title, head, and base branches are required');
      }

      const prData = {
        title: options.title,
        head: options.head,
        base: options.base,
        body: options.body || '',
        draft: options.draft || false,
        maintainer_can_modify: options.maintainer_can_modify !== false
      };

      const response = await api.post(`/repos/${githubRepo}/pulls`, prData);
      
      this.updateRateLimit(response.headers);

      const pr = response.data;

      logger.info('Pull request created successfully', {
        repo: githubRepo,
        prNumber: pr.number,
        prUrl: pr.html_url,
        title: pr.title
      });

      return {
        success: true,
        pr: {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          state: pr.state,
          head: {
            ref: pr.head.ref,
            sha: pr.head.sha
          },
          base: {
            ref: pr.base.ref,
            sha: pr.base.sha
          },
          created_at: pr.created_at,
          mergeable: pr.mergeable,
          mergeable_state: pr.mergeable_state
        }
      };

    } catch (error) {
      logger.error('Failed to create pull request', {
        repo: githubRepo,
        error: error.message,
        options,
        githubApiResponse: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: {
            'x-ratelimit-remaining': error.response.headers['x-ratelimit-remaining'],
            'x-oauth-scopes': error.response.headers['x-oauth-scopes']
          }
        } : null
      });

      // Handle specific GitHub API errors
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.message || error.message;

        if (status === 401) {
          throw new Error(`GitHub authentication failed. Please check your token has repo access. GitHub says: ${message}`);
        } else if (status === 403) {
          throw new Error(`Insufficient permissions to create PR. Token needs repo/pull_requests write access. GitHub says: ${message}`);
        } else if (status === 404) {
          throw new Error(`Repository '${githubRepo}' not found or not accessible. GitHub says: ${message}`);
        } else if (status === 422) {
          throw new Error(`PR creation failed: ${message}. Check if branch exists and differs from base.`);
        } else {
          throw new Error(`GitHub API error (${status}): ${message}`);
        }
      }

      throw new Error(`Failed to create pull request: ${error.message}`);
    }
  }

  // Create a new branch from a base branch
  async createBranch(githubRepo, githubToken, newBranchName, baseBranch = 'main') {
    try {
      logger.info('Creating new branch', {
        repo: githubRepo,
        newBranch: newBranchName,
        baseBranch
      });

      // Validate repo format
      if (!this.validateRepoFormat(githubRepo)) {
        throw new Error('Invalid repository format. Expected: owner/repo');
      }

      const api = this.createAxiosInstance(githubToken);
      
      // Step 1: Get the SHA of the base branch
      const baseRefResponse = await api.get(`/repos/${githubRepo}/git/refs/heads/${baseBranch}`);
      const baseSha = baseRefResponse.data.object.sha;
      
      this.updateRateLimit(baseRefResponse.headers);

      // Step 2: Create new branch from base branch
      const createBranchData = {
        ref: `refs/heads/${newBranchName}`,
        sha: baseSha
      };

      const response = await api.post(`/repos/${githubRepo}/git/refs`, createBranchData);
      
      this.updateRateLimit(response.headers);

      const branch = response.data;

      logger.info('Branch created successfully', {
        repo: githubRepo,
        newBranch: newBranchName,
        baseBranch,
        sha: branch.object.sha
      });

      return {
        success: true,
        branch: {
          name: newBranchName,
          sha: branch.object.sha,
          ref: branch.ref,
          url: branch.url
        }
      };

    } catch (error) {
      logger.error('Failed to create branch', {
        repo: githubRepo,
        newBranch: newBranchName,
        baseBranch,
        error: error.message,
        githubApiResponse: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: {
            'x-ratelimit-remaining': error.response.headers['x-ratelimit-remaining'],
            'x-oauth-scopes': error.response.headers['x-oauth-scopes']
          }
        } : null
      });

      // Handle specific GitHub API errors
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.message || error.message;

        if (status === 401) {
          throw new Error(`GitHub authentication failed. Please check your token has repo access. GitHub says: ${message}`);
        } else if (status === 403) {
          throw new Error(`Insufficient permissions to create branch. Token needs repo write access. GitHub says: ${message}`);
        } else if (status === 404) {
          throw new Error(`Repository '${githubRepo}' or base branch '${baseBranch}' not found. GitHub says: ${message}`);
        } else if (status === 422) {
          throw new Error(`Branch creation failed: ${message}. Branch '${newBranchName}' might already exist.`);
        } else {
          throw new Error(`GitHub API error (${status}): ${message}`);
        }
      }

      throw new Error(`Failed to create branch: ${error.message}`);
    }
  }

  // Create a dummy commit on a branch to make it differ from base
  async createDummyCommit(githubRepo, githubToken, branchName, message = 'chore: initialize branch for PR') {
    try {
      logger.info('Creating dummy commit on branch', {
        repo: githubRepo,
        branch: branchName
      });

      const api = this.createAxiosInstance(githubToken);
      
      // Get the current branch reference
      const branchResponse = await api.get(`/repos/${githubRepo}/git/refs/heads/${branchName}`);
      const branchSha = branchResponse.data.object.sha;
      
      this.updateRateLimit(branchResponse.headers);

      // Get the current commit details
      const commitResponse = await api.get(`/repos/${githubRepo}/git/commits/${branchSha}`);
      const treeSha = commitResponse.data.tree.sha;
      
      this.updateRateLimit(commitResponse.headers);

      // Create a new file with timestamp content
      const timestamp = new Date().toISOString();
      const fileName = '.github/branch-info.md';
      const fileContent = `# Branch Information\n\nBranch: ${branchName}\nCreated: ${timestamp}\nPurpose: Automated branch for PR creation\n`;
      const encodedContent = Buffer.from(fileContent, 'utf8').toString('base64');

      // Create a new blob for the file
      const blobResponse = await api.post(`/repos/${githubRepo}/git/blobs`, {
        content: encodedContent,
        encoding: 'base64'
      });
      const blobSha = blobResponse.data.sha;
      
      this.updateRateLimit(blobResponse.headers);

      // Create a new tree with the file
      const treeResponse = await api.post(`/repos/${githubRepo}/git/trees`, {
        base_tree: treeSha,
        tree: [{
          path: fileName,
          mode: '100644',
          type: 'blob',
          sha: blobSha
        }]
      });
      const newTreeSha = treeResponse.data.sha;
      
      this.updateRateLimit(treeResponse.headers);

      // Create a new commit
      const newCommitResponse = await api.post(`/repos/${githubRepo}/git/commits`, {
        message,
        tree: newTreeSha,
        parents: [branchSha]
      });
      const newCommitSha = newCommitResponse.data.sha;
      
      this.updateRateLimit(newCommitResponse.headers);

      // Update the branch reference to point to the new commit
      const updateRefResponse = await api.patch(`/repos/${githubRepo}/git/refs/heads/${branchName}`, {
        sha: newCommitSha
      });
      
      this.updateRateLimit(updateRefResponse.headers);

      logger.info('Dummy commit created successfully', {
        repo: githubRepo,
        branch: branchName,
        commitSha: newCommitSha,
        fileName
      });

      return {
        success: true,
        commit: {
          sha: newCommitSha,
          message,
          fileName,
          url: newCommitResponse.data.html_url
        }
      };

    } catch (error) {
      logger.error('Failed to create dummy commit', {
        repo: githubRepo,
        branch: branchName,
        error: error.message,
        githubApiResponse: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: {
            'x-ratelimit-remaining': error.response.headers['x-ratelimit-remaining'],
            'x-oauth-scopes': error.response.headers['x-oauth-scopes']
          }
        } : null
      });

      throw new Error(`Failed to create dummy commit: ${error.message}`);
    }
  }

  // Get existing Pull Requests
  async getPullRequests(githubRepo, githubToken, state = 'open') {
    try {
      const api = this.createAxiosInstance(githubToken);
      const response = await api.get(`/repos/${githubRepo}/pulls`, {
        params: { state, per_page: 100 }
      });
      
      this.updateRateLimit(response.headers);

      return response.data.map(pr => ({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        state: pr.state,
        head: pr.head.ref,
        base: pr.base.ref,
        created_at: pr.created_at,
        user: pr.user.login
      }));

    } catch (error) {
      logger.error('Failed to get pull requests', {
        repo: githubRepo,
        error: error.message
      });
      throw error;
    }
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