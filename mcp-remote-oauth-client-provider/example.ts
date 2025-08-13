import { OAuthClientProvider } from "./dist/index.js";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

async function main() {
  // Create OAuth provider with automatic authentication
  const authProvider = OAuthClientProvider.createWithAutoAuth({
    serverUrl: "https://your-mcp-server.com",
    callbackPort: 12334,
    host: "localhost",
    clientName: "Example MCP Client",
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

  try {
    // The provider will automatically handle authentication when needed
    const tools = await client.getTools();
    console.log(`Retrieved ${tools.length} tools from server`);
    
    // Use the tools...
    
  } finally {
    // Clean up when done
    await authProvider.cleanup();
  }
}

// Alternative: Manual authentication control
async function manualAuthExample() {
  const authProvider = new OAuthClientProvider({
    serverUrl: "https://your-mcp-server.com",
    callbackPort: 12334,
    host: "localhost",
    clientName: "Manual Auth Client",
    autoAuthenticate: false // Disable automatic authentication
  });

  // Manually trigger authentication when needed
  await authProvider.ensureAuthenticated();
  
  // Now use with MultiServerMCPClient
  const client = new MultiServerMCPClient({
    mcpServers: {
      myServer: {
        url: "https://your-mcp-server.com",
        authProvider
      }
    }
  });
  
  // ... use the client
}

main().catch(console.error);