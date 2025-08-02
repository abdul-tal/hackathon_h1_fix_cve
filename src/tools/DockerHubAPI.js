const axios = require('axios');
const semver = require('semver');
const config = require('../config/config');
const logger = require('../utils/logger');

class DockerHubAPI {
  constructor() {
    this.baseURL = 'https://registry.hub.docker.com/v2';
    this.authURL = 'https://auth.docker.io/token';
    this.hubURL = 'https://hub.docker.com/v2';
    this.rateLimitDelay = 1000; // 1 second between requests
    this.maxRetries = 3;
    this.cache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.mockMode = process.env.DOCKER_HUB_MOCK_MODE === 'true';
  }

  // Mock data for testing
  getMockTags(imageName) {
    const mockData = {
             ubuntu: [
         { name: 'latest', full_size: 30245728, last_updated: '2024-04-15T23:00:00Z' },
         { name: '22.04', full_size: 30145728, last_updated: '2024-04-01T22:00:00Z' },
         { name: '20.04.3', full_size: 29445728, last_updated: '2024-03-15T21:30:00Z' },
         { name: '20.04.2', full_size: 29345728, last_updated: '2024-02-01T20:00:00Z' },
         { name: '20.04.1', full_size: 29245728, last_updated: '2024-01-15T19:30:00Z' },
         { name: '20.04', full_size: 29145728, last_updated: '2023-12-01T18:00:00Z' },
         { name: '18.04.6', full_size: 28745728, last_updated: '2023-11-15T17:30:00Z' },
         { name: '18.04.5', full_size: 28645728, last_updated: '2023-10-01T16:00:00Z' },
         { name: '18.04.4', full_size: 28545728, last_updated: '2023-09-15T15:30:00Z' },
         { name: '18.04.3', full_size: 28445728, last_updated: '2023-08-01T14:00:00Z' },
         { name: '18.04.2', full_size: 28345728, last_updated: '2023-07-15T12:30:00Z' },
         { name: '18.04.1', full_size: 28245728, last_updated: '2023-06-01T11:00:00Z' },
         { name: '18.04', full_size: 28145728, last_updated: '2023-05-15T10:30:00Z' }
       ],
      node: [
        { name: '16', full_size: 345728000, last_updated: '2023-05-15T10:30:00Z' },
        { name: '16.20', full_size: 345828000, last_updated: '2023-06-01T11:00:00Z' },
        { name: '18', full_size: 356728000, last_updated: '2023-07-15T12:30:00Z' },
        { name: '18.17', full_size: 356828000, last_updated: '2023-08-01T14:00:00Z' },
        { name: '20', full_size: 367728000, last_updated: '2023-09-15T15:30:00Z' },
        { name: 'latest', full_size: 367828000, last_updated: '2024-04-15T23:00:00Z' }
      ]
    };

    const normalizedName = imageName.includes('/') ? imageName.split('/')[1] : imageName;
    return mockData[normalizedName] || [
      { name: '1.0', full_size: 50000000, last_updated: '2023-01-01T00:00:00Z' },
      { name: '1.1', full_size: 51000000, last_updated: '2023-06-01T00:00:00Z' },
      { name: '2.0', full_size: 52000000, last_updated: '2024-01-01T00:00:00Z' },
      { name: 'latest', full_size: 52000000, last_updated: '2024-04-15T23:00:00Z' }
    ];
  }

  // Get Docker Hub authentication token
  async getAuthToken(imageName) {
    const cacheKey = `auth_token_${imageName}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.token;
    }

    try {
      const response = await axios.get(this.authURL, {
        params: {
          service: 'registry.docker.io',
          scope: `repository:${imageName}:pull`
        },
        timeout: 10000
      });

      const token = response.data.access_token;
      
      // Cache the token
      this.cache.set(cacheKey, {
        token,
        timestamp: Date.now()
      });

      return token;

    } catch (error) {
      logger.warn('Failed to get Docker Hub auth token', {
        imageName,
        error: error.message
      });
      return null; // Some public repos don't need auth
    }
  }

  // Get available tags for an image
  async getAvailableTags(imageName) {
    // Mock mode for testing
    if (this.mockMode) {
      logger.info('Using mock Docker Hub API', { imageName });
      return this.getMockTags(imageName);
    }

    const cacheKey = `tags_${imageName}`;
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      logger.debug('Using cached tags', { imageName, tagCount: cached.data.length });
      return cached.data;
    }

    try {
      logger.info('Fetching available tags from Docker Hub', { imageName });

      // Normalize image name for API
      const normalizedName = this.normalizeImageName(imageName);
      
      // Skip authentication for public repositories (causes 401 errors)
      const headers = {};
      // Note: Public repositories don't need authentication
      // const token = await this.getAuthToken(normalizedName);
      // if (token) {
      //   headers['Authorization'] = `Bearer ${token}`;
      // }

      const allTags = [];
      let url = `${this.hubURL}/repositories/${normalizedName}/tags`;
      let hasNextPage = true;

      // Fetch all pages of tags
      while (hasNextPage && allTags.length < 1000) { // Limit to prevent excessive API calls
        const response = await axios.get(url, {
          headers,
          params: {
            page_size: 100
          },
          timeout: 15000
        });

        const data = response.data;
        
        if (data.results && Array.isArray(data.results)) {
          const tags = data.results.map(tag => ({
            name: tag.name,
            lastUpdated: tag.last_updated,
            fullSize: tag.full_size,
            architecture: tag.images?.[0]?.architecture,
            digest: tag.digest
          }));
          
          allTags.push(...tags);
        }

        // Check for next page
        hasNextPage = !!data.next;
        if (hasNextPage) {
          url = data.next;
        }

        // Rate limiting
        await this.delay(this.rateLimitDelay);
      }

      // Sort tags by semantic version where possible
      let sortedTags = this.sortTagsBySemver(allTags);
      
      // Apply Ubuntu-specific filtering for Ubuntu images
      if (normalizedName === 'library/ubuntu' || normalizedName === 'ubuntu') {
        const beforeCount = sortedTags.length;
        sortedTags = this.filterSupportedUbuntuVersions(sortedTags);
        logger.info('Applied Ubuntu version filtering to available tags', {
          imageName,
          beforeCount,
          afterCount: sortedTags.length,
          filtered: beforeCount - sortedTags.length
        });
      }

      // Cache the results
      this.cache.set(cacheKey, {
        data: sortedTags,
        timestamp: Date.now()
      });

      logger.info('Fetched tags from Docker Hub', {
        imageName,
        tagCount: sortedTags.length
      });

      return sortedTags;

    } catch (error) {
      logger.error('Failed to fetch tags from Docker Hub', {
        imageName,
        error: error.message,
        status: error.response?.status
      });
      
      if (error.response?.status === 404) {
        throw new Error(`Image '${imageName}' not found on Docker Hub`);
      } else if (error.response?.status === 429) {
        throw new Error('Docker Hub rate limit exceeded. Please try again later.');
      } else {
        throw new Error(`Failed to fetch tags: ${error.message}`);
      }
    }
  }

  // Get detailed information about a specific image version
  async getImageInfo(imageName, tag) {
    try {
      logger.debug('Fetching image info', { imageName, tag });

      const normalizedName = this.normalizeImageName(imageName);
      
      // Skip authentication for public repositories (causes 401 errors)
      const headers = {};
      // Note: Public repositories don't need authentication
      // const token = await this.getAuthToken(normalizedName);
      // if (token) {
      //   headers['Authorization'] = `Bearer ${token}`;
      // }

      const response = await axios.get(
        `${this.hubURL}/repositories/${normalizedName}/tags/${tag}`,
        {
          headers,
          timeout: 10000
        }
      );

      const tagData = response.data;
      
      return {
        name: tagData.name,
        lastUpdated: tagData.last_updated,
        fullSize: tagData.full_size,
        digest: tagData.digest,
        images: tagData.images || [],
        architecture: tagData.images?.[0]?.architecture || 'amd64'
      };

    } catch (error) {
      logger.error('Failed to fetch image info', {
        imageName,
        tag,
        error: error.message
      });
      
      if (error.response?.status === 404) {
        throw new Error(`Tag '${tag}' not found for image '${imageName}'`);
      } else {
        throw new Error(`Failed to fetch image info: ${error.message}`);
      }
    }
  }

  // Get the latest version of an image
  async getLatestVersion(imageName) {
    try {
      const tags = await this.getAvailableTags(imageName);
      
      if (tags.length === 0) {
        throw new Error(`No tags found for image '${imageName}'`);
      }

      // Filter out non-release tags
      let releaseTags = this.filterReleaseTags(tags);
      
      // Apply Ubuntu-specific filtering for Ubuntu images
      const normalizedName = this.normalizeImageName(imageName);
      if (normalizedName === 'library/ubuntu' || normalizedName === 'ubuntu') {
        releaseTags = this.filterSupportedUbuntuVersions(releaseTags);
        logger.info('Applied Ubuntu-specific version filtering', {
          imageName,
          originalCount: tags.length,
          filteredCount: releaseTags.length
        });
      }
      
      if (releaseTags.length === 0) {
        logger.warn('No release tags found, using all tags', { imageName });
        return tags[0]; // Return first tag if no semantic versions found
      }

      logger.debug('Found latest version', {
        imageName,
        latestTag: releaseTags[0].name
      });

      return releaseTags[0];

    } catch (error) {
      logger.error('Failed to get latest version', {
        imageName,
        error: error.message
      });
      throw error;
    }
  }

  // Normalize image name for Docker Hub API
  normalizeImageName(imageName) {
    // Remove registry prefix if it's docker.io
    if (imageName.startsWith('docker.io/')) {
      imageName = imageName.replace('docker.io/', '');
    }

    // Add library/ prefix for official images if not present
    if (!imageName.includes('/') && this.isOfficialImage(imageName)) {
      return `library/${imageName}`;
    }

    return imageName;
  }

  // Check if image is an official Docker image
  isOfficialImage(imageName) {
    const officialImages = [
      'ubuntu', 'debian', 'alpine', 'centos', 'fedora',
      'node', 'python', 'nginx', 'redis', 'postgres', 
      'mysql', 'httpd', 'tomcat', 'openjdk', 'golang'
    ];
    
    return officialImages.includes(imageName.toLowerCase());
  }

  // Filter out non-release tags (beta, rc, dev, etc.)
  filterReleaseTags(tags) {
    const skipPatterns = [
      /beta/i, /alpha/i, /rc/i, /dev/i, /test/i,
      /snapshot/i, /nightly/i, /edge/i, /experimental/i
    ];

    return tags.filter(tag => {
      const tagName = tag.name.toLowerCase();
      
      // Skip 'latest' tag for version sorting
      if (tagName === 'latest') {
        return false;
      }
      
      // Skip if matches any skip pattern
      for (const pattern of skipPatterns) {
        if (pattern.test(tagName)) {
          return false;
        }
      }
      
      return true;
    });
  }

  // Enhanced filtering for Ubuntu-specific versions
  filterSupportedUbuntuVersions(tags) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // JavaScript months are 0-based
    
    // Ubuntu LTS versions (Long Term Support - 5 years)
    const ltsVersions = [
      '24.04', '22.04', '20.04', '18.04', '16.04', '14.04'
    ];
    
    // End-of-life Ubuntu versions (approximate dates)
    const eolVersions = [
      '23.10', '23.04', '22.10', '21.10', '21.04', '20.10', 
      '19.10', '19.04', '18.10', '17.10', '17.04', '16.10',
      '12.04', '10.04', '8.04'
    ];

    return tags.filter(tag => {
      const tagName = tag.name;
      
      // Check if it's a Ubuntu version format (XX.XX or XX.XX.X)
      const ubuntuVersionMatch = tagName.match(/^(\d{2})\.(\d{2})(?:\.(\d+))?$/);
      if (!ubuntuVersionMatch) {
        return true; // Keep non-version tags
      }
      
      const [, year, month, patch] = ubuntuVersionMatch;
      const versionString = `${year}.${month}`;
      
      // Priority 1: Always include LTS versions (unless very old)
      if (ltsVersions.includes(versionString)) {
        const versionYear = parseInt(year, 10) + 2000;
        return versionYear >= 2016; // Keep LTS from 16.04 onwards
      }
      
      // Priority 2: Exclude known EOL versions
      if (eolVersions.includes(versionString)) {
        logger.debug('Filtering out EOL Ubuntu version', { version: tagName });
        return false;
      }
      
      // Priority 3: Filter interim releases (.10 versions) that are likely EOL
      if (month === '10') {
        const versionYear = parseInt(year, 10) + 2000;
        const releaseDate = new Date(versionYear, 9); // October = month 9
        const monthsSinceRelease = (now - releaseDate) / (1000 * 60 * 60 * 24 * 30);
        
        // Ubuntu interim releases have 9-month support
        if (monthsSinceRelease > 9) {
          logger.debug('Filtering out expired interim Ubuntu version', { 
            version: tagName, 
            monthsSinceRelease: Math.round(monthsSinceRelease) 
          });
          return false;
        }
      }
      
      return true;
    });
  }

  // Sort tags by semantic version with Ubuntu LTS prioritization
  sortTagsBySemver(tags) {
    const semverTags = [];
    const nonSemverTags = [];

    for (const tag of tags) {
      if (semver.valid(semver.coerce(tag.name))) {
        semverTags.push(tag);
      } else {
        nonSemverTags.push(tag);
      }
    }

    // Sort semantic version tags with Ubuntu LTS prioritization
    semverTags.sort((a, b) => {
      const versionA = semver.coerce(a.name);
      const versionB = semver.coerce(b.name);
      
      // Check if these are Ubuntu LTS versions
      const isLtsA = this.isUbuntuLTS(a.name);
      const isLtsB = this.isUbuntuLTS(b.name);
      
      // Prioritize LTS versions
      if (isLtsA && !isLtsB) return -1;
      if (!isLtsA && isLtsB) return 1;
      
      // Both LTS or both non-LTS, sort by version (newest first)
      return semver.rcompare(versionA, versionB);
    });

    // Sort non-semantic tags by last updated (newest first)
    nonSemverTags.sort((a, b) => {
      const dateA = new Date(a.lastUpdated || 0);
      const dateB = new Date(b.lastUpdated || 0);
      return dateB - dateA;
    });

    // Return semantic versions first, then others
    return [...semverTags, ...nonSemverTags];
  }

  // Check if a version is Ubuntu LTS
  isUbuntuLTS(version) {
    const ltsVersions = ['24.04', '22.04', '20.04', '18.04', '16.04', '14.04'];
    return ltsVersions.some(lts => version.startsWith(lts));
  }

  // Get versions newer than a specific version
  getVersionsNewerThan(tags, currentVersion) {
    const currentSemver = semver.coerce(currentVersion);
    
    if (!currentSemver) {
      logger.warn('Current version is not semantic, returning all tags', { currentVersion });
      return tags.map(tag => tag.name);
    }

    const newerTags = [];
    
    for (const tag of tags) {
      const tagSemver = semver.coerce(tag.name);
      
      if (tagSemver && semver.gt(tagSemver, currentSemver)) {
        newerTags.push(tag.name);
      }
    }

    logger.debug('Found newer versions', {
      currentVersion,
      newerVersions: newerTags.length
    });

    return newerTags;
  }

  // Delay function for rate limiting
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
    logger.debug('Docker Hub API cache cleared');
  }

  // Get cache statistics
  getCacheStats() {
    const entries = Array.from(this.cache.entries());
    const now = Date.now();
    const activeEntries = entries.filter(([key, value]) => 
      now - value.timestamp < this.cacheTimeout
    );

    return {
      totalEntries: this.cache.size,
      activeEntries: activeEntries.length,
      expiredEntries: this.cache.size - activeEntries.length
    };
  }
}

module.exports = DockerHubAPI; 