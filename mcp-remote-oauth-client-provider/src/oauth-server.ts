import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';
import { URL } from 'url';
import { debugLog } from './utils';

export interface OAuthServerOptions {
  port: number;
  path: string;
  events: EventEmitter;
}

export function createOAuthCallbackServer(options: OAuthServerOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      const url = new URL(req.url, `http://localhost:${options.port}`);
      
      if (url.pathname === options.path) {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>Authentication Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          options.events.emit('auth-error', error);
          return;
        }
        
        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>Authentication Successful</h1>
                <p>You can close this window and return to the application.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);
          options.events.emit('auth-code', code);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>Authentication Failed</h1>
                <p>No authorization code received.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    server.listen(options.port, () => {
      debugLog(`OAuth callback server listening on port ${options.port}`);
      resolve(server);
    });

    server.on('error', (error) => {
      reject(error);
    });
  });
}