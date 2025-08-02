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
      
      // Get auth token
      const token = await this.getAuthToken(normalizedName);
      
      const headers = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const allTags = [];
      let url = `${this.baseURL}/repositories/${normalizedName}/tags`;
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
      const sortedTags = this.sortTagsBySemver(allTags);

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
      const token = await this.getAuthToken(normalizedName);
      
      const headers = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await axios.get(
        `${this.baseURL}/repositories/${normalizedName}/tags/${tag}`,
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
      const releaseTags = this.filterReleaseTags(tags);
      
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

  // Sort tags by semantic version
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

    // Sort semantic version tags in descending order (newest first)
    semverTags.sort((a, b) => {
      const versionA = semver.coerce(a.name);
      const versionB = semver.coerce(b.name);
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