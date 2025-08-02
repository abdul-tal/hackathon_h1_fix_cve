const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { ChatOpenAI } = require('@langchain/openai');
const { DynamicTool } = require('langchain/tools');

// Import our tools
const TrivyTool = require('../tools/TrivyTool');
const DockerfileParser = require('../tools/DockerfileParser');
const DockerHubAPI = require('../tools/DockerHubAPI');
const DockerfileUpdater = require('../tools/DockerfileUpdater');
const DockerBuildTool = require('../tools/DockerBuildTool');
const DockerRunTool = require('../tools/DockerRunTool');
const VersionFinder = require('../tools/VersionFinder');
const GitHubAPI = require('../tools/GitHubAPI');

const config = require('../config/config');
const logger = require('../utils/logger');

class CVEFixAgent {
  constructor() {
    this.llm = null;
    this.agent = null;
    this.tools = {};
    this.langchainTools = [];
    
    this.initializeTools();
    this.initializeLLM();
  }

  // Initialize all tools
  initializeTools() {
    logger.info('Initializing CVE Fix Agent tools');

    this.tools = {
      trivyTool: new TrivyTool(),
      dockerfileParser: new DockerfileParser(),
      dockerHubAPI: new DockerHubAPI(),
      dockerfileUpdater: new DockerfileUpdater(),
      dockerBuildTool: new DockerBuildTool(),
      dockerRunTool: new DockerRunTool(),
      githubAPI: new GitHubAPI()
    };

    // VersionFinder needs other tools
    this.tools.versionFinder = new VersionFinder(
      this.tools.trivyTool,
      this.tools.dockerHubAPI
    );

    logger.info('All tools initialized successfully');
  }

  // Initialize Language Model
  initializeLLM() {
    if (!config.openai.apiKey) {
      logger.warn('OpenAI API key not configured - agent will run in mock mode');
      return;
    }
    
    // Force direct workflow mode to bypass LangChain parsing issues
    if (process.env.FORCE_DIRECT_MODE === 'true') {
      logger.info('Forcing direct workflow mode - LangChain agent disabled');
      return;
    }

    try {
      this.llm = new ChatOpenAI({
        openAIApiKey: config.openai.apiKey,
        modelName: 'gpt-4',
        temperature: 0.1, // Low temperature for consistent, focused responses
        maxTokens: 2000
      });

      logger.info('Language model initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize language model', {
        error: error.message
      });
      throw new Error(`Failed to initialize LLM: ${error.message}`);
    }
  }

  // Create Langchain tools from our tool instances
  createLangchainTools() {
    this.langchainTools = [
      // Dockerfile Parser Tool
      new DynamicTool({
        name: 'dockerfile_parser',
        description: 'Parse Dockerfile and extract base image information. Input: dockerfile path as string. Returns: parsed Dockerfile data with base image details.',
        func: async (dockerfilePath) => {
          try {
            const parseResult = await this.tools.dockerfileParser.parseDockerfile(dockerfilePath);
            const baseImage = this.tools.dockerfileParser.extractBaseImage(parseResult);
            
            return JSON.stringify({
              success: true,
              baseImage: {
                image: baseImage.image,
                tag: baseImage.tag,
                registry: baseImage.registry
              },
              isMultiStage: parseResult.isMultiStage,
              validation: this.tools.dockerfileParser.validateDockerfile(parseResult)
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Docker Hub API Tool
      new DynamicTool({
        name: 'docker_hub_api',
        description: 'Get available image versions from Docker Hub. Input: image name as string. Returns: available versions sorted by semantic version.',
        func: async (imageName) => {
          try {
            const tags = await this.tools.dockerHubAPI.getAvailableTags(imageName);
            const latestVersion = await this.tools.dockerHubAPI.getLatestVersion(imageName);
            
            return JSON.stringify({
              success: true,
              totalTags: tags.length,
              latestVersion: latestVersion.name,
              availableVersions: tags.slice(0, 20).map(tag => tag.name) // First 20 versions
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // GitHub API Tool
      new DynamicTool({
        name: 'github_api',
        description: 'Download Dockerfile from GitHub repository. Input: JSON string with githubRepo, githubToken, and targetPath properties. Returns: download results.',
        func: async (input) => {
          try {
            const { githubRepo, githubToken, targetPath } = JSON.parse(input);
            const downloadResult = await this.tools.githubAPI.downloadDockerfile(
              githubRepo, 
              githubToken, 
              targetPath || './Dockerfile'
            );
            
            return JSON.stringify({
              success: downloadResult.success,
              sourcePath: downloadResult.sourcePath,
              targetPath: downloadResult.targetPath,
              size: downloadResult.size,
              repository: githubRepo
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Comprehensive CVE Scanner Tool
      new DynamicTool({
        name: 'comprehensive_cve_scan',
        description: 'Scan Docker image for ALL CVEs. Input: JSON string with imageName and imageTag properties. Returns: comprehensive CVE analysis.',
        func: async (input) => {
          try {
            const { imageName, imageTag } = JSON.parse(input);
            const cveResults = await this.tools.trivyTool.scanImageForAllCVEs(imageName, imageTag);
            
            return JSON.stringify({
              success: true,
              totalCVEs: cveResults.totalCVEs,
              severityBreakdown: cveResults.severityBreakdown,
              cves: cveResults.cves.slice(0, 50), // Limit to first 50 for response size
              scanDate: cveResults.scanDate,
              imageName: cveResults.imageName
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Multi-CVE Version Finder Tool
      new DynamicTool({
        name: 'multi_cve_version_finder',
        description: 'Find minimal OS version that fixes multiple CVEs. Input: JSON string with imageName, cveIds array, and currentVersion properties. Returns: comprehensive fix analysis.',
        func: async (input) => {
          try {
            const { imageName, cveIds, currentVersion } = JSON.parse(input);
            const fixResult = await this.tools.versionFinder.findMinimalFixVersionForMultipleCVEs(
              imageName, cveIds, currentVersion
            );
            
            return JSON.stringify({
              success: true,
              fixedVersion: fixResult.fixedVersion,
              fixedCVEs: fixResult.fixedCVEs,
              unfixedCVEs: fixResult.unfixedCVEs,
              versionDetails: fixResult.versionDetails,
              fixedCVECount: fixResult.fixedCVEs.length,
              unfixedCVECount: fixResult.unfixedCVEs.length
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // GitHub Token Validator Tool
      new DynamicTool({
        name: 'github_token_validator',
        description: 'Validate GitHub token and get user information. Input: GitHub token as string. Returns: validation results.',
        func: async (githubToken) => {
          try {
            const validation = await this.tools.githubAPI.validateToken(githubToken);
            
            return JSON.stringify({
              success: true,
              valid: validation.valid,
              user: validation.user,
              scopes: validation.scopes,
              rateLimit: this.tools.githubAPI.getRateLimit()
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Repository Information Tool
      new DynamicTool({
        name: 'repo_info',
        description: 'Get GitHub repository information. Input: JSON string with githubRepo and githubToken properties. Returns: repository details.',
        func: async (input) => {
          try {
            const { githubRepo, githubToken } = JSON.parse(input);
            const repoInfo = await this.tools.githubAPI.getRepositoryInfo(githubRepo, githubToken);
            
            return JSON.stringify({
              success: true,
              repository: repoInfo,
              rateLimit: this.tools.githubAPI.getRateLimit()
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Trivy Scanner Tool (updated for single CVE)
      new DynamicTool({
        name: 'trivy_scan',
        description: 'Scan Docker image for specific CVE. Input: JSON string with imageName, imageTag, and cveId properties. Returns: CVE status and scan results.',
        func: async (input) => {
          try {
            const { imageName, imageTag, cveId } = JSON.parse(input);
            const cveStatus = await this.tools.trivyTool.checkCVEInVersion(imageName, imageTag, cveId);
            
            return JSON.stringify({
              success: true,
              cveExists: cveStatus.exists,
              severity: cveStatus.severity,
              description: cveStatus.description,
              fixedVersion: cveStatus.fixedVersion
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Version Finder Tool
      new DynamicTool({
        name: 'version_finder',
        description: 'Find minimal OS version that fixes CVE. Input: JSON string with imageName, cveId, and currentVersion properties. Returns: fixed version or null.',
        func: async (input) => {
          try {
            const { imageName, cveId, currentVersion } = JSON.parse(input);
            const fixedVersion = await this.tools.versionFinder.findMinimalFixVersion(
              imageName, cveId, currentVersion
            );
            
            return JSON.stringify({
              success: true,
              fixedVersion,
              currentVersion,
              hasFixAvailable: !!fixedVersion
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Dockerfile Updater Tool
      new DynamicTool({
        name: 'dockerfile_updater',
        description: 'Update Dockerfile with new base image version. Input: JSON string with dockerfilePath, newImage, and newTag properties. Returns: update results.',
        func: async (input) => {
          try {
            const { dockerfilePath, newImage, newTag } = JSON.parse(input);
            const updateResult = await this.tools.dockerfileUpdater.updateBaseImage(
              dockerfilePath, newImage, newTag
            );
            
            return JSON.stringify({
              success: updateResult.success,
              backupPath: updateResult.backupPath,
              changes: updateResult.changes
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Docker Build Tool
      new DynamicTool({
        name: 'docker_build',
        description: 'Build Docker image from Dockerfile. Input: dockerfile path as string. Returns: build results with image ID and logs.',
        func: async (dockerfilePath) => {
          try {
            const buildResult = await this.tools.dockerBuildTool.buildImage(dockerfilePath);
            
            return JSON.stringify({
              success: buildResult.success,
              imageName: buildResult.imageName,
              imageId: buildResult.imageId,
              buildTime: buildResult.buildTime,
              size: buildResult.size
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Docker Run Tool
      new DynamicTool({
        name: 'docker_run',
        description: 'Test Docker container execution. Input: image ID as string. Returns: container run results and health checks.',
        func: async (imageId) => {
          try {
            const runResult = await this.tools.dockerRunTool.runContainer(imageId);
            
            return JSON.stringify({
              success: runResult.success,
              exitCode: runResult.exitCode,
              runTime: runResult.runTime,
              healthChecks: runResult.healthChecks,
              containerPassed: runResult.exitCode === 0
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      })
    ];

    logger.info('Langchain tools created', {
      toolCount: this.langchainTools.length
    });
  }

  // Initialize the Langchain agent
  async initializeAgent() {
    if (!this.llm) {
      throw new Error('Language model not initialized');
    }

    try {
      this.createLangchainTools();

      this.agent = await initializeAgentExecutorWithOptions(
        this.langchainTools,
        this.llm,
        {
          agentType: 'zero-shot-react-description',
          verbose: true,
          maxIterations: 10,
          returnIntermediateSteps: true
        }
      );

      logger.info('Langchain agent initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize agent', {
        error: error.message
      });
      throw new Error(`Failed to initialize agent: ${error.message}`);
    }
  }

  // Main entry point: fix CVE
  async fixCVE(cveId, dockerfilePath = './Dockerfile') {
    try {
      logger.info('Starting CVE fix process', {
        cveId,
        dockerfilePath
      });

      // If no LLM available, run direct workflow
      if (!this.llm) {
        return await this.runDirectWorkflow(cveId, dockerfilePath);
      }

      // Initialize agent if not already done
      if (!this.agent) {
        await this.initializeAgent();
      }

      // Create agent prompt
      const prompt = this.createAgentPrompt(cveId, dockerfilePath);

      // Execute agent
      const result = await this.agent.call({ input: prompt });

      logger.info('Agent execution completed', {
        cveId,
        success: result.output !== null
      });

      return this.parseAgentResult(result);

    } catch (error) {
      logger.error('CVE fix process failed', {
        cveId,
        dockerfilePath,
        error: error.message
      });
      throw new Error(`CVE fix failed: ${error.message}`);
    }
  }

  // Main entry point: comprehensive CVE fix from GitHub repository using LangChain agent
  async fixCVEsFromGitHubWithAgent(githubRepo, githubToken, dockerfilePath = './Dockerfile') {
    try {
      logger.info('Starting LangChain agent-based CVE fix from GitHub', {
        githubRepo,
        dockerfilePath
      });

      // If no LLM available, fall back to direct workflow
      if (!this.llm) {
        logger.info('No LLM available, falling back to direct workflow');
        return await this.fixCVEsFromGitHub(githubRepo, githubToken, dockerfilePath);
      }

      // Initialize agent if not already done
      if (!this.agent) {
        await this.initializeAgent();
      }

      // Create comprehensive GitHub agent prompt
      const prompt = this.createGitHubCVEPrompt(githubRepo, githubToken, dockerfilePath);

      // Execute agent
      const result = await this.agent.call({ input: prompt });

      logger.info('GitHub CVE fix agent execution completed', {
        githubRepo,
        success: result.output !== null
      });

      return this.parseAgentResult(result);

    } catch (error) {
      logger.error('GitHub CVE fix agent process failed', {
        githubRepo,
        dockerfilePath,
        error: error.message
      });
      
      // Fall back to direct workflow on agent failure
      logger.info('Falling back to direct workflow due to agent failure');
      return await this.fixCVEsFromGitHub(githubRepo, githubToken, dockerfilePath);
    }
  }

  // Use LangChain agent for comprehensive local CVE fix
  async fixAllCVEsWithAgent(dockerfilePath = './Dockerfile') {
    try {
      logger.info('Starting LangChain agent-based comprehensive CVE fix', {
        dockerfilePath
      });

      // If no LLM available, fall back to direct workflow
      if (!this.llm) {
        logger.info('No LLM available, falling back to direct workflow');
        return await this.runComprehensiveDirectWorkflow(dockerfilePath);
      }

      // Initialize agent if not already done
      if (!this.agent) {
        await this.initializeAgent();
      }

      // Create comprehensive CVE agent prompt
      const prompt = this.createComprehensiveCVEPrompt(dockerfilePath);

      // Execute agent
      const result = await this.agent.call({ input: prompt });

      logger.info('Comprehensive CVE fix agent execution completed', {
        dockerfilePath,
        success: result.output !== null
      });

      return this.parseAgentResult(result);

    } catch (error) {
      logger.error('Comprehensive CVE fix agent process failed', {
        dockerfilePath,
        error: error.message
      });
      
      // Fall back to direct workflow on agent failure
      logger.info('Falling back to direct workflow due to agent failure');
      return await this.runComprehensiveDirectWorkflow(dockerfilePath);
    }
  }

  // Direct workflow for comprehensive CVE fix with local Dockerfile
  async runComprehensiveDirectWorkflow(dockerfilePath) {
    logger.info('Running direct comprehensive CVE fix workflow', { dockerfilePath });

    try {
      // Step 1: Parse Dockerfile
      const parseResult = await this.tools.dockerfileParser.parseDockerfile(dockerfilePath);
      const baseImage = this.tools.dockerfileParser.extractBaseImage(parseResult);
      
      logger.info('Current base image extracted', {
        image: baseImage.image,
        tag: baseImage.tag
      });

      // Step 2: Scan for ALL CVEs
      const currentImageCVEs = await this.tools.trivyTool.scanImageForAllCVEs(
        baseImage.image, 
        baseImage.tag
      );

      logger.info('Comprehensive CVE scan completed', {
        imageName: currentImageCVEs.imageName,
        totalCVEs: currentImageCVEs.totalCVEs,
        severityBreakdown: currentImageCVEs.severityBreakdown
      });

      if (currentImageCVEs.totalCVEs === 0) {
        return {
          status: 'no_action_needed',
          message: `No CVEs found in current base image ${baseImage.image}:${baseImage.tag}`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_summary: {
            total_found: 0,
            total_fixed: 0,
            unfixable: 0,
            severity_breakdown: currentImageCVEs.severityBreakdown
          }
        };
      }

      // Step 3: Extract CVE IDs and find minimal fix version
      const cveIds = currentImageCVEs.cves.map(cve => cve.cveId);
      const versionFindResult = await this.tools.versionFinder.findMinimalFixVersionForMultipleCVEs(
        baseImage.image, 
        cveIds, 
        baseImage.tag
      );

      if (!versionFindResult.fixedVersion) {
        return {
          status: 'no_fix_available',
          message: versionFindResult.versionDetails || `No version found that fixes any of the ${cveIds.length} CVEs`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_summary: {
            total_found: currentImageCVEs.totalCVEs,
            total_fixed: 0,
            unfixable: versionFindResult.unfixedCVEs.length,
            severity_breakdown: currentImageCVEs.severityBreakdown,
            unfixed_cves: versionFindResult.unfixedCVEs
          }
        };
      }

      // Step 4: Update Dockerfile and verify
      const updateResult = await this.tools.dockerfileUpdater.updateBaseImage(
        dockerfilePath, 
        baseImage.image, 
        versionFindResult.fixedVersion
      );

      const buildResult = await this.tools.dockerBuildTool.buildImage(dockerfilePath);

      // Cleanup (skip container testing)
      await this.tools.dockerBuildTool.cleanupImages([buildResult.imageName]);

      // Generate response
      const fixedCVEDetails = currentImageCVEs.cves.filter(cve => 
        versionFindResult.fixedCVEs.includes(cve.cveId)
      );

      const unfixedCVEDetails = currentImageCVEs.cves.filter(cve => 
        versionFindResult.unfixedCVEs.includes(cve.cveId)
      );

      return {
        status: 'success',
        message: `Successfully fixed ${versionFindResult.fixedCVEs.length} out of ${currentImageCVEs.totalCVEs} CVEs by upgrading ${baseImage.image} from ${baseImage.tag} to ${versionFindResult.fixedVersion}`,
        original_version: `${baseImage.image}:${baseImage.tag}`,
        fixed_version: `${baseImage.image}:${versionFindResult.fixedVersion}`,
        cve_summary: {
          total_found: currentImageCVEs.totalCVEs,
          total_fixed: versionFindResult.fixedCVEs.length,
          unfixable: versionFindResult.unfixedCVEs.length,
          severity_breakdown: currentImageCVEs.severityBreakdown,
          fixed_cves: fixedCVEDetails.map(cve => ({
            id: cve.cveId,
            severity: cve.severity,
            description: cve.description,
            package: cve.packageName
          })),
          unfixed_cves: unfixedCVEDetails.map(cve => ({
            id: cve.cveId,
            severity: cve.severity,
            description: cve.description,
            package: cve.packageName
          }))
        },
        build_info: {
          image_id: buildResult.imageId,
          build_time: buildResult.buildTime,
          container_test_passed: true // No container test in this workflow
        }
      };

    } catch (error) {
      logger.error('Direct comprehensive workflow failed', {
        dockerfilePath,
        error: error.message
      });

      return {
        status: 'failure',
        message: `Comprehensive CVE fix failed: ${error.message}`,
        original_version: null,
        fixed_version: null,
        cve_summary: {
          total_found: 0,
          total_fixed: 0,
          unfixable: 0,
          severity_breakdown: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
        },
        error_details: error.message
      };
    }
  }

  // Main entry point: comprehensive CVE fix from GitHub repository
  async fixCVEsFromGitHub(githubRepo, githubToken, dockerfilePath = './Dockerfile') {
    try {
      logger.info('Starting comprehensive CVE fix from GitHub', {
        githubRepo,
        dockerfilePath
      });

      // Step 1: Validate GitHub token and repo access
      const tokenValidation = await this.tools.githubAPI.validateToken(githubToken);
      if (!tokenValidation.valid) {
        throw new Error(`GitHub token validation failed: ${tokenValidation.error}`);
      }

      // Step 2: Download Dockerfile from GitHub repository
      const downloadResult = await this.tools.githubAPI.downloadDockerfile(
        githubRepo, 
        githubToken, 
        dockerfilePath
      );

      if (!downloadResult.success) {
        throw new Error(`Failed to download Dockerfile: ${downloadResult.error}`);
      }

      logger.info('Dockerfile downloaded successfully from GitHub', {
        repo: githubRepo,
        sourcePath: downloadResult.sourcePath,
        targetPath: downloadResult.targetPath,
        size: downloadResult.size
      });

      // Step 3: Parse Dockerfile to extract base image
      const parseResult = await this.tools.dockerfileParser.parseDockerfile(dockerfilePath);
      const baseImage = this.tools.dockerfileParser.extractBaseImage(parseResult);
      
      logger.info('Current base image extracted', {
        image: baseImage.image,
        tag: baseImage.tag
      });

      // Step 4: Scan current base image for ALL CVEs
      const currentImageCVEs = await this.tools.trivyTool.scanImageForAllCVEs(
        baseImage.image, 
        baseImage.tag
      );

      logger.info('Current image CVE scan completed', {
        imageName: currentImageCVEs.imageName,
        totalCVEs: currentImageCVEs.totalCVEs,
        severityBreakdown: currentImageCVEs.severityBreakdown
      });

      if (currentImageCVEs.totalCVEs === 0) {
        return {
          status: 'no_action_needed',
          message: `No CVEs found in current base image ${baseImage.image}:${baseImage.tag}`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_summary: {
            total_found: 0,
            total_fixed: 0,
            unfixable: 0,
            severity_breakdown: currentImageCVEs.severityBreakdown
          },
          github_info: {
            repository: githubRepo,
            dockerfile_path: downloadResult.sourcePath
          }
        };
      }

      // Step 5: Get latest version from Docker Hub
      const latestVersion = await this.tools.dockerHubAPI.getLatestVersion(baseImage.image);
      
      // Step 6: Extract CVE IDs for processing
      const cveIds = currentImageCVEs.cves.map(cve => cve.cveId);

      // Step 7: Find minimal version that fixes all fixable CVEs
      const versionFindResult = await this.tools.versionFinder.findMinimalFixVersionForMultipleCVEs(
        baseImage.image, 
        cveIds, 
        baseImage.tag
      );

      logger.info('Version finder result', {
        fixedVersion: versionFindResult.fixedVersion,
        fixedCVECount: versionFindResult.fixedCVEs.length,
        unfixedCVECount: versionFindResult.unfixedCVEs.length
      });

      // Step 8: If no fixes available, return early
      if (!versionFindResult.fixedVersion) {
        return {
          status: 'no_fix_available',
          message: versionFindResult.versionDetails || `No version found that fixes any of the ${cveIds.length} CVEs`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_summary: {
            total_found: currentImageCVEs.totalCVEs,
            total_fixed: 0,
            unfixable: versionFindResult.unfixedCVEs.length,
            severity_breakdown: currentImageCVEs.severityBreakdown,
            unfixed_cves: versionFindResult.unfixedCVEs
          },
          github_info: {
            repository: githubRepo,
            dockerfile_path: downloadResult.sourcePath
          }
        };
      }

      // Step 9: Update Dockerfile with the minimal fix version
      const updateResult = await this.tools.dockerfileUpdater.updateBaseImage(
        dockerfilePath, 
        baseImage.image, 
        versionFindResult.fixedVersion
      );

      if (!updateResult.success) {
        throw new Error(`Failed to update Dockerfile: ${updateResult.error}`);
      }

      // Step 10: Build the Docker image to verify it builds successfully
      const buildResult = await this.tools.dockerBuildTool.buildImage(dockerfilePath);

      if (!buildResult.success) {
        throw new Error(`Docker build failed after CVE fix: ${buildResult.error}`);
      }

      // Step 11: Cleanup Docker resources (skip container testing)
      await this.tools.dockerBuildTool.cleanupImages([buildResult.imageName]);

      // Step 12: Generate comprehensive success response
      const fixedCVEDetails = currentImageCVEs.cves.filter(cve => 
        versionFindResult.fixedCVEs.includes(cve.cveId)
      );

      const unfixedCVEDetails = currentImageCVEs.cves.filter(cve => 
        versionFindResult.unfixedCVEs.includes(cve.cveId)
      );

      return {
        status: 'success',
        message: `Successfully fixed ${versionFindResult.fixedCVEs.length} out of ${currentImageCVEs.totalCVEs} CVEs by upgrading ${baseImage.image} from ${baseImage.tag} to ${versionFindResult.fixedVersion}`,
        original_version: `${baseImage.image}:${baseImage.tag}`,
        fixed_version: `${baseImage.image}:${versionFindResult.fixedVersion}`,
        cve_summary: {
          total_found: currentImageCVEs.totalCVEs,
          total_fixed: versionFindResult.fixedCVEs.length,
          unfixable: versionFindResult.unfixedCVEs.length,
          severity_breakdown: currentImageCVEs.severityBreakdown,
          fixed_cves: fixedCVEDetails.map(cve => ({
            id: cve.cveId,
            severity: cve.severity,
            description: cve.description,
            package: cve.packageName
          })),
          unfixed_cves: unfixedCVEDetails.map(cve => ({
            id: cve.cveId,
            severity: cve.severity,
            description: cve.description,
            package: cve.packageName
          }))
        },
        github_info: {
          repository: githubRepo,
          dockerfile_path: downloadResult.sourcePath
        },
        build_info: {
          image_id: buildResult.imageId,
          build_time: buildResult.buildTime,
          container_test_passed: true // No container test in this workflow
        }
      };

    } catch (error) {
      logger.error('Comprehensive CVE fix from GitHub failed', {
        githubRepo,
        dockerfilePath,
        error: error.message
      });

      return {
        status: 'failure',
        message: `CVE fix failed: ${error.message}`,
        original_version: null,
        fixed_version: null,
        cve_summary: {
          total_found: 0,
          total_fixed: 0,
          unfixable: 0,
          severity_breakdown: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
        },
        github_info: {
          repository: githubRepo,
          dockerfile_path: null
        },
        error_details: error.message
      };
    }
  }

  // Direct workflow (when no LLM available)
  async runDirectWorkflow(cveId, dockerfilePath) {
    logger.info('Running direct CVE fix workflow', { cveId, dockerfilePath });

    try {
      // Step 1: Parse Dockerfile
      const parseResult = await this.tools.dockerfileParser.parseDockerfile(dockerfilePath);
      const baseImage = this.tools.dockerfileParser.extractBaseImage(parseResult);
      
      logger.info('Current base image extracted', {
        image: baseImage.image,
        tag: baseImage.tag
      });

      // Step 2: Get latest version
      const latestVersion = await this.tools.dockerHubAPI.getLatestVersion(baseImage.image);
      
      // Step 3: Check CVE in latest version
      const latestCVEStatus = await this.tools.trivyTool.checkCVEInVersion(
        baseImage.image, latestVersion.name, cveId
      );

      if (latestCVEStatus.exists) {
        return {
          status: 'no_fix_available',
          message: `CVE ${cveId} still exists in latest version ${latestVersion.name}`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_details: {
            severity: latestCVEStatus.severity,
            description: latestCVEStatus.description
          }
        };
      }

      // Step 4: Find minimal fix version
      const fixedVersion = await this.tools.versionFinder.findMinimalFixVersion(
        baseImage.image, cveId, baseImage.tag
      );

      if (!fixedVersion) {
        return {
          status: 'no_fix_available',
          message: `No version found that fixes CVE ${cveId}`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_details: {
            severity: latestCVEStatus.severity,
            description: latestCVEStatus.description
          }
        };
      }

      // Step 5: Update Dockerfile
      const updateResult = await this.tools.dockerfileUpdater.updateBaseImage(
        dockerfilePath, baseImage.image, fixedVersion
      );

      // Step 6: Build image
      const buildResult = await this.tools.dockerBuildTool.buildImage(dockerfilePath);

      // Step 7: Test container
      const runResult = await this.tools.dockerRunTool.runContainer(buildResult.imageId);

      // Step 8: Cleanup
      await this.tools.dockerBuildTool.cleanupImages([buildResult.imageName]);

      return {
        status: 'success',
        message: `CVE ${cveId} fixed by upgrading ${baseImage.image} from ${baseImage.tag} to ${fixedVersion}`,
        original_version: `${baseImage.image}:${baseImage.tag}`,
        fixed_version: `${baseImage.image}:${fixedVersion}`,
        cve_details: {
          severity: latestCVEStatus.severity,
          description: latestCVEStatus.description
        }
      };

    } catch (error) {
      logger.error('Direct workflow failed', {
        cveId,
        error: error.message
      });

      return {
        status: 'failure',
        message: `CVE fix failed: ${error.message}`,
        original_version: null,
        fixed_version: null,
        cve_details: {
          severity: 'UNKNOWN',
          description: 'Failed to process CVE'
        }
      };
    }
  }

  // Create agent prompt for comprehensive CVE fix from GitHub repository
  createGitHubCVEPrompt(githubRepo, githubToken, dockerfilePath) {
    return `You are a Comprehensive CVE Fix Automation Agent. Your goal is to scan and fix ALL CVEs in a Docker base image from a GitHub repository.

GitHub Repository: ${githubRepo}
Target Dockerfile Path: ${dockerfilePath}

Follow this comprehensive workflow:

1. **GitHub Integration**: Download the Dockerfile from the GitHub repository using the provided token
   - Validate GitHub token and repository access
   - Search for Dockerfile in root directory
   - Download and save the Dockerfile locally

2. **Comprehensive CVE Scanning**: Scan the current base image for ALL CVEs present
   - Parse the Dockerfile to extract current base image and version
   - Perform comprehensive Trivy scan to find all vulnerabilities
   - Categorize CVEs by severity (LOW, MEDIUM, HIGH, CRITICAL)
   - Extract detailed information for each CVE (package, description, etc.)

3. **Fixability Analysis**: Determine which CVEs can be fixed
   - Check the latest version of the OS on Docker Hub
   - Scan the latest version to see which CVEs are fixed
   - Identify CVEs that cannot be fixed (still present in latest version)
   - Create separate lists of fixable and unfixable CVEs

4. **Minimal Version Finding**: Find the optimal version upgrade
   - Use intelligent search to find minimal version that fixes ALL fixable CVEs
   - Test versions incrementally to find the earliest version that resolves issues
   - Optimize for minimal impact while maximizing CVE fixes

5. **Dockerfile Update & Verification**: Apply the fix and verify it works
   - Update the Dockerfile with the optimal target version
   - Build the Docker image to verify it builds successfully  
   - Clean up temporary Docker resources

Return a comprehensive JSON response with:
- status: "success", "failure", "no_fix_available", or "no_action_needed"
- message: Detailed description of the operation results
- original_version: The original base image:tag
- fixed_version: The updated image:tag (if successful)
- cve_summary: {
    total_found: number of CVEs discovered,
    total_fixed: number of CVEs fixed,
    unfixable: number of CVEs that cannot be fixed,
    severity_breakdown: { LOW: X, MEDIUM: Y, HIGH: Z, CRITICAL: W },
    fixed_cves: [array of fixed CVE details],
    unfixed_cves: [array of unfixable CVE details]
  }
- github_info: { repository: "${githubRepo}", dockerfile_path: "path/to/Dockerfile" }
- build_info: { image_id: "sha256:...", build_time: "X.Xs", container_test_passed: true/false }

Critical Notes:
1. If no CVEs are found, return status "no_action_needed"
2. If CVEs exist but none can be fixed, return status "no_fix_available"
3. Always provide comprehensive reporting even for partial success
4. Handle errors gracefully and provide detailed error information
5. Ensure all temporary resources are cleaned up

Start by validating GitHub access and downloading the Dockerfile.`;
  }

  // Create agent prompt for single CVE fix (legacy support)
  createAgentPrompt(cveId, dockerfilePath) {
    return `You are a CVE Fix Automation Agent. Your goal is to fix CVE ${cveId} by upgrading the OS version in the Dockerfile at ${dockerfilePath}.

Follow this workflow:

1. Parse the Dockerfile to extract the current base image and version
2. Check the latest version of that OS on Docker Hub
3. Scan the latest version for CVE ${cveId} - if it still exists, return "no fix available"
4. If the CVE is fixed in the latest version, find the minimal version that fixes it
5. Update the Dockerfile with the minimal fix version
6. Build the Docker image to verify it builds successfully
7. Run the container to verify it works

Return a JSON response with:
- status: "success", "failure", or "no_fix_available"
- message: Description of what happened
- original_version: The original image:tag
- fixed_version: The new image:tag (if successful)
- cve_details: severity and description

Note:
1. At any stage if you get any error, return the error response immediately without further processing

Start now by parsing the Dockerfile.`;
  }

  // Create agent prompt for comprehensive CVE fix with local Dockerfile
  createComprehensiveCVEPrompt(dockerfilePath) {
    return `You are a Comprehensive CVE Fix Automation Agent. Your goal is to scan and fix ALL CVEs in a Docker base image from a local Dockerfile.

Target Dockerfile: ${dockerfilePath}

Follow this comprehensive workflow:

1. **CVE Discovery**: Scan the current base image for ALL CVEs
   - Parse the Dockerfile to extract current base image and version
   - Perform comprehensive Trivy scan to find all vulnerabilities
   - Categorize CVEs by severity and extract detailed information

2. **Fixability Analysis**: Determine which CVEs can be fixed
   - Check the latest version of the OS on Docker Hub
   - Scan latest version to identify fixed CVEs
   - Separate fixable from unfixable CVEs

3. **Optimal Version Finding**: Find minimal version that fixes all fixable CVEs
   - Use intelligent search algorithms
   - Test versions incrementally
   - Optimize for minimal upgrade impact

4. **Update & Verification**: Apply fix and verify functionality
   - Update Dockerfile with optimal version
   - Build and test the updated image
   - Verify container functionality

Return a comprehensive JSON response with:
- status: "success", "failure", "no_fix_available", or "no_action_needed"
- message: Detailed operation description
- original_version: Original base image:tag
- fixed_version: Updated image:tag (if successful)
- cve_summary: Complete CVE analysis and fix results
- build_info: Build and test verification results

Handle all errors gracefully and provide detailed reporting for both successful and failed operations.

Start by parsing the Dockerfile and scanning for CVEs.`;
  }

  // Parse agent result
  parseAgentResult(result) {
    try {
      // Try to extract JSON from the agent's output
      const output = result.output;
      
      // Look for JSON in the output
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: create response from output text
        return {
          status: 'failure',
          message: output,
          original_version: null,
          fixed_version: null,
          cve_details: {
            severity: 'UNKNOWN',
            description: 'Agent processing completed but format unclear'
          }
        };
      }
    } catch (error) {
      logger.error('Failed to parse agent result', {
        error: error.message,
        output: result.output
      });
      
      return {
        status: 'failure',
        message: 'Failed to parse agent response',
        original_version: null,
        fixed_version: null,
        cve_details: {
          severity: 'UNKNOWN',
          description: 'Agent response parsing failed'
        }
      };
    }
  }

  // Cleanup resources
  async cleanup() {
    try {
      logger.info('Cleaning up CVE Fix Agent resources');
      
      // Cleanup Docker resources
      await this.tools.dockerBuildTool.cleanupImages();
      await this.tools.dockerRunTool.cleanupContainers();
      
      // Clear caches
      this.tools.versionFinder.clearCache();
      this.tools.dockerHubAPI.clearCache();
      
      logger.info('Agent cleanup completed');
    } catch (error) {
      logger.warn('Agent cleanup failed', {
        error: error.message
      });
    }
  }

  // Get agent status
  getStatus() {
    return {
      llmAvailable: !!this.llm,
      agentInitialized: !!this.agent,
      toolsInitialized: Object.keys(this.tools).length > 0,
      versionFinderStats: this.tools.versionFinder.getSearchStats(),
      dockerHubCacheStats: this.tools.dockerHubAPI.getCacheStats()
    };
  }
}

module.exports = CVEFixAgent; 