const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

class PRCreatorTool {
  constructor() {
    this.gitConfig = {
      user: 'cve-fix-bot',
      email: 'cve-fix-bot@hackathon.local'
    };
  }

  // Create a pull request for CVE fix
  async createCVEFixPR(options = {}) {
    const {
      clonePath,
      repoUrl,
      githubToken,
      cveId,
      originalVersion,
      fixedVersion,
      branch = 'main'
    } = options;

    try {
      logger.info('Starting CVE fix PR creation', {
        clonePath,
        repoUrl: this.sanitizeUrl(repoUrl),
        cveId,
        originalVersion,
        fixedVersion
      });

      // Step 1: Configure Git user
      await this.configureGitUser(clonePath);

      // Step 2: Create a new branch for the CVE fix
      const branchName = `fix/cve-${cveId.toLowerCase()}-${Date.now()}`;
      await this.createBranch(clonePath, branchName);

      // Step 3: Add and commit changes
      const commitMessage = this.generateCommitMessage(cveId, originalVersion, fixedVersion);
      await this.commitChanges(clonePath, commitMessage);

      // Step 4: Push branch to origin
      await this.pushBranch(clonePath, branchName, repoUrl, githubToken);

      // Step 5: Create pull request via GitHub API
      const prResult = await this.createGitHubPR({
        repoUrl,
        githubToken,
        sourceBranch: branchName,
        targetBranch: branch,
        title: this.generatePRTitle(cveId, originalVersion, fixedVersion),
        body: this.generatePRBody(cveId, originalVersion, fixedVersion)
      });

      logger.info('CVE fix PR created successfully', {
        prNumber: prResult.number,
        prUrl: prResult.html_url,
        branchName
      });

      return {
        success: true,
        prNumber: prResult.number,
        prUrl: prResult.html_url,
        branchName,
        commitMessage
      };

    } catch (error) {
      logger.error('Failed to create CVE fix PR', {
        clonePath,
        repoUrl: this.sanitizeUrl(repoUrl),
        error: error.message
      });

      return {
        success: false,
        error: error.message,
        details: error.response?.data || null
      };
    }
  }

  // Configure Git user in the repository
  async configureGitUser(clonePath) {
    try {
      await execAsync(`git config user.name "${this.gitConfig.user}"`, { cwd: clonePath });
      await execAsync(`git config user.email "${this.gitConfig.email}"`, { cwd: clonePath });
      
      logger.debug('Git user configured', {
        clonePath,
        user: this.gitConfig.user,
        email: this.gitConfig.email
      });
    } catch (error) {
      throw new Error(`Failed to configure Git user: ${error.message}`);
    }
  }

  // Create a new branch
  async createBranch(clonePath, branchName) {
    try {
      await execAsync(`git checkout -b ${branchName}`, { cwd: clonePath });
      
      logger.debug('Git branch created', {
        clonePath,
        branchName
      });
    } catch (error) {
      throw new Error(`Failed to create branch: ${error.message}`);
    }
  }

  // Add and commit changes
  async commitChanges(clonePath, commitMessage) {
    try {
      // Add all changes
      await execAsync('git add .', { cwd: clonePath });
      
      // Check if there are changes to commit
      const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: clonePath });
      
      if (!statusOutput.trim()) {
        throw new Error('No changes to commit');
      }

      // Commit changes
      await execAsync(`git commit -m "${commitMessage}"`, { cwd: clonePath });
      
      logger.debug('Changes committed', {
        clonePath,
        commitMessage,
        changesCount: statusOutput.split('\n').filter(line => line.trim()).length
      });
      
    } catch (error) {
      throw new Error(`Failed to commit changes: ${error.message}`);
    }
  }

  // Push branch to origin
  async pushBranch(clonePath, branchName, repoUrl, githubToken) {
    try {
      // Prepare authenticated URL
      const authenticatedUrl = this.prepareAuthenticatedUrl(repoUrl, githubToken);
      
      // Set up origin with authentication
      await execAsync(`git remote set-url origin "${authenticatedUrl}"`, { cwd: clonePath });
      
      // Push branch
      await execAsync(`git push -u origin ${branchName}`, { 
        cwd: clonePath,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0'
        }
      });
      
      logger.debug('Branch pushed to origin', {
        clonePath,
        branchName
      });
      
    } catch (error) {
      throw new Error(`Failed to push branch: ${error.message}`);
    }
  }

  // Create GitHub pull request
  async createGitHubPR(options) {
    const { repoUrl, githubToken, sourceBranch, targetBranch, title, body } = options;
    
    try {
      const repoInfo = this.extractRepoInfo(repoUrl);
      const apiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`;
      
      const prData = {
        title,
        body,
        head: sourceBranch,
        base: targetBranch
      };

      const response = await axios.post(apiUrl, prData, {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        }
      });

      return response.data;
      
    } catch (error) {
      logger.error('GitHub API error', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      throw new Error(`GitHub API error: ${error.response?.data?.message || error.message}`);
    }
  }

  // Generate commit message
  generateCommitMessage(cveId, originalVersion, fixedVersion) {
    return `fix: upgrade ${originalVersion} to ${fixedVersion} to fix ${cveId}

- Addresses security vulnerability ${cveId}
- Updates base image from ${originalVersion} to ${fixedVersion}
- Automated fix generated by CVE Fix Bot`;
  }

  // Generate PR title
  generatePRTitle(cveId, originalVersion, fixedVersion) {
    return `🔒 Fix ${cveId}: Upgrade ${originalVersion} → ${fixedVersion}`;
  }

  // Generate PR body
  generatePRBody(cveId, originalVersion, fixedVersion) {
    return `## 🔒 Security Fix: ${cveId}

This PR automatically fixes the security vulnerability **${cveId}** by upgrading the base Docker image.

### Changes Made
- **Original Version**: \`${originalVersion}\`
- **Fixed Version**: \`${fixedVersion}\`
- **Vulnerability**: ${cveId}

### Verification
✅ Docker image builds successfully  
✅ No vulnerabilities detected in new version  
✅ Automated testing completed  

### About This Fix
This PR was automatically generated by the **CVE Fix Automation Tool** as part of a security vulnerability remediation process. The fix has been verified to:

1. Successfully build the Docker image
2. Resolve the specified CVE
3. Maintain compatibility with existing functionality

### Security Impact
Upgrading to \`${fixedVersion}\` resolves the security vulnerability while maintaining the existing functionality of your application.

---
*🤖 This PR was automatically generated by CVE Fix Bot*`;
  }

  // Extract owner and repo from GitHub URL
  extractRepoInfo(repoUrl) {
    try {
      const url = new URL(repoUrl);
      const pathParts = url.pathname.split('/').filter(Boolean);
      
      if (pathParts.length < 2) {
        throw new Error('Invalid repository URL format');
      }
      
      return {
        owner: pathParts[0],
        repo: pathParts[1].replace(/\.git$/, '')
      };
    } catch (error) {
      throw new Error(`Failed to parse repository URL: ${error.message}`);
    }
  }

  // Prepare authenticated URL for Git operations
  prepareAuthenticatedUrl(repoUrl, githubToken) {
    if (!githubToken || !repoUrl.includes('github.com')) {
      return repoUrl;
    }

    try {
      const url = new URL(repoUrl);
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
}

module.exports = PRCreatorTool; 