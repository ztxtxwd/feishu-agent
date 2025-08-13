import { EventEmitter } from 'events';
import { 
  OAuthClientInformationFull, 
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';

export interface OAuthProviderOptions {
  serverUrl: string;
  callbackPort: number;
  host: string;
  callbackPath?: string;
  configDir?: string;
  clientName?: string;
  clientUri?: string;
  softwareId?: string;
  softwareVersion?: string;
  staticOAuthClientMetadata?: OAuthClientMetadata | null | undefined;
  staticOAuthClientInfo?: OAuthClientInformationFull | null | undefined;
  authorizeResource?: string;
}

export interface OAuthClientProviderOptions extends OAuthProviderOptions {
  autoAuthenticate?: boolean;
  transportStrategy?: 'sse-only' | 'http-only' | 'sse-first' | 'http-first';
}

export interface AuthState {
  skipBrowserAuth: boolean;
  waitForAuthCode: () => Promise<string>;
  server?: any;
}

export interface TokenStorage {
  getTokens(serverUrlHash: string): Promise<OAuthTokens | null>;
  saveTokens(serverUrlHash: string, tokens: OAuthTokens): Promise<void>;
  deleteTokens(serverUrlHash: string): Promise<void>;
}