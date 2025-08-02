const semver = require('semver');
const config = require('../config/config');
const logger = require('../utils/logger');

class VersionFinder {
  constructor(trivyTool, dockerHubAPI) {
    this.trivyTool = trivyTool;
    this.dockerHubAPI = dockerHubAPI;
    this.strategy = config.versionSearch.strategy || 'sequential'; // sequential, binary, auto
    this.maxConcurrentScans = config.performance.maxConcurrentScans || 3;
    this.cache = new Map(); // Cache scan results
  }

  // Main entry point: find minimal version that fixes CVE
  async findMinimalFixVersion(imageName, cveId, currentVersion, options = {}) {
    try {
      logger.info('Starting version finder', {
        imageName,
        cveId,
        currentVersion,
        strategy: this.strategy
      });

      // Get available versions
      const availableVersions = await this.getAvailableVersions(imageName, currentVersion, options);
      
      if (availableVersions.length === 0) {
        logger.warn('No newer versions available', { imageName, currentVersion });
        return null;
      }

      // Choose search strategy
      const searchStrategy = this.chooseSearchStrategy(availableVersions.length, options.strategy);
      
      logger.info('Using search strategy', {
        strategy: searchStrategy,
        versionsToCheck: availableVersions.length
      });

      // Execute search
      let fixedVersion;
      if (searchStrategy === 'binary') {
        fixedVersion = await this.binarySearchFix(imageName, cveId, availableVersions);
      } else {
        fixedVersion = await this.sequentialSearchFix(imageName, cveId, availableVersions);
      }

      if (fixedVersion) {
        logger.info('Found minimal fix version', {
          imageName,
          cveId,
          currentVersion,
          fixedVersion
        });
      } else {
        logger.info('No fix version found', {
          imageName,
          cveId,
          currentVersion,
          versionsChecked: availableVersions.length
        });
      }

      return fixedVersion;

    } catch (error) {
      logger.error('Version finder failed', {
        imageName,
        cveId,
        currentVersion,
        error: error.message
      });
      throw new Error(`Version finder failed: ${error.message}`);
    }
  }

  // Get available versions newer than current version
  async getAvailableVersions(imageName, currentVersion, options = {}) {
    try {
      logger.debug('Fetching available versions', { imageName, currentVersion });

      // Get all tags from Docker Hub
      const allTags = await this.dockerHubAPI.getAvailableTags(imageName);
      
      // Filter to only newer versions
      const newerVersions = this.dockerHubAPI.getVersionsNewerThan(allTags, currentVersion);
      
      // Apply additional filters
      const filteredVersions = this.filterVersions(newerVersions, options);
      
      // Sort by semantic version (earliest first for minimal upgrade)
      const sortedVersions = this.sortVersionsAscending(filteredVersions);

      logger.debug('Available versions processed', {
        imageName,
        totalTags: allTags.length,
        newerVersions: newerVersions.length,
        filteredVersions: sortedVersions.length
      });

      return sortedVersions;

    } catch (error) {
      logger.error('Failed to get available versions', {
        imageName,
        currentVersion,
        error: error.message
      });
      throw error;
    }
  }

  // Sequential search: check versions one by one from earliest to latest
  async sequentialSearchFix(imageName, cveId, versions) {
    logger.info('Starting sequential search', {
      imageName,
      cveId,
      versionsCount: versions.length
    });

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      
      try {
        logger.debug('Checking version sequentially', {
          imageName,
          version,
          progress: `${i + 1}/${versions.length}`
        });

        const cveExists = await this.checkCVEInVersion(imageName, version, cveId);
        
        if (!cveExists) {
          logger.info('Found fix in sequential search', {
            imageName,
            cveId,
            fixedVersion: version,
            versionsChecked: i + 1
          });
          return version;
        }

      } catch (error) {
        logger.warn('Failed to check version in sequential search', {
          imageName,
          version,
          cveId,
          error: error.message
        });
        // Continue with next version
      }
    }

    logger.info('Sequential search completed - no fix found', {
      imageName,
      cveId,
      versionsChecked: versions.length
    });

    return null;
  }

  // Binary search: efficiently find the earliest fixed version
  async binarySearchFix(imageName, cveId, versions) {
    logger.info('Starting binary search', {
      imageName,
      cveId,
      versionsCount: versions.length
    });

    let left = 0;
    let right = versions.length - 1;
    let lastFixedVersion = null;
    let checksPerformed = 0;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const version = versions[mid];
      checksPerformed++;

      try {
        logger.debug('Checking version in binary search', {
          imageName,
          version,
          position: `${mid + 1}/${versions.length}`,
          range: `[${left + 1}, ${right + 1}]`
        });

        const cveExists = await this.checkCVEInVersion(imageName, version, cveId);

        if (!cveExists) {
          // CVE is fixed in this version, try to find an earlier fix
          lastFixedVersion = version;
          right = mid - 1;
          
          logger.debug('CVE fixed, searching for earlier version', {
            imageName,
            cveId,
            version,
            newRange: `[${left + 1}, ${right + 1}]`
          });
        } else {
          // CVE still exists, need a later version
          left = mid + 1;
          
          logger.debug('CVE still exists, searching later versions', {
            imageName,
            cveId,
            version,
            newRange: `[${left + 1}, ${right + 1}]`
          });
        }

      } catch (error) {
        logger.warn('Failed to check version in binary search', {
          imageName,
          version,
          cveId,
          error: error.message
        });
        
        // Skip this version by adjusting search range
        if (mid === left) {
          left++;
        } else {
          right = mid - 1;
        }
      }
    }

    logger.info('Binary search completed', {
      imageName,
      cveId,
      fixedVersion: lastFixedVersion,
      checksPerformed,
      efficiency: `${checksPerformed}/${versions.length} checks`
    });

    return lastFixedVersion;
  }

  // Check if CVE exists in a specific version (with caching)
  async checkCVEInVersion(imageName, version, cveId) {
    const cacheKey = `${imageName}:${version}:${cveId}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      logger.debug('Using cached CVE check result', {
        imageName,
        version,
        cveId,
        result: cached
      });
      return cached;
    }

    try {
      const cveStatus = await this.trivyTool.checkCVEInVersion(imageName, version, cveId);
      const cveExists = cveStatus.exists;
      
      // Cache the result
      this.cache.set(cacheKey, cveExists);
      
      logger.debug('CVE check completed', {
        imageName,
        version,
        cveId,
        exists: cveExists,
        severity: cveStatus.severity
      });

      return cveExists;

    } catch (error) {
      logger.error('CVE check failed', {
        imageName,
        version,
        cveId,
        error: error.message
      });
      throw error;
    }
  }

  // Choose search strategy based on version count and configuration
  chooseSearchStrategy(versionCount, overrideStrategy = null) {
    if (overrideStrategy) {
      return overrideStrategy;
    }

    if (this.strategy === 'auto') {
      // Use binary search for large version lists, sequential for small ones
      return versionCount > 20 ? 'binary' : 'sequential';
    }

    return this.strategy;
  }

  // Filter versions based on options
  filterVersions(versions, options = {}) {
    let filtered = [...versions];

    // Filter by maximum versions to check
    if (options.maxVersions && filtered.length > options.maxVersions) {
      logger.debug('Limiting versions to check', {
        original: filtered.length,
        limited: options.maxVersions
      });
      filtered = filtered.slice(0, options.maxVersions);
    }

    // Filter by version pattern
    if (options.versionPattern) {
      const pattern = new RegExp(options.versionPattern, 'i');
      filtered = filtered.filter(version => pattern.test(version));
      
      logger.debug('Filtered by version pattern', {
        pattern: options.versionPattern,
        before: versions.length,
        after: filtered.length
      });
    }

    // Filter by release type (stable, beta, etc.)
    if (options.releaseType === 'stable') {
      filtered = filtered.filter(version => this.isStableVersion(version));
      
      logger.debug('Filtered to stable versions only', {
        before: versions.length,
        after: filtered.length
      });
    }

    return filtered;
  }

  // Sort versions in ascending order (earliest first)
  sortVersionsAscending(versions) {
    const semverVersions = [];
    const nonSemverVersions = [];

    // Separate semantic and non-semantic versions
    for (const version of versions) {
      if (semver.valid(semver.coerce(version))) {
        semverVersions.push(version);
      } else {
        nonSemverVersions.push(version);
      }
    }

    // Sort semantic versions in ascending order
    semverVersions.sort((a, b) => {
      const versionA = semver.coerce(a);
      const versionB = semver.coerce(b);
      return semver.compare(versionA, versionB);
    });

    // For non-semantic versions, sort alphabetically
    nonSemverVersions.sort();

    // Return semantic versions first (they're more reliable), then others
    return [...semverVersions, ...nonSemverVersions];
  }

  // Check if a version looks like a stable release
  isStableVersion(version) {
    const unstablePatterns = [
      /beta/i, /alpha/i, /rc/i, /dev/i, /test/i,
      /snapshot/i, /nightly/i, /edge/i, /experimental/i,
      /preview/i, /pre/i
    ];

    return !unstablePatterns.some(pattern => pattern.test(version));
  }

  // Parallel version checking (for performance optimization)
  async checkVersionsInParallel(imageName, cveId, versions, maxConcurrent = null) {
    const concurrent = maxConcurrent || this.maxConcurrentScans;
    const results = [];
    
    logger.debug('Starting parallel version checks', {
      imageName,
      cveId,
      versionsCount: versions.length,
      maxConcurrent: concurrent
    });

    // Process versions in batches
    for (let i = 0; i < versions.length; i += concurrent) {
      const batch = versions.slice(i, i + concurrent);
      
      const batchPromises = batch.map(async (version) => {
        try {
          const cveExists = await this.checkCVEInVersion(imageName, version, cveId);
          return { version, cveExists, success: true };
        } catch (error) {
          logger.warn('Parallel version check failed', {
            imageName,
            version,
            error: error.message
          });
          return { version, cveExists: null, success: false, error: error.message };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      logger.debug('Parallel batch completed', {
        batchSize: batch.length,
        completed: results.length,
        total: versions.length
      });
    }

    return results;
  }

  // Get search statistics
  getSearchStats() {
    return {
      cacheSize: this.cache.size,
      strategy: this.strategy,
      maxConcurrentScans: this.maxConcurrentScans
    };
  }

  // Clear cache
  clearCache() {
    const cacheSize = this.cache.size;
    this.cache.clear();
    
    logger.debug('Version finder cache cleared', { 
      clearedEntries: cacheSize 
    });
  }

  // Estimate search efficiency
  estimateSearchEfficiency(versionCount, strategy = null) {
    const searchStrategy = strategy || this.chooseSearchStrategy(versionCount);
    
    if (searchStrategy === 'binary') {
      return {
        strategy: 'binary',
        estimatedChecks: Math.ceil(Math.log2(versionCount)),
        efficiency: `O(log n)`,
        percentage: (Math.ceil(Math.log2(versionCount)) / versionCount * 100).toFixed(1)
      };
    } else {
      return {
        strategy: 'sequential',
        estimatedChecks: Math.ceil(versionCount / 2), // Average case
        efficiency: `O(n)`,
        percentage: '50.0' // Average case
      };
    }
  }

  // Find minimal version that fixes multiple CVEs (new method for comprehensive fixing)
  async findMinimalFixVersionForMultipleCVEs(imageName, cveIds, currentVersion, options = {}) {
    try {
      logger.info('Starting multi-CVE version finder', {
        imageName,
        cveCount: cveIds.length,
        currentVersion,
        strategy: this.strategy
      });

      // Get available versions
      const availableVersions = await this.getAvailableVersions(imageName, currentVersion, options);
      
      if (availableVersions.length === 0) {
        logger.warn('No newer versions available for multi-CVE fix', { imageName, currentVersion });
        return {
          fixedVersion: null,
          fixedCVEs: [],
          unfixedCVEs: cveIds,
          versionDetails: null
        };
      }

      // First, check which CVEs are fixable by scanning the latest version
      const latestVersion = availableVersions[availableVersions.length - 1];
      const fixabilityCheck = await this.checkCVEFixability(imageName, latestVersion, cveIds);
      
      const fixableCVEs = fixabilityCheck.fixableCVEs;
      const unfixableCVEs = fixabilityCheck.unfixableCVEs;

      logger.info('CVE fixability analysis completed', {
        totalCVEs: cveIds.length,
        fixableCVEs: fixableCVEs.length,
        unfixableCVEs: unfixableCVEs.length,
        latestVersion
      });

      if (fixableCVEs.length === 0) {
        return {
          fixedVersion: null,
          fixedCVEs: [],
          unfixedCVEs: cveIds,
          versionDetails: `No CVEs can be fixed. All ${cveIds.length} CVEs still exist in latest version ${latestVersion}`
        };
      }

      // Find minimal version that fixes all fixable CVEs
      const searchStrategy = this.chooseSearchStrategy(availableVersions.length, options.strategy);
      
      logger.info('Using search strategy for multi-CVE fix', {
        strategy: searchStrategy,
        versionsToCheck: availableVersions.length,
        fixableCVEs: fixableCVEs.length
      });

      let fixedVersion;
      if (searchStrategy === 'binary') {
        fixedVersion = await this.binarySearchMultiCVEFix(imageName, fixableCVEs, availableVersions);
      } else {
        fixedVersion = await this.sequentialSearchMultiCVEFix(imageName, fixableCVEs, availableVersions);
      }

      const result = {
        fixedVersion,
        fixedCVEs: fixedVersion ? fixableCVEs : [],
        unfixedCVEs: unfixableCVEs,
        versionDetails: this.createVersionDetails(fixedVersion, fixableCVEs, unfixableCVEs, currentVersion)
      };

      logger.info('Multi-CVE version finder completed', {
        imageName,
        currentVersion,
        fixedVersion,
        fixedCVECount: result.fixedCVEs.length,
        unfixedCVECount: result.unfixedCVEs.length
      });

      return result;

    } catch (error) {
      logger.error('Multi-CVE version finder failed', {
        imageName,
        cveIds,
        currentVersion,
        error: error.message
      });
      throw new Error(`Multi-CVE version finder failed: ${error.message}`);
    }
  }

  // Check which CVEs can be fixed by examining the latest version
  async checkCVEFixability(imageName, latestVersion, cveIds) {
    try {
      const latestCVECheck = await this.trivyTool.checkMultipleCVEsInVersion(
        imageName, 
        latestVersion, 
        cveIds
      );

      const fixableCVEs = [];
      const unfixableCVEs = [];

      for (const cveId of cveIds) {
        const cveResult = latestCVECheck.results[cveId];
        if (cveResult && !cveResult.exists) {
          fixableCVEs.push(cveId);
        } else {
          unfixableCVEs.push(cveId);
        }
      }

      return { fixableCVEs, unfixableCVEs };

    } catch (error) {
      logger.error('CVE fixability check failed', {
        imageName,
        latestVersion,
        cveIds,
        error: error.message
      });
      throw new Error(`CVE fixability check failed: ${error.message}`);
    }
  }

  // Sequential search for version that fixes multiple CVEs
  async sequentialSearchMultiCVEFix(imageName, cveIds, versions) {
    logger.info('Starting sequential search for multi-CVE fix', {
      imageName,
      cveCount: cveIds.length,
      versionsToCheck: versions.length
    });

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      
      try {
        const allFixed = await this.checkAllCVEsFixed(imageName, version, cveIds);
        
        if (allFixed) {
          logger.info('Found minimal fix version for all CVEs', {
            imageName,
            version,
            checkedVersions: i + 1,
            totalVersions: versions.length
          });
          return version;
        }

        // Add small delay to avoid overwhelming the system
        if (i < versions.length - 1) {
          await this.delay(100);
        }

      } catch (error) {
        logger.warn('Error checking version during sequential search', {
          imageName,
          version,
          error: error.message
        });
        // Continue with next version
      }
    }

    logger.warn('No version found that fixes all CVEs', {
      imageName,
      cveIds,
      versionsChecked: versions.length
    });
    
    return null;
  }

  // Binary search for version that fixes multiple CVEs
  async binarySearchMultiCVEFix(imageName, cveIds, versions) {
    logger.info('Starting binary search for multi-CVE fix', {
      imageName,
      cveCount: cveIds.length,
      versionsToCheck: versions.length
    });

    let left = 0;
    let right = versions.length - 1;
    let bestFixVersion = null;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const version = versions[mid];

      try {
        const allFixed = await this.checkAllCVEsFixed(imageName, version, cveIds);

        if (allFixed) {
          bestFixVersion = version;
          right = mid - 1; // Look for earlier version
          logger.debug('Binary search: CVEs fixed in version', {
            version,
            position: mid
          });
        } else {
          left = mid + 1; // Look for later version
          logger.debug('Binary search: CVEs not fixed in version', {
            version,
            position: mid
          });
        }

      } catch (error) {
        logger.warn('Error during binary search', {
          imageName,
          version,
          error: error.message
        });
        // Continue search by eliminating this version
        left = mid + 1;
      }
    }

    if (bestFixVersion) {
      logger.info('Binary search found minimal fix version', {
        imageName,
        fixedVersion: bestFixVersion
      });
    } else {
      logger.warn('Binary search found no fix version', {
        imageName,
        cveIds
      });
    }

    return bestFixVersion;
  }

  // Check if all CVEs are fixed in a specific version
  async checkAllCVEsFixed(imageName, version, cveIds) {
    try {
      const cacheKey = `${imageName}:${version}:${cveIds.sort().join(',')}`;
      
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        logger.debug('Using cached multi-CVE result', { imageName, version, cveCount: cveIds.length });
        return cached;
      }

      const multiCVECheck = await this.trivyTool.checkMultipleCVEsInVersion(
        imageName,
        version,
        cveIds
      );

      // Check if all requested CVEs are fixed (not present)
      const allFixed = cveIds.every(cveId => {
        const cveResult = multiCVECheck.results[cveId];
        return cveResult && !cveResult.exists;
      });

      // Cache the result
      this.cache.set(cacheKey, allFixed);

      logger.debug('Multi-CVE check result', {
        imageName,
        version,
        allFixed,
        fixedCount: Object.values(multiCVECheck.results).filter(r => !r.exists).length,
        totalCount: cveIds.length
      });

      return allFixed;

    } catch (error) {
      logger.error('Failed to check if all CVEs are fixed', {
        imageName,
        version,
        cveIds,
        error: error.message
      });
      throw error;
    }
  }

  // Create detailed version information for the result
  createVersionDetails(fixedVersion, fixedCVEs, unfixedCVEs, currentVersion) {
    if (!fixedVersion) {
      return `Unable to find a version that fixes all CVEs. ${unfixedCVEs.length} CVEs remain unfixed in all available versions.`;
    }

    const parts = [];
    
    if (fixedCVEs.length > 0) {
      parts.push(`Fixed ${fixedCVEs.length} CVE(s) by upgrading from ${currentVersion} to ${fixedVersion}`);
    }
    
    if (unfixedCVEs.length > 0) {
      parts.push(`${unfixedCVEs.length} CVE(s) cannot be fixed and require manual attention: ${unfixedCVEs.join(', ')}`);
    }

    return parts.join('. ');
  }

  // Utility method for delays
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = VersionFinder; 