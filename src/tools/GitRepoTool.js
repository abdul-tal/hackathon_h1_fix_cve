const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

class GitRepoTool {
  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp-repos');
    this.activeRepos = new Map(); // Track active repository clones
    this.ensureTempDir();
  }

  // Ensure temp directory exists
  async ensureTempDir() {
    try {
      await fs.ensureDir(this.tempDir);
      logger.debug('Git temp directory ensured', { tempDir: this.tempDir });
    } catch (error) {
      logger.error('Failed to create Git temp directory', { 
        error: error.message,
        tempDir: this.tempDir 
      });
    }
  }

  // Clone a Git repository
  async cloneRepository(repoUrl, githubToken, options = {}) {
    const cloneId = uuidv4().substring(0, 8);
    const repoName = this.extractRepoName(repoUrl);
    const clonePath = path.join(this.tempDir, `${repoName}-${cloneId}`);

    try {
      logger.info('Cloning Git repository', {
        repoUrl: this.sanitizeUrl(repoUrl),
        clonePath,
        cloneId
      });

      // Prepare authenticated URL if GitHub token provided
      const authenticatedUrl = this.prepareAuthenticatedUrl(repoUrl, githubToken);

      // Clone command with shallow clone for efficiency
      const cloneOptions = [
        '--depth=1', // Shallow clone
        '--single-branch', // Only clone default branch
        '--no-tags', // Skip tags
        ...(options.branch ? [`--branch=${options.branch}`] : [])
      ].join(' ');

      const cloneCommand = `git clone ${cloneOptions} "${authenticatedUrl}" "${clonePath}"`;
      
      // Execute clone with timeout
      const { stdout, stderr } = await execAsync(cloneCommand, {
        timeout: 60000, // 1 minute timeout
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0' // Disable interactive prompts
        }
      });

      // Track the cloned repository
      const repoInfo = {
        cloneId,
        repoUrl: this.sanitizeUrl(repoUrl),
        clonePath,
        createdAt: new Date(),
        branch: options.branch || 'default'
      };

      this.activeRepos.set(cloneId, repoInfo);

      logger.info('Repository cloned successfully', {
        cloneId,
        repoUrl: this.sanitizeUrl(repoUrl),
        clonePath,
        size: await this.getDirectorySize(clonePath)
      });

      return {
        cloneId,
        clonePath,
        repoInfo,
        stdout: stdout?.trim(),
        stderr: stderr?.trim()
      };

    } catch (error) {
      logger.error('Failed to clone repository', {
        repoUrl: this.sanitizeUrl(repoUrl),
        clonePath,
        error: error.message
      });

      // Cleanup on failure
      await this.cleanupRepository(cloneId);
      
      throw new Error(`Git clone failed: ${error.message}`);
    }
  }

  // Find Dockerfile in the cloned repository
  async findDockerfile(clonePath, options = {}) {
    try {
      logger.info('Searching for Dockerfile', { clonePath });

      const possiblePaths = [
        'Dockerfile',
        'dockerfile',
        'Dockerfile.prod',
        'Dockerfile.production',
        'docker/Dockerfile',
        '.docker/Dockerfile',
        'build/Dockerfile',
        'deployments/Dockerfile'
      ];

      // Add custom paths if provided
      if (options.dockerfilePath) {
        possiblePaths.unshift(options.dockerfilePath);
      }

      const foundDockerfiles = [];

      for (const dockerfilePath of possiblePaths) {
        const fullPath = path.join(clonePath, dockerfilePath);
        
        if (await fs.pathExists(fullPath)) {
          const stats = await fs.stat(fullPath);
          
          if (stats.isFile()) {
            const content = await fs.readFile(fullPath, 'utf8');
            
            foundDockerfiles.push({
              path: dockerfilePath,
              fullPath,
              size: stats.size,
              hasFromInstruction: content.includes('FROM'),
              content: content.substring(0, 500) // First 500 chars for logging
            });
          }
        }
      }

      if (foundDockerfiles.length === 0) {
        throw new Error('No Dockerfile found in repository');
      }

      // Prefer main Dockerfile, then others
      const primaryDockerfile = foundDockerfiles.find(df => df.path === 'Dockerfile') || foundDockerfiles[0];

      logger.info('Dockerfile found', {
        clonePath,
        dockerfilePath: primaryDockerfile.path,
        totalFound: foundDockerfiles.length,
        size: primaryDockerfile.size
      });

      return {
        primary: primaryDockerfile,
        all: foundDockerfiles
      };

    } catch (error) {
      logger.error('Failed to find Dockerfile', {
        clonePath,
        error: error.message
      });
      throw error;
    }
  }

  // Get repository information
  async getRepositoryInfo(clonePath) {
    try {
      const gitCommands = {
        branch: 'git rev-parse --abbrev-ref HEAD',
        commit: 'git rev-parse HEAD',
        remoteUrl: 'git config --get remote.origin.url',
        lastCommit: 'git log -1 --format="%H|%an|%ae|%ad|%s"'
      };

      const info = {};

      for (const [key, command] of Object.entries(gitCommands)) {
        try {
          const { stdout } = await execAsync(command, { 
            cwd: clonePath,
            timeout: 10000 
          });
          info[key] = stdout.trim();
        } catch (error) {
          info[key] = null;
          logger.debug(`Failed to get ${key}`, { error: error.message });
        }
      }

      // Parse last commit info
      if (info.lastCommit) {
        const [hash, author, email, date, message] = info.lastCommit.split('|');
        info.lastCommitDetails = { hash, author, email, date, message };
      }

      return info;
    } catch (error) {
      logger.warn('Failed to get repository info', {
        clonePath,
        error: error.message
      });
      return {};
    }
  }

  // Cleanup a specific repository
  async cleanupRepository(cloneId) {
    try {
      const repoInfo = this.activeRepos.get(cloneId);
      
      if (repoInfo && await fs.pathExists(repoInfo.clonePath)) {
        await fs.remove(repoInfo.clonePath);
        logger.info('Repository cleaned up', {
          cloneId,
          clonePath: repoInfo.clonePath
        });
      }

      this.activeRepos.delete(cloneId);
    } catch (error) {
      logger.warn('Failed to cleanup repository', {
        cloneId,
        error: error.message
      });
    }
  }

  // Cleanup all active repositories
  async cleanupAllRepositories() {
    try {
      logger.info('Cleaning up all repositories', {
        activeCount: this.activeRepos.size
      });

      const cleanupPromises = Array.from(this.activeRepos.keys()).map(
        cloneId => this.cleanupRepository(cloneId)
      );

      await Promise.allSettled(cleanupPromises);

      // Remove entire temp directory if empty
      if (await fs.pathExists(this.tempDir)) {
        try {
          await fs.remove(this.tempDir);
          logger.info('Temp directory removed', { tempDir: this.tempDir });
        } catch (error) {
          logger.debug('Could not remove temp directory', { 
            tempDir: this.tempDir,
            error: error.message 
          });
        }
      }

    } catch (error) {
      logger.error('Failed to cleanup all repositories', {
        error: error.message
      });
    }
  }

  // Extract repository name from URL
  extractRepoName(repoUrl) {
    try {
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split('/').filter(Boolean);
      const repoName = pathParts[pathParts.length - 1].replace(/\.git$/, '');
      return repoName || 'unknown-repo';
    } catch (error) {
      return 'unknown-repo';
    }
  }

  // Prepare authenticated URL for GitHub
  prepareAuthenticatedUrl(repoUrl, githubToken) {
    if (!githubToken || !repoUrl.includes('github.com')) {
      return repoUrl;
    }

    try {
      const url = new URL(repoUrl);
      // Use token authentication for GitHub
      url.username = githubToken;
      url.password = 'x-oauth-basic';
      return url.toString();
    } catch (error) {
      logger.warn('Failed to prepare authenticated URL', {
        error: error.message
      });
      return repoUrl;
    }
  }

  // Sanitize URL for logging (remove tokens)
  sanitizeUrl(repoUrl) {
    try {
      const url = new URL(repoUrl);
      url.username = '';
      url.password = '';
      return url.toString();
    } catch (error) {
      return repoUrl.replace(/:[^@]*@/, ':***@');
    }
  }

  // Get directory size
  async getDirectorySize(dirPath) {
    try {
      const { stdout } = await execAsync(`du -sh "${dirPath}" | cut -f1`, {
        timeout: 10000
      });
      return stdout.trim();
    } catch (error) {
      return 'unknown';
    }
  }

  // Get active repositories status
  getActiveRepositories() {
    return Array.from(this.activeRepos.entries()).map(([cloneId, info]) => ({
      cloneId,
      repoUrl: info.repoUrl,
      clonePath: info.clonePath,
      createdAt: info.createdAt,
      ageMinutes: Math.round((Date.now() - info.createdAt.getTime()) / 60000)
    }));
  }
}

module.exports = GitRepoTool; 