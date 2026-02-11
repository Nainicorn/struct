import auth from './auth.mjs';
import users from './users.mjs';

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5001',
];

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
});

export const handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  // Handle preflight OPTIONS requests - check both event formats
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(allowedOrigin),
      body: '',
    };
  }

  let data;
  try {
    data = await route(event);
  } catch (e) {
    console.error('Route error:', e);
    data = { error: 'Internal server error', statusCode: 500 };
  }

  const statusCode = data?.statusCode || 200;
  if (data?.statusCode) delete data.statusCode;

  return {
    statusCode,
    headers: corsHeaders(allowedOrigin),
    body: JSON.stringify(data ?? {}),
  };
};

const route = async (event) => {
  const path = event.path || event.rawPath || '';
  const resource = event.resource || '';

  // Prefer resource-based routing (REST API)
  if (resource === '/api/auth') return await auth.handle(event);
  if (resource === '/api/users/{id}' || resource === '/api/users') return await users.handle(event);

  // Fallback: path-based routing
  if (path.includes('/api/auth')) return await auth.handle(event);
  if (path.includes('/api/users')) return await users.handle(event);

  return { error: 'Unknown route', statusCode: 404 };
};
