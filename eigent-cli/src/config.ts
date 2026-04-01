import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── Paths ───

const EIGENT_HOME = path.join(os.homedir(), '.eigent');
const KEYS_DIR = path.join(EIGENT_HOME, 'keys');
const SESSION_FILE = path.join(EIGENT_HOME, 'session.json');

const PROJECT_EIGENT_DIR = '.eigent';
const PROJECT_CONFIG_FILE = path.join(PROJECT_EIGENT_DIR, 'config.json');
const TOKENS_DIR = path.join(PROJECT_EIGENT_DIR, 'tokens');

const DEFAULT_REGISTRY_URL = 'http://localhost:3456';

// ─── Types ───

interface ProjectConfig {
  registryUrl: string;
  initialized: boolean;
  createdAt: string;
}

interface Session {
  email: string;
  sub: string;
  iss: string;
  token: string;
  authenticatedAt: string;
  verified?: boolean;
  providerType?: string;
}

// ─── Helpers ───

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Global Config (~/.eigent/) ───

export function ensureEigentHome(): void {
  ensureDir(EIGENT_HOME);
  ensureDir(KEYS_DIR);
}

export function getKeysDir(): string {
  return KEYS_DIR;
}

export function getEigentHome(): string {
  return EIGENT_HOME;
}

// ─── Session Management ───

export function saveSession(session: Session): void {
  ensureEigentHome();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

export function loadSession(): Session | null {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }
  const data = fs.readFileSync(SESSION_FILE, 'utf-8');
  return JSON.parse(data) as Session;
}

export function requireSession(): Session {
  const session = loadSession();
  if (!session) {
    throw new Error(
      'Not logged in. Run `eigent login` first.'
    );
  }
  return session;
}

export function clearSession(): void {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
  }
}

// ─── Project Config (.eigent/) ───

export function getProjectDir(): string {
  return path.resolve(PROJECT_EIGENT_DIR);
}

export function getTokensDir(): string {
  return path.resolve(TOKENS_DIR);
}

export function initProjectConfig(registryUrl: string): ProjectConfig {
  ensureDir(PROJECT_EIGENT_DIR);
  ensureDir(TOKENS_DIR);

  const config: ProjectConfig = {
    registryUrl,
    initialized: true,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    PROJECT_CONFIG_FILE,
    JSON.stringify(config, null, 2)
  );

  return config;
}

export function loadProjectConfig(): ProjectConfig | null {
  if (!fs.existsSync(PROJECT_CONFIG_FILE)) {
    return null;
  }
  const data = fs.readFileSync(PROJECT_CONFIG_FILE, 'utf-8');
  return JSON.parse(data) as ProjectConfig;
}

export function requireProjectConfig(): ProjectConfig {
  const config = loadProjectConfig();
  if (!config) {
    throw new Error(
      'Eigent not initialized in this project. Run `eigent init` first.'
    );
  }
  return config;
}

export function getRegistryUrl(): string {
  const config = loadProjectConfig();
  return config?.registryUrl ?? DEFAULT_REGISTRY_URL;
}

// ─── Token Storage ───

export function saveToken(agentName: string, token: string): string {
  ensureDir(TOKENS_DIR);
  const tokenPath = path.resolve(TOKENS_DIR, `${agentName}.jwt`);
  fs.writeFileSync(tokenPath, token);
  return tokenPath;
}

export function loadToken(agentName: string): string | null {
  const tokenPath = path.resolve(TOKENS_DIR, `${agentName}.jwt`);
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  return fs.readFileSync(tokenPath, 'utf-8').trim();
}

export function requireToken(agentName: string): string {
  const token = loadToken(agentName);
  if (!token) {
    throw new Error(
      `No token found for agent "${agentName}". Run \`eigent issue ${agentName} --scope <tools>\` first.`
    );
  }
  return token;
}

export function removeToken(agentName: string): boolean {
  const tokenPath = path.resolve(TOKENS_DIR, `${agentName}.jwt`);
  if (fs.existsSync(tokenPath)) {
    fs.unlinkSync(tokenPath);
    return true;
  }
  return false;
}

export function listTokenFiles(): string[] {
  if (!fs.existsSync(TOKENS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(TOKENS_DIR)
    .filter((f) => f.endsWith('.jwt'))
    .map((f) => f.replace('.jwt', ''));
}
