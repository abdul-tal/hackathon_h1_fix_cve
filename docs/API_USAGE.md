# CVE Fix API - GitHub Integration Guide

The CVE Fix API has been updated to provide comprehensive CVE scanning and fixing from GitHub repositories. This new workflow scans for ALL CVEs in a Docker base image and finds the minimal version bump needed to fix all fixable CVEs.

## API Endpoint

```
POST /fix-cve
```

## New Request Format

```json
{
  "github_repo": "owner/repository-name",
  "github_token": "your_github_personal_access_token"
}
```

### Parameters

- **github_repo** (required): GitHub repository in format `owner/repo` (e.g., `microsoft/vscode`)
- **github_token** (required): GitHub Personal Access Token with repository read permissions

## Response Format

The API now returns a comprehensive response with detailed CVE information:

```json
{
  "status": "success|failure|no_fix_available|no_action_needed",
  "message": "Descriptive message about the operation",
  "original_version": "original_image:tag",
  "fixed_version": "updated_image:tag",
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
  },
  "requestId": "uuid-string",
  "processingTime": "45000ms",
  "timestamp": "2025-01-23T10:30:00.000Z"
}
```

## Workflow Overview

The new API performs the following steps:

1. **GitHub Integration**: Downloads Dockerfile from the specified repository
2. **Comprehensive CVE Scanning**: Scans the base image for ALL CVEs present
3. **Dockerfile Parsing**: Extracts current base image and version
4. **Latest Version Check**: Checks the latest available version on Docker Hub
5. **Fixability Analysis**: Determines which CVEs can be fixed in the latest version
6. **Minimal Version Finding**: Finds the minimal version bump that fixes all fixable CVEs
7. **Dockerfile Update**: Updates the Dockerfile with the optimal fix version
8. **Build Verification**: Builds the Docker image to ensure it works
9. **Container Testing**: Runs the container to verify functionality
10. **Comprehensive Response**: Returns detailed information about all CVEs found and fixed

## Example Usage

### cURL Example

```bash
curl -X POST http://localhost:3000/api/fix-cve \
  -H "Content-Type: application/json" \
  -d '{
    "github_repo": "your-username/your-repo",
    "github_token": "ghp_your_token_here"
  }'
```

### Node.js Example

```javascript
const axios = require('axios');

async function fixCVEs() {
  try {
    const response = await axios.post('http://localhost:3000/api/fix-cve', {
      github_repo: 'your-username/your-repo',
      github_token: 'ghp_your_token_here'
    });

    console.log('CVE Fix Results:');
    console.log(`Status: ${response.data.status}`);
    console.log(`Message: ${response.data.message}`);
    console.log(`Total CVEs Found: ${response.data.cve_summary.total_found}`);
    console.log(`CVEs Fixed: ${response.data.cve_summary.total_fixed}`);
    console.log(`Unfixable CVEs: ${response.data.cve_summary.unfixable}`);
    
    if (response.data.fixed_version) {
      console.log(`Version Updated: ${response.data.original_version} → ${response.data.fixed_version}`);
    }
  } catch (error) {
    console.error('CVE Fix Failed:', error.response?.data || error.message);
  }
}

fixCVEs();
```

## GitHub Token Setup

1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token with the following permissions:
   - `repo` (for private repositories) or `public_repo` (for public repositories only)
3. Copy the token and use it in your API requests

## Response Status Types

- **success**: CVEs were found and some/all were successfully fixed
- **no_action_needed**: No CVEs were found in the current base image
- **no_fix_available**: CVEs were found but none can be fixed with available versions
- **failure**: An error occurred during processing

## Error Handling

The API includes comprehensive error handling for:

- Invalid GitHub repository format
- Invalid or expired GitHub tokens
- Missing Dockerfile in repository
- Docker build failures
- Network timeouts
- Invalid base images

## Performance Considerations

- Processing time varies based on the number of CVEs and available versions
- The API uses intelligent search strategies (binary search for large version sets)
- Results are cached to improve performance for repeated scans
- Timeout protection prevents hanging requests

## Security Features

- GitHub tokens are validated before use
- Input sanitization prevents injection attacks
- Temporary files are cleaned up after processing
- Docker images are removed after testing

## Limitations

- Only works with repositories containing a Dockerfile
- Requires Docker to be installed and running
- GitHub API rate limits apply
- Some CVEs may not be fixable with available versions
- Processing time increases with the number of CVEs found

## Migration from Old API

The previous API that required a specific `cve_id` has been replaced. To migrate:

**Old format:**
```json
{
  "cve_id": "CVE-2021-3711"
}
```

**New format:**
```json
{
  "github_repo": "owner/repo",
  "github_token": "token"
}
```

The new API automatically detects and fixes ALL CVEs, providing much more comprehensive security improvements. 