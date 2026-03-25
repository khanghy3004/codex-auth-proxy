import express, { Request, Response } from 'express';
import { PassThrough } from 'node:stream';
import { AccountManager } from './manager';
import { OpenAIProvider, GenericOpenAIProvider, ProviderResponse } from './providers';
import { AxiosError } from 'axios';

const app = express();
const port = process.env.PROXY_PORT || 8080;
const accountManager = new AccountManager();
const openaiProvider = new OpenAIProvider();

app.use(express.json());

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  await handleProxyRequest(req, res);
});

app.post('/v1/conversation', async (req: Request, res: Response) => {
  await handleProxyRequest(req, res);
});

app.post('/v1/responses', async (req: Request, res: Response) => {
  await handleProxyRequest(req, res);
});

async function handleProxyRequest(req: Request, res: Response) {
  let attempts = 0;
  const maxAttempts = 10; // Increased because there are more providers

  while (attempts < maxAttempts) {
    const account = accountManager.getNextAvailableAccount();
    if (!account) {
      res.status(402).json({ error: 'All accounts and providers are exhausted.' });
      return;
    }

    try {
      const model = req.body.model || 'unknown-model';
      console.log(`[Proxy] [${account.type}] [${account.email}] [Model: ${model}] (Attempt ${attempts + 1})`);
      
      let relativePath = req.path.startsWith('/v1') ? req.path.slice(3) : req.path;

      let response: ProviderResponse;
      if (account.type === 'chatgpt') {
        response = await openaiProvider.forward(req.body, account, relativePath, req.headers);
      } else {
        const body = { ...req.body };
        // For standard OpenAI/OpenRouter providers, ask for usage in the stream
        if (body.stream) {
          body.stream_options = { include_usage: true };
        }
        
        const custom = new GenericOpenAIProvider(account.email, account.baseUrl!, account.access_token!);
        response = await custom.forward(body, account, relativePath, req.headers);
      }

      // Handle streaming response
      if (response.data && typeof response.data.pipe === 'function') {
        // Ensure SSE headers are set correctly for streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined && !['content-type', 'cache-control', 'connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) {
             res.setHeader(key, value as string | string[]);
          }
        }
        
        // Use PassThrough as a middleman to observe the stream without affecting the main pipe
        const observer = new PassThrough();
        let totalUsage: any = null;
        
        observer.on('data', (chunk: any) => {
          const content = chunk.toString();
          const lines = content.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
               const dataStr = line.slice(6).trim();
               if (dataStr === '[DONE]') continue;
               try {
                 const data = JSON.parse(dataStr);
                 if (data.usage) {
                   totalUsage = data.usage;
                 }
               } catch {}
            }
          }
        });

        observer.on('end', () => {
          if (totalUsage) {
            console.log(`[Proxy] Usage: prompts=${totalUsage.prompt_tokens}, completion=${totalUsage.completion_tokens}, total=${totalUsage.total_tokens}`);
          } else {
             // If still no usage found, it might be in a different format or missing
             console.log(`[Proxy] Usage: (No usage reported in stream)`);
          }
        });

        // Single chain pipeline
        response.data.pipe(observer).pipe(res);

        // Handle client disconnect
        req.on('close', () => {
          response.data.destroy();
          observer.destroy();
        });

        return;
      } else {
        if (response.data.usage) {
          const u = response.data.usage;
          console.log(`[Proxy] Usage: prompts=${u.prompt_tokens}, completion=${u.completion_tokens}, total=${u.total_tokens}`);
        }
        res.status(response.status).json(response.data);
        return;
      }
    } catch (error) {
      if (openaiProvider.isQuotaExhausted(error)) {
        console.warn(`[Proxy] Account ${account.email} exhausted. Retrying...`);
        accountManager.markExhausted(account.account_key);
        attempts++;
      } else if (error instanceof AxiosError) {
        const status = error.response?.status || 500;
        const data = error.response?.data;
        
        console.error(`[Proxy] Provider Error (${status}): ${error.message}`);
        
        if (data && typeof data.pipe === 'function') {
          // If it's a stream error, it's hard to read and return at the same time without losing data,
          // but we can try to log the error message from the Axios error object.
          res.status(status).json({ error: error.message, status: status });
        } else {
          console.error(`[Proxy] Error Body:`, JSON.stringify(data).slice(0, 1000));
          res.status(status).json(data || { error: error.message });
        }
        return;
      } else {
        console.error(`[Proxy] Unexpected error:`, error);
        res.status(500).json({ error: 'Internal Server Error' });
        return;
      }
    }
  }

  res.status(429).json({ error: 'Max retry attempts reached.' });
}

export function startProxy() {
  app.listen(port, () => {
    console.log(`[Proxy] Codex Proxy Server started on http://localhost:${port}`);
    console.log(`[Proxy] Point your Codex client to http://localhost:${port}/v1`);
  });
}

if (require.main === module) {
  startProxy();
}
