import { EventEmitter } from 'events';
import { Server } from 'http';
import open from 'open';
import axios from 'axios';
import {
  OAuthTokens,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  AuthorizationServerMetadata,
  OAuthMetadata
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthClientProvider as IOAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { 
  OAuthClientProviderOptions, 
  AuthState,
  TokenStorage 
} from './types';
import { 
  log, 
  debugLog, 
  DEBUG, 
  getServerUrlHash,
  FileTokenStorage 
} from './utils';
import { createOAuthCallbackServer } from './oauth-server';

export class OAuthClientProvider implements IOAuthClientProvider {
  private options: OAuthClientProviderOptions;
  private events: EventEmitter;
  private authServer?: Server;
  private authenticationPromise?: Promise<void>;
  private authInitialized = false;
  private serverUrlHash: string;
  private tokenStorage: TokenStorage;
  private discoveryDocument?: AuthorizationServerMetadata;
  private clientInfo?: OAuthClientInformationFull;
  private _codeVerifier?: string;

  constructor(options: OAuthClientProviderOptions) {
    this.options = {
      ...options,
      autoAuthenticate: options.autoAuthenticate !== false,
      transportStrategy: options.transportStrategy || 'http-first',
      callbackPath: options.callbackPath || '/oauth/callback',
      clientName: options.clientName || 'MCP OAuth Client',
      clientUri: options.clientUri || 'https://modelcontextprotocol.io',
      softwareId: options.softwareId || 'mcp-oauth-client',
      softwareVersion: options.softwareVersion || '1.0.0'
    };
    
    this.events = new EventEmitter();
    this.serverUrlHash = getServerUrlHash(options.serverUrl);
    this.tokenStorage = new FileTokenStorage(options.configDir);
  }

  get redirectUrl(): string | URL {
    return `http://${this.options.host}:${this.options.callbackPort}${this.options.callbackPath}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.options.staticOAuthClientMetadata || {
      client_name: this.options.clientName!,
      client_uri: this.options.clientUri!,
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      software_id: this.options.softwareId!,
      software_version: this.options.softwareVersion!
    };
  }

  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    if (!this.clientInfo) {
      // Try to load from storage
      const storage = this.tokenStorage as FileTokenStorage;
      this.clientInfo = await storage.getClientInfo(this.serverUrlHash) || undefined;
    }
    return this.clientInfo;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    this.clientInfo = clientInformation;
    // Also save to storage
    const storage = this.tokenStorage as FileTokenStorage;
    await storage.saveClientInfo(this.serverUrlHash, clientInformation);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (DEBUG) debugLog('tokens() called');
    
    // If we're in the authentication process, return undefined to prevent recursion
    if (this.authenticationPromise) {
      if (DEBUG) debugLog('Already authenticating, returning undefined');
      return undefined;
    }
    
    // Try to get existing tokens
    const existingTokens = await this.tokenStorage.getTokens(this.serverUrlHash);
    
    if (DEBUG) debugLog('Existing tokens:', existingTokens ? 'Found' : 'Not found');
    
    // If no tokens and auto-authenticate is enabled, trigger authentication
    if (!existingTokens && this.options.autoAuthenticate && !this.authInitialized) {
      log('No tokens found, triggering automatic authentication...');
      await this.ensureAuthenticated();
      // Return tokens after authentication
      const newTokens = await this.tokenStorage.getTokens(this.serverUrlHash);
      if (DEBUG) debugLog('Tokens after auth:', newTokens ? 'Found' : 'Not found');
      return newTokens || undefined;
    }
    
    return existingTokens || undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.tokenStorage.saveTokens(this.serverUrlHash, tokens);
    if (DEBUG) debugLog('Tokens saved successfully');
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log(`Opening browser for authentication: ${authorizationUrl.toString()}`);
    await open(authorizationUrl.toString());
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this._codeVerifier = codeVerifier;
    // Also save to storage
    const storage = this.tokenStorage as FileTokenStorage;
    await storage.saveCodeVerifier(this.serverUrlHash, codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    if (!this._codeVerifier) {
      // Try to load from storage
      const storage = this.tokenStorage as FileTokenStorage;
      this._codeVerifier = await storage.getCodeVerifier(this.serverUrlHash) || undefined;
      if (!this._codeVerifier) {
        throw new Error('No code verifier saved');
      }
    }
    return this._codeVerifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    const storage = this.tokenStorage as FileTokenStorage;
    switch (scope) {
      case 'all':
        await this.tokenStorage.deleteTokens(this.serverUrlHash);
        await storage.deleteClientInfo(this.serverUrlHash);
        await storage.deleteCodeVerifier(this.serverUrlHash);
        this.clientInfo = undefined;
        this._codeVerifier = undefined;
        break;
      case 'client':
        await storage.deleteClientInfo(this.serverUrlHash);
        this.clientInfo = undefined;
        break;
      case 'tokens':
        await this.tokenStorage.deleteTokens(this.serverUrlHash);
        break;
      case 'verifier':
        await storage.deleteCodeVerifier(this.serverUrlHash);
        this._codeVerifier = undefined;
        break;
    }
    if (DEBUG) debugLog(`Credentials invalidated: ${scope}`);
  }

  async ensureAuthenticated(): Promise<void> {
    log('ensureAuthenticated called');
    
    // Check if tokens already exist
    const existingTokens = await this.tokenStorage.getTokens(this.serverUrlHash);
    if (existingTokens?.access_token) {
      log('Tokens already exist, skipping authentication');
      return;
    }
    
    // If authentication is already in progress, wait for it
    if (this.authenticationPromise) {
      if (DEBUG) debugLog('Authentication already in progress, waiting...');
      return this.authenticationPromise;
    }

    // Start authentication process
    this.authenticationPromise = this._performAuthentication();
    
    try {
      await this.authenticationPromise;
    } finally {
      this.authenticationPromise = undefined;
    }
  }

  private async _performAuthentication(): Promise<void> {
    log('Starting automatic authentication flow...');
    log(`Server URL: ${this.options.serverUrl}`);
    log(`Callback Port: ${this.options.callbackPort}`);
    
    try {
      // Get discovery document
      await this.discoverOAuthEndpoints();
      
      // Register or use static client
      await this.registerClient();
      
      // Create callback server
      const authState = await this.initializeAuth();
      
      // Perform authorization code flow
      await this.performAuthorizationCodeFlow(authState);
      
      log('Authentication completed successfully');
      this.authInitialized = true;
      
    } catch (error: any) {
      log(`Authentication failed: ${error.message}`);
      console.error('Full authentication error:', error);
      throw error;
    }
  }

  private async discoverOAuthEndpoints(): Promise<void> {
    const discoveryUrl = new URL('/.well-known/oauth-authorization-server', this.options.serverUrl).toString();
    
    try {
      const response = await axios.get<OAuthMetadata>(discoveryUrl);
      this.discoveryDocument = response.data;
      if (DEBUG) debugLog('Discovery document:', this.discoveryDocument);
    } catch (error) {
      throw new Error(`Failed to fetch OAuth discovery document: ${error}`);
    }
  }

  private async registerClient(): Promise<void> {
    // Use static client info if provided
    if (this.options.staticOAuthClientInfo) {
      this.clientInfo = this.options.staticOAuthClientInfo;
      if (DEBUG) debugLog('Using static client info');
      return;
    }

    // Check if we already have client info saved
    const existingClientInfo = await this.clientInformation();
    if (existingClientInfo) {
      this.clientInfo = existingClientInfo;
      if (DEBUG) debugLog('Using existing client info from storage');
      return;
    }

    if (!this.discoveryDocument?.registration_endpoint) {
      throw new Error('No registration endpoint found in discovery document');
    }

    const redirectUri = `http://${this.options.host}:${this.options.callbackPort}${this.options.callbackPath}`;
    
    const metadata: OAuthClientMetadata = this.options.staticOAuthClientMetadata || {
      client_name: this.options.clientName!,
      client_uri: this.options.clientUri!,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      software_id: this.options.softwareId!,
      software_version: this.options.softwareVersion!
    };

    try {
      const response = await axios.post<OAuthClientInformationFull>(
        this.discoveryDocument.registration_endpoint,
        metadata,
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
      
      this.clientInfo = response.data;
      if (DEBUG) debugLog('Client registered:', this.clientInfo);
      
      // Save client info to storage
      await this.saveClientInformation(this.clientInfo);
    } catch (error) {
      throw new Error(`Failed to register OAuth client: ${error}`);
    }
  }

  private async initializeAuth(): Promise<AuthState> {
    // Create callback server
    this.authServer = await createOAuthCallbackServer({
      port: this.options.callbackPort,
      path: this.options.callbackPath!,
      events: this.events
    });

    // Create promise that resolves when auth code is received
    const waitForAuthCode = () => new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 5 * 60 * 1000); // 5 minute timeout

      this.events.once('auth-code', (code: string) => {
        clearTimeout(timeout);
        resolve(code);
      });

      this.events.once('auth-error', (error: string) => {
        clearTimeout(timeout);
        reject(new Error(`Authentication error: ${error}`));
      });
    });

    return {
      skipBrowserAuth: false,
      waitForAuthCode,
      server: this.authServer
    };
  }

  private async performAuthorizationCodeFlow(authState: AuthState): Promise<void> {
    if (!this.discoveryDocument || !this.clientInfo) {
      throw new Error('Missing discovery document or client info');
    }

    // Generate PKCE challenge
    const pkce = await this.generatePKCEChallenge();
    
    // Save code verifier for later use
    await this.saveCodeVerifier(pkce.verifier);
    
    // Build authorization URL
    const authUrl = new URL(this.discoveryDocument.authorization_endpoint);
    authUrl.searchParams.set('client_id', this.clientInfo.client_id);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', this.clientInfo.redirect_uris[0]);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    
    if (this.options.authorizeResource) {
      authUrl.searchParams.set('resource', this.options.authorizeResource);
    }

    // Open browser for authentication
    log(`Opening browser for authentication: ${authUrl.toString()}`);
    await open(authUrl.toString());

    // Wait for auth code
    const authCode = await authState.waitForAuthCode();
    log('Authorization code received');

    // Exchange code for tokens
    await this.exchangeCodeForTokens(authCode, pkce.verifier);
  }

  private async generatePKCEChallenge(): Promise<{ challenge: string; verifier: string }> {
    const crypto = await import('crypto');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    
    return {
      challenge,
      verifier
    };
  }

  private async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<void> {
    if (!this.discoveryDocument || !this.clientInfo) {
      throw new Error('Missing discovery document or client info');
    }

    const tokenData: any = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.clientInfo.redirect_uris[0],
      client_id: this.clientInfo.client_id,
      code_verifier: codeVerifier
    };

    // Add client_secret if available
    if ('client_secret' in this.clientInfo && this.clientInfo.client_secret) {
      tokenData.client_secret = this.clientInfo.client_secret;
    }

    try {
      const response = await axios.post<OAuthTokens>(
        this.discoveryDocument.token_endpoint,
        new URLSearchParams(tokenData).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      await this.saveTokens(response.data);
      log('Tokens obtained and saved successfully');
    } catch (error) {
      throw new Error(`Failed to exchange code for tokens: ${error}`);
    }
  }

  async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
    if (!this.discoveryDocument || !this.clientInfo) {
      await this.discoverOAuthEndpoints();
      await this.registerClient();
    }

    if (!this.discoveryDocument || !this.clientInfo) {
      throw new Error('Missing discovery document or client info');
    }

    const tokenData: any = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientInfo.client_id
    };

    // Add client_secret if available
    if ('client_secret' in this.clientInfo && this.clientInfo.client_secret) {
      tokenData.client_secret = this.clientInfo.client_secret;
    }

    try {
      const response = await axios.post<OAuthTokens>(
        this.discoveryDocument.token_endpoint,
        new URLSearchParams(tokenData).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      const tokens: OAuthTokens = {
        access_token: response.data.access_token,
        token_type: response.data.token_type,
        expires_in: response.data.expires_in,
        refresh_token: response.data.refresh_token || refreshToken,
        scope: response.data.scope
      };

      await this.saveTokens(tokens);
      return tokens;
    } catch (error) {
      throw new Error(`Failed to refresh tokens: ${error}`);
    }
  }

  async cleanup(): Promise<void> {
    if (this.authServer) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.authServer!.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        if (DEBUG) debugLog('Auth server closed');
      } catch (error) {
        if (DEBUG) debugLog('Error closing auth server', error);
      }
    }
    
    this.events.removeAllListeners();
  }

  static createWithAutoAuth(options: Omit<OAuthClientProviderOptions, 'autoAuthenticate'>): OAuthClientProvider {
    return new OAuthClientProvider({
      ...options,
      autoAuthenticate: true
    });
  }
}