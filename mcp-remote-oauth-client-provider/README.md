# @tapeless/mcp-remote-oauth-client-provider

OAuth client provider for MultiServerMCPClient that handles automatic authentication flow for remote MCP servers.

## Installation

```bash
npm install @tapeless/mcp-remote-oauth-client-provider
```

## Usage

```typescript
import { OAuthClientProvider } from "@tapeless/mcp-remote-oauth-client-provider";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

// Create OAuth provider with automatic authentication
const authProvider = OAuthClientProvider.createWithAutoAuth({
  serverUrl: "https://your-mcp-server.com",
  callbackPort: 12334,
  host: "localhost",
  clientName: "Your MCP Client",
});

// Use with MultiServerMCPClient
const client = new MultiServerMCPClient({
  mcpServers: {
    myServer: {
      url: "https://your-mcp-server.com",
      authProvider
    }
  }
});

// The provider will automatically handle authentication when needed
const tools = await client.getTools();

// Clean up when done
await authProvider.cleanup();
```

## Features

- **Automatic Authentication**: Automatically triggers OAuth flow when tokens are needed
- **Token Persistence**: Securely stores tokens locally for reuse across sessions
- **PKCE Support**: Implements PKCE (Proof Key for Code Exchange) for enhanced security
- **Discovery Document**: Supports OAuth 2.0 Authorization Server Metadata discovery
- **Refresh Token**: Automatically refreshes expired tokens when available

## Configuration Options

```typescript
interface OAuthClientProviderOptions {
  // Required
  serverUrl: string;        // MCP server URL
  callbackPort: number;     // Local port for OAuth callback
  host: string;            // Callback host (usually "localhost")
  
  // Optional
  clientName?: string;      // OAuth client name (default: "MCP OAuth Client")
  clientUri?: string;       // Client URI for OAuth registration
  softwareId?: string;      // Software identifier
  softwareVersion?: string; // Software version
  callbackPath?: string;    // OAuth callback path (default: "/oauth/callback")
  configDir?: string;       // Directory to store tokens (default: ~/.config/mcp-oauth)
  autoAuthenticate?: boolean; // Auto-trigger auth flow (default: true)
  
  // Advanced
  staticOAuthClientMetadata?: OAuthClientMetadata; // Override OAuth client metadata
  staticOAuthClientInfo?: OAuthClientInformationFull; // Use static client instead of registration
  authorizeResource?: string; // Resource parameter for authorization
}
```

## Token Storage

Tokens are stored locally in the user's home directory:
- Windows: `%USERPROFILE%\.config\mcp-oauth\tokens-{serverHash}.json`
- macOS/Linux: `~/.config/mcp-oauth/tokens-{serverHash}.json`

You can customize the storage location using the `configDir` option.

## Debug Mode

Enable debug logging by setting the environment variable:

```bash
NODE_DEBUG=mcp-oauth npm start
# or
DEBUG=mcp-oauth npm start
```

## Manual Authentication

If you prefer to control when authentication happens:

```typescript
const authProvider = new OAuthClientProvider({
  serverUrl: "https://your-mcp-server.com",
  callbackPort: 12334,
  host: "localhost",
  autoAuthenticate: false // Disable automatic authentication
});

// Manually trigger authentication when needed
await authProvider.ensureAuthenticated();
```

## Error Handling

The provider throws `OAuthError` for authentication-related errors:

```typescript
try {
  const tools = await client.getTools();
} catch (error) {
  if (error.name === 'OAuthError') {
    console.error('Authentication failed:', error.message);
  }
}
```

## License

MIT