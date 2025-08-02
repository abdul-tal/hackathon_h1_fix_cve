#!/usr/bin/env node

/**
 * CVE Fix Automation Tool - Setup Validation Script
 * 
 * This script checks if all required environment variables and dependencies
 * are properly configured before running the application.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔍 CVE Fix Automation Tool - Setup Validation\n');

const checks = [];
let hasErrors = false;

// Helper functions
function checkPassed(name, message) {
  checks.push({ name, status: '✅', message });
  console.log(`✅ ${name}: ${message}`);
}

function checkWarning(name, message) {
  checks.push({ name, status: '⚠️', message });
  console.log(`⚠️  ${name}: ${message}`);
}

function checkFailed(name, message) {
  checks.push({ name, status: '❌', message });
  console.log(`❌ ${name}: ${message}`);
  hasErrors = true;
}

// 1. Check Node.js version
try {
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  
  if (majorVersion >= 18) {
    checkPassed('Node.js Version', `${nodeVersion} (✓ >= 18.0.0)`);
  } else {
    checkFailed('Node.js Version', `${nodeVersion} (requires >= 18.0.0)`);
  }
} catch (error) {
  checkFailed('Node.js Version', 'Unable to determine version');
}

// 2. Check .env file
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  checkPassed('.env File', 'Found');
  
  // Load .env file
  require('dotenv').config();
} else {
  checkWarning('.env File', 'Not found - using defaults (see docs/SETUP.md)');
}

// 3. Check required directories
const requiredDirs = ['logs', 'trivy-cache'];
requiredDirs.forEach(dir => {
  const dirPath = path.join(process.cwd(), dir);
  if (fs.existsSync(dirPath)) {
    checkPassed(`Directory ${dir}`, 'Exists');
  } else {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      checkPassed(`Directory ${dir}`, 'Created');
    } catch (error) {
      checkFailed(`Directory ${dir}`, `Failed to create: ${error.message}`);
    }
  }
});

// 4. Check Dockerfile
const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
if (fs.existsSync(dockerfilePath)) {
  checkPassed('Dockerfile', 'Found at project root');
} else {
  checkFailed('Dockerfile', 'Not found at project root');
}

// 5. Check Docker daemon
try {
  execSync('docker ps', { stdio: 'pipe' });
  checkPassed('Docker Daemon', 'Accessible');
} catch (error) {
  checkFailed('Docker Daemon', 'Not accessible - is Docker running?');
}

// 6. Check Trivy installation
try {
  const trivyVersion = execSync('trivy --version', { encoding: 'utf8' });
  checkPassed('Trivy CLI', `Installed: ${trivyVersion.trim()}`);
} catch (error) {
  checkFailed('Trivy CLI', 'Not found - install with: brew install trivy');
}

// 7. Check environment variables
const envVars = [
  {
    name: 'OPENAI_API_KEY',
    required: false,
    description: 'Enables LLM agent mode'
  },
  {
    name: 'DOCKER_HOST',
    required: false,
    description: 'Docker daemon connection',
    default: 'unix:///var/run/docker.sock'
  },
  {
    name: 'DOCKER_HUB_USERNAME',
    required: false,
    description: 'Higher Docker Hub rate limits'
  },
  {
    name: 'DOCKER_HUB_PASSWORD',
    required: false,
    description: 'Docker Hub authentication'
  },
  {
    name: 'GITHUB_TOKEN',
    required: false,
    description: 'Future PR creation feature'
  }
];

console.log('\n📋 Environment Variables:');
envVars.forEach(({ name, required, description, default: defaultValue }) => {
  const value = process.env[name];
  
  if (value) {
    const maskedValue = name.includes('KEY') || name.includes('PASSWORD') || name.includes('TOKEN') 
      ? '***' + value.slice(-4) 
      : value;
    checkPassed(`ENV ${name}`, `Set: ${maskedValue}`);
  } else if (required) {
    checkFailed(`ENV ${name}`, `Required but not set - ${description}`);
  } else {
    const msg = defaultValue 
      ? `Optional - using default: ${defaultValue}` 
      : `Optional - ${description}`;
    checkWarning(`ENV ${name}`, msg);
  }
});

// 8. Check package dependencies
console.log('\n📦 Checking dependencies...');
try {
  const packagePath = path.join(process.cwd(), 'package.json');
  const nodeModulesPath = path.join(process.cwd(), 'node_modules');
  
  if (fs.existsSync(nodeModulesPath)) {
    checkPassed('Dependencies', 'node_modules found');
  } else {
    checkWarning('Dependencies', 'Run: npm install');
  }
} catch (error) {
  checkWarning('Dependencies', 'Unable to check');
}

// Summary
console.log('\n📊 Setup Summary:');
console.log('─'.repeat(50));

const passed = checks.filter(c => c.status === '✅').length;
const warnings = checks.filter(c => c.status === '⚠️').length;
const failed = checks.filter(c => c.status === '❌').length;

console.log(`✅ Passed: ${passed}`);
console.log(`⚠️  Warnings: ${warnings}`);
console.log(`❌ Failed: ${failed}`);

if (hasErrors) {
  console.log('\n❌ Setup has errors. Please fix the issues above.');
  console.log('📖 See docs/SETUP.md for detailed instructions.');
  process.exit(1);
} else if (warnings > 0) {
  console.log('\n⚠️  Setup has warnings but should work with limited functionality.');
  console.log('📖 See docs/SETUP.md to enable all features.');
} else {
  console.log('\n🎉 Setup looks good! All checks passed.');
}

console.log('\n🚀 Start the application with: npm start');
console.log('🔧 Test the setup with: curl http://localhost:3000/api/health');

process.exit(hasErrors ? 1 : 0); 