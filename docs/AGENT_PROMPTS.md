# CVE Fix Agent Prompts - Updated for Comprehensive Workflow

The CVE Fix Agent has been updated with new prompts to support the comprehensive CVE scanning and fixing workflow. This document outlines the different prompt types and their usage scenarios.

## Prompt Types

### 1. GitHub Repository CVE Fix Prompt

**Method:** `createGitHubCVEPrompt(githubRepo, githubToken, dockerfilePath)`

**Purpose:** Guides the LangChain agent through the complete GitHub-based CVE fix workflow.

**Workflow Steps:**
1. **GitHub Integration**: Download Dockerfile from repository
2. **Comprehensive CVE Scanning**: Scan base image for ALL CVEs
3. **Fixability Analysis**: Determine which CVEs can be fixed
4. **Minimal Version Finding**: Find optimal version upgrade
5. **Dockerfile Update & Verification**: Apply fix and verify functionality

**Example Usage:**
```javascript
const prompt = agent.createGitHubCVEPrompt(
  'microsoft/vscode', 
  'ghp_token_here', 
  './Dockerfile'
);
const result = await agent.agent.call({ input: prompt });
```

**Response Format:**
```json
{
  "status": "success|failure|no_fix_available|no_action_needed",
  "message": "Detailed operation description",
  "original_version": "ubuntu:18.04",
  "fixed_version": "ubuntu:20.04",
  "cve_summary": {
    "total_found": 15,
    "total_fixed": 12,
    "unfixable": 3,
    "severity_breakdown": { "LOW": 5, "MEDIUM": 4, "HIGH": 4, "CRITICAL": 2 },
    "fixed_cves": [...],
    "unfixed_cves": [...]
  },
  "github_info": { "repository": "microsoft/vscode", "dockerfile_path": "Dockerfile" },
  "build_info": { "image_id": "sha256:...", "build_time": "2.5s", "container_test_passed": true }
}
```

### 2. Comprehensive Local CVE Fix Prompt

**Method:** `createComprehensiveCVEPrompt(dockerfilePath)`

**Purpose:** Guides the agent through comprehensive CVE fixing for a local Dockerfile.

**Workflow Steps:**
1. **CVE Discovery**: Scan current base image for all CVEs
2. **Fixability Analysis**: Determine which CVEs can be fixed
3. **Optimal Version Finding**: Find minimal version that fixes all fixable CVEs
4. **Update & Verification**: Apply fix and verify functionality

**Example Usage:**
```javascript
const prompt = agent.createComprehensiveCVEPrompt('./Dockerfile');
const result = await agent.agent.call({ input: prompt });
```

### 3. Single CVE Fix Prompt (Legacy)

**Method:** `createAgentPrompt(cveId, dockerfilePath)`

**Purpose:** Maintains backward compatibility for fixing specific individual CVEs.

**Example Usage:**
```javascript
const prompt = agent.createAgentPrompt('CVE-2021-3711', './Dockerfile');
const result = await agent.agent.call({ input: prompt });
```

## Available LangChain Tools

The agent now has access to enhanced tools for the comprehensive workflow:

### GitHub Integration Tools
- **`github_api`**: Download Dockerfile from GitHub repository
- **`github_token_validator`**: Validate GitHub tokens
- **`repo_info`**: Get repository information

### Comprehensive CVE Tools
- **`comprehensive_cve_scan`**: Scan for ALL CVEs in an image
- **`multi_cve_version_finder`**: Find minimal version fixing multiple CVEs

### Legacy Tools (Enhanced)
- **`dockerfile_parser`**: Parse and extract base image information
- **`docker_hub_api`**: Get available image versions
- **`trivy_scan`**: Scan for specific CVE (legacy support)
- **`version_finder`**: Find version fixing single CVE
- **`dockerfile_updater`**: Update Dockerfile with new version
- **`docker_build`**: Build Docker image
- **`docker_run`**: Test container execution

## Agent Execution Methods

### 1. GitHub-based Agent Execution

```javascript
// Using LangChain agent for GitHub workflow
const result = await agent.fixCVEsFromGitHubWithAgent(
  'owner/repo', 
  'github_token',
  './Dockerfile'
);

// Direct workflow (no LangChain agent)
const result = await agent.fixCVEsFromGitHub(
  'owner/repo', 
  'github_token',
  './Dockerfile'
);
```

### 2. Local Comprehensive CVE Fix

```javascript
// Using LangChain agent for local workflow
const result = await agent.fixAllCVEsWithAgent('./Dockerfile');

// Direct workflow (no LangChain agent)
const result = await agent.runComprehensiveDirectWorkflow('./Dockerfile');
```

### 3. Legacy Single CVE Fix

```javascript
// Using LangChain agent for single CVE
const result = await agent.fixCVE('CVE-2021-3711', './Dockerfile');

// Direct workflow for single CVE
const result = await agent.runDirectWorkflow('CVE-2021-3711', './Dockerfile');
```

## Fallback Strategy

The agent implements intelligent fallback:

1. **Primary**: Try LangChain agent with comprehensive prompts
2. **Fallback**: Use direct workflow if agent fails
3. **Graceful**: Always provide meaningful results

## Error Handling

The prompts include comprehensive error handling instructions:

- **GitHub Access Errors**: Token validation and repository access
- **CVE Scanning Errors**: Trivy integration issues
- **Docker Build Errors**: Build and container test failures
- **Version Finding Errors**: Docker Hub API issues

## Performance Considerations

- **Binary Search**: For large version sets (>50 versions)
- **Sequential Search**: For smaller version sets
- **Caching**: Results cached to improve repeated operations
- **Rate Limiting**: GitHub API rate limit awareness
- **Resource Cleanup**: Automatic Docker image and container cleanup

## Key Benefits of Updated Prompts

1. **Comprehensive Coverage**: Scans for ALL CVEs, not just one
2. **Optimal Upgrades**: Finds minimal version bump for maximum fixes
3. **GitHub Integration**: Works with any public repository
4. **Detailed Reporting**: Provides complete CVE analysis and fix results
5. **Verified Results**: Builds and tests updated containers
6. **Graceful Degradation**: Falls back to direct workflow when needed

## Example Comprehensive Response

```json
{
  "status": "success",
  "message": "Successfully fixed 12 out of 15 CVEs by upgrading ubuntu from 18.04 to 20.04",
  "original_version": "ubuntu:18.04",
  "fixed_version": "ubuntu:20.04",
  "cve_summary": {
    "total_found": 15,
    "total_fixed": 12,
    "unfixable": 3,
    "severity_breakdown": {
      "LOW": 5,
      "MEDIUM": 4,
      "HIGH": 4,
      "CRITICAL": 2
    },
    "fixed_cves": [
      {
        "id": "CVE-2021-3711",
        "severity": "HIGH",
        "description": "OpenSSL buffer overflow vulnerability",
        "package": "openssl"
      }
    ],
    "unfixed_cves": [
      {
        "id": "CVE-2023-0001", 
        "severity": "MEDIUM",
        "description": "Unfixable vulnerability",
        "package": "some-package"
      }
    ]
  },
  "github_info": {
    "repository": "owner/repo",
    "dockerfile_path": "Dockerfile"
  },
  "build_info": {
    "image_id": "sha256:abc123...",
    "build_time": "2.5s",
    "container_test_passed": true
  }
}
```

The updated prompts provide the LangChain agent with clear, comprehensive instructions for handling modern CVE fix workflows while maintaining backward compatibility and providing intelligent fallback mechanisms. 