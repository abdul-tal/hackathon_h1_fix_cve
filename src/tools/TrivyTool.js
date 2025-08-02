const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config/config');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

class TrivyTool {
  constructor() {
    this.cacheDir = config.trivy.cacheDir;
    this.timeout = config.trivy.timeout;
    this.mockMode = process.env.TRIVY_MOCK_MODE === 'true';
    this.ensureCacheDir();
  }

  // Mock CVE scan results for testing
  getMockCVEStatus(imageName, imageTag, cveId) {
    // Simulate realistic CVE scenarios
    const mockData = {
      'CVE-2021-3711': {
        // OpenSSL vulnerability - fixed in later versions
        ubuntu: {
          '18.04': { exists: true, severity: 'HIGH', description: 'OpenSSL buffer overflow vulnerability' },
          '18.04.1': { exists: true, severity: 'HIGH', description: 'OpenSSL buffer overflow vulnerability' },
          '18.04.2': { exists: true, severity: 'HIGH', description: 'OpenSSL buffer overflow vulnerability' },
          '18.04.3': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          '18.04.4': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          '18.04.5': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          '20.04': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          '22.04': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          'latest': { exists: false, severity: 'HIGH', description: 'Fixed in this version' }
        }
      },
      'CVE-2022-0778': {
        // Another OpenSSL vulnerability
        ubuntu: {
          '18.04': { exists: true, severity: 'HIGH', description: 'OpenSSL infinite loop vulnerability' },
          '18.04.1': { exists: true, severity: 'HIGH', description: 'OpenSSL infinite loop vulnerability' },
          '18.04.2': { exists: true, severity: 'HIGH', description: 'OpenSSL infinite loop vulnerability' },
          '18.04.3': { exists: true, severity: 'HIGH', description: 'OpenSSL infinite loop vulnerability' },
          '18.04.4': { exists: true, severity: 'HIGH', description: 'OpenSSL infinite loop vulnerability' },
          '18.04.5': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          '20.04': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          '22.04': { exists: false, severity: 'HIGH', description: 'Fixed in this version' },
          'latest': { exists: false, severity: 'HIGH', description: 'Fixed in this version' }
        }
      }
    };

    const normalizedImage = imageName.includes('/') ? imageName.split('/')[1] : imageName;
    const cveData = mockData[cveId];
    const imageData = cveData?.[normalizedImage];
    const versionData = imageData?.[imageTag];

    if (versionData) {
      return versionData;
    }

    // Default: CVE exists in older versions, fixed in newer ones
    const isOldVersion = imageTag.includes('18.04') || 
                        parseInt(imageTag.split('.')[0]) < 20 ||
                        imageTag === '1.0' || imageTag === '1.1';
    
    return {
      exists: isOldVersion,
      severity: 'MEDIUM',
      description: isOldVersion ? 'CVE exists in older version' : 'Fixed in newer version'
    };
  }

  // Ensure cache directory exists
  async ensureCacheDir() {
    try {
      await fs.ensureDir(this.cacheDir);
      logger.debug('Trivy cache directory ensured', { cacheDir: this.cacheDir });
    } catch (error) {
      logger.error('Failed to create Trivy cache directory', { 
        error: error.message,
        cacheDir: this.cacheDir 
      });
    }
  }

  // Check if Trivy is installed
  async checkTrivyInstalled() {
    try {
      const { stdout } = await execAsync('trivy --version');
      const version = stdout.trim();
      logger.debug('Trivy version check', { version });
      return true;
    } catch (error) {
      logger.error('Trivy not found or not installed', { error: error.message });
      throw new Error('Trivy CLI is not installed. Please install Trivy first.');
    }
  }

  // Update Trivy database
  async updateDatabase() {
    try {
      logger.info('Updating Trivy vulnerability database');
      
      const { stdout, stderr } = await execAsync(
        `trivy image --download-db-only --cache-dir ${this.cacheDir}`,
        { timeout: this.timeout }
      );
      
      logger.info('Trivy database updated successfully');
      return true;
    } catch (error) {
      logger.warn('Failed to update Trivy database', { 
        error: error.message,
        stderr: error.stderr 
      });
      // Don't throw - we can still try to scan with existing DB
      return false;
    }
  }

  // Scan Docker image for vulnerabilities
  async scanImage(imageName, imageTag = 'latest') {
    const fullImageName = `${imageName}:${imageTag}`;
    
    try {
      await this.checkTrivyInstalled();
      logger.info('Starting Trivy scan', { image: fullImageName });

      const command = [
        'trivy', 'image',
        '--format', 'json',
        '--cache-dir', this.cacheDir,
        '--timeout', Math.floor(this.timeout / 1000) + 's',
        fullImageName
      ].join(' ');

      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large scan results
      });

      if (stderr) {
        logger.warn('Trivy scan warnings', { 
          image: fullImageName, 
          warnings: stderr 
        });
      }

      const scanResult = JSON.parse(stdout);
      logger.info('Trivy scan completed', { 
        image: fullImageName,
        vulnerabilitiesFound: this.countVulnerabilities(scanResult)
      });

      return scanResult;

    } catch (error) {
      logger.error('Trivy scan failed', { 
        image: fullImageName,
        error: error.message 
      });
      throw new Error(`Failed to scan image ${fullImageName}: ${error.message}`);
    }
  }

  // Check if specific CVE exists in scan results
  checkCVEStatus(scanResult, cveId) {
    try {
      const cveInfo = {
        exists: false,
        severity: null,
        description: null,
        fixedVersion: null
      };

      if (!scanResult.Results) {
        return cveInfo;
      }

      for (const result of scanResult.Results) {
        if (!result.Vulnerabilities) continue;

        for (const vuln of result.Vulnerabilities) {
          if (vuln.VulnerabilityID === cveId) {
            cveInfo.exists = true;
            cveInfo.severity = vuln.Severity || 'UNKNOWN';
            cveInfo.description = vuln.Description || vuln.Title || 'No description available';
            cveInfo.fixedVersion = vuln.FixedVersion || null;
            
            logger.debug('CVE found in scan results', { 
              cveId,
              severity: cveInfo.severity,
              fixedVersion: cveInfo.fixedVersion
            });
            
            return cveInfo;
          }
        }
      }

      logger.debug('CVE not found in scan results', { cveId });
      return cveInfo;

    } catch (error) {
      logger.error('Error checking CVE status', { 
        cveId,
        error: error.message 
      });
      throw new Error(`Failed to check CVE status: ${error.message}`);
    }
  }

  // Check if CVE exists in a specific image version
  async checkCVEInVersion(imageName, imageTag, cveId) {
    // Mock mode for testing
    if (this.mockMode) {
      logger.info('Using mock Trivy scan', { imageName, imageTag, cveId });
      return this.getMockCVEStatus(imageName, imageTag, cveId);
    }

    try {
      const scanResult = await this.scanImage(imageName, imageTag);
      return this.checkCVEStatus(scanResult, cveId);
    } catch (error) {
      logger.error('Failed to check CVE in version', {
        image: `${imageName}:${imageTag}`,
        cveId,
        error: error.message
      });
      throw error;
    }
  }

  // Find which version fixes the CVE by scanning multiple versions
  async findFixedVersion(imageName, cveId, versions) {
    const results = [];
    
    logger.info('Finding fixed version for CVE', { 
      imageName,
      cveId,
      versionsToCheck: versions.length 
    });

    for (const version of versions) {
      try {
        const cveStatus = await this.checkCVEInVersion(imageName, version, cveId);
        
        results.push({
          version,
          cveExists: cveStatus.exists,
          severity: cveStatus.severity,
          fixedVersion: cveStatus.fixedVersion
        });

        // If CVE doesn't exist in this version, it's potentially fixed
        if (!cveStatus.exists) {
          logger.info('Found version without CVE', { 
            imageName,
            version,
            cveId 
          });
          return version;
        }

      } catch (error) {
        logger.warn('Failed to scan version', { 
          image: `${imageName}:${version}`,
          cveId,
          error: error.message 
        });
        
        results.push({
          version,
          error: error.message,
          cveExists: null
        });
      }
    }

    logger.info('Completed version scanning', { 
      imageName,
      cveId,
      results 
    });

    // No version found that fixes the CVE
    return null;
  }

  // Count total vulnerabilities in scan result
  countVulnerabilities(scanResult) {
    if (!scanResult.Results) return 0;
    
    let count = 0;
    for (const result of scanResult.Results) {
      if (result.Vulnerabilities) {
        count += result.Vulnerabilities.length;
      }
    }
    return count;
  }

  // Get vulnerability summary by severity
  getVulnerabilitySummary(scanResult) {
    const summary = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
      UNKNOWN: 0
    };

    if (!scanResult.Results) return summary;

    for (const result of scanResult.Results) {
      if (!result.Vulnerabilities) continue;
      
      for (const vuln of result.Vulnerabilities) {
        const severity = vuln.Severity || 'UNKNOWN';
        if (summary.hasOwnProperty(severity)) {
          summary[severity]++;
        } else {
          summary.UNKNOWN++;
        }
      }
    }

    return summary;
  }
}

module.exports = TrivyTool; 