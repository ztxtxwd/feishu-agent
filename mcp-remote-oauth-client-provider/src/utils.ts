import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { OAuthTokens, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { TokenStorage } from './types';

export const DEBUG = process.env.NODE_DEBUG === 'mcp-oauth' || process.env.DEBUG === 'mcp-oauth';

export function log(...args: any[]): void {
  console.log('[OAuth]', ...args);
}

export function debugLog(...args: any[]): void {
  if (DEBUG) {
    console.log('[OAuth Debug]', ...args);
  }
}

export function getServerUrlHash(serverUrl: string): string {
  return crypto.createHash('sha256').update(serverUrl).digest('hex').slice(0, 16);
}

export class FileTokenStorage implements TokenStorage {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), '.config', 'mcp-oauth');
  }

  private getTokenPath(serverUrlHash: string): string {
    return path.join(this.configDir, serverUrlHash, 'tokens.json');
  }

  private getClientInfoPath(serverUrlHash: string): string {
    return path.join(this.configDir, serverUrlHash, 'client_info.json');
  }

  private getCodeVerifierPath(serverUrlHash: string): string {
    return path.join(this.configDir, serverUrlHash, 'code_verifier.txt');
  }

  async getTokens(serverUrlHash: string): Promise<OAuthTokens | null> {
    try {
      const tokenPath = this.getTokenPath(serverUrlHash);
      const data = await fs.readFile(tokenPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async saveTokens(serverUrlHash: string, tokens: OAuthTokens): Promise<void> {
    const dir = path.join(this.configDir, serverUrlHash);
    await fs.mkdir(dir, { recursive: true });
    const tokenPath = this.getTokenPath(serverUrlHash);
    await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2));
  }

  async deleteTokens(serverUrlHash: string): Promise<void> {
    try {
      const tokenPath = this.getTokenPath(serverUrlHash);
      await fs.unlink(tokenPath);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
  }

  async getClientInfo(serverUrlHash: string): Promise<OAuthClientInformationFull | null> {
    try {
      const clientPath = this.getClientInfoPath(serverUrlHash);
      const data = await fs.readFile(clientPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async saveClientInfo(serverUrlHash: string, clientInfo: OAuthClientInformationFull): Promise<void> {
    const dir = path.join(this.configDir, serverUrlHash);
    await fs.mkdir(dir, { recursive: true });
    const clientPath = this.getClientInfoPath(serverUrlHash);
    await fs.writeFile(clientPath, JSON.stringify(clientInfo, null, 2));
  }

  async deleteClientInfo(serverUrlHash: string): Promise<void> {
    try {
      const clientPath = this.getClientInfoPath(serverUrlHash);
      await fs.unlink(clientPath);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
  }

  async getCodeVerifier(serverUrlHash: string): Promise<string | null> {
    try {
      const verifierPath = this.getCodeVerifierPath(serverUrlHash);
      return await fs.readFile(verifierPath, 'utf-8');
    } catch (error) {
      return null;
    }
  }

  async saveCodeVerifier(serverUrlHash: string, verifier: string): Promise<void> {
    const dir = path.join(this.configDir, serverUrlHash);
    await fs.mkdir(dir, { recursive: true });
    const verifierPath = this.getCodeVerifierPath(serverUrlHash);
    await fs.writeFile(verifierPath, verifier);
  }

  async deleteCodeVerifier(serverUrlHash: string): Promise<void> {
    try {
      const verifierPath = this.getCodeVerifierPath(serverUrlHash);
      await fs.unlink(verifierPath);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
  }
}